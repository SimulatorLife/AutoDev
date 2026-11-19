#!/usr/bin/env bash
set -euo pipefail
hook_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
codex_home="${CODEX_HOME:-$(dirname -- "$hook_dir")}"
export PLAYWRIGHT_BROWSERS_PATH="$codex_home/provider-runtime/opencli/browsers"
if [[ -z "${CODEX_ROUTER_OPENCLI_API_KEY:-}" && -f "$codex_home/.env" ]]; then
  CODEX_ROUTER_OPENCLI_API_KEY="$(awk -F= '$1 == "CODEX_ROUTER_OPENCLI_API_KEY" { value = substr($0, index($0, "=") + 1) } END { print value }' "$codex_home/.env")"
  if [[ -n "$CODEX_ROUTER_OPENCLI_API_KEY" ]]; then
    export CODEX_ROUTER_OPENCLI_API_KEY
  fi
fi
# The Google account opencli's Gemini commands run as (an email). Optional: a
# browser signed in to several Google accounts otherwise opens Gemini as its
# first one, which may be an account without the Gemini app.
if [[ -z "${OPENCLI_GEMINI_ACCOUNT:-}" && -f "$codex_home/.env" ]]; then
  OPENCLI_GEMINI_ACCOUNT="$(awk -F= '$1 == "OPENCLI_GEMINI_ACCOUNT" { value = substr($0, index($0, "=") + 1) } END { print value }' "$codex_home/.env")"
  if [[ -n "$OPENCLI_GEMINI_ACCOUNT" ]]; then
    export OPENCLI_GEMINI_ACCOUNT
  fi
fi
if [[ -z "${CODEX_ROUTER_OPENCLI_API_KEY:-}" ]]; then
  echo "opencli bridge auth key is missing from $codex_home/.env; rerun the AutoDev installer." >&2
  exit 78
fi
resolve_node() {
  # LaunchAgents carry the installer's selected binary; direct starts use pnpm's Node shim.
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then
    printf '%s\n' "$AUTODEV_NODE_BIN"
    return 0
  fi
  local pnpm_home="${PNPM_HOME:-$HOME/Library/pnpm}"
  if [[ -x "$pnpm_home/bin/node" ]]; then
    printf '%s\n' "$pnpm_home/bin/node"
    return 0
  fi
  return 1
}
node_bin="$(resolve_node)" || { echo "run-codex-opencli-proxy: node not found" >&2; exit 127; }
# The bridge is a typed AutoDev runtime module installed under CODEX_HOME. It
# runs opencli from the Runtime's own @jackwener/opencli dependency, which the
# installed tree reaches through its node_modules link.
proxy_script="$codex_home/src/providers/opencli.ts"
if [[ ! -f "$proxy_script" ]]; then
  echo "opencli proxy source is missing: $proxy_script" >&2
  echo "Run scripts/install.sh to deploy it." >&2
  exit 1
fi
exec env OPENCLI_PROXY_HOST="${CODEX_OPENCLI_PROXY_HOST:-127.0.0.1}" OPENCLI_PROXY_PORT="${CODEX_OPENCLI_PROXY_PORT:-4004}" \
  "$node_bin" "$proxy_script"
