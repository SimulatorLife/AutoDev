---
name: orchestration
description: Coordinate independent work across the configured agents and providers. Use when planning parallel implementation, distributing load, choosing a reviewer, or cross-validating a change.
targets: ["copilot"]
---

# Agent orchestration

Coordinate work; do not become the default worker.

The root owns planning, task decomposition, delegation, synthesis, integration,
lifecycle progression, and final gate decisions. For non-trivial work, delegate
substantive discovery, implementation, testing, and validation to configured
roles.

For repository changes, follow `references/development-lifecycle.md`.
For spawning, waiting, recovery, or child cleanup, follow
`references/runtime-contract.md`.

## Capability roles

| Role | Use for | Sandbox |
| --- | --- | --- |
| `default` | General-purpose development | workspace-write |
| `docs-researcher` | Targeted documentation research | read-only |
| `browser-tester` | Browser and runtime evidence | read-only |
| `explorer` | Architecture, dependencies, and current-state discovery | read-only |
| `worker` | Bounded implementation | workspace-write |
| `validator` | Independent review and validation | workspace-write |
| `smart` | Work requiring broader capability than normal roles | workspace-write |

Choose by capability first, then required sandbox. Use the smallest capable
role and configured autodev/<role> aliases rather than hard-coding a provider or
model.

## Delegate

Scale delegation to semantic complexity: scope, risk, uncertainty, runtime
impact, ownership boundaries, and cost of a missed defect. Do not use line count
as the primary measure.

- **Trivial/atomic**: the root may execute directly when delegation adds little value
- **Normal**: delegate substantive implementation and useful discovery
- **Large, uncertain, or cross-cutting**: decompose into bounded scopes and parallelize independent work where useful

Give each mutable scope one primary implementer. Avoid concurrent edits to the
same files unless the root is deliberately reconciling alternatives.

Each delegated task must state:

- concrete outcome and acceptance criteria
- allowed read/write scope
- important constraints and non-goals
- expected tests, checks, or evidence
- repository or worktree context

Delegated roles are leaves unless nested delegation is explicitly designed for
the task. Read-only roles may inspect explicitly authorized external state but
must not edit, stage, commit, or push.

## Validate

Scale independent validation by semantic risk:

- **Trivial/atomic**: direct verification may be sufficient
- **Normal**: normally use one independent validator or tester
- **Large/high-risk/cross-cutting**: normally use two complementary independent validation perspectives when capacity allows

Prefer complementary evidence over duplicate reviewers, for example:

- architecture/code review + runtime validation
- tests/static analysis + browser behavior
- migration/call-path review + regression testing

A validator must not validate a scope it implemented. Prefer fresh context so
validation is based on requirements and repository state rather than the
implementer's reasoning.

Do not spawn agents merely to satisfy a count. Each additional agent must add
useful execution, expertise, or independent evidence.

Validation applies to the reviewed repository state. Material changes invalidate
affected evidence and require appropriate revalidation.

Treat agent reports as evidence, not authority. The root resolves disagreements
and decides whether lifecycle gates pass.

Never weaken requirements, tests, or performance thresholds to obtain a passing
result.

## Integrate

The root:

1. collects delegated results
2. checks them against acceptance criteria
3. resolves conflicting findings
4. integrates only relevant work
5. advances or returns the development lifecycle as warranted
6. reports unavailable evidence and unresolved risk

When a finding exposes an earlier lifecycle error, return to the phase that owns
the problem rather than patching around it downstream.
