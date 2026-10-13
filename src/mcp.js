import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

import { authenticate, authorizeScope, bearerFromHeader } from './keys.js';
import { listSources } from './corpus.js';
import { getDocument, search } from './retrieve.js';
import { badRequest, ChError, unauthorized } from './errors.js';
import { log } from './log.js';

export const SERVER_INFO = { name: 'context-harvest', version: '0.0.0' };

/**
 * Retrieval only. There is no connect, harvest, refresh, export, delete or revoke tool here,
 * and there will not be one until every acting verb has identity, scope, budget, idempotency,
 * audit and a stop condition. Nothing injected into harvested content
 * has anything to actuate through this surface -- THREAT-MODEL.md T8.
 */
export const TOOLS = [
  {
    name: 'search_context',
    title: 'Search context',
    description:
      'Search the connected corpus. Every hit carries exact provenance (source, document, byte '
      + 'and line locator, content hash) and a freshness verdict computed at query time.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Terms to search for. Matched literally.' },
        source_ids: {
          type: 'array', items: { type: 'string' },
          description: 'Restrict to these sources. Omit to search every connected source.'
        },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum hits, default 10.' }
      },
      required: ['query'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'get_document',
    title: 'Get document',
    description:
      'Fetch one harvested document, optionally a line range. Returns 404-equivalent for a '
      + 'document that has been deleted; never a redacted body.',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 }
      },
      required: ['document_id'],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'list_sources',
    title: 'List sources',
    description: 'List the sources connected to this corpus, with their declared scope.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }
];

const MCP_LOG_VERBS = new Set(TOOLS.map((tool) => `mcp:${tool.name}`));
const mcpLogVerb = (name) => {
  const candidate = `mcp:${name}`;
  return MCP_LOG_VERBS.has(candidate) ? candidate : 'mcp:unknown_tool';
};

function toolResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function toolError(err) {
  const body = err instanceof ChError
    ? { error: err.code, ...err.details }
    : { error: 'internal' };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}

function validateArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw badRequest('arguments_must_be_object');
  const allowed = name === 'search_context' ? new Set(['query', 'source_ids', 'limit'])
    : name === 'get_document' ? new Set(['document_id', 'start_line', 'end_line'])
      : new Set();
  if (Object.keys(args).some((key) => !allowed.has(key))) throw badRequest('unexpected_argument');

  if (name === 'search_context') {
    if (typeof args.query !== 'string') throw badRequest('query_required');
    if (args.source_ids !== undefined) {
      if (!Array.isArray(args.source_ids)) throw badRequest('source_ids_must_be_array');
      if (args.source_ids.some((id) => typeof id !== 'string')) {
        throw badRequest('source_ids_must_be_strings');
      }
    }
    if (args.limit !== undefined) {
      if (!Number.isInteger(args.limit) || args.limit <= 0) {
        throw badRequest('limit_must_be_positive_integer');
      }
      if (args.limit > 50) throw badRequest('limit_must_be_at_most_50');
    }
  } else if (name === 'get_document') {
    if (typeof args.document_id !== 'string' || args.document_id.length === 0) {
      throw badRequest('document_id_required');
    }
    for (const field of ['start_line', 'end_line']) {
      if (args[field] !== undefined && (!Number.isInteger(args[field]) || args[field] <= 0)) {
        throw badRequest(`${field}_must_be_positive_integer`);
      }
    }
    if (args.start_line !== undefined && args.end_line !== undefined
        && args.start_line > args.end_line) throw badRequest('line_range_invalid');
  }
  return args;
}

/**
 * @param db          open corpus database
 * @param resolveCtx  called on EVERY tool call and must re-read key state each time. A session
 *                    that authenticated at connect time is re-checked here, which is what makes
 *                    revocation immediate over a long-lived MCP session -- THREAT-MODEL.md T4.
 */
export function createMcpServer(db, resolveCtx) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  let initialized = false;
  server.oninitialized = () => { initialized = true; };
  const requireInitialized = () => {
    if (!initialized) throw new McpError(ErrorCode.InvalidRequest, 'initialize_required');
  };

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    requireInitialized();
    try {
      authorizeScope(resolveCtx(extra), 'retrieve');
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, 'unauthorized');
    }
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    requireInitialized();
    const { name, arguments: args = {} } = request.params;
    const logVerb = mcpLogVerb(name);
    let ctx;
    try {
      ctx = authorizeScope(resolveCtx(extra), 'retrieve');
    } catch (err) {
      log({ verb: logVerb, outcome: 'error', code: 'unauthorized' });
      return toolError(err instanceof ChError ? err : unauthorized());
    }

    try {
      if (!TOOLS.some((tool) => tool.name === name)) {
        // JSON-RPC method error, not a tool execution error. The fixed message avoids reflecting
        // a caller-controlled tool name into the response.
        throw new McpError(ErrorCode.MethodNotFound, 'unknown_tool');
      }
      validateArgs(name, args);
      switch (name) {
        case 'search_context': {
          const result = search(db, ctx, {
            query: args.query,
            source_ids: args.source_ids ?? null,
            limit: args.limit
          });
          log({ verb: 'mcp:search_context', outcome: 'ok', hit_count: result.count });
          return toolResult(result);
        }
        case 'get_document': {
          const result = getDocument(db, ctx, args.document_id, {
            start_line: args.start_line ?? null,
            end_line: args.end_line ?? null
          });
          log({ verb: 'mcp:get_document', outcome: 'ok', document_id: result.document_id });
          return toolResult(result);
        }
        case 'list_sources': {
          const sources = listSources(db, ctx.tenant_id);
          log({ verb: 'mcp:list_sources', outcome: 'ok', document_count: sources.length });
          return toolResult({ sources });
        }
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      log({
        verb: logVerb,
        outcome: 'error',
        code: err instanceof ChError ? err.code : 'internal'
      });
      return toolError(err);
    }
  });

  return server;
}

/** stdio transport. The key comes from CH_API_KEY and is re-validated on every tool call. */
export async function serveMcpStdio(db, { apiKey = process.env.CH_API_KEY } = {}) {
  const server = createMcpServer(db, () => {
    if (!apiKey) throw unauthorized('missing_ch_api_key');
    return authenticate(db, apiKey);
  });
  await server.connect(new StdioServerTransport());
  log({ verb: 'serve_mcp', outcome: 'listening', transport: 'stdio' });
  return server;
}

/**
 * Streamable HTTP transport. A fresh transport and a fresh authentication per POST: the bearer
 * is re-checked on the request that carries the tool call, not once when a session opened.
 */
export function createMcpHttpServer(db) {
  const sessions = new Map();
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (!['POST', 'DELETE'].includes(req.method)) {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST, DELETE' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    const token = bearerFromHeader(req.headers.authorization);
    let ctx;
    try {
      if (!token) throw unauthorized('missing_bearer');
      ctx = authorizeScope(authenticate(db, token), 'retrieve');
    } catch (err) {
      log({ verb: 'mcp_http', outcome: 'error', code: 'unauthorized', status: 401 });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof ChError ? err.code : 'unauthorized' }));
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'];
      let record = typeof sessionId === 'string' ? sessions.get(sessionId) : null;
      if (record) {
        if (record.keyId !== ctx.key_id) throw unauthorized();
        record.token = token;
        await record.transport.handleRequest(req, res);
        if (req.method === 'DELETE') sessions.delete(sessionId);
        return;
      }
      if (req.method !== 'POST' || sessionId) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: ErrorCode.InvalidRequest, message: 'invalid_or_missing_session' }
        }));
        return;
      }

      const body = await readMcpBody(req);
      if (body?.method !== 'initialize') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: body?.id ?? null,
          error: { code: ErrorCode.InvalidRequest, message: 'initialize_required' }
        }));
        return;
      }

      record = { keyId: ctx.key_id, token, transport: null, server: null };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, record)
      });
      const server = createMcpServer(db,
        () => authorizeScope(authenticate(db, record.token), 'retrieve'));
      record.transport = transport;
      record.server = server;
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        const status = err instanceof ChError ? err.status : 500;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(err instanceof ChError
          ? { error: err.code, ...err.details }
          : { error: 'internal' }));
      }
    }
  });
}

function readMcpBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= 1_048_576) chunks.push(chunk);
    });
    req.on('end', () => {
      if (bytes > 1_048_576) return reject(badRequest('body_too_large'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(badRequest('body_is_not_json')); }
    });
    req.on('error', () => reject(badRequest('body_read_failed')));
  });
}

export function serveMcpHttp(db, { port = 8788, host = '127.0.0.1' } = {}) {
  const server = createMcpHttpServer(db);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log({ verb: 'serve_mcp', outcome: 'listening', transport: 'http', port: server.address().port });
      resolve(server);
    });
  });
}
