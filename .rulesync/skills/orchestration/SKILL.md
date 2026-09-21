---
name: orchestration
description: Coordinate independent work across the configured agents and providers. Use when planning parallel implementation, distributing load, choosing a reviewer, or cross-validating a change.
targets: ["copilot"]
---

# Agent orchestration

Coordinate work; do not become the default worker.

This file is the source of truth for orchestration policy. Provider prompts,
hooks, and bridges may bootstrap it but must not maintain competing procedures.

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

## Complexity

Classify the change once using semantic impact, not line count:

- **Trivial/atomic**: obvious, localized, low-risk work with direct verification
- **Standard**: non-trivial but bounded work with meaningful behavioral, structural, interface, configuration, data, or regression risk
- **High-risk/cross-cutting**: broad ownership or migration impact, runtime-critical behavior, substantial uncertainty, or high cost of a missed defect

## Delegate

- **Trivial/atomic**: the root may execute directly when delegation adds little value
- **Standard**: delegate substantive implementation and useful discovery
- **High-risk/cross-cutting**: decompose into bounded scopes and parallelize independent work where useful

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

- **Trivial/atomic**: direct verification may be sufficient
- **Standard**: normally use one independent validator or tester
- **High-risk/cross-cutting**: normally use two complementary independent validation perspectives when capacity allows

Prefer complementary evidence over duplicate reviewers, for example:

- architecture/code review + runtime validation
- tests/static analysis + browser behavior
- migration/call-path review + regression testing

A validator must not validate a scope it implemented. Give it the acceptance
criteria, constraints, and current repository/diff state, but do not prime it
with the implementer's conclusions or reasoning unless needed to investigate a
specific finding.

Do not spawn agents merely to satisfy a count. Each additional agent must add
useful execution, expertise, or independent evidence.

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
5. advances lifecycle gates when their evidence is satisfied
6. reports unavailable evidence and unresolved risk
