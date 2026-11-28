# Codex-specific and historical diagnostics

Read this only for Codex-specific probes or historical rollout/router/bridge records. These details describe the recorded architecture and observed behavior of the relevant versions, not the current provider-neutral execution or delegation contract. Confirm that a path, command, probe, or metric exists before using it. The current architecture owner is `docs/autodev-console-target-state.md`; delegation is defined in `docs/xacpx-subagent-delegation.md`. Do not infer current tool availability or lifecycle from historical Codex records. `$SKILL_DIR` is the parent skill directory.

## 1. Build the evidence report

`$SKILL_DIR` is this skill's directory.

Every diagnostics answer comes from **one** engine: AutoDev's diagnostics
engine (`@simulatorlife/autodev-data/diagnostics`), which reads the Codex
rollouts, the router's rotated logs, the bridge logs and the hook log. The
Control API (`GET /control/diagnostics/*`), the `pnpm autodev -- diagnostics`
CLI, this script and the Console's `/usage?sessionId=<id>` view are four
faces of that one engine -- there is no second parser to keep in sync.

```bash
node "$SKILL_DIR/scripts/session-trace.ts" --recent            # no id given: newest sessions (active + archived)
node "$SKILL_DIR/scripts/session-trace.ts" --scan-recent [N]   # cross-session fleet efficiency & failure/skip scan
node "$SKILL_DIR/scripts/session-trace.ts" --hooks [--since D] # PreToolUse denial summary from hooks.log (default 7d)
node "$SKILL_DIR/scripts/session-trace.ts" <id>                # session or thread id
node "$SKILL_DIR/scripts/session-trace.ts" <id> --failures     # include paired call input on TOOL FAILED lines (2/category cap)
node "$SKILL_DIR/scripts/session-trace.ts" <id> --all-failures # list every failure without the per-category cap
node "$SKILL_DIR/scripts/session-trace.ts" <id> --efficiency   # per-thread tokens/cache/compaction/skills + router state & MCP exposure
node "$SKILL_DIR/scripts/session-trace.ts" <id> --items        # plus every item, truncated
node "$SKILL_DIR/scripts/session-trace.ts" <id> --events       # plus every router event
```

The same commands exist on the Runtime CLI, which needs no skill:

```bash
pnpm autodev -- diagnostics <id> --efficiency --failures
pnpm autodev -- diagnostics --recent 10
pnpm autodev -- diagnostics --scan-recent 15
pnpm autodev -- diagnostics --hooks --since 7
```

This script asks the Control API (`http://127.0.0.1:4101/control/diagnostics/…`,
read-only, `Authorization: Bearer <token>` + `X-AutoDev-Actor: autodev-local`)
so it sees the live router state; with `--offline`, `--codex-home` or
`--router-log` -- or when the API is not running -- it runs the same engine
through the CLI in the checkout. `--control-api-url URL` points it at another
Control API.

A Codex App "Session" id is the root thread; a "Thread" id may be a subagent.
Either finds the whole session. To compare investigation metrics across tool-surface changes, save two `--json` reports, then run `node "$SKILL_DIR/scripts/investigation-compare.ts" before.json after.json`. Inputs must be the JSON object emitted by `session-trace --json`, with a top-level `threads` array; every array entry must be an object with an `investigation` object containing boolean `observed`. Metric fields (`toolCalls`, `tokens`, `filesRead`, `repeatedReads`, `searches`, `repeatedSearches`, and `context.ccc`/`cgc`/`lsp`) may be omitted; present counts must be finite numbers, and `tokens` may also be null. The report gives per-period totals/means, metric-specific observed/missing counts, separate unavailable-thread counts, and after-minus-before deltas. It is descriptive only and does not establish causation. Each thread gets turn outcomes, `GAP`s of 60s+ inside a turn, tool calls by name (MCP tools called inside `exec` counted as `mcp__<server>__<tool>`), grouped `TOOL FAILURES` + `TOOL FAILED` lines (capped at 2 samples per failure category unless `--all-failures` is passed so noisy repeated errors do not truncate the report), and the router's requests: per-provider counts, `ROUTER SKIPPED` (`probe_unavailable`, `quota_exhausted`, etc.), `ROUTER RETRIES` (`retries`, `transport_errors`, `exhaustion_waits`), `ROUTER FAILURE`s, `PROVIDER HOPS`, and the `upstream models` that served the thread (provider model ids, not the `autodev/<role>` alias Codex requested). With `--efficiency` (and always in `--json`), each thread also reports cumulative `token_count` usage (`cached` %, `reasoning` %, peak input, >50% cache drops), compaction count & max `replacement_history` items/bytes/images, and initial developer-prompt bytes + loaded skills grouped by source root alongside observed `SKILL.md` reads.
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

| Question                                       | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What does the session look like overall?       | `GET /control/diagnostics/sessions/<id>` on the Control API (`:4101`, read-only, contract v35), `pnpm autodev -- diagnostics <id>`, or the Console's `/usage?sessionId=<id>` -- all three run the same engine                                                                                                                                                                                                                                                                                                                                           |
| What did the thread contain?                   | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`, or `$CODEX_HOME/archived_sessions/` once the Codex app has archived it: `session_meta` (role, parent, `cli_version`), `turn_context` (model), `response_item`, `event_msg` `task_complete.error`                                                                                                                                                                                                                                                                                            |
| Which provider served each request?            | `$CODEX_HOME/run/codex-model-router.launchd.err.log` (`autodev-router-event-v1`, with `thread`), **and its rotated `.err.log.1`, `.err.log.2`, ...** -- launchd empties the live file and moves the events aside                                                                                                                                                                                                                                                                                                                                        |
| What did a bridge do?                          | `$CODEX_HOME/hooks/<bridge>.launchd.log` (no timestamps: correlate by order and router times; check `opencli-proxy.launchd.log` for `earlier message(s) left out` and `minimax-proxy.launchd.log` for startup errors)                                                                                                                                                                                                                                                                                                                                   |
| Health, cooldowns, agent counts, MCP usage now | `pnpm autodev -- router status` (or `curl -s 127.0.0.1:4100/status \| jq`) -- `providers.<name>`, `agents` (`canonicalLiveCount`, `byState`, `liveByRole`), `usage.byWorkspace.<ws>` (`skillUses`, `bySkill`), `spawnFailures`. MCP calls: `GET /control/mcp-runtime` (the shared MCP gateway's ledger, `$CODEX_HOME/mcp-gateway/observations.json`). Bridges: `curl 127.0.0.1:{4000,4002,4003,18765}/health`. Retry `/status` once if `session-trace.ts` hits a router restart window (`router /status unreachable`).                                                                                                                                |
| Persisted router state vs live `/status`       | `$CODEX_HOME/codex-router-state.json` (`disabledProviders`, `providerCooldowns`, `roleAssignments.*.model: null` falling back to `config/model-routing.json`)                                                                                                                                                                                                                                                                                                                                                                                           |
| Does an MCP server work?                       | `node "$SKILL_DIR/scripts/mcp-probe.ts" <server> --cwd <repo> --call <tool> '<json>'` starts it exactly as Codex does (installed launcher, minimal env) and prints its stderr if it dies. `<server>` must be a canonical AutoDev name -- `lsp`, `playwright`, `cocoindex-code`, `codegraphcontext` (`runtime/src/mcp/launcher.ts`); anything else exits 2 with `unsupported AutoDev MCP`. A binary's package name is often not its server name: the LSP server is `lsp-mcp-server` on disk and on disk's `PATH`, but `lsp` everywhere AutoDev names it. |
| Codex's own view of a turn                     | `sqlite3 $CODEX_HOME/logs_2.sqlite "select ... from logs where thread_id='<id>'"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Did work happen despite an empty thread?       | the thread's `cwd`: `git status`, mtimes vs the timeline; running CLIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Did Codex load the command rules?              | `node "$SKILL_DIR/scripts/rule-loading-probe.ts" --codex "$(command -v codex)"` — a real Codex run against an isolated `CODEX_HOME`; `ls -l "$CODEX_HOME/rules/default.rules"` must show a regular file, and `bash scripts/install.sh --check` reports a symlink or stale copy as drift                                                                                                                                                                                                                                                                 |
| Can this session write to `.git`?              | `node "$SKILL_DIR/scripts/git-write-access-probe.ts" --codex "$(command -v codex)"` — the same real-Codex harness against a throwaway Git repository, staging one file through each command form and reporting which forms keep the write access                                                                                                                                                                                                                                                                                                        |
| What `PreToolUse` hooks blocked?               | `$CODEX_HOME/hooks/hooks.log` (`event="PreToolUse"`, `decision="deny"`, `policy`, `role`, `reason`, `commandHead`); summarize via `node "$SKILL_DIR/scripts/session-trace.ts" --hooks --since 7`, or scan historical rollouts via `--scan-recent [N]`                                                                                                                                                                                                                                                                                                   |
| Did a skill get read?                          | Rollout tool inputs reading `SKILL.md` give exact skill names; the live Runtime counts hook-observed reads per workspace in `/status` `usage.byWorkspace[*].skillUses`                                                                                                                                                                                                                                                                                                                                     |

## 3. Historical diagnosis procedure

1. **Name the threads**: role, parent, model (`autodev/<role>`). Run `node "$SKILL_DIR/scripts/session-trace.ts" <id>` summary first before `--items` or `--events` so large rollouts do not truncate output into manual JSONL grep/script passes. Historical sessions may contain per-request routing; current sessions are pinned. Use the recorded identity for the applicable architecture.
2. **Read each failing thread**: gaps, reasoning-only responses, aborted turns,
   `TOOL FAILED`, `ROUTER FAILURE`, `PROVIDER HOPS`.
3. **Check the provider side**: bridge log, live CLIs outliving their request,
   workspace changes the thread never recorded.
4. **Check what is deployed** before blaming (or crediting) code: router and
   bridges run _installed copies_ under `$CODEX_HOME/src` and only pick up a
   change after reinstall and restart (see `DRIFT` and service start times);
   the MCP launcher resolves into the checkout and applies on the next server
   start.
5. **Size it**: run `node "$SKILL_DIR/scripts/session-trace.ts" --scan-recent 15` and `--hooks --since 7`, or scan `sessions/` + `archived_sessions/` for the error string or item pattern, to tell a one-off from a systemic bug.
6. **Trace to code** in `src/router/`, `src/providers/<bridge>.ts`, or
   `runtime/src/mcp/`, and fix it there, not downstream.

## 4. Historical reproduction and probes

- **Hermetic first:** drive the real ACP executor or router with a fake CLI or fake
  upstream (`runtime/tests/xacpx-acp-architecture.test.ts`, `tests/router/http.test.ts`). When running router/proxy unit tests directly with `node --test`, include `--import ./runtime/tests/support/isolate-autodev-state.ts` (matching `package.json`'s `test:root`) so tests do not read live `$CODEX_HOME/codex-router-state.json` cooldowns.
- **Model catalog changes:** keep `config/model-routing.json`, `config/catalogs/*-model-catalog.json`, `config/catalogs/codex-model-catalog.json`, and `data/src/openlit/sync-model-catalogue.ts` in sync (`data/tests/openlit/price-catalogue.test.ts`, `tests/providers/opencli.test.ts`).
- **Prove the test catches the bug:** disable the fix (revert it or neuter one
  line), confirm the new test fails with the observed symptom, restore.
- **Request shapes:** `autodev-request-capture`; replay a spawn to see a
  subagent's own requests.
- **Live, without touching the running system:** run a second `opencli` server or
  router instance from the checkout on a spare port (e.g. `node runtime/src/providers/opencli.ts`
  or `/v1/acp/sessions`), an isolated `CODEX_HOME` pointing at it, and `codex exec --json`
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
- **Historical Codex-native delegation:** old sessions may contain native spawn calls and capacity failures. These are historical observations, not the current xacpx delegation interface.

- **Item id prefixes identify the minter**: `rs_`/`ctc_`/`fc_`/`msg_` Codex-shaped;
  `<32 hex>_rs`, `<32 hex>_fc_<n>` MiniMax.
- **Live CLIs surface bugs fakes hide** (the Claude CLI truncates long MCP tool
  descriptions).
- **Clean up after your own probes**: a server killed through its shell wrapper
  left its language server orphaned; the bundled probe kills the whole group.
- **`playwright` is disabled at user level on purpose.** `.rulesync/mcp.jsonc`
  ships it `disabled: true` and only `agents/roles/browser-tester.toml` and
  `agents/roles/smart.toml` set `enabled = true`, because a role block would
  otherwise inherit the user-level `false`. So no `playwright` server in
  `/control/mcp-runtime` is the expected steady state, not a telemetry
  gap, and probing `playwright` directly bypasses that gating -- a working probe
  there proves only that a browser can start, not that any role can use it.
- **A second `playwright` probe fails on a shared browser profile, by design.**
  `playwright-mcp` launches headed Chrome against one persistent profile
  (`~/Library/Caches/ms-playwright-mcp/mcp-chrome-<hash>`), so a second
  instance gets `Browser is already in use for <dir>, use --isolated`. The
  pinned `node_modules/.bin/playwright-mcp` (0.0.80) fails this _silently_ --
  tools list, then no reply, no stderr -- while 0.0.83 names the cause. Read
  that silence as "old version plus an already-held profile", never as a healthy
  server, and never as proof the server is broken.
- **A CocoIndex `paths` filter that matches nothing returns `success: true` with
  an empty list and no warning**, so "not indexed" is the wrong reading. Its
  `**` requires at least one intermediate directory: `runtime/src/mcp/**\/*.ts`
  returns 0 results even though that directory holds indexed files, while
  `runtime/src/mcp/*` and `runtime/src/mcp/**\/*/**\/*.ts` both return them.
  Confirm with one unfiltered query before concluding a path is unindexed.
- **`codegraphcontext`'s `get_repository_stats` reports `0` functions and classes
  for a fully indexed repo** (verified 2026-10-05: the graph held 9,505
  `Function` and 262 `Class` nodes; the tool returned `functions: 0,
classes: 0` with `success: true`). It counts through
  `MATCH (r:Repository)-[:CONTAINS*]->(:Function|:Class)`, but the indexer emits
  `CONTAINS` from `File` to `Function` exactly once across the whole graph and
  never from `File` to `Class`; functions hang off files via `CALLS` and
  `HEURISTIC_CALLS` instead. Trust its `files`/`modules`, and get real counts
  from `MATCH (n) RETURN labels(n), count(*)`. Upstream bug, not AutoDev's
  (pipx 0.6.13, already current), so report it rather than patching site-packages.
- **The router's event log rotates, and the live file is the empty one.** launchd
  caps `codex-model-router.launchd.err.log` and moves its contents to
  `.err.log.1`; the live file is then 0 bytes. Reading only the live file
  reports "the router saw 0 requests; no results" for a session the router
  actually served -- and it reads as "the request never reached the router",
  which sends the investigation after the wrong system. Read the live file and
  every `.err.log.N` beside it.
- **An archived session's rollout is not under `sessions/`.** The Codex app
  moves a rollout to `$CODEX_HOME/archived_sessions/` when a session is
  archived, so a search of `sessions/` alone reports "no rollout found for that
  id" for a session the user has finished with. Read both roots.
- **`0 of N file input(s) on the page accept this file` is ChatGPT's upload
  allowance, not a broken page.** An account gets a fixed number of uploads in
  a rolling window (80 in three hours, observed 2026-11-11); once spent, the
  page keeps its file inputs and none takes a file. Count `opencli-chatgpt`
  successes per hour in the router events before the first failure: a run
  that ends at the allowance is this. The bridge types prompts up to 32 KB
  and reports the rest as `UPLOADS_EXHAUSTED` (a `throttled` limit), so a
  session that still dies of it is uploading more than it should.
- **Codex loads a rules entry only when it resolves to a file directly inside
  `$CODEX_HOME/rules/`**, so a symlink that points anywhere else — the repository
  checkout, another file in `$CODEX_HOME`, a subdirectory of `rules/` — is skipped
  silently and every rule in that file turns inert: an `allow` rule stops
  lifting the workspace-write sandbox (`git add` fails with `.git/index.lock:`
  `Operation not permitted`) and a `forbidden` rule stops blocking (`git stash`
  runs). `codex execpolicy check` cannot see it: it resolves the path itself and
  reports the decision the skipped file would have produced. Check
  `ls -l "$CODEX_HOME/rules/default.rules"` (a regular file) or
  `bash scripts/install.sh --check` (drift on `rule file default.rules`), and
  reproduce it with `node "$SKILL_DIR/scripts/rule-loading-probe.ts"`. Verified
  2026-11-17 against `codex-cli 0.154.0` and `0.169.0-alpha.11.1`; the write-up is
  in `docs/local-setup.md` ("Codex command rules").
- **"`.git` is read-only for this session" is usually a wrong diagnosis.** The
  write access is granted per command, not per session, and it is real: a
  standalone `git add <path>` writes the index. What loses it is the _shape_ of
  the command. Codex judges a chain as a whole, so a chain is only allowed when
  every part of it matches a rule; a shell construct (`cd ... &&`, `2>&1`, `|`,
  a `for` loop) breaks the chain even around an allowed command. Verified
  2026-11-21 against `codex-cli 0.171.0-alpha.13`: `git add f && git status`
  failed with `.git/index.lock: Operation not permitted` while `git add f` on
  its own staged the file. The rules now allow the read-only inspection
  commands, so that chain works; `cd ... &&`, a pipe, a redirection and a
  shell loop still do not.
- **`touch .git/<file>` is not a probe of the write access.** It matches no
  rule, so it is sandboxed by design and always fails with `Operation not
permitted` — including in a session that stages successfully. A session that
  probed that way and concluded it could not commit had never tried a real
  `git add`. The one signal that tells a sandboxed command from an unsandboxed
  one is the noise the login shell makes when it is sandboxed (on this
  machine, `/Users/<user>/.rvm/scripts/rvm: line 15: /bin/ps: Operation not
permitted`): its absence means the command ran outside the sandbox.
- **An explicit `shell` on `exec_command` can cost the write access.**
  Codex resolves the shell by _name_ through `PATH`, ignoring the directory in
  the path you give it, and on an Apple Silicon machine `bash` is often a
  Homebrew x86_64 build that runs translated; macOS keeps the sandbox on a
  translated shell, so an allowed command still cannot write `.git`. Verified
  2026-11-21: `shell: "/bin/bash"` (which resolved to the x86_64 Homebrew
  bash) could not stage, while the default shell, `/bin/zsh`, `/bin/sh` and
  the system arm64 `/bin/bash` could. Use the default shell.
- **Three mechanisms make `.git` writable, and they are not
  interchangeable.** Measured 2026-11-21 with `codex-cli 0.171.0-alpha.13`
  (`git-write-access-probe.ts --writable-root` / `--permission-profile` /
  `--no-sandbox-mode`): the sandbox alone writes nothing; an execpolicy
  `allow` rule lets _that one command_ out of the sandbox; a sandbox
  `writable_roots` entry makes the whole directory writable for every command
  (and a **file** path as a writable root has no effect, so
  `writable_roots = ["<repo>/.git/index"]` grants nothing while
  `["<repo>/.git"]` grants everything, `git config` included); a Codex
  **permission profile** is path-scoped _with specificity_, so
  `".git/**" = "write"` plus `".git/config" = "read"` lets every command stage
  while `.git/config` stays read-only. A selected profile also **overrides**
  `sandbox_mode`, which is why AutoDev does not let Rulesync generate it: one
  global profile flattens the per-role tiers. When a profile is supplied to a
  probe, its top-level keys must come **before** any table header or Codex
  never selects it ("config defines `[permissions]` profiles but does not set
  `default_permissions`").
- **Zero `ROUTER FAILURE`s does not mean Priority-1 stayed selected.** A single `ROUTER SKIPPED` event (`probe_unavailable`, `quota_exhausted`, `session_limit`, etc.) can pin a long session onto a fallback provider with zero failed requests; always check `ROUTER SKIPPED` and `ROUTER RETRIES` in `session-trace.ts`.
- **Never restart launchd services or run the installer without asking**: it
  interrupts every in-flight session.
- **Never print tokens or paste prompts**; quote ids, counts, and timestamps.
