import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';

import { cleanupAll, makeCorpus, tempDir, writeTree, HANDBOOK } from './helpers.js';
import { connectSource, deleteCorpus, deleteSource, exportCorpus, listSources, runHarvest, applyRetention }
  from '../src/corpus.js';
import { getDocument, search } from '../src/retrieve.js';
import { authenticate } from '../src/keys.js';

after(cleanupAll);

function setup(scope = { include: ['**/*.md'] }, extra = {}) {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'handbook', root, scope, ...extra
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  return { ...corpus, root, source };
}

// Source deletion.
test('deleting a source removes its content from every surface', () => {
  const { db, ctx, source } = setup();
  const documentId = search(db, ctx, { query: 'refund' }).hits[0].provenance.document_id;

  const result = deleteSource(db, ctx, source.source_id);
  assert.equal(result.documents_removed, 2);
  assert.ok(result.chunks_removed >= 2);

  assert.equal(search(db, ctx, { query: 'refund' }).count, 0);
  assert.throws(() => getDocument(db, ctx, documentId), /not_found/);
  assert.equal(listSources(db, ctx.tenant_id).length, 0);
});

test('deleting a source removes the FTS rows, not just the base rows', () => {
  const { db, ctx, source } = setup();
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n > 0);
  deleteSource(db, ctx, source.source_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n, 0,
    'an orphaned FTS row would still match and leak the text it holds');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE tenant_id = ?').get(ctx.tenant_id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents WHERE tenant_id = ?').get(ctx.tenant_id).n, 0);
});

test('a deleted source leaves a tombstone of ids and counts only', () => {
  const { db, ctx, source } = setup();
  deleteSource(db, ctx, source.source_id);
  const tombstone = db.prepare('SELECT * FROM source_tombstones WHERE source_id = ?').get(source.source_id);
  assert.equal(tombstone.documents_removed, 2);
  assert.ok(tombstone.deleted_at);
  const columns = db.prepare('PRAGMA table_info(source_tombstones)').all().map((c) => c.name);
  assert.deepEqual(columns.sort(),
    ['chunks_removed', 'deleted_at', 'documents_removed', 'source_id', 'tenant_id']);
});

test('get_document on a deleted document is a 404 with no body, not a redacted one', () => {
  const { db, ctx, source } = setup();
  const documentId = search(db, ctx, { query: 'refund' }).hits[0].provenance.document_id;
  deleteSource(db, ctx, source.source_id);
  try {
    getDocument(db, ctx, documentId);
    assert.fail('expected a not_found');
  } catch (err) {
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
    assert.equal(JSON.stringify(err.details).includes('refund'), false);
    assert.ok(!('text' in err), 'the error carries no content');
  }
});

// Corpus purge and key revocation.
test('deleting the corpus empties it and revokes every key in the same transaction', () => {
  const { db, ctx, key } = setup();
  const before = exportCorpus(db, ctx);
  assert.ok(before.documents.length > 0);

  const result = deleteCorpus(db, ctx);
  assert.ok(result.keys_revoked >= 1);

  const after = exportCorpus(db, ctx);
  assert.equal(after.documents.length, 0);
  assert.equal(after.chunks.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chunks_fts').get().n, 0);
  assert.throws(() => authenticate(db, key), /unauthorized/);
});

test('a second source belonging to the same tenant is deleted too', () => {
  const { db, ctx } = setup();
  const other = connectSource(db, ctx, {
    display_name: 'second', root: writeTree(tempDir(), { 'x.md': 'second corpus note\n' }),
    scope: { include: ['**/*.md'] }
  });
  runHarvest(db, ctx, other.source_id);
  assert.equal(listSources(db, ctx.tenant_id).length, 2);
  deleteCorpus(db, ctx);
  assert.equal(listSources(db, ctx.tenant_id).length, 0);
  assert.equal(search(db, ctx, { query: 'second' }).count, 0);
});

// Retention.
test('retention purges tombstoned documents past the window and leaves live ones alone', () => {
  const { db, ctx, source } = setup({ include: ['**/*.md'] }, { retention_days: 30 });
  const doc = db.prepare('SELECT id FROM documents WHERE uri = ? AND tenant_id = ?')
    .get('handbook/onboarding.md', ctx.tenant_id);

  // Tombstone it and age it past the window, the state a refresh would leave behind.
  db.prepare('UPDATE documents SET deleted_at = ?, harvested_at = ? WHERE id = ?')
    .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', doc.id);

  const result = applyRetention(db, ctx);
  assert.equal(result.documents_purged, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM documents WHERE id = ?').get(doc.id).n, 0);
  assert.equal(search(db, ctx, { query: 'refund' }).count, 1, 'live documents are untouched');
  void source;
});

test('retention does not purge a document that is still present at the source', () => {
  const { db, ctx } = setup({ include: ['**/*.md'] }, { retention_days: 1 });
  db.prepare('UPDATE documents SET harvested_at = ? WHERE tenant_id = ?')
    .run('2026-01-01T00:00:00.000Z', ctx.tenant_id);
  assert.equal(applyRetention(db, ctx).documents_purged, 0);
  assert.equal(search(db, ctx, { query: 'refund' }).count, 1);
});

test('retention purge removes the expired document path from every SQLite file', () => {
  const corpus = makeCorpus();
  const retiredPath = 'retired/private-marker-file.md';
  const root = writeTree(tempDir(), {
    [retiredPath]: 'expired retention marker content\n',
    'live.md': 'live retained note\n'
  });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'retention', root, scope: { include: ['**/*.md'] }, retention_days: 1
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  rmSync(`${root}/${retiredPath}`);
  runHarvest(corpus.db, corpus.ctx, source.source_id, 'refresh');
  corpus.db.prepare(`UPDATE documents SET harvested_at = ?, deleted_at = ?
                     WHERE source_id = ? AND uri = ?`)
    .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', source.source_id, retiredPath);
  assert.equal(applyRetention(corpus.db, corpus.ctx).documents_purged, 1);

  for (const file of readdirSync(corpus.dir).filter((name) => name.startsWith('corpus.db'))) {
    assert.ok(!readFileSync(`${corpus.dir}/${file}`).includes(Buffer.from(retiredPath)),
      `${file} retained the expired document path`);
  }
});

test('deleting an already deleted source is a not_found, not a silent success', () => {
  const { db, ctx, source } = setup();
  deleteSource(db, ctx, source.source_id);
  assert.throws(() => deleteSource(db, ctx, source.source_id), /not_found/);
});

// harvest_runs.skipped_json carries source paths; the sources row carries the absolute root and
// declared globs. Both are removed so a deleted source leaves no path history; the tombstone
// retains ids, counts and a timestamp only.
test('deleting a source leaves no path behind in any table', () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), {
    'Acme-layoffs-Q3/severance.md': '# Severance\n\npayout schedule\n',
    'Acme-layoffs-Q3/names.csv': 'a,b\n',
    'Acme-layoffs-Q3/huge.md': 'x'.repeat(9000)
  });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'sensitive', root, scope: { include: ['**/*.md'], max_file_bytes: 1024 }
  });
  const run = runHarvest(corpus.db, corpus.ctx, source.source_id);
  assert.ok(run.skipped.some((s) => s.reason === 'max_file_bytes'), 'the run really did skip a file');

  deleteSource(corpus.db, corpus.ctx, source.source_id);

  for (const { name } of corpus.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    let rows;
    try { rows = corpus.db.prepare(`SELECT * FROM "${name}"`).all(); } catch { continue; }
    const blob = JSON.stringify(rows);
    assert.ok(!blob.includes('Acme-layoffs-Q3'), `table ${name} retained a customer path`);
    assert.ok(!blob.includes(root), `table ${name} retained the source root`);
  }
  assert.equal(corpus.db.prepare('SELECT COUNT(*) AS n FROM harvest_runs').get().n, 0);
  assert.equal(corpus.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 0);
  assert.equal(corpus.db.prepare('SELECT COUNT(*) AS n FROM source_tombstones').get().n, 1);
});

test('purging the corpus leaves no path behind in any table', () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), {
    'Acme-layoffs-Q3/severance.md': '# Severance\n\npayout schedule\n',
    'Acme-layoffs-Q3/names.csv': 'a,b\n'
  });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'sensitive', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);

  deleteCorpus(corpus.db, corpus.ctx);

  for (const { name } of corpus.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    let rows;
    try { rows = corpus.db.prepare(`SELECT * FROM "${name}"`).all(); } catch { continue; }
    const blob = JSON.stringify(rows);
    assert.ok(!blob.includes('Acme-layoffs-Q3'), `table ${name} retained a customer path`);
    assert.ok(!blob.includes(root), `table ${name} retained the source root`);
  }
});

test('a purge covers a source that was already individually deleted', () => {
  const corpus = makeCorpus();
  const first = connectSource(corpus.db, corpus.ctx, {
    display_name: 'one', root: writeTree(tempDir(), { 'a.md': 'alpha note\n' }),
    scope: { include: ['**/*.md'] }
  });
  const second = connectSource(corpus.db, corpus.ctx, {
    display_name: 'two', root: writeTree(tempDir(), { 'b.md': 'beta note\n' }),
    scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, first.source_id);
  runHarvest(corpus.db, corpus.ctx, second.source_id);
  deleteSource(corpus.db, corpus.ctx, first.source_id);

  const purged = deleteCorpus(corpus.db, corpus.ctx);
  assert.equal(purged.sources_deleted, 1, 'only the still-live source remains to delete');
  assert.equal(corpus.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n, 0);
  assert.equal(search(corpus.db, corpus.ctx, { query: 'beta' }).count, 0);
});

test('source delete and corpus purge remove customer bytes from every SQLite file', () => {
  for (const deletion of ['source', 'corpus']) {
    const corpus = makeCorpus();
    const marker = `SYNTHETIC_PHYSICAL_DELETE_${deletion.toUpperCase()}_MARKER`;
    const root = writeTree(tempDir(`ch-physical-${deletion}-`), {
      'private/customer-note.md': `${marker}\n`
    });
    const source = connectSource(corpus.db, corpus.ctx, {
      display_name: 'physical deletion proof', root, scope: { include: ['**/*.md'] }
    });
    runHarvest(corpus.db, corpus.ctx, source.source_id);

    if (deletion === 'source') deleteSource(corpus.db, corpus.ctx, source.source_id);
    else deleteCorpus(corpus.db, corpus.ctx);

    for (const file of readdirSync(corpus.dir)) {
      const bytes = readFileSync(`${corpus.dir}/${file}`);
      assert.ok(!bytes.includes(Buffer.from(marker)), `${file} retained deleted chunk bytes`);
      assert.ok(!bytes.includes(Buffer.from(root)), `${file} retained the deleted source root`);
      assert.ok(!bytes.includes(Buffer.from('private/customer-note.md')),
        `${file} retained a deleted relative path`);
    }
  }
});

test('deleting one source removes its terms from FTS segments while another source stays live', () => {
  const corpus = makeCorpus();
  const marker = 'ftssecuredeletemarkerqzjx';
  // Enough rows to make FTS5 retain real segment structure rather than collapsing the tiny index
  // used by the basic deletion test. The second source keeps that index alive after the delete.
  const victimFiles = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [
    `victim-${i}.md`, `${marker} private victim ${i}\n`
  ]));
  const liveFiles = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [
    `live-${i}.md`, `harmless retained material ${i}\n`
  ]));
  const victimRoot = writeTree(tempDir('ch-fts-victim-'), victimFiles);
  const liveRoot = writeTree(tempDir('ch-fts-live-'), liveFiles);
  const victim = connectSource(corpus.db, corpus.ctx, {
    display_name: 'victim', root: victimRoot, scope: { include: ['**/*.md'] }
  });
  const live = connectSource(corpus.db, corpus.ctx, {
    display_name: 'live', root: liveRoot, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, victim.source_id);
  runHarvest(corpus.db, corpus.ctx, live.source_id);

  deleteSource(corpus.db, corpus.ctx, victim.source_id);

  assert.ok(search(corpus.db, corpus.ctx, { query: 'harmless' }).count > 0,
    'the retained source really is still indexed');
  for (const file of readdirSync(corpus.dir).filter((name) => name.startsWith('corpus.db'))) {
    assert.ok(!readFileSync(`${corpus.dir}/${file}`).includes(Buffer.from(marker)),
      `${file} retained a deleted term in an FTS segment`);
  }
});
