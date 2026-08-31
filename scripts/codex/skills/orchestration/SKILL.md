---
name: orchestration
description: Coordinate independent work across the configured agents and providers. Use when planning parallel implementation, distributing load, choosing a reviewer, or cross-validating a change.
---

# Agent orchestration

Use this skill to coordinate independent work across the configured capability
roles. The orchestrator owns the plan and integration; delegated roles own
their bounded execution. Select configured roles and explicit
`autodev/<role>` aliases rather than hard-coding a provider or concrete model.

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

## Validation and integration

Finish every significant coordinated change with an independent `validator`
role that did not implement the change. Treat its report as evidence and
resolve disagreements at the parent boundary. Never weaken requirements,
tests, or performance thresholds to satisfy a validator.

The parent reviews delegated changes, checks the reported file scope and
validation, integrates only relevant results, and reports any unavailable
roles or unresolved evidence instead of silently treating them as success.
