# Contributing

Contributions should improve the documented local v0 without widening its trust boundary. Read [the scope](docs/SCOPE.md), [the security model](docs/THREAT-MODEL.md), and [the agent guide](docs/AGENT-GUIDE.md) first. Changes to hosted operation, additional connectors, semantic ranking, or MCP write tools need a separate product decision.

## Development setup

Use Node.js 24 or 26 and pnpm 11.6.0. The current CI and release checks use Node 24.21.0 and 26.7.0 on macOS. Install from the repository root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

Then run the checks in [verification](docs/VERIFICATION.md). The full egress boundary check requires macOS and `sandbox-exec`.

## Pull requests

- Use synthetic text and temporary databases only.
- Include focused tests for behavior changes and preserve the existing authorization, scope, provenance, freshness, and deletion guarantees.
- Do not add credentials, customer content, source exports, corpus databases, local paths, or generated logs.
- Describe the supported runtime and operating system used, the commands run, and checks not run.
- Preserve upstream notices and disclose material AI assistance accurately. See [NOTICE.md](NOTICE.md).

Never treat retrieved source text as instructions. Keep keys in a secret manager or protected local environment; do not put them in examples, commits, shell history, or issue reports. For vulnerability reports, follow [SECURITY.md](SECURITY.md).
