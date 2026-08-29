---
name: orchestration
description: Coordinate independent work across the configured agents and providers. Use when planning parallel implementation, distributing load, choosing a reviewer, or cross-validating a change.
---

# Agent orchestration

For provider-specific routing, read the canonical repository guide at
`https://github.com/SimulatorLife/AutoDev/blob/main/docs/provider-routing.md`. It owns the available roles, execution
surfaces, provider boundaries, and setup commands; this skill only defines the
coordination strategy.

Use the smallest set of agents that gives useful independence:

1. Split the task into independent work items and distribute those items
   across available agents/providers when useful. Choosing one primary
   implementer is per independent item, not an overall restriction.
2. Assign disjoint file ownership. Do not have parallel agents edit the same
   files unless the parent is deliberately reconciling the result.
3. Mix providers for important decisions or implementations so independent
   perspectives distribute load and expose provider-specific blind spots.
4. Finish with an independent validator. Treat its report as evidence; never
   weaken requirements or tests to satisfy it.
5. Keep prompts bounded: state the exact outcome, allowed files, validation
   expected, and whether edits are allowed.
6. Use the configured subagent tools for delegation; do not use
   `create_thread`, `fork_thread`, or `handoff_thread` for that purpose.
7. Treat each child handle as a two-phase resource. A `wait_agent` notification
   and a terminal status (`completed`, `errored`, `interrupted`, or `shutdown`)
   report state but do not release the handle. After consuming a finished
   child's result, the parent must call `close_agent` immediately, before
   spawning another child or ending the task. If a turn is interrupted, close
   every child handle whose final status is known at the start of the next turn
   before attempting new delegation; stale handles can retain thread-pool
   capacity even when their work is no longer running. Report rate limits,
   stalls, and skipped paths explicitly.
