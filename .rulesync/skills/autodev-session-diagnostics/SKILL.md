---
name: autodev-session-diagnostics
description: AutoDev-only. Diagnose and fix AutoDev issues from live evidence -- Codex session rollouts, router events, provider bridge logs, router status, and running processes. Use when a Codex/AutoDev session or subagent misbehaves (stalls, missing tool calls or thinking in the app, wrong provider, provider errors, MCP or skills not working).
---

# AutoDev session diagnostics (AutoDev development only)

Diagnose from what the system recorded, not from what the code or docs say it
should do. Find the root cause at its source, then fix and prove it.

Not for inspecting what Codex *would* send a provider offline -- that is the
`autodev-codex-request-capture` skill, which this one hands off to when you need
to reproduce a request shape.

## 1. Build the evidence report

Run the bundled script with the session **or** thread id the user gave you (a
Codex App "Session" id is the root thread; a "Thread" id may be a subagent):

```bash
node "$SKILL_DIR/scripts/session-trace.ts" <id>            # summary
node "$SKILL_DIR/scripts/session-trace.ts" <id> --items    # plus every item, truncated
```

`$SKILL_DIR` is this skill's directory. It finds every thread in the session,
their turns (completed / failed / `aborted:<reason>`), silent gaps of 60s or
more inside a turn, the router's events for each thread's model and window,
log freshness, and any provider CLI or shim still running. `--json` gives the
same data for scripting; `--codex-home` points it at an isolated home.

## 2. Evidence map

| Question | Source |
| --- | --- |
| What did the thread actually contain? | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`: `session_meta` (role, nickname, parent), `turn_context` (model), `response_item` (items), `event_msg` `task_complete.error` (verbatim upstream error) |
| Which provider served each request, how long, how it ended? | `$CODEX_HOME/run/codex-model-router.launchd.err.log`, `autodev-router-event-v1` lines: `selected` / `result` / `transport_error` / `subagent_spawn` / `spawn_failed`, with `provider`, `status`, `failureClass`, `elapsedMs`, `toolCalls` |
| What did a bridge do? | `$CODEX_HOME/hooks/<bridge>.launchd.log` (no timestamps: correlate by order, mtime, and router times) |
| Provider health, cooldowns, MCP/skill usage now | `curl -s 127.0.0.1:4100/status \| jq` -- `providers.<name>` (cooldowns, failure streaks), `usage.byWorkspace.<ws>.byMcp` and `.mcpExposed`, `subagents`, `spawnFailures`. Bridges: `curl 127.0.0.1:{4000,4002,4003,18765}/health`. (`autodev router status` is not wired up; use the endpoint.) |
| Codex's own view of a turn | `sqlite3 $CODEX_HOME/logs_2.sqlite "select ... from logs where thread_id='<id>'"` |
| Did work happen despite an empty thread? | the thread's `cwd`: `git status`, file mtimes vs the rollout timeline; `ps` for live CLIs |
| Did a skill get read? | `$CODEX_HOME/run/skill-read-telemetry/<thread>.json`; `exec` inputs reading `SKILL.md` |
| Does an MCP server work? | `exec` inputs calling `tools.mcp__<server>__*` and their outputs in the rollout; `/status` `byMcp` counts; the role's `agents/roles/<role>.toml` enables it |

## 3. Diagnose

1. **Name the threads.** Map each id to its role, nickname, parent, and model
   (`autodev/<role>`). The provider is chosen per request, so never assume it:
   read it from the router events.
2. **Read the timeline.** For the failing thread, line up items, gaps, and
   turn outcomes against the router events in the same window. Most failures
   show up as one of: a long gap with no items, a response with only a
   reasoning item, an `aborted` turn, a `result` with `failure`, or providers
   changing between requests of one turn.
3. **Check the provider side.** Bridge log lines for the request, live CLI
   processes (orphans outliving their request), and workspace changes the
   thread never recorded.
4. **Size it** before fixing: scan the whole `sessions/` tree (count by item
   type or error string, report counts and date range) to tell a one-off from
   a systemic bug.
5. **Trace to code.** Follow the failing hop into `src/router/` or
   `src/providers/<bridge>.ts` and find where the recorded behaviour is
   produced. Fix it there, not downstream.

## 4. Reproduce, fix, verify

- **Hermetic first:** drive the real bridge or router with a fake CLI or fake
  upstream in a test (see `tests/claude-codex-tool-loop.test.ts`,
  `tests/router/proxy.test.ts`).
- **Request shapes:** capture them offline with `autodev-codex-request-capture`.
- **Live, without touching the running system:** start a second bridge from
  the checkout on a spare port (e.g. `CLAUDE_BRIDGE_PORT=4019 node
  src/providers/claude.ts`, OAuth token read inline from the Keychain, never
  printed), point an isolated `CODEX_HOME` at it, and run `codex exec --json`
  from a throwaway `git init` repo with `</dev/null`. Then run this skill's
  script with `--codex-home` on that home. Kill the side bridge afterwards.
- Run the full suite and typecheck, update docs, and report what was verified
  live versus only in tests.

## Gotchas (all observed)

- **An empty thread is not an idle agent.** A provider that runs tools inside
  its own CLI records nothing in Codex; check `git status` and running
  processes before concluding "nothing happened".
- **Codex records an item only when it is finished.** A response interrupted
  mid-stream leaves no trace in the rollout, however long it ran.
- **The user's belief about the provider is a hypothesis.** One worker turn
  went Antigravity → MiniMax → Claude across its requests.
- **Codex appends its own messages after a tool output** (`<subagent_notification>`,
  steers, `<turn_aborted>`): the outputs are not always the last input items.
- **`toolCalls=0` on a long successful bridge request** means the provider did
  its work invisibly, or did none.
- **Item id prefixes identify the minter**: `rs_`/`ctc_`/`fc_`/`msg_` from
  Codex-shaped providers; `<32 hex>_rs` and `<32 hex>_fc_<n>` from MiniMax.
- **Live CLIs surface bugs fakes hide**: the Claude CLI truncates long MCP tool
  descriptions, for example.
- **Never restart launchd services or run the installer without asking**: it
  interrupts every in-flight session. Use a side-port instance instead.
- **Never print tokens or paste prompts**; the script truncates excerpts, and
  reports should quote ids, counts, and timestamps.
