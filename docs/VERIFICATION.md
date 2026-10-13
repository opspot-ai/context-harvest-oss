# Verify a local checkout

## Prerequisites

Use Node.js 24.21.0 or 26.7.0, pnpm 11.6.0, and macOS with `sandbox-exec` for the full external-egress check. The repository workflow runs those exact Node versions on standard GitHub-hosted macOS runners. Other Node patches and operating systems are outside this verification matrix.

## Install and run

From the repository root, install the frozen graph without lifecycle scripts and run the full suite, synthetic demo, and discovery command:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run demo
node scripts/describe.js
```

A successful demo ends with JSON containing `"synthetic_only":true` and `"passed":true`. Discovery is generated from the MCP tool schemas and should list exactly the three read-only tools: `search_context`, `get_document`, and `list_sources`.

Run the external egress gate with the current Node runtime bound explicitly for child processes:

```sh
CH_EXPECTED_NODE_VERSION="$(node -p 'process.version')" pnpm run test:egress-boundary
```

The gate applies the macOS sandbox to the exercised lifecycle process tree, allows loopback for local protocol tests, and requires a real non-loopback connection attempt to fail with `EPERM`. It covers the CLI, HTTP, MCP stdio, and MCP over streamable HTTP. It does not establish that every future code path or operating system is incapable of network access.

For contributor review, also run:

```sh
pnpm audit --prod --json
npm pack --dry-run --json
git diff --check
```

Review the audit output and packed file list; do not suppress findings or claim an empty output without inspecting the command exit and content. `private: true` prevents npm publication, but does not replace the repository's release review.
