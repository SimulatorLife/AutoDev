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
handle until explicitly closed where the runtime requires it. After consuming a
terminal result, call `close_agent` before creating replacement work or ending
the task. Router active-child telemetry is not proof that the parent has no open
child handles.

A rejected spawn with no child ID created no handle.

On interruption or admission failure, run any injected current-parent recovery
preflight first when available, then:

1. enumerate this parent's children with owner-scoped `list_agents` or `manage_subagents` when available
2. otherwise recover IDs only from this parent's verified spawn history, including Codex App `read_thread` when needed
3. close only known terminal children
4. leave running or foreign children untouched
5. retry the original delegation once if recovery freed capacity
6. report the unavailable path if it still fails

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
