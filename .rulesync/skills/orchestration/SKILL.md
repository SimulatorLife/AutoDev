---
name: orchestration
description: Coordinate independent work across the configured agents and providers. Use when planning parallel implementation, distributing load, choosing a reviewer, or cross-validating a change.
targets: ["copilot"]
---

# Agent orchestration

Coordinate work; do not become the default worker.

This skill is the source of truth for orchestration policy. Provider prompts, hooks, and bridges may bootstrap it but must not maintain competing procedures.

The root owns planning, decomposition, delegation, synthesis, integration, lifecycle progression, and final gate decisions. Except for trivial work, delegate substantive discovery, implementation, testing, and validation to configured roles.

## References: read only what applies

Each reference is a self-contained procedure. Read one when its trigger applies to your provider and situation; skip the rest.

| Reference | Read when |
| --- | --- |
| `references/runtime-contract.md` | Before your first spawn: spawning, waiting, parking, closing, commits |
| `references/codex-code-mode.md` | Before your first spawn when your instructions have no "Delegation on this provider" section (Codex-native GPT, MiniMax, opencli) |
| `references/provider-bridges.md` | Before your first spawn when your instructions have a "Delegation on this provider" section (Claude, Antigravity, Copilot bridges) |
| `references/web-chat.md` | Your replies go through a web chat (`opencli-chatgpt`, `opencli-gemini`) |
| `references/recovery.md` | A spawn fails for capacity or admission, or a delegation is interrupted |
| `references/validation.md` | You plan or run a validation gate, including browser verification |
| `references/development-lifecycle.md` | You are making a repository change past trivial |
| `references/playtesting.md` | The task runs, reviews, or verifies a game playtest |
| `references/tool-names.md` | You add, rename, or validate an AutoDev tool name |

## Capability/subagent roles

| Role | Use for | Sandbox | Notes |
| ----------------- | ------------------------------------------------------- | --------------- | ------- |
| `default` | General-purpose development | workspace-write |
| `docs-researcher` | Authoritative, version-aware external research, website research, documentation discovery | read-only | - |
| `browser-tester` | Browser and runtime evidence | read-only | Uses Playwright strictly for delegated UI and browser testing via browser-tester; do not use browser automation for general web research. |
| `explorer` | Architecture, dependencies, and current-state discovery | read-only | - |
| `worker` | Bounded implementation | workspace-write | - |
| `validator` | Independent review and validation | workspace-write | Validators must be independent of the scope they validate and pinned to an identified repository state; see `references/validation.md`. |
| `smart` | Work requiring broader capability than normal roles | workspace-write | - |

Choose by capability first, then required sandbox. Prefer the smallest capable role and configured `autodev/<role>` aliases over hard-coded providers or models.

## Complexity and orchestration

Classify work by semantic impact, uncertainty, and regression risk—not line count.

| Complexity | Planning | Execution | Validation |
| ----- | ----- | ----- | ----- |
| **Trivial/atomic** | Root may plan directly; keep planning proportional to the task | Root may execute directly when delegation adds little value | Direct verification may suffice |
| **Standard** | Root performs discovery and normally delegates at least one complementary discovery scope; reconcile findings into a single approach before implementation | Root participates in implementation and normally delegates at least one useful, bounded portion that can proceed independently or in parallel | Root validates the integrated result and normally uses at least one independent validator or tester |
| **High-risk/cross-cutting** | Maintain one canonical Markdown plan with scope, decisions, dependencies, risks, and a checklist. Delegate discovery across relevant perspectives; the root owns synthesis, reconciliation, sequencing, and checklist state, integrating agent evidence and proposed changes into the plan. Refine it across execution and validation waves as new evidence emerges; it may be temporary when it has no lasting repository value | Decompose into bounded scopes; parallelize independent work and use multiple waves when useful | At least two complementary independent validation perspectives; use additional waves when useful |

## Delegation rules

Do not add agents merely to satisfy a count. Each delegation must contribute useful execution, expertise, or independent evidence.

Give each subagent mutable scope, each task one primary implementer. Avoid concurrent edits to the same files unless deliberately reconciling alternatives.

Each delegated task must define:

- concrete outcome and acceptance criteria
- allowed read/write scope
- important constraints and non-goals
- expected tests, checks, or evidence
- repository or worktree context

Delegated roles are leaves unless nested delegation is explicitly designed. Read-only roles may inspect authorized external state but must not edit, stage, commit, or push.

Allow discovery and worker subagents to complete their assignments. Do not close or kill in-flight subagents on wait timeouts; if progress or partial evidence is urgently needed, prompt the subagent for an interim summary rather than terminating it. Completed subagents must remain parked and be reused for follow-up discovery and implementation tasks rather than closed and re-spawned.

Batch initial read-only exploration and CodeGraphContext lookups in parallel up front, then transition promptly to spawning bounded `worker` / `default` implementation children once the failing seam is identified rather than running repeated serial read passes in the root turn.

## Waiting and context budget

Each model request re-sends the whole conversation, as with any stateless LLM API, so every tool output stays in every later request until compaction. Prompt caching bills that repeated prefix at a fraction of the normal price, but it still counts against usage limits and adds latency, and a wake that returns nothing new buys nothing.

- Wait on all outstanding children in one `wait_agent` call with `timeout_ms` of at least 300000, never a 10–60s loop. In code mode, put `// @exec: {"yield_time_ms": <timeout_ms + 30000>}` on the cell's first line: without it the cell yields after about 30 seconds and each resume is an extra model turn.
- A Codex code-mode `exec` cell has no `setTimeout` or `setInterval`; wait through `wait_agent` or `write_stdin`.
- Run commands to completion with a timeout sized to them. Poll a background command with empty `write_stdin` at `yield_time_ms` of at least 60000.
- Scope reads and searches to the step (`rg -l`, `--max-count`, a line range, a path filter), and do not re-run a call whose output is already in context.
- The root does not read git history: the role-sandbox hook refuses `git log`, `git show`, `git blame` and the other history commands for the root orchestrator. When a regression needs history, delegate it to one child with the symptom, the files, and a commit range, and have it report the finding.

After compaction, re-read files or re-request reports only when the current step needs them. When the user's next request is unrelated to the finished task, say that a fresh session will be cheaper and sharper than continuing this one.

## Validation and integration

The root/orchestrator:

1. collects delegated results
2. treats agent reports as provisional evidence
3. checks them against acceptance criteria
4. never weakens requirements, tests, or performance thresholds to obtain a passing result
5. resolves conflicting findings
6. integrates only relevant work
7. re-delegates planning, implementation, or validation when findings reveal issues, gaps, improvements, or missing evidence
8. repeats refinement and validation waves until evidence is sufficient
9. advances lifecycle gates when evidence is sufficient
10. reports unavailable evidence and unresolved risk

