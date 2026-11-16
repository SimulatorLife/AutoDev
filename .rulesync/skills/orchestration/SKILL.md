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

## Delegation surface

Use the delegation surface your provider actually offers.

On Codex -- Codex-native GPT, MiniMax, and the opencli web-chat providers (`opencli-chatgpt`, `opencli-gemini`) -- that surface is `multi_agent_v1__spawn_agent` with `{ agent_type: "<role>", message: "<full task>" }`. A provider CLI bridge (Antigravity's `agy` CLI, Copilot) serves a delegation tool of its own and states the exact call in the "Delegation on this provider" section of your instructions. Where that section is present it is the surface to use: it is the one call this provider can serve, and a child created through it is a real Codex session. Where it is absent -- including for a Gemini model served by opencli, which is not Antigravity -- use `multi_agent_v1__spawn_agent` through `exec`.

Every catalog in `config/catalogs/` and every model catalog in `~/.codex/*-model-catalog.json` declares `"tool_mode": "code_mode_only"` and `"multi_agent_version": "v1"`, so Codex delivers the entire tool surface as one `exec` custom tool whose input is raw JavaScript evaluated against a `tools` global. The spawn and lifecycle tools (`multi_agent_v1__spawn_agent`, `multi_agent_v1__wait_agent`, `multi_agent_v1__close_agent`, `multi_agent_v1__resume_agent`, `multi_agent_v1__send_input`) hang off that global inside the `exec` cell and are not listed as top-level functions -- by design, not a missing tool. Probe `typeof tools.multi_agent_v1__spawn_agent` inside an `exec` script before reporting a delegation capability failure. `runtime/src/agents/spawn-tools.ts` builds the batched `await Promise.allSettled(...)` script that fans out across children and is the reference implementation.

Set `agent_type` to one of the roles above; do not hard-code a provider or model. Pass each child the full context it needs: a child cannot see your conversation. Write `message` as a double-quoted JavaScript string with `"`, `\` and line breaks escaped (`\"`, `\\`, `\n`), never as a template literal: task text routinely contains Markdown backticks and `${`, which end or interpolate a template literal and fail the whole `exec` cell before any child spawns.

Use `@simulatorlife/autodev-runtime/shared/tool-names` as the source of canonical tool names. Provider CLIs may impose native exceptions; follow the role contract and provider instructions instead of inventing names.

Root and child MCP capabilities can differ. For role-scoped MCP (`browser-tester` -> Playwright, `playtester` -> Playtest), verify a real call through the routed provider; do not infer exposure from root tools or telemetry, and never enable those servers at the root. Playtest requires Runtime-bound authorization, an approved target, and exact budgets; never pass credentials or invent run context. Use Console Play/Watch for the supported end-to-end workflow.

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

Batch initial read-only exploration and CodeGraphContext lookups in parallel up front, then transition promptly to spawning bounded `worker` / `default` implementation children once the failing seam is identified rather than running repeated serial read passes in the root turn.

## Waiting and context budget

Each model request re-sends the whole conversation, as with any stateless LLM API, so every tool output stays in every later request until compaction. Prompt caching bills that repeated prefix at a fraction of the normal price, but it still counts against usage limits and adds latency, and a wake that returns nothing new buys nothing.

- Wait on all outstanding children in one `wait_agent` call with `timeout_ms` of at least 300000, never a 10–60s loop. In code mode, put `// @exec: {"yield_time_ms": <timeout_ms + 30000>}` on the cell's first line: without it the cell yields after about 30 seconds and each resume is an extra model turn.
- A Codex code-mode `exec` cell has no `setTimeout` or `setInterval`; wait through `wait_agent` or `write_stdin`.
- Run commands to completion with a timeout sized to them. Poll a background command with empty `write_stdin` at `yield_time_ms` of at least 60000.
- Scope reads and searches to the step (`rg -l`, `--max-count`, a line range, a path filter), and do not re-run a call whose output is already in context.
- The root does not read git history: the role-sandbox hook refuses `git log`, `git show`, `git blame` and the other history commands for the root orchestrator. When a regression needs history, delegate it to one child with the symptom, the files, and a commit range, and have it report the finding.

After compaction, re-read files or re-request reports only when the current step needs them. When the user's next request is unrelated to the finished task, say that a fresh session will be cheaper and sharper than continuing this one.

## Validation rules

Validators must be independent of the scope they validate. Pin validation to an identified repository state (commit/head plus any relevant uncommitted diff), and provide acceptance criteria, constraints, and expected evidence without priming validators with the implementer's conclusions unless investigating a specific finding. Validators for the same gate should inspect the same state.

For browser verification, delegate to `browser-tester` (`playwright-mcp` launches `--headless --no-sandbox --isolated`); if headless Chromium launch fails inside a macOS Seatbelt sandbox with `MachPortRendezvousServer` permission denied, retry headless with `["--no-sandbox", "--single-process"]` or fall back to server/DOM/unit assertions and report the sandbox Mach port restriction clearly as an environment boundary rather than a product failure.

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
