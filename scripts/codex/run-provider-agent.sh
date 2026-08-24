#!/usr/bin/env bash
set -euo pipefail

# Run one bounded external-provider Codex turn from an OpenAI desktop parent.
# The desktop multi-agent dispatcher validates model IDs against the ChatGPT
# account before it reaches local providers, so external roles enter through a
# local profile instead of the native spawn_agent tool.

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
codex_bin="${CODEX_BIN:-}"
if [[ -z "$codex_bin" ]]; then
  codex_bin="$(command -v codex || true)"
  # Prefer the newest nvm-installed CLI when an older system Codex shadows it.
  nvm_codex="$(find "$HOME/.nvm/versions/node" -path '*/bin/codex' -type f -perm -111 -print 2>/dev/null | sort | tail -1)"
  if [[ -n "$nvm_codex" ]]; then codex_bin="$nvm_codex"; fi
fi
[[ -x "$codex_bin" ]] || { echo "Codex CLI not found; set CODEX_BIN to the current codex executable." >&2; exit 1; }
provider=""
role=""
prompt=""
prompt_file=""
check_only=0

usage() {
  cat >&2 <<'EOF'
Usage: run-provider-agent.sh --provider claude|minimax|antigravity [options]

Options:
  --role ROLE          Role label for the bounded turn (default: provider default)
  --prompt TEXT        Prompt to send to the provider
  --prompt-file FILE   Read the prompt from FILE; use - for stdin
  --check              Validate the provider profile and local launcher only
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      provider="$2"
      shift 2
      ;;
    --role)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      role="$2"
      shift 2
      ;;
    --prompt)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      prompt="$2"
      shift 2
      ;;
    --prompt-file)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      prompt_file="$2"
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    --help|-h)
      usage >&1
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$provider" in
  claude)
    profile_model="sonnet"
    ensure_script="$repo_root/scripts/ensure-codex-claude-bridge.sh"
    case "${role:-explorer}" in
      explorer) role_file="$codex_home/agents/explorer.toml" ;;
      *) echo "Unsupported Claude role: $role" >&2; exit 2 ;;
    esac
    ;;
  minimax)
    profile_model="MiniMax-M3"
    ensure_script="$repo_root/scripts/ensure-codex-minimax-proxy.sh"
    case "${role:-worker}" in
      worker) role_file="$codex_home/agents/worker.toml" ;;
      *) echo "Unsupported MiniMax role: $role" >&2; exit 2 ;;
    esac
    ;;
  antigravity)
    profile_model="gemini-3.6-flash-medium"
    ensure_script="$repo_root/scripts/ensure-codex-antigravity-proxy.sh"
    case "${role:-validator}" in
      validator) role_file="$codex_home/agents/validator.toml" ;;
      *) echo "Unsupported Antigravity role: $role" >&2; exit 2 ;;
    esac
    ;;
  "")
    echo "--provider is required" >&2
    usage
    exit 2
    ;;
  *)
    echo "Unsupported provider: $provider" >&2
    usage
    exit 2
    ;;
esac

profile="$codex_home/$provider.config.toml"
[[ -f "$profile" ]] || { echo "Missing Codex profile: $profile" >&2; exit 1; }
[[ -x "$ensure_script" ]] || { echo "Missing provider ensure hook: $ensure_script" >&2; exit 1; }
[[ -f "$role_file" ]] || { echo "Missing provider role: $role_file" >&2; exit 1; }

if [[ "$check_only" == 1 ]]; then
  "$codex_bin" --profile "$provider" --strict-config -C "$repo_root" --help >/dev/null
  printf 'provider=%s profile=%s role=%s status=ready\n' "$provider" "$profile" "${role:-default}"
  exit 0
fi

if [[ -n "$prompt_file" ]]; then
  if [[ "$prompt_file" == "-" ]]; then
    prompt="$(cat)"
  else
    prompt="$(<"$prompt_file")"
  fi
fi
[[ -n "$prompt" ]] || { echo "Provide --prompt or --prompt-file (use - for stdin)." >&2; exit 2; }

# Start only the bridge required for this provider. The same scripts are used
# by SubagentStart hooks, so direct CLI and app-launched turns share one setup.
case "$provider" in
  claude)
    printf '{"model":"%s"}\n' "$profile_model" | bash "$ensure_script"
    ;;
  minimax)
    bash "$ensure_script" --daemon
    ;;
  antigravity)
    printf '{"model":"%s"}\n' "$profile_model" | bash "$ensure_script"
    ;;
esac

role_context="$(python3 - "$role_file" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as stream:
    config = tomllib.load(stream)
print(config.get("developer_instructions", ""))
PY
)"

prompt=$'Provider role instructions:\n'"$role_context"$'\n\nBounded task:\n'"$prompt"
exec "$codex_bin" --profile "$provider" --strict-config -C "$repo_root" exec \
  --ephemeral --json --skip-git-repo-check "$prompt"
