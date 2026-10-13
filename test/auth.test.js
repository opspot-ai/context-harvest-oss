import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupAll, makeCorpus, tempDir, writeTree, HANDBOOK } from './helpers.js';
import { connectSource, runHarvest } from '../src/corpus.js';
import { authenticate, bearerFromHeader, issueKey, listKeys, revokeAllKeys, revokeKey }
  from '../src/keys.js';
import { createHttpServer } from '../src/http.js';

after(cleanupAll);

function serving() {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  return corpus;
}

async function withServer(db, fn) {
  const server = createHttpServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

// Key revocation.
test('a revoked key is denied on its very next request, with no grace window', async () => {
  const { db, key, keyId } = serving();
  await withServer(db, async (base) => {
    const call = () => fetch(`${base}/v1/sources`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal((await call()).status, 200);
    revokeKey(db, keyId);
    const denied = await call();
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: 'unauthorized', reason: 'revoked' });
  });
});

test('revocation is immediate at the library layer too', () => {
  const { db, key, keyId } = serving();
  assert.doesNotThrow(() => authenticate(db, key));
  revokeKey(db, keyId);
  assert.throws(() => authenticate(db, key), /unauthorized/);
});

test('there is no key cache: the state is re-read on every call', () => {
  const { db, key, keyId, tenant } = serving();
  authenticate(db, key);
  revokeKey(db, keyId);
  assert.throws(() => authenticate(db, key), /unauthorized/);
  // Un-revoking is not a product verb, but it proves the check reads live state each time.
  db.prepare('UPDATE api_keys SET revoked_at = NULL WHERE id = ?').run(keyId);
  assert.equal(authenticate(db, key).tenant_id, tenant.id);
});

test('an unknown or malformed bearer is unauthorized, never a 500', async () => {
  const { db } = serving();
  await withServer(db, async (base) => {
    for (const header of ['Bearer ch_totallyfake', 'Bearer not-a-key', 'Basic abc', 'Bearer', '']) {
      const res = await fetch(`${base}/v1/sources`, { headers: header ? { authorization: header } : {} });
      assert.equal(res.status, 401, `header "${header}" should be unauthorized`);
    }
  });
});

test('every write verb requires a key as well', async () => {
  const { db } = serving();
  await withServer(db, async (base) => {
    const attempts = [
      ['POST', '/v1/search', { query: 'refund' }],
      ['POST', '/v1/sources', { display_name: 'x', root: '/tmp' }],
      ['GET', '/v1/export', undefined],
      ['DELETE', '/v1/corpus', {}],
      ['POST', '/v1/keys/key_x/revoke', {}]
    ];
    for (const [method, path, body] of attempts) {
      const res = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      assert.equal(res.status, 401, `${method} ${path} must require a key`);
    }
  });
});

test('the plaintext key is never stored, only its digest', () => {
  const { db, tenant } = serving();
  const issued = issueKey(db, tenant.id, 'second');
  const rows = db.prepare('SELECT * FROM api_keys').all();
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes(issued.key), 'the plaintext must not appear in the key table');
  assert.ok(issued.key.startsWith('ch_'));
  assert.equal(listKeys(db, tenant.id).some((k) => JSON.stringify(k).includes(issued.key)), false);
});

test('two issued keys are distinct and each maps to its own key id', () => {
  const { db, tenant } = serving();
  const first = issueKey(db, tenant.id, 'one');
  const second = issueKey(db, tenant.id, 'two');
  assert.notEqual(first.key, second.key);
  assert.equal(authenticate(db, first.key).key_id, first.key_id);
  assert.equal(authenticate(db, second.key).key_id, second.key_id);
});

test('revokeAllKeys kills every live key for the tenant', () => {
  const { db, tenant, key } = serving();
  const extra = issueKey(db, tenant.id, 'extra');
  assert.equal(revokeAllKeys(db, tenant.id), 2);
  assert.throws(() => authenticate(db, key), /unauthorized/);
  assert.throws(() => authenticate(db, extra.key), /unauthorized/);
  assert.equal(revokeAllKeys(db, tenant.id), 0, 'revoking again is a no-op');
});

test('bearerFromHeader accepts only a well-formed bearer header', () => {
  assert.equal(bearerFromHeader('Bearer ch_abc'), 'ch_abc');
  assert.equal(bearerFromHeader('bearer ch_abc'), 'ch_abc');
  assert.equal(bearerFromHeader('Bearer  ch_abc '), 'ch_abc');
  assert.equal(bearerFromHeader('Bearer ch_a ch_b'), null);
  assert.equal(bearerFromHeader('ch_abc'), null);
  assert.equal(bearerFromHeader(undefined), null);
});
