---
name: autodev-request-capture
description: AutoDev-only. Capture and replay offline provider, ACP, OpenCLI, and router wire requests without contacting any real API. Use when changing AutoDev ACP profiles, provider transports, router routes, model catalogs, or privacy boundaries.
---

# AutoDev request capture (AutoDev development only)

This skill is for working on the AutoDev repository itself. It is exposed only
through AutoDev's repository-scoped skill folders and is never installed at user
level.

Use it before changing anything that sits between AutoDev, an ACP or OpenCLI
executor, and a model provider:

- `runtime/src/router/` and `runtime/src/xacpx/` routes, session pinning, header allowlists, and payload boundaries;
- ACP profiles and provider transports in `runtime/src/acp/provider-profiles.ts` and `runtime/src/providers/opencli-turn.ts`;
- model catalogs in `config/catalogs/`;
- any claim about what credentials, workspace paths, or remote URLs leave the machine.

For provider-specific Codex wire capture (`codex exec`, `CODEX_HOME`, `x-codex-turn-metadata`,
`examples/exec-command.turns.json`, and `~/.codex/sessions` rollout analysis), see
[references/codex-responses.md](references/codex-responses.md).

## Capture and replay tool

The local HTTP recorder is `scripts/responses-recorder.ts` in this skill directory:

- **capture mode** (no `--turns`): records each request with credential headers redacted
  (`authorization`, `x-api-key`, `api_key`, `cookie`, `x-access-token`) to JSONL and answers
  with a controlled `400` error (`capture_only`);
- **replay mode** (`--turns <file>`): streams scripted SSE turns, one per request with the last
  turn repeating, and records every follow-up request.

Set these once. `SKILL_DIR` is this skill's directory; `WORK` is a scratch directory outside
the repository:

```bash
SKILL_DIR=/path/to/AutoDev/.rulesync/skills/autodev-request-capture
WORK="$(mktemp -d)"
```

## 1. Capture offline traffic

Start the loopback recorder on an ephemeral port and point the target runtime endpoint,
provider transport, or CLI at `http://127.0.0.1:${PORT}/v1`:

```bash
node "$SKILL_DIR/scripts/responses-recorder.ts" --record "$WORK/requests.jsonl" --port 0 2>"$WORK/recorder.log" &
RECORDER=$!; sleep 1
PORT="$(grep -o '[0-9]*$' "$WORK/recorder.log")"
# Run the isolated CLI/transport against http://127.0.0.1:${PORT}/v1, then stop RECORDER.
kill "$RECORDER"
```

Inspect structure, not secrets: print keys, tool types and names, and field shapes. Never
paste recorded instructions, tokens, or raw prompts into docs, commits, or tests.

## 2. Verify privacy and credential redaction

To test whether a provider CLI or transport leaks local repository metadata or git remote URLs,
run the capture from a throwaway git repository with a fake remote URL:

```bash
mkdir -p "$WORK/repo" && cd "$WORK/repo" && git init -q \
  && git remote add origin https://example.invalid/private-owner/private-repo.git \
  && echo x > f && git add f && git -c user.email=a@b -c user.name=probe commit -qm init
```

Verify neither credentials nor private remote URLs reach upstream:

```bash
grep -c example.invalid "$WORK/requests.jsonl"
```

## 3. Replay scripted responses and test hermetically

Use `--turns <file>` with scripted response events to test how a client or transport reacts
without external network calls, and convert any reproducible failure into a hermetic test in
`runtime/tests/xacpx-acp-architecture.test.ts`, `tests/providers/opencli.test.ts`, or
`tests/router/http.test.ts`.

## 4. Provider-specific references

- **Codex Responses & rollouts:** [references/codex-responses.md](references/codex-responses.md)

## 5. Record the result and clean up

- Put provider/runtime versions, capture paths, shapes, and counts in the doc that owns the
  path, such as `docs/provider-routing.md`.
- Keep regression coverage in hermetic unit tests (such as `tests/autodev-request-capture-skill.test.ts`).
- Delete `$WORK`, and never commit recorded requests.
