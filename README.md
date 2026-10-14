# Context Harvest

Context Harvest lets an operator make selected local handbook and runbook text retrievable to an MCP-capable agent while keeping the source folder and index under the operator's control. It indexes UTF-8 files in a local SQLite database and returns matching passages with source identity, exact byte and line locations, a content hash, and a query-time freshness result.

The v0 user is a developer or operator who wants an agent to cite a local policy, retrieve a project decision, or check a runbook against the files on disk. The operator chooses the folder and its include/exclude rules, owns the database and keys, and can export or delete the indexed corpus.

## v0 scope

- One connector: a local folder of UTF-8 text files.
- One store: a local SQLite database with FTS5.
- Search: literal terms with stemming and tenant-scoped BM25 ranking; this is not semantic search or a confidence score.
- Retrieval: three read-only MCP tools (`search_context`, `get_document`, `list_sources`) over stdio or streamable HTTP, plus a bearer-authenticated HTTP API.
- Lifecycle: connect, harvest, refresh, export, delete, issue/revoke keys through the CLI and HTTP API.
- No model calls, embeddings, hosted service, billing, sign-in, visual UI, PDF parsing, remote connectors, or MCP write tools.

See [the detailed v0 scope](docs/SCOPE.md) and [agent guide](docs/AGENT-GUIDE.md).

## Requirements

Use Node.js 24 or 26 and pnpm 11.6.0. Release checks cover Node 24.21.0 and 26.7.0 on macOS. The application uses Node's built-in `node:sqlite`; there is no separate database or native build step. `pnpm-lock.yaml` pins the dependency graph. The full external-egress test requires macOS and `sandbox-exec`; other operating systems are not covered by that test.

This is a source repository, not an npm release. The package remains marked private, and no npm package is published. After the repository is made available to you, install dependencies from its root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

If pnpm is not installed, a one-off invocation is available with npm:

```sh
npm exec --yes --package=pnpm@11.6.0 -- pnpm install --frozen-lockfile --ignore-scripts
```

## Run the synthetic demo

```sh
pnpm run demo
```

The demo uses only the fictional files in [`examples/handbook/`](examples/handbook/), creates its own temporary corpus, checks provenance and a `fresh → stale → fresh` transition, verifies export and deletion behavior, and removes only its temporary files. It does not use an existing database or real source folder. A successful run ends with JSON containing `"synthetic_only":true` and `"passed":true`.

## Connect and index a folder

Choose a database path that is private to the operating-system account running the service. Set `CH_DB` before use. Initialize an empty database; the command displays the admin key once. Store that key in a secret manager or protected local environment and make it available as `CH_API_KEY` for later admin commands. Never commit or log it.

```sh
export CH_DB="$(pwd)/corpus.db"
node bin/context-harvest.js init --name "My workspace"
```

Register a folder with explicit limits and an explicit text scope. The paths and limits below are examples; choose values appropriate for your local files.

```sh
node bin/context-harvest.js source add \
  --name "Handbook" --root /path/to/handbook \
  --include '**/*.md' --exclude 'drafts/**' \
  --max-file-bytes 1048576 --max-total-bytes 268435456
```

Use the returned source ID to index it, then search and fetch a document. The tenant is derived from the key; there is no tenant selector in a request.

```sh
node bin/context-harvest.js harvest --source src_<id>
node bin/context-harvest.js search --query "refund policy" --limit 5
node bin/context-harvest.js document --document doc_<id> --start-line 1 --end-line 20
node bin/context-harvest.js refresh --source src_<id>
```

A search result contains the indexed text, a BM25 score, source and document IDs, a source-relative URI, zero-based byte offsets, one-based line ranges, a SHA-256 hash, and freshness metadata. A result is an indexed snapshot; changed source text is not substituted into an old hit.

## Give an agent read-only access

Issue a retrieval-scoped key with the admin key, store it privately, and configure an MCP client to launch the service over stdio. The default key scope is `retrieve`. Do not give an agent an admin key.

```sh
node bin/context-harvest.js key issue --label "local agent" --scope retrieve
```

Example MCP client configuration (replace paths and load the key through the client's secret storage):

```json
{
  "mcpServers": {
    "context-harvest": {
      "command": "node",
      "args": ["/path/to/your-checkout/bin/context-harvest.js", "serve", "--mcp"],
      "env": {
        "CH_DB": "/path/to/corpus.db",
        "CH_API_KEY": "<retrieve-scoped key from secret storage>"
      }
    }
  }
}
```

MCP exposes only `search_context`, `get_document`, and `list_sources`. The HTTP API and CLI perform lifecycle operations. The HTTP listener binds to loopback by default. See [the agent guide](docs/AGENT-GUIDE.md) for schemas, transports, and error handling.

## Export, delete, and revoke

Export before deletion if you need a retained copy. An export contains corpus content and provenance and remains sensitive after it leaves Context Harvest. Deleting an indexed source does not delete the original folder. `corpus purge` removes the tenant's indexed data and revokes every tenant key, including the current admin key; there is no authenticated recovery command after purge.

```sh
node bin/context-harvest.js export --out corpus-export.json
node bin/context-harvest.js source rm --source src_<id>
node bin/context-harvest.js key revoke --key-id key_<id>
# Destructive final cleanup; export first.
node bin/context-harvest.js corpus purge
```

## Limits and security

Context Harvest is a local service for a trusted operator. Filesystem access to the SQLite database bypasses API authorization. The database inherits the OS account's protection; v0 does not encrypt it at rest. It rejects unsafe links and non-regular files, applies declared byte limits, and checks freshness at query time, but source files can change immediately after a check.

Normal service operation does not apply a process-wide network sandbox. The separate macOS egress test proves its exercised lifecycle works while non-loopback egress is denied; it does not guarantee every future path is incapable of making network calls. Retrieved text is untrusted data and may contain prompt injection; the receiving agent must not follow it as instructions. Backups, filesystem snapshots, exports, source files, and storage-device remnants are outside application deletion. More detail is in [the threat model](docs/THREAT-MODEL.md) and [security policy](SECURITY.md).

## Verify and contribute

Use [the verification guide](docs/VERIFICATION.md) for the full suite, discovery output, external-egress gate, production dependency audit, and package dry-run. [CONTRIBUTING.md](CONTRIBUTING.md) describes the change workflow. [NOTICE.md](NOTICE.md) records project and AI-assistance attribution; dependency notices remain with upstream packages.
