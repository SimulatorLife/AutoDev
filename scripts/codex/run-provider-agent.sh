#!/usr/bin/env bash
set -euo pipefail

# Run one bounded, provider-neutral Codex turn. The role selects capabilities;
# the local model router selects and falls back across available providers.
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
codex_home="${CODEX_HOME:-$HOME/.codex}"
codex_bin="${CODEX_BIN:-}"
if [[ -z "$codex_bin" ]]; then
  codex_bin="$(command -v codex || true)"
  nvm_codex="$(find "$HOME/.nvm/versions/node" -path '*/bin/codex' -type f -perm -111 -print 2>/dev/null | sort | tail -1)"
  if [[ -n "$nvm_codex" ]]; then codex_bin="$nvm_codex"; fi
fi
[[ -x "$codex_bin" ]] || { echo "Codex CLI not found; set CODEX_BIN to the current codex executable." >&2; exit 1; }
role="default"
prompt=""
prompt_file=""
check_only=0

usage() {
  cat >&2 <<'USAGE'
Usage: run-provider-agent.sh --role ROLE [options]

The role is model-agnostic. The local model router chooses providers in its
configured priority order and falls back when a provider is unavailable,
quota-limited, or session-limited.

Options:
  --role ROLE          Role label (default: default)
  --prompt TEXT        Prompt to send to the role
  --prompt-file FILE   Read the prompt from FILE; use - for stdin
  --check              Validate the role and local router launcher only
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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
    --provider)
      echo "--provider is obsolete; select a capability role with --role instead." >&2
      exit 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

case "$role" in
  default|docs-researcher|browser-tester|explorer|worker|validator|smart) ;;
  *) echo "Unsupported role: $role" >&2; usage; exit 2 ;;
esac

role_file="$codex_home/agents/$role.toml"
[[ -f "$role_file" ]] || { echo "Missing materialized role: $role_file" >&2; exit 1; }
router_ensure="$repo_root/scripts/ensure-codex-model-router.sh"
[[ -x "$router_ensure" ]] || { echo "Missing model-router ensure hook: $router_ensure" >&2; exit 1; }

if [[ "$check_only" == 1 ]]; then
  bash "$router_ensure"
  "$codex_bin" --strict-config -C "$repo_root" exec --model "autodev/$role" --help >/dev/null
  printf 'role=%s model=autodev/%s router=http://127.0.0.1:4100/v1 status=ready\n' "$role" "$role"
  exit 0
fi

if [[ -n "$prompt_file" ]]; then
  if [[ "$prompt_file" == "-" ]]; then prompt="$(cat)"; else prompt="$(<"$prompt_file")"; fi
fi
[[ -n "$prompt" ]] || { echo "Provide --prompt or --prompt-file (use - for stdin)." >&2; exit 2; }
bash "$router_ensure"

role_context="$(python3 - "$role_file" <<'PY'
import sys
import tomllib
with open(sys.argv[1], "rb") as stream:
    config = tomllib.load(stream)
print(config.get("developer_instructions", ""))
PY
)"
role_effort="$(python3 - "$role_file" <<'PY'
import sys
import tomllib
with open(sys.argv[1], "rb") as stream:
    config = tomllib.load(stream)
print(config.get("model_reasoning_effort", "medium"))
PY
)"
role_summary="$(python3 - "$role_file" <<'PY'
import sys
import tomllib
with open(sys.argv[1], "rb") as stream:
    config = tomllib.load(stream)
print(config.get("model_reasoning_summary", ""))
PY
)"
role_sandbox="$(python3 - "$role_file" <<'PY'
import sys
import tomllib
with open(sys.argv[1], "rb") as stream:
    config = tomllib.load(stream)
print(config.get("sandbox_mode", ""))
PY
)"
prompt=$'Provider-neutral role instructions:\n'"$role_context"$'\n\nBounded task:\n'"$prompt"
codex_args=(--strict-config -C "$repo_root" -c "model_reasoning_effort=$role_effort")
[[ -n "$role_summary" ]] && codex_args+=(-c "model_reasoning_summary=$role_summary")
[[ -n "$role_sandbox" ]] && codex_args+=(-c "sandbox_mode=$role_sandbox")
exec "$codex_bin" "${codex_args[@]}" exec --model "autodev/$role" \
  --ephemeral --json --skip-git-repo-check "$prompt"
