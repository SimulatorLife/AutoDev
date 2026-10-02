#!/usr/bin/env bash
set -euo pipefail

codex_home="${CODEX_HOME:-$HOME/.codex}"

# Load router settings and out-of-repository OpenLIT secrets. The generated
# secret file contains only shell-safe hex values and is mode 0600.
if [[ -f "$codex_home/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$codex_home/.env"
  set +a
fi
openlit_secret_file="${AUTODEV_OPENLIT_SECRET_FILE:-$codex_home/openlit-secrets.env}"
if [[ -f "$openlit_secret_file" ]]; then
  read_openlit_secret() {
    local name="$1"
    awk -F= -v key="$name" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$openlit_secret_file"
  }
  OPENLIT_OTLP_API_KEY="$(read_openlit_secret OPENLIT_OTLP_API_KEY)"
  AUTODEV_CONTROL_API_TOKEN="$(read_openlit_secret AUTODEV_CONTROL_API_TOKEN)"
  export AUTODEV_CONTROL_API_TOKEN
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
    echo "run-codex-model-router: could not publish CODEX_ROUTER_AUTH_TOKEN to launchd" >&2
fi


# The OpenLIT ingress mode is committed only after config materialization and
# before service restart. Publish the same endpoint/key to the router and the
# GUI launchd domain so both Codex's exporters and router-owned spans use the
# protected first-party receiver. No secret is written into config.toml/plist.
mode_file="$codex_home/otel-ingress.mode"
otel_mode="direct"
if [[ -f "$mode_file" ]]; then
  otel_mode="$(tr -d '\r\n ' < "$mode_file")"
fi
if [[ "$otel_mode" == "openlit" ]]; then
  export AUTODEV_CONTROL_API_LISTEN_HOST="${AUTODEV_CONTROL_API_LISTEN_HOST:-0.0.0.0}"
  export AUTODEV_CONTROL_API_LISTEN_PORT="${AUTODEV_CONTROL_API_LISTEN_PORT:-4101}"
  otlp_api_key="${OPENLIT_OTLP_API_KEY:-}"
  if [[ ${#otlp_api_key} -lt 32 ]]; then
    echo "run-codex-model-router: OpenLIT ingress needs the CODEX_HOME OTLP key" >&2
    exit 1
  fi
  export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
  export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${otlp_api_key}"
  export AUTODEV_OPENLIT_OTLP_AUTH="1"
  if [[ "${AUTODEV_SKIP_LAUNCHCTL:-0}" != "1" ]] \
    && command -v launchctl >/dev/null 2>&1; then
    launchctl setenv OTEL_EXPORTER_OTLP_ENDPOINT "$OTEL_EXPORTER_OTLP_ENDPOINT" 2>/dev/null || \
      echo "run-codex-model-router: could not publish OpenLIT OTLP endpoint to launchd" >&2
    launchctl setenv OTEL_EXPORTER_OTLP_HEADERS "$OTEL_EXPORTER_OTLP_HEADERS" 2>/dev/null || \
      echo "run-codex-model-router: could not publish OpenLIT OTLP auth to launchd" >&2
    launchctl setenv AUTODEV_OPENLIT_OTLP_AUTH "1" 2>/dev/null || \
      echo "run-codex-model-router: could not publish OpenLIT ingress marker to launchd" >&2
  fi
elif [[ "${AUTODEV_OPENLIT_OTLP_AUTH:-}" == "1" ]]; then
  # Remove only values previously published by this launcher. Explicit values
  # in the user .env remain the user's configuration and are not overwritten.
  if ! grep -q '^OTEL_EXPORTER_OTLP_ENDPOINT=' "$codex_home/.env" 2>/dev/null; then
    unset OTEL_EXPORTER_OTLP_ENDPOINT
  fi
  if ! grep -q '^OTEL_EXPORTER_OTLP_HEADERS=' "$codex_home/.env" 2>/dev/null; then
    unset OTEL_EXPORTER_OTLP_HEADERS
  fi
  if [[ "${AUTODEV_SKIP_LAUNCHCTL:-0}" != "1" ]] \
    && command -v launchctl >/dev/null 2>&1; then
    launchctl unsetenv OTEL_EXPORTER_OTLP_ENDPOINT 2>/dev/null || true
    launchctl unsetenv OTEL_EXPORTER_OTLP_HEADERS 2>/dev/null || true
    launchctl unsetenv AUTODEV_OPENLIT_OTLP_AUTH 2>/dev/null || true
  fi
  unset AUTODEV_OPENLIT_OTLP_AUTH
fi

# launchd starts us with a minimal PATH that lacks nvm/homebrew node.
# Resolve a real node binary robustly before exec.
resolve_node() {
  # launchd passes the native Node the installer resolved; PATH order alone
  # can pick an Intel build that Rosetta translates on every cold start.
  if [[ -n "${AUTODEV_NODE_BIN:-}" && -x "$AUTODEV_NODE_BIN" ]]; then printf '%s\n' "$AUTODEV_NODE_BIN"; return 0; fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidate
  # Newest nvm-installed node, then common homebrew locations.
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
  echo "run-codex-model-router: could not locate a node binary" >&2
  exit 127
fi

server_script="$codex_home/src/router/server.ts"
[[ -f "$server_script" ]] || server_script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/runtime/src/router/server.ts"
exec "$NODE_BIN" "$server_script"
