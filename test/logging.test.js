import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

import { cleanupAll, makeCorpus, tempDir, writeTree } from './helpers.js';
import { connectSource, deleteCorpus, deleteSource, exportCorpus, runHarvest } from '../src/corpus.js';
import { getDocument, search } from '../src/retrieve.js';
import { createHttpServer } from '../src/http.js';
import { log, setLogSink } from '../src/log.js';
import { issueKey, revokeKey } from '../src/keys.js';

after(cleanupAll);

// Distinctive markers so a leak is unambiguous rather than a judgement call.
const SECRET_TEXT = 'ZZQQ_CONFIDENTIAL_CHUNK_BODY_MARKER';
const SECRET_DIR = 'Acme-layoffs-Q3';
const FIXTURES = {
  [`${SECRET_DIR}/severance.md`]: `# Severance\n\n${SECRET_TEXT} governs the payout schedule.\n`,
  'public/readme.md': '# Readme\n\nnothing sensitive here\n'
};

function captureLogs() {
  const lines = [];
  setLogSink((line) => lines.push(line));
  return {
    lines,
    restore: () => setLogSink((line) => process.stderr.write(line + '\n'))
  };
}

// Logging keeps secrets, content and paths out of records.
test('a full lifecycle over HTTP writes no key, no chunk text, and no path to the log', async () => {
  const { db, ctx, tenant } = makeCorpus();
  const root = writeTree(tempDir(), FIXTURES);
  const issued = issueKey(db, tenant.id, 'logging', 'admin');
  const capture = captureLogs();

  const server = createHttpServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body) => fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  try {
    const connected = await (await call('POST', '/v1/sources', {
      display_name: 'sensitive', root, scope: { include: ['**/*.md'] }
    })).json();
    await call('POST', `/v1/sources/${connected.source_id}/harvest`, {});
    writeFileSync(join(root, `${SECRET_DIR}/extra.md`), `${SECRET_TEXT} again\n`);
    await call('POST', `/v1/sources/${connected.source_id}/refresh`, {});
    const found = await (await call('POST', '/v1/search', { query: 'severance payout' })).json();
    assert.ok(found.count >= 1, 'the lifecycle really did retrieve the sensitive content');
    await call('GET', `/v1/documents/${found.hits[0].provenance.document_id}`);
    await call('GET', '/v1/export');
    await call('GET', '/v1/documents/doc_does_not_exist');
    await fetch(`${base}/v1/sources`, { headers: { authorization: 'Bearer ch_wrongkey' } });
    await call('POST', `/v1/keys/${issued.key_id}/revoke`, {});
  } finally {
    server.close();
    capture.restore();
  }

  const written = capture.lines.join('\n');
  assert.ok(written.length > 0, 'the run really did log something');
  assert.ok(!written.includes(issued.key), 'the bearer token must never be logged');
  assert.ok(!written.includes(SECRET_TEXT), 'chunk text must never be logged');
  assert.ok(!written.includes(SECRET_DIR), 'a customer path must never be logged');
  assert.ok(!written.includes(root), 'the source root must never be logged');
  assert.ok(!written.includes('severance'), 'a filename must never be logged');
});

test('the audit table has no column that could hold content or a path', () => {
  const { db } = makeCorpus();
  const columns = db.prepare('PRAGMA table_info(audit_log)').all().map((c) => c.name);
  assert.deepEqual(columns.sort(), [
    'actor_key_id', 'at', 'document_count', 'id', 'outcome', 'source_id', 'tenant_id', 'verb'
  ]);
});

test('audit rows written during a full lifecycle carry no content, path, or key', () => {
  const { db, ctx, tenant } = makeCorpus();
  const root = writeTree(tempDir(), FIXTURES);
  const issued = issueKey(db, tenant.id, 'audit');
  const actorCtx = { tenant_id: tenant.id, key_id: issued.key_id };

  const source = connectSource(db, actorCtx, {
    display_name: 'sensitive', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(db, actorCtx, source.source_id);
  const hit = search(db, actorCtx, { query: 'severance' }).hits[0];
  getDocument(db, actorCtx, hit.provenance.document_id);
  exportCorpus(db, actorCtx);
  revokeKey(db, issued.key_id, tenant.id);
  deleteSource(db, actorCtx, source.source_id);

  const rows = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  assert.ok(rows.length > 2);
  assert.ok(!rows.includes(SECRET_TEXT));
  assert.ok(!rows.includes(SECRET_DIR));
  assert.ok(!rows.includes(root));
  assert.ok(!rows.includes(issued.key));
  void ctx;
});

test('the logger drops any field that is not an id, a count, or a bounded category', () => {
  const capture = captureLogs();
  log({
    verb: 'search',
    outcome: 'ok',
    hit_count: 3,
    uri: 'Acme-layoffs-Q3/severance.md',
    path: '/Users/someone/private',
    text: SECRET_TEXT,
    authorization: 'Bearer ch_live_key',
    query: 'severance payout'
  });
  capture.restore();
  const line = capture.lines[0];
  assert.ok(line.includes('"verb":"search"'));
  assert.ok(line.includes('"hit_count":3'));
  for (const leaked of ['Acme-layoffs-Q3', '/Users/someone/private', SECRET_TEXT, 'ch_live_key', 'severance payout']) {
    assert.ok(!line.includes(leaked), `the logger emitted "${leaked}"`);
  }
});

test('an error response carries a code and a bounded reason, never the request or content', async () => {
  const { db, tenant } = makeCorpus();
  const issued = issueKey(db, tenant.id, 'errors', 'admin');
  const server = createHttpServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/v1/sources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${issued.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: 'x', root: `/no/such/${SECRET_DIR}` })
    });
    const body = await res.text();
    assert.equal(res.status, 400);
    assert.ok(!body.includes(SECRET_DIR), 'the error echoed the path back');
    assert.deepEqual(JSON.parse(body), { error: 'bad_request', reason: 'root_unreachable' });
  } finally {
    server.close();
  }
});

test('deleting the corpus leaves no chunk text anywhere in the database file', () => {
  const { db, ctx, dir } = makeCorpus();
  const root = writeTree(tempDir(), FIXTURES);
  const source = connectSource(db, ctx, {
    display_name: 'sensitive', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(db, ctx, source.source_id);
  assert.equal(search(db, ctx, { query: 'severance' }).count, 1);

  deleteCorpus(db, ctx);

  for (const file of readdirSync(dir).filter((name) => name.startsWith('corpus.db'))) {
    assert.ok(!readFileSync(join(dir, file)).includes(Buffer.from(SECRET_TEXT)),
      `${file} still holds raw chunk bytes`);
  }
});

// SQLite creates the database and WAL before the final file mode is tightened.
// schema write, but SQLite had already created the -wal sidecar by then and copies the database
// file's mode onto it. The corpus sat at 0600 beside a 0644 write-ahead log holding recent page
// images -- that is, holding chunk text. THREAT-MODEL.md T9.
test('the corpus and every sidecar it creates are 0600, across open, write, close and reopen', async () => {
  const { openDb } = await import('../src/db.js');
  const { connectSource, runHarvest } = await import('../src/corpus.js');
  const { ensureTenant } = await import('../src/keys.js');
  const { readdirSync, statSync } = await import('node:fs');

  const dir = tempDir('ch-perm-');
  const dbPath = join(dir, 'corpus.db');
  const root = writeTree(tempDir(), FIXTURES);

  const modes = () => readdirSync(dir).map((file) => [file, statSync(join(dir, file)).mode & 0o777]);
  const assertAll600 = (label) => {
    const seen = modes();
    assert.ok(seen.length > 0, `${label}: no database file was created`);
    for (const [file, mode] of seen) {
      assert.equal(mode, 0o600, `${label}: ${file} is ${mode.toString(8)}, not 600`);
    }
  };

  let db = openDb(dbPath);
  assertAll600('after open');
  const tenant = ensureTenant(db);
  const ctx = { tenant_id: tenant.id, key_id: null };
  const source = connectSource(db, ctx, {
    display_name: 'sensitive', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(db, ctx, source.source_id);
  assertAll600('after harvest');
  // The write-ahead log really does hold the corpus, which is why its mode matters.
  assert.ok(readdirSync(dir).some((f) => f.endsWith('-wal')), 'a WAL sidecar exists to check');
  db.close();

  db = openDb(dbPath);
  runHarvest(db, ctx, source.source_id, 'refresh');
  assertAll600('after reopen and refresh');
  db.close();
});
