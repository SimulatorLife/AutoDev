#!/usr/bin/env bash
# run-codex-console.sh — Launchd entrypoint that exec's the resolved Node
# against console/node_modules/next/dist/bin/next start on the loopback
# interface, exporting only the two Console-required service credentials
# (AUTODEV_CONTROL_API_TOKEN, AUTODEV_OPENLIT_USAGE_TOKEN) and the optional
# nonsecret URL overrides that drive the same server-side adapters.
#
# This script is intentionally a thin, policy-free dispatcher. All
# readiness, restart, and build-orchestration decisions live in the typed
# Runtime platform owner; this shell layer only:
#
#   1. Resolves a real Node binary (AUTODEV_NODE_BIN → PATH → nvm → homebrew).
#   2. Confirms console/.next/BUILD_ID exists (the Runtime installer builds
#      console/ first; this script never invokes a build).
#   3. Reads only the two Console-required tokens from
#      CODEX_HOME/openlit-secrets.env via an exact-key awk parser; the file
#      is NEVER sourced, and token values are NEVER printed.
#   4. Reads only the two optional nonsecret URL overrides the Console server
#      consumes (AUTODEV_CONTROL_API_BASE_URL, AUTODEV_OPENLIT_USAGE_URL) from
#      CODEX_HOME/.env if present; anything else in that file is ignored.
#   5. exec()s next start bound to 127.0.0.1 on AUTODEV_CONSOLE_PORT (default
#      3300).

set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"
repo_root="${AUTODEV_REPO_ROOT:-}"
console_port="${AUTODEV_CONSOLE_PORT:-3300}"

if [[ -z "$repo_root" ]]; then
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd -- "$script_dir/.." && pwd)"
fi

# Clear any inherited tokens before reading openlit-secrets.env so tokens
# come strictly from CODEX_HOME/openlit-secrets.env.
unset AUTODEV_CONTROL_API_TOKEN AUTODEV_OPENLIT_USAGE_TOKEN

# ---------------------------------------------------------------------------
# Optional nonsecret URL overrides from CODEX_HOME/.env
#
# Reads optional nonsecret URL overrides only from CODEX_HOME/.env if present,
# and only the two the Console server actually consumes. The allowlist is
# explicit rather than a `*_URL` glob so a variable with no Console consumer
# (for example the retired AUTODEV_OPENLIT_UI_URL bridge) never reaches the
# server. Secret tokens are never read from .env.
# ---------------------------------------------------------------------------
if [[ -f "$codex_home/.env" ]]; then
  while IFS='=' read -r key val || [[ -n "$key" ]]; do
    # Strip carriage return and leading/trailing whitespace
    key="${key%$'\r'}"
    key="$(printf '%s' "$key" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ "$key" =~ ^# ]] || [[ -z "$key" ]]; then
      continue
    fi
    case "$key" in
      AUTODEV_CONTROL_API_BASE_URL|AUTODEV_OPENLIT_USAGE_URL)
        val="${val%$'\r'}"
        val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        val="${val%\"}"
        val="${val#\"}"
        val="${val%\'}"
        val="${val#\'}"
        export "$key"="$val"
        ;;
    esac
  done < "$codex_home/.env"
fi

# ---------------------------------------------------------------------------
# Exact-key token parser for openlit-secrets.env.
#
# Reads only AUTODEV_CONTROL_API_TOKEN and AUTODEV_OPENLIT_USAGE_TOKEN by
# exact first-field match. NEVER sources the file (which would expose every
# secret it contains) and NEVER echoes a token value. Missing values stay
# unset so the Next.js server can render the documented "credential not
# configured" state per page instead of silently accepting an empty token.
# ---------------------------------------------------------------------------
openlit_secret_file="${AUTODEV_OPENLIT_SECRET_FILE:-$codex_home/openlit-secrets.env}"
if [[ -f "$openlit_secret_file" ]]; then
  read_openlit_secret() {
    local name="$1"
    awk -F= -v key="$name" '$1 == key { sub(/^[^=]*=/, ""); sub(/\r$/, ""); print; exit }' "$openlit_secret_file"
  }
  control_token="$(read_openlit_secret AUTODEV_CONTROL_API_TOKEN)"
  usage_token="$(read_openlit_secret AUTODEV_OPENLIT_USAGE_TOKEN)"
  if [[ -n "$control_token" ]]; then
    export AUTODEV_CONTROL_API_TOKEN="$control_token"
  fi
  if [[ -n "$usage_token" ]]; then
    export AUTODEV_OPENLIT_USAGE_TOKEN="$usage_token"
  fi
  unset control_token usage_token
fi

# ---------------------------------------------------------------------------
# Node resolution (matches the installer's typed resolver behavior)
# ---------------------------------------------------------------------------
resolve_node() {
  # launchd passes the native Node the installer resolved; PATH order alone
  # can pick an Intel build that Rosetta translates on every cold start.
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then
    printf '%s\n' "$AUTODEV_NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  for candidate in \
    "$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_node || true)"
if [[ -z "${NODE_BIN:-}" ]]; then
  echo "run-codex-console: could not locate a node binary" >&2
  exit 127
fi

# ---------------------------------------------------------------------------
# Build artifact gate: console/.next/BUILD_ID must already exist.
#
# `next start` refuses to serve without a build; without an explicit gate
# the launcher would crash-loop and look like a real runtime bug. The
# Runtime installer is the single owner of `next build`; this script never
# invokes a build. A clear, actionable error points the operator at the
# installer so they do not reach for `next build` here and drift from the
# canonical build pipeline.
# ---------------------------------------------------------------------------
console_dir="$repo_root/console"
build_id_file="$console_dir/.next/BUILD_ID"
if [[ ! -f "$build_id_file" ]]; then
  cat >&2 <<ERR
run-codex-console: console/.next/BUILD_ID is missing at $build_id_file
  Next.js requires a built console before 'next start' can serve it.
  The Runtime installer is the single owner of the console build
  (it pre-builds console/.next so the LaunchAgent can exec 'next start').
  Re-run scripts/install.sh, or invoke the installer's typed
  console-build step (runtime/src/platform/install-command.ts), to
  produce console/.next/BUILD_ID before launching this service.
ERR
  exit 2
fi

next_bin="$console_dir/node_modules/next/dist/bin/next"
if [[ ! -f "$next_bin" ]]; then
  echo "run-codex-console: next bin is missing: $next_bin" >&2
  echo "  Reinstall console/node_modules (the Runtime installer links it)." >&2
  exit 127
fi

export AUTODEV_CONSOLE_PORT="$console_port"

# exec() so launchd supervises the Next.js server directly (no extra shell
# layer between KeepAlive and the worker). The server is bound to the
# loopback interface only; the Console is a single-user UI and is reached
# through whatever reverse proxy / SSH tunnel the deployment puts in
# front of it.
exec "$NODE_BIN" "$next_bin" \
  start \
  --hostname 127.0.0.1 \
  --port "$console_port"
