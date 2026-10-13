#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
profile="$repo_root/scripts/no-egress.sb"

if [ -z "${CH_EXPECTED_NODE_VERSION:-}" ]; then
  echo "CH_EXPECTED_NODE_VERSION must be set to the exact suite runtime" >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ] || [ ! -x /usr/bin/sandbox-exec ]; then
  echo "external no-egress gate requires macOS sandbox-exec" >&2
  exit 1
fi

runtime_assertion='
  const expected = process.env.CH_EXPECTED_NODE_VERSION;
  const actual = process.version;
  if (actual !== expected) {
    process.stderr.write(`sandboxed Node runtime mismatch: expected ${expected}, actual ${actual}\n`);
    process.exit(64);
  }
  process.stdout.write(`sandboxed Node runtime verified: expected ${expected}, actual ${actual}\n`);
'

script_runner='
  const { pathToFileURL } = await import("node:url");
  await import(pathToFileURL(process.argv[1]).href);
'

boundary_probe='
  const { connect } = await import("node:net");
  const socket = connect(80, "1.1.1.1");
  socket.on("error", (error) => {
    if (error.code !== "EPERM") process.exit(2);
    process.stdout.write("boundary denied outbound: " + error.code + "\n");
    process.exit(0);
  });
  setTimeout(() => process.exit(3), 2000);
'

/usr/bin/sandbox-exec -f "$profile" node --input-type=module -e \
  "$runtime_assertion$boundary_probe"

for surface in cli http mcp-stdio mcp-http; do
  /usr/bin/sandbox-exec -f "$profile" node --input-type=module -e \
    "$runtime_assertion$script_runner" "$repo_root/test/egress-cycle.js" "$surface"
done

/usr/bin/sandbox-exec -f "$profile" node --input-type=module -e \
  "$runtime_assertion$script_runner" "$repo_root/test/installed-deps.js"
