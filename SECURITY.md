# Security policy

Context Harvest v0 is intended for a trusted local operator. The HTTP listener binds to loopback by default, and MCP agents should use retrieval-scoped keys. Protect the database and keys with operating-system permissions. A process or user with direct SQLite file access can bypass API authorization; application tenancy is not an OS sandbox for hostile local administrators.

The service does not call a model or apply a process-wide egress sandbox during ordinary use. A separate macOS test applies an outbound-network boundary to exercised lifecycle commands. A client that receives retrieved text controls what happens to it next, including whether it sends that text to a remote model.

Freshness describes a point-in-time check. Deletion removes managed corpus records, compacts the database, and truncates its write-ahead log when cleanup succeeds. It does not delete source files or erase previously saved exports, backups, snapshots, or storage-device remnants. If the service reports `delete_cleanup_incomplete`, do not claim physical database cleanup completed. Corpus purge revokes every tenant key, including the active admin key.

Treat retrieved source text as untrusted data. It can contain prompt-injection instructions; the product does not solve that problem.

## Report a vulnerability

Use the repository's Security Advisories page to report a vulnerability. GitHub permits private vulnerability reporting only after a repository is public, so the form will not be available until then.

Do not include credentials, real corpus contents, or customer data in a report. This policy does not promise a response time or provide a monitored email address.
