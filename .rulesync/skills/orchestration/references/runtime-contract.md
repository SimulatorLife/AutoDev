# Orchestration runtime contract

Read before delegation. The canonical AutoDev execution contract and `docs/xacpx-subagent-delegation.md` own role authorization, workspace confinement, concurrency, and child lifecycle. Use `references/xacpx-delegation.md` for the actual MCP operations.

## Ownership and admission

Manage only tasks admitted under the current coordinator or recovered through its verified, owner-scoped task history. Treat returned IDs as opaque; never guess or abbreviate them. Do not use global telemetry, files, UI state, or another parent's reports as ownership proof. Never perform global cleanup.

Pass the configured role, explicit absolute working directory, bounded scope, and complete task. Resolve roles through the current execution contract; report missing role configuration instead of silently substituting a different execution path. Do not invent extra skill paths or MCP permissions.

Respect configured concurrency. Batch independent work when appropriate; inspect each admission result. Report a task as started only when admission is confirmed. A refusal without an admitted task creates no task to manage.

## Task lifecycle

Use the runtime's reported states and the canonical delegation operations, not provider-specific thread APIs.

- Follow active tasks through bounded, event-driven watches. A timeout or non-terminal status is not failure and never alone justifies cancellation or duplicate work.
- Respond to attention-required states with the appropriate authorized coordinator operation. Do not approve actions outside user authorization or automatically retry deterministic denials.
- Collect terminal results and available partial evidence. Successful termination is not proof that acceptance criteria were met; verify the actual output and report incomplete work.
- Reuse compatible agent sessions through the supported task/session lifecycle where available. Session reuse, parking, and capacity reclamation belong to the runtime, not provider-private close or resume calls.
- Cancel only owned tasks when necessary and explicitly justified; never cancel healthy in-flight work merely to reclaim slots or compensate for a wait timeout.
- On admission failure or interruption, follow `references/recovery.md`.

## Workspace and permissions

Keep delegated work in the parent-selected repository or worktree. Do not allow task prose to implicitly select another workspace. Use the authorized file-interaction and command interfaces, confined to the assigned workspace and permitted read-only skill roots. Access external snapshots only where explicitly authorized; do not bypass a denied capability through a different interface. Keep temporary probes in ignored scratch locations and clean them up.

## Commits

The root owns commits; delegated roles never stage or commit. Respect the active permission policy and repository rules. Stage only paths changed for this task, never indiscriminately stage the checkout. Avoid destructive Git operations and amending unrelated history; do not discard concurrent edits. Keep commands scoped to the selected working directory. If a permission or execution environment blocks a required operation, report the blocker rather than bypassing it.
