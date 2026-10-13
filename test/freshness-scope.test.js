import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  constants, copyFileSync, linkSync, lstatSync, realpathSync, renameSync, symlinkSync,
  unlinkSync, utimesSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import * as folder from '../src/connectors/folder.js';
import { connectSource, runHarvest } from '../src/corpus.js';
import { getDocument, search } from '../src/retrieve.js';
import { makeFreshnessProbe } from '../src/freshness.js';
import { normalizeScope } from '../src/scope.js';
import { cleanupAll, makeCorpus, tempDir, writeTree } from './helpers.js';

after(cleanupAll);
const CONTENT = 'synthetic freshness scope marker\n';
const PINNED = new Date('2026-01-01T00:00:00Z');

function setup() {
  const corpus = makeCorpus();
  const root = realpathSync(writeTree(tempDir(), { 'nested/note.md': CONTENT }));
  const target = join(root, 'nested/note.md');
  utimesSync(target, PINNED, PINNED);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'synthetic scope', root,
    scope: { include: ['nested/**/*.md'], max_file_bytes: 64, max_total_bytes: 128 }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  const documentId = search(corpus.db, corpus.ctx, { query: 'marker' }).hits[0].provenance.document_id;
  return { ...corpus, root, target, source, documentId };
}

function assertState(corpus, state) {
  const hit = search(corpus.db, corpus.ctx, { query: 'marker' }).hits[0];
  assert.equal(hit.freshness.state, state);
  assert.equal(hit.text, CONTENT, 'retrieval still returns the indexed snapshot');
  assert.equal(getDocument(corpus.db, corpus.ctx, corpus.documentId).freshness.state, state);
}

for (const kind of ['symlink', 'hardlink', 'ancestor-symlink']) {
  test(`freshness refuses ${kind} replacement even with identical bytes and mtime`, () => {
    const corpus = setup();
    const copy = join(corpus.root, 'excluded.md');
    copyFileSync(corpus.target, copy);
    utimesSync(copy, PINNED, PINNED);
    if (kind === 'ancestor-symlink') {
      renameSync(join(corpus.root, 'nested'), join(corpus.root, 'excluded-dir'));
      symlinkSync('excluded-dir', join(corpus.root, 'nested'));
    } else {
      unlinkSync(corpus.target);
      if (kind === 'symlink') symlinkSync(copy, corpus.target);
      else linkSync(copy, corpus.target);
    }
    assertState(corpus, 'stale');
  });
}

test('a registered root replaced by a symlink is unverified and cannot be refreshed', () => {
  const corpus = setup();
  const moved = join(tempDir(), 'moved-source');
  renameSync(corpus.root, moved);
  symlinkSync(moved, corpus.root);
  assertState(corpus, 'unverified');
  assert.throws(() => runHarvest(corpus.db, corpus.ctx, corpus.source.source_id, 'refresh'),
    (error) => error.code === 'bad_request' && error.details.reason === 'root_unreachable');
});

test('freshness enforces declared inclusion, exclusion, file and remaining query byte limits', () => {
  const corpus = setup();
  const scope = corpus.source.scope;
  assert.equal(folder.statDocument(corpus.root, '../outside.md', scope), null);
  assert.equal(folder.statDocument(corpus.root, 'nested/note.md',
    { ...scope, exclude: ['nested/**'] }), null);
  assert.equal(folder.statDocument(corpus.root, 'nested/note.md',
    { ...scope, include: ['other/**'] }), null);
  assert.equal(folder.statDocument(corpus.root, 'nested/note.md', scope, 1), null);
  writeFileSync(corpus.target, 'x'.repeat(65));
  assert.equal(folder.statDocument(corpus.root, 'nested/note.md', scope), null);
  assertState(corpus, 'stale');
});

for (const fault of ['final-entry', 'ancestor']) {
  test(`freshness rejects injected ${fault} identity changes before reading any bytes`, () => {
    const corpus = setup();
    const leaf = lstatSync(corpus.target, { bigint: true });
    const changed = (stat) => Object.assign(Object.create(stat), { ino: stat.ino + 1n });
    let opened = false, reads = 0, closes = 0;
    const io = {
      realpath: realpathSync,
      lstat: (path) => {
        const stat = lstatSync(path, { bigint: true });
        return opened && fault === 'ancestor' && path === join(corpus.root, 'nested')
          ? changed(stat) : stat;
      },
      beforeOpen: () => { opened = true; },
      open: (_path, flags) => {
        assert.ok(flags & constants.O_NOFOLLOW);
        assert.ok(flags & constants.O_NONBLOCK, 'a raced-in FIFO must not block open');
        return 71;
      },
      stat: () => fault === 'final-entry' ? changed(leaf) : leaf,
      read: () => { reads++; return Buffer.from(CONTENT); },
      close: () => { closes++; }
    };
    assert.equal(folder.statDocument(corpus.root, 'nested/note.md', corpus.source.scope, 128, io), null);
    assert.equal(reads, 0);
    assert.equal(closes, 1);
  });
}

test('the production read loop stops at the byte budget even if a file keeps growing', () => {
  let readBytes = 0;
  const content = folder.readBoundedFile(71, 100_000, (_fd, buffer, offset, length) => {
    buffer.fill(120, offset, offset + length);
    readBytes += length;
    return length; // Simulate a source that never reaches EOF.
  });
  assert.equal(content.length, 100_000);
  assert.equal(readBytes, 100_000);
});

test('descriptor read receives the smaller budget and growth fails closed', () => {
  const before = {
    isFile: () => true, size: 3n, nlink: 1n, dev: 1n, ino: 2n, mtimeNs: 10n
  };
  let stats = 0;
  assert.deepEqual(folder.readCandidateFile('/synthetic', 64, 8, {
    open: () => 71,
    stat: () => stats++ ? { ...before, size: 100n } : before,
    read: (_fd, budget) => { assert.equal(budget, 8); return Buffer.alloc(budget); },
    close: () => {}
  }), { reason: 'max_file_bytes' });
});

test('query budget is per source and duplicate documents are only probed once', () => {
  const corpus = setup();
  const document = corpus.db.prepare('SELECT * FROM documents WHERE id = ?').get(corpus.documentId);
  const bytes = document.byte_size;
  const source = { id: corpus.source.source_id, root: corpus.root,
    scope: normalizeScope({ include: ['**/*.md'], max_total_bytes: bytes }) };
  const probe = makeFreshnessProbe();
  assert.equal(probe(source, document).state, 'fresh');
  assert.equal(probe(source, document).state, 'fresh');
  copyFileSync(corpus.target, join(corpus.root, 'other.md'));
  utimesSync(join(corpus.root, 'other.md'), PINNED, PINNED);
  assert.equal(probe(source, { ...document, uri: 'other.md' }).state, 'stale');
  assert.equal(probe({ ...source, id: 'separate-source' }, document).state, 'fresh');
});
