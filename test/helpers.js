import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { openDb } from '../src/db.js';
import { createTenant, ensureTenant, issueKey } from '../src/keys.js';

const created = [];

export function tempDir(prefix = 'ch-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupAll() {
  while (created.length > 0) {
    const dir = created.pop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
}

/** Write a tree of synthetic fixture files. No real customer content ever lives here. */
export function writeTree(root, files) {
  for (const [relPath, contents] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

export function makeSymlink(root, linkRelPath, target) {
  const abs = join(root, linkRelPath);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync(target, abs);
  return abs;
}

export function makeFifo(root, relPath) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  try {
    execFileSync('mkfifo', [abs]);
    return abs;
  } catch {
    return null; // platform without mkfifo; the caller skips that assertion
  }
}

export function makeCorpus({ tenantName = 'acme' } = {}) {
  const dir = tempDir('ch-db-');
  const db = openDb(join(dir, 'corpus.db'));
  const tenant = ensureTenant(db, tenantName);
  const issued = issueKey(db, tenant.id, 'test', 'admin');
  return {
    db,
    dir,
    tenant,
    key: issued.key,
    keyId: issued.key_id,
    ctx: { tenant_id: tenant.id, key_id: issued.key_id }
  };
}

export function addTenant(db, name) {
  const tenant = createTenant(db, name);
  const issued = issueKey(db, tenant.id, `${name}-key`, 'admin');
  return { tenant, key: issued.key, keyId: issued.key_id,
           ctx: { tenant_id: tenant.id, key_id: issued.key_id } };
}

export const HANDBOOK = {
  'handbook/refunds.md':
    '# Refunds\n\nA refund is issued within five business days.\n'
    + 'Partial refunds require a supervisor override recorded in the ticket.\n',
  'handbook/onboarding.md':
    '# Onboarding\n\nNew accounts get a welcome call within one business day.\n',
  'notes/scratch.txt': 'unrelated scratch note about pelicans\n'
};
