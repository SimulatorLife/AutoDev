#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"

# Load router settings and out-of-repository OpenLIT secrets. The generated
# secret file contains only shell-safe hex values and is mode 0600.
explicit_minimax_api_key="${MINIMAX_API_KEY:-}"
if [[ -f "$codex_home/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$codex_home/.env"
  set +a
fi
if [[ -n "$explicit_minimax_api_key" ]]; then
  export MINIMAX_API_KEY="$explicit_minimax_api_key"
elif [[ -z "${MINIMAX_API_KEY:-}" && "${AUTODEV_DISABLE_KEYCHAIN:-0}" != "1" ]] \
  && [[ "$(uname -s)" == "Darwin" && -x /usr/bin/security ]]; then
  keychain_account="${USER:-$(id -un)}"
  minimax_keychain_value="$(
    /usr/bin/security find-generic-password -a "$keychain_account" -s MINIMAX_API_KEY -w ${AUTODEV_KEYCHAIN_FILE:+"$AUTODEV_KEYCHAIN_FILE"} 2>/dev/null ||
      /usr/bin/security find-generic-password -s MINIMAX_API_KEY -w ${AUTODEV_KEYCHAIN_FILE:+"$AUTODEV_KEYCHAIN_FILE"} 2>/dev/null ||
      true
  )"
  if [[ -n "$minimax_keychain_value" ]]; then
    export MINIMAX_API_KEY="$minimax_keychain_value"
  fi
  unset minimax_keychain_value keychain_account
fi
unset explicit_minimax_api_key
openlit_secret_file="${AUTODEV_OPENLIT_SECRET_FILE:-$codex_home/openlit-secrets.env}"
unset AUTODEV_PLAYTEST_CONTROL_API_TOKEN
if [[ -f "$openlit_secret_file" ]]; then
  read_openlit_secret() {
    local name="$1"
    awk -F= -v key="$name" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$openlit_secret_file"
  }
  OPENLIT_OTLP_API_KEY="$(read_openlit_secret OPENLIT_OTLP_API_KEY)"
  AUTODEV_CONTROL_API_TOKEN="$(read_openlit_secret AUTODEV_CONTROL_API_TOKEN)"
  AUTODEV_PLAYTEST_CONTROL_API_TOKEN="$(read_openlit_secret AUTODEV_PLAYTEST_CONTROL_API_TOKEN)"
  export AUTODEV_CONTROL_API_TOKEN
fi

# The Playtest runner credential is deliberately separate from the Console's
# general Control API credential. Keep it in the router process only; role
# bridges pass it solely to the workspace-bound Playtest MCP process after
# validating the trusted Playtester role and session context. Never publish it
# to the launchd user environment or the Console.
if [[ "${AUTODEV_PLAYTEST_CONTROL_API_TOKEN:-}" =~ ^[0-9a-f]{64}$ ]]; then
  export AUTODEV_PLAYTEST_CONTROL_API_TOKEN
  export AUTODEV_PLAYTEST_CONTROL_API_ACTOR="autodev-playtester-runtime"
  export AUTODEV_PLAYTEST_CONTROL_API_ROLE="playtester"
  export AUTODEV_CONTROL_API_BASE_URL="${AUTODEV_CONTROL_API_BASE_URL:-http://127.0.0.1:${AUTODEV_CONTROL_API_LISTEN_PORT:-4101}}"
else
  unset AUTODEV_PLAYTEST_CONTROL_API_TOKEN
  unset AUTODEV_PLAYTEST_CONTROL_API_ACTOR
  unset AUTODEV_PLAYTEST_CONTROL_API_ROLE
fi

# Republish the router auth token to the launchd user domain.
#
# This is what keeps the two ends of the auth boundary agreeing across a
# reboot. The router gets the token durably from the .env sourced above, so
# once a token exists it enforces on every boot. Codex Desktop, though,
# resolves `env_key = "CODEX_ROUTER_AUTH_TOKEN"` from its own process
# environment and does NOT read $CODEX_HOME/.env -- so its only supply is
# what launchd hands a GUI launch. `launchctl setenv` does not survive a
# reboot, so without this the router would come up enforcing while every
# Desktop session came up unable to authenticate, and each boot would 401.
#
# RunAtLoad puts this before the user's Codex launch, and .env stays the one
# source of truth: the token is never written into the (git-tracked,
# symlinked) config.toml. A failure here must not stop the router from
# starting -- a router that is up and rejecting is far easier to diagnose
# than one that never bound its port.
if [[ -n "${CODEX_ROUTER_AUTH_TOKEN:-}" && "${AUTODEV_SKIP_LAUNCHCTL:-0}" != "1" ]] \
  && command -v launchctl >/dev/null 2>&1; then
  launchctl setenv CODEX_ROUTER_AUTH_TOKEN "$CODEX_ROUTER_AUTH_TOKEN" 2>/dev/null || \
    echo "run-autodev-model-router: could not publish CODEX_ROUTER_AUTH_TOKEN to launchd" >&2
fi


export AUTODEV_CONTROL_API_LISTEN_HOST="${AUTODEV_CONTROL_API_LISTEN_HOST:-0.0.0.0}"
export AUTODEV_CONTROL_API_LISTEN_PORT="${AUTODEV_CONTROL_API_LISTEN_PORT:-4101}"

# The agents export their telemetry to OpenLIT. Publish the same endpoint and
# key to the router and the GUI launchd domain so both Codex's exporters and
# the router's own spans reach the protected first-party receiver. No secret
# is written into config.toml/plist.
otlp_api_key="${OPENLIT_OTLP_API_KEY:-}"
if [[ ${#otlp_api_key} -lt 32 ]]; then
  echo "run-autodev-model-router: the OpenLIT OTLP key is required" >&2
  exit 1
fi
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${otlp_api_key}"
export AUTODEV_OPENLIT_OTLP_AUTH="1"
if [[ "${AUTODEV_SKIP_LAUNCHCTL:-0}" != "1" ]] \
  && command -v launchctl >/dev/null 2>&1; then
  launchctl setenv OTEL_EXPORTER_OTLP_ENDPOINT "$OTEL_EXPORTER_OTLP_ENDPOINT" 2>/dev/null || \
    echo "run-autodev-model-router: could not publish OpenLIT OTLP endpoint to launchd" >&2
  launchctl setenv OTEL_EXPORTER_OTLP_HEADERS "$OTEL_EXPORTER_OTLP_HEADERS" 2>/dev/null || \
    echo "run-autodev-model-router: could not publish OpenLIT OTLP auth to launchd" >&2
  launchctl setenv AUTODEV_OPENLIT_OTLP_AUTH "1" 2>/dev/null || \
    echo "run-autodev-model-router: could not publish OpenLIT ingress marker to launchd" >&2
fi

# launchd uses a minimal PATH; resolve the pnpm-managed Node directly.
# Resolve the pnpm-managed Node before exec.
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

NODE_BIN="$(resolve_node || true)"
if [[ -z "${NODE_BIN:-}" ]]; then
  echo "run-autodev-model-router: could not locate a node binary" >&2
  exit 127
fi

server_script="$codex_home/src/router/server.ts"
[[ -f "$server_script" ]] || server_script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/runtime/src/router/server.ts"
exec "$NODE_BIN" "$server_script"
