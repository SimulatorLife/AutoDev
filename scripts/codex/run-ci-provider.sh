#!/usr/bin/env bash
set -euo pipefail

# Canonical CI provider entrypoint. The reusable GitHub workflow owns retries,
# checkout, prompts, and push handling; this script owns only provider command
# selection from the pinned AutoDev tool manifest.
provider="${AUTODEV_CI_PROVIDER:-}"
prompt_file="${AGENT_PROMPT_FILE:-}"
runner_temp="${RUNNER_TEMP:-/tmp}"
[[ -n "$prompt_file" && -f "$prompt_file" ]] || { echo "AGENT_PROMPT_FILE is missing" >&2; exit 1; }

require_pinned_package() {
  local name="$1" value="$2"
  [[ "$value" =~ ^@[^@[:space:]]+@[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
    echo "$name must be an exact semver package spec (got: $value)" >&2
    exit 1
  }
}

case "$provider" in
  claude)
    : "${AUTODEV_CLAUDE_PACKAGE:?AUTODEV_CLAUDE_PACKAGE is required}"
    require_pinned_package AUTODEV_CLAUDE_PACKAGE "$AUTODEV_CLAUDE_PACKAGE"
    export CLAUDE_CODE_OAUTH_TOKEN="${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
    export DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1
    command=(pnpm --silent dlx "$AUTODEV_CLAUDE_PACKAGE" -p --model claude-sonnet-5 --dangerously-skip-permissions --strict-mcp-config --output-format=stream-json --verbose)
    ;;
  gemini)
    : "${AUTODEV_GEMINI_PACKAGE:?AUTODEV_GEMINI_PACKAGE is required}"
    require_pinned_package AUTODEV_GEMINI_PACKAGE "$AUTODEV_GEMINI_PACKAGE"
    export GEMINI_CLI_TRUST_WORKSPACE=true GEMINI_API_KEY="${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
    command=(pnpm --silent dlx "$AUTODEV_GEMINI_PACKAGE" --approval-mode=yolo --policy="$HOME/.gemini/policies" --output-format=stream-json --skip-trust --prompt "")
    ;;
  mini-max)
    : "${AUTODEV_QWEN_PACKAGE:?AUTODEV_QWEN_PACKAGE is required}"
    require_pinned_package AUTODEV_QWEN_PACKAGE "$AUTODEV_QWEN_PACKAGE"
    command=(pnpm --silent dlx "$AUTODEV_QWEN_PACKAGE" --approval-mode=yolo --auth-type openai --openai-api-key "${OPENAI_API_KEY:?OPENAI_API_KEY is required}" --openai-base-url "${OPENAI_BASE_URL:?OPENAI_BASE_URL is required}" --model=MiniMax-M3 --experimental-lsp --output-format=stream-json --prompt "")
    ;;
  qwen)
    : "${AUTODEV_QWEN_PACKAGE:?AUTODEV_QWEN_PACKAGE is required}"
    require_pinned_package AUTODEV_QWEN_PACKAGE "$AUTODEV_QWEN_PACKAGE"
    command=(pnpm --silent dlx "$AUTODEV_QWEN_PACKAGE" --yolo --debug --experimental-lsp --output-format=stream-json --prompt "")
    ;;
  mini-max-codex)
    : "${AUTODEV_CODEX_PACKAGE:?AUTODEV_CODEX_PACKAGE is required}"
    require_pinned_package AUTODEV_CODEX_PACKAGE "$AUTODEV_CODEX_PACKAGE"
    command=(pnpm --silent dlx "$AUTODEV_CODEX_PACKAGE" exec --profile=minimax --json -)
    ;;
  *)
    echo "Unsupported AutoDev CI provider: $provider" >&2
    exit 2
    ;;
esac

set +e
"${command[@]}" <"$prompt_file" 2>&1 | tee "$runner_temp/agent-stream.jsonl"
provider_status="${PIPESTATUS[0]}"
set -e
exit "$provider_status"
