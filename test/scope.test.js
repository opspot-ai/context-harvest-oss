import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, makeCorpus, makeFifo, makeSymlink, tempDir, writeTree, HANDBOOK } from './helpers.js';
import { connectSource, runHarvest } from '../src/corpus.js';
import { normalizeScope } from '../src/scope.js';
import { isContained } from '../src/connectors/folder.js';

after(cleanupAll);

const skipReasons = (run, uri) => run.skipped.filter((s) => s.uri === uri).map((s) => s.reason);

// Scope enforcement.
test('exclude globs keep files out of the corpus', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const source = connectSource(db, ctx, {
    display_name: 'handbook', root,
    scope: { include: ['**/*.md'], exclude: ['handbook/onboarding.md'] }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.equal(run.docs_added, 1);
  assert.deepEqual(skipReasons(run, 'handbook/onboarding.md'), ['excluded']);
  assert.deepEqual(skipReasons(run, 'notes/scratch.txt'), ['not_included']);
});

test('an excluded directory is never descended into', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), { ...HANDBOOK, 'secrets/keys.md': 'sk-live-do-not-index\n' });
  const source = connectSource(db, ctx, {
    display_name: 'handbook', root,
    scope: { include: ['**/*.md'], exclude: ['secrets'] }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.deepEqual(skipReasons(run, 'secrets'), ['excluded']);
  assert.ok(!run.skipped.some((s) => s.uri === 'secrets/keys.md'),
    'a file inside an excluded directory is never even enumerated');
  const rows = db.prepare('SELECT uri FROM documents WHERE tenant_id = ?').all(ctx.tenant_id);
  assert.ok(!rows.some((r) => r.uri.startsWith('secrets/')));
});

test('max_file_bytes skips an oversize file and reports it', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  writeFileSync(join(root, 'handbook/huge.md'), 'x'.repeat(5000) + '\n');
  const source = connectSource(db, ctx, {
    display_name: 'handbook', root,
    scope: { include: ['**/*.md'], max_file_bytes: 1024 }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.deepEqual(skipReasons(run, 'handbook/huge.md'), ['max_file_bytes']);
  assert.equal(run.docs_added, 2);
});

test('max_total_bytes stops indexing during the walk and marks the run truncated', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), {
    'a.md': 'a'.repeat(400) + '\n',
    'b.md': 'b'.repeat(400) + '\n',
    'c.md': 'c'.repeat(400) + '\n'
  });
  const source = connectSource(db, ctx, {
    display_name: 'capped', root,
    scope: { include: ['**/*.md'], max_total_bytes: 900 }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.equal(run.truncated, true);
  assert.equal(run.docs_added, 2);
  assert.deepEqual(skipReasons(run, 'c.md'), ['max_total_bytes']);
  assert.ok(run.bytes_indexed <= 900);
});

test('scope rejects follow_symlinks true rather than quietly honouring it', () => {
  assert.throws(() => normalizeScope({ follow_symlinks: true }), /bad_request/);
  assert.equal(normalizeScope({}).follow_symlinks, false);
});

test('scope rejects a non-positive byte limit and an empty include list', () => {
  assert.throws(() => normalizeScope({ max_file_bytes: 0 }), /bad_request/);
  assert.throws(() => normalizeScope({ max_total_bytes: -1 }), /bad_request/);
  assert.throws(() => normalizeScope({ include: [] }), /bad_request/);
});

// Path containment.
test('a symlink pointing outside the root is never followed or read', () => {
  const { db, ctx } = makeCorpus();
  const outside = writeTree(tempDir(), { 'private.md': 'SENTINEL_OUTSIDE_ROOT_CONTENT\n' });
  const root = writeTree(tempDir(), HANDBOOK);
  makeSymlink(root, 'handbook/escape.md', join(outside, 'private.md'));
  makeSymlink(root, 'linkdir', outside);

  const source = connectSource(db, ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(db, ctx, source.source_id);

  assert.deepEqual(skipReasons(run, 'handbook/escape.md'), ['symlink_not_followed']);
  assert.deepEqual(skipReasons(run, 'linkdir'), ['symlink_not_followed']);

  const texts = db.prepare('SELECT text FROM chunks_fts').all().map((r) => r.text).join('\n');
  assert.ok(!texts.includes('SENTINEL_OUTSIDE_ROOT_CONTENT'),
    'content from outside the declared root must never enter the corpus');
});

test('a symlink pointing inside the root is still not followed in v0', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  makeSymlink(root, 'handbook/alias.md', join(root, 'handbook/refunds.md'));
  const source = connectSource(db, ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.deepEqual(skipReasons(run, 'handbook/alias.md'), ['symlink_not_followed']);
  assert.equal(run.docs_added, 2);
});

test('isContained refuses traversal out of the root', () => {
  assert.equal(isContained('/a/b', '/a/b/c.md'), true);
  assert.equal(isContained('/a/b', '/a/b'), true);
  assert.equal(isContained('/a/b', '/a/c.md'), false);
  assert.equal(isContained('/a/b', '/a'), false);
  assert.equal(isContained('/a/b', '/a/bc/d.md'), false);
});

test('a root given with .. resolves to a real path and cannot reach past it', () => {
  const { db, ctx } = makeCorpus();
  const parent = writeTree(tempDir(), { 'outside.md': 'SENTINEL_PARENT\n' });
  writeTree(join(parent, 'inner'), { 'inside.md': 'inner note\n' });
  const source = connectSource(db, ctx, {
    display_name: 'inner', root: join(parent, 'inner', '..', 'inner'),
    scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.equal(run.docs_added, 1);
  const uris = db.prepare('SELECT uri FROM documents WHERE tenant_id = ?').all(ctx.tenant_id)
    .map((r) => r.uri);
  assert.deepEqual(uris, ['inside.md']);
  const texts = db.prepare('SELECT text FROM chunks_fts').all().map((r) => r.text).join('\n');
  assert.ok(!texts.includes('SENTINEL_PARENT'));
});

test('a FIFO is skipped as a non-regular file rather than blocking the walk', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const made = makeFifo(root, 'handbook/pipe.md');
  if (!made) return; // no mkfifo on this platform
  const source = connectSource(db, ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.deepEqual(skipReasons(run, 'handbook/pipe.md'), ['not_a_regular_file']);
  assert.equal(run.docs_added, 2);
});

test('a binary file is skipped and reported, never indexed as text', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  writeFileSync(join(root, 'handbook/blob.md'), Buffer.from([0x41, 0x00, 0x42]));
  const source = connectSource(db, ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.deepEqual(skipReasons(run, 'handbook/blob.md'), ['binary']);
});

test('invalid UTF-8 is skipped rather than indexed with replacement characters', () => {
  const { db, ctx } = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  // Invalid two-byte sequence without a NUL: the old binary heuristic accepted this and UTF-8
  // decoding replaced a byte, so the published locator could not reproduce the response.
  writeFileSync(join(root, 'handbook/invalid.md'), Buffer.from([0x63, 0x61, 0x66, 0xc3, 0x28]));
  const source = connectSource(db, ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(db, ctx, source.source_id);
  assert.deepEqual(skipReasons(run, 'handbook/invalid.md'), ['binary']);
  assert.equal(run.docs_added, 2);
});

test('connecting a source whose root does not exist fails closed', () => {
  const { db, ctx } = makeCorpus();
  assert.throws(
    () => connectSource(db, ctx, { display_name: 'gone', root: '/no/such/root/here' }),
    /bad_request/
  );
});
