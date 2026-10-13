#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { openDb, resolveDbPath } from '../src/db.js';
import {
  authenticate, authorizeScope, createTenant, issueKey, listKeys, revokeKey
} from '../src/keys.js';
import {
  applyRetention, connectSource, deleteCorpus, deleteSource, exportCorpus, listSources, runHarvest
} from '../src/corpus.js';
import { getDocument, search } from '../src/retrieve.js';
import { serveHttp } from '../src/http.js';
import { serveMcpHttp, serveMcpStdio } from '../src/mcp.js';
import { audit } from '../src/audit.js';
import { badRequest, ChError, conflict, notFound, unauthorized } from '../src/errors.js';

const USAGE = `context-harvest -- governed, attributable context over sources you control

  init                          create the corpus database and its first tenant
  source add                    connect a source
      --name <label> --root <dir> [--include <glob>]... [--exclude <glob>]...
      [--max-file-bytes N] [--max-total-bytes N] [--retention-days N]
  source list                   list connected sources
  source rm --source <id>       delete a source and everything harvested from it
  harvest --source <id>         harvest a source
  refresh --source <id>         re-harvest and reconcile added / changed / removed
  search --query <text> [--source <id>]... [--limit N]
  document --document <id> [--start-line N] [--end-line N]
  export [--out <file>]         write the whole corpus and its provenance out as JSON
  corpus purge                  delete every source and revoke every key for the tenant
  retention run                 apply each source's retention window
  key issue [--label <text>] [--scope retrieve|admin]
                                issue an API key (retrieve by default; shown once)
  key list                      list key ids and their revocation state
  key revoke --key-id <id>      revoke a key; the next request on it is denied
  serve --http [--port N]       run the HTTP API
  serve --mcp [--http] [--port N]
                                run the MCP server over stdio, or over streamable HTTP

Global: --db <path> (or CH_DB), --key <ch_...> (or CH_API_KEY)
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue; }
    if (flags[key] === undefined) flags[key] = next;
    else if (Array.isArray(flags[key])) flags[key].push(next);
    else flags[key] = [flags[key], next];
    i += 1;
  }
  return { positional, flags };
}

const asArray = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const asInt = (value, fallback = null) => {
  if (value === undefined || value === true) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new ChError('bad_request', 400, 'bad_request', { reason: 'not_an_integer' });
  return parsed;
};

function out(value) { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }

function contextFor(db, flags) {
  const presented = flags.key && flags.key !== true ? String(flags.key) : process.env.CH_API_KEY;
  if (!presented) throw unauthorized('missing_api_key');
  if (flags.tenant !== undefined) throw badRequest('tenant_argument_not_allowed');
  return authenticate(db, presented);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional.join(' ');

  if (positional.length === 0 || flags.help || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const db = openDb(flags.db && flags.db !== true ? String(flags.db) : undefined);

  switch (command) {
    case 'init': {
      if (db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n !== 0) {
        throw conflict('already_initialized');
      }
      const tenant = createTenant(db,
        flags.name && flags.name !== true ? String(flags.name) : 'default');
      // The only unauthenticated key issuance path is the empty-database bootstrap. It emits one
      // admin key exactly once; every later CLI command derives its tenant from a presented key.
      const bootstrap = issueKey(db, tenant.id, 'bootstrap admin', 'admin');
      out({ db: resolveDbPath(flags.db && flags.db !== true ? String(flags.db) : undefined),
            tenant_id: tenant.id, display_name: tenant.display_name, ...bootstrap });
      return;
    }

    case 'source add': {
      const ctx = authorizeScope(contextFor(db, flags), 'admin');
      const include = asArray(flags.include).filter((v) => v !== true);
      const exclude = asArray(flags.exclude).filter((v) => v !== true);
      out(connectSource(db, ctx, {
        kind: flags.kind && flags.kind !== true ? String(flags.kind) : 'folder',
        display_name: String(flags.name),
        root: String(flags.root),
        retention_days: asInt(flags['retention-days']),
        scope: {
          ...(include.length ? { include } : {}),
          ...(exclude.length ? { exclude } : {}),
          ...(flags['max-file-bytes'] ? { max_file_bytes: asInt(flags['max-file-bytes']) } : {}),
          ...(flags['max-total-bytes'] ? { max_total_bytes: asInt(flags['max-total-bytes']) } : {})
        }
      }));
      return;
    }

    case 'source list':
      out({ sources: listSources(db, authorizeScope(contextFor(db, flags), 'retrieve').tenant_id) });
      return;

    case 'source rm':
      out(deleteSource(db, authorizeScope(contextFor(db, flags), 'admin'), String(flags.source)));
      return;

    case 'harvest':
      out(runHarvest(db, authorizeScope(contextFor(db, flags), 'admin'), String(flags.source), 'harvest'));
      return;

    case 'refresh':
      out(runHarvest(db, authorizeScope(contextFor(db, flags), 'admin'), String(flags.source), 'refresh'));
      return;

    case 'search':
      out(search(db, authorizeScope(contextFor(db, flags), 'retrieve'), {
        query: String(flags.query),
        source_ids: asArray(flags.source).filter((v) => v !== true).length
          ? asArray(flags.source).filter((v) => v !== true) : null,
        limit: asInt(flags.limit) ?? undefined
      }));
      return;

    case 'document':
      out(getDocument(db, authorizeScope(contextFor(db, flags), 'retrieve'), String(flags.document), {
        start_line: asInt(flags['start-line']),
        end_line: asInt(flags['end-line'])
      }));
      return;

    case 'export': {
      const payload = exportCorpus(db, authorizeScope(contextFor(db, flags), 'admin'));
      if (flags.out && flags.out !== true) {
        writeFileSync(String(flags.out), JSON.stringify(payload, null, 2), { mode: 0o600 });
        out({ exported_to: String(flags.out), sources: payload.sources.length,
              documents: payload.documents.length, chunks: payload.chunks.length });
      } else {
        out(payload);
      }
      return;
    }

    case 'corpus purge':
      out(deleteCorpus(db, authorizeScope(contextFor(db, flags), 'admin')));
      return;

    case 'retention run':
      out(applyRetention(db, authorizeScope(contextFor(db, flags), 'admin')));
      return;

    case 'key issue': {
      const ctx = authorizeScope(contextFor(db, flags), 'admin');
      // The plaintext is printed here and never again. It is not written to the database,
      // not written to the audit log, and not written to any log line.
      const issued = issueKey(db, ctx.tenant_id,
        flags.label && flags.label !== true ? String(flags.label) : 'default',
        flags.scope && flags.scope !== true ? String(flags.scope) : 'retrieve');
      audit(db, { tenant_id: ctx.tenant_id, verb: 'key_issue', actor_key_id: ctx.key_id,
                  outcome: 'ok' });
      out(issued);
      return;
    }

    case 'key list':
      out({ keys: listKeys(db, authorizeScope(contextFor(db, flags), 'admin').tenant_id) });
      return;

    case 'key revoke': {
      const ctx = authorizeScope(contextFor(db, flags), 'admin');
      const keyId = flags['key-id'];
      if (!keyId || keyId === true) throw badRequest('key_id_required');
      const revoked = revokeKey(db, String(keyId), ctx.tenant_id);
      if (!revoked) throw notFound('key');
      audit(db, { tenant_id: ctx.tenant_id, verb: 'revoke_key', actor_key_id: ctx.key_id,
                  outcome: 'ok' });
      out({ key_id: String(keyId), revoked });
      return;
    }

    case 'serve': {
      const port = asInt(flags.port);
      if (flags.mcp) {
        if (flags.http) {
          await serveMcpHttp(db, { port: port ?? 8788 });
        } else {
          await serveMcpStdio(db);
        }
        await new Promise(() => {});
        return;
      }
      await serveHttp(db, { port: port ?? 8787 });
      await new Promise(() => {});
      return;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  if (err instanceof ChError) {
    process.stderr.write(JSON.stringify({ error: err.code, ...err.details }) + '\n');
    process.exitCode = 1;
    return;
  }
  process.stderr.write(JSON.stringify({ error: 'internal' }) + '\n');
  process.exitCode = 1;
});
