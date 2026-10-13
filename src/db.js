import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
-- Tenant-local ranking uses a transient FTS5 view. Keep it in memory so a search never creates
-- another filesystem copy of customer content.
PRAGMA temp_store = MEMORY;
-- Overwrite deleted payloads in their b-tree pages. A truncating WAL checkpoint after a product
-- delete then leaves no pre-delete page image in any SQLite file.
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  key_sha256  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'retrieve' CHECK (scope IN ('retrieve', 'admin')),
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_sha ON api_keys(key_sha256);

CREATE TABLE IF NOT EXISTS sources (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  kind            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  root            TEXT NOT NULL,
  scope_json      TEXT NOT NULL,
  retention_days  INTEGER,
  created_at      TEXT NOT NULL,
  revoked_at      TEXT,
  deleted_at      TEXT
);
CREATE INDEX IF NOT EXISTS sources_tenant ON sources(tenant_id);

CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  source_id          TEXT NOT NULL REFERENCES sources(id),
  uri                TEXT NOT NULL,
  content_sha256     TEXT NOT NULL,
  byte_size          INTEGER NOT NULL,
  source_modified_at TEXT NOT NULL,
  source_mtime_ns    TEXT NOT NULL DEFAULT '',
  harvested_at       TEXT NOT NULL,
  last_seen_run_id   TEXT,
  deleted_at         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS documents_source_uri ON documents(source_id, uri);
CREATE INDEX IF NOT EXISTS documents_tenant ON documents(tenant_id);

CREATE TABLE IF NOT EXISTS chunks (
  rowid       INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  ordinal     INTEGER NOT NULL,
  start_byte  INTEGER NOT NULL,
  end_byte    INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  text_sha256 TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
CREATE INDEX IF NOT EXISTS chunks_tenant ON chunks(tenant_id);

-- Chunk text lives here and nowhere else. Deleting a chunk therefore has exactly two rows to
-- remove, both inside one transaction, and the auditor can assert against this table directly.
--
-- The porter wrapper stems tokens, so a customer asking about a "refund" reaches a document that
-- says "Refunds". Without it the index matches only exact word forms, which for a retrieval
-- product is not a nicety -- it is the difference between finding the answer and not. Porter is a
-- deterministic algorithm bundled in SQLite: no model, no network, no dependency.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='porter unicode61');

CREATE TABLE IF NOT EXISTS harvest_runs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id),
  source_id     TEXT NOT NULL REFERENCES sources(id),
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  docs_added    INTEGER NOT NULL DEFAULT 0,
  docs_changed  INTEGER NOT NULL DEFAULT 0,
  docs_removed  INTEGER NOT NULL DEFAULT 0,
  bytes_indexed INTEGER NOT NULL DEFAULT 0,
  outcome       TEXT
);
CREATE INDEX IF NOT EXISTS harvest_runs_source ON harvest_runs(source_id);

-- Ids, counts, verbs, outcomes. No text column exists, so there is nothing here to leak.
CREATE TABLE IF NOT EXISTS audit_log (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  at             TEXT NOT NULL,
  verb           TEXT NOT NULL,
  actor_key_id   TEXT,
  source_id      TEXT,
  document_count INTEGER,
  outcome        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_tenant ON audit_log(tenant_id);

CREATE TABLE IF NOT EXISTS source_tombstones (
  source_id  TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  documents_removed INTEGER NOT NULL,
  chunks_removed    INTEGER NOT NULL
);
`;

export function resolveDbPath(explicit) {
  const raw = explicit || process.env.CH_DB || './context-harvest.db';
  return resolve(raw);
}

export function openDb(explicit) {
  const path = resolveDbPath(explicit);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh = !existsSync(path);
  // Create the database file at 0600 BEFORE SQLite opens it. SQLite copies the database file's
  // mode onto the -wal, -shm and -journal sidecars it creates, so tightening the mode after the
  // first write would leave the sidecar that already exists world-readable.
  if (fresh) closeSync(openSync(path, 'a', 0o600));
  restrictPermissions(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const schemaChanged = migrateSchema(db);
  const ftsChanged = migrateFtsTokenizer(db);
  enableFtsSecureDelete(db);
  // ALTER TABLE/DROP TABLE can leave the old payload in freed pages. A one-time migration
  // compaction is the price of making the upgraded file obey the same byte-level promise as a
  // newly-created corpus.
  if (schemaChanged || ftsChanged) {
    db.exec('VACUUM');
    const migrated = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (migrated?.busy !== 0 || migrated?.log !== 0) {
      throw new Error('migration_cleanup_incomplete');
    }
  }
  // The corpus is only as safe as the file it sits in -- THREAT-MODEL.md T9. The -wal and -shm
  // sidecars hold recent page images, which means they hold chunk text; a 0600 database beside
  // a 0644 write-ahead log would be a control that only looks like one.
  restrictPermissions(path);
  if (fresh) { /* nothing extra yet; migrations land here */ }
  db.__path = path;
  return db;
}

export const FTS_TOKENIZER = "porter unicode61";

export function migrateSchema(db) {
  let changed = false;
  const keyColumns = db.prepare('PRAGMA table_info(api_keys)').all().map((row) => row.name);
  if (!keyColumns.includes('scope')) {
    // Existing unscoped credentials are least-privilege on upgrade. Promoting them to admin
    // would preserve the very control-plane escalation this migration closes.
    db.exec("ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'retrieve' CHECK (scope IN ('retrieve', 'admin'))");
    changed = true;
  }
  const runColumns = db.prepare('PRAGMA table_info(harvest_runs)').all().map((row) => row.name);
  if (runColumns.includes('skipped_json')) {
    // The live run response still reports every skipped path. Persisting those paths added
    // customer data that the frozen schema never declared.
    db.exec('ALTER TABLE harvest_runs DROP COLUMN skipped_json');
    changed = true;
  }
  return changed;
}

/**
 * FTS5 segments are append-oriented and do not inherit PRAGMA secure_delete. Without FTS5's own
 * control, deleted terms can remain in segment pages while another source keeps the index alive.
 */
export function enableFtsSecureDelete(db) {
  const current = db.prepare("SELECT v FROM chunks_fts_config WHERE k = 'secure-delete'").get();
  if (Number(current?.v) === 1) return false;
  db.prepare("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('secure-delete', 1)").run();
  return true;
}

/**
 * `CREATE VIRTUAL TABLE IF NOT EXISTS` silently keeps whatever tokenizer an existing corpus was
 * built with, so a database created before the tokenizer changed would keep searching the old way
 * with nothing to show for it. Chunk text lives in this table, so the index can be rebuilt in
 * place from itself without re-reading the customer's source.
 */
export function migrateFtsTokenizer(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_fts'").get();
  if (!row || row.sql.includes(FTS_TOKENIZER)) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE VIRTUAL TABLE chunks_fts_migrated USING fts5(text, tokenize='${FTS_TOKENIZER}')`);
    db.exec('INSERT INTO chunks_fts_migrated(rowid, text) SELECT rowid, text FROM chunks_fts');
    db.exec('DROP TABLE chunks_fts');
    db.exec('ALTER TABLE chunks_fts_migrated RENAME TO chunks_fts');
    db.exec('COMMIT');
    return true;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function restrictPermissions(path) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { chmodSync(path + suffix, 0o600); } catch { /* absent, or a platform without modes */ }
  }
}

/**
 * Flush the post-delete state into the main database and remove every pre-delete WAL frame.
 * `secure_delete` zeroes removed values in those post-delete pages; both controls are required.
 */
export function scrubDeletedBytes(db) {
  const first = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (first?.busy !== 0 || first?.log !== 0) return false;
  try {
    // secure_delete covers the rows being removed and FTS5 secure-delete covers current
    // segments. VACUUM additionally removes historical freed pages (including pages left by a
    // tokenizer migration). This is O(database size); v0 chooses deletion truth over purge
    // latency. A later slice may replace it only with equally strong file-level evidence.
    db.exec('VACUUM');
  } catch {
    return false;
  }
  const final = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if (db.__path) restrictPermissions(db.__path);
  return final?.busy === 0 && final?.log === 0;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();
