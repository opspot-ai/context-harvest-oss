# Context Harvest v0 scope

## Purpose and user

Context Harvest is for a developer or operator who wants an MCP-capable agent to retrieve relevant passages from a local handbook, project decision folder, or runbook. The operator chooses the source folder, limits what is indexed, owns the local database and keys, and can export or delete the indexed copy. The useful output is a source-backed passage whose origin and current freshness can be checked.

## Inputs and processing

The only connector in v0 is a local folder. The service accepts regular UTF-8 text files within an explicitly registered root and caller-specified include/exclude globs. Each source has per-file and total byte limits. It refuses symlink reads, hardlinked files whose scope cannot be proven, other non-regular files, invalid UTF-8, and paths that change during a guarded read.

The application stores indexed content in one operator-selected SQLite database. SQLite FTS5 ranks literal search terms with BM25 and Porter stemming. It does not use embeddings, vector search, a language model, semantic ranking, a remote connector, or a hosted service.

## Outputs and access

A retrieval result contains text, a relevance score, source and document identifiers, a source-relative URI, exact byte and line locators, a content hash, and freshness metadata. Freshness is checked from the source at query time. A changed, missing, unsafe, excluded, or over-budget file is marked stale; a source root that cannot be verified is marked unverified. Existing indexed text is returned as a snapshot, never replaced with new content during retrieval.

MCP provides three read-only tools: `search_context`, `get_document`, and `list_sources`. MCP is available over stdio and streamable HTTP. The CLI and bearer-authenticated HTTP API support source registration, harvest, refresh, export, deletion, and key management. The tenant is derived from the key. Retrieve-scoped keys cannot perform lifecycle operations.

## Supported use

Use v0 to retrieve policies, decisions, and runbook instructions from a folder the operator controls. Use specific terms: search is literal-term search with stemming, not question answering. PDF and office files must be converted to text by an operator-controlled process before connecting them.

## Success checks

A useful local run connects a bounded folder, harvests it, searches and fetches a source-backed passage, verifies a fresh/stale transition after a source change, exports the corpus if needed, deletes the indexed data, and revokes a key. The synthetic demo exercises this lifecycle with fictional documents. See [verification](VERIFICATION.md).

## Limits

- No hosted deployment, billing, login, UI, remote connectors, binary document parsing, MCP mutation tools, embeddings, or semantic search.
- The HTTP service binds to loopback by default. TLS and Internet-facing deployment are not provided.
- The database is not encrypted by the application. OS permissions and backup practices belong to the operator.
- Normal service operation does not enforce an egress sandbox. The macOS test applies a boundary only to its exercised processes and lifecycle.
- Deletion does not remove source files or copies in exports, backups, snapshots, or storage remnants.
- Retrieved text is untrusted and may contain prompt injection. The receiving agent controls its own behavior and network use.
- Runtime checks cover Node 24.21.0 and 26.7.0 on macOS; other operating systems and external user deployments are not established by these checks.
