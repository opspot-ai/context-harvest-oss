# Security model and limits

## Protected data

The main assets are indexed source text, source paths, API keys, the SQLite corpus, and exports. Source text and paths can be sensitive even when a test fixture is fictional.

## Trust assumptions

The service assumes its operator and operating-system account are trusted. Local filesystem access to the database can bypass API authorization. Tenant IDs are derived from keys at the application layer; they do not isolate hostile processes with access to the same account or database file.

HTTP listeners bind to loopback by default. v0 does not provide TLS or a supported Internet-facing deployment. The application does not encrypt the database at rest; use OS permissions, encrypted storage, and protected backups appropriate to your environment.

## Implemented controls

- The operator declares a source root, include/exclude rules, and per-file and total byte limits.
- The folder reader refuses symlinks, non-regular files, invalid UTF-8, and paths whose identity changes during a guarded read. Hardlinked files are refused when the reader cannot prove they stay within scope.
- Retrieval checks source freshness at query time and preserves the indexed snapshot when the source is stale.
- API keys are stored as hashes; key scope is checked for each request and MCP call.
- Audit and diagnostic logging use bounded fields and omit source bodies and paths.
- Deletion removes indexed records and attempts database compaction and WAL truncation. If cleanup cannot complete, the service reports `delete_cleanup_incomplete`.
- The full suite includes an external-egress gate that runs on macOS under an outbound-network sandbox and uses a non-loopback negative control.

## Remaining risks

The egress test covers exercised paths only; ordinary service use does not receive its sandbox. The caller that receives retrieval results controls any later network transfer. A source may change after its freshness check. Application deletion cannot erase source files or copies in exports, backups, filesystem snapshots, or storage-device remnants. Prompt injection in retrieved text is not solved; consumers must treat retrieved material as data rather than instructions.
