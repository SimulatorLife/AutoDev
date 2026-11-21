# Orchestration runtime contract

Read this before your first spawn: it governs creating, waiting for, parking,
resuming, and closing delegated agents. After a capacity or admission failure,
also read `references/recovery.md`.

## Delegation path

Every provider delegates the same way: `tools.multi_agent_v1__spawn_agent` with
`{ agent_type, message }` inside `exec` (`references/codex-code-mode.md`). There
is no provider-specific spawn tool; the spawn's result comes back to the `exec`
call that made it.

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
children are peers. Never perform global cleanup.

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
thread pool. Close parked child handles with `close_agent` when:
1. the assignment is fully complete and no follow-up tasks will occur, or
2. transitioning to a new wave requiring different roles while at the session's
   concurrency limit (e.g., closing unneeded parked `explorer` handles whose
   findings are already integrated before spawning `worker` children, rather
   than hitting `agent thread limit reached` first), or
3. under capacity pressure, when new roles must be dispatched and the session
   has reached its concurrency limit.

When evicting under capacity pressure, evict (close) only the oldest
parked/terminal children owned by this parent. Never evict, terminate, or
interrupt active (running) children, and never touch foreign children owned
by other parents. Never invoke `close_agent` inside a wait or spawn script on
children that may still be reused or are still running.
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

A new user request is a new assignment. Once a child's result has been
integrated and no follow-up for the *current* request will reuse it, close it
with `close_agent` before reporting: a parked handle from a finished request
holds a concurrency slot that the next request needs.

Report a child as started only after its `spawn_status` is `created` (or
`reused`). A `rejected` status created no child; say so rather than describing
work in progress.

## Commits

The root owns commits; delegated roles never stage or commit. Codex's
workspace-write sandbox keeps `.git` read-only, and AutoDev's command rules
(`agents/rules/default.rules`) run exactly `git add`, `git commit`, `git mv`,
`git rm`, `git restore --staged`, `git switch -c` and `git worktree add`
outside it. Other agents edit the same checkout concurrently, so:

- stage only the paths this task changed (`git add <path>...`), never
  `git add -A` or `git add .`
- make a new commit; never `--amend` (the rules require approval for it)
- run **every** `.git`-writing command (`git add`, `git commit`, `git mv`,
  `git rm`, `git restore --staged`, `git switch -c`, `git worktree add`) as its
  own standalone command with `workdir` set — never chain it with `&&`, `;`,
  `|`, `2>&1`, `cd ... &&`, or `set -e;`. Compound shell commands fail to match
  the `allow` prefix rule and stay inside the `workspace-write` sandbox, where
  `.git/index.lock` fails with `Operation not permitted`
## Workspace and role resolution

Keep delegated work in the parent-selected repository or worktree. Do not let
task prose implicitly select another workspace.

Give children only the task context they need. The spawn payload contains the
selected role and task, not ad hoc skill paths or MCP lists.

The selected `agent_type` must resolve through the installed
`agents/<agent_type>.toml` contract, including that role's configured skills
and MCP servers. Report missing role/tool configuration rather than silently
substituting another path.
