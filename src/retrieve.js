import { badRequest, notFound } from './errors.js';
import { makeFreshnessProbe } from './freshness.js';

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;

/**
 * FTS5 query syntax is not exposed. Every token from the customer's query becomes a quoted
 * literal term, so no MATCH expression the caller writes can change which columns or rows are
 * considered. Tenancy does not depend on this -- it is enforced in SQL on chunks, documents and
 * sources independently -- but narrowing the surface costs nothing.
 */
export function toFtsQuery(query) {
  if (typeof query !== 'string') throw badRequest('query_required');
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) || [];
  if (tokens.length === 0) throw badRequest('query_has_no_searchable_terms');
  return tokens.slice(0, 32).map((token) => '"' + token + '"').join(' OR ');
}

function normalizeLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw badRequest('limit_must_be_positive_integer');
  return Math.min(limit, MAX_LIMIT);
}

export function search(db, ctx, { query, source_ids = null, limit } = {}) {
  const ftsQuery = toFtsQuery(query);
  const take = normalizeLimit(limit);

  // Every tenant predicate below is derived from the authenticated key. No tenant id is ever
  // read from the request -- THREAT-MODEL.md T2.
  let sql = `
    SELECT c.id AS chunk_id, c.document_id, c.start_line, c.end_line, c.start_byte, c.end_byte,
           tenant_rank_fts.text AS text, bm25(tenant_rank_fts) AS bm25,
           d.uri, d.content_sha256, d.harvested_at, d.source_modified_at, d.source_mtime_ns, d.byte_size,
           s.id AS source_id, s.display_name AS source_name, s.kind AS source_kind, s.root AS source_root,
           s.scope_json AS source_scope_json
    FROM tenant_rank_fts
    JOIN chunks    c ON c.rowid = tenant_rank_fts.rowid
    JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
    JOIN sources   s ON s.id = d.source_id  AND s.tenant_id = d.tenant_id
    WHERE tenant_rank_fts MATCH ?
      AND c.tenant_id = ? AND d.tenant_id = ? AND s.tenant_id = ?
      AND d.deleted_at IS NULL AND s.deleted_at IS NULL`;
  const args = [ftsQuery, ctx.tenant_id, ctx.tenant_id, ctx.tenant_id];

  if (source_ids !== null && source_ids !== undefined) {
    if (!Array.isArray(source_ids)) throw badRequest('source_ids_must_be_array');
    if (source_ids.length === 0) return finish(db, ctx, [], take);
    for (const id of source_ids) {
      if (typeof id !== 'string') throw badRequest('source_ids_must_be_strings');
    }
    // One binding regardless of cardinality. One-placeholder-per-id eventually hits either
    // SQLite's MAX_VARIABLE_NUMBER or JavaScript's spread-argument ceiling, and used to turn a
    // valid source filter into a misleading parse error (or an unbounded internal error).
    sql += ' AND s.id IN (SELECT value FROM json_each(?))';
    args.push(JSON.stringify(source_ids));
  }

  // BM25 first. On a small corpus a term can carry zero discriminating information and every
  // hit legitimately scores the same, so uri and ordinal break the tie and keep result order
  // stable across identical queries.
  sql += ' ORDER BY bm25 ASC, d.uri ASC, c.ordinal ASC LIMIT ?';
  args.push(take);

  let rows;
  try {
    // FTS5 computes BM25 statistics over the whole virtual table. Ranking directly against the
    // shared index therefore turns another tenant's term frequency into a score oracle. Build a
    // tenant-only view in SQLite's in-memory temp store for this query; it retains FTS5 ranking
    // semantics without putting another tenant in the scoring population.
    db.exec("CREATE VIRTUAL TABLE temp.tenant_rank_fts USING fts5(text, tokenize='porter unicode61')");
    db.prepare(`INSERT INTO temp.tenant_rank_fts(rowid, text)
                SELECT c.rowid, f.text FROM chunks c JOIN chunks_fts f ON f.rowid = c.rowid
                WHERE c.tenant_id = ?`).run(ctx.tenant_id);
    rows = db.prepare(sql).all(...args);
  } catch {
    throw badRequest('query_could_not_be_parsed');
  } finally {
    try { db.exec('DROP TABLE IF EXISTS temp.tenant_rank_fts'); } catch { /* best effort */ }
  }

  const freshnessFor = makeFreshnessProbe();
  const hits = rows.map((row) => ({
    chunk_id: row.chunk_id,
    text: row.text,
    // bm25() returns a negative number where more negative is a better match. We publish a
    // positive relevance score so "higher is better" holds for the caller.
    score: Number((-row.bm25).toFixed(4)),
    provenance: {
      source_id: row.source_id,
      source_name: row.source_name,
      source_kind: row.source_kind,
      document_id: row.document_id,
      uri: row.uri,
      locator: {
        start_line: row.start_line, end_line: row.end_line,
        start_byte: row.start_byte, end_byte: row.end_byte
      },
      content_sha256: row.content_sha256
    },
    freshness: freshnessFor(
      { id: row.source_id, root: row.source_root, scope: JSON.parse(row.source_scope_json) },
      { uri: row.uri, byte_size: row.byte_size, harvested_at: row.harvested_at,
        source_modified_at: row.source_modified_at, source_mtime_ns: row.source_mtime_ns,
        content_sha256: row.content_sha256 }
    )
  }));

  return finish(db, ctx, hits, take);
}

function finish(db, ctx, hits, limit) {
  // Retrieval is intentionally read-only. Keeping an audit row per caller-driven read made the
  // MCP annotation false and let a client grow the database without bound.
  void db; void ctx;
  return { hits, count: hits.length, limit };
}

export function getDocument(db, ctx, documentId, { start_line = null, end_line = null } = {}) {
  if (typeof documentId !== 'string' || documentId.length === 0) throw badRequest('document_id_required');
  for (const [name, value] of [['start_line', start_line], ['end_line', end_line]]) {
    if (value !== null && (!Number.isInteger(value) || value <= 0)) {
      throw badRequest(`${name}_must_be_positive_integer`);
    }
  }
  if (start_line !== null && end_line !== null && start_line > end_line) {
    throw badRequest('line_range_invalid');
  }
  const row = db.prepare(`
    SELECT d.id, d.uri, d.content_sha256, d.byte_size, d.harvested_at, d.source_modified_at,
           d.source_mtime_ns,
           s.id AS source_id, s.display_name AS source_name, s.kind AS source_kind, s.root AS source_root,
           s.scope_json AS source_scope_json
    FROM documents d
    JOIN sources s ON s.id = d.source_id AND s.tenant_id = d.tenant_id
    WHERE d.id = ? AND d.tenant_id = ? AND s.tenant_id = ?
      AND d.deleted_at IS NULL AND s.deleted_at IS NULL`)
    .get(documentId, ctx.tenant_id, ctx.tenant_id);

  // A deleted document is a 404 with no body, never a redacted one.
  if (!row) {
    throw notFound('document');
  }

  const chunks = db.prepare(`
    SELECT c.id, c.ordinal, c.start_line, c.end_line, c.start_byte, c.end_byte, f.text
    FROM chunks c JOIN chunks_fts f ON f.rowid = c.rowid
    WHERE c.document_id = ? AND c.tenant_id = ? ORDER BY c.ordinal`)
    .all(documentId, ctx.tenant_id);

  const wantsRange = start_line !== null || end_line !== null;
  const selected = chunks.filter((chunk) => {
    if (start_line !== null && chunk.end_line < start_line) return false;
    if (end_line !== null && chunk.start_line > end_line) return false;
    return true;
  });
  if (wantsRange && selected.length === 0) throw badRequest('line_range_out_of_bounds');

  let text = selected.map((chunk) => chunk.text).join('');
  let firstLine = selected.length > 0 ? selected[0].start_line : 0;
  let lastLine = selected.length > 0 ? selected[selected.length - 1].end_line : 0;
  let firstByte = selected.length > 0 ? selected[0].start_byte : 0;
  let lastByte = selected.length > 0 ? selected[selected.length - 1].end_byte : 0;

  if (wantsRange && selected.length > 0) {
    // Narrow to the requested lines and narrow the byte locator with them. A locator that
    // still described the whole chunk while the text was trimmed would be a false provenance
    // claim, which is the one thing this product may not do.
    const buffer = Buffer.from(text, 'utf8');
    const lineStarts = [0];
    for (let i = 0; i < buffer.length; i += 1) if (buffer[i] === 0x0a) lineStarts.push(i + 1);

    const from = start_line === null ? firstLine : Math.max(firstLine, start_line);
    const to = end_line === null ? lastLine : Math.min(lastLine, end_line);
    const fromIndex = Math.min(Math.max(from - firstLine, 0), lineStarts.length - 1);
    const toIndex = Math.min(Math.max(to - firstLine, 0), lineStarts.length - 1);

    const sliceStart = lineStarts[fromIndex];
    const sliceEnd = toIndex + 1 < lineStarts.length ? lineStarts[toIndex + 1] : buffer.length;
    text = buffer.subarray(sliceStart, sliceEnd).toString('utf8');
    firstByte = selected[0].start_byte + sliceStart;
    lastByte = selected[0].start_byte + sliceEnd;
    firstLine = from;
    lastLine = to;
  }

  const freshnessFor = makeFreshnessProbe();
  return {
    document_id: row.id,
    text,
    provenance: {
      source_id: row.source_id,
      source_name: row.source_name,
      source_kind: row.source_kind,
      document_id: row.id,
      uri: row.uri,
      locator: { start_line: firstLine, end_line: lastLine,
                 start_byte: firstByte, end_byte: lastByte },
      content_sha256: row.content_sha256
    },
    freshness: freshnessFor(
      { id: row.source_id, root: row.source_root, scope: JSON.parse(row.source_scope_json) },
      { uri: row.uri, byte_size: row.byte_size, harvested_at: row.harvested_at,
        source_modified_at: row.source_modified_at, source_mtime_ns: row.source_mtime_ns,
        content_sha256: row.content_sha256 })
  };
}
