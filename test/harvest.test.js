import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { cleanupAll, makeCorpus, tempDir, writeTree, HANDBOOK } from './helpers.js';
import { connectSource, runHarvest } from '../src/corpus.js';
import { getDocument, search } from '../src/retrieve.js';

after(cleanupAll);

function setup(files = HANDBOOK, scope = { include: ['**/*.md'] }) {
  const { db, ctx, dir } = makeCorpus();
  const root = writeTree(tempDir(), files);
  const source = connectSource(db, ctx, { display_name: 'handbook', root, scope });
  return { db, ctx, dir, root, source };
}

// Refresh reconciliation.
test('refresh detects an added file', () => {
  const { db, ctx, root, source } = setup();
  runHarvest(db, ctx, source.source_id);
  writeFileSync(join(root, 'handbook/escalation.md'), '# Escalation\n\nPage the duty lead.\n');
  const run = runHarvest(db, ctx, source.source_id, 'refresh');
  assert.equal(run.docs_added, 1);
  assert.equal(run.docs_changed, 0);
  assert.equal(run.docs_removed, 0);
  assert.equal(run.docs_unchanged, 2);
  assert.equal(search(db, ctx, { query: 'escalation duty' }).count, 1);
});

test('refresh detects a changed file and replaces its chunks', () => {
  const { db, ctx, root, source } = setup();
  runHarvest(db, ctx, source.source_id);
  const before = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE tenant_id = ?').get(ctx.tenant_id).n;

  writeFileSync(join(root, 'handbook/refunds.md'),
    '# Refunds\n\nA refund is issued within TEN business days.\nSUPERSEDING_TEXT_MARKER\n');
  const run = runHarvest(db, ctx, source.source_id, 'refresh');

  assert.equal(run.docs_changed, 1);
  assert.equal(run.docs_added, 0);
  assert.equal(search(db, ctx, { query: 'SUPERSEDING_TEXT_MARKER' }).count, 1);
  assert.equal(search(db, ctx, { query: 'five' }).count, 0,
    'the superseded text must not remain searchable');
  const after = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE tenant_id = ?').get(ctx.tenant_id).n;
  assert.equal(after, before, 'a replaced document leaves no orphan chunks behind');
});

test('refresh removes superseded content from every SQLite file', () => {
  const marker = 'supersededphysicalmarkerxyzq';
  const { db, ctx, root, source, dir } = setup({ 'doc.md': `${marker} old text\n` });
  runHarvest(db, ctx, source.source_id);
  writeFileSync(join(root, 'doc.md'), 'replacement current text\n');
  runHarvest(db, ctx, source.source_id, 'refresh');

  for (const file of readdirSync(dir).filter((name) => name.startsWith('corpus.db'))) {
    assert.ok(!readFileSync(join(dir, file)).includes(Buffer.from(marker)),
      `${file} retained superseded content`);
  }
});

test('refresh detects a removed file and makes it immediately unreachable', () => {
  const { db, ctx, root, source } = setup();
  runHarvest(db, ctx, source.source_id);
  rmSync(join(root, 'handbook/onboarding.md'));
  const run = runHarvest(db, ctx, source.source_id, 'refresh');

  assert.equal(run.docs_removed, 1);
  assert.equal(search(db, ctx, { query: 'welcome call' }).count, 0);

  const doc = db.prepare('SELECT id, deleted_at FROM documents WHERE uri = ? AND tenant_id = ?')
    .get('handbook/onboarding.md', ctx.tenant_id);
  assert.ok(doc.deleted_at, 'a removed document keeps a metadata tombstone until retention');
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?').get(doc.id).n;
  assert.equal(chunks, 0, 'its content and index rows go immediately');
});

test('a file that returns is re-harvested rather than staying tombstoned', () => {
  const { db, ctx, root, source } = setup();
  runHarvest(db, ctx, source.source_id);
  rmSync(join(root, 'handbook/onboarding.md'));
  runHarvest(db, ctx, source.source_id, 'refresh');
  writeFileSync(join(root, 'handbook/onboarding.md'),
    '# Onboarding\n\nNew accounts get a welcome call within one business day.\n');
  const run = runHarvest(db, ctx, source.source_id, 'refresh');
  assert.equal(run.docs_changed, 1);
  assert.equal(search(db, ctx, { query: 'welcome call' }).count, 1);
});

test('an unchanged file is neither added nor changed on refresh', () => {
  const { db, ctx, source } = setup();
  runHarvest(db, ctx, source.source_id);
  const run = runHarvest(db, ctx, source.source_id, 'refresh');
  assert.deepEqual(
    { a: run.docs_added, c: run.docs_changed, r: run.docs_removed, u: run.docs_unchanged },
    { a: 0, c: 0, r: 0, u: 2 }
  );
});

test('a content-preserving touch is reconciled without re-chunking', () => {
  const { db, ctx, root, source } = setup();
  runHarvest(db, ctx, source.source_id);
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'handbook/refunds.md'), future, future);
  const run = runHarvest(db, ctx, source.source_id, 'refresh');
  assert.equal(run.docs_changed, 0);
  assert.equal(run.docs_unchanged, 2);
  assert.equal(search(db, ctx, { query: 'refund' }).hits[0].freshness.state, 'fresh');
});

test('harvest records counts while skip paths remain only in the live response', () => {
  const { db, ctx, source } = setup();
  const run = runHarvest(db, ctx, source.source_id);
  const row = db.prepare('SELECT * FROM harvest_runs WHERE id = ?').get(run.run_id);
  assert.equal(row.outcome, 'ok');
  assert.equal(row.docs_added, 2);
  assert.ok(row.finished_at);
  assert.ok(run.skipped.some((s) => s.reason === 'not_included'));
  assert.ok(!Object.hasOwn(row, 'skipped_json'));
});

test('harvesting a source whose root vanished fails closed and records the outcome', () => {
  const { db, ctx, root, source } = setup();
  runHarvest(db, ctx, source.source_id);
  rmSync(root, { recursive: true, force: true });
  assert.throws(() => runHarvest(db, ctx, source.source_id, 'refresh'), /bad_request/);
  const row = db.prepare('SELECT outcome FROM harvest_runs WHERE source_id = ? ORDER BY rowid DESC')
    .get(source.source_id);
  assert.equal(row.outcome, 'root_unreachable');
  const audits = db.prepare('SELECT outcome FROM audit_log WHERE tenant_id = ? ORDER BY rowid DESC')
    .all(ctx.tenant_id);
  assert.equal(audits[0].outcome, 'root_unreachable');
});

test('chunk locators point at the exact bytes and lines they came from', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ipsum dolor sit amet`).join('\n');
  const { db, ctx, root, source } = setup({ 'long.md': lines + '\n' });
  runHarvest(db, ctx, source.source_id);
  const raw = Buffer.from(lines + '\n');
  const rows = db.prepare(`SELECT c.start_byte, c.end_byte, c.start_line, c.end_line, f.text
                           FROM chunks c JOIN chunks_fts f ON f.rowid = c.rowid
                           WHERE c.tenant_id = ? ORDER BY c.ordinal`).all(ctx.tenant_id);
  assert.ok(rows.length > 1, 'a long file produces several chunks');
  for (const row of rows) {
    assert.equal(raw.subarray(row.start_byte, row.end_byte).toString('utf8'), row.text,
      'the byte locator reproduces the chunk text exactly');
    const firstLine = row.text.split('\n')[0];
    assert.equal(firstLine, `line ${row.start_line} ipsum dolor sit amet`);
  }
  assert.equal(rows[0].start_byte, 0);
  assert.equal(rows[rows.length - 1].end_byte, raw.length);
  void root;
});

test('a returned locator and content hash reproduce the real file bytes', () => {
  const { db, ctx, root, source } = setup();
  runHarvest(db, ctx, source.source_id);
  const hit = search(db, ctx, { query: 'refund' }).hits[0];
  const raw = readFileSync(join(root, hit.provenance.uri));
  const { start_byte: start, end_byte: end } = hit.provenance.locator;
  assert.equal(raw.subarray(start, end).toString('utf8'), hit.text);
  assert.equal(createHash('sha256').update(raw).digest('hex'), hit.provenance.content_sha256);
});

test('full-document provenance preserves whitespace-only spans between searchable text', () => {
  const contents = 'alpha searchable\n' + '\n'.repeat(5000) + 'omega searchable\n';
  const { db, ctx, root, source } = setup({ 'gap.md': contents });
  runHarvest(db, ctx, source.source_id);
  const hit = search(db, ctx, { query: 'alpha' }).hits[0];
  const document = getDocument(db, ctx, hit.provenance.document_id);
  const raw = readFileSync(join(root, 'gap.md'));
  const { start_byte: start, end_byte: end } = document.provenance.locator;
  assert.ok(raw.equals(Buffer.from(document.text, 'utf8')), 'get_document omitted source bytes');
  assert.ok(raw.subarray(start, end).equals(Buffer.from(document.text, 'utf8')),
    'the locator covers bytes that are absent from the returned text');
});
