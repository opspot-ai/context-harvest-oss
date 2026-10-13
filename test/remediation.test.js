import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, linkSync, readFileSync, readdirSync, renameSync, statSync,
  writeFileSync
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { cleanupAll, addTenant, makeCorpus, tempDir, writeTree } from './helpers.js';
import { openDb } from '../src/db.js';
import {
  connectSource, deleteSource, exportCorpus, runHarvest
} from '../src/corpus.js';
import { getDocument, search } from '../src/retrieve.js';
import { authenticate, issueKey } from '../src/keys.js';
import { createHttpServer } from '../src/http.js';
import { createMcpHttpServer, createMcpServer } from '../src/mcp.js';

after(cleanupAll);

const parseTool = (result) => JSON.parse(result.content[0].text);
const sha256Text = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function mcpSession(db, key) {
  const server = createMcpServer(db, () => authenticate(db, key));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'remediation-test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function httpServer(db) {
  const server = createHttpServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close()
  };
}

test('B1: deleting a source after an FTS tokenizer migration removes the copied bytes', () => {
  const corpus = makeCorpus();
  const marker = 'zzqqsyntheticmigrationresiduemarker';
  const root = writeTree(tempDir('ch-migration-delete-'), {
    'private.md': `${marker} synthetic private text\n`
  });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'migration victim', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);

  const rows = corpus.db.prepare(`SELECT c.rowid, f.text FROM chunks c
    JOIN chunks_fts f ON f.rowid = c.rowid WHERE c.tenant_id = ?`).all(corpus.ctx.tenant_id);
  corpus.db.exec('DROP TABLE chunks_fts');
  corpus.db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, tokenize='unicode61')");
  for (const row of rows) {
    corpus.db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)').run(row.rowid, row.text);
  }
  corpus.db.close();

  const migrated = openDb(join(corpus.dir, 'corpus.db'));
  deleteSource(migrated, corpus.ctx, source.source_id);
  migrated.close();
  for (const file of readdirSync(corpus.dir).filter((name) => name.startsWith('corpus.db'))) {
    assert.ok(!readFileSync(join(corpus.dir, file)).includes(Buffer.from(marker)),
      `${file} retained text copied through the old FTS table`);
  }
});

test('B2/B2b: every chunk and every requested range has byte-exact and line-exact provenance', () => {
  const files = {
    'trailing.md': 'alpha\nbeta\ngamma\n',
    'no-trailing.md': 'alpha\nbeta\ngamma',
    'crlf.md': 'alpha\r\nbeta\r\ngamma\r\n',
    'blank-gap.md': `alpha\n${Array.from({ length: 18 }, () => ' '.repeat(240)).join('\n')}\nomega\n`,
    'utf8.md': 'café 東京 😀\nnaïve résumé\nfin\n',
    'long-line.md': `${'x'.repeat(5000)}\ntail`
  };
  const corpus = makeCorpus();
  const root = writeTree(tempDir('ch-provenance-'), files);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'adversarial text', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);

  const documents = corpus.db.prepare('SELECT id, uri FROM documents WHERE tenant_id = ? ORDER BY uri')
    .all(corpus.ctx.tenant_id);
  for (const document of documents) {
    const raw = readFileSync(join(root, document.uri));
    const lineStarts = [0];
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === 0x0a && i + 1 < raw.length) lineStarts.push(i + 1);
    }
    const lineCount = lineStarts.length;
    const chunks = corpus.db.prepare(`SELECT c.*, f.text FROM chunks c
      JOIN chunks_fts f ON f.rowid = c.rowid WHERE c.document_id = ? ORDER BY c.ordinal`)
      .all(document.id);
    assert.ok(chunks.length > 0, `${document.uri} produced no chunks`);
    for (const chunk of chunks) {
      assert.equal(raw.subarray(chunk.start_byte, chunk.end_byte).toString('utf8'), chunk.text);
      assert.equal(chunk.start_line,
        1 + raw.subarray(0, chunk.start_byte).filter((byte) => byte === 0x0a).length);
      const newlinesThroughEnd = raw.subarray(0, chunk.end_byte).filter((byte) => byte === 0x0a).length;
      const expectedEndLine = newlinesThroughEnd + (raw[chunk.end_byte - 1] === 0x0a ? 0 : 1);
      assert.equal(chunk.end_line, expectedEndLine, `${document.uri} end_line overruns`);
      assert.ok(chunk.end_line <= lineCount, `${document.uri} names a phantom line`);
    }

    for (let startLine = 1; startLine <= lineCount; startLine += 1) {
      for (let endLine = startLine; endLine <= lineCount; endLine += 1) {
        const result = getDocument(corpus.db, corpus.ctx, document.id, {
          start_line: startLine, end_line: endLine
        });
        const startByte = lineStarts[startLine - 1];
        const endByte = endLine < lineCount ? lineStarts[endLine] : raw.length;
        assert.deepEqual(result.provenance.locator,
          { start_line: startLine, end_line: endLine, start_byte: startByte, end_byte: endByte },
          `${document.uri} lines ${startLine}-${endLine}`);
        assert.equal(result.text, raw.subarray(startByte, endByte).toString('utf8'));
      }
    }
  }
});

test('B3: CLI bootstrap emits one admin key and every later corpus command authenticates', () => {
  const dir = tempDir('ch-cli-auth-');
  const dbPath = join(dir, 'corpus.db');
  const root = writeTree(join(dir, 'source'), { 'note.md': 'synthetic cli marker\n' });
  const cli = (args, env = {}) => spawnSync(process.execPath,
    [new URL('../bin/context-harvest.js', import.meta.url).pathname, '--db', dbPath, ...args], {
      encoding: 'utf8', env: { ...process.env, ...env }
    });

  const initialized = cli(['init', '--name', 'cli tenant']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const bootstrap = JSON.parse(initialized.stdout);
  assert.equal(bootstrap.scope, 'admin');
  assert.ok(bootstrap.key.startsWith('ch_'));

  const anonymousIssue = cli(['key', 'issue']);
  assert.equal(anonymousIssue.status, 1);
  assert.equal(JSON.parse(anonymousIssue.stderr).error, 'unauthorized');

  const added = cli(['source', 'add', '--name', 'cli source', '--root', root, '--include', '**/*.md'],
    { CH_API_KEY: bootstrap.key });
  assert.equal(added.status, 0, added.stderr);
  const sourceId = JSON.parse(added.stdout).source_id;
  assert.equal(cli(['harvest', '--source', sourceId], { CH_API_KEY: bootstrap.key }).status, 0);

  const anonymousSearch = cli(['search', '--query', 'synthetic', '--tenant', bootstrap.tenant_id]);
  assert.equal(anonymousSearch.status, 1, anonymousSearch.stdout);
  assert.equal(JSON.parse(anonymousSearch.stderr).error, 'unauthorized');
  const authenticatedSearch = cli(['search', '--query', 'synthetic'], { CH_API_KEY: bootstrap.key });
  assert.equal(JSON.parse(authenticatedSearch.stdout).count, 1);
  const attributedIssue = cli(['key', 'issue', '--label', 'attributed'], { CH_API_KEY: bootstrap.key });
  assert.equal(attributedIssue.status, 0, attributedIssue.stderr);
  const reopened = openDb(dbPath);
  const issueAudit = reopened.prepare("SELECT actor_key_id FROM audit_log WHERE verb = 'key_issue' ORDER BY rowid DESC")
    .get();
  assert.equal(issueAudit.actor_key_id, bootstrap.key_id);
  reopened.close();
});

test('B4: retrieve-scoped keys read over HTTP and MCP but cannot actuate the control plane', async () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), { 'note.md': 'synthetic scoped retrieval marker\n' });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'scoped', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  const retrieveKey = issueKey(corpus.db, corpus.tenant.id, 'agent');
  assert.equal(retrieveKey.scope, 'retrieve');
  const http = await httpServer(corpus.db);
  const call = (method, path, body) => fetch(http.base + path, {
    method,
    headers: { authorization: `Bearer ${retrieveKey.key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  try {
    assert.equal((await call('POST', '/v1/search', { query: 'synthetic' })).status, 200);
    assert.equal((await call('GET', '/v1/sources')).status, 200);
    for (const [method, path, body] of [
      ['POST', '/v1/sources', { display_name: 'x', root }],
      ['POST', `/v1/sources/${source.source_id}/harvest`, {}],
      ['GET', '/v1/export'],
      ['DELETE', '/v1/corpus', {}],
      ['POST', `/v1/keys/${retrieveKey.key_id}/revoke`, {}]
    ]) {
      assert.equal((await call(method, path, body)).status, 403, `${method} ${path}`);
    }
    const mcp = await mcpSession(corpus.db, retrieveKey.key);
    try {
      const result = parseTool(await mcp.client.callTool({
        name: 'search_context', arguments: { query: 'synthetic' }
      }));
      assert.equal(result.count, 1);
    } finally { await mcp.close(); }
  } finally { http.close(); }
});

test('B5: one tenant cannot change another tenant published BM25 score', () => {
  const corpus = makeCorpus({ tenantName: 'tenant-a' });
  const b = addTenant(corpus.db, 'tenant-b');
  const bFiles = { 'match.md': 'layoff synthetic target\n' };
  for (let i = 0; i < 30; i += 1) bFiles[`filler-${i}.md`] = `unrelated synthetic filler ${i}\n`;
  const bSource = connectSource(corpus.db, b.ctx, {
    display_name: 'b', root: writeTree(tempDir(), bFiles), scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, b.ctx, bSource.source_id);
  const before = search(corpus.db, b.ctx, { query: 'layoff' }).hits[0].score;

  const aFiles = {};
  for (let i = 0; i < 16; i += 1) aFiles[`private-${i}.md`] = `layoff private synthetic ${i}\n`;
  const aSource = connectSource(corpus.db, corpus.ctx, {
    display_name: 'a', root: writeTree(tempDir(), aFiles), scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, aSource.source_id);
  const afterScore = search(corpus.db, b.ctx, { query: 'layoff' }).hits[0].score;
  assert.equal(afterScore, before, `tenant A changed B's score from ${before} to ${afterScore}`);
});

test('F6: skipped paths remain in the live run response but never enter the database', () => {
  const corpus = makeCorpus();
  const marker = 'ZZQQ_PRIVATE_EXCLUDED_PATH_MARKER';
  const root = writeTree(tempDir(), {
    'public.md': 'public synthetic note\n',
    [`${marker}.md`]: 'excluded synthetic note\n'
  });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'excluded path proof', root,
    scope: { include: ['public.md'] }
  });
  const run = runHarvest(corpus.db, corpus.ctx, source.source_id);
  assert.ok(run.skipped.some((entry) => entry.uri === `${marker}.md`
    && entry.reason === 'not_included'));
  const columns = corpus.db.prepare('PRAGMA table_info(harvest_runs)').all().map((row) => row.name);
  assert.ok(!columns.includes('skipped_json'));
  corpus.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  for (const file of readdirSync(corpus.dir).filter((name) => name.startsWith('corpus.db'))) {
    assert.ok(!readFileSync(join(corpus.dir, file)).includes(Buffer.from(marker)),
      `${file} persisted an excluded path`);
  }
});

test('F6: upgrading an old skipped_json corpus removes historical path bytes', () => {
  const corpus = makeCorpus();
  const marker = 'ZZQQ_HISTORICAL_SKIPPED_PATH_MARKER';
  const root = writeTree(tempDir(), { 'public.md': 'synthetic migration note\n' });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'migration', root, scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(corpus.db, corpus.ctx, source.source_id);
  corpus.db.exec("ALTER TABLE harvest_runs ADD COLUMN skipped_json TEXT NOT NULL DEFAULT '[]'");
  corpus.db.prepare('UPDATE harvest_runs SET skipped_json = ? WHERE id = ?')
    .run(JSON.stringify([{ uri: `${marker}.md`, reason: 'not_included' }]), run.run_id);
  corpus.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  corpus.db.close();

  const upgraded = openDb(join(corpus.dir, 'corpus.db'));
  assert.ok(!upgraded.prepare('PRAGMA table_info(harvest_runs)').all()
    .some((column) => column.name === 'skipped_json'));
  upgraded.close();
  for (const file of readdirSync(corpus.dir).filter((name) => name.startsWith('corpus.db'))) {
    assert.ok(!readFileSync(join(corpus.dir, file)).includes(Buffer.from(marker)),
      `${file} retained a path from the removed migration column`);
  }
});

test('B8: an unreadable root reports unverified rather than stale', () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), { 'note.md': 'freshness synthetic marker\n' });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'unreadable', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  chmodSync(root, 0o000);
  try {
    assert.equal(search(corpus.db, corpus.ctx, { query: 'freshness' }).hits[0].freshness.state,
      'unverified');
  } finally {
    chmodSync(root, 0o700);
  }
});

test('B9: empty files are reported and whitespace bytes are not silently dropped', () => {
  const corpus = makeCorpus();
  const padded = `${' '.repeat(2200)}\nmeaningful synthetic text\n${' '.repeat(2200)}`;
  const root = writeTree(tempDir(), {
    'empty.md': '', 'whitespace.md': ' \t\n\n', 'padded.md': padded
  });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'zero chunk proof', root, scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(corpus.db, corpus.ctx, source.source_id);
  assert.ok(run.skipped.some((entry) => entry.uri === 'empty.md' && entry.reason === 'empty_file'));
  assert.equal(run.docs_added, 2);
  const exported = exportCorpus(corpus.db, corpus.ctx);
  for (const uri of ['whitespace.md', 'padded.md']) {
    const document = exported.documents.find((item) => item.uri === uri);
    const text = exported.chunks.filter((item) => item.document_id === document.document_id)
      .sort((a, b) => a.ordinal - b.ordinal).map((item) => item.text).join('');
    assert.equal(Buffer.byteLength(text), statSync(join(root, uri)).size, `${uri} lost bytes`);
  }
});

test('B10: every exported text_sha256 verifies the text actually returned', () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), { 'utf8.md': 'café naïve 東京 😀\n' });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'hash proof', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  for (const chunk of exportCorpus(corpus.db, corpus.ctx).chunks) {
    assert.equal(chunk.text_sha256, sha256Text(chunk.text));
  }
});

test('B11: content replacement cannot read fresh even when ordinary tools preserve metadata', () => {
  const corpus = makeCorpus();
  const original = 'alpha synthetic original marker\n';
  const replacement = 'omega synthetic replaced marker\n';
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(replacement));
  const root = writeTree(tempDir(), { 'note.md': original });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'hash freshness', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  const target = join(root, 'note.md');
  const reference = join(tempDir(), 'reference.md');
  copyFileSync(target, reference);
  // copyFile does not preserve timestamps by default. Make the reference reproduce the exact
  // harvested timestamp before using ordinary `touch -r` to restore it after replacement.
  execFileSync('touch', ['-r', target, reference]);
  writeFileSync(target, replacement);
  execFileSync('touch', ['-r', reference, target]);
  assert.equal(statSync(target, { bigint: true }).mtimeNs, statSync(reference, { bigint: true }).mtimeNs);
  assert.equal(search(corpus.db, corpus.ctx, { query: 'alpha' }).hits[0].freshness.state, 'stale');

  const replacementRoot = writeTree(tempDir(), { 'note.md': replacement });
  execFileSync('touch', ['-r', reference, join(replacementRoot, 'note.md')]);
  renameSync(root, root + '-old');
  renameSync(replacementRoot, root);
  assert.equal(search(corpus.db, corpus.ctx, { query: 'alpha' }).hits[0].freshness.state, 'stale');
});

test('F7: MCP validates actual arguments rather than trusting the advertised schema', async () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), { 'note.md': 'synthetic argument marker\n' });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'args', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  const documentId = search(corpus.db, corpus.ctx, { query: 'argument' }).hits[0].provenance.document_id;
  const mcp = await mcpSession(corpus.db, corpus.key);
  try {
    for (const [name, args, reason] of [
      ['get_document', { document_id: documentId, start_line: 'oops' }, 'start_line_must_be_positive_integer'],
      ['get_document', { document_id: documentId, unexpected: true }, 'unexpected_argument'],
      ['search_context', { query: 'argument', limit: 51 }, 'limit_must_be_at_most_50'],
      ['list_sources', { unexpected: true }, 'unexpected_argument']
    ]) {
      const result = await mcp.client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} accepted ${JSON.stringify(args)}`);
      assert.deepEqual(parseTool(result), { error: 'bad_request', reason });
    }
  } finally { await mcp.close(); }
});

test('F8a: GET /v1/keys is absent from the frozen HTTP surface', async () => {
  const corpus = makeCorpus();
  const http = await httpServer(corpus.db);
  const call = (method, path) => fetch(http.base + path, {
    method, headers: { authorization: `Bearer ${corpus.key}`, 'content-type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined
  });
  try {
    assert.equal((await call('GET', '/v1/keys')).status, 404);
  } finally { http.close(); }
});

test('F8b: a cross-tenant key id returns an honest 404 on revoke', async () => {
  const corpus = makeCorpus();
  const other = addTenant(corpus.db, 'other');
  const http = await httpServer(corpus.db);
  const call = (method, path) => fetch(http.base + path, {
    method, headers: { authorization: `Bearer ${corpus.key}`, 'content-type': 'application/json' },
    body: method === 'POST' ? '{}' : undefined
  });
  try {
    const cross = await call('POST', `/v1/keys/${other.keyId}/revoke`);
    assert.equal(cross.status, 404);
    assert.deepEqual(await cross.json(), { error: 'not_found', what: 'key' });
  } finally { http.close(); }
});

test('B12: MCP retrieval is read-only and does not grow the audit log', async () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), { 'note.md': 'synthetic audit marker\n' });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'audit', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);
  const before = corpus.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  const mcp = await mcpSession(corpus.db, corpus.key);
  try {
    const found = parseTool(await mcp.client.callTool({
      name: 'search_context', arguments: { query: 'audit' }
    }));
    await mcp.client.callTool({
      name: 'get_document', arguments: { document_id: found.hits[0].provenance.document_id }
    });
    await mcp.client.callTool({ name: 'list_sources', arguments: {} });
  } finally { await mcp.close(); }
  assert.equal(corpus.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, before);
});

test('B13: MCP authenticates tool discovery, requires initialization, routes query strings, and errors unknown tools', async () => {
  const corpus = makeCorpus();

  const deniedServer = createMcpServer(corpus.db, () => { throw new Error('no key'); });
  const [deniedClientTransport, deniedServerTransport] = InMemoryTransport.createLinkedPair();
  const deniedClient = new Client({ name: 'denied', version: '0' }, { capabilities: {} });
  await Promise.all([deniedServer.connect(deniedServerTransport), deniedClient.connect(deniedClientTransport)]);
  await assert.rejects(() => deniedClient.listTools(), /unauthorized/i);
  await deniedClient.close(); await deniedServer.close();

  const rawServer = createMcpServer(corpus.db, () => authenticate(corpus.db, corpus.key));
  const [rawClientTransport, rawServerTransport] = InMemoryTransport.createLinkedPair();
  await rawServer.connect(rawServerTransport);
  const response = new Promise((resolve) => { rawClientTransport.onmessage = resolve; });
  await rawClientTransport.start();
  await rawClientTransport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const message = await response;
  assert.equal(message.error.code, -32600);
  await rawClientTransport.close(); await rawServer.close();

  const mcp = await mcpSession(corpus.db, corpus.key);
  try {
    await assert.rejects(
      () => mcp.client.callTool({ name: 'synthetic_unknown_tool', arguments: {} }),
      /-32601|unknown_tool/i
    );
  } finally { await mcp.close(); }

  const server = createMcpHttpServer(corpus.db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp?synthetic=1`);
  try {
    const client = new Client({ name: 'query-string', version: '0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${corpus.key}` } }
    }));
    assert.equal((await client.listTools()).tools.length, 3);
    await client.close();
  } finally { server.close(); }
});

test('B14: the first total-byte overflow stops the walk before later smaller files', () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), {
    'a-first.md': `${'a'.repeat(700)}\n`,
    'b-overflow.md': `${'b'.repeat(500)}\n`,
    'c-later-small.md': 'small synthetic\n'
  });
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'stop proof', root,
    scope: { include: ['**/*.md'], max_total_bytes: 1000 }
  });
  const run = runHarvest(corpus.db, corpus.ctx, source.source_id);
  assert.equal(run.truncated, true);
  assert.deepEqual(corpus.db.prepare('SELECT uri FROM documents WHERE tenant_id = ? ORDER BY uri')
    .all(corpus.ctx.tenant_id).map((row) => row.uri), ['a-first.md']);
  assert.ok(run.skipped.some((entry) => entry.uri === 'b-overflow.md'
    && entry.reason === 'max_total_bytes'));
});

test('max_file_bytes is enforced against bytes actually read, not only a pre-read stat', async () => {
  const folder = await import('../src/connectors/folder.js');
  assert.equal(typeof folder.readCandidateFile, 'function');
  const stats = [
    { isFile: () => true, size: 3n, nlink: 1n, dev: 1n, ino: 2n, mtimeNs: 10n },
    { isFile: () => true, size: 10n, nlink: 1n, dev: 1n, ino: 2n, mtimeNs: 11n }
  ];
  const result = folder.readCandidateFile('/synthetic/path', 5, 100, {
    open: () => 7,
    stat: () => stats.shift(),
    read: () => Buffer.from('0123456789'),
    close: () => {}
  });
  assert.deepEqual(result, { reason: 'max_file_bytes' });
});

test('B6: multiply-linked regular files are reported and never indexed', () => {
  const corpus = makeCorpus();
  const outside = writeTree(tempDir(), { 'outside.md': 'ZZQQ_HARDLINK_PRIVATE_MARKER\n' });
  const root = writeTree(tempDir(), { 'safe.md': 'safe synthetic note\n' });
  linkSync(join(outside, 'outside.md'), join(root, 'innocuous.md'));
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'hardlink proof', root, scope: { include: ['**/*.md'] }
  });
  const run = runHarvest(corpus.db, corpus.ctx, source.source_id);
  assert.ok(run.skipped.some((entry) => entry.uri === 'innocuous.md'
    && entry.reason === 'multiple_hardlinks'));
  assert.equal(search(corpus.db, corpus.ctx, { query: 'HARDLINK_PRIVATE_MARKER' }).count, 0);
});

test('B7: the package exposes an executable external-boundary egress gate', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(typeof pkg.scripts?.['test:egress-boundary'], 'string');
  const run = spawnSync('pnpm', ['run', 'test:egress-boundary'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
    env: { ...process.env, CH_EXPECTED_NODE_VERSION: process.version }
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(run.stdout.match(/sandboxed Node runtime verified:/g)?.length, 6);
  assert.match(run.stdout, /boundary denied outbound: EPERM/);
  for (const surface of ['cli', 'http', 'mcp-stdio', 'mcp-http']) {
    assert.match(run.stdout, new RegExp(`${surface}: seven-verb cycle passed`));
  }

  const mismatch = spawnSync('pnpm', ['run', 'test:egress-boundary'], {
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
    env: { ...process.env, CH_EXPECTED_NODE_VERSION: 'v0.0.0-ops401-negative-control' }
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(`${mismatch.stdout}\n${mismatch.stderr}`,
    /sandboxed Node runtime mismatch: expected v0\.0\.0-ops401-negative-control, actual v\d+\.\d+\.\d+/);

  const unpinnedEnv = { ...process.env };
  delete unpinnedEnv.CH_EXPECTED_NODE_VERSION;
  const unpinned = spawnSync('pnpm', ['run', 'test:egress-boundary'], {
    cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: unpinnedEnv
  });
  assert.notEqual(unpinned.status, 0);
  assert.match(`${unpinned.stdout}\n${unpinned.stderr}`,
    /CH_EXPECTED_NODE_VERSION must be set to the exact suite runtime/);
});
