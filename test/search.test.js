import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { cleanupAll, makeCorpus, tempDir, writeTree } from './helpers.js';
import { connectSource, runHarvest } from '../src/corpus.js';
import { search, toFtsQuery } from '../src/retrieve.js';
import { openDb, migrateFtsTokenizer, FTS_TOKENIZER } from '../src/db.js';

after(cleanupAll);

const POLICY = {
  'policy.md':
    '# Support policy\n\n'
    + 'Refunds are issued within five business days of an approved request.\n'
    + 'Escalations page the duty lead after fifteen minutes with no response.\n'
};

function setup(files = POLICY) {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), files);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'policy', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  return { ...corpus, root, source };
}

// The corpus held one document about "Refunds" and a search for "refund" returned nothing. Every
// test until then happened to use the exact word form present in the fixture, so nothing caught
// it. For a retrieval product this is not a nicety -- it is the difference between finding the
// answer and not.
test('an inflected query reaches the document, not only the exact word form', () => {
  const { db, ctx } = setup();
  for (const [query, why] of [
    ['refund', 'singular query, plural in the document'],
    ['refunds', 'exact form'],
    ['escalation', 'singular query, plural in the document'],
    ['issue', 'stem of "issued"'],
    ['approve', 'stem of "approved"'],
    ['REFUND', 'case-insensitive']
  ]) {
    assert.equal(search(db, ctx, { query }).count, 1, `"${query}" (${why}) found nothing`);
  }
});

test('a query for a word that is genuinely absent still returns nothing', () => {
  const { db, ctx } = setup();
  for (const query of ['pelican', 'chargeback', 'zzzzqqqq']) {
    assert.equal(search(db, ctx, { query }).count, 0, `"${query}" matched something it should not`);
  }
});

test('source filters use a fixed number of SQLite bindings even for a very large array', () => {
  const { db, ctx, source } = setup();
  // The previous implementation built one placeholder and spread one argument per id. Depending
  // on the SQLite build, that failed at its variable limit or failed in JavaScript first while
  // spreading the arguments. Repeating one valid id keeps the expected result unambiguous.
  const sourceIds = Array(250_000).fill(source.source_id);
  const result = search(db, ctx, { query: 'refund', source_ids: sourceIds });
  assert.equal(result.count, 1);
  assert.equal(result.hits[0].provenance.source_id, source.source_id);
});

test('the corpus index uses the declared tokenizer', () => {
  const { db } = setup();
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get().sql;
  assert.ok(sql.includes(FTS_TOKENIZER), `chunks_fts is not built with ${FTS_TOKENIZER}: ${sql}`);
});

test('the corpus index enables FTS5 secure deletion', () => {
  const { db } = setup();
  const row = db.prepare("SELECT v FROM chunks_fts_config WHERE k = 'secure-delete'").get();
  assert.equal(Number(row.v), 1);
});

// CREATE VIRTUAL TABLE IF NOT EXISTS silently keeps an existing table's tokenizer, so a corpus
// built before the change would keep searching the old way with nothing to show for it.
test('a corpus built with the old tokenizer is migrated in place, keeping its rows', () => {
  const dir = tempDir('ch-migrate-');
  const path = join(dir, 'corpus.db');

  const legacy = openDb(path);
  legacy.exec('DROP TABLE chunks_fts');
  legacy.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, tokenize='unicode61')");
  legacy.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)')
    .run(1, 'Refunds are issued within five business days.');
  legacy.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)')
    .run(2, 'Escalations page the duty lead.');
  assert.equal(legacy.prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?')
    .get('"refund"').n, 0, 'the legacy index really does miss the singular');
  legacy.close();

  const migrated = openDb(path);
  const sql = migrated.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'").get().sql;
  assert.ok(sql.includes(FTS_TOKENIZER));
  assert.equal(migrated.prepare('SELECT count(*) AS n FROM chunks_fts').get().n, 2,
    'no chunk text was lost in the migration');
  assert.equal(migrated.prepare('SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?')
    .get('"refund"').n, 1);
  assert.equal(migrated.prepare('SELECT rowid, text FROM chunks_fts ORDER BY rowid').all()[1].rowid, 2,
    'rowids are preserved, so the join back to chunks still holds');

  assert.equal(migrateFtsTokenizer(migrated), false, 'migrating an already-current corpus is a no-op');
  migrated.close();
});

test('search terms are matched literally; FTS syntax is not exposed', () => {
  assert.equal(toFtsQuery('refund policy'), '"refund" OR "policy"');
  assert.equal(toFtsQuery('a AND b'), '"a" OR "AND" OR "b"');
  assert.equal(toFtsQuery('"quoted" (paren) *star*'), '"quoted" OR "paren" OR "star"');
  assert.equal(toFtsQuery('col:value'), '"col" OR "value"');
  assert.throws(() => toFtsQuery('   '), /bad_request/);
  assert.throws(() => toFtsQuery('()*'), /bad_request/);
  assert.throws(() => toFtsQuery(null), /bad_request/);
});

test('a query built from punctuation-only input never reaches SQLite as syntax', () => {
  const { db, ctx } = setup();
  for (const query of ['"', '""', 'NEAR(', 'a AND (b', '^', '-', ':']) {
    let result;
    try { result = search(db, ctx, { query }); } catch (err) {
      assert.equal(err.code, 'bad_request', `"${query}" produced ${err.code}`);
      continue;
    }
    assert.ok(Array.isArray(result.hits), `"${query}" returned something unexpected`);
  }
});

test('hits come back in a stable order for the same query', () => {
  const { db, ctx } = setup({
    'a.md': 'refund policy alpha\n',
    'b.md': 'refund policy beta\n',
    'c.md': 'refund policy gamma\n'
  });
  const first = search(db, ctx, { query: 'refund policy' }).hits.map((h) => h.chunk_id);
  const second = search(db, ctx, { query: 'refund policy' }).hits.map((h) => h.chunk_id);
  assert.equal(first.length, 3);
  assert.deepEqual(first, second);
});
