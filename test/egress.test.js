import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// B7's runtime proof lives outside the Node process under test. The complete gate is executed by
// remediation.test.js and by `pnpm run test:egress-boundary`; this test keeps its boundary and
// loopback-only policy reviewable as code.
test('the no-egress gate is an external sandbox with only loopback outbound allowed', () => {
  const profile = readFileSync(new URL('../scripts/no-egress.sb', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../scripts/test-egress-boundary.sh', import.meta.url), 'utf8');
  assert.match(profile, /deny network-outbound/);
  assert.match(profile, /allow network-outbound \(remote ip "localhost:\*"\)/);
  assert.match(runner, /sandbox-exec/);
  assert.match(runner, /1\.1\.1\.1/);
  for (const surface of ['cli', 'http', 'mcp-stdio', 'mcp-http']) assert.match(runner, new RegExp(surface));
});

test('the installed production dependency tree contains no model-provider or telemetry SDK', () => {
  const output = execFileSync(process.execPath,
    [new URL('./installed-deps.js', import.meta.url).pathname], { encoding: 'utf8' });
  assert.match(output, /installed dependency tree audited: \d+ resolved package versions/);
  assert.match(output, /MCP SDK \d+\.\d+\.\d+/);
});

test('the source tree contains no model or telemetry endpoint', async () => {
  const { readdirSync } = await import('node:fs');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  const repoRoot = new URL('..', import.meta.url).pathname;
  walk(join(repoRoot, 'src'));
  walk(join(repoRoot, 'bin'));

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/node:(child_process|worker_threads|cluster)/.test(text),
      `${file} imports a process boundary outside the product contract`);
    assert.ok(!/process\.dlopen|process\.binding/.test(text),
      `${file} reaches an ungoverned native boundary`);
    const urls = text.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
    for (const url of urls) {
      assert.ok(/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url),
        `${file} references an outbound URL: ${url}`);
    }
  }
});
