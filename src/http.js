import { createServer } from 'node:http';
import { authenticate, authorizeScope, bearerFromHeader, revokeKey } from './keys.js';
import { ChError, badRequest, notFound, unauthorized } from './errors.js';
import { connectSource, deleteCorpus, deleteSource, exportCorpus, listSources, runHarvest } from './corpus.js';
import { getDocument, search } from './retrieve.js';
import { audit } from './audit.js';
import { log } from './log.js';

const MAX_BODY_BYTES = 1_048_576;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return; // keep draining without retaining any more caller bytes
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        parts.length = 0;
        reject(badRequest('body_too_large'));
        return;
      }
      parts.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        reject(badRequest('body_is_not_json'));
      }
    });
    req.on('error', () => {
      if (settled) return;
      settled = true;
      reject(badRequest('body_read_failed'));
    });
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

// Error bodies carry a code and a bounded reason. They never echo the request, a path, or
// any content -- THREAT-MODEL.md T7.
function sendError(res, err) {
  if (err instanceof ChError) {
    return send(res, err.status, { error: err.code, ...err.details });
  }
  return send(res, 500, { error: 'internal' });
}

/**
 * Every request re-authenticates from scratch. There is no session, no key cache, and no
 * grace window, so a key revoked a millisecond ago is dead on this call -- THREAT-MODEL.md T4.
 */
export function requireAuth(db, req) {
  const token = bearerFromHeader(req.headers.authorization);
  if (!token) throw unauthorized('missing_bearer');
  return authenticate(db, token);
}

const ROUTES = [
  { method: 'POST',   pattern: /^\/v1\/search$/,                       name: 'search', scope: 'retrieve' },
  { method: 'GET',    pattern: /^\/v1\/sources$/,                      name: 'list_sources', scope: 'retrieve' },
  { method: 'POST',   pattern: /^\/v1\/sources$/,                      name: 'connect', scope: 'admin' },
  { method: 'GET',    pattern: /^\/v1\/documents\/([^/]+)$/,           name: 'get_document', scope: 'retrieve' },
  { method: 'POST',   pattern: /^\/v1\/sources\/([^/]+)\/harvest$/,    name: 'harvest', scope: 'admin' },
  { method: 'POST',   pattern: /^\/v1\/sources\/([^/]+)\/refresh$/,    name: 'refresh', scope: 'admin' },
  { method: 'GET',    pattern: /^\/v1\/export$/,                       name: 'export', scope: 'admin' },
  { method: 'DELETE', pattern: /^\/v1\/sources\/([^/]+)$/,             name: 'delete_source', scope: 'admin' },
  { method: 'DELETE', pattern: /^\/v1\/corpus$/,                       name: 'delete_corpus', scope: 'admin' },
  { method: 'POST',   pattern: /^\/v1\/keys\/([^/]+)\/revoke$/,        name: 'revoke_key', scope: 'admin' }
];

function route(method, pathname) {
  for (const candidate of ROUTES) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(pathname);
    if (match) return {
      name: candidate.name, scope: candidate.scope,
      param: match[1] ? decodeURIComponent(match[1]) : null
    };
  }
  return null;
}

export async function handleRequest(db, req, res) {
  const started = Date.now();
  let matched = null;
  try {
    const url = new URL(req.url, 'http://localhost');
    matched = route(req.method, url.pathname);
    if (!matched) throw notFound('route');

    const ctx = requireAuth(db, req);
    authorizeScope(ctx, matched.scope);
    const body = req.method === 'POST' || req.method === 'DELETE' ? await readJsonBody(req) : {};

    let status = 200;
    let payload;
    switch (matched.name) {
      case 'search':
        payload = search(db, ctx, {
          query: body.query,
          source_ids: body.source_ids ?? null,
          limit: body.limit
        });
        break;
      case 'list_sources':
        payload = { sources: listSources(db, ctx.tenant_id) };
        break;
      case 'connect':
        payload = connectSource(db, ctx, body);
        status = 201;
        break;
      case 'get_document': {
        const startLine = url.searchParams.has('start_line')
          ? Number(url.searchParams.get('start_line')) : null;
        const endLine = url.searchParams.has('end_line')
          ? Number(url.searchParams.get('end_line')) : null;
        if (startLine !== null && !Number.isInteger(startLine)) throw badRequest('start_line_invalid');
        if (endLine !== null && !Number.isInteger(endLine)) throw badRequest('end_line_invalid');
        payload = getDocument(db, ctx, matched.param, { start_line: startLine, end_line: endLine });
        break;
      }
      case 'harvest':
        payload = runHarvest(db, ctx, matched.param, 'harvest');
        break;
      case 'refresh':
        payload = runHarvest(db, ctx, matched.param, 'refresh');
        break;
      case 'export':
        payload = exportCorpus(db, ctx);
        break;
      case 'delete_source':
        payload = deleteSource(db, ctx, matched.param);
        break;
      case 'delete_corpus':
        payload = deleteCorpus(db, ctx);
        break;
      case 'revoke_key': {
        const revoked = revokeKey(db, matched.param, ctx.tenant_id);
        if (!revoked) throw notFound('key');
        audit(db, { tenant_id: ctx.tenant_id, verb: 'revoke_key', actor_key_id: ctx.key_id,
                    outcome: 'ok' });
        payload = { key_id: matched.param, revoked };
        break;
      }
      default:
        throw notFound('route');
    }

    send(res, status, payload);
    log({ verb: matched.name, status, outcome: 'ok', duration_ms: Date.now() - started });
  } catch (err) {
    sendError(res, err);
    log({
      verb: matched ? matched.name : 'unrouted',
      status: err instanceof ChError ? err.status : 500,
      code: err instanceof ChError ? err.code : 'internal',
      outcome: 'error',
      duration_ms: Date.now() - started
    });
  }
}

export function createHttpServer(db) {
  return createServer((req, res) => { handleRequest(db, req, res); });
}

export function serveHttp(db, { port = 8787, host = '127.0.0.1' } = {}) {
  const server = createHttpServer(db);
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      log({ verb: 'serve_http', outcome: 'listening', port: server.address().port });
      resolve(server);
    });
  });
}
