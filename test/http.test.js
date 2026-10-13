import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, makeCorpus, tempDir, writeTree, HANDBOOK } from './helpers.js';
import { createHttpServer } from '../src/http.js';

after(cleanupAll);

async function withApi(fn) {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const server = createHttpServer(corpus.db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${corpus.key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  try { return await fn({ ...corpus, root, base, call }); } finally { server.close(); }
}

test('the seven verbs run end to end over the HTTP API', async () => {
  await withApi(async ({ root, call }) => {
    // 1 connect
    const connected = await call('POST', '/v1/sources', {
      display_name: 'Ops handbook', root, scope: { include: ['**/*.md'] }, retention_days: 30
    });
    assert.equal(connected.status, 201);
    const sourceId = connected.body.source_id;
    assert.equal(connected.body.scope.follow_symlinks, false);

    // 2 harvest
    const harvested = await call('POST', `/v1/sources/${sourceId}/harvest`, {});
    assert.equal(harvested.status, 200);
    assert.equal(harvested.body.docs_added, 2);

    // 3 refresh
    writeFileSync(join(root, 'handbook/escalation.md'), '# Escalation\n\nPage the duty lead.\n');
    const refreshed = await call('POST', `/v1/sources/${sourceId}/refresh`, {});
    assert.equal(refreshed.body.docs_added, 1);
    assert.equal(refreshed.body.docs_unchanged, 2);

    // 4 retrieve
    const found = await call('POST', '/v1/search', { query: 'refund supervisor', limit: 5 });
    assert.equal(found.status, 200);
    assert.ok(found.body.count >= 1);
    const hit = found.body.hits[0];
    assert.equal(hit.provenance.source_id, sourceId);
    assert.equal(hit.provenance.uri, 'handbook/refunds.md');
    assert.equal(hit.provenance.source_kind, 'folder');
    assert.ok(hit.provenance.content_sha256.length === 64);
    assert.ok(hit.provenance.locator.start_line >= 1);
    assert.equal(hit.freshness.state, 'fresh');
    assert.ok(typeof hit.score === 'number');

    const listed = await call('GET', '/v1/sources');
    assert.equal(listed.body.sources.length, 1);
    assert.equal(listed.body.sources[0].document_count, 3);

    const document = await call('GET', `/v1/documents/${hit.provenance.document_id}`);
    assert.equal(document.status, 200);
    assert.ok(document.body.text.includes('refund'));

    // 5 export
    const exported = await call('GET', '/v1/export');
    assert.equal(exported.status, 200);
    assert.equal(exported.body.documents.length, 3);

    // 6 delete
    const deleted = await call('DELETE', `/v1/sources/${sourceId}`, {});
    assert.equal(deleted.status, 200);
    assert.equal((await call('POST', '/v1/search', { query: 'refund' })).body.count, 0);
    assert.equal((await call('GET', `/v1/documents/${hit.provenance.document_id}`)).status, 404);
  });
});

test('7 revoke: the next request after revocation is denied', async () => {
  await withApi(async ({ call, keyId }) => {
    assert.equal((await call('GET', '/v1/sources')).status, 200);
    const revoked = await call('POST', `/v1/keys/${keyId}/revoke`, {});
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);
    assert.equal((await call('GET', '/v1/sources')).status, 401);
  });
});

test('DELETE /v1/corpus empties the corpus and kills every key', async () => {
  await withApi(async ({ root, call }) => {
    const { body: source } = await call('POST', '/v1/sources', {
      display_name: 'handbook', root, scope: { include: ['**/*.md'] }
    });
    await call('POST', `/v1/sources/${source.source_id}/harvest`, {});
    const purged = await call('DELETE', '/v1/corpus', {});
    assert.equal(purged.status, 200);
    assert.ok(purged.body.keys_revoked >= 1);
    assert.equal((await call('GET', '/v1/sources')).status, 401,
      'the key used to purge is revoked in the same transaction');
  });
});

test('a document line range narrows both the text and the byte locator', async () => {
  await withApi(async ({ root, call }) => {
    const { body: source } = await call('POST', '/v1/sources', {
      display_name: 'handbook', root, scope: { include: ['**/*.md'] }
    });
    await call('POST', `/v1/sources/${source.source_id}/harvest`, {});
    const found = await call('POST', '/v1/search', { query: 'refund' });
    const documentId = found.body.hits[0].provenance.document_id;

    const full = await call('GET', `/v1/documents/${documentId}`);
    const ranged = await call('GET', `/v1/documents/${documentId}?start_line=3&end_line=3`);
    assert.equal(ranged.status, 200);
    assert.ok(ranged.body.text.length < full.body.text.length);
    assert.equal(ranged.body.provenance.locator.start_line, 3);
    assert.equal(ranged.body.provenance.locator.end_line, 3);
    assert.ok(ranged.body.provenance.locator.end_byte <= full.body.provenance.locator.end_byte);
    const fullBytes = Buffer.from(full.body.text, 'utf8');
    const start = ranged.body.provenance.locator.start_byte - full.body.provenance.locator.start_byte;
    const end = ranged.body.provenance.locator.end_byte - full.body.provenance.locator.start_byte;
    assert.equal(fullBytes.subarray(start, end).toString('utf8'), ranged.body.text,
      'the narrowed byte locator points at exactly the narrowed text');
  });
});

test('an invalid document line range is rejected instead of publishing a false line locator', async () => {
  await withApi(async ({ root, call }) => {
    const { body: source } = await call('POST', '/v1/sources', {
      display_name: 'handbook', root, scope: { include: ['**/*.md'] }
    });
    await call('POST', `/v1/sources/${source.source_id}/harvest`, {});
    const found = await call('POST', '/v1/search', { query: 'refund' });
    const documentId = found.body.hits[0].provenance.document_id;

    for (const [query, reason] of [
      ['start_line=0', 'start_line_must_be_positive_integer'],
      ['end_line=-1', 'end_line_must_be_positive_integer'],
      ['start_line=3x', 'start_line_invalid'],
      ['start_line=4&end_line=2', 'line_range_invalid']
    ]) {
      const response = await call('GET', `/v1/documents/${documentId}?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal(response.body.reason, reason, query);
    }
  });
});

test('bad input is a 400 with a bounded reason, not a 500', async () => {
  await withApi(async ({ call, root }) => {
    const cases = [
      ['POST', '/v1/search', {}, 'query_required'],
      ['POST', '/v1/search', { query: '   ' }, 'query_has_no_searchable_terms'],
      ['POST', '/v1/search', { query: 'refund', limit: 0 }, 'limit_must_be_positive_integer'],
      ['POST', '/v1/search', { query: 'refund', source_ids: 'src_x' }, 'source_ids_must_be_array'],
      ['POST', '/v1/sources', { root }, 'display_name_required'],
      ['POST', '/v1/sources', { display_name: 'x', root, scope: { follow_symlinks: true } },
        'scope.follow_symlinks_must_be_false_in_v0']
    ];
    for (const [method, path, body, reason] of cases) {
      const res = await call(method, path, body);
      assert.equal(res.status, 400, `${method} ${path} ${JSON.stringify(body)}`);
      assert.equal(res.body.error, 'bad_request');
      assert.equal(res.body.reason, reason);
    }
  });
});

test('an oversized body receives a bounded 400 instead of a reset connection', async () => {
  await withApi(async ({ base, key }) => {
    const response = await fetch(`${base}/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'refund', source_ids: ['x'.repeat(1_048_576)] })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'bad_request', reason: 'body_too_large' });
  });
});

test('an unknown route and an unknown document are 404s', async () => {
  await withApi(async ({ call }) => {
    assert.equal((await call('GET', '/v1/nope')).status, 404);
    assert.equal((await call('GET', '/v1/documents/doc_nope')).status, 404);
    assert.equal((await call('POST', '/v1/sources/src_nope/harvest', {})).status, 404);
  });
});

test('search respects the limit and caps it', async () => {
  await withApi(async ({ root, call }) => {
    const { body: source } = await call('POST', '/v1/sources', {
      display_name: 'handbook', root, scope: { include: ['**/*'] }
    });
    await call('POST', `/v1/sources/${source.source_id}/harvest`, {});
    const one = await call('POST', '/v1/search', { query: 'business day refund note', limit: 1 });
    assert.equal(one.body.count, 1);
    assert.equal(one.body.limit, 1);
    const capped = await call('POST', '/v1/search', { query: 'refund', limit: 5000 });
    assert.equal(capped.body.limit, 50);
  });
});
