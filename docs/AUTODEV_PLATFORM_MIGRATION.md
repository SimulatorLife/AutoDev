# AutoDev Platform Simplification — Corrected Audit & Migration Plan

> Correctness pass against the current `SimulatorLife/AutoDev` repository and the audited upstream repositories as of 2026-09-13

## Executive decision

The previous direction was broadly correct but too aggressive in three places: it treated AutoDev as if it still needed to become a monorepo, treated Rulesync as if it could replace AutoDev's role/execution contract, and treated LiteLLM/router retirement as an expected destination rather than a compatibility-gated option.

The corrected target is:

| Concern | Decision | Target owner |
|---|---|---|
| GitHub scheduling, PR workflows, repository selection | Keep | AutoDev |
| Role/capability semantics, read-only policy, spawn semantics | Keep | AutoDev |
| Provider-selection policy | Keep initially | AutoDev |
| Cross-provider rules/skills/MCP/hooks/permissions translation | Adopt | Rulesync |
| Standard OTLP receive/process/export | Adopt | OpenTelemetry Collector |
| Provider transport/Responses normalization | Pilot per provider | LiteLLM |
| Stateful workspace/skill/subagent telemetry enrichment | Keep | AutoDev |
| Claude Code agent-runtime bridge | Keep initially | AutoDev |
| Antigravity agent-runtime bridge | Keep | AutoDev |
| Copilot transport proxy | Candidate for deletion | LiteLLM, if parity passes |
| MiniMax transport proxy | Candidate for deletion | LiteLLM, if parity passes |
| Generic GenAI instrumentation | Do not add initially | Native OTel first; OpenLLMetry only if a gap remains |
| Alternative gateway | Contingency only | Bifrost |
| Agent-config package distribution | Defer | Grimoire if later needed |

**Architectural rule:** AutoDev owns **GitHub orchestration, capability/policy semantics, Codex-specific invariants, workspace/session attribution, and cross-provider subagent semantics**. Upstream dependencies own **portable provider configuration, standard provider transports where proven, and standard telemetry transport**

---

# 1. What AutoDev actually owns today

AutoDev is already a single repository and already describes itself as the SimulatorLife control plane for reusable GitHub workflows, routing policy, and local AI/provider setup

Current source: [`README.md`](https://github.com/SimulatorLife/AutoDev/blob/main/README.md)

## GitHub control plane

Current `.github/workflows/` owns the scheduler, weighted target/provider selection, provider invocation, PR creation, and continuation workflow

**Keep this in AutoDev.** None of the evaluated dependencies replaces this domain-specific control plane

## Local AI/provider runtime

Current `scripts/` contains substantial custom runtime infrastructure, including:

- `codex-model-router.mjs`
- `codex-model-router.test.mjs`
- `codex-claude-cli-responses-proxy.py`
- `codex-antigravity-cli-responses-proxy.mjs`
- `codex-copilot-cli-responses-proxy.mjs`
- `codex-minimax-responses-proxy.mjs`
- `codex-model-router-dashboard.html`
- `codex-model-router-status.mjs`
- `autodev-metrics.cjs`

This is the main simplification target, but the code is not all generic plumbing

## AutoDev role/capability contract

The editable Codex role TOMLs currently encode more than prompts:

- AutoDev role alias and model-router target
- Read-only versus workspace-write sandbox behavior
- Role-specific MCP exposure
- Role-specific skill enablement
- Provider-independent capability intent

Example: [`scripts/codex/agents/explorer.toml`](https://github.com/SimulatorLife/AutoDev/blob/main/scripts/codex/agents/explorer.toml)

`render-agent-configs.py` composes the base, leaf, code-search, and role prompts because native Codex role TOML has no prompt-file include primitive, and it validates concrete MCP transport shapes and provider-specific reasoning constraints

Source: [`scripts/codex/render-agent-configs.py`](https://github.com/SimulatorLife/AutoDev/blob/main/scripts/codex/render-agent-configs.py)

`render-execution-contract.py` then projects the role TOMLs into the provider-neutral role contract consumed by bridges and child bootstrap logic

Source: [`scripts/codex/render-execution-contract.py`](https://github.com/SimulatorLife/AutoDev/blob/main/scripts/codex/render-execution-contract.py)

**Conclusion:** this is AutoDev domain logic, not merely provider-format translation. Keep it unless a later parity test proves an upstream representation can replace it without losing semantics

## MCP runtime ownership

`run-autodev-mcp.sh` deliberately resolves LSP and Playwright from AutoDev's pinned dependency tree while preserving the active workspace as process CWD, and resolves CocoIndex outside the model-shell permission boundary

Source: [`scripts/codex/run-autodev-mcp.sh`](https://github.com/SimulatorLife/AutoDev/blob/main/scripts/codex/run-autodev-mcp.sh)

**Conclusion:** Rulesync can emit MCP configuration, but it does not replace this runtime launcher or AutoDev's dependency/security behavior

## Provider routing policy

`model-routing.json` currently defines:

- Capability roles and tiers
- Ordered provider groups
- Randomization within provider groups
- Orchestrator-specific provider ordering
- Provider/model mapping
- Provider-specific reasoning effort

Source: [`scripts/codex/model-routing.json`](https://github.com/SimulatorLife/AutoDev/blob/main/scripts/codex/model-routing.json)

The router additionally implements behavior that is more specialized than ordinary failover:

- Native versus bridge-native child execution
- Shared provider-limit semantics
- Multiple cooldown classes
- Provider-corroborated hard limits
- Primary versus last-resort routing passes
- Bounded waiting and chain deadlines
- Stream-terminal backstops
- Responses item-ID repair
- Conversation/workspace continuity
- Cross-provider subagent accounting

Source: [`docs/provider-routing.md`](https://github.com/SimulatorLife/AutoDev/blob/main/docs/provider-routing.md)

**Conclusion:** LiteLLM is not automatically a drop-in replacement for AutoDev routing policy

## Telemetry semantics

AutoDev currently receives Codex OTLP at `/v1/logs`, `/v1/traces`, and `/v1/metrics`, but the dashboard also performs stateful AutoDev-specific attribution:

- `conversation.id` to Codex `state_5.sqlite` thread/workspace joins
- Rollout-derived skill attribution
- Native versus bridge tool attribution with precedence rules
- Bridge-native subagent events invisible to native Codex OTLP
- Fail-closed `unavailable` versus `0` semantics
- GitHub automation metrics

Source: [`docs/metrics-dashboard.md`](https://github.com/SimulatorLife/AutoDev/blob/main/docs/metrics-dashboard.md)

**Conclusion:** OpenTelemetry Collector can replace generic OTLP transport plumbing, but not these semantic joins and attribution rules

---

# 2. Audit of recommended upstream repositories

## Rulesync — **adopt, scoped**

Repository: [`dyoshikawa/rulesync`](https://github.com/dyoshikawa/rulesync)

Audited current release: `v16.30.2` published 2026-09-13

Rulesync explicitly supports cross-tool generation for rules, MCP, commands, subagents, skills, hooks, and permissions, including Claude Code, Codex CLI, GitHub Copilot CLI, and Google Antigravity

Relevant sources:

- [`README.md`](https://github.com/dyoshikawa/rulesync/blob/main/README.md)
- [`docs/reference/supported-tools.md`](https://github.com/dyoshikawa/rulesync/blob/main/docs/reference/supported-tools.md)
- [`docs/guide/configuration.md`](https://github.com/dyoshikawa/rulesync/blob/main/docs/guide/configuration.md)
- [`src/features/subagents/codexcli-subagent.ts`](https://github.com/dyoshikawa/rulesync/blob/main/src/features/subagents/codexcli-subagent.ts)
- [`src/features/mcp/codexcli-mcp.ts`](https://github.com/dyoshikawa/rulesync/blob/main/src/features/mcp/codexcli-mcp.ts)

It also supports:

- Project and global/user-scope generation
- Per-target feature selection
- Multiple output roots for monorepos
- Local developer overrides
- Hook ownership preservation
- Tool-specific MCP overrides
- Codex-specific subagent fields such as model, reasoning effort, sandbox mode, and extra tool-specific fields

### Correct scope

Use Rulesync for **portable configuration translation**:

- Shared/root instructions
- Canonical Agent Skills
- Shared MCP declarations
- Cross-provider hook declarations
- Cross-provider permissions declarations
- Provider filesystem/config-format translation

Do **not** initially use Rulesync as the source of truth for AutoDev's role-capability contract

Keep initially:

- Native AutoDev role TOMLs
- `render-execution-contract.py`
- Prompt composition required by native Codex
- `run-autodev-mcp.sh`
- Role-specific provider skill filtering/views
- Provider-specific exceptions that Rulesync cannot express losslessly

### Why the previous plan was too aggressive

The previous plan listed provider skill-view rendering and large portions of agent-config rendering as likely immediate removals. Rulesync supports Codex subagent serialization, but there is no audited Rulesync abstraction equivalent to AutoDev's generated execution contract linking `readOnly`, MCP sets, skill sets, web-research capability, provider-native spawn tools, and bridge behavior

**Correction:** migrate common configuration first and evaluate role migration only after the shared configuration surfaces are stable

---

## LiteLLM — **conditional pilot, not assumed platform owner**

Repository: [`BerriAI/litellm`](https://github.com/BerriAI/litellm)

Audited current stable release: `v1.100.1` published 2026-09-10

LiteLLM does have strong relevant capabilities:

- OpenAI-compatible `/responses`
- Anthropic Responses support
- GitHub Copilot provider support
- Dedicated GitHub Copilot OAuth device flow
- Dedicated GitHub Copilot Responses transformation
- MiniMax provider support
- Namespace/custom-tool transformation machinery
- Routing, retries, fallbacks, cooldowns, and allowed-failure policy
- Native OpenTelemetry integration

Relevant sources:

- [`README.md`](https://github.com/BerriAI/litellm/blob/main/README.md)
- [`provider_endpoints_support.json`](https://github.com/BerriAI/litellm/blob/main/provider_endpoints_support.json)
- [`litellm/llms/github_copilot/authenticator.py`](https://github.com/BerriAI/litellm/blob/main/litellm/llms/github_copilot/authenticator.py)
- [`litellm/llms/github_copilot/responses/transformation.py`](https://github.com/BerriAI/litellm/blob/main/litellm/llms/github_copilot/responses/transformation.py)
- [`litellm/responses/litellm_completion_transformation/transformation.py`](https://github.com/BerriAI/litellm/blob/main/litellm/responses/litellm_completion_transformation/transformation.py)
- [`litellm/integrations/otel/`](https://github.com/BerriAI/litellm/tree/main/litellm/integrations/otel)

### Important new finding: GitHub Copilot

The previous evaluation understated LiteLLM here. Current LiteLLM has a native GitHub Copilot OAuth authenticator and a dedicated Responses implementation that normalizes streaming item IDs and preserves Copilot reasoning state across turns

That makes the current AutoDev Copilot proxy the **best first deletion candidate**

However, LiteLLM's authenticator currently uses GitHub's `copilot_internal/v2/token` endpoint, and its Responses implementation explicitly says it was based on analysis of the external `copilot-api` project

**Correction:** treat Copilot as a high-value pilot, but keep the existing CLI proxy available until stability, policy, and compatibility are accepted

### Important new finding: Claude Code Max

LiteLLM now explicitly supports forwarding Claude Code Max OAuth headers to the upstream LLM API

That does **not** imply AutoDev's Claude bridge can be removed

AutoDev currently uses Claude Code as an **agent runtime**, not merely an Anthropic HTTP transport. The Claude bridge applies role instructions, role-specific MCP configuration, permissions, skills, and Claude-native `Agent`/`Task` delegation

**Correction:** keep the Claude Code bridge initially. Evaluate a direct Anthropic/LiteLLM route only as a separate architecture change that intentionally gives up or recreates Claude Code runtime semantics

### MiniMax

LiteLLM has a MiniMax provider and generic Responses-to-chat transformation code with namespace and custom-tool handling

This makes the AutoDev MiniMax proxy a credible second deletion candidate

But AutoDev currently performs very specific transformations for Codex namespace tools and custom/freeform `exec` behavior

**Correction:** require exact MiniMax-M3 parity tests before deleting the custom proxy

### Antigravity

The audit found LiteLLM guidance for tracking Antigravity traffic, but no equivalent native Antigravity agent-runtime provider that replaces AutoDev's CLI bridge

**Correction:** keep the Antigravity bridge

### Routing-policy ownership

LiteLLM supports generic routing primitives, but AutoDev's current provider policy contains additional semantics such as provider groups, role-specific ordering, multiple cooldown kinds, corroborated hard limits, last-resort passes, and bounded waits

**Correction:** initially let AutoDev select the concrete provider/model and use LiteLLM only where it removes provider transport/normalization code

Move selection policy into LiteLLM only if either:

1. Exact behavior can be represented and proven
2. AutoDev intentionally simplifies the policy and accepts the behavior change

### Net-deletion requirement

Do not deploy LiteLLM merely as another hop

A LiteLLM migration is successful only when it deletes meaningful AutoDev-owned transport/protocol code or materially simplifies maintenance

---

## OpenTelemetry Collector — **adopt**

Repositories:

- [`open-telemetry/opentelemetry-collector`](https://github.com/open-telemetry/opentelemetry-collector)
- [`open-telemetry/opentelemetry-collector-contrib`](https://github.com/open-telemetry/opentelemetry-collector-contrib)

Audited current Collector release: `v0.160.0` published 2026-09-02

The Collector is explicitly designed to receive, process, and export traces, metrics, and logs. Its OTLP HTTP receiver uses the standard paths AutoDev already exposes:

- `/v1/traces`
- `/v1/metrics`
- `/v1/logs`

Relevant sources:

- [`opentelemetry-collector/README.md`](https://github.com/open-telemetry/opentelemetry-collector/blob/main/README.md)
- [`receiver/otlpreceiver/README.md`](https://github.com/open-telemetry/opentelemetry-collector/blob/main/receiver/otlpreceiver/README.md)
- [`processor/batchprocessor/README.md`](https://github.com/open-telemetry/opentelemetry-collector/blob/main/processor/batchprocessor/README.md)
- [`transformprocessor/README.md`](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/transformprocessor/README.md)

### Correct scope

Use Collector for:

- OTLP ingestion
- Batching
- Stateless transformation/filtering
- Retry/export plumbing
- Fan-out to multiple consumers/backends

Do not use Collector as a substitute for:

- Telemetry storage/query
- `conversation.id` to local SQLite joins
- Rollout-file inspection
- AutoDev workspace identity
- Bridge-native spawn accounting
- AutoDev fail-closed attribution semantics

### Correct migration shape

Insert Collector first as a **tee**, not a replacement:

```text
Codex OTLP -----\
LiteLLM OTel ----> OTel Collector ----> AutoDev semantic aggregator
bridges OTel ----/          \
                              ---> future generic backend
```

Only remove AutoDev's OTLP HTTP receiver after the semantic aggregator has a clean Collector-fed input and parity is proven

The previous plan's phrase “storage routing into Collector” was incorrect. Collector is transport/processing infrastructure, not the storage backend

---

## OpenLLMetry — **defer unless a concrete gap exists**

Repository: [`traceloop/openllmetry`](https://github.com/traceloop/openllmetry)

OpenLLMetry provides GenAI-specific OpenTelemetry instrumentation and supports providers/frameworks including OpenAI, Anthropic, Gemini, LiteLLM, and MCP

Source: [`README.md`](https://github.com/traceloop/openllmetry/blob/main/README.md)

The previous plan included it in the target stack as an optional instrumentation layer. That is unnecessary at the start because AutoDev already has native Codex OTLP, LiteLLM has native OTel, and AutoDev can emit its own semantic events from the remaining bridges

**Correction:** do not install OpenLLMetry initially. Add it only when a specific component lacks sufficient native telemetry and duplicate spans/metrics have been ruled out

---

## Bifrost — **credible contingency, do not stack with LiteLLM**

Repository: [`maximhq/bifrost`](https://github.com/maximhq/bifrost)

Bifrost is a Go AI gateway with provider routing, failover/load balancing, observability, and a current OpenAI Responses implementation

Relevant sources:

- [`README.md`](https://github.com/maximhq/bifrost/blob/dev/README.md)
- [`core/providers/openai/responses.go`](https://github.com/maximhq/bifrost/blob/dev/core/providers/openai/responses.go)

Its current repository contains substantial Responses lifecycle support, so it remains technically credible

However, some advanced capabilities are presented as enterprise features, including areas relevant to AutoDev such as more advanced gateway/plugin functionality

**Decision:** keep Bifrost as the replacement candidate if LiteLLM fails, but never run both as permanent overlapping gateways

---

## Portkey Gateway — **not selected**

Repository: [`Portkey-AI/gateway`](https://github.com/Portkey-AI/gateway)

The project is a capable gateway, but the audited README currently describes Gateway 2.0 as pre-release and the audit did not establish the same level of exact Codex Responses compatibility evidence found in LiteLLM and Bifrost

Source: [`README.md`](https://github.com/Portkey-AI/gateway/blob/main/README.md)

**Decision:** do not add it to this migration

---

## Grimoire — **defer, not rejected for immaturity**

Repository: [`grimoire-rs/grimoire`](https://github.com/grimoire-rs/grimoire)

Grimoire is a package manager for AI-agent configuration. It installs versioned skills, rules, agents, and MCP servers across agent runtimes, uses OCI registries, and pins packages by digest. Its README describes the project as stabilizing toward 1.0 with released surfaces treated as frozen contracts

Source: [`README.md`](https://github.com/grimoire-rs/grimoire/blob/main/README.md)

The previous assessment framed it mainly as too immature. The more precise reason not to adopt it is **scope**

AutoDev currently needs one monorepo source of truth and provider-format generation, not a separate OCI distribution/package-management layer

**Decision:** revisit if AutoDev later needs independently versioned agent bundles distributed across many teams or repositories

---

## Conforme — **not selected**

Repository: [`maxgfr/conforme`](https://github.com/maxgfr/conforme)

Conforme provides broad rule/skill/MCP synchronization, but its own current feature matrix says Codex CLI does not support agents through Conforme

Source: [`README.md`](https://github.com/maxgfr/conforme/blob/main/README.md)

Because AutoDev's native Codex role/subagent model is central, Rulesync is the better fit

---

## AgentSync — **not selected**

Repository: [`x0c/agentsync`](https://github.com/x0c/agentsync)

AgentSync is strong for machine-global synchronization of instructions, skills, and MCP configuration. Its repository mode is much narrower, and it does not provide AutoDev's role/execution-contract semantics

Source: [`README.md`](https://github.com/x0c/agentsync/blob/main/README.md)

Its own FAQ points broader project-level rule generation toward tools such as Rulesync

**Decision:** do not combine it with Rulesync

---

# 3. Discrepancies from the previous plan

| Previous plan | Correctness result | Correction |
|---|---|---|
| “Adopt a single monorepo” as a migration | Misframed | AutoDev is already a single repo; reorganize incrementally inside it |
| Add `apps/`, `packages/`, `pnpm-workspace.yaml` immediately | Unjustified churn | Keep one package until multiple independently packageable JS components exist |
| Rulesync likely removes role renderers early | Overstated | Use Rulesync for portable config first; retain AutoDev role/execution semantics |
| Rulesync likely removes Claude role skill views immediately | Unproven | Retain until per-role skill filtering parity is demonstrated |
| LiteLLM pilot starts with a generic API provider | Too vague | Start with Copilot, then MiniMax, because each could delete a real proxy |
| Copilot likely remains a CLI adapter | Outdated | LiteLLM has direct OAuth + Responses support; pilot replacement |
| Claude bridge can likely narrow to transport | Incomplete | Claude Code is an agent runtime in AutoDev; retain its runtime semantics |
| Generic routing moves to LiteLLM after pilot | Too deterministic | Keep AutoDev selection policy unless exact parity or deliberate simplification is approved |
| OTel Collector can replace OTLP + “storage routing” | Partly wrong | Collector replaces receive/process/export plumbing, not storage or stateful semantic enrichment |
| OpenLLMetry belongs in initial target stack | Premature | Use native Codex/LiteLLM OTel first |
| Router retirement is a migration phase | Premature | Router may shrink into a justified AutoDev edge rather than disappear |
| Bifrost only a generic backup | Still valid but stronger technically | Current Bifrost has substantial Responses support; retain as contingency |
| Grimoire is mainly too immature | Imprecise | Main issue is unnecessary packaging/distribution scope today |

## What the previous plan did well

- Correctly separated AutoDev-specific policy/semantics from generic infrastructure
- Correctly required shadow operation, golden fixtures, parity gates, and rollback
- Correctly identified Rulesync as the strongest cross-provider configuration candidate
- Correctly identified OTel Collector as the standard telemetry transport layer
- Correctly identified LiteLLM as the most promising gateway candidate
- Correctly retained GitHub control-plane logic and AutoDev-specific subagent/workspace semantics
- Correctly avoided a big-bang router replacement

---

# 4. Correct target monorepo

“Monorepo” means **all AutoDev-owned code, policy, configuration, tests, and local-runtime integration live in `SimulatorLife/AutoDev`**

Third-party projects remain pinned upstream dependencies. Do not vendor or copy Rulesync, LiteLLM, OTel Collector, or Bifrost into the repository

```text
AutoDev/
├── .github/
│   └── workflows/                 # Existing GitHub control plane
├── .agents/
│   └── prompts/                   # Existing GitHub-workflow prompt sources
├── .rulesync/
│   ├── rules/                     # Portable shared/root instructions
│   ├── skills/                    # Portable canonical Agent Skills
│   ├── mcp.jsonc                  # Shared/provider-scoped MCP declarations
│   ├── hooks.jsonc                # Portable hook declarations
│   └── permissions.jsonc          # Portable permission declarations
├── rulesync.jsonc
├── config/
│   ├── autodev/
│   │   ├── roles/                 # AutoDev capability TOMLs
│   │   ├── prompts/               # Base/leaf/code-search/role prompt sources
│   │   ├── routing.json           # AutoDev role/provider selection policy
│   │   └── execution-contract.json# Generated AutoDev semantic projection
│   ├── otel/
│   │   └── collector.yaml
│   └── litellm/                   # Create only if pilot passes
│       └── config.yaml
├── runtime/
│   ├── edge/                      # Shrinking Codex/AutoDev compatibility edge
│   ├── providers/
│   │   ├── claude-code/           # Retained initially
│   │   ├── antigravity/           # Retained
│   │   ├── copilot/               # Temporary until LiteLLM parity
│   │   └── minimax/               # Temporary until LiteLLM parity
│   └── telemetry/                 # Stateful AutoDev semantic enrichment/status
├── scripts/
│   ├── install/                   # Bootstrap, install/check, service lifecycle
│   └── mcp/                       # MCP launch/runtime helpers
├── tests/
│   ├── contracts/
│   ├── generated-config/
│   ├── providers/
│   ├── routing/
│   └── telemetry/
├── docs/
├── package.json
└── pnpm-lock.yaml
```

## Organization rules

- Migrate into this shape incrementally as each subsystem changes
- Do not perform a directory-only rewrite before functional migration
- Do not add `pnpm-workspace.yaml` until there are multiple actual JS packages
- Do not turn generated provider files into sources of truth
- Keep machine-local secrets, OAuth tokens, trusted hashes, user paths, and project trust state out of portable canonical configuration
- Prefer exact pinned dependency versions and deterministic generation

---

# 5. Correct target runtime architecture

## Provider path — initial target

```text
Codex CLI / Desktop
        |
        v
AutoDev edge
  - role alias resolution
  - provider-selection policy
  - concurrency/delegation policy
  - workspace/session continuity
  - Codex Responses invariants
  - AutoDev semantic events
        |
        +--> Claude Code bridge ----------> Claude Code CLI
        |
        +--> Antigravity bridge ----------> Antigravity CLI
        |
        +--> LiteLLM ---------------------> GitHub Copilot
        |                           \
        |                            +----> MiniMax if parity passes
        |
        +--> existing Codex/ChatGPT backend
```

The key change is that LiteLLM first replaces **provider transports**, not AutoDev policy

## Optional later provider path

Only after routing-policy parity or an intentional policy simplification:

```text
Codex
  |
AutoDev compatibility edge
  |
LiteLLM routing
  |
providers / remaining adapters
```

This is an option, not a required end state

## Telemetry path

```text
Codex native OTLP -----\
LiteLLM native OTel ----> OpenTelemetry Collector ---> generic backend(s)
provider bridges OTel --/             |
                                      +--> AutoDev semantic enricher
                                           - workspace joins
                                           - rollout/skill attribution
                                           - spawn accounting
                                           - fail-closed semantics
```

---

# 6. Correct migration order

## Phase 0 — Freeze observable contracts

Inventory and test the behavior before replacing anything

### Status

The first Phase 0 slice is landed: the generated execution contract
(`scripts/codex/execution-contract.json`) is frozen against a canonical
fixture at `tests/fixtures/contracts/execution-contract.json`.
`tests/test_local_setup.py::LocalSetupTests::test_execution_contract_matches_frozen_phase0_baseline_fixture`
asserts that both the tracked artifact and a fresh render from the role TOML
sources match that fixture byte-for-byte (as parsed JSON), so any future
refactor of role rendering (including a Rulesync migration) has an executable
baseline to diff against instead of "whatever the renderer currently
produces." Updating the fixture is itself the documented, intentional signal
that the contract's shape was meant to change.

All other Phase 0 capture areas listed below remain future work.

### Capture

- Role TOML inputs and rendered role outputs
- Generated execution contract (frozen — see Status above)
- Provider request/response fixtures
- Streaming event sequences
- Namespace/custom/freeform tool behavior
- Responses item-ID continuation behavior
- Provider selection order and randomization
- Cooldown and provider-limit behavior
- Root versus subagent provider selection
- Workspace attribution
- Tool/skill/MCP attribution
- Native versus bridge-native child counts
- Dashboard/status snapshots

### Exit gate

Every behavior being migrated has an executable fixture or an explicit documented exception

---

## Phase 1 — Separate portable versus machine-local configuration

Current tracked `scripts/codex/config.toml` includes portable AutoDev settings and machine-specific state such as absolute user paths, trusted hook hashes, project trust entries, and local marketplace paths

### Change

- Define which keys are AutoDev-owned and portable
- Define which keys are machine/user-owned
- Stop treating the entire user `~/.codex/config.toml` as one portable artifact
- Preserve user-owned keys during every generator/install operation
- Keep a small installer/composer for AutoDev-specific Codex keys that Rulesync does not own

### Exit gate

Fresh install and update can converge AutoDev-owned configuration without deleting or committing machine-local state

### Status

Complete. The portable source is authoritative at `scripts/codex/config.autodev.toml`: it carries the AutoDev-owned portable scalars, provider definitions, `sandbox_workspace_write`, `otel`, `analytics`, `features`, `tools`, `agents`, the declared hooks (without `hooks.state`), the AutoDev MCP servers (`lsp`, `cocoindex-code`, `playwright`), the AutoDev-owned skills (`ccc`, `lsp-mcp-server`, `orchestration`), and `shell_environment_policy`. It excludes `notify`, `hooks.state`, `projects`, `marketplaces`, TUI/notice/desktop/apps/plugins/memories, `node_repl`/`cua_repl`, non-AutoDev skills, and absolute user/application paths. `scripts/codex/compose-user-config.py` deterministically merges the portable source with existing machine-local configuration into `$CODEX_HOME/config.toml` as an atomic regular file, resolving conflicts in favor of AutoDev while semantically preserving machine-local and user-owned values. The installer (`install-codex-integration.sh`), `--check` drift validation, and `render-execution-contract.py` consume `config.autodev.toml` and the composer. Legacy `scripts/codex/config.toml` is retired from being authoritative and remains only as a one-time migration seed.

---

## Phase 2 — Adopt Rulesync for shared configuration

### Status

The Phase 2 slices are shadow-only MCP translation, shared-instruction
translation, and canonical-skill translation. Rulesync is pinned to `16.30.2`
and generates into tracked fixtures under `tests/fixtures/rulesync-shadow/` for
`codexcli`, `claudecode`, `copilot`, and `antigravity-cli`.

The Rulesync source covers shared MCP declarations, the common repository
instructions represented by `AGENTS.md`, and the three portable AutoDev-owned
skills (`ccc`, `lsp-mcp-server`, and `orchestration`). It produces target-shaped
shadow files for rules plus skill trees under `.agents/skills/`,
`.claude/skills/`, and `.github/skills/` without writing live provider or user
configuration. Existing live instructions remain unchanged so target-specific
guidance is not silently removed during this parity phase.

Role-specific skill assignment and exposure remain AutoDev-owned: the execution
contract, provider skill-view renderer, Claude role views, Antigravity
`include_only` registration, symlink installer, MCP launcher, provider
bridges, hooks, and permissions remain outside Rulesync.

CI drift protection is enforced by `.github/workflows/rulesync-mcp-shadow-drift.yml`, a
read-only workflow triggered on `push` to `main`, `pull_request`, and `workflow_dispatch`
(path-filtered to `.rulesync/**`, `rulesync.jsonc`, `tests/fixtures/rulesync-shadow/**`,
`package.json`, `pnpm-lock.yaml`, and the workflow file itself). The workflow installs frozen
dependencies and detects drift using:

```bash
pnpm exec rulesync generate \
  --config rulesync.jsonc \
  --targets codexcli,claudecode,copilot,antigravity-cli \
  --features mcp,rules,skills \
  --output-roots tests/fixtures/rulesync-shadow \
  --check \
  --silent
```

### Remediation

When the CI drift check or local `--check` reports drift due to intentional updates to `.rulesync/` or `rulesync.jsonc`:

1. Refresh the tracked shadow fixtures using the pinned generation command:
   ```bash
   pnpm exec rulesync generate \
     --config rulesync.jsonc \
     --targets codexcli,claudecode,copilot,antigravity-cli \
     --features mcp,rules,skills \
     --output-roots tests/fixtures/rulesync-shadow \
     --delete \
     --silent
   ```
2. Verify that focused tests pass:
   ```bash
   python3 -m unittest tests/test_rulesync_mcp_shadow.py
   python3 -m unittest tests/test_rulesync_skills_shadow.py
   ```
3. Commit the refreshed fixtures under `tests/fixtures/rulesync-shadow/`.

Pin an exact tested Rulesync version rather than tracking `latest`

### Migrate first

- Root/shared instructions
- Canonical skills
- Shared MCP declarations
- Hook declarations
- Permissions declarations

### Process

1. Import/translate existing sources into `.rulesync/`
2. Generate into an isolated shadow root
3. Diff against current Codex/Claude/Copilot/Antigravity outputs
4. Test global and project scopes separately
5. Verify unrelated user config survives
6. Add CI drift checks (enforced via `.github/workflows/rulesync-mcp-shadow-drift.yml`)
7. Switch one generated surface at a time

### Keep outside Rulesync initially

- AutoDev role TOMLs
- Execution-contract generation
- Role-specific MCP/skill capability decisions
- Prompt composition
- MCP runtime launcher
- Provider bridge behavior

### Exit gate

Rulesync-generated portable surfaces are behaviorally equivalent and preserve unrelated user configuration

---

## Phase 3 — Insert OpenTelemetry Collector as OTLP ingress

Pin an exact tested Collector build

### Status

The Phase 3 slices are contract-only. `config/otel/collector.version`
pins the audited build at `v0.160.0`, and `config/otel/collector.yaml`
describes an inactive OTLP HTTP ingress on `127.0.0.1:4318` forwarding JSON
batches to the existing AutoDev receiver at `http://127.0.0.1:4100`.

The HTTP-level contract is also frozen by
`tests/fixtures/otel/collector-forwarded-otlp.json` and focused router tests:
real loopback POSTs to `/v1/logs`, `/v1/traces`, and `/v1/metrics` must accept
Collector-shaped OTLP JSON batches, preserve existing semantic aggregation,
reject malformed JSON, and avoid prompt-content leakage. A repeated-batch
regression test also confirms receiver transport counters may advance while
cumulative metrics, tool results, sessions, and semantic rows do not double-count.

The additive semantic attribute contract is frozen in
`tests/fixtures/otel/autodev-attributes-schema.json`. It defines the seven
`autodev.*` keys, their resource/event scope, and signal applicability without
changing the existing unprefixed attribute lookup behavior; emission remains
opt-in and disabled by default.
The corresponding emission mapping is frozen separately in
`tests/fixtures/otel/autodev-attributes-emission-contract.json`: it specifies
how semantic enrichment adds optional namespaced attributes while preserving
the existing wire keys and omitting unknown values. The router-side emitter is
implemented behind `AUTODEV_OTEL_ATTRIBUTES=v1` and remains disabled by default.

No Collector binary is installed or launched, Codex still exports directly to
port `4100`, and no default/release-mode provider, launch-agent, SQLite,
dashboard, or semantic-enrichment behavior changes. The Collector configuration
remains a validated contract fixture only. Any future exporter targeting the current
AutoDev receiver must set `encoding: json`; the receiver currently parses OTLP
JSON and does not accept the Collector exporter's protobuf default.

Rollback for this slice is limited to removing the version/config fixture,
HTTP fixture, semantic-attribute schemas, and contract tests; no runtime rollback
is required.

### First deployment

```text
Codex -> Collector -> existing AutoDev OTLP aggregator
                  \-> optional generic backend
```

### Then

- Point LiteLLM telemetry at Collector during pilots
- Point remaining provider bridges at Collector
- Move generic batching/filtering/retry/export behavior out of AutoDev
- Define AutoDev semantic attributes under an `autodev.*` namespace

Suggested attributes:

- `autodev.role`
- `autodev.workspace`
- `autodev.provider`
- `autodev.model`
- `autodev.spawn.mechanism`
- `autodev.skill`
- `autodev.mcp.server`

### Do not remove yet

- SQLite/workspace enrichment
- Rollout/skill attribution
- Bridge-native spawn accounting
- Existing status/dashboard aggregation

### Exit gate

Existing AutoDev metrics remain identical in meaning and do not double-count after Collector insertion

---

## Phase 4 — LiteLLM pilot 1: GitHub Copilot

### Status

The initial Phase 4 slice is an offline golden-fixture contract for the
incumbent Copilot Responses boundary. It freezes representative JSONL tool,
skill-read, normal-turn, permission-denied, and provider-limit inputs plus the
expected SSE lifecycle and error-shape invariants without installing LiteLLM,
contacting GitHub, or changing the current Copilot proxy. It is a parity
baseline only; it does not authorize proxy deletion or claim live LiteLLM
compatibility.

This is the strongest current transport-replacement candidate

### Compare against current Copilot proxy

- OAuth/bootstrap behavior
- Responses request fidelity
- Streaming event fidelity
- Reasoning/encrypted state across turns
- Tool/function/custom tool behavior
- Item IDs
- Error mapping
- Cancellation
- Usage telemetry
- Long-running turns

### Explicit risk review

LiteLLM currently uses GitHub's internal Copilot token endpoint, so validate operational and policy acceptability before removing the CLI path

### Exit gate

Delete the AutoDev Copilot proxy only if LiteLLM is at least behaviorally equivalent and the replacement removes more complexity than it introduces

---

## Phase 5 — LiteLLM pilot 2: MiniMax-M3

Test the exact AutoDev contract, not just basic text generation

### Required parity

- `/responses` behavior
- `multi_agent_v1` namespace handling
- Namespace flatten/re-expansion
- Custom/freeform `exec`
- Tool choice
- Streaming
- Item IDs
- Multi-turn continuation
- Reasoning effort `none` and `high`
- Error/retry behavior
- Usage telemetry

### Exit gate

Retire `codex-minimax-responses-proxy.mjs` only after all required Codex tool patterns pass

---

## Phase 6 — Shrink the AutoDev router around retained semantics

After provider transport migrations, separate router responsibilities into:

### Keep

- Role/provider selection policy
- Root/subagent constraints
- Concurrency
- Provider-limit semantics that are not delegated
- Workspace/session continuity
- Required Responses compatibility repairs
- AutoDev semantic telemetry

### Delete where upstream now owns it

- Migrated provider HTTP/OAuth transport
- Duplicated generic response normalization
- Duplicated generic retry/health code
- Duplicated provider metrics

### Exit gate

Router code size and responsibility are materially reduced while all Phase 0 contracts still pass

---

## Phase 7 — Decide whether LiteLLM should own provider selection

Do not assume this migration will happen

Compare LiteLLM against AutoDev's current semantics:

- Ordered provider groups
- Randomization within groups
- Role-specific tiers
- Orchestrator-specific ordering
- Transient/hard/probe/config cooldown classes
- Provider-corroborated hard-limit behavior
- Primary/last-resort passes
- Bounded wait
- Chain deadline

### Outcome A — parity

Represent the policy declaratively in LiteLLM and remove the corresponding AutoDev implementation

### Outcome B — deliberate simplification

Adopt simpler LiteLLM behavior only with an explicit accepted behavior change

### Outcome C — no fit

Keep AutoDev selection policy. This is acceptable if it remains small and domain-specific

---

## Phase 8 — Split telemetry transport from AutoDev semantic enrichment

Once Collector is stable:

- Make the AutoDev telemetry component consume standard OTel-derived events instead of acting as a generic OTLP server
- Convert bridge-native child events to normal OTel logs/spans where practical
- Keep stateful local joins in the AutoDev enricher
- Select a local telemetry backend separately if generic querying/history is needed
- Remove generic dashboard panels already better served by LiteLLM or the selected telemetry backend

### Keep AutoDev UI only for AutoDev-specific views

- Orchestrator/subagent topology
- Role activity
- Workspace attribution
- Skill exposure/use
- MCP exposure/use
- GitHub automation
- AutoDev provider-policy state

---

## Phase 9 — Re-evaluate deeper Rulesync role migration

Only now test whether Rulesync can replace more AutoDev role rendering

### Prove round-trip parity for

- Role names/descriptions
- Prompt composition
- Sandbox/read-only state
- Model aliases
- Reasoning effort
- Per-role MCP exposure
- Per-role skill exposure
- Root orchestrator versus leaf distinctions
- Claude role-specific discovery
- Antigravity limitations

### Outcome

- If exact, remove the corresponding AutoDev renderer
- If not exact, retain the small semantic renderer rather than forcing the abstraction

---

## Phase 10 — Final cleanup

- Remove launch agents and ensure scripts for retired services
- Keep only the bootstrap/service lifecycle still required by Collector, LiteLLM, remaining bridges, MCP runtime, and AutoDev edge
- Remove unreachable compatibility shims
- Update docs and diagrams
- Keep rollback fixtures as regression tests

---

# 7. Requirements

- Local-first operation with no mandatory hosted control plane
- Preserve existing subscription-backed authentication unless a migration explicitly changes it
- Preserve role/capability behavior and read-only isolation
- Preserve root-orchestrator and bridge-native child semantics
- Preserve Codex Responses streaming/tool/item/session behavior
- Preserve existing provider-selection policy by default
- Preserve fail-closed telemetry attribution where `unavailable` is not `0`
- Never double-count native and bridge telemetry
- Keep machine-local state user-owned
- Keep generated configuration deterministic and testable
- Pin upstream dependencies to tested versions
- Require rollback per subsystem
- Require net deletion/simplification before adding a permanent infrastructure layer

---

# 8. Remaining unknowns

## Rulesync

- Exact fit for AutoDev's per-role MCP/skill capability model
- Whether all Claude/Antigravity role-specific discovery behavior can be generated without custom views
- Which current user-level Codex settings should remain outside Rulesync permanently

## LiteLLM

- GitHub Copilot internal-API stability and policy acceptability
- Exact MiniMax-M3 namespace/custom/freeform-tool parity
- Whether AutoDev routing semantics can be represented without custom callbacks
- Whether direct ChatGPT/Codex OAuth/provider support is suitable for AutoDev's current ChatGPT Codex backend path
- Whether any future direct Anthropic path can preserve the benefits AutoDev currently gets from running Claude Code itself

## Telemetry

- Which local backend, if any, should store/query generic OTel data
- Whether bridge-native `/v1/agent-events` can be fully replaced with normal OTel events
- Which current dashboard panels remain valuable after generic observability moves upstream

---

# 9. Expected deletion outcome

## Strong deletion targets

- Repeated cross-provider rules/MCP/hooks/permissions translation
- Generic OTLP HTTP receive/process/export plumbing
- Copilot Responses proxy if LiteLLM pilot passes
- MiniMax Responses proxy if LiteLLM pilot passes
- Generic provider metrics already emitted by LiteLLM/OTel
- Generic provider transport/retry/health code that becomes redundant

## Likely justified AutoDev code after migration

- GitHub control plane
- Role/capability contract
- Prompt composition where native tools require it
- Execution-contract projection
- MCP launcher/runtime boundary
- Claude Code agent-runtime bridge
- Antigravity agent-runtime bridge
- Small Codex/AutoDev compatibility edge
- Provider-selection policy if LiteLLM cannot model it cleanly
- Stateful telemetry enricher
- AutoDev-specific dashboard/status views

The success criterion is therefore **not “delete the router at all costs.”** It is to leave AutoDev with only the code that encodes SimulatorLife/AutoDev-specific semantics and remove generic infrastructure wherever a supported upstream implementation demonstrably replaces it
