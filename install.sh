#!/usr/bin/env bash
# Process-dispatch shim. Typed install and check ownership live in AutoDev's CLI.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
exec env AUTODEV_REPO_ROOT="$repo_root" CODEX_HOME="$codex_home" node "$repo_root/src/cli/install.ts" "$@"
