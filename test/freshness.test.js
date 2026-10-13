import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync, truncateSync, utimesSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, makeCorpus, tempDir, writeTree, HANDBOOK } from './helpers.js';
import { connectSource, runHarvest } from '../src/corpus.js';
import { search, getDocument } from '../src/retrieve.js';

after(cleanupAll);

function setup() {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const source = connectSource(db, ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(db, ctx, source.source_id);
  return { db, ctx, root, source };
}

const refundHit = (db, ctx) => search(db, ctx, { query: 'refund' }).hits[0];

// Freshness checks.
test('a harvested file that has not moved reads fresh', () => {
  const { db, ctx } = setup();
  const hit = refundHit(db, ctx);
  assert.equal(hit.freshness.state, 'fresh');
  assert.ok(Number.isInteger(hit.freshness.age_seconds));
  assert.ok(hit.freshness.harvested_at);
  assert.ok(hit.freshness.source_modified_at);
});

test('a modified file reads stale and is still returned, clearly marked', () => {
  const { db, ctx, root } = setup();
  writeFileSync(join(root, 'handbook/refunds.md'),
    '# Refunds\n\nA refund is issued within TEN business days.\n');
  const hit = refundHit(db, ctx);
  assert.equal(hit.freshness.state, 'stale');
  assert.ok(hit.text.includes('five business days'),
    'the hit is still returned so the caller can see what we hold');
});

test('an mtime-preserving rewrite that changes size still reads stale', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const target = join(root, 'handbook/refunds.md');

  // Pin the mtime to a whole second so it can be restored byte-exactly after the rewrite.
  // This is the attack the size check exists to catch: content swapped underneath a timestamp
  // that has been put back to look untouched.
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
  utimesSync(target, pinned, pinned);

  const source = connectSource(db, ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(db, ctx, source.source_id);
  assert.equal(refundHit(db, ctx).freshness.state, 'fresh');

  truncateSync(target, 12);
  utimesSync(target, pinned, pinned);
  assert.equal(statSync(target).mtimeMs, pinned.getTime(), 'the mtime was restored exactly');
  assert.equal(refundHit(db, ctx).freshness.state, 'stale');
});

test('a size-preserving rewrite that changes mtime reads stale', () => {
  const { db, ctx, root } = setup();
  const target = join(root, 'handbook/refunds.md');
  const original = HANDBOOK['handbook/refunds.md'];
  const replacement = original.replace('five ', 'nine ');
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original), 'size is unchanged');
  writeFileSync(target, replacement);
  assert.equal(refundHit(db, ctx).freshness.state, 'stale');
});

test('a deleted file reads stale, never fresh', () => {
  const { db, ctx, root } = setup();
  renameSync(join(root, 'handbook/refunds.md'), join(root, 'handbook/refunds.moved'));
  assert.equal(refundHit(db, ctx).freshness.state, 'stale');
});

test('an unreachable source root reads unverified, never fresh', () => {
  const { db, ctx, root } = setup();
  renameSync(root, root + '-moved');
  const hit = refundHit(db, ctx);
  assert.equal(hit.freshness.state, 'unverified');
  renameSync(root + '-moved', root);
});

test('get_document reports freshness on the same rules as search', () => {
  const { db, ctx, root } = setup();
  const documentId = refundHit(db, ctx).provenance.document_id;
  assert.equal(getDocument(db, ctx, documentId).freshness.state, 'fresh');
  writeFileSync(join(root, 'handbook/refunds.md'), '# Refunds\n\nrewritten\n');
  assert.equal(getDocument(db, ctx, documentId).freshness.state, 'stale');
});

test('freshness is computed at query time, not read from a stored column', () => {
  const { db, ctx, root } = setup();
  assert.equal(refundHit(db, ctx).freshness.state, 'fresh');
  writeFileSync(join(root, 'handbook/refunds.md'), '# Refunds\n\nchanged without any refresh\n');
  // No harvest, no refresh, no write to the database between these two calls.
  assert.equal(refundHit(db, ctx).freshness.state, 'stale');
  const columns = db.prepare('PRAGMA table_info(documents)').all().map((c) => c.name);
  assert.ok(!columns.some((name) => name.includes('fresh')),
    'no stored freshness column exists that could go out of date');
});
