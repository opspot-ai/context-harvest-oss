import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This demo always creates its own disposable corpus. It never uses the caller's CH_DB or key.
const work = mkdtempSync(join(tmpdir(), 'context-harvest-demo-'));
const db = join(work, 'corpus.db');
const sourceRoot = join(work, 'source');
const bin = fileURLToPath(new URL('../bin/context-harvest.js', import.meta.url));
cpSync(new URL('../examples/handbook/', import.meta.url), sourceRoot, { recursive: true });

function cli(args, key, status = 0) {
  const env = { ...process.env, CH_DB: db };
  delete env.CH_API_KEY;
  if (key) env.CH_API_KEY = key;
  const result = spawnSync(process.execPath, [bin, ...args], {
    env, encoding: 'utf8', timeout: 15_000
  });
  // Do not put stdout in an assertion: bootstrap and key issuance return one-time credentials.
  assert.equal(result.status, status, `demo command ${args[0]} failed`);
  return JSON.parse(status === 0 ? result.stdout : result.stderr);
}

const receipt = (step, result) => process.stdout.write(JSON.stringify({ step, ...result }) + '\n');
try {
  const admin = cli(['init', '--name', 'Synthetic demo']);
  const reader = cli(['key', 'issue', '--label', 'demo reader'], admin.key);
  assert.equal(reader.scope, 'retrieve');
  const source = cli(['source', 'add', '--name', 'Synthetic handbook', '--root', sourceRoot,
    '--include', '**/*.md', '--exclude', 'drafts/**',
    '--max-file-bytes', '65536', '--max-total-bytes', '262144'], admin.key);
  receipt('connect', { kind: source.kind, scope: source.scope });

  const harvested = cli(['harvest', '--source', source.source_id], admin.key);
  assert.equal(harvested.docs_added, 2);
  assert.ok(harvested.skipped.some((item) => item.reason === 'excluded'));
  receipt('harvest', { documents: harvested.docs_added, excluded_draft: true });

  const hit = cli(['search', '--query', 'refund', '--limit', '3'], reader.key).hits[0];
  assert.equal(hit.freshness.state, 'fresh');
  const document = cli(['document', '--document', hit.provenance.document_id], reader.key);
  const raw = readFileSync(join(sourceRoot, hit.provenance.uri));
  const { start_byte: from, end_byte: to } = hit.provenance.locator;
  assert.equal(hit.text, raw.subarray(from, to).toString('utf8'));
  assert.equal(document.text, raw.toString('utf8'));
  receipt('retrieve', { uri: hit.provenance.uri, locator: hit.provenance.locator,
    freshness: hit.freshness.state, text: hit.text });

  assert.equal(cli(['export'], reader.key, 1).error, 'forbidden');
  receipt('authorization', { reader_export: 'forbidden' });
  writeFileSync(join(sourceRoot, 'refunds.md'), raw.toString('utf8').replace('five', 'seven'));
  assert.equal(cli(['search', '--query', 'refund'], reader.key).hits[0].freshness.state, 'stale');
  const refreshed = cli(['refresh', '--source', source.source_id], admin.key);
  assert.equal(refreshed.docs_changed, 1);
  const updated = cli(['search', '--query', 'refund'], reader.key).hits[0];
  assert.equal(updated.freshness.state, 'fresh');
  assert.ok(updated.text.includes('seven business days'));
  receipt('refresh', { documents_changed: refreshed.docs_changed,
    freshness_sequence: ['fresh', 'stale', 'fresh'] });

  const exported = cli(['export'], admin.key);
  assert.equal(exported.format, 'context-harvest.corpus');
  assert.equal(exported.documents.length, 2);
  receipt('export', { format: exported.format, format_version: exported.format_version,
    documents: exported.documents.length, chunks: exported.chunks.length });

  cli(['source', 'rm', '--source', source.source_id], admin.key);
  assert.equal(cli(['search', '--query', 'refund'], reader.key).count, 0);
  assert.equal(cli(['document', '--document', hit.provenance.document_id], reader.key, 1).error,
    'not_found');
  assert.equal(cli(['export'], admin.key).documents.length, 0);
  assert.ok(exported.chunks.some((chunk) => chunk.text.includes('seven business days')));
  receipt('delete', { search_hits: 0, document: 'not_found', export_documents: 0,
    earlier_export_remains_usable: true });

  cli(['key', 'revoke', '--key-id', reader.key_id], admin.key);
  assert.equal(cli(['search', '--query', 'refund'], reader.key, 1).error, 'unauthorized');
  receipt('revoke', { next_request: 'unauthorized' });

  // Purge last: it revokes the admin credential as well as every other tenant key.
  cli(['corpus', 'purge'], admin.key);
  assert.equal(cli(['source', 'list'], admin.key, 1).error, 'unauthorized');
  receipt('purge', { admin_next_request: 'unauthorized' });
  receipt('complete', { synthetic_only: true, passed: true });
} finally {
  // Only the directory created by this demo is removed; user corpora are never touched.
  rmSync(work, { recursive: true, force: true });
}
