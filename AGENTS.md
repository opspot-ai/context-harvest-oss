# Guidance for coding agents

Read [README.md](README.md), [the v0 scope](docs/SCOPE.md), [the agent guide](docs/AGENT-GUIDE.md), [contributor instructions](CONTRIBUTING.md), and [security notes](SECURITY.md) before proposing a change.

Keep changes within the shipped local v0: one explicitly scoped folder connector, UTF-8 text, local SQLite/FTS5, and retrieval-only MCP tools. Do not describe this release as hosted or as semantic search. Preserve source provenance, query-time freshness, tenant authorization, bounded reads, export, deletion, and immediate key revocation.

Use fictional synthetic content only in tests and examples. Never add API keys, customer files, exports, databases, private paths, operational transcripts, or logs. Do not paste private source data into an AI tool. Preserve accurate contributor and AI-assistance attribution in [NOTICE.md](NOTICE.md).

Run the checks in [docs/VERIFICATION.md](docs/VERIFICATION.md) from a clean install. Report the exact Node and pnpm versions, commands, results, and any skipped checks. A passing test suite does not establish support on another operating system or clear a public release.
