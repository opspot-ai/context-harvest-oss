import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, makeCorpus, tempDir, writeTree, HANDBOOK } from './helpers.js';
import { connectSource, deleteCorpus, exportCorpus, runHarvest, EXPORT_FORMAT_VERSION }
  from '../src/corpus.js';

after(cleanupAll);

function setup() {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'handbook', root, scope: { include: ['**/*.md'] }, retention_days: 90
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  return { ...corpus, root, source };
}

// Export round-trip.
test('export carries the corpus, its provenance, and its declared scope', () => {
  const { db, ctx, source, root } = setup();
  const dump = exportCorpus(db, ctx);

  assert.equal(dump.format, 'context-harvest.corpus');
  assert.equal(dump.format_version, EXPORT_FORMAT_VERSION);
  assert.equal(dump.sources.length, 1);
  assert.deepEqual(dump.sources[0].scope.include, ['**/*.md']);
  assert.equal(dump.sources[0].retention_days, 90);
  assert.equal(dump.sources[0].source_id, source.source_id);
  assert.equal(dump.documents.length, 2);
  assert.ok(dump.chunks.length >= 2);

  for (const chunk of dump.chunks) {
    assert.ok(chunk.locator.start_line >= 1);
    assert.ok(chunk.locator.end_byte > chunk.locator.start_byte);
    assert.equal(typeof chunk.text, 'string');
  }
  for (const doc of dump.documents) {
    assert.ok(doc.content_sha256);
    assert.ok(doc.harvested_at);
    assert.ok(doc.source_modified_at);
  }
  void root;
});

test('exported chunks reproduce the bytes of the real source file', () => {
  const { db, ctx, root } = setup();
  const dump = exportCorpus(db, ctx);
  const byId = new Map(dump.documents.map((d) => [d.document_id, d]));
  for (const chunk of dump.chunks) {
    const doc = byId.get(chunk.document_id);
    const raw = readFileSync(join(root, doc.uri));
    assert.equal(
      raw.subarray(chunk.locator.start_byte, chunk.locator.end_byte).toString('utf8'),
      chunk.text,
      `chunk ${chunk.chunk_id} does not match the bytes its locator claims`
    );
  }
});

test('export succeeds before a delete and returns an empty corpus after one', () => {
  const { db, ctx } = setup();
  const before = exportCorpus(db, ctx);
  assert.ok(before.documents.length > 0);
  assert.ok(before.chunks.length > 0);

  // A customer who cannot get their data out before deleting it does not control it.
  const held = JSON.parse(JSON.stringify(before));
  deleteCorpus(db, ctx);

  const after = exportCorpus(db, ctx);
  assert.equal(after.documents.length, 0);
  assert.equal(after.chunks.length, 0);
  assert.ok(held.chunks.some((c) => c.text.includes('refund')),
    'the export taken beforehand still holds the corpus');
});

test('the export is valid JSON that round-trips without loss', () => {
  const { db, ctx } = setup();
  const dump = exportCorpus(db, ctx);
  const round = JSON.parse(JSON.stringify(dump));
  assert.deepEqual(round, dump);
});

test('export includes the audit trail and harvest runs', () => {
  const { db, ctx, source } = setup();
  const dump = exportCorpus(db, ctx);
  assert.ok(dump.harvest_runs.length >= 1);
  assert.equal(dump.harvest_runs[0].source_id, source.source_id);
  const verbs = dump.audit_log.map((row) => row.verb);
  assert.ok(verbs.includes('connect'));
  assert.ok(verbs.includes('harvest'));
});

test('the export carries no api key material', () => {
  const { db, ctx, key } = setup();
  const serialized = JSON.stringify(exportCorpus(db, ctx));
  assert.ok(!serialized.includes(key));
  assert.ok(!serialized.includes('key_sha256'));
});
