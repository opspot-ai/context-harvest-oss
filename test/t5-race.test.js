import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  constants, lstatSync, realpathSync
} from 'node:fs';
import { join } from 'node:path';

import { cleanupAll, makeCorpus, tempDir, writeTree } from './helpers.js';
import { connectSource, exportCorpus, runHarvest } from '../src/corpus.js';
import { search } from '../src/retrieve.js';

after(cleanupAll);

const SENTINEL = 'ZZQQT5FAULTSENTINEL';

function changedIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino + 1n,
    mode: stat.mode,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    isDirectory: () => stat.isDirectory(),
    isFile: () => stat.isFile(),
    isSymbolicLink: () => stat.isSymbolicLink()
  };
}

function faultIo(root, candidate, fault) {
  const ancestor = join(root, 'nested');
  const leaf = lstatSync(candidate, { bigint: true });
  let afterResolve = false;
  let reads = 0;

  return {
    io: {
      realpath: (path) => realpathSync(path),
      lstat: (path) => {
        const stat = lstatSync(path, { bigint: true });
        if (afterResolve && fault === 'ancestor' && path === ancestor) {
          return changedIdentity(stat);
        }
        return stat;
      },
      beforeOpen: () => { afterResolve = true; },
      open: (path, flags) => {
        assert.equal(path, candidate);
        assert.ok((flags & constants.O_NOFOLLOW) !== 0, 'the leaf open must not follow symlinks');
        return 71;
      },
      stat: () => fault === 'final-entry' ? changedIdentity(leaf) : leaf,
      read: () => {
        reads += 1;
        return Buffer.from(`${SENTINEL}\n`);
      },
      close: () => {}
    },
    reads: () => reads
  };
}

function assertFaultFailsClosed(fault) {
  const corpus = makeCorpus();
  const root = writeTree(tempDir('ch-t5-fault-'), {
    'nested/candidate.md': 'synthetic in-scope control text\n'
  });
  const realRoot = realpathSync(root);
  const candidate = join(realRoot, 'nested/candidate.md');
  const injected = faultIo(realRoot, candidate, fault);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'T5 defensive fault probe', root, scope: { include: ['**/*.md'] }
  });

  const run = runHarvest(corpus.db, corpus.ctx, source.source_id, 'harvest', {
    connectorIo: injected.io
  });

  assert.deepEqual(run.skipped, [
    { uri: 'nested/candidate.md', reason: 'path_changed_during_open' }
  ]);
  assert.equal(injected.reads(), 0, 'identity faults must be rejected before any bytes are read');

  const corpusText = corpus.db.prepare('SELECT text FROM chunks_fts').all()
    .map((row) => row.text).join('\n');
  assert.ok(!corpusText.includes(SENTINEL), 'the sentinel must not enter the corpus');
  assert.equal(search(corpus.db, corpus.ctx, { query: SENTINEL }).count, 0,
    'the sentinel must not be retrievable');
  assert.ok(!JSON.stringify(exportCorpus(corpus.db, corpus.ctx)).includes(SENTINEL),
    'the sentinel must not enter an export');
}

test('T5-RACE: a defensive final-entry identity fault fails closed before read', () => {
  assertFaultFailsClosed('final-entry');
});

test('T5-RACE: a defensive ancestor-chain identity fault fails closed before read', () => {
  assertFaultFailsClosed('ancestor');
});
