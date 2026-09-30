---
name: orchestration
description: Coordinate independent work across the configured agents and providers. Use when planning parallel implementation, distributing load, choosing a reviewer, or cross-validating a change.
targets: ["copilot"]
---

# Agent orchestration

Coordinate work; do not become the default worker.

This file is the source of truth for orchestration policy. Provider prompts, hooks, and bridges may bootstrap it but must not maintain competing procedures.

The root owns planning, decomposition, delegation, synthesis, integration, lifecycle progression, and final gate decisions. Except for trivial work, delegate substantive discovery, implementation, testing, and validation to configured roles.

For repository changes, follow `references/development-lifecycle.md`. For spawning, waiting, recovery, and cleanup, follow `references/runtime-contract.md`.

## Capability/subagent roles

| Role | Use for | Sandbox |
| --- | --- | --- |
| `default` | General-purpose development | workspace-write |
| `docs-researcher` | Targeted documentation research | read-only |
| `browser-tester` | Browser and runtime evidence | read-only |
| `explorer` | Architecture, dependencies, and current-state discovery | read-only |
| `worker` | Bounded implementation | workspace-write |
| `validator` | Independent review and validation | workspace-write |
| `smart` | Work requiring broader capability than normal roles | workspace-write |

Choose by capability first, then required sandbox. Prefer the smallest capable role and configured `autodev/<role>` aliases over hard-coded providers or models.

## Complexity and orchestration

Classify work by semantic impact, uncertainty, and regression risk—not line count.

| Complexity | Execution | Validation |
| --- | --- | --- |
| **Trivial/atomic** | Root may execute directly when delegation adds little value | Direct verification may suffice |
| **Standard** | Delegate substantive implementation and useful discovery | At least one independent validator or tester |
| **High-risk/cross-cutting** | Decompose into bounded scopes; parallelize independent work and use multiple waves when useful | At least two complementary independent validation perspectives; use additional waves when useful |

Do not add agents merely to satisfy a count. Each delegation must contribute useful execution, expertise, or independent evidence.

## Delegation rules

Give each subagent mutable scope, each task one primary implementer. Avoid concurrent edits to the same files unless deliberately reconciling alternatives.

Each delegated task must define:

- concrete outcome and acceptance criteria
- allowed read/write scope
- important constraints and non-goals
- expected tests, checks, or evidence
- repository or worktree context

Delegated roles are leaves unless nested delegation is explicitly designed. Read-only roles may inspect authorized external state but must not edit, stage, commit, or push.

## Validation rules

Validators must be independent of the scope they validate. Provide acceptance criteria, constraints, and current repository/diff state without priming them with the implementer's conclusions unless investigating a specific finding.

Prefer complementary evidence, such as:

- architecture/code review + runtime validation
- tests/static analysis + browser behavior
- migration/call-path review + regression testing

Treat agent reports as evidence, not authority. The root resolves disagreements and determines whether lifecycle gates pass.

Never weaken requirements, tests, or performance thresholds to obtain a passing result.

## Integration

The root:

1. collects delegated results
2. checks them against acceptance criteria
3. resolves conflicting findings
4. integrates only relevant work
5. advances lifecycle gates when evidence is sufficient
6. reports unavailable evidence and unresolved risk