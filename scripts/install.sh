#!/usr/bin/env bash
# AutoDev installation entrypoint. Dispatches to AutoDev's typed installer CLI.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"

exec env AUTODEV_REPO_ROOT="$repo_root" CODEX_HOME="$codex_home" node "$repo_root/runtime/src/cli/install.ts" "$@"

