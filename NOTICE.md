# Attribution and notices

Context Harvest v0 is distributed under the MIT License in [LICENSE](LICENSE). The copyright notice identifies Colton Harris and contributors as approved for this project release; it does not claim that one person authored every upstream contribution.

The original project history records contributions from multiple people and AI-assisted commit co-author attribution for Anthropic Claude and OpenAI Codex. This clean snapshot intentionally omits that Git history and includes release-preparation work created with OpenAI Codex assistance. These names record material assistance; they do not replace human contribution records or establish rights in third-party material.

The repository does not vendor dependency source or runtime binaries. `pnpm-lock.yaml` pins the package graph; `pnpm install` fetches packages and retains their upstream license and notice files under `node_modules`. Those notices remain governed by their respective upstream terms. Node.js and its bundled SQLite also carry separate notices. See [dependency notes](docs/DEPENDENCIES.md) before redistributing a combined build.
