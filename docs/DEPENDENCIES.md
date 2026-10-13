# Dependencies and notices

The project uses `@modelcontextprotocol/sdk` 1.31.0 as its direct runtime dependency. `pnpm-lock.yaml` records the full resolved package graph. The verified graph contains 92 production package versions across both supported Node runtimes.

The repository does not copy package source into its tree and does not bundle a `node_modules` directory. Install with pnpm 11.6.0 and the frozen lockfile. Each installed package carries its own upstream license and any required notice files. The project MIT license does not change those terms.

The source snapshot also does not redistribute Node.js or its bundled SQLite runtime. If you create a combined binary or archive that bundles dependencies or runtime components, inspect and preserve the applicable upstream license and notice material for the exact versions you distribute.
