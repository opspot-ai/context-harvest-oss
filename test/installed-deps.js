import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const [root] = JSON.parse(execFileSync('pnpm', ['list', '--prod', '--depth', 'Infinity', '--json'], {
  cwd: new URL('..', import.meta.url).pathname,
  encoding: 'utf8'
}));
const installed = new Map();
function walk(dependencies) {
  for (const [name, value] of Object.entries(dependencies ?? {})) {
    installed.set(`${name}@${value.version}`, { name, version: value.version });
    walk(value.dependencies);
  }
}
walk(root.dependencies);

const banned = /(^|[/@])(openai|anthropic|@anthropic-ai|cohere|mistralai|@google\/generative-ai|langchain|llamaindex|sentry|@sentry|posthog|mixpanel|segment|datadog|axios|node-fetch|got|undici)($|\/)/;
for (const { name } of installed.values()) {
  assert.ok(!banned.test(name), `${name} must not enter the installed production tree`);
}
const sdk = [...installed.values()].find((item) => item.name === '@modelcontextprotocol/sdk');
assert.ok(sdk, 'the installed MCP SDK was not found');
process.stdout.write(
  `installed dependency tree audited: ${installed.size} resolved package versions; MCP SDK ${sdk.version}\n`
);
