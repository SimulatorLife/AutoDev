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
    : "${AUTODEV_ROOT:?AUTODEV_ROOT is required}"
    # Codex never talks to api.minimax.io directly. It attaches turn metadata --
    # the workspace path, git remote URLs, the commit hash -- to every provider
    # request and has no setting to omit it, and MiniMax can answer the freeform
    # `exec` tool with JSON arguments Codex aborts. The tracked MiniMax boundary
    # adapter handles both, exactly as it does on a workstation, and Codex runs
    # with the tracked MiniMax profile and model catalog.
    export MINIMAX_API_KEY="${OPENAI_API_KEY:?OPENAI_API_KEY is required}"
    unset OPENAI_API_KEY OPENAI_BASE_URL
    export CODEX_HOME="$runner_temp/codex-home"
    mkdir -p "$CODEX_HOME"
    cp "$AUTODEV_ROOT/scripts/codex/profiles/minimax.config.toml" "$CODEX_HOME/minimax.config.toml"
    cp "$AUTODEV_ROOT/scripts/codex/catalogs/minimax-model-catalog.json" "$CODEX_HOME/minimax-model-catalog.json"
    # The profile's provider base_url is the adapter's fixed loopback port. Never
    # adopt a process already answering there (a leftover from an earlier retry,
    # or anything else): only the adapter this run starts may carry the traffic.
    adapter_url="http://127.0.0.1:18765"
    if curl --silent --fail --max-time 1 "$adapter_url/health" >/dev/null 2>&1; then
      echo "Port 18765 is already serving; refusing to route MiniMax through an adapter this run did not start" >&2
      exit 1
    fi
    MINIMAX_PROXY_HOST=127.0.0.1 MINIMAX_PROXY_PORT=18765 \
      node "$AUTODEV_ROOT/src/providers/minimax.ts" >"$runner_temp/minimax-adapter.log" 2>&1 &
    adapter_pid=$!
    trap 'kill "$adapter_pid" 2>/dev/null || true' EXIT
    for _ in $(seq 1 100); do
      curl --silent --fail --max-time 1 "$adapter_url/health" >/dev/null 2>&1 && break
      sleep 0.1
    done
    curl --silent --fail --max-time 1 "$adapter_url/health" >/dev/null 2>&1 || {
      echo "MiniMax boundary adapter did not become ready" >&2
      cat "$runner_temp/minimax-adapter.log" >&2
      exit 1
    }
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
