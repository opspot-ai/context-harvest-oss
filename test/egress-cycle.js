import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const surface = process.argv[2];
assert.ok(['cli', 'http', 'mcp-stdio', 'mcp-http'].includes(surface), 'unknown surface');
const repoRoot = new URL('..', import.meta.url).pathname;
const scratch = join(repoRoot, '.scratch');
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const work = mkdtempSync(join(scratch, `egress-${surface}-`));
const dbPath = join(work, 'corpus.db');
const sourceRoot = join(work, 'source');
mkdirSync(sourceRoot, { mode: 0o700 });
writeFileSync(join(sourceRoot, 'policy.md'), 'Synthetic refunds take five business days.\n');
const bin = join(repoRoot, 'bin/context-harvest.js');

function cli(args, key = null, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [bin, '--db', dbPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(key ? { CH_API_KEY: key } : {}) }
  });
  assert.equal(result.status, expectedStatus,
    `CLI ${args.join(' ')} exited ${result.status}: ${result.stderr}`);
  const text = expectedStatus === 0 ? result.stdout : result.stderr;
  return text.trim() ? JSON.parse(text) : null;
}

function bootstrap() {
  const initialized = cli(['init', '--name', `synthetic-${surface}`]);
  const retrieval = cli(['key', 'issue', '--label', `${surface}-agent`], initialized.key);
  assert.equal(initialized.scope, 'admin');
  assert.equal(retrieval.scope, 'retrieve');
  return { admin: initialized, retrieval };
}

function connectCli(admin) {
  return cli([
    'source', 'add', '--name', 'Synthetic policy', '--root', sourceRoot,
    '--include', '**/*.md'
  ], admin.key);
}

function refreshFixture() {
  writeFileSync(join(sourceRoot, 'escalation.md'), 'Synthetic escalations page the duty lead.\n');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/not-ready`);
      if (response.status > 0) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('loopback server did not start');
}

async function startServer(args) {
  const port = await freePort();
  const child = spawn(process.execPath, [bin, '--db', dbPath, ...args, '--port', String(port)], {
    cwd: repoRoot, env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.once('exit', (code) => {
    if (code && code !== 0) process.stderr.write(`server exited ${code}: ${stderr}`);
  });
  await waitForServer(port);
  return {
    port,
    stop: async () => {
      if (child.exitCode !== null) return;
      const closed = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await closed;
    }
  };
}

async function runCliCycle() {
  const { admin, retrieval } = bootstrap();
  const source = connectCli(admin);
  assert.equal(cli(['harvest', '--source', source.source_id], admin.key).docs_added, 1);
  refreshFixture();
  assert.equal(cli(['refresh', '--source', source.source_id], admin.key).docs_added, 1);
  assert.ok(cli(['search', '--query', 'refund'], retrieval.key).count >= 1);
  const exported = cli(['export', '--out', join(work, 'export.json')], admin.key);
  assert.equal(exported.sources, 1);
  assert.equal(cli(['source', 'rm', '--source', source.source_id], admin.key).documents_removed, 2);
  assert.equal(cli(['key', 'revoke', '--key-id', retrieval.key_id], admin.key).revoked, true);
  assert.equal(cli(['search', '--query', 'refund'], retrieval.key, 1).error, 'unauthorized');
}

async function runHttpCycle() {
  const { admin, retrieval } = bootstrap();
  const server = await startServer(['serve', '--http']);
  const call = async (method, path, key, body) => {
    const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  try {
    const connected = await call('POST', '/v1/sources', admin.key, {
      display_name: 'Synthetic policy', root: sourceRoot, scope: { include: ['**/*.md'] }
    });
    assert.equal(connected.status, 201);
    const sourceId = connected.body.source_id;
    assert.equal((await call('POST', `/v1/sources/${sourceId}/harvest`, admin.key, {})).body.docs_added, 1);
    refreshFixture();
    assert.equal((await call('POST', `/v1/sources/${sourceId}/refresh`, admin.key, {})).body.docs_added, 1);
    assert.ok((await call('POST', '/v1/search', retrieval.key, { query: 'refund' })).body.count >= 1);
    assert.equal((await call('GET', '/v1/export', admin.key)).body.sources.length, 1);
    assert.equal((await call('DELETE', `/v1/sources/${sourceId}`, admin.key, {})).status, 200);
    assert.equal((await call('POST', `/v1/keys/${retrieval.key_id}/revoke`, admin.key, {})).status, 200);
    assert.equal((await call('POST', '/v1/search', retrieval.key, { query: 'refund' })).status, 401);
  } finally { await server.stop(); }
}

async function seedForMcp(admin) {
  const source = connectCli(admin);
  assert.equal(cli(['harvest', '--source', source.source_id], admin.key).docs_added, 1);
  refreshFixture();
  assert.equal(cli(['refresh', '--source', source.source_id], admin.key).docs_added, 1);
  return source;
}

async function finishMcpCycle(admin, retrieval, source) {
  assert.equal(cli(['export', '--out', join(work, 'export.json')], admin.key).sources, 1);
  assert.equal(cli(['source', 'rm', '--source', source.source_id], admin.key).documents_removed, 2);
  assert.equal(cli(['key', 'revoke', '--key-id', retrieval.key_id], admin.key).revoked, true);
}

async function runMcpStdioCycle() {
  const { admin, retrieval } = bootstrap();
  const source = await seedForMcp(admin);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, '--db', dbPath, 'serve', '--mcp'],
    env: { CH_API_KEY: retrieval.key }, stderr: 'pipe', cwd: repoRoot
  });
  transport.stderr?.resume();
  const client = new Client({ name: 'egress-stdio', version: '0' }, { capabilities: {} });
  await client.connect(transport);
  try {
    assert.equal((await client.listTools()).tools.length, 3);
    const found = JSON.parse((await client.callTool({
      name: 'search_context', arguments: { query: 'refund' }
    })).content[0].text);
    assert.ok(found.count >= 1);
    await finishMcpCycle(admin, retrieval, source);
    const denied = await client.callTool({ name: 'list_sources', arguments: {} });
    assert.equal(denied.isError, true);
  } finally { await client.close(); }
}

async function runMcpHttpCycle() {
  const { admin, retrieval } = bootstrap();
  const source = await seedForMcp(admin);
  const server = await startServer(['serve', '--mcp', '--http']);
  const client = new Client({ name: 'egress-http', version: '0' }, { capabilities: {} });
  try {
    await client.connect(new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${server.port}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${retrieval.key}` } } }
    ));
    assert.equal((await client.listTools()).tools.length, 3);
    const found = JSON.parse((await client.callTool({
      name: 'search_context', arguments: { query: 'refund' }
    })).content[0].text);
    assert.ok(found.count >= 1);
    await finishMcpCycle(admin, retrieval, source);
    await assert.rejects(() => client.callTool({ name: 'list_sources', arguments: {} }), /401|unauthorized/i);
    await client.close();
  } finally { await server.stop(); }
}

try {
  if (surface === 'cli') await runCliCycle();
  else if (surface === 'http') await runHttpCycle();
  else if (surface === 'mcp-stdio') await runMcpStdioCycle();
  else await runMcpHttpCycle();
  process.stdout.write(`${surface}: seven-verb cycle passed\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
