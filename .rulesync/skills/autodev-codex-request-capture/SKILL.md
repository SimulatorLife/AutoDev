---
name: autodev-codex-request-capture
description: AutoDev-only. See exactly what Codex sends a model provider, and how Codex reacts to a provider's responses, without contacting any real API. Use when changing AutoDev provider adapters, router routes, model catalogs, or privacy boundaries.
---

# Codex request capture (AutoDev development only)

This skill is for working on the AutoDev repository itself. It is exposed only
through AutoDev's repository-scoped skill folders and is never installed at user
level.

Use it before changing anything that sits between Codex and a model provider:
- `scripts/codex-model-router.mjs` routes, header allowlists, payload rewrites;
- provider adapters such as `src/providers/minimax.ts`;
- model catalogs in `scripts/codex/catalogs/`;
- any claim about what leaves the machine.

Documentation and memory describe what Codex *should* send. This procedure shows
what the installed Codex *does* send, and what it does with a reply, for free and
without network access.

The recorder is `scripts/responses-recorder.ts` in this skill directory:
- **capture mode** (no `--turns`): records each request with credentials redacted
  and answers with a controlled error;
- **replay mode** (`--turns <file>`): streams scripted SSE turns, one per request
  with the last one repeating, and records every follow-up.

Set these once. `SKILL_DIR` is this skill's directory; `WORK` is a scratch
directory outside the repository.

```bash
SKILL_DIR=/path/to/AutoDev/.rulesync/skills/autodev-codex-request-capture
WORK="$(mktemp -d)"
codex --version   # record the version with every finding
```

## 1. Capture the request Codex sends

Use an isolated `CODEX_HOME` so nothing touches `~/.codex`: no sessions, config,
or credentials. The model catalog decides the request shape (tool mode, search,
responses-lite), so capture each path you are changing:

| Path | `model` | `model_catalog_json` |
| --- | --- | --- |
| A provider profile talking to its adapter directly | e.g. `MiniMax-M3` | `scripts/codex/catalogs/minimax-model-catalog.json` |
| The router's role aliases | e.g. `autodev/worker` | `scripts/codex/catalogs/codex-model-catalog.json` |

```bash
node "$SKILL_DIR/scripts/responses-recorder.ts" --record "$WORK/requests.jsonl" --port 0 2>"$WORK/recorder.log" &
RECORDER=$!; sleep 1
PORT="$(grep -o '[0-9]*$' "$WORK/recorder.log")"

mkdir -p "$WORK/home" "$WORK/work"
cat > "$WORK/home/config.toml" <<EOF
model = "MiniMax-M3"
model_provider = "capture"
model_reasoning_effort = "high"
model_catalog_json = "/path/to/AutoDev/scripts/codex/catalogs/minimax-model-catalog.json"
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

Inspect structure, not secrets. Print keys, tool types and names, and field
shapes. For example, list the tool tree of `body.tools`, and of any
`additional_tools` input item, as `type`/`name` pairs. Never paste recorded
instructions or prompts into docs, commits, or tests.

## 2. Check what private data a request carries

Codex attaches turn metadata to every provider request, in two places: the
`x-codex-turn-metadata` header and `client_metadata["x-codex-turn-metadata"]` in
the body. Inside a git repository that metadata includes the absolute workspace
path, the git remote URLs (unsanitized, so credentials embedded in a remote URL
travel too; see openai/codex#31588), and the latest commit hash.

To see it, capture from a throwaway repository with a fake remote:

```bash
mkdir -p "$WORK/repo" && cd "$WORK/repo" && git init -q \
  && git remote add origin https://example.invalid/private-owner/private-repo.git \
  && echo x > f && git add f && git -c user.email=a@b -c user.name=probe commit -qm init
```

Run the same `codex exec` from there, without `--skip-git-repo-check`. Then
check for the fake remote in both places:

```bash
grep -c example.invalid "$WORK/requests.jsonl"
```

Any adapter or route that forwards to a remote API must remove this data. Prove
it by running the recorder as the adapter's upstream: for example, set
`MINIMAX_PROXY_UPSTREAM_BASE_URL` to the recorder and point Codex at the adapter.

## 3. Replay a provider's response and watch Codex react

To learn whether Codex accepts a response shape, script it as turns. Point Codex
(or an adapter in front of the recorder) at a replay recorder, then read the
second recorded request. It carries Codex's own record of the call's outcome: a
`function_call_output`/`custom_tool_call_output` with real command output,
`"aborted"`, or an error.

```bash
node "$SKILL_DIR/scripts/responses-recorder.ts" --record "$WORK/replay.jsonl" \
  --turns "$SKILL_DIR/examples/exec-command.turns.json" --port 0 2>"$WORK/recorder.log" &
```

`examples/exec-command.turns.json` reproduces MiniMax-M3's observed answer: a
plain `function_call` to the nested `exec_command` tool. To test another shape,
copy it and change the tool item. For instance, `exec` with JSON arguments, which
Codex aborts as "tool exec invoked with incompatible payload" unless an adapter
coerces it. Also check `$WORK/codex.out` for `ERROR` lines.

## 4. Confirm against the live provider (only when needed)

Only after capture and replay leave a question the provider must answer, such as
whether it accepts a tool type or what it returns for a given body:
- send the smallest possible number of requests;
- use synthetic prompts, never repository content or captured instructions;
- load the key without printing it, for example by parsing `MINIMAX_API_KEY` out
  of `~/.codex/.env` into the command's environment;
- use a captured body shape, replacing only the final user message;
- report status, output item types, and ids, not raw bodies.

Repeat a realistic probe several times before concluding anything. Explicitly
naming a tool in a synthetic prompt produces different behaviour from Codex's
real instructions.

## 5. Size the pattern in real traffic

Pair any finding with the local rollouts under `~/.codex/sessions`: `type:
"response_item"` records carry the items, and MiniMax-minted ids look like
`<32 hex>_fc_<n>` or `<32 hex>_rs`.
- Count by item type and id pattern, not by string matches, which also hit
  quoted source code.
- Report counts and date ranges only.

## 6. Record the result and clean up

- Put the Codex version, capture paths, shapes, and counts in
  `docs/AUTODEV_PLATFORM_MIGRATION.md` or the relevant doc.
- Turn a reproducible shape into a hermetic test, for example in
  `tests/minimax-proxy.test.mjs`.
- Delete `$WORK`, and never commit recorded requests.
