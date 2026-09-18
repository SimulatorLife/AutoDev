#!/usr/bin/env bash
# Process-dispatch shim. Role parsing, TOML settings, router readiness, and
# Codex invocation live in the typed provider-agent CLI.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
node_bin="${AUTODEV_NODE_BIN:-$(command -v node || true)}"
[[ -x "$node_bin" ]] || { echo "run-provider-agent: node not found" >&2; exit 127; }
exec env AUTODEV_REPO_ROOT="$repo_root" "$node_bin" "$repo_root/src/cli/provider-agent.ts" "$@"
