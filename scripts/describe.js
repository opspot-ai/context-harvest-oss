import { SERVER_INFO, TOOLS } from '../src/mcp.js';

// Project-local discovery output, using the same schemas served by MCP tools/list.
// This command opens no corpus, creates no credentials and starts no listener.
process.stdout.write(JSON.stringify({
  manifest_version: 1,
  server: SERVER_INFO,
  status: 'MIT-licensed v0 release snapshot',
  purpose: 'Local UTF-8 folder retrieval with provenance and query-time freshness',
  setup: 'README.md',
  agent_guide: 'docs/AGENT-GUIDE.md',
  verification: 'docs/VERIFICATION.md',
  connectors: ['folder'],
  store: 'SQLite FTS5',
  ranking: 'BM25 with Porter stemming; literal OR terms',
  authentication: {
    stdio: 'CH_API_KEY environment variable',
    http: 'Authorization: Bearer <retrieve-scoped key>',
    tenant: 'derived from the key',
    default_issued_scope: 'retrieve'
  },
  transports: [
    { kind: 'stdio', command: 'node bin/context-harvest.js serve --mcp' },
    { kind: 'streamable-http', url: 'http://127.0.0.1:8788/mcp',
      command: 'node bin/context-harvest.js serve --mcp --http --port 8788' }
  ],
  tools: TOOLS,
  control_plane: 'CLI and HTTP only; connect, harvest, refresh, export, delete, revoke',
  limitations: ['No model calls, embeddings or semantic ranking', 'No hosted service or billing',
    'No runtime process-wide egress sandbox unless the operator applies one',
    'Corpus text is untrusted data; prompt injection is not solved']
}, null, 2) + '\n');
