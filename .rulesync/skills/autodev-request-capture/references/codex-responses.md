# Codex Responses capture and rollout analysis

This reference covers Codex-specific offline wire capture, privacy checks for Codex turn
metadata, scripted SSE response replay, and `~/.codex/sessions` rollout analysis.

Set these once before running the steps below:

```bash
SKILL_DIR=/path/to/AutoDev/.rulesync/skills/autodev-request-capture
WORK="$(mktemp -d)"
codex --version   # record the version with every finding
```

## 1. Capture the request Codex sends

Use an isolated `CODEX_HOME` so nothing touches `~/.codex`: no sessions, config,
or credentials. The model catalog decides the request shape (tool mode, search,
responses-lite), so capture each path you are changing:

| Path                              | `model`               | `model_catalog_json`                         |
| --------------------------------- | --------------------- | -------------------------------------------- |
| Standalone MiniMax catalog probe  | e.g. `MiniMax-M3`     | `config/catalogs/minimax-model-catalog.json` |
| Router role aliases / Codex route | e.g. `autodev/worker` | `config/catalogs/codex-model-catalog.json`   |

```bash
node "$SKILL_DIR/scripts/responses-recorder.ts" --record "$WORK/requests.jsonl" --port 0 2>"$WORK/recorder.log" &
RECORDER=$!; sleep 1
PORT="$(grep -o '[0-9]*$' "$WORK/recorder.log")"

mkdir -p "$WORK/home" "$WORK/work"
cat > "$WORK/home/config.toml" <<EOF
model = "MiniMax-M3"
model_provider = "capture"
model_reasoning_effort = "high"
model_catalog_json = "/path/to/AutoDev/config/catalogs/minimax-model-catalog.json"
approval_policy = "never"
sandbox_mode = "read-only"

[model_providers.capture]
name = "capture"
base_url = "http://127.0.0.1:${PORT}/v1"
env_key = "CAPTURE_API_KEY"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
EOF

(cd "$WORK/work" && CODEX_HOME="$WORK/home" CAPTURE_API_KEY=dummy \
  perl -e 'alarm shift; exec @ARGV' 90 \
  codex exec --skip-git-repo-check "Reply with the single word ok." </dev/null >"$WORK/codex.out" 2>&1)
kill "$RECORDER"
```

Three details are required, not optional:

- `</dev/null`: otherwise `codex exec` waits on "Reading additional input from
  stdin" until it is killed.
- `perl -e 'alarm shift; exec @ARGV' <seconds>`: macOS has no `timeout`.
- `--skip-git-repo-check`: needed when the work directory is not a git repository.

Inspect `body.tools` and any `additional_tools` input item as `type`/`name` pairs. Never
paste recorded instructions or prompts into docs, commits, or tests.

## 2. Check Codex turn metadata

Codex attaches turn metadata to every provider request in two places: the
`x-codex-turn-metadata` header and `client_metadata["x-codex-turn-metadata"]` in
the body. Inside a git repository that metadata includes the absolute workspace
path, git remote URLs, and the latest commit hash.

Capture from the throwaway repository created in the parent skill (`example.invalid`) without
`--skip-git-repo-check`, then check `$WORK/requests.jsonl`:

```bash
grep -c example.invalid "$WORK/requests.jsonl"
```

## 3. Replay scripted Responses SSE turns

Point Codex at a replay recorder, then inspect the second recorded request. It carries
Codex's own record of the call outcome (`function_call_output`/`custom_tool_call_output`,
`"aborted"`, or an error):

```bash
node "$SKILL_DIR/scripts/responses-recorder.ts" --record "$WORK/replay.jsonl" \
  --turns "$SKILL_DIR/examples/exec-command.turns.json" --port 0 2>"$WORK/recorder.log" &
```

`examples/exec-command.turns.json` reproduces a plain `function_call` to `exec_command`.
Check `$WORK/codex.out` for `ERROR` lines when testing alternate shapes.

## 4. Size patterns in Codex rollouts

Pair findings with local rollouts under `~/.codex/sessions`: `type: "response_item"` records
carry the items, and MiniMax-minted ids look like `<32 hex>_fc_<n>` or `<32 hex>_rs`. Count
by item type and id pattern rather than quoted source strings, and report counts and date
ranges only.
