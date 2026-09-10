---
name: orchestration
description: Coordinate independent work across the configured agents and providers. Use when planning parallel implementation, distributing load, choosing a reviewer, or cross-validating a change.
---

# Agent orchestration

Use this skill to coordinate independent work across the configured capability
roles. The orchestrator owns the plan and integration; delegated roles own
their bounded execution. Select explicit configured autodev/<role> model aliases rather than hard-coding a provider or concrete model.

## Root orchestrator contract

This skill is the single source of truth for root delegation behavior. Provider
prompts, hooks, and bridges may bootstrap or inject this skill, but must not
maintain competing copies of its procedure.

The root orchestrator owns planning, delegation, integration, and final
validation. Before substantial work, identify useful independent subtasks and
assign them through the configured role-based orchestration layer. There is
exactly one delegation path: the configured `spawn_subagent`/role-based
surface (or its code-mode `multi_agent_v1__spawn_agent` implementation). Use
one whole batch call for independent work; do not substitute `create_thread`,
`fork_thread`, or provider-private task APIs for the role-based child path.

The parent may message, wait for, resume, and close only children in its own
agent tree. Never act on an agent ID you did not receive from this parent's
spawn call or recover from this parent's own Codex App history; never use IDs
discovered by reading the filesystem, global task list, or another parent's
output. Other orchestrators and their children are peers, not recovery
candidates. Roles are leaves unless a task explicitly requires otherwise and
has an approved nested-delegation design.

For a native code-mode provider, the delegation call uses the runtime's
`exec` surface and `tools.multi_agent_v1__spawn_agent` with `{ agent_type,
message }`. Batch calls use `Promise.allSettled`, emit a structured
`spawn_status: "created"` or `spawn_status: "rejected"` result per child, and
never hide successful siblings behind one rejected child. Spawning is
fire-and-forget: children continue under the orchestration layer after the
spawn call returns, and the parent must not poll for their lifetime. Provider
bridges use the same parent-owned path when available; bridge-native children
remain provider-owned and are reported separately.

A spawn failure never authorizes silent takeover of delegated implementation
scopes. A rejected entry with no `agent_id` created no child handle. On an
admission/thread-limit failure against the configured limit, stop repeated spawn
attempts, recover known terminal children owned by this parent, retry the
original batch once, and if that fails report the exact unavailable path while
remaining the coordinator.

When a child reaches `completed`, `errored`, `interrupted`, `shutdown`, or an
explicit provider-incomplete terminal state, consume its result and call
`close_agent` immediately. Completion does not release the child handle by
itself. If the runtime offers owner-scoped `list_agents`/`manage_subagents`, use
it during recovery. If only Codex App `read_thread` is available, recover IDs
only from successful spawn results in this parent's history. Do not use global
`list_threads`, filesystem state, telemetry, or UI listings as ownership proof.
The root hook may inject an executable current-parent recovery preflight; run it
before retrying admission failures. It must wait children, close terminal ones,
and leave running or foreign children untouched.

The router's active-child count is router-admission telemetry, not the Codex
app's open child-handle count. A zero router count does not prove that the
parent has no open handles. Keep the active workspace/worktree aligned with the
parent and report missing roles, tools, provider limits, stalls, partial child
results, and unavailable recovery surfaces explicitly.

## Capability roles

| Role | Capability | Sandbox |
| --- | --- | --- |
| `default` | General-purpose development | workspace-write |
| `docs-researcher` | Targeted documentation research | read-only |
| `browser-tester` | Browser and runtime evidence | read-only |
| `explorer` | Architecture and dependency exploration | read-only |
| `worker` | Bounded implementation | workspace-write |
| `validator` | Independent validation | workspace-write |
| `smart` | Full-capability research, browser, and implementation work | workspace-write |

Choose a role by capability first, then by the required sandbox. Use the
smallest role that can complete the work: `explorer`, `docs-researcher`, and
`browser-tester` gather evidence; `worker` makes a bounded change; `default`
handles general development; `validator` checks another role's work; and
`smart` is reserved for work that genuinely needs its broader capabilities.
Use the configured default tier for ordinary roles and reserve the smart tier
for `smart`; do not choose a concrete model to bypass role selection.

## Plan and delegate

1. Before substantial investigation or implementation, identify useful,
   independent subtasks. Skip delegation only for a genuinely trivial or
   atomic task with no useful independent work.
2. Give each independent item one primary implementer. Run independent items
   in parallel when useful, but assign disjoint file ownership. Do not have
   parallel roles edit the same file unless the parent is deliberately
   reconciling the results.
3. Use the configured subagent tools for delegation. Do not use
   `create_thread`, `fork_thread`, or `handoff_thread` as substitutes for
   role-based delegation.
4. Keep every prompt bounded. State the exact outcome, allowed files or
   read scope, whether edits are allowed, the validation expected, and the
   repository/worktree the role must use.
5. Roles are leaf agents. Do not ask a delegated role to spawn further
   subagents. Keep the parent workspace aligned with the target repository
   and do not let a role infer a different workspace from task prose.
6. For important decisions, obtain an independent perspective through a
   separate configured role or implementation path. A second perspective is
   evidence, not permission to broaden the file scope or weaken requirements.

Read-only roles may inspect explicitly authorized external runtime state,
but must not edit, stage, commit, or push. Keep any external read
authorization narrow and explicit in the prompt.

## Concurrency and child-handle lifecycle

Before creating parallel roles, check the available configured concurrency and
never exceed it. Serialize work when capacity is unavailable or uncertain;
do not retry by spawning more roles. Keep the smallest set of active roles
that provides useful independence.

Treat each child handle as a two-phase resource:

- Wait only when the result is needed. A completion notification or terminal
  status (`completed`, `errored`, `interrupted`, or `shutdown`) reports state
  but does not release the handle.
- After consuming a finished child's result, call `close_agent` immediately,
  before spawning another role or ending the task.
- If the turn is interrupted, close every child handle whose final status is
  known before attempting new delegation. Stale handles can retain capacity
  even when their work is no longer running.
- Treat a rejected spawn with no returned child id as an admission failure, not
  as a child that needs closing. If the runtime exposes an owner-scoped
  `list_agents`/`manage_subagents` operation, enumerate this parent's children
  before recovery. If only Codex App `read_thread` is available, recover IDs
  only from successful spawn results in this parent's own history. Otherwise use
  only IDs returned by this parent's spawn calls. `list_threads`, filesystem
  state, telemetry, and UI listings are not child-handle enumeration. Close
  only known terminal children owned by this parent, retry the original
  delegation once, and then stop retrying.
  Do not silently perform delegated implementation scopes after the bounded
  recovery attempt fails; report the capacity/provider failure to the
  parent/user.
- Never perform a global cleanup or close a handle discovered outside this
  parent tree. Router active-slot telemetry cannot prove that the Codex app has
  no open child handles.

Antigravity-orchestrated turns wrap their work in the CLI's own `invoke_subagent`
and `manage_subagents` tools. Those children are subprocess calls inside agy,
not `autodev/<role>` requests through the router, so per-session concurrency
enforcement does not cover them; the antigravity bridge tracks the most recent
delegator step and stops killing agy when the upstream goes away mid-delegation,
emitting an `INCOMPLETE_REASON_CLIENT_DISCONNECTED` truncation instead of an
`INCOMPLETE_REASON_INTERRUPTED` one when the cause was the parent stream going
idle. Long delegations therefore surface in launchd logs as `agy turn aborted-
delegation` with the delegator tool name, not `agy turn aborted`. Treat those
as `agy turn succeeded after upstream close` for telemetry: the work ran, the
parent just wasn't listening.

Report rate limits, stalls, provider failures, skipped roles, and
unavailable execution paths explicitly. Treat missing or partial delegated
evidence as missing evidence, not as a successful result.

## Workspace and prompt boundaries

Pass the active repository or worktree context through the delegation tool and
keep it consistent with the parent task. Never rely on arbitrary task prose
to select a workspace. Do not serialize parent-only instructions as if they
were delegated user content; give each role only the task context it needs.

For each delegated item, state:

- the concrete outcome and acceptance criteria;
- the exact files or directories it may read or edit;
- whether it may make edits, and who owns integration;
- tests, checks, or evidence it must return; and
- any explicitly approved external paths or services it may inspect.

Until the Codex App spawn API accepts a native role-capability contract, the
provider bridge must carry the generated role skill identities in the spawn
payload. This is derived from `execution-contract.json`, not a role allowlist;
the role TOMLs remain the source and drift is checked by the installer. Attach
`ccc` and `lsp-mcp-server` only when the selected role contract declares them.


## Validation and integration

Finish every significant coordinated change with an independent `validator`
role that did not implement the change. Treat its report as evidence and
resolve disagreements at the parent boundary. Never weaken requirements,
tests, or performance thresholds to satisfy a validator.

The parent reviews delegated changes, checks the reported file scope and
validation, integrates only relevant results, and reports any unavailable
roles or unresolved evidence instead of silently treating them as success.
