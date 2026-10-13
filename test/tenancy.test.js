import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { addTenant, cleanupAll, makeCorpus, tempDir, writeTree } from './helpers.js';
import { connectSource, deleteCorpus, deleteSource, exportCorpus, listSources, runHarvest }
  from '../src/corpus.js';
import { getDocument, search } from '../src/retrieve.js';
import { authenticate, listKeys, revokeKey } from '../src/keys.js';
import { createHttpServer } from '../src/http.js';

after(cleanupAll);

const A_SECRET = 'AAA_TENANT_A_CONFIDENTIAL_MARKER';
const B_SECRET = 'BBB_TENANT_B_CONFIDENTIAL_MARKER';

// Two tenants in one database, each with their own key and their own source.
function twoTenants() {
  const a = makeCorpus({ tenantName: 'tenant-a' });
  const b = addTenant(a.db, 'tenant-b');

  const rootA = writeTree(tempDir(), { 'a.md': `# A\n\n${A_SECRET} appears only here.\n` });
  const rootB = writeTree(tempDir(), { 'b.md': `# B\n\n${B_SECRET} appears only here.\n` });

  const sourceA = connectSource(a.db, a.ctx, { display_name: 'a', root: rootA, scope: { include: ['**/*.md'] } });
  const sourceB = connectSource(a.db, b.ctx, { display_name: 'b', root: rootB, scope: { include: ['**/*.md'] } });
  runHarvest(a.db, a.ctx, sourceA.source_id);
  runHarvest(a.db, b.ctx, sourceB.source_id);

  const docA = search(a.db, a.ctx, { query: A_SECRET }).hits[0].provenance.document_id;
  const docB = search(a.db, b.ctx, { query: B_SECRET }).hits[0].provenance.document_id;
  return { db: a.db, a, b, sourceA, sourceB, docA, docB };
}

// Tenant isolation.
test('search never crosses the tenant boundary', () => {
  const { db, a, b } = twoTenants();
  assert.equal(search(db, a.ctx, { query: A_SECRET }).count, 1);
  assert.equal(search(db, b.ctx, { query: A_SECRET }).count, 0);
  assert.equal(search(db, a.ctx, { query: B_SECRET }).count, 0);
  assert.equal(search(db, b.ctx, { query: B_SECRET }).count, 1);
});

test('passing another tenant source_id returns nothing, not their content', () => {
  const { db, b, sourceA } = twoTenants();
  const result = search(db, b.ctx, { query: A_SECRET, source_ids: [sourceA.source_id] });
  assert.equal(result.count, 0);
  assert.equal(JSON.stringify(result).includes(A_SECRET), false);
});

test('a known document_id from another tenant is a 404', () => {
  const { db, b, docA } = twoTenants();
  assert.throws(() => getDocument(db, b.ctx, docA), /not_found/);
});

test('list_sources shows only the calling tenant sources', () => {
  const { db, a, b, sourceA, sourceB } = twoTenants();
  assert.deepEqual(listSources(db, a.ctx.tenant_id).map((s) => s.source_id), [sourceA.source_id]);
  assert.deepEqual(listSources(db, b.ctx.tenant_id).map((s) => s.source_id), [sourceB.source_id]);
});

test('export contains only the calling tenant corpus', () => {
  const { db, a, b } = twoTenants();
  const exportA = JSON.stringify(exportCorpus(db, a.ctx));
  const exportB = JSON.stringify(exportCorpus(db, b.ctx));
  assert.ok(exportA.includes(A_SECRET));
  assert.ok(!exportA.includes(B_SECRET));
  assert.ok(exportB.includes(B_SECRET));
  assert.ok(!exportB.includes(A_SECRET));
});

test('FTS query syntax cannot widen the row set past the tenant boundary', () => {
  const { db, b } = twoTenants();
  const attacks = [
    `${A_SECRET} OR ${B_SECRET}`,
    'text : *',
    '*',
    'NEAR(AAA_TENANT_A_CONFIDENTIAL_MARKER BBB_TENANT_B_CONFIDENTIAL_MARKER)',
    '"AAA_TENANT_A_CONFIDENTIAL_MARKER" OR "a"',
    'a* OR b*'
  ];
  for (const attack of attacks) {
    let result;
    try { result = search(db, b.ctx, { query: attack }); } catch { continue; }
    assert.equal(JSON.stringify(result).includes(A_SECRET), false,
      `query "${attack}" reached across the tenant boundary`);
  }
});

test('deleting another tenant source is a 404 and leaves it intact', () => {
  const { db, a, b, sourceA } = twoTenants();
  assert.throws(() => deleteSource(db, b.ctx, sourceA.source_id), /not_found/);
  assert.equal(search(db, a.ctx, { query: A_SECRET }).count, 1);
});

test('purging one tenant corpus leaves the other untouched', () => {
  const { db, a, b } = twoTenants();
  deleteCorpus(db, b.ctx);
  assert.equal(search(db, b.ctx, { query: B_SECRET }).count, 0);
  assert.equal(search(db, a.ctx, { query: A_SECRET }).count, 1,
    'tenant A keeps their corpus and their keys');
  assert.ok(listKeys(db, a.ctx.tenant_id).some((k) => k.revoked_at === null));
});

test('a tenant cannot revoke another tenant key', () => {
  const { db, a, b } = twoTenants();
  assert.equal(revokeKey(db, a.keyId, b.ctx.tenant_id), false);
  assert.doesNotThrow(() => authenticate(db, a.key));
});

test('the tenant is derived from the key alone', () => {
  const { db, a, b } = twoTenants();
  assert.equal(authenticate(db, a.key).tenant_id, a.tenant.id);
  assert.equal(authenticate(db, b.key).tenant_id, b.tenant.id);
  assert.notEqual(a.tenant.id, b.tenant.id);
});

test('no read path accepts a tenant id from the caller', async () => {
  // A structural check: the request-facing modules never read a tenant from a payload.
  const { readFileSync } = await import('node:fs');
  for (const file of ['src/http.js', 'src/mcp.js', 'src/retrieve.js']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(!/body\.tenant|params\.tenant|args\.tenant|query\.tenant|searchParams\.get\(['"]tenant/.test(source),
      `${file} must not read a tenant id from the caller`);
  }
});

test('the HTTP surface ignores caller-supplied tenant ids and uses the bearer tenant', async () => {
  const { db, a, b, sourceA, docA } = twoTenants();
  const server = createHttpServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const searchResponse = await fetch(`${base}/v1/search?tenant_id=${a.tenant.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: A_SECRET,
        source_ids: [sourceA.source_id],
        tenant_id: a.tenant.id,
        tenant: a.tenant.id
      })
    });
    assert.equal(searchResponse.status, 200);
    assert.equal((await searchResponse.json()).count, 0);

    const documentResponse = await fetch(
      `${base}/v1/documents/${docA}?tenant_id=${a.tenant.id}`,
      { headers: { authorization: `Bearer ${b.key}` } }
    );
    assert.equal(documentResponse.status, 404);
  } finally {
    server.close();
  }
});
