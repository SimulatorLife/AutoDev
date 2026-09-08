#!/usr/bin/env bash
set -euo pipefail

# Load router secrets/config if present (optional under launchd).
if [[ -f "$HOME/.codex/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.codex/.env"
  set +a
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

# launchd starts us with a minimal PATH that lacks nvm/homebrew node.
# Resolve a real node binary robustly before exec.
resolve_node() {
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

exec "$NODE_BIN" "$HOME/.codex/hooks/codex-model-router.mjs"
