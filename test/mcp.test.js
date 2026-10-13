import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { addTenant, cleanupAll, makeCorpus, tempDir, writeTree, HANDBOOK } from './helpers.js';
import { connectSource, deleteSource, runHarvest } from '../src/corpus.js';
import { createMcpServer, createMcpHttpServer, TOOLS } from '../src/mcp.js';
import { authenticate, revokeKey } from '../src/keys.js';
import { setLogSink } from '../src/log.js';

after(cleanupAll);

const RETRIEVAL_ONLY = ['search_context', 'get_document', 'list_sources'];
const parse = (result) => JSON.parse(result.content[0].text);

async function connected({ key } = {}) {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'Ops handbook', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);

  const token = key ?? corpus.key;
  const server = createMcpServer(corpus.db, () => authenticate(corpus.db, token));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    ...corpus, root, source, client,
    close: async () => { await client.close(); await server.close(); }
  };
}

test('the MCP surface exposes retrieval only, with no acting verb', async () => {
  const session = await connected();
  try {
    const { tools } = await session.client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...RETRIEVAL_ONLY].sort());
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true);
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.openWorldHint, false);
      assert.ok(tool.description.length > 0);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const declared = TOOLS.map((t) => t.name);
    for (const forbidden of ['connect', 'harvest', 'refresh', 'export', 'delete', 'revoke',
                             'delete_source', 'delete_corpus', 'revoke_key', 'connect_source']) {
      assert.ok(!declared.includes(forbidden), `${forbidden} must not be an MCP tool in v0`);
    }
  } finally { await session.close(); }
});

test('search_context returns provenance and query-time freshness on every hit', async () => {
  const session = await connected();
  try {
    const result = parse(await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund supervisor', limit: 5 }
    }));
    assert.ok(result.count >= 1);
    for (const hit of result.hits) {
      assert.ok(hit.chunk_id.startsWith('chk_'));
      assert.equal(typeof hit.text, 'string');
      assert.equal(typeof hit.score, 'number');
      assert.equal(hit.provenance.source_id, session.source.source_id);
      assert.equal(hit.provenance.source_name, 'Ops handbook');
      assert.equal(hit.provenance.source_kind, 'folder');
      assert.ok(hit.provenance.document_id.startsWith('doc_'));
      assert.ok(hit.provenance.uri.endsWith('.md'));
      assert.equal(hit.provenance.content_sha256.length, 64);
      for (const field of ['start_line', 'end_line', 'start_byte', 'end_byte']) {
        assert.equal(typeof hit.provenance.locator[field], 'number');
      }
      assert.ok(['fresh', 'stale', 'unverified'].includes(hit.freshness.state));
      assert.ok(hit.freshness.harvested_at);
      assert.equal(typeof hit.freshness.age_seconds, 'number');
    }
  } finally { await session.close(); }
});

test('freshness over MCP moves when the file underneath changes', async () => {
  const session = await connected();
  try {
    const before = parse(await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund' } }));
    assert.equal(before.hits[0].freshness.state, 'fresh');

    writeFileSync(join(session.root, 'handbook/refunds.md'),
      '# Refunds\n\nA refund is issued within TEN business days.\n');

    const after = parse(await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund' } }));
    assert.equal(after.hits[0].freshness.state, 'stale');
  } finally { await session.close(); }
});

test('get_document and list_sources answer over MCP', async () => {
  const session = await connected();
  try {
    const found = parse(await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund' } }));
    const documentId = found.hits[0].provenance.document_id;

    const document = parse(await session.client.callTool({
      name: 'get_document', arguments: { document_id: documentId, start_line: 3, end_line: 3 } }));
    assert.equal(document.document_id, documentId);
    assert.equal(document.provenance.locator.start_line, 3);
    assert.ok(document.text.includes('refund'));

    const sources = parse(await session.client.callTool({ name: 'list_sources', arguments: {} }));
    assert.equal(sources.sources.length, 1);
    assert.equal(sources.sources[0].document_count, 2);
    assert.deepEqual(sources.sources[0].scope.include, ['**/*.md']);
  } finally { await session.close(); }
});

test('a deleted document is an error over MCP, never a redacted body', async () => {
  const session = await connected();
  try {
    const found = parse(await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund' } }));
    const documentId = found.hits[0].provenance.document_id;
    deleteSource(session.db, session.ctx, session.source.source_id);

    const result = await session.client.callTool({
      name: 'get_document', arguments: { document_id: documentId } });
    assert.equal(result.isError, true);
    assert.deepEqual(parse(result), { error: 'not_found', what: 'document' });
    assert.ok(!JSON.stringify(result).includes('refund'));

    const empty = parse(await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund' } }));
    assert.equal(empty.count, 0);
  } finally { await session.close(); }
});

test('revoking a key kills the very next call on an already-open MCP session', async () => {
  const session = await connected();
  try {
    assert.ok(parse(await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund' } })).count >= 1);

    revokeKey(session.db, session.keyId, session.tenant.id);

    const denied = await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund' } });
    assert.equal(denied.isError, true);
    assert.deepEqual(parse(denied), { error: 'unauthorized', reason: 'revoked' });

    for (const name of RETRIEVAL_ONLY) {
      const result = await session.client.callTool({
        name, arguments: name === 'get_document' ? { document_id: 'doc_x' }
          : name === 'search_context' ? { query: 'refund' } : {} });
      assert.equal(result.isError, true, `${name} must be denied on a revoked key`);
    }
  } finally { await session.close(); }
});

test('a tenant key cannot reach another tenant corpus over MCP', async () => {
  const session = await connected();
  try {
    const other = addTenant(session.db, 'tenant-b');
    const otherServer = createMcpServer(session.db, () => authenticate(session.db, other.key));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const otherClient = new Client({ name: 'b', version: '0' }, { capabilities: {} });
    await Promise.all([otherServer.connect(st), otherClient.connect(ct)]);

    const found = parse(await session.client.callTool({
      name: 'search_context', arguments: { query: 'refund' } }));
    const documentId = found.hits[0].provenance.document_id;

    const crossSearch = parse(await otherClient.callTool({
      name: 'search_context',
      arguments: { query: 'refund', source_ids: [session.source.source_id] } }));
    assert.equal(crossSearch.count, 0);

    const crossDocument = await otherClient.callTool({
      name: 'get_document', arguments: { document_id: documentId } });
    assert.equal(crossDocument.isError, true);

    const crossList = parse(await otherClient.callTool({ name: 'list_sources', arguments: {} }));
    assert.equal(crossList.sources.length, 0);

    await otherClient.close(); await otherServer.close();
  } finally { await session.close(); }
});

test('an unknown tool and a malformed argument are errors, not crashes', async () => {
  const session = await connected();
  try {
    await assert.rejects(
      () => session.client.callTool({ name: 'delete_corpus', arguments: {} }),
      /-32601|unknown_tool/i
    );
    const malformed = await session.client.callTool({
      name: 'search_context', arguments: { query: 42 } });
    assert.equal(malformed.isError, true);
  } finally { await session.close(); }
});

test('a caller-controlled unknown tool name is absent from MCP errors and logs', async () => {
  const session = await connected();
  const marker = 'ch_SYNTHETIC_CALLER_CONTROLLED_SECRET_MARKER';
  const lines = [];
  setLogSink((line) => lines.push(line));
  try {
    let unknownError;
    try { await session.client.callTool({ name: marker, arguments: {} }); }
    catch (err) { unknownError = err; }
    assert.ok(unknownError);
    assert.ok(!String(unknownError).includes(marker), 'the error echoed caller-controlled input');

    revokeKey(session.db, session.keyId, session.tenant.id);
    const denied = await session.client.callTool({ name: marker, arguments: {} });
    assert.equal(denied.isError, true);
    assert.ok(!lines.join('\n').includes(marker), 'the auth-error log echoed caller-controlled input');
  } finally {
    setLogSink((line) => process.stderr.write(line + '\n'));
    await session.close();
  }
});

test('the streamable HTTP transport serves the same contract and requires a bearer', async () => {
  const corpus = makeCorpus();
  const root = writeTree(tempDir(), HANDBOOK);
  const source = connectSource(corpus.db, corpus.ctx, {
    display_name: 'Ops handbook', root, scope: { include: ['**/*.md'] }
  });
  runHarvest(corpus.db, corpus.ctx, source.source_id);

  const server = createMcpHttpServer(corpus.db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  try {
    const anonymous = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(anonymous.status, 401);

    const client = new Client({ name: 'http', version: '0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${corpus.key}` } }
    }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...RETRIEVAL_ONLY].sort());
    const result = parse(await client.callTool({
      name: 'search_context', arguments: { query: 'refund' } }));
    assert.ok(result.count >= 1);
    assert.equal(result.hits[0].freshness.state, 'fresh');
    // Keep this exact client/transport open. The bearer is re-checked per request, so revocation
    // must land on the next call inside the already-open client session.
    revokeKey(corpus.db, corpus.keyId, corpus.tenant.id);
    await assert.rejects(
      () => client.callTool({ name: 'search_context', arguments: { query: 'refund' } }),
      /401|unauthorized/i
    );
    await client.close();
  } finally {
    server.close();
  }
});
