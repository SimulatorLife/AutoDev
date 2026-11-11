# Orchestration runtime contract

Use this reference when creating, waiting for, recovering, resuming, or closing
delegated agents.

## Delegation path

Use the configured role-based `spawn_subagent` surface. Native code-mode
providers use `exec` with `tools.multi_agent_v1__spawn_agent` and
`{ agent_type, message }`.

Do not substitute `create_thread`, `fork_thread`, `handoff_thread`, or
provider-private task APIs for the configured child path.

Batch independent spawns in one call when supported. Use isolated results such
as `Promise.allSettled` so one rejected child does not hide successful siblings.
Spawning is fire-and-forget when supported; children continue after the spawn
call returns. Wait when a child result is needed, but do not poll merely to keep
children alive.

## Ownership

Manage only children created by this parent or recovered from this parent's
verified spawn history.

Do not use filesystem state, global thread/task listings, telemetry, UI state,
or another parent's output as ownership proof. Other orchestrators and their
children are peers.

## Concurrency and child lifecycle

Respect configured concurrency. Serialize when capacity is unavailable or
uncertain rather than spawning beyond the limit.

Terminal states are `completed`, `errored`, `interrupted`, `shutdown`, and
explicit provider-incomplete terminal states. A terminal child still owns a
handle until explicitly closed where the runtime requires it.

### Wait timeouts and running children

A wait timeout (such as the default 30-second wait in recovery or polling)
never implies child failure, a crash, or an abandoned task, and NEVER justifies
terminating the child or spawning a replacement. A timeout or non-terminal
status simply means the child is still executing. Allow running children to
finish by waiting on them, collecting any intermediate partial findings
reported. Spawning a replacement while a child is in flight duplicates work,
wastes tokens, and exhausts concurrency slots.

Be sure to give running children enough time to finish. A child may be reading files, running commands, or synthesizing results. If the parent needs to proceed urgently, prompt the child for an interim progress summary rather than closing it. Some model-providers operate much slower than others, and some tasks are inherently long-running. Prefer to let subagents finish their work rather than terminating them prematurely.

### Efficient waits

When several children are active and their results are needed, pass their IDs together to one `wait_agent` call; it returns when the first target reaches a final status. Then wait only for remaining children whose results are still needed. Choose a timeout that matches the work (minutes when appropriate) instead of issuing repeated short, fixed-interval polls. A timeout remains non-terminal and never permits closing or replacing a running child.

### Parking and session reuse

A child whose status is `completed` has finished its current turn. Instead of
immediately closing the session, park completed discovery and worker sessions
for compatible follow-up tasks. Reusing an existing child session with
`multi_agent_v1__send_input({ target: childId, message: "<follow-up task>" })`
preserves warmed context, file caches, and index state, avoiding redundant discovery
and duplicate initialization. Note that `resume_agent` accepts only `target` and
does not deliver new task input; always use `send_input` to deliver follow-up work,
using `resume_agent` only where unpausing without new instructions is genuinely required.

Generally, do not terminate, close, or discard running discovery or worker subagents. A wait
timeout (`timed_out: true` or `status: "running"`) indicates that the child is actively
executing commands, reading files, or synthesizing results. Closing an in-flight child
destroys its analysis and returns no useful results. Orchestrators must allow running
children to finish, or if findings are urgently needed to proceed, prompt the subagent
for an interim progress summary via `send_input({ target: childId, message: "..." })`
rather than closing it.

### Capacity-driven eviction

Completed and parked child sessions occupy concurrency slots in the session
thread pool. Close parked child handles with `close_agent` only when necessary:
1. when the assignment is fully complete and no follow-up tasks will occur, or
2. under capacity pressure, when new roles must be dispatched and the session
   has reached its concurrency limit.

When evicting under capacity pressure, evict (close) only the oldest
parked/terminal children owned by this parent. Never evict, terminate, or
interrupt active (running) children, and never touch foreign children owned
by other parents. Never invoke `close_agent` as a cleanup step in wait or spawn scripts.

### Terminal result handling and partial results

Treat `agent_id` as an opaque handle and pass the complete value from
the spawn result verbatim; never abbreviate or retype it from memory. If a
lifecycle call rejects an ID, recover the exact handle from this parent's
verified spawn history instead of guessing. Router active-child telemetry is
not proof that the parent has no open child handles.

A rejected spawn with no child ID created no handle.

A lifecycle status of `completed` means the turn ended, not necessarily that the
child completed its assignment. Inspect the returned result for an explicit
incomplete marker or provider-failure diagnostic; treat either as a failed or
partial child result, preserve any useful partial work, and report the cause.
Do not automatically retry a deterministic permission denial; correct the cause
first and leave any retry to the parent. When terminal or errored sessions must
be closed, ensure any useful partial findings produced by the child are
collected and preserved rather than discarded.

On interruption or admission failure, run any injected current-parent recovery
preflight first when available, then:

1. enumerate this parent's children with owner-scoped `list_agents` or `manage_subagents` when available
2. otherwise recover IDs only from this parent's verified spawn history, including Codex App `read_thread` when needed
3. preserve running children (a wait timeout never implies child failure or justifies termination)
4. collect and preserve any available finished results or partial findings
5. under capacity pressure, evict only this parent's oldest parked/terminal children to free capacity
6. leave running or foreign children untouched
7. retry the original delegation once if recovery freed capacity
8. report the unavailable path if it still fails

Never perform global cleanup. A spawn failure does not authorize silently taking
over delegated implementation work.

## Workspace and role resolution

Keep delegated work in the parent-selected repository or worktree. Do not let
task prose implicitly select another workspace.

Give children only the task context they need. The spawn payload contains the
selected role and task, not ad hoc skill paths or MCP lists.

The selected `agent_type` must resolve through the installed
`agents/<agent_type>.toml` contract, including that role's configured skills
and MCP servers. Report missing role/tool configuration rather than silently
substituting another path.

## Provider-specific behavior

Provider bridges may implement the common contract differently but must preserve
parent-owned child identity, bounded scope, explicit terminal-result handling,
safe capacity recovery, and no global child cleanup.

Antigravity's `invoke_subagent`/`manage_subagents` children are agy-owned
subprocesses rather than router `autodev/<role>` children, so router
per-session concurrency does not cover them. When the parent stream disappears
mid-delegation, the bridge must report
`INCOMPLETE_REASON_CLIENT_DISCONNECTED` rather than
`INCOMPLETE_REASON_INTERRUPTED`.

The router keeps a parent with active router-owned children in `subagent_wait`
on its original provider so live-load routing can prefer idle providers. Child
progress refreshes the parent's liveness; stale parents may age out normally
after their children stop reporting.

Report rate limits, stalls, provider failures, skipped roles, partial child
results, and unavailable recovery surfaces explicitly.

## Tool naming convention

Every canonical AutoDev tool name follows `<namespace>__<tool>` with
snake_case segments and a double-underscore separator (or a single bare
snake_case segment, e.g. `exec`). The single owner of these names is
`@simulatorlife/autodev-runtime/shared/tool-names`; bridges, hooks, the orchestrator prompt, and
tests all import from there so a rename moves the whole surface together.

| Family                                | Form                     | Examples                                                                                                                                                 |
| ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex code-mode meta-tool             | bare                     | `exec`                                                                                                                                                   |
| Multi-agent delegation                | `multi_agent_v1__<tool>` | `multi_agent_v1__spawn_agent`, `multi_agent_v1__wait_agent`, `multi_agent_v1__close_agent`, `multi_agent_v1__resume_agent`, `multi_agent_v1__send_input` |
| MCP tools                             | `mcp__<server>__<tool>`  | `mcp__lsp__lsp_goto_definition`, `mcp__cocoindex-code__search`, `mcp__autodev_spawn__spawn_subagent`                                                     |
| Codex-native web research             | bare                     | `web_search`, `web_fetch`                                                                                                                                |
| Codex App plugin (request_user_input) | bare                     | `request_user_input`                                                                                                                                     |

The `<server>` segment of an MCP name is snake_case; the one historical
exception is `openaiDeveloperDocs`, which is allowed in the canonical regex
because it already ships in `.rulesync/mcp.jsonc`. A new server name must be
snake_case unless it is a port of an existing third-party tool that already
ships under its camelCase identity.

CLI-required exceptions (PascalCase `WebSearch`/`WebFetch`/`Agent` from the
Claude CLI, lowercase `bash`/`search_web`/`read_file`/`glob`/`grep` from the
Antigravity CLI, lowercase `bash`/`shell`/`execute` from the Copilot CLI,
`invoke_subagent` from Antigravity) live in `@simulatorlife/autodev-runtime/shared/tool-names` under
`CLAUDE_NATIVE_TOOL_EXCEPTIONS`, `ANTIGRAVITY_NATIVE_TOOL_EXCEPTIONS`, and
`COPILOT_NATIVE_TOOL_EXCEPTIONS`. The bridges translate them into the
canonical surface; do not adopt their style for a new AutoDev tool.

A guard rail in `tests/shared/tool-names.test.ts` fails the suite if anyone
hard-codes a `multi_agent_v1__*` literal anywhere in `src/` outside
`@simulatorlife/autodev-runtime/shared/tool-names`. The audit helper `auditToolNames(names)` classifies
every string into `canonical`, `exception` (with provider), or `unrecognised`,
and is the recommended surface for any new tool-name validation.
