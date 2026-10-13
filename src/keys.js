import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { nowIso } from './db.js';
import { newKeyId, newTenantId } from './ids.js';
import { badRequest, forbidden, unauthorized } from './errors.js';

export const KEY_PREFIX = 'ch_';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function ensureTenant(db, displayName = 'default') {
  const existing = db.prepare('SELECT * FROM tenants ORDER BY created_at LIMIT 1').get();
  if (existing) return existing;
  const tenant = { id: newTenantId(), display_name: displayName, created_at: nowIso() };
  db.prepare('INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)')
    .run(tenant.id, tenant.display_name, tenant.created_at);
  return tenant;
}

export function createTenant(db, displayName) {
  const tenant = { id: newTenantId(), display_name: displayName, created_at: nowIso() };
  db.prepare('INSERT INTO tenants (id, display_name, created_at) VALUES (?, ?, ?)')
    .run(tenant.id, tenant.display_name, tenant.created_at);
  return tenant;
}

// The plaintext is returned to the caller exactly once and is never stored or logged.
export function issueKey(db, tenantId, label = 'default', scope = 'retrieve') {
  if (!['retrieve', 'admin'].includes(scope)) throw badRequest('key_scope_invalid');
  const plaintext = KEY_PREFIX + randomBytes(32).toString('base64url');
  const row = {
    id: newKeyId(), tenant_id: tenantId, key_sha256: sha256(plaintext),
    label, scope, created_at: nowIso(), revoked_at: null
  };
  db.prepare(`INSERT INTO api_keys (id, tenant_id, key_sha256, label, scope, created_at, revoked_at)
              VALUES (?, ?, ?, ?, ?, ?, NULL)`)
    .run(row.id, row.tenant_id, row.key_sha256, row.label, row.scope, row.created_at);
  return { key_id: row.id, tenant_id: tenantId, label, scope,
           created_at: row.created_at, key: plaintext };
}

export function revokeKey(db, keyId, tenantId = null) {
  const sql = tenantId
    ? 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL'
    : 'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL';
  const args = tenantId ? [nowIso(), keyId, tenantId] : [nowIso(), keyId];
  const res = db.prepare(sql).run(...args);
  return res.changes > 0;
}

export function revokeAllKeys(db, tenantId) {
  return db.prepare('UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL')
    .run(nowIso(), tenantId).changes;
}

export function listKeys(db, tenantId) {
  return db.prepare(`SELECT id, label, scope, created_at, revoked_at FROM api_keys
                     WHERE tenant_id = ? ORDER BY created_at`).all(tenantId);
}

// Called on EVERY request and EVERY MCP tool call. There is no cache and no grace window --
// THREAT-MODEL.md T4. A revoked key is dead on its next call, including inside a session that
// authenticated successfully a moment earlier.
export function authenticate(db, presented) {
  if (typeof presented !== 'string' || !presented.startsWith(KEY_PREFIX)) throw unauthorized();
  const digest = sha256(presented);
  const row = db.prepare('SELECT id, tenant_id, key_sha256, scope, revoked_at FROM api_keys WHERE key_sha256 = ?')
    .get(digest);
  if (!row) throw unauthorized();
  // Constant-time compare on the digest as well; the index lookup already matched, this only
  // removes a timing signal from any future non-unique lookup path.
  const a = Buffer.from(row.key_sha256, 'hex');
  const b = Buffer.from(digest, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized();
  if (row.revoked_at) throw unauthorized('revoked');
  return { key_id: row.id, tenant_id: row.tenant_id, scope: row.scope };
}

export function authorizeScope(ctx, required) {
  if (required === 'retrieve' && (ctx.scope === 'retrieve' || ctx.scope === 'admin')) return ctx;
  if (required === 'admin' && ctx.scope === 'admin') return ctx;
  throw forbidden();
}

export function bearerFromHeader(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
