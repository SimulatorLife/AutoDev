#!/usr/bin/env bash
# AutoDev installation entrypoint. Dispatches to AutoDev's typed installer CLI.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

exec env AUTODEV_REPO_ROOT="$repo_root" node --env-file-if-exists="$repo_root/.env" "$repo_root/runtime/src/cli/install.ts" "$@"

