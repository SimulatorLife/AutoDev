#!/usr/bin/env bash
# Codex Cloud bootstrap for developing AutoDev, not the macOS host installer.
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

required_node="$(tr -d '\r\n' < .nvmrc)"
if ! command -v node >/dev/null 2>&1 || ! node - "$required_node" <<'NODE'
const actual = process.versions.node.split(".").map(Number);
const minimum = process.argv[2].split(".").map(Number);
for (let index = 0; index < 3; index++) {
  if ((actual[index] ?? 0) > (minimum[index] ?? 0)) process.exit(0);
  if ((actual[index] ?? 0) < (minimum[index] ?? 0)) process.exit(1);
}
NODE
then
  printf 'AutoDev requires Node %s+; set this version in the Codex Cloud environment.\n' "$required_node" >&2
  exit 1
fi

if command -v corepack >/dev/null 2>&1; then
  corepack enable
fi

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'pnpm is missing; enable Corepack or install the version pinned by package.json.\n' >&2
  exit 1
fi

required_pnpm="$(node -p "require('./package.json').packageManager.split('@')[1]")"
actual_pnpm="$(pnpm --version)"
if [[ "$actual_pnpm" != "$required_pnpm" ]]; then
  printf 'Expected pnpm %s, found %s. Use the packageManager pin in package.json.\n' "$required_pnpm" "$actual_pnpm" >&2
  exit 1
fi

pnpm install --frozen-lockfile
bash scripts/bootstrap-repo-exclusions.sh
pnpm exec rulesync generate --targets codexcli --features skills --silent
pnpm autodev -- --help >/dev/null
printf 'AutoDev cloud development toolchain ready.\n'
