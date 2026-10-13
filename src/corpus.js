import { nowIso, scrubDeletedBytes, tx } from './db.js';
import { newDocumentId, newChunkId, newRunId, newSourceId } from './ids.js';
import { normalizeScope } from './scope.js';
import { chunkText } from './chunk.js';
import { audit } from './audit.js';
import { badRequest, conflict, notFound } from './errors.js';
import { KIND as FOLDER_KIND, resolveRoot, walkFolder } from './connectors/folder.js';

const CONNECTORS = { [FOLDER_KIND]: { resolveRoot, walk: walkFolder } };

export function connectorFor(kind) {
  const connector = CONNECTORS[kind];
  if (!connector) throw badRequest('unsupported_source_kind');
  return connector;
}

export function getSource(db, tenantId, sourceId, { includeDeleted = false } = {}) {
  const row = db.prepare(`SELECT * FROM sources WHERE id = ? AND tenant_id = ?`).get(sourceId, tenantId);
  if (!row) throw notFound('source');
  if (!includeDeleted && row.deleted_at) throw notFound('source');
  return row;
}

export function listSources(db, tenantId) {
  return db.prepare(`SELECT id, kind, display_name, root, scope_json, retention_days, created_at, revoked_at
                     FROM sources WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY created_at`)
    .all(tenantId)
    .map((row) => ({
      source_id: row.id,
      kind: row.kind,
      display_name: row.display_name,
      root: row.root,
      scope: JSON.parse(row.scope_json),
      retention_days: row.retention_days,
      created_at: row.created_at,
      revoked_at: row.revoked_at,
      document_count: db.prepare(`SELECT COUNT(*) AS n FROM documents
                                  WHERE source_id = ? AND tenant_id = ? AND deleted_at IS NULL`)
        .get(row.id, tenantId).n
    }));
}

// ---------------------------------------------------------------- connect

export function connectSource(db, ctx, { kind = FOLDER_KIND, display_name, root, scope, retention_days = null }) {
  if (typeof display_name !== 'string' || display_name.trim().length === 0) {
    throw badRequest('display_name_required');
  }
  if (typeof root !== 'string' || root.length === 0) throw badRequest('root_required');
  if (retention_days !== null && (!Number.isInteger(retention_days) || retention_days <= 0)) {
    throw badRequest('retention_days_must_be_positive_integer');
  }
  const connector = connectorFor(kind);
  const normalized = normalizeScope(scope);
  const realRoot = connector.resolveRoot(root);
  const id = newSourceId();
  const created = nowIso();
  db.prepare(`INSERT INTO sources
              (id, tenant_id, kind, display_name, root, scope_json, retention_days, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.tenant_id, kind, display_name.trim(), realRoot, JSON.stringify(normalized),
         retention_days, created);
  audit(db, { tenant_id: ctx.tenant_id, verb: 'connect', actor_key_id: ctx.key_id,
              source_id: id, outcome: 'ok' });
  return { source_id: id, kind, display_name: display_name.trim(), root: realRoot,
           scope: normalized, retention_days, created_at: created };
}

// ---------------------------------------------------------------- harvest / refresh

function removeChunksForDocument(db, documentId) {
  const rows = db.prepare('SELECT rowid FROM chunks WHERE document_id = ?').all(documentId);
  for (const row of rows) db.prepare('DELETE FROM chunks_fts WHERE rowid = ?').run(row.rowid);
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
  return rows.length;
}

function insertChunks(db, tenantId, documentId, buffer) {
  const pieces = chunkText(buffer);
  const insertChunk = db.prepare(`INSERT INTO chunks
      (id, tenant_id, document_id, ordinal, start_byte, end_byte, start_line, end_line, text_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)');
  for (const piece of pieces) {
    const result = insertChunk.run(newChunkId(), tenantId, documentId, piece.ordinal,
      piece.start_byte, piece.end_byte, piece.start_line, piece.end_line, piece.text_sha256);
    insertFts.run(result.lastInsertRowid, piece.text);
  }
  return pieces.length;
}

export function runHarvest(db, ctx, sourceId, verb = 'harvest', { connectorIo } = {}) {
  const source = getSource(db, ctx.tenant_id, sourceId);
  if (source.revoked_at) throw badRequest('source_revoked');
  const connector = connectorFor(source.kind);
  const scope = JSON.parse(source.scope_json);

  const runId = newRunId();
  const startedAt = nowIso();
  db.prepare(`INSERT INTO harvest_runs (id, tenant_id, source_id, started_at) VALUES (?, ?, ?, ?)`)
    .run(runId, ctx.tenant_id, sourceId, startedAt);

  let realRoot;
  try {
    realRoot = connector.resolveRoot(source.root, { mustBeCanonical: true });
  } catch (err) {
    db.prepare(`UPDATE harvest_runs SET finished_at = ?, outcome = ? WHERE id = ?`)
      .run(nowIso(), 'root_unreachable', runId);
    audit(db, { tenant_id: ctx.tenant_id, verb, actor_key_id: ctx.key_id, source_id: sourceId,
                outcome: 'root_unreachable' });
    throw err;
  }

  const walked = connector.walk(realRoot, scope, connectorIo);
  const summary = tx(db, () => {
    let added = 0, changed = 0, removed = 0, unchanged = 0, bytes = 0, chunkCount = 0;
    const seen = new Set();

    for (const file of walked.files) {
      seen.add(file.uri);
      bytes += file.byte_size;
      const existing = db.prepare(`SELECT * FROM documents
                                   WHERE source_id = ? AND tenant_id = ? AND uri = ?`)
        .get(sourceId, ctx.tenant_id, file.uri);

      if (!existing) {
        const docId = newDocumentId();
        db.prepare(`INSERT INTO documents (id, tenant_id, source_id, uri, content_sha256, byte_size,
                    source_modified_at, source_mtime_ns, harvested_at, last_seen_run_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(docId, ctx.tenant_id, sourceId, file.uri, file.content_sha256, file.byte_size,
               file.source_modified_at, file.source_mtime_ns, nowIso(), runId);
        chunkCount += insertChunks(db, ctx.tenant_id, docId, file.content);
        added += 1;
        continue;
      }

      const contentMoved = existing.content_sha256 !== file.content_sha256 || Boolean(existing.deleted_at);
      if (contentMoved) {
        removeChunksForDocument(db, existing.id);
        db.prepare(`UPDATE documents SET content_sha256 = ?, byte_size = ?, source_modified_at = ?,
                    source_mtime_ns = ?, harvested_at = ?, last_seen_run_id = ?, deleted_at = NULL
                    WHERE id = ?`)
          .run(file.content_sha256, file.byte_size, file.source_modified_at, file.source_mtime_ns,
               nowIso(), runId, existing.id);
        chunkCount += insertChunks(db, ctx.tenant_id, existing.id, file.content);
        changed += 1;
      } else {
        // Same bytes. Record that we verified it just now, and record the source's current
        // mtime and size so a content-preserving touch does not read as stale later.
        db.prepare(`UPDATE documents SET source_modified_at = ?, source_mtime_ns = ?, byte_size = ?,
                    harvested_at = ?, last_seen_run_id = ? WHERE id = ?`)
          .run(file.source_modified_at, file.source_mtime_ns, file.byte_size, nowIso(), runId,
               existing.id);
        unchanged += 1;
      }
    }

    // Documents that are in the corpus but no longer at the source. Their content and index
    // rows go immediately, so retrieval cannot reach them; a metadata tombstone remains until
    // retention purges it.
    const stale = db.prepare(`SELECT id, uri FROM documents
                              WHERE source_id = ? AND tenant_id = ? AND deleted_at IS NULL`)
      .all(sourceId, ctx.tenant_id);
    for (const doc of stale) {
      if (seen.has(doc.uri)) continue;
      removeChunksForDocument(db, doc.id);
      db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(nowIso(), doc.id);
      removed += 1;
    }

    db.prepare(`UPDATE harvest_runs SET finished_at = ?, docs_added = ?, docs_changed = ?,
                docs_removed = ?, bytes_indexed = ?, outcome = ? WHERE id = ?`)
      .run(nowIso(), added, changed, removed, bytes,
           walked.truncated ? 'ok_truncated' : 'ok', runId);

    return { added, changed, removed, unchanged, bytes, chunkCount };
  });

  if ((summary.changed > 0 || summary.removed > 0) && !scrubDeletedBytes(db)) {
    db.prepare('UPDATE harvest_runs SET outcome = ? WHERE id = ?')
      .run('cleanup_incomplete', runId);
    audit(db, { tenant_id: ctx.tenant_id, verb, actor_key_id: ctx.key_id, source_id: sourceId,
                document_count: summary.added + summary.changed + summary.unchanged,
                outcome: 'cleanup_incomplete' });
    throw conflict('reconciliation_cleanup_incomplete');
  }
  audit(db, { tenant_id: ctx.tenant_id, verb, actor_key_id: ctx.key_id, source_id: sourceId,
              document_count: summary.added + summary.changed + summary.unchanged, outcome: 'ok' });

  return {
    run_id: runId,
    source_id: sourceId,
    started_at: startedAt,
    finished_at: nowIso(),
    docs_added: summary.added,
    docs_changed: summary.changed,
    docs_removed: summary.removed,
    docs_unchanged: summary.unchanged,
    chunks_indexed: summary.chunkCount,
    bytes_indexed: summary.bytes,
    skipped: walked.skipped,
    truncated: walked.truncated
  };
}

// ---------------------------------------------------------------- delete / revoke / retention

export function deleteSource(db, ctx, sourceId) {
  const source = getSource(db, ctx.tenant_id, sourceId);
  const result = tx(db, () => {
    const docs = db.prepare('SELECT id FROM documents WHERE source_id = ? AND tenant_id = ?')
      .all(sourceId, ctx.tenant_id);
    let chunksRemoved = 0;
    for (const doc of docs) chunksRemoved += removeChunksForDocument(db, doc.id);
    db.prepare('DELETE FROM documents WHERE source_id = ? AND tenant_id = ?').run(sourceId, ctx.tenant_id);
    const at = nowIso();
    // Runs belong to the deleted source lifecycle, and the source row carries the absolute root
    // and declared globs. A tombstone keeps ids, counts and a timestamp, and nothing else --
    // So the rows themselves go.
    db.prepare('DELETE FROM harvest_runs WHERE source_id = ? AND tenant_id = ?')
      .run(sourceId, ctx.tenant_id);
    db.prepare('DELETE FROM sources WHERE id = ? AND tenant_id = ?').run(sourceId, ctx.tenant_id);
    db.prepare(`INSERT OR REPLACE INTO source_tombstones
                (source_id, tenant_id, deleted_at, documents_removed, chunks_removed)
                VALUES (?, ?, ?, ?, ?)`)
      .run(sourceId, ctx.tenant_id, at, docs.length, chunksRemoved);
    return { documents_removed: docs.length, chunks_removed: chunksRemoved, deleted_at: at };
  });
  // Logical row removal is not enough in WAL mode: old page images still contain the deleted
  // path and chunk text. secure_delete plus a truncating checkpoint makes the file-level claim
  // true as well. A busy checkpoint is reported honestly rather than returning a false success.
  if (!scrubDeletedBytes(db)) {
    audit(db, { tenant_id: ctx.tenant_id, verb: 'delete_source', actor_key_id: ctx.key_id,
                source_id: sourceId, document_count: result.documents_removed,
                outcome: 'cleanup_incomplete' });
    throw conflict('delete_cleanup_incomplete');
  }
  audit(db, { tenant_id: ctx.tenant_id, verb: 'delete_source', actor_key_id: ctx.key_id,
              source_id: sourceId, document_count: result.documents_removed, outcome: 'ok' });
  return { source_id: source.id, ...result };
}

export function deleteCorpus(db, ctx) {
  const result = tx(db, () => {
    const sources = db.prepare('SELECT id FROM sources WHERE tenant_id = ?').all(ctx.tenant_id);
    const docs = db.prepare('SELECT id FROM documents WHERE tenant_id = ?').all(ctx.tenant_id);
    let chunksRemoved = 0;
    for (const doc of docs) chunksRemoved += removeChunksForDocument(db, doc.id);
    db.prepare('DELETE FROM documents WHERE tenant_id = ?').run(ctx.tenant_id);
    const at = nowIso();
    // Same rule as deleteSource: run rows and source rows carry paths, so they go with the
    // content rather than surviving the purge as a map of what the customer used to hold.
    db.prepare('DELETE FROM harvest_runs WHERE tenant_id = ?').run(ctx.tenant_id);
    for (const source of sources) {
      db.prepare('DELETE FROM sources WHERE id = ? AND tenant_id = ?').run(source.id, ctx.tenant_id);
      db.prepare(`INSERT OR REPLACE INTO source_tombstones
                  (source_id, tenant_id, deleted_at, documents_removed, chunks_removed)
                  VALUES (?, ?, ?, 0, 0)`).run(source.id, ctx.tenant_id, at);
    }
    // Every key for this tenant dies in the same transaction.
    const keysRevoked = db.prepare('UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL')
      .run(at, ctx.tenant_id).changes;
    return { sources_deleted: sources.length, documents_removed: docs.length,
             chunks_removed: chunksRemoved, keys_revoked: keysRevoked, deleted_at: at };
  });
  if (!scrubDeletedBytes(db)) {
    audit(db, { tenant_id: ctx.tenant_id, verb: 'delete_corpus', actor_key_id: ctx.key_id,
                document_count: result.documents_removed, outcome: 'cleanup_incomplete' });
    throw conflict('delete_cleanup_incomplete');
  }
  audit(db, { tenant_id: ctx.tenant_id, verb: 'delete_corpus', actor_key_id: ctx.key_id,
              document_count: result.documents_removed, outcome: 'ok' });
  return result;
}

export function applyRetention(db, ctx) {
  const sources = db.prepare(`SELECT id, retention_days FROM sources
                              WHERE tenant_id = ? AND deleted_at IS NULL AND retention_days IS NOT NULL`)
    .all(ctx.tenant_id);
  let purged = 0;
  tx(db, () => {
    for (const source of sources) {
      const cutoff = new Date(Date.now() - source.retention_days * 86_400_000).toISOString();
      const rows = db.prepare(`SELECT id FROM documents
                               WHERE source_id = ? AND tenant_id = ? AND deleted_at IS NOT NULL
                                 AND harvested_at < ?`)
        .all(source.id, ctx.tenant_id, cutoff);
      for (const row of rows) {
        removeChunksForDocument(db, row.id);
        db.prepare('DELETE FROM documents WHERE id = ?').run(row.id);
        purged += 1;
      }
    }
  });
  if (purged > 0) {
    if (!scrubDeletedBytes(db)) {
      audit(db, { tenant_id: ctx.tenant_id, verb: 'retention_purge', actor_key_id: ctx.key_id,
                  document_count: purged, outcome: 'cleanup_incomplete' });
      throw conflict('retention_cleanup_incomplete');
    }
    audit(db, { tenant_id: ctx.tenant_id, verb: 'retention_purge', actor_key_id: ctx.key_id,
                document_count: purged, outcome: 'ok' });
  }
  return { documents_purged: purged };
}

// ---------------------------------------------------------------- export

export const EXPORT_FORMAT_VERSION = 1;

export function exportCorpus(db, ctx) {
  const tenant = db.prepare('SELECT id, display_name, created_at FROM tenants WHERE id = ?').get(ctx.tenant_id);
  const sources = db.prepare(`SELECT id, kind, display_name, root, scope_json, retention_days,
                              created_at, revoked_at, deleted_at FROM sources
                              WHERE tenant_id = ? ORDER BY created_at`).all(ctx.tenant_id);
  const documents = db.prepare(`SELECT id, source_id, uri, content_sha256, byte_size,
                                source_modified_at, harvested_at, last_seen_run_id, deleted_at
                                FROM documents WHERE tenant_id = ? AND deleted_at IS NULL
                                ORDER BY source_id, uri`).all(ctx.tenant_id);
  const chunks = db.prepare(`SELECT c.id, c.document_id, c.ordinal, c.start_byte, c.end_byte,
                             c.start_line, c.end_line, c.text_sha256, f.text
                             FROM chunks c JOIN chunks_fts f ON f.rowid = c.rowid
                             WHERE c.tenant_id = ? ORDER BY c.document_id, c.ordinal`)
    .all(ctx.tenant_id);
  const runs = db.prepare(`SELECT id, source_id, started_at, finished_at, docs_added, docs_changed,
                           docs_removed, bytes_indexed, outcome FROM harvest_runs
                           WHERE tenant_id = ? ORDER BY started_at, rowid`).all(ctx.tenant_id);
  const auditRows = db.prepare(`SELECT id, at, verb, actor_key_id, source_id, document_count, outcome
                                FROM audit_log WHERE tenant_id = ? ORDER BY at, rowid`).all(ctx.tenant_id);
  const tombstones = db.prepare(`SELECT source_id, deleted_at, documents_removed, chunks_removed
                                 FROM source_tombstones WHERE tenant_id = ?`).all(ctx.tenant_id);

  audit(db, { tenant_id: ctx.tenant_id, verb: 'export', actor_key_id: ctx.key_id,
              document_count: documents.length, outcome: 'ok' });

  return {
    format: 'context-harvest.corpus',
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: nowIso(),
    tenant: tenant ? { id: tenant.id, display_name: tenant.display_name, created_at: tenant.created_at } : null,
    sources: sources.map((s) => ({
      source_id: s.id, kind: s.kind, display_name: s.display_name, root: s.root,
      scope: JSON.parse(s.scope_json), retention_days: s.retention_days,
      created_at: s.created_at, revoked_at: s.revoked_at, deleted_at: s.deleted_at
    })),
    documents: documents.map((d) => ({
      document_id: d.id, source_id: d.source_id, uri: d.uri, content_sha256: d.content_sha256,
      byte_size: d.byte_size, source_modified_at: d.source_modified_at,
      harvested_at: d.harvested_at, last_seen_run_id: d.last_seen_run_id
    })),
    chunks: chunks.map((c) => ({
      chunk_id: c.id, document_id: c.document_id, ordinal: c.ordinal,
      locator: { start_line: c.start_line, end_line: c.end_line,
                 start_byte: c.start_byte, end_byte: c.end_byte },
      text_sha256: c.text_sha256, text: c.text
    })),
    // Rows come back from the driver with a null prototype; the export is plain JSON data and
    // must not carry the shape of whatever driver produced it.
    harvest_runs: runs.map((r) => ({ ...r })),
    source_tombstones: tombstones.map((r) => ({ ...r })),
    audit_log: auditRows.map((r) => ({ ...r }))
  };
}
