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

| Role              | Use for                                                 | Sandbox         |
| ----------------- | ------------------------------------------------------- | --------------- |
| `default`         | General-purpose development                             | workspace-write |
| `docs-researcher` | Authoritative, version-aware external research          | read-only       |
| `browser-tester`  | Browser and runtime evidence                            | read-only       |
| `explorer`        | Architecture, dependencies, and current-state discovery | read-only       |
| `worker`          | Bounded implementation                                  | workspace-write |
| `validator`       | Independent review and validation                       | workspace-write |
| `smart`           | Work requiring broader capability than normal roles     | workspace-write |

Choose by capability first, then required sandbox. Prefer the smallest capable role and configured `autodev/<role>` aliases over hard-coded providers or models.

## Complexity and orchestration

Classify work by semantic impact, uncertainty, and regression risk—not line count.

| Complexity                  | Planning                                                                                                                                                                                                                                                                                                                                                                                                                         | Execution                                                                                                                                     | Validation                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Trivial/atomic**          | Root may plan directly; keep planning proportional to the task                                                                                                                                                                                                                                                                                                                                                                   | Root may execute directly when delegation adds little value                                                                                   | Direct verification may suffice                                                                     |
| **Standard**                | Root performs discovery and normally delegates at least one complementary discovery scope; reconcile findings into a single approach before implementation                                                                                                                                                                                                                                                                       | Root participates in implementation and normally delegates at least one useful, bounded portion that can proceed independently or in parallel | Root validates the integrated result and normally uses at least one independent validator or tester |
| **High-risk/cross-cutting** | Maintain one canonical Markdown plan with scope, decisions, dependencies, risks, and a checklist. Delegate discovery across relevant perspectives; the root owns synthesis, reconciliation, sequencing, and checklist state, integrating agent evidence and proposed changes into the plan. Refine it across execution and validation waves as new evidence emerges; it may be temporary when it has no lasting repository value | Decompose into bounded scopes; parallelize independent work and use multiple waves when useful                                                | At least two complementary independent validation perspectives; use additional waves when useful    |

## Delegation rules

Do not add agents merely to satisfy a count. Each delegation must contribute useful execution, expertise, or independent evidence.

### On a web-chat provider

When your replies go through a web chat (`opencli-chatgpt`, `opencli-gemini`: the response rules say each reply is a round trip through a web chat), every model turn of yours and of every child costs about a minute, and a child's first turn costs two. Scale delegation down to match:

- Standard work: delegate one `worker` that does its own discovery for its scope. Do not run an `explorer` on the same scope beside or ahead of it; spawn an explorer only for a separate question the worker does not need answered first.
- Validate Standard work yourself by running the relevant tests and checks against the integrated state. Spawn an independent `validator` only for High-risk/cross-cutting work.
- Trivial work: do it yourself without spawning.

Give each subagent mutable scope, each task one primary implementer. Avoid concurrent edits to the same files unless deliberately reconciling alternatives.

Each delegated task must define:

- concrete outcome and acceptance criteria
- allowed read/write scope
- important constraints and non-goals
- expected tests, checks, or evidence
- repository or worktree context

Delegated roles are leaves unless nested delegation is explicitly designed. Read-only roles may inspect authorized external state but must not edit, stage, commit, or push.

Allow discovery and worker subagents to complete their assignments. Do not close or kill in-flight subagents on wait timeouts; if progress or partial evidence is urgently needed, prompt the subagent for an interim summary rather than terminating it. Completed subagents must remain parked and be reused for follow-up discovery and implementation tasks rather than closed and re-spawned.

## Waiting and context budget

Every tool call re-sends the whole conversation, so a poll that returns nothing new costs as much as real work. Wait on all outstanding children in one `wait_agent` call with `timeout_ms` of at least 300000, never a 10–60s loop. In code mode, start that `exec` cell with `// @exec: {"yield_time_ms": <timeout_ms + 30000>}` on its first line: without it the cell yields after about 30 seconds with `Script running`, and resuming it costs a full extra model turn (a minute or more on a web-chat provider) for every wait. Run commands to completion with a timeout sized to their expected runtime; when a command must run in the background, poll it with empty `write_stdin` at `yield_time_ms` of at least 60000, never 1000–30000. Do not re-run a call whose output is already in context. Scope reads and searches to what the step needs (`rg -l`, `--max-count`, a line range, a path filter): every result stays in context until compaction, and output past the catalog's `truncation_policy` is cut to its head and tail anyway.

Codex compacts at the catalog's `auto_compact_token_limit`; do not re-read files or re-request reports to rebuild context compaction dropped unless the current step needs them. When the user's next request is unrelated to the finished task, say that a fresh session will be cheaper and sharper than continuing this one.

## Validation rules

Validators must be independent of the scope they validate. Pin validation to an identified repository state (commit/head plus any relevant uncommitted diff), and provide acceptance criteria, constraints, and expected evidence without priming validators with the implementer's conclusions unless investigating a specific finding. Validators for the same gate should inspect the same state.

Prefer complementary evidence, such as:

- architecture/code review + runtime validation
- tests/static analysis + browser behavior
- migration/call-path review + regression testing

Treat agent reports as provisional evidence, not authority. The root resolves disagreements and determines whether lifecycle gates pass.

Never weaken requirements, tests, or performance thresholds to obtain a passing result.

## Integration

The root:

1. collects delegated results
2. checks them against acceptance criteria
3. resolves conflicting findings
4. integrates only relevant work
5. re-delegates planning, implementation, or validation when findings reveal issues, gaps, improvements, or missing evidence
6. repeats refinement and validation waves until evidence is sufficient
7. advances lifecycle gates when evidence is sufficient
8. reports unavailable evidence and unresolved risk

## Playtesting handoffs

For game-playtesting tasks, keep execution, interpretation, verification and publication separate:

- Delegate an explicitly requested, operator-authorized run to `playtester`; require the exact workspace/build approval and bounded budget first. Workspace enablement alone is not run approval. If there is no exact approval, do not run a game or substitute a fixture; report the missing gate.
- Delegate review of completed, workspace-scoped evidence to `playtest-analyst`. Give it immutable episode/window references and the game-owned rubric; it is read-only and cannot run, branch, modify code, or publish issues.
- Ask the existing `validator` to independently inspect consequential claims from the cited evidence before treating them as verified; do not prime it with the analyst's conclusion.
- Use `browser-tester` only for an explicitly relevant rendered-UI check, against an authorized target and real captured interface. It does not replace the game adapter or infer human outcomes.
- The root retains workspace approval, experiment authorization, issue publication, and owner-promotion decisions. Preserve incomplete, negative, contradictory and unavailable evidence.

**MCP boundary:** Codex-native `multi_agent_v1` children inherit the parent's host MCP set; per-agent `mcp_servers` in a custom role file do not override that host-level set ([Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents)). AutoDev intentionally disables `playtest` and `playwright` in the root session. A native child using `autodev/<role>` is still served through AutoDev's Model Router: for roles with `roleScopedMcp`, the router filters provider candidates to bridges that inject the role contract's MCP into that provider invocation (`roleMcpInjection`). The provider-native MCP tools may therefore be available even when absent from the parent/child host `ALL_TOOLS`; use the role's supported provider-mediated path rather than generic parent-session MCP tools. Verify a real provider tool call, not just the role TOML or `mcpExposed` telemetry. Never enable the servers globally. Playtester MCP additionally requires the trusted workspace/session identity and dedicated runner credential supplied by Runtime; an arbitrary MCP launch or shell invocation without that binding must stop. For provider-internal delegation, `autodev_spawn` still asks Codex to create the native child thread, which is then routed through the same role-aware Router path.

These handoffs reuse the existing orchestrator and roles; they do not create another scheduler or grant a role capabilities it does not already have.
