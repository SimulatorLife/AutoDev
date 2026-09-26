---
name: autodev-session-diagnostics
description: AutoDev-only. Diagnose and fix AutoDev issues from live evidence -- Codex session rollouts, router events, provider bridge logs, router status, MCP servers, and running processes. Use when a Codex/AutoDev session or subagent misbehaves (stalls, missing tool calls or thinking in the app, wrong provider, provider errors, MCP or skills not working, wrong agent counts).
---

# AutoDev session diagnostics (AutoDev development only)

Diagnose from what the system recorded, not from what the code or docs *say* it
should do. Find the root cause at its source, then fix and prove it.

Not for inspecting what Codex *would* send a provider offline -- that is the
`autodev-codex-request-capture` skill, which this one hands off to when you need
to reproduce a request shape.

### Things to look for

- Agents have the proper/expected skills, tools, MCPs, prompts, permissions, and other resources available/enabled
- Agents do not have access to resources they should *not* have (e.g. a subagent reading an 'orchestration' skill when it does not and *should not* have agent-spawning tools/permissions)
- Tools and MCP servers have consistent names across all model providers and are exposed in the same/consistent way to the agents
- Orchestrator agents can properly spawn subagents and receive their reports
- Telemetry and logging is complete and consistent/standardized across all agents, subagents, and providers

## 1. Build the evidence report

`$SKILL_DIR` is this skill's directory.

```bash
node "$SKILL_DIR/scripts/session-trace.ts" --recent            # no id given: newest sessions
node "$SKILL_DIR/scripts/session-trace.ts" <id>                # session or thread id
node "$SKILL_DIR/scripts/session-trace.ts" <id> --items        # plus every item, truncated
node "$SKILL_DIR/scripts/session-trace.ts" <id> --events       # plus every router event
```

A Codex App "Session" id is the root thread; a "Thread" id may be a subagent.
Either finds the whole session. Per thread the report gives turn outcomes,
`GAP`s of 60s+ inside a turn, tool calls by name (MCP tools called inside
`exec` counted as `mcp__<server>__<tool>`), `TOOL FAILED` lines, and the
router's requests: per-provider counts, `ROUTER FAILURE`s, and `PROVIDER HOPS`.
Each thread also gets an `investigation` line: what it did before its first
file change (the whole thread if it never edited). It reports tool calls,
tokens, unique files read, repeated reads, searches and repeated searches, and
CocoIndex/CodeGraphContext/LSP calls (`ccc`/`cgc`/`lsp`). These come from
Codex's own `item_completed` records (`FileChange`, `McpToolCall`,
`CommandExecution.parsed_cmd`), not from matching `exec` scripts. `tokens=?`
means no provider reported usage, and `investigation unavailable` means the
rollout has no item records; neither is a zero.
Router matching says `thread` (exact) or `model-window` (older events without a
thread id: same-model threads interleave).

The `live now` section compares the router's live-agent count with the threads
whose turn is still open (a recently written thread may already be finished), lists router/bridge processes with their start times, the
installed runtime files that differ from the checkout (`DRIFT`), and running
provider CLIs and MCP servers. `--offline` skips it; `--json` for scripting.

Read the summary lines, not a hand-filtered event dump: a `grep -v` once hid
every event and looked like "the router logged nothing".

## 2. Evidence map

| Question | Source |
| --- | --- |
| What did the thread contain? | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`: `session_meta` (role, parent, `cli_version`), `turn_context` (model), `response_item`, `event_msg` `task_complete.error` |
| Which provider served each request? | `$CODEX_HOME/run/codex-model-router.launchd.err.log` (`autodev-router-event-v1`, with `thread`) |
| What did a bridge do? | `$CODEX_HOME/hooks/<bridge>.launchd.log` (no timestamps: correlate by order and router times) |
| Health, cooldowns, agent counts, MCP usage now | `curl -s 127.0.0.1:4100/status \| jq` -- `providers.<name>`, `agents` (`canonicalLiveCount`, `byState`, `liveByRole`), `usage.byWorkspace.<ws>.byMcp`, `spawnFailures`. Bridges: `curl 127.0.0.1:{4000,4002,4003,18765}/health`. (`autodev router status` is not wired up.) |
| Does an MCP server work? | `node "$SKILL_DIR/scripts/mcp-probe.ts" <server> --cwd <repo> --call <tool> '<json>'` starts it exactly as Codex does (installed launcher, minimal env) and prints its stderr if it dies |
| Codex's own view of a turn | `sqlite3 $CODEX_HOME/logs_2.sqlite "select ... from logs where thread_id='<id>'"` |
| Did work happen despite an empty thread? | the thread's `cwd`: `git status`, mtimes vs the timeline; running CLIs |
| Did a skill get read? | `$CODEX_HOME/run/skill-read-telemetry/<thread>.json`; `exec` inputs reading `SKILL.md` |

## 3. Diagnose

1. **Name the threads**: role, parent, model (`autodev/<role>`). The provider is
   chosen per request; read it from the router summary.
2. **Read each failing thread**: gaps, reasoning-only responses, aborted turns,
   `TOOL FAILED`, `ROUTER FAILURE`, `PROVIDER HOPS`.
3. **Check the provider side**: bridge log, live CLIs outliving their request,
   workspace changes the thread never recorded.
4. **Check what is deployed** before blaming (or crediting) code: router and
   bridges run *installed copies* under `$CODEX_HOME/src` and only pick up a
   change after reinstall and restart (see `DRIFT` and service start times);
   the MCP launcher resolves into the checkout and applies on the next server
   start.
5. **Size it**: scan `sessions/` for the error string or item pattern (counts and
   date range) to tell a one-off from a systemic bug.
6. **Trace to code** in `src/router/`, `src/providers/<bridge>.ts`, or
   `src/mcp/`, and fix it there, not downstream.

## 4. Reproduce, fix, verify

- **Hermetic first:** drive the real bridge or router with a fake CLI or fake
  upstream (`tests/claude-codex-tool-loop.test.ts`, `tests/router/proxy.test.ts`).
- **Prove the test catches the bug:** disable the fix (revert it or neuter one
  line), confirm the new test fails with the observed symptom, restore.
- **Request shapes:** `autodev-codex-request-capture`; replay a spawn to see a
  subagent's own requests.
- **Live, without touching the running system:** a second bridge from the
  checkout on a spare port (e.g. `CLAUDE_BRIDGE_PORT=4019 node
  src/providers/claude.ts`, OAuth token read inline from the Keychain, never
  printed), an isolated `CODEX_HOME` pointing at it, and `codex exec --json`
  from a throwaway `git init` repo with `</dev/null`; then run this skill's
  script with `--codex-home`. Kill what you started.
- **Intermittent failures:** repeat the full suite several times, keeping each
  run's full output, so the failing assertion is captured the first time.
- Run the full suite and typecheck, update docs, and report what was verified
  live, what only in tests, and what needs a reinstall to take effect.

## Gotchas (all observed)

- **An empty thread is not an idle agent.** A provider that runs tools inside
  its own CLI records nothing in Codex; check `git status` and running processes.
- **Codex records an item only when it is finished**; an interrupted response
  leaves no trace, however long it ran.
- **The user's belief about the provider is a hypothesis.** One worker turn went
  Antigravity → MiniMax → Claude across its requests.
- **Codex appends its own messages after a tool output** (`<subagent_notification>`,
  steers, `<turn_aborted>`).
- **A subagent shares its root's session id but has its own thread id**
  (`thread-id` header, `client_metadata.thread_id`). One agent is one thread: a
  live count far above the writing threads means something keys by request; a
  live count below them, or an orchestrator carrying a child's role, means
  something applies a child's reports to the shared session key.
- **In Codex code mode MCP tools are `mcp__<server>__<tool>`**; searching
  `ALL_TOOLS` for a bare `lsp_` finds nothing and reads as "LSP unavailable".
- **`Transport closed` means the MCP server process died**; the probe shows why
  (it was `typescript-language-server` missing from Codex's `PATH`).
- **`toolCalls=0` on a long successful bridge request** means the provider
  worked invisibly, or not at all.
- **Item id prefixes identify the minter**: `rs_`/`ctc_`/`fc_`/`msg_` Codex-shaped;
  `<32 hex>_rs`, `<32 hex>_fc_<n>` MiniMax.
- **Live CLIs surface bugs fakes hide** (the Claude CLI truncates long MCP tool
  descriptions).
- **Clean up after your own probes**: a server killed through its shell wrapper
  left its language server orphaned; the bundled probe kills the whole group.
- **Never restart launchd services or run the installer without asking**: it
  interrupts every in-flight session.
- **Never print tokens or paste prompts**; quote ids, counts, and timestamps.
