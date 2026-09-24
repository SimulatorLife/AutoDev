# AutoDev Platform Simplification — Corrected Audit & Migration Plan

> Correctness pass against the current `SimulatorLife/AutoDev` repository and the audited upstream repositories as of 2026-09-14

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
| Codex/OpenAI subscription access | Keep OAuth-native | Codex native model provider |
| Claude subscription access | Prefer OAuth-native Codex provider if parity is proven | Current Claude CLI bridge until a replacement passes all gates |
| Antigravity subscription access | Prefer OAuth-native Codex provider if parity is proven | Current Antigravity CLI bridge until a replacement passes all gates |
| Copilot subscription access | Prefer OAuth-native Codex provider if parity is proven | Current Copilot CLI/proxy until a replacement passes all gates |
| MiniMax access | Keep API-key-backed | Existing Codex model provider; remove bespoke proxy only if parity passes |
| Provider CLIs in the model path | Evaluate for retirement provider-by-provider | Retain any CLI/bridge that is not fully replaced by a proven alternative |
| Generic GenAI instrumentation | Do not add initially | Native OTel first; OpenLLMetry only if a gap remains |
| Alternative gateway | Contingency only | Bifrost |
| Agent-config package distribution | Defer | Grimoire if later needed |

**Architectural rule:** Codex is the agent runtime. AutoDev owns **GitHub orchestration, capability/policy semantics, Codex-specific invariants, workspace/session attribution, and cross-provider subagent semantics**. Upstream dependencies own **portable provider configuration, standard provider transports where proven, and standard telemetry transport**. Direct OAuth/API-backed Codex model providers are the preferred simplification target, but provider CLIs and bridges remain supported incumbent paths until a candidate replacement has been verified against AutoDev's full contract. CLI removal is an outcome of successful validation, not an assumption of the migration.

---

# 1. What AutoDev actually owns today

AutoDev is already a single repository and already describes itself as the SimulatorLife control plane for reusable GitHub workflows, routing policy, and local AI/provider setup

Current source: [`README.md`](https://github.com/SimulatorLife/AutoDev/blob/main/README.md)

## GitHub control plane

Current `.github/workflows/` owns the scheduler, weighted target/provider selection, provider invocation, PR creation, and continuation workflow

**Keep this in AutoDev.** None of the evaluated dependencies replaces this domain-specific control plane

## Local AI/provider runtime

Current source/runtime paths contain substantial custom infrastructure, including:

- `src/router/server.ts` (decomposed from legacy `codex-model-router.mjs` into modular `src/router/*`)
- `tests/router/model-router.test.ts` (migrated from legacy `codex-model-router.test.mjs`)
- `src/providers/claude.ts`
- `src/providers/antigravity.ts`
- `src/providers/copilot.ts`
- `src/providers/minimax.ts`
- `codex-model-router-dashboard.html`
- `src/cli/router-status.ts`
- `src/telemetry/github-metrics.ts` (migrated from legacy `autodev-metrics.cjs`)
- `tests/metrics.test.ts` (migrated from legacy `tests/metrics.test.mjs`)

This is the main simplification target, fully unified under native TypeScript on Node 24+ LTS.

## AutoDev role/capability contract

The editable Codex role TOMLs currently encode more than prompts:

- AutoDev role alias and model-router target
- Read-only versus workspace-write sandbox behavior
- Role-specific MCP exposure
- Role-specific skill enablement
- Provider-independent capability intent

Example: [`agents/roles/explorer.toml`](https://github.com/SimulatorLife/AutoDev/blob/main/agents/roles/explorer.toml)

`src/config/render-agent-configs.ts` composes the base, leaf, code-search, and role prompts because native Codex role TOML has no prompt-file include primitive, and it validates concrete MCP transport shapes and provider-specific reasoning constraints

Source: [`src/config/render-agent-configs.ts`](https://github.com/SimulatorLife/AutoDev/blob/main/src/config/render-agent-configs.ts)

`src/config/render-execution-contract.ts` then projects the role TOMLs into the provider-neutral role contract consumed by bridges and child bootstrap logic

Source: [`src/config/render-execution-contract.ts`](https://github.com/SimulatorLife/AutoDev/blob/main/src/config/render-execution-contract.ts)

**Conclusion:** this is AutoDev domain logic, not merely provider-format translation. Keep it unless a later parity test proves an upstream representation can replace it without losing semantics

## MCP runtime ownership

`run-autodev-mcp.sh` deliberately resolves LSP and Playwright from AutoDev's pinned dependency tree while preserving the active workspace as process CWD, and resolves CodeGraphContext and CocoIndex outside the model-shell permission boundary

Source: [`scripts/run-autodev-mcp.sh`](https://github.com/SimulatorLife/AutoDev/blob/main/scripts/run-autodev-mcp.sh)

**Conclusion:** Rulesync can emit MCP configuration, but it does not replace this runtime launcher or AutoDev's dependency/security behavior

## Provider routing policy

`model-routing.json` currently defines:

- Capability roles and tiers
- Ordered provider groups
- Randomization within provider groups
- Orchestrator-specific provider ordering
- Provider/model mapping
- Provider-specific reasoning effort

Source: [`config/model-routing.json`](https://github.com/SimulatorLife/AutoDev/blob/main/config/model-routing.json)

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

## Current Codex model-provider shape

`config/config.autodev.toml` already exposes the external routes through Codex's `[model_providers.*]` mechanism. MiniMax is already represented as `[model_providers.minimax]` and uses `MINIMAX_API_KEY`, but its current `base_url` still points at the bespoke local MiniMax Responses proxy. Claude and Antigravity are likewise represented as Codex model providers, but those entries currently point at CLI-backed local bridges

**Conclusion:** the preferred simplification is to keep Codex as the harness and test whether each `[model_providers.*]` endpoint can reach the provider through OAuth or API credentials without invoking that provider's CLI. The existing CLI-backed endpoint remains authoritative for that provider unless and until a replacement proves equivalent behavior

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
- Shared MCP declarations (live: `.rulesync/mcp.jsonc` is the only MCP source for Codex, Claude Code, Copilot CLI, and Antigravity)
- Cross-provider hook declarations
- Cross-provider permissions declarations
- Provider filesystem/config-format translation

Do **not** initially use Rulesync as the source of truth for AutoDev's role-capability contract

Keep initially:

- Native AutoDev role TOMLs
- `src/config/render-execution-contract.ts`
- Prompt composition required by native Codex
- `run-autodev-mcp.sh`
- Role-specific provider skill filtering/views
- Provider-specific exceptions that Rulesync cannot express losslessly

Migrate common configuration first and evaluate role migration only after the shared configuration surfaces are stable.

---

## LiteLLM — **conditional transport/auth candidate, not assumed platform owner**

Repository: [`BerriAI/litellm`](https://github.com/BerriAI/litellm)

Audited current stable release: `v1.100.1` published 2026-09-10

LiteLLM has strong relevant capabilities:

- OpenAI-compatible `/responses`
- Anthropic Responses support
- Anthropic bearer/OAuth authentication through `ANTHROPIC_AUTH_TOKEN`
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
- [`litellm/llms/anthropic/common_utils.py`](https://github.com/BerriAI/litellm/blob/main/litellm/llms/anthropic/common_utils.py)
- [`litellm/llms/github_copilot/authenticator.py`](https://github.com/BerriAI/litellm/blob/main/litellm/llms/github_copilot/authenticator.py)
- [`litellm/llms/github_copilot/responses/transformation.py`](https://github.com/BerriAI/litellm/blob/main/litellm/llms/github_copilot/responses/transformation.py)
- [`litellm/responses/litellm_completion_transformation/transformation.py`](https://github.com/BerriAI/litellm/blob/main/litellm/responses/litellm_completion_transformation/transformation.py)
- [`litellm/integrations/otel/`](https://github.com/BerriAI/litellm/tree/main/litellm/integrations/otel)

These capabilities make LiteLLM worth testing, but they do not establish AutoDev parity by themselves. A provider is migrated only after the exact AutoDev boundary contract passes against the candidate transport

### GitHub Copilot

Current LiteLLM has a native GitHub Copilot OAuth authenticator and a dedicated Responses implementation that normalizes streaming item IDs and preserves Copilot reasoning state across turns

That makes the current AutoDev Copilot CLI/proxy path a strong candidate for simplification

LiteLLM's authenticator currently uses GitHub's `copilot_internal/v2/token` endpoint, and its Responses implementation explicitly says it was based on analysis of the external `copilot-api` project

**Preferred target, conditional on validation:** expose Copilot through a normal `[model_providers.*]` route backed by Copilot OAuth and Responses translation, without a Copilot CLI in the request path. If stability, policy, authentication, or Responses/tool parity is not acceptable, retain the incumbent Copilot CLI/proxy path

**Evaluated 2026-09-15: not acceptable; the incumbent is retained.** See Phase 4, GitHub Copilot OAuth pilot.

### Claude Code Max / Anthropic OAuth

The earlier plan was too conservative in treating Claude Code itself as inherently required. LiteLLM does more than forward a Claude Code client's headers: its Anthropic provider can use `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer ...`, recognizes Anthropic OAuth token handling, and adds the required OAuth beta header

More importantly, AutoDev's current Claude bridge explicitly disables Claude Code's `Agent`/`Task` tools and states that the parent Codex process remains responsible for orchestration. The bridge is therefore not required merely because AutoDev needs Claude Code to be a second agent harness; today it also serves subscription authentication, protocol/tool translation, limits, permissions, and telemetry behavior that a replacement must reproduce or make unnecessary

**Preferred target, conditional on validation:** configure Claude as a normal Codex model provider using Claude subscription OAuth, with LiteLLM providing Responses↔Anthropic translation/authentication if it proves sufficient. Codex continues to own roles, tools, MCP, skills, sandboxing, and orchestration. Retain the Claude Code CLI bridge if the replacement does not fully satisfy the contract

**Evaluated 2026-09-15: not permitted; the bridge is retained permanently.** See Phase 4, Claude OAuth pilot.

The migration requires parity tests for Responses streaming, namespace/custom/freeform tools, multi-turn tool continuation, reasoning, rate limits, OAuth bootstrap/refresh/expiry, model selection, error fidelity, permissions, and telemetry before deleting the bridge

### MiniMax

LiteLLM has a MiniMax provider and generic Responses-to-chat transformation code with namespace and custom-tool handling

AutoDev already exposes MiniMax through Codex's native model-provider configuration and authenticates it with `MINIMAX_API_KEY`; the remaining custom part is that the provider entry currently targets `src/providers/minimax.ts` rather than the MiniMax API or a shared gateway directly

**Preferred target, conditional on validation:** keep MiniMax API-key usage and remove the bespoke MiniMax proxy only if direct provider support or LiteLLM can preserve the exact Codex Responses/tool contract. MiniMax does not need an OAuth/subscription migration, and the current proxy remains valid if no simpler path reaches parity

**Evaluated 2026-09-15: MiniMax speaks the Responses contract natively, but a direct transport cannot provide the machine boundary, `exec` coercion, or telemetry. The proxy is retained as a slimmer boundary adapter.** See Phase 5.

### Antigravity

The audit found LiteLLM guidance for tracking Antigravity traffic, but no equivalent native Antigravity OAuth provider that has been proven to replace AutoDev's CLI bridge today

That means the replacement path is unproven, not predetermined

**Preferred target, conditional on validation:** expose Antigravity through a normal Codex `[model_providers.*]` entry using OAuth/subscription credentials through a compatible direct or shared protocol adapter, without launching the Antigravity CLI. Retain the current CLI bridge unless a supported OAuth transport and equivalent Responses/tool/permission/telemetry semantics are demonstrated

**Evaluated 2026-09-15: no supported subscription transport without `agy` exists; the bridge is retained.** See Phase 4, Antigravity OAuth pilot.

### Codex/OpenAI

Codex itself should remain on its native subscription/OAuth path. AutoDev should not introduce another OpenAI/Codex CLI wrapper merely for authentication

### Routing-policy ownership

LiteLLM supports generic routing primitives, but AutoDev's current provider policy contains additional semantics such as provider groups, role-specific ordering, multiple cooldown kinds, corroborated hard limits, last-resort passes, and bounded waits

**Correction:** initially let AutoDev select the concrete provider/model. Test LiteLLM as a shared protocol/auth transport only where it may let Codex address a provider without a bespoke provider CLI or proxy

Move selection policy into LiteLLM only if either:

1. Exact behavior can be represented and proven
2. AutoDev intentionally simplifies the policy and accepts the behavior change

### Net-deletion requirement

Do not deploy LiteLLM merely as another hop

A LiteLLM migration is successful only when it passes the provider's full parity gates and deletes meaningful AutoDev-owned CLI/proxy/protocol code or materially simplifies maintenance. If it fails those gates, keep the incumbent provider path

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

The previous plan included it in the target stack as an optional instrumentation layer. That is unnecessary at the start because AutoDev already has native Codex OTLP, LiteLLM has native OTel, and AutoDev can emit its own semantic events from the remaining compatibility paths

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
| Rulesync likely removes Claude role skill views immediately | Superseded | Removed outright on 2026-09-18: Claude turns act only through Codex's tools and read skills from Codex's own catalogue, so no Claude-specific view remains |
| LiteLLM pilot starts with a generic API provider | Too vague | Prioritize provider paths that could delete real CLI/proxy layers, but only after provider-specific parity testing |
| Copilot likely remains a CLI adapter | Outdated capability assumption | LiteLLM has direct OAuth + Responses support; test it, but retain the CLI/proxy unless parity passes |
| Claude Code must remain because it is the agent runtime | Incorrect rationale | Current bridge disables Claude `Agent`/`Task`; Codex remains the harness, so direct Claude OAuth is worth testing, not presumed sufficient |
| Antigravity CLI is a permanent provider boundary | Too deterministic | Test for an OAuth-native model-provider replacement; retain the CLI if no candidate reaches parity |
| Provider CLIs are migration-only compatibility mechanisms | Too strong | They are incumbent supported paths and become removable only after a replacement is proven |
| MiniMax needs a subscription-style migration | Incorrect | Keep API-key usage; only remove the bespoke Responses proxy if upstream parity permits |
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
│   └── litellm/                   # Shared transport/auth config only after provider pilots pass
│       └── config.yaml
├── runtime/
│   ├── edge/                      # Shrinking Codex/AutoDev compatibility edge
│   ├── providers/                 # Incumbent provider-specific paths, removed only after proven replacement
│   │   ├── claude/                # Candidate for deletion after OAuth-native parity
│   │   ├── antigravity/           # Candidate for deletion after OAuth-native parity
│   │   ├── copilot/               # Candidate for deletion after OAuth-native parity
│   │   └── minimax/               # Candidate for deletion if shared/direct API transport reaches parity
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

# 5. Preferred provider target architecture

A **native Codex model provider** here means a normal Codex `[model_providers.*]` entry. Its endpoint may be the provider directly or a shared LiteLLM compatibility endpoint when protocol translation is required. Avoiding a provider CLI in the request path is the preferred simplification, not a precondition or predetermined end state

Codex remains the sole intended agent harness and therefore owns tools, MCP, skills, sandboxing, orchestration, and child-agent behavior. Ideally (as/if/wherever possible), all config, agents, MCPs, rules, permissions, skills, etc. are defined via rulesync as the sole/single source of truth. The intended *developer experience* is that the Codex CLI/desktop is the only tool the developer needs interact with to use agents.

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
        +--> Codex/OpenAI model provider ---- OAuth/subscription ----> OpenAI/Codex backend
        |
        +--> Claude model provider ---------- OAuth ---------------> direct or LiteLLM/Anthropic -> Claude
        |
        +--> Copilot model provider --------- OAuth ---------------> direct or LiteLLM/Copilot -> GitHub Copilot
        |
        +--> Antigravity model provider ----- OAuth ---------------> compatible direct/shared adapter -> Antigravity
        |
        +--> MiniMax model provider --------- API key -------------> direct/shared adapter -> MiniMax API
```

Each non-incumbent path in this diagram is a **candidate target** until it passes the provider migration gate below. The current Claude, Antigravity, Copilot, and MiniMax bridges/proxies remain valid supported paths during evaluation and remain in place indefinitely if no simpler implementation proves equivalent

### Provider migration gate

A provider CLI/bridge/proxy may be retired only after its candidate replacement proves all applicable requirements against the frozen incumbent contract:

- Authentication bootstrap, refresh/expiry, secure storage, and subscription/API billing semantics
- Responses request and SSE streaming fidelity
- Function, namespace, MCP, custom, and freeform tool behavior
- Tool-call → tool-result → continuation behavior and item-ID fidelity
- Reasoning effort, model selection, context limits, and provider-specific parameters
- Provider-limit classification, reset timing, retry behavior, cancellation, and long-running turns
- Role/capability, read-only, permission, workspace, and orchestration invariants
- Usage, tool, skill, MCP, workspace, spawn, and provider telemetry semantics
- Operational stability, supported upstream behavior, upgrade risk, and acceptable policy/API dependencies
- Equal-or-lower maintenance complexity with a clear rollback path

Failure of any required gate means **retain the incumbent provider path** unless AutoDev explicitly accepts a documented behavior change

### Preferred authentication shape

| Provider | Preferred authentication | Candidate execution path if parity passes | Incumbent fallback |
|---|---|---|---|
| Codex/OpenAI | OAuth/subscription | Native Codex provider | Existing native path |
| Claude | OAuth/subscription (hard requirement), usable only by Claude Code and native Anthropic apps | None: subscription OAuth failed the policy gate and API-key billing was rejected (2026-09-15) | Claude Code bridge (permanent) |
| Antigravity | OAuth/subscription (hard requirement) | None: third-party access with Antigravity OAuth breaches Google's terms, and the non-CLI SDK and Gemini API agent are API-key billed (2026-09-15) | Antigravity CLI bridge (retained; open policy question) |
| GitHub Copilot | OAuth/subscription (hard requirement) | None without the Copilot CLI: LiteLLM's route depends on an undocumented endpoint and a borrowed editor OAuth client (2026-09-15). A supported Copilot SDK/`--acp` session is an incumbent-simplification candidate | Copilot CLI/proxy (retained) |
| MiniMax | API key | Direct transport evaluated and rejected (2026-09-15): it would leak workspace metadata, lose `exec` coercion, and lose telemetry | MiniMax Responses boundary adapter (retained, simplified) |

## Optional later routing simplification

Only after routing-policy parity or an intentional policy simplification:

```text
Codex
  |
AutoDev compatibility edge
  |
LiteLLM routing
  |
native provider endpoints
```

This is an option, not a required end state. Native/provider-direct setup and removal of a provider CLI do **not** require LiteLLM to own AutoDev's provider-selection policy

## Telemetry path

```text
Codex native OTLP -----\
LiteLLM native OTel ----> OpenTelemetry Collector ---> generic backend(s)
compatibility OTel -----/             |
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
(`config/execution-contract.json`) is frozen against a canonical
fixture at `tests/fixtures/contracts/execution-contract.json`.
`tests/test_local_setup.py::LocalSetupTests::test_execution_contract_matches_frozen_phase0_baseline_fixture`
asserts that both the tracked artifact and a fresh render from the role TOML
sources match that fixture byte-for-byte (as parsed JSON), so any future
refactor of role rendering (including a Rulesync migration) has an executable
baseline to diff against instead of "whatever the renderer currently
produces." Updating the fixture is itself the documented, intentional signal
that the contract's shape was meant to change.

Copilot direct-file and shell-based skill-read paths are frozen (`tests/fixtures/contracts/copilot-responses-contract.json` exercised via `tests/copilot-responses-contract.test.mjs`). Antigravity's Responses boundary is now frozen as well: `tests/fixtures/contracts/antigravity-responses-contract.json` and `tests/antigravity-responses-contract.test.ts` exercise normal stream/SSE completion, direct and shell-based skill reads, permission denial, and provider-limit incomplete output through a fake local `agy` executable and temporary loopback telemetry server. The contract also asserts sanitized response IDs/timestamps, prompt-content privacy, telemetry observations, and fixture immutability; it does not contact a provider or require credentials. The Claude Responses boundary is now frozen and runs through the typed bridge: `tests/fixtures/contracts/claude-responses-contract.json` and `tests/claude-responses-contract.test.ts` exercise a fake local Claude CLI and loopback telemetry server for normal and streaming completion, direct and shell skill reads, tool continuation/item IDs, permission denial, provider-limit incomplete output, authentication failure, sanitized identifiers/timestamps, prompt privacy, telemetry, and fixture immutability. This contract is offline-only and does not contact Anthropic or require credentials. The OAuth-native transport retirement gate remains closed by policy; Claude Code CLI/OAuth is the supported path. Dashboard contract assertions were also hardened to tolerate formatting-only whitespace and to match the current provider-health labels (`Models` and `Errors & cooldowns`); no dashboard runtime behavior changed.

The Phase 0 "provider selection order and randomization" capture is landed
as a deterministic fixture. The fixture at
`tests/fixtures/contracts/provider-selection-order.json` records the eight
non-empty `providerPriority` listings the router produces under seeded
randomness (`mulberry32(0xC0FFEE)`) for the `default`, `smart`, and
`orchestrator` tiers, plus the second eight listings for `default`, and the
live tier membership that each listing must stay within.
`tests/provider-selection-order.test.ts` drives those listings through the
exported `providerPriority`, `tierCandidates`, and `roleCandidates` helpers
and asserts every listing stays within its tier membership. Refreshing the
fixture is the documented, intentional signal that ordering, group layout,
or randomization is meant to change.

The Phase 0 "root versus subagent provider selection" capture is landed as
a deterministic fixture that freezes the semantic boundary the router
maintains between the root orchestrator and every leaf subagent. The
fixture at `tests/fixtures/contracts/root-subagent-provider-selection.json`
records, under schema `autodev-root-subagent-provider-selection-v1` and
seed `0xC0FFEE`, the alias map the router distinguishes from one another
(`autodev/orchestrator` plus the seven `autodev/<role>` aliases), the
seeded `roleCandidates` listing for every leaf role (the default-tier
roles all share one listing, smart has its own), the seeded
`orchestratorCandidates` listing with both the unpreferred ordering and
the preferred-provider continuation ordering for every tier member, the
`payloadForCandidate` projection for the orchestrator primary, the
orchestrator fallback, and a leaf candidate (so the root-only fallback
reasoning override is captured distinctly from the caller's effort that
leaves are required to preserve), and the tier membership each listing
must stay within. `tests/root-subagent-provider-selection.test.ts` drives
those scenarios through the exported `roleForModel`,
`orchestratorCandidates`, `roleCandidates`, and `payloadForCandidate`
helpers and asserts every shape against the fixture, including the schema
tag, the root alias being declared a leaf (`roleForModel` returns
`null`), every subagent alias resolving to its role, concrete model names
and unknown aliases remaining role-less, the root-only continuation
preference being a preference (never a pin), and the leaf effort remaining
untouched under `payloadForCandidate`. The test is
fully offline and deterministic and is distinct from the existing
`tests/provider-selection-order.test.ts`, which freezes only the
generic `providerPriority` tier listings the router produces under the
same seed: this fixture is the one that locks down which alias resolves
to which tier, which concrete model each provider must use for it, and
which reasoning-effort override the root orchestrator is allowed to
pin. Refreshing the fixture is the documented, intentional signal that
root-versus-subagent aliasing, tier membership, concrete models, fallback
reasoning overrides, or preferred-provider continuation ordering is
meant to change.

The Phase 0 "cooldown and provider-limit behavior" capture is landed as a
deterministic fixture. The fixture at
`tests/fixtures/contracts/cooldown-behavior.json` records the observable
shape the router produces today at a fixed `now` (epoch ms `1700000000000`)
for every cooldown slice: `config` (authentication/invalid_model), `probe`
(local bridge health failures on their own short ladder), `transient`
(everything else on the 30s-doubling ladder), and `hard` (provider-reported
limits held until the stated reset, with floor/ceiling/clamp rules);
escalation rungs for both ladders; stated-reset handling for future, past,
absent, and far-past-reset cases; the non-shortening rule that prevents a
shorter failure from pulling a longer one back; `cooldownAllowsLastResort`
decisions for every entry shape; `nextProviderRetryMs` for the earliest
remaining retry window; and `providerCooldownSummary` for disabled,
cooling, available, deduplicated, and mixed-provider lists.
`tests/cooldown-behavior.test.ts` drives those scenarios through the
exported `cooldownProvider`, `clearProviderCooldown`,
`cooldownAllowsLastResort`, `providerCooldownSummary`, and
`nextProviderRetryMs` helpers and asserts every shape against the fixture.
Refreshing the fixture is the documented, intentional signal that cooldown
classes, ladder ceilings, last-resort policy, or summary shape is meant to
change.

The Phase 0 "Responses item-ID continuation behavior" capture is landed
as a deterministic fixture. The fixture at
`tests/fixtures/contracts/responses-item-ids-contract.json` records the
observable shape the router produces today through the four exports of
`src/shared/responses-item-ids.ts`: the frozen
`RESPONSES_ITEM_ID_PREFIXES` map (the type -> prefix table every self-
contained item's id must match); every `normalizeItemId` branch
(MiniMax-minted `custom_tool_call` and `function_call` ids rewritten to
their type's prefix, already-conforming ids left alone across all six
prefixes, the `ctco_` cross-prefix collision that is well-formed for a
tool output but not for a tool call, the non-self-contained `reasoning`
branch that always returns `null`, an absent/empty/undefined id, an
unrecognised item type passed through untouched, and the distinct-
originals invariant that prevents two items collapsing onto one id); every
`normalizeInputItemIds` branch (all-valid input returned as the same
array reference with `changed: 0`, non-array pass-through including the
`undefined` host primitive that JSON cannot represent, mixed inputs
rewriting only non-conforming items, deterministic hash expectations for
the exact MiniMax-minted ids the router sees, `call_id` preservation
across the call/output pair that is what makes a tool result attach to
its call, idempotence on a repaired input that returns the same array
reference on the second pass, and foreign-field survival on a rewritten
item); the poisoned-rollout repair driven through
`tests/fixtures/poisoned-rollout-items.json` (38 items, 9 non-conforming
before repair, exact deterministic hash for `input[18].id` which is
the field the upstream reported, every other non-conforming item
rewritten, all 13 `call_id` values preserved exactly across the
tool-call/tool-output middle, and 4 reasoning items surviving without
id rewriting or drop on the OpenAI route); and every
`dropUnresolvableReasoning` branch (drop when `encrypted_content` is
absent, the empty string, or a non-string; preserve when populated; and
the non-array pass-through including the `undefined` host primitive).
`tests/responses-item-ids-contract.test.mjs` drives every scenario
through the exported `normalizeItemId`, `normalizeInputItemIds`, and
`dropUnresolvableReasoning` helpers and asserts every shape against the
fixture, including the schema tag (`autodev-responses-item-ids-contract-v1`).
Refreshing the fixture is the documented, intentional signal that the
prefix map, the SHA-256 truncation length, item-id continuator
behavior, or `dropUnresolvableReasoning` policy is meant to change.

The Phase 0 "per-session concurrency contract" capture is landed as a
deterministic fixture. **Finding.** The router's concurrency parser
(`parseConcurrencyConfig` in `scripts/codex-model-router.mjs`) only
matched a key/value pair at the start of a line, so the canonical Codex
key `max_concurrent_threads_per_session` was unreachable when it
appeared inside a composer-emitted inline `agents = { ... }` table --
the form `$CODEX_HOME/config.toml` now ships. That left the router with
`maxConcurrentThreadsPerSession = null`, so admission reported the
documented over-denial risk on every denied request and accepted every
request it should have denied; the sanitized `/status` payload
(`status.limits.maxConcurrentThreadsPerSession` and
`status.concurrency.effectivePerSessionLimit`) reported `null` as well,
masking the bug behind what looked like an explicit operator choice. The
legacy `max_threads` alias was also being parsed into the same object
and surfaced through `effectivePerSessionLimit()` as a fallback, which
would have hidden the parser bug behind a second source of truth the
moment the inline form was repaired. **Slice.** The parser now extracts
the agents context first (multiline `[agents]` table OR composer-emitted
inline `agents = { ... }` table with nested role braces tracked by a
small depth counter), then looks for the canonical key inside that
context with the existing integer match. The `maxThreads` field is
removed from the parsed object; `effectivePerSessionLimit()` reads only
the canonical key; `concurrencyStatus()` and `limitsStatus()` no longer
expose the legacy alias and never leak the absolute config path;
admission denial continues to carry the canonical reason
`max_concurrent_threads_per_session`. Missing or invalid canonical
values still surface as `null`, which `tryAcquireSubagentSlot` reads as
"no configured cap" so a missing file never silently disables
enforcement and a present-but-unparseable file never silently enables
it. An explicit `0` is preserved verbatim and feeds admission as a
literal zero cap (`sessionActive >= 0` is always true, so every acquire
is denied with the canonical reason); that is the same behaviour the
previous parser produced, and the fixture pins it so any future change
is intentional. **Fixture / tracking rationale.** The fixture at
`tests/fixtures/contracts/concurrency-contract.json` records the
parser-shape scenarios (multiline, inline, inline-with-nested-roles,
compact inline, comments/blanks, indented block, missing key, alias-only,
alias-plus-canonical, sibling-section bleed, string value, bareword
value, missing file), the admission scenarios (under-limit admit,
over-limit deny, identified-session independence, process-fallback shared
bucket, release drops counts, denial records sanitized status), and the
sanitized-status shape (the exact key set returned by `concurrencyStatus`
and the absence of the `maxThreads` alias). `tests/concurrency-contract.test.ts` drives every parser scenario and drives
admission scenarios when the host's effective configured limit matches the
fixture's declared limit; mismatches are explicitly skipped rather than
faked. It drives every scenario through the exported `parseConcurrencyConfig`,
`tryAcquireSubagentSlot`, `releaseSubagentSlot`, `recordConcurrencyDenial`,
`resetConcurrencyTelemetry`, and `concurrencyStatus` helpers and asserts
every shape against the fixture, including the schema tag
(`autodev-concurrency-contract-v1`). The focused router test
`"parseConcurrencyConfig accepts multiline [agents] and inline agents={...} but ignores the legacy max_threads alias"`
covers the same parser scenarios against temp files, and the focused
router test `"admission enforces the canonical limit, surfaces the same value on /status, and never reports the legacy alias"`
covers the sanitized-status assertions in isolation; both are gated on
the module-level `CONCURRENCY_CONFIG` so a host without a configured
`$CODEX_HOME/config.toml` still exercises the no-cap branch. **Completed
slice only after verification.** `node --test tests/concurrency-contract.test.ts`
reports 25 passing scenarios (parser + admission + constants) and
`node --test scripts/codex-model-router.test.mjs` reports 181 passing
tests with no failures; the parser fix also clears the three unrelated
baseline failures (`scripts/codex-model-router.test.mjs` lines 3313,
3367, and 5255) that were caused by the same root cause and previously
inlined the `maxThreads` field in their expectations. **Commands / results.**
`node --test tests/concurrency-contract.test.ts` -> 25 pass, 0 fail;
`node --test scripts/codex-model-router.test.mjs` -> 181 pass, 0 fail
(3 baseline failures resolved). The Phase 0 "active-agent reconciliation" capture is landed as a
deterministic fixture. **Finding.** The router exposed live-agent counts
through three projections that did not formally agree: the canonical
`status.liveActivity` / `usage.totals.active` /
`usage.activity.live` triple (each a single `agentActivity.countLive()`
call with no filter), the `status.usage.byRole` /
`status.usage.byOrigin` / `status.usage.byWorkspace` partitions the
dashboard read for breakdowns and workspace context, and the
`status.concurrency.activeSubagentThreads` / `activeSessions` /
`processFallbackActiveThreads` slot counters. Nothing tied them
together: a held concurrency slot and the live agent it gated could
each be reported from a separate counter that drifted over time, and a
roleless agent reconciled to `unattributed` in role/origin/workspace but
no provider/model dimension ever surfaced that same residual
explicitly. **Slice.** The router now derives a single frozen
`status.agents` projection (`autodev-agent-status-v1`) from
`agentsStatus(at)` evaluated at the same `now` the rest of
`getRouterStatus(now)` evaluates. `status.agents.canonicalLiveCount`
is the canonical live-agent count the dashboard reads (it agrees with
`status.liveActivity`, `usage.totals.active`, and
`usage.activity.live` by construction -- they are all the same
`agentActivity.countLive()` call). `status.agents.byState` is the
full tracker state histogram (including `stale`, `finished`,
`failed`) so an operator can see the activity backlog. `liveByKind` / `liveByRole` / `liveByOrigin` / `liveByProvider` /
`liveByModel` / `liveByWorkspace` are the live-only partitions the
dashboard reads; `liveByRole`, `liveByOrigin`, and
`liveByWorkspace` retain the explicit `unattributed` residual while
`liveByKind` distinguishes between `session` and `bridge_subagent`
records (held `subagent_slot` admission bookkeeping never inflates any
live-by partition). The provider and model dimensions contain only concrete routed values;
records without attribution are omitted from those maps and surfaced through
`missingProvider` / `missingModel`, so `status.providers` continues to list
only concrete routed values.
`status.agents.slotVsAgent` reconciles the agent and slot projections
in one block: `agentLive` (the canonical live count),
`admissionSlots` (active subagent_slot count held anywhere),
`activeAdmissionSessions` (distinct session-key tags holding slots),
and `processFallbackActiveThreads` (the shared process-fallback
admission count, a subset of `admissionSlots`);
`reconciledWithConcurrency` is the `true` flag confirming
`agentsStatus(at)` and `concurrencyStatus(at)` evaluated the tracker
at the same instant. **Fixture / tracking rationale.** The fixture at
`tests/fixtures/contracts/agent-reconciliation-contract.json` records
the schema tag (`autodev-agent-status-v1`), the exact field set the
router exposes, the full tracker `byState` histogram, the live-only
`liveByKind` / `liveByRole` / `liveByOrigin` / `liveByProvider` /
`liveByModel` / `liveByWorkspace` partitions, the slot-vs-agent
reconciliation block, the explicit
`unattributed` residual on role/origin/workspace, and the concrete-only `liveByProvider` / `liveByModel` partitions
(matching `status.providers`). `tests/agent-reconciliation-contract.test.ts`
drives every scenario through the exported `agentsStatus`,
`agentActivity`, `tryAcquireSubagentSlot`, `releaseSubagentSlot`,
`recordConcurrencyDenial`, and `resetConcurrencyTelemetry` helpers
and asserts every shape against the fixture, including the schema tag
(`autodev-agent-reconciliation-contract-v1`). The fixture registers slot records directly for host-independent
reconciliation; admission-limit behavior remains frozen separately by the
per-session concurrency contract.
**Dashboard update.** `scripts/codex-model-router-dashboard.html`
`computeKpiAgentTotals(status)` and `countActiveWorkspaces(status)`
now read exclusively from `status.agents` -- `canonicalLiveCount`,
`liveByRole`, and `liveByWorkspace` -- and throw when `status.agents`
is absent or has a non-frozen schema. The legacy top-level
`status.liveActivity` / `status.usage.totals.active` fallback paths
are removed; the dashboard no longer tolerates a pre-reconciliation
status payload, since the router now guarantees the frozen
`autodev-agent-status-v1` projection on every `getRouterStatus()`
response. **Completed slice only after verification.**
`node --test tests/agent-reconciliation-contract.test.ts` reports
16 passing scenarios (constants + scenarios + role-residual regression)
and the existing `scripts/codex-model-router.test.mjs` "active-agent
reconciliation" suite still passes (181 + 1 new = 182 passing tests).
The fixture pins the canonical live count, every liveBy partition, the
`byState` histogram, the slot-vs-agent reconciliation, and the
deliberate `unattributed` residual on role/origin/workspace but not
on provider/model -- so any future change to those shapes is an
intentional contract change rather than a silent drift.

The final two Phase 0 capture contracts are now frozen. The native-versus-
bridge-native child-count fixture at
`tests/fixtures/contracts/native-vs-bridge-child-counts.json` (schema
`autodev-native-vs-bridge-child-counts-v1`) and its executable suite at
`tests/native-vs-bridge-child-counts.test.ts` drive the existing router
helpers and `ingestAgentEvents` with deterministic IDs and timestamps. They
pin mechanism ordering, exact empty/non-empty projection keys, per-child
bridge batch counts, started-to-settled outcomes and row settlement tallies,
newest-first 50-row recency, roleless bridge attribution,
inherited-child-model resolution, ignored unknown mechanisms, late-report
settlement, overflow failure, and the non-additive Codex-native spawn counter
with spawn failures kept outside `status.subagents.total`. The dashboard/status
snapshot fixture at `tests/fixtures/contracts/dashboard-status-snapshot.json`
(schema `autodev-dashboard-status-snapshot-v1`) and
`tests/dashboard-status-snapshot.test.ts` freeze exact `/status` field
presence, privacy-safe metadata, pending/populated `codexState`, provider rows,
dashboard grouping and empty states, totals-footer visibility, the status CLI
`byMechanism` summary, and extract-and-evaluate HTML rendering without prompt,
response, credential, or absolute-path leakage. The dashboard now distinguishes
its bounded recent-window subtotal from the cumulative all-time total as
`X recent / Y total` when the 50-row window cannot cover history; the totals
footer and status CLI use the same distinction without fallback inflation.
These two contracts mark `Native versus bridge-native child counts` and
`Dashboard/status snapshots` frozen. **Validation.** The focused contracts
pass exactly: `node --test tests/native-vs-bridge-child-counts.test.ts` ->
24 pass, 0 fail; `node --test tests/dashboard-status-snapshot.test.ts` ->
5 pass, 0 fail. The requested regression commands also pass: agent
reconciliation 16, workspace attribution 8, concurrency 25, router 182,
metrics 19, workspace telemetry 18, and router state snapshot 3, all with
0 failures. The full `pnpm test` run reports 575 pass, 0 fail; both
`pnpm run validate:actionlint` and `pnpm run validate:shell` exit 0;
`node --test tests/otel-attributes-schema.test.ts tests/otel-attributes-emission.test.ts`
reports 44 pass, 0 fail; and `git diff --check` is clean. LSP diagnostics
for `src/cli/router-status.ts`,
`tests/native-vs-bridge-child-counts.test.ts`, and
`tests/dashboard-status-snapshot.test.ts` report 0 errors, warnings, info,
and hints. An independent validator reproduced 29/29 focused passes and
reported no privacy, determinism, labeling, or documentation blockers.

The Phase 0 "workspace attribution and tool/skill/MCP attribution" capture is now frozen as a deterministic contract. **Finding.** Existing behavioral tests covered workspace-local named tool/skill/MCP evidence, fail-closed unavailable-versus-empty rendering, workspace-id joins, privacy normalization, and attribution diagnostics, but no fixture pinned the public `status.usage.byWorkspace` rows or diagnostic reasons. **Slice.** `tests/fixtures/contracts/workspace-attribution-contract.json` (schema `autodev-workspace-attribution-v1`) and `tests/workspace-attribution-contract.test.ts` now freeze empty dimensions, workspace-local bridge evidence, skill exposure versus use, MCP exposure versus confirmed use, registered/unknown/ambiguous workspace identifiers, privacy hashing, deterministic named rows, and additive privacy-safe OTel attributes. The fixture registers slot/telemetry inputs directly where needed so it is host-independent; admission limits remain covered by the separate concurrency contract. **Completed slice only after verification.** The focused contract reports 8 passing tests; existing workspace telemetry and OTel attribute suites remain green. `Workspace attribution` and `Tool/skill/MCP attribution` are marked frozen below; the final child-count and dashboard/status slices are documented immediately below.

With these two contracts complete, the entire Phase 0 capture list is frozen
except for provider and CLI parity gaps that explicitly require provider
contact. Phase 0 is complete; no additional Phase 0 contract is required to
begin Phase 1.

### Capture

- Role TOML inputs and rendered role outputs
- Generated execution contract (frozen — see Status above)
- Provider request/response fixtures
- Streaming event sequences
- Namespace/custom/freeform tool behavior
- Responses item-ID continuation behavior (frozen — see Status above)
- Provider selection order and randomization (frozen — see Status above)
- Cooldown and provider-limit behavior (frozen — see Status above)
- Root versus subagent provider selection (frozen — see Status above)
- Per-session concurrency contract (frozen — see Status above)
- Active-agent reconciliation (frozen — see Status above)
- Workspace attribution (frozen — see Status above)
- Tool/skill/MCP attribution (frozen — see Status above)
- Native versus bridge-native child counts (frozen — see Status above)
- Dashboard/status snapshots (frozen — see Status above)

### Exit gate

Every behavior being migrated has an executable fixture or an explicit documented exception

---

## Phase 1 — Separate portable versus machine-local configuration

Phase 0 is complete. The next step is to separate portable versus machine-local
configuration using the existing portable source
`config/config.autodev.toml`, the existing composer, and the existing
rulesync-pinned fixtures. No additional Phase 0 contract is required before
starting this work.

The former tracked `config/config.toml` was a legacy migration seed. Older
installations may still point a user config symlink at it; the supported upgrade
path reads an existing target and atomically materializes a regular composed
file. A broken legacy symlink fails closed rather than overwriting the target
with a configuration that could discard machine-local state.

### Change

- Define which keys are AutoDev-owned and portable
- Define which keys are machine/user-owned
- Stop treating the entire user `~/.codex/config.toml` as one portable artifact
- Preserve user-owned keys during every generator/install operation
- Keep a small installer/composer for AutoDev-specific Codex keys that Rulesync does not own

### Exit gate

Fresh install and update can converge AutoDev-owned configuration without deleting or committing machine-local state

### Status

Complete. The portable source is authoritative at `config/config.autodev.toml`: it carries the AutoDev-owned portable scalars, provider definitions, `sandbox_workspace_write`, `otel`, `analytics`, `features`, `tools`, `agents`, the AutoDev-owned skills (`ccc`, `lsp-mcp-server`, `orchestration`), and `shell_environment_policy`. MCP declarations come from the live Rulesync source `.rulesync/mcp.jsonc` and are projected into the composer. The source excludes `notify`, `hooks.state`, `projects`, `marketplaces`, TUI/notice/desktop/apps/plugins/memories, `node_repl`/`cua_repl`, non-AutoDev skills, and absolute user/application paths. `src/config/compose-user-config.ts` deterministically merges the portable source and Rulesync MCP projection with existing machine-local configuration into `$CODEX_HOME/config.toml` as an atomic regular file, resolving conflicts in favor of AutoDev while semantically preserving machine-local and user-owned values. The installer (`scripts/install.sh`), `--check` drift validation, and `src/config/render-execution-contract.ts` consume `config.autodev.toml` and the composer. The former `config/config.toml` seed is removed from the repository and no longer participates in validation.

### Seed-retirement acceptance

The retirement is accepted when an upgrade materializes a regular (not
symlinked) `$CODEX_HOME/config.toml` through the supported installer/composer,
reads a valid legacy symlink target only during migration from an older
installation, and keeps
existing machine-local state such as projects, notifications, custom MCP
servers, and trusted hook state. A second install must be idempotent and
`scripts/install.sh --check` must pass without
rewriting the composed file. The focused composer/convergence tests and the
Rulesync MCP and generated-skills checks are the validation evidence for this
boundary.

### Hardening slice

The Phase 1 portable-source boundary is now hardened. The stale caveat in
`config/config.autodev.toml` claiming that the source was not yet
composed into the installed config was removed; the source now states that it
is composed into `$CODEX_HOME/config.toml` by
`src/config/compose-user-config.ts`. The frozen contract fixture
`tests/fixtures/contracts/portable-autodev-config-contract.json` (schema
`autodev-portable-autodev-config-v1`) and
`tests/portable-autodev-config-contract.test.ts` pin the portable scalar set,
four model providers, seven required sections, declared hook events without
`hooks.state`, and the exact AutoDev MCP and skill-name sets byte-for-byte
using the same Python `tomllib` parser as the composer.

The installer convergence regression
`LocalSetupTests.test_installer_converges_after_operator_edits_operator_state`
proves that a fresh install followed by operator edits to `notify`, `projects`,
and a custom MCP server, a second installer run, and a final `--check` all
preserve machine-local state while restoring portable `model` and
`model_provider` values, retaining a regular non-symlink config file, and
leaving the checked bytes unchanged. Validation is recorded exactly: the
portable-source contract reports 7 passing tests; the focused Python composer,
portable-source, and convergence tests report 26 passing tests; the native,
dashboard, agent-reconciliation, workspace-attribution, concurrency, router,
metrics, workspace-telemetry, and router-state regression suites report 24,
5, 16, 8, 25, 182, 19, 18, and 3 passing tests respectively; `pnpm test`
reports 582 passing tests; actionlint and ShellCheck exit 0; the required OTel
Python tests report 44 passing tests; LSP diagnostics report 0 errors, warnings,
info, or hints for the changed JavaScript and Python files; and `git diff --check` is clean. Phase 1 is now both correct and stable enough to begin
Phase 2 (Adopt Rulesync for shared configuration). Before any shadow surface
graduates to live output, the first live cutover must make
`.rulesync/rules/overview.md` byte-identical to `AGENTS.md`.


---

## Phase 2 — Adopt Rulesync for shared configuration

### Status

Phase 2 remains shadow-only for hooks. MCP servers and the repository skill
folders are live (see "Completed MCP live cutover to Rulesync" below). Shared instructions need no Rulesync projection: every tool
reads `AGENTS.md` natively (see "Completed single-source instructions and
source-derived MCP checks" below). Rulesync is pinned to `16.30.2` for
`codexcli`, `claudecode`, `copilot`, and `antigravity-cli`. Its output is never
tracked as a fixture: the tests generate every projection into temporary roots
(see "Completed removal of Rulesync shadow fixtures" below).

The hook-adoption evaluation is **not a live-cutover approval**.
`tests/rulesync-hooks-shadow.test.ts` executes the parity blockers against
current sources: Codex's live `config.autodev.toml` carries
`prevent_idle_sleep` on four hooks while Rulesync cannot represent it; Copilot
and Antigravity lose target-specific commands during projection; and the
installer/composer still owns the materialized user configuration. The result
is **retain AutoDev as the live hook owner**. Rulesync remains a shadow
translation generated only into temporary roots.

**Next action:** keep the live hook/config path unchanged and add a
target-by-target parity harness only if a future Rulesync release can preserve
Codex-only fields and all target-specific commands (or provide an explicit
owner for each loss). Re-run the focused shadow suite against that release;
do not promote hooks until the harness proves byte/semantic parity with the
installer-composed Codex config and provider runtime behavior.

**Completed first live surface — shared instruction rules.**
`.rulesync/rules/overview.md` is now byte-identical to `AGENTS.md`; the live
`CLAUDE.md` and `.github/copilot-instructions.md` artifacts are also byte-
identical to that canonical body. Rulesync `16.30.2` requires YAML frontmatter
in input rule files, so the live-generation workflow and focused tests build an
ephemeral frontmatter input root around the canonical bytes instead of adding a
second tracked instruction source or changing `AGENTS.md`. The workflow performs
an isolated `rules` generation and compares all three live outputs, while the
existing shadow drift job continues to validate `mcp,rules,hooks` in its
isolated fixture root. `tests/test_rulesync_live_rules.py` freezes byte identity,
ephemeral all-target generation, and the live workflow boundary; the existing
`tests/test_rulesync_mcp_shadow.py` now uses the same ephemeral input technique
for rules generation. This is a Rulesync compatibility seam, not a second
source of instructions. *Superseded 2026-09-15:* Rulesync no longer handles
instructions. `.rulesync/rules/overview.md`, `.github/copilot-instructions.md`,
and `tests/test_rulesync_live_rules.py` are gone. See "Completed single-source
instructions and source-derived MCP checks" below.

**Historical record (superseded 2026-09-15) — Copilot canonical skills.** The
Rulesync-generated Copilot skill surface at `.github/skills/` now contains
exactly `ccc`, `lsp-mcp-server`, and `orchestration`, with generated
frontmatter and bodies checked against `.rulesync/skills/`. The focused
`tests/test_rulesync_live_skills.py` contract and the workflow's read-only
Copilot `skills` drift check freeze that surface; `ccc` reference files remain
shadow-only because the first cutover is intentionally limited to the three
canonical `SKILL.md` files. Codex's user-level skill links, Claude's
role-filtered provider views, and Antigravity's explicit skill registry remain
AutoDev-owned and were not cut over. MCP, hooks, and permissions
remain shadow-only/deferred. Validation is complete: the seven Rulesync suites
(`test_rulesync_live_rules`, `test_rulesync_live_skills`,
`test_rulesync_mcp_shadow`, `test_rulesync_skills_shadow`,
`test_rulesync_hooks_shadow`, `test_rulesync_permissions_inventory`, and
`test_rulesync_mcp_boundary`) report 36 passing tests; `pnpm test` reports
582 passing tests; actionlint and
ShellCheck exit 0; `git diff --check` is clean; and LSP diagnostics for the
new live-skills test and updated Rulesync tests report no issues. Shared MCP remains the next live-equivalence candidate; Codex, Claude, and
Antigravity skill surfaces remain explicitly out of this cutover. *Superseded
2026-09-15:* `.github/skills/` is no longer tracked; see "Completed generated
repository skill surfaces" below.

**Completed canonical skill-source consolidation — `.rulesync/skills` is the
only skill source (added item).** This item was not in the original plan. A
stalled concurrent change had moved all ten AutoDev skills from
`scripts/codex/skills/` into `.rulesync/skills/`, dropping
`orchestration/agents/openai.yaml` and leaving about 30 references on the
removed path. As a result, the installer exited 71, `--check` failed, about 45
tests failed, and the Phase 3 installer gates were blocked. HEAD also kept
duplicate copies of `ccc`, `lsp-mcp-server`, and `orchestration` in both
directories.

The move was completed rather than reverted, and every consumer now reads the
single source:
- The installer uses `skill_source_root` for versioned-source checks,
  `~/.agents/skills` links, and the agy registry.
- `runtime_module_target()` installs non-`scripts/` assets under
  `$CODEX_HOME/<path>`. As a result, one relative specifier reaches the
  orchestration skill in both a checkout and the hooks copy, for
  `src/agents/bridge-role.ts`, the Claude bridge, and `enforce-root-delegation.sh`.
- The Claude, Copilot, and Antigravity bridges and `skill-read-telemetry.ts`
  recognise `.rulesync/skills` as the canonical skill root.
- `.agents/skills.json`, the three frozen provider contract fixtures, the tests,
  and the docs were updated to the new path.
- The obsolete `$CODEX_HOME/hooks/codex/skills` copy and the agy registry entry
  for the removed path are cleaned up. `--check` rejects both if they reappear.

`openai.yaml` was restored byte-identical from HEAD, because live Codex reads
it through the skill symlink. Rulesync `16.30.2` composes the `codexcli`
sidecar only from a `codexcli:` frontmatter section, so the `codexcli`
projection omits a raw copy, while the other targets copy it verbatim. This is
a documented projection limitation, and it has no effect on live Codex.
Exposure is unchanged:
- Codex still links the same eight skills.
- Antigravity still registers only `ccc` and `lsp-mcp-server`.
- Claude role views still come from the execution contract.
- Live Copilot `.github/skills` remains exactly `ccc`, `lsp-mcp-server`, and
  `orchestration`.

The tracked shadow fixtures were regenerated with the pinned Remediation
command. The only change was additions: the seven other skills in every shadow
root. `test_rulesync_skills_shadow.py` now freezes all ten skills,
byte-identical nested files, and per-target `openai.yaml` behavior.
`test_rulesync_live_skills.py` asserts that the non-cutover skills are
generated but not promoted. New installer regression tests cover the runtime
target mapping and obsolete agy registry replacement. *Superseded 2026-09-15:*
skill shadow fixtures and both skill tests were replaced by fresh generation;
see "Completed generated repository skill surfaces" below.

**Completed repository-only skill surface (added item, 2026-09-15).** Some
skills exist only for developing AutoDev itself and must never reach other
workspaces. The first is `autodev-codex-request-capture`, which documents how to
see exactly what Codex sends a provider without contacting any API, and bundles
`scripts/responses-recorder.ts` plus an example turns file.
- Like every skill, its source is `.rulesync/skills`.
- It is deliberately absent from the installer's user-level `skill_names` and
  from the agy registries.
- It is exposed only through each tool's own repository-scoped discovery
  folder, generated by the installer (next item): `.agents/skills/` (Codex and
  Antigravity scan `$REPO_ROOT/.agents/skills`), `.claude/skills/` (Claude
  Code), and `.github/skills/` (Copilot), each with its bundled files.
- `tests/test_local_setup.py` asserts the generated copies, that they stay out
  of git, the exclusions, and that a hermetic install creates no user-level
  link.
- `tests/codex-request-capture-skill.test.ts` covers the recorder.

The second repository-only skill, `autodev-session-diagnostics` (added
2026-09-18), is the live-evidence counterpart: it diagnoses AutoDev problems
from session rollouts, router events, bridge logs, router status, and running
processes. It bundles `scripts/session-trace.ts`, which builds the joined
per-session report (threads, turn outcomes, silent gaps, tool calls and
failures, per-thread router requests and provider hops, and live state: agent
counts against writing threads, service start times, installed-vs-checkout
drift, running CLIs), and `scripts/mcp-probe.ts`, which starts an AutoDev MCP
server exactly as Codex does and exercises it. Router events carry the Codex
`thread` id so the report attributes requests exactly. It is exposed exactly
like the capture skill, and `tests/session-diagnostics-skill.test.ts` covers
both scripts.

The third repository-only skill, `opentelemetry` (added 2026-09-19), defines
OpenTelemetry architecture, ownership, semantic-convention, instrumentation,
and telemetry-quality rules for AutoDev itself. It establishes that OpenTelemetry
serves as AutoDev's standard telemetry transport and interoperability layer while
keeping AutoDev-specific semantic truth in AutoDev, governing OTLP ingestion,
Collector configuration, telemetry attributes, traces, metrics, logs, and dashboard
projections. Like the other repository-only skills, it is exposed across each tool's
repository-scoped discovery folders and tested by `tests/opentelemetry-skill.test.ts`.

**Completed generated repository skill surfaces — only `.rulesync/skills` is
tracked (added item, 2026-09-15).** Git tracked Rulesync output in three
places: SKILL.md-only copies in `.github/skills/`, repository-only skill
symlinks, and 45 skill shadow fixtures. The live Copilot copy of
`autodev-codex-request-capture` therefore lacked the scripts it documents.
Every repository skill folder is now untracked output generated from the
single source:
- Each canonical skill declares Rulesync `targets` frontmatter, which Rulesync
  strips from the generated copies:
  - repository-only skills keep the default, so all four tools get them;
  - `ccc`, `lsp-mcp-server`, and `orchestration` declare `["copilot"]`, because
    Copilot's cloud agent has no user level;
  - the other seven declare `[]`. They already reach local tools at user level,
    and Codex lists a same-named repository skill a second time.
- `rulesync.jsonc` is the only Rulesync configuration. It sets the four
  targets, the `skills` feature, the repository root as output, and `delete`.
  The installer runs the pinned `node_modules/.bin/rulesync generate --config
  rulesync.jsonc` right after rendering the Claude role views. `--check` adds
  `--check`, and the configured `delete` makes that also report a stale
  generated skill. The installer therefore needs
  `pnpm install --frozen-lockfile`.
- `.gitignore` lists `/.github/skills/` and `/.claude/skills/`. The installer
  writes `/.agents/skills/` to `.git/info/exclude` instead, because Antigravity
  does not load a gitignored `.agents/skills/`. A captured Codex request
  confirmed that Codex still discovers skills in both cases.
- `copilot-setup-steps.yml` generates the Copilot folder after `pnpm install`,
  before the cloud agent starts.
- Removed:
  - the tracked `.github/skills` copies and the repository-only symlinks;
  - the skill shadow fixtures;
  - `test_rulesync_skills_shadow.py` and `test_rulesync_live_skills.py`.
- `tests/rulesync-skills.test.ts` generates the folders fresh and checks:
  - each folder gets exactly its skills, with bundled files byte-identical;
  - no user-level skill is duplicated;
  - name, description, and body survive, and `targets` does not;
  - `--check` catches an edited, stale, or missing skill;
  - the installer and CI wiring;
  - that nothing generated is tracked.
  The drift workflow runs it.
- Trade-off: tools that read the repository without running setup see no
  repository skills. These are github.com Copilot chat and code review, Codex
  cloud, and Claude Code on the web. Whether Copilot's cloud agent loads the
  generated, gitignored `.github/skills/` is confirmed on its first run after
  this lands.

**Completed removal of Rulesync shadow fixtures (added item, 2026-09-15).**
`tests/fixtures/rulesync-shadow/` tracked 11 generated files: MCP and hook
projections for each target, plus three copies of `AGENTS.md`. That contradicts
the single-source requirement. Every suite already generated the same output
into temporary roots, so the fixtures only added a byte-for-byte golden
comparison. They are deleted, and nothing Rulesync generates is tracked as a
fixture:
- `test_rulesync_mcp_shadow.py`, `test_rulesync_mcp_boundary.py`,
  `rulesync-hooks-shadow.test.ts`, `test_rulesync_live_rules.py`, and
  `rulesync-skills.test.ts` generate from `.rulesync` into temporary roots with
  the pinned Rulesync.
- They assert what matters instead of comparing golden bytes:
  - MCP: each target's server set and commands, plus the boundary contract;
  - hooks: one output file per target, all six commands with their matchers
    and status messages for Codex and Claude, and the Copilot and Antigravity
    parity limits;
  - rules: output byte-identical to `AGENTS.md`;
  - skills: exposure and bundled files.
- `rulesync.jsonc` stopped pointing at the fixture root. It is now the live
  skills configuration used by the installer, Copilot's setup steps, and
  `rulesync-skills.test.ts`.
- The drift workflow keeps its name and job id, so required checks are
  unaffected. It no longer runs inline Rulesync generation. Instead it runs
  `node --test tests/rulesync-mcp.test.ts tests/rulesync-hooks-shadow.test.ts tests/rulesync-skills.test.ts tests/rulesync-permissions-inventory.test.ts`,
  `rulesync.jsonc`, those tests, the MCP boundary contract, the live rule
  files, and the dependency manifests.
- An upgrade that changes Rulesync output is caught by those assertions, not by
  a fixture refresh.
- *Superseded 2026-09-15 for MCP:* see "Completed MCP live cutover to Rulesync"
  below.

**Completed single-source instructions and source-derived MCP checks (added
item, 2026-09-15).** Two duplications remained after the fixtures went.

*Instructions.* Four byte-identical files were tracked: `AGENTS.md`,
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.rulesync/rules/overview.md`.
Rulesync generated none of them live; tests only kept them identical. Every
consumer now reads the one source natively:
- Codex and Antigravity read `AGENTS.md`.
- Copilot reads `AGENTS.md` in its cloud agent, code review, CLI, and VS Code
  chat, per GitHub's and VS Code's custom-instruction support documentation.
- Claude Code reads `CLAUDE.md`, now a symlink to `AGENTS.md`. Its docs endorse
  both a symlink and an `@AGENTS.md` import. The symlink was chosen because an
  import that resolves outside a session's working directory, such as a session
  started in a subdirectory, needs interactive approval that headless bridge
  runs cannot give.
- `.github/copilot-instructions.md`, `.rulesync/rules/`, and
  `tests/test_rulesync_live_rules.py` are deleted.
- Trade-off: Copilot Chat on github.com reads only
  `.github/copilot-instructions.md`, so it no longer receives these
  instructions.
- Copilot and VS Code read both `AGENTS.md` and `CLAUDE.md`, so they see the
  text twice; before this change they saw it three times.
- `tests/agent-instructions.test.ts` asserts that `AGENTS.md` is the only regular
  instruction file, that `CLAUDE.md` links to it, and that no tracked file
  duplicates it.

*MCP.* `tests/fixtures/contracts/rulesync-mcp-boundary.json` held a frozen copy
of every target's generated servers and of the live Codex MCP servers, and
`tests/test_rulesync_mcp_boundary.py` compared against it. Both are deleted and
folded into `tests/test_rulesync_mcp_shadow.py`, which derives expectations from
the tracked sources:
- each target writes only its project MCP file;
- each target projects exactly the servers `.rulesync/mcp.jsonc` declares for
  it, with matching commands, arguments, URLs, and disabled state;
- no forbidden server is declared;
- `config/config.autodev.toml` owns exactly `lsp`, `cocoindex-code`, and
  `playwright`, with the same commands, arguments, and enabled state as the
  Codex declaration;
- Rulesync stays pinned to an exact version.

The live Codex config and `.rulesync/mcp.jsonc` remain two tracked MCP
declarations. The MCP behavioural-equivalence decision above keeps the live
owner, so the test enforces that they agree rather than merging them.
*Superseded 2026-09-15:* the live Codex config no longer declares MCP servers;
see "Completed MCP live cutover to Rulesync" below.

**Context7 MCP added (2026-09-21).** Context7 is wired through the same
Rulesync path: `.rulesync/mcp.jsonc` declares `context7` (URL
`https://mcp.context7.com/mcp`, `bearer_token_env_var = "CONTEXT7_API_KEY"`),
the role renderer propagates `bearer_token_env_var` alongside `command`/`args`/`url`
so each rendered role TOML that names `context7` carries the full server
definition, and `MCP_ORDER` in `src/config/render-execution-contract.ts`
places it between `openaiDeveloperDocs` and `autodev_spawn`. The role
TOMLs explicitly gate the server: `docs-researcher` and `explorer` enable
it; `orchestrator` and `browser-tester` explicitly disable it so the root
turn and the UI-testing role never pick it up. `default`, `worker`,
`validator`, and `smart` are unchanged. The `CONTEXT7_API_KEY` env var
is owned by the operator's shell; AutoDev never embeds or writes it.
Validation: `tests/config/config-rendering.test.ts` asserts the per-role
`context7` boundary and MCP ordering; `tests/rulesync-mcp.test.ts`
asserts the shared `context7` entry plus `bearer_token_env_var` survives
the Codex projection.

**Completed MCP live cutover to Rulesync (added item, 2026-09-15).** The
behavioural-equivalence decision below assumed Rulesync could not write
AutoDev's live MCP files; tests against `16.30.2` in temporary homes disproved
that. Meanwhile each server's launch definition was repeated in four places:
- `config.autodev.toml`;
- eight role TOMLs;
- the installer's `copilot mcp add` / `agy mcp add` calls;
- the Claude bridge, whose Playwright even bypassed the pinned launcher.

`.rulesync/mcp.jsonc` is now the only MCP source.

*Source.*
- The shared code servers are `codegraphcontext`, `lsp`, and `cocoindex-code` (through
  `run-autodev-mcp.sh`), plus `openaiDeveloperDocs` (by URL).
- The `codexcli` section adds `default_tools_approval_mode`, a disabled
  `playwright`, and a disabled `openaiDeveloperDocs` that roles can enable.
- `copilotcli` drops `openaiDeveloperDocs`.
- `antigravity-cli` adds `autodev_spawn`, launched through the installed shim.
- A target section replaces a shared entry whole, so the Codex entries repeat
  their launch keys; `tests/rulesync-mcp.test.ts` keeps them equal.

*Generation.*
- **Claude Code, Copilot CLI, Antigravity:** for each of `claude`, `copilot`,
  and `agy` on `PATH`, the installer runs `rulesync generate --global --features
  mcp`, and `--check` adds `--check`. Rulesync keeps non-MCP keys but owns the
  server lists, as decided.
- **Codex:** Rulesync's global output ignores `CODEX_HOME`, so the installer
  generates the Codex projection into a temporary root.
  - The composer's new `--mcp-source` merges it, keeping operator-added Codex
    servers.
  - A portable source that declares `mcp_servers` is rejected.
  - The execution-contract builder reads the same projection and treats a
    missing `enabled` as enabled.
- **Codex roles:** role TOMLs keep only per-role settings.
  - The renderer fills launch keys from the projection.
  - It adds `transport = "streamable_http"` for URL servers, which the Codex
    role loader requires and Rulesync omits.
  - A role naming an undeclared server fails to render.

*Claude bridge.* It reads each contract server from the composed
`$CODEX_HOME/config.toml` and always passes `--strict-mcp-config`, as decided. A
bridged turn therefore sees exactly its contract's servers, never
`~/.claude.json`'s or a workspace `.mcp.json`'s.

*Removed.*
- The installer functions `register_copilot_code_mcp`, `check_copilot_code_mcp`,
  `register_agy_spawn_shim`, and `check_agy_code_mcp`.
- `AUTODEV_SKIP_COPILOT_MCP`.
- The bridge's hardcoded server constants.
- The `mcp_servers` tables in `config.autodev.toml`.

*Limits.*
- Rulesync `16.30.2`'s Codex subagent output writes `developer_instructions`
  after the `mcp_servers` tables, so TOML parses the instructions into the last
  server. Role files therefore stay AutoDev-rendered; an upstream issue is
  drafted but not filed.
- A Rulesync config file with `global: true` generates nothing, so MCP
  generation passes flags.
- At the time of this cutover, the former legacy seed `config/config.toml`
  still held MCP copies. The seed-retirement slice removed that tracked file;
  valid legacy symlink targets are materialized during upgrade, while broken
  targets fail closed.

*Live effect of the next install.*
- `~/.copilot/mcp-config.json` loses `playwright`, which AutoDev never
  registered for Copilot.
- The agy `autodev_spawn` entry switches to the launcher form.
- `~/.claude.json` keeps the same servers.
- The Codex user config gains a disabled `openaiDeveloperDocs`.

*Validation.*
- `pnpm run test:python`: 273 tests, OK (1 skipped: the Collector smoke test).
- `pnpm test`: 597/597.
- ShellCheck, actionlint, `py_compile`, and `git diff --check` are clean.
- Hermetic installs with `CODEX_HOME` inside and outside `HOME` produced
  byte-identical user-level MCP files and rendered roles, and `--check` passed.
- `codex mcp list` on the composed config shows `lsp` and `cocoindex-code`
  enabled, and `playwright` and `openaiDeveloperDocs` (streamable HTTP)
  disabled.

**Historical record (superseded 2026-09-15) — shared-MCP evaluation and
hardening; no live cutover at that time.** The
contract fixture `tests/fixtures/contracts/rulesync-mcp-boundary.json` (schema
`autodev-rulesync-mcp-boundary-v1`) and
`tests/test_rulesync_mcp_boundary.py` now freeze Rulesync `16.30.2` projections
for all four targets, including the `lsp`/`cocoindex-code` launcher arguments,
OpenAI Developer Docs placement, Playwright disabled/absent behavior, and
forbidden server absence. They also freeze the live ownership boundary:
`config/config.autodev.toml` remains authoritative for `lsp`,
`cocoindex-code`, and `playwright`, while installer/provider-specific MCP
registries remain outside Rulesync. Temporary generation roots and fixture/live
config immutability are asserted. The focused boundary plus existing MCP shadow
suite reports 8 passing tests. This hardening item is complete, but no MCP live
cutover is claimed because the target projections and existing installer/bridge
owners are not yet one behaviorally equivalent surface. *Superseded
2026-09-15:* the contract fixture and its test were removed, and MCP went live
through Rulesync; see "Completed MCP live cutover to Rulesync" below.

**Historical record (superseded 2026-09-15) — target-by-target MCP
behavioral-equivalence decision; no promotion approved at that time.**
The decision gate now covers server names and launcher arguments, enabled/
disabled state, URL placement, approval semantics, forbidden-server absence,
project versus global scope, role-sensitive exposure, permissions, lifecycle,
merge/preservation behavior, smoke validation, and rollback. The result is
`retain incumbent`/`defer` for all four targets:

- **Codex:** Rulesync emits project `.codex/config.toml`, while the live owner
  is the user-level `config.autodev.toml` plus atomic composer and role-local
  overrides; live approval/network metadata is not represented by the Rulesync
  projection.
- **Claude:** the bridge constructs per-request inline MCP and role-sensitive
  tool/permission boundaries, including browser and orchestration behavior;
  Rulesync's shared `.mcp.json` projection cannot replace that owner.
- **Copilot:** the installer and bridge own a global `copilot mcp` registry and
  role-dependent tool flags; a project `.vscode/mcp.json` is not equivalent.
- **Antigravity:** the installer owns a global `agy` registry, optional spawn
  registration, machine-local permission grants, and launchd/bridge lifecycle;
  a project `.agents/mcp_config.json` cannot represent those semantics.

At that time, all four MCP projections were kept shadow-only. The decision was
superseded by the tested live cutover documented above; the rollback baseline
remains the Rulesync source plus the installer/composer and provider bridge
owners.

*Superseded 2026-09-15 by tested evidence; see "Completed MCP live cutover to
Rulesync" below.* This decision rested on assumptions that were never tested,
and tests against Rulesync `16.30.2` showed:
- `--global` writes the same user-level files the installer maintained:
  `~/.claude.json`, `~/.copilot/mcp-config.json`, and
  `~/.gemini/config/mcp_config.json`.
- It passes Codex's `default_tools_approval_mode` through.
- Role-sensitive exposure never needed to move: it stays with the role files
  and bridges, which now take server definitions from the generated output.

The Rulesync source covers MCP servers, every canonical AutoDev skill, and the
six existing command hooks across `SessionStart`, `SubagentStart`,
`UserPromptSubmit`, and `PreToolUse`. Hooks remain a shadow translation: Rulesync
emits only `PreToolUse` for Antigravity, and Codex-only fields such as
`prevent_idle_sleep` remain outside the portable source as explicit parity
limitations.

MCP servers and the repository skill folders are the live Rulesync surfaces.
Live hooks, Codex user-level skills, and Antigravity skill registration remain
AutoDev-owned, so target-specific guidance
and runtime enforcement are not silently removed. Per-role skill and MCP
assignment and exposure remain AutoDev-owned:
- the role TOMLs and the execution contract;
- Antigravity `include_only` registration and the symlink installer;
- the MCP launcher and the provider bridges;
- hooks and permissions.

The permission source inventory is complete:
`tests/rulesync-permissions-inventory.test.ts` snapshots and contract-tests
the three live permission sources without writing to any of them —
Codex's `approval_policy`/`sandbox_mode`/`sandbox_workspace_write.network_access`
scalars in `config/config.autodev.toml` and the per-server
`default_tools_approval_mode` in the `codexcli` section of
`.rulesync/mcp.jsonc`, the role-dependent
`--disallowed-tools`/`--allowed-tools` construction (`DISALLOWED_CLAUDE_TOOLS`,
`CROSS_SESSION_CLAUDE_TOOLS`, `PLAYWRIGHT_AGENT_ROLES`,
`PLAYWRIGHT_DISALLOWED_TOOLS`, `RESEARCH_CAPABLE_ROLES`,
`CLAUDE_RESEARCH_ALLOWED_TOOLS`, and the `readOnly` role-contract deny list) in
`src/providers/claude.ts`, and the dynamic
`mcp(...)`/`read_file(...)`/`unsandboxed(...)` grant markers that
`grant_agy_code_mcp_permissions`/`check_agy_code_mcp_permissions` compute
against the machine-local `$HOME/.gemini/antigravity-cli/settings.json` in
`scripts/install.sh`. The test also asserts no
`.rulesync/permissions.jsonc` source exists and that `permissions` is absent
from `rulesync.jsonc`'s `features` array.

Permissions *generation* through Rulesync remains deferred, not because the
inventory is incomplete but because each source resists a single portable
translation: Codex's scalars are composed at the user level against
whatever machine-local `$CODEX_HOME/config.toml` already exists (global,
not per-project, and merged rather than overwritten — see
`src/config/compose-user-config.ts`); Claude's current bridge tool boundary is computed
per request from the agent role (orchestrator-with-shim vs. leaf,
read-only vs. mutating, Playwright-eligible vs. not, research-capable vs.
not), not a static file Rulesync could diff against; and Antigravity's current CLI grants
are appended idempotently to a machine-local settings file
(`$HOME/.gemini/antigravity-cli/settings.json`) keyed off install-time
environment (`AUTODEV_AGY_READ_ROOTS`), not a repository-tracked artifact.
These bridge/CLI-specific permission layers become removable only if a validated replacement moves the corresponding enforcement cleanly into Codex or another accepted boundary. Until then they remain part of the incumbent provider contract

CI drift protection is enforced by `.github/workflows/rulesync-mcp-shadow-drift.yml`, a
read-only workflow triggered on `push` to `main`, `pull_request`, and `workflow_dispatch`.
It is path-filtered to:
- `.rulesync/**` and `rulesync.jsonc`;
- `tests/rulesync-*.test.ts`;
- `package.json`, `pnpm-lock.yaml`, and the workflow file itself.

It runs `node --test tests/rulesync-mcp.test.ts tests/rulesync-hooks-shadow.test.ts tests/rulesync-skills.test.ts tests/rulesync-permissions-inventory.test.ts`. Those suites generate every
projection from `.rulesync` into temporary roots with the pinned Rulesync and
derive their expectations from the tracked sources; no generated output is tracked.

### Remediation

When a Rulesync suite fails after an intentional change to `.rulesync/`,
`rulesync.jsonc`, or the pinned Rulesync version:

1. Run the suites locally:
   ```bash
   node --test tests/rulesync-mcp.test.ts tests/rulesync-hooks-shadow.test.ts tests/rulesync-skills.test.ts tests/rulesync-permissions-inventory.test.ts
   ```
2. Update the failing assertion only when the new projection is the intended
   behaviour. There are no fixtures to refresh.

Pin an exact tested Rulesync version rather than tracking `latest`

### Migrate first

- Root/shared instructions (complete without Rulesync: `AGENTS.md` is the only source, read natively by Codex, Antigravity, and Copilot; `CLAUDE.md` is a symlink to it)
- Canonical skills (single tracked `.rulesync/skills` source complete; every repository skill folder is generated, untracked Rulesync output selected by per-skill `targets`; user-level Codex links, Claude role views, and the Antigravity registry remain AutoDev-owned)
- Shared MCP declarations (live cutover complete; see "Completed MCP live cutover to Rulesync")
- Hook declarations (shadow-only translation complete; target limitations documented)
- Permissions declarations (inventory complete, see Status above; generation deferred while provider-CLI-specific permission layers still exist)

### Process

1. Import/translate existing sources into `.rulesync/`
2. Generate into an isolated shadow root
3. Diff against current Codex/Claude/Copilot/Antigravity outputs
4. Test global and project scopes separately
5. Verify unrelated user config survives
6. Add CI drift checks (enforced via `.github/workflows/rulesync-mcp-shadow-drift.yml`)
7. Switch one generated surface at a time (MCP and generated repository skills
   are now live; hooks and permissions remain deferred or AutoDev-owned, and
   role rendering remains AutoDev-owned)

### Keep outside Rulesync initially

- AutoDev role TOMLs
- Execution-contract generation
- Role-specific MCP/skill capability decisions
- Prompt composition
- MCP runtime launcher
- Provider bridge behavior that remains necessary after validation

### Exit gate

Rulesync-generated portable surfaces are behaviorally equivalent and preserve unrelated user configuration

---

## Phase 3 — Insert OpenTelemetry Collector as OTLP ingress

Pin an exact tested Collector build

### Status

The Phase 3 runtime slice is implemented as a reversible, opt-in local
Collector ingress. The pinned build remains `v0.160.0`; the platform artifact
manifest at `config/otel/collector-artifacts.json` records official
`darwin/{arm64,amd64}` and `linux/{arm64,amd64}` release assets and SHA-256
checksums. `src/platform/otel-provision.ts` downloads only the host-matching
asset, verifies its checksum, and installs the machine-local binary under
`$CODEX_HOME/otelcol`; `scripts/otel/provision-autodev-otel-collector.sh`
is only the process-dispatch shim, and no Collector binary is vendored in the
repository.

The runtime is supervised by
`config/launchagents/com.codex.otel-collector.plist` and the foreground
runner/ensure hooks under `scripts/otel/`. The runner validates the exact
Collector version and configuration before launch, binds the OTLP HTTP receiver
on localhost, refuses duplicate/non-HTTP port conflicts, and keeps logs and
transient state under the private `$CODEX_HOME/run` directory. The installer
renders the launch agent and supports `--enable-otel-collector` and
`--disable-otel-collector`; `--check` reports the selected mode, binary/config
validation, and active port state.

Codex remains on the model router at `127.0.0.1:4100` in both modes. Only the
three OTLP exporter endpoints change to `127.0.0.1:4318` when Collector mode is
enabled. The mode is stored as machine-local state in
`$CODEX_HOME/otel-collector.mode`, and the existing composer continues to
preserve unrelated user configuration. Direct mode is the default and is the
rollback path.

The pinned Collector config uses the `otlp_http` exporter (the real binary
flagged the deprecated `otlphttp` alias) and sets
`service.telemetry.metrics.level: none`. Without that setting the upstream
default also binds `127.0.0.1:8888` for internal Prometheus metrics, which
gave the Collector a second, unmanaged listener. That listener also blocked
any other Collector on the host from starting, which is how the live smoke run
surfaced it.

**Live exit-gate evidence (2026-09-14, macOS 26 / Darwin 25.5.0 arm64, target
user account, `otelcol v0.160.0`):**

- *Artifact:* `provision-autodev-otel-collector.sh` downloaded
  `otelcol_0.160.0_darwin_arm64.tar.gz`, verified the manifest SHA-256, and
  produced a binary byte-identical to the installed `$CODEX_HOME/otelcol`
  (`sha256 f4faf10a…d9cc6`).
- *Ingress ownership:* under `com.codex.otel-collector`, exactly one `otelcol`
  process owns `127.0.0.1:4318` and nothing else. Codex keeps
  `openai_base_url = http://127.0.0.1:4100/v1`, and only the three OTLP
  exporter endpoints use `127.0.0.1:4318`.
- *Launchd restart:* `launchctl kickstart -k` logged `Shutdown complete`, and a
  new pid served `4318` within 2s.
- *Crash restart:* `kill -TERM` respawned in 2s and `kill -KILL` in 6s, which
  is the 5s `ThrottleInterval`. Each time exactly one process and one listener
  were present afterwards.
- *Clean shutdown:* `launchctl bootout` logged `Shutdown complete`, and no
  process, listener, or respawn remained after 7s. `launchctl bootstrap`
  restored a single running instance.
- *Live forwarding:* OTLP log and trace probes to `4318` returned HTTP 200 and
  reached the router receiver. Over 70s of real Codex traffic through the
  Collector, the router's logs, traces, and metrics receiver counters all
  advanced, and `invalid` stayed at its pre-insertion value.
- *No double counting:* two isolated real routers on throwaway state, fed the
  same `collector-forwarded-otlp.json` batches (one directly, one through the
  real Collector running the repository config), produced identical
  `codexTelemetry`, `usage`, `attributionDiagnostics`, `subagents`,
  `spawnFailures`, `agents`, and `liveAgentAttribution` projections. That
  covers one prompt, one completed turn, 270 tokens, and a repeated cumulative
  metrics export applied once. Receiver counts matched at 1/1/2 with 0
  invalid, and no prompt marker appeared in Collector output.
- *Unchanged behavior:* `config.toml`, the `/v1/models` catalog, and the
  router `/status` routing, limits, provider, and authentication projections
  are identical to the pre-validation snapshot.

Validation of this tree (HEAD plus the Phase 3 changes) had these results:
- The historical Phase 3 JavaScript suite passed 582/582, including
  the then-incumbent Claude contract; the current typed Claude contract is
  `tests/claude-responses-contract.test.ts`.
- The Python suite ran 271 tests after the canonical skill-source
  consolidation, including the opt-in real-binary smoke test with
  `AUTODEV_OTELCOL_BIN`. 269 pass. The live Collector kept the same pid through
  the whole run. The 2 failures also failed at unmodified HEAD; both were fixed
  on 2026-09-15 (see the completed follow-up item below):
  - The model-router assertion still expected `$(<"$fallback_pid_file")`.
  - `test_claude_cli_exposes_role_specific_skill_view_not_canonical_agents_root`.
- ShellCheck, actionlint, `git diff --check`, and LSP diagnostics are clean.

The installer now persists `$CODEX_HOME/otel-collector.mode` only after the
install succeeds. Previously an `--enable-otel-collector` or
`--disable-otel-collector` run that aborted part-way still recorded the
requested mode. `--check` then reported a mode that did not match the active
configuration and services, which made rollback unreliable.

The installer also decides launchd ownership before stopping a disabled
Collector. Launchd labels are global to the user even under an overridden
`HOME`/`CODEX_HOME`, and the direct-mode `launchctl bootout` used to run
before the "belongs to another runtime" check. As a result, a hermetic
direct-mode installer run from the test suite booted out the live
`com.codex.otel-collector` job during this validation. The job was re-bootstrapped
and verified serving `4318` again.

**✅ Phase 3 is complete (2026-09-15).** The installer gates were blocked by
the stalled skills move. They were unblocked by the canonical skill-source
consolidation recorded under Phase 2, then run live on the target macOS user
account:

1. `install-codex-integration.sh --enable-otel-collector` exited 0 and
   deployed the consolidation. Evidence:
   - all eight `~/.agents/skills` links now point into `.rulesync/skills`;
   - the agy registry holds only the new managed entry;
   - the obsolete `$CODEX_HOME/hooks/codex/skills` copy was removed;
   - the router and all four bridges returned 200.

   `--check` then exited 0.
2. `--disable-otel-collector` exited 0 and rolled back to direct mode:
   - the mode file reads `direct`;
   - no `otelcol` process or `4318` listener remains, and
     `com.codex.otel-collector` is unloaded;
   - all three OTLP endpoints are `127.0.0.1:4100`, with
     `openai_base_url` unchanged;
   - the only `config.toml` change against the pre-validation snapshot is that
     single `otel = { … }` line;
   - router routing, limits, provider, and authentication projections and the
     `/v1/models` catalog are identical, and every service returned 200.

   `--check` exited 0 and reported
   `OpenTelemetry Collector is disabled (direct OTLP ingress on 127.0.0.1:4100)`.
3. `--enable-otel-collector` exited 0:
   - exactly one `otelcol` owns `127.0.0.1:4318`;
   - the endpoints are back on `4318`, and `config.toml` is byte-identical to
     the snapshot;
   - router projections are unchanged;
   - a forward probe returned 200 and the router receiver advanced, with
     `invalid` unchanged.

   `--check` exited 0 with the Collector validating and forwarding.

The machine was left in **Collector mode**, the state found before
validation. Direct mode remains the documented, verified rollback.

**No-double-counting and delivery order.** A later rerun of the isolated
direct-versus-Collector harness showed a `codexTelemetry` difference. Totals
matched, but 3 of 15 MCP-by-model counts and MCP health/status landed on
`unattributed`. A controlled follow-up separated the two variables:
- **Collector with ordered delivery:** each signal is sent through the real
  Collector only after the router ingested the previous one. All seven
  semantic sections are identical to direct delivery.
- **Direct delivery, reordered, no Collector:** sending traces before logs
  reproduces the same class of difference.

The Collector therefore introduces no double counting and no change in
meaning for a given arrival order. Its independent per-signal pipelines do
not preserve cross-signal order, but Codex already exports logs, traces, and
metrics as separate OTLP requests, so the order sensitivity is a pre-existing
router property.

That validation did not cover redelivered log or trace batches; the Phase 3
harness repeated only a cumulative metrics export. The follow-up work below
found and fixed a redelivery double count in the router. Collector insertion
itself was not the cause, since exporter retries resend batches in both modes.

**✅ Follow-up item (added, completed 2026-09-15): router OTLP ingestion is
independent of arrival order and idempotent under redelivery.** This item was
not in the plan; the Phase 3 harness surfaced it. An in-process probe replayed
`collector-forwarded-otlp.json` in all six logs/traces/metrics orders and
after a full redelivery. It found two classes of source defect in
`scripts/codex-model-router.mjs`.

**1. Order sensitivity, only when traces precede logs.** Two causes:
- A later `configured` log overwrote `ready`/`error` MCP dimension statuses.
- MCP spans ingested before `codex.conversation_starts` were permanently
  attributed to model `unattributed`.

The fixes:
- `mergeMcpDimensionBucket` makes `configured` the weakest status. Among
  observed statuses, the newest source timestamp wins. Server `lastSeenAt` is
  monotonic.
- `noteMcpObservation` defers only the model dimension while the conversation
  is known but its model is not (`pendingMcpModelAttribution`). The deferral is
  bounded to 1,000 conversations and 200 observations each; on overflow the
  observations are committed as `unattributed`.
- `/status` and persistence project deferred observations as `unattributed`,
  and `noteConversation` attributes them once the model arrives. A restart can
  therefore leave them unattributed, but never lost or double-counted.

**2. Redelivery double counting.** A resent log batch doubled turns and tokens.
Resent spans doubled MCP init/discovery attempts, failures, durations, and MCP
dimension counts. Resent metric points doubled attribution diagnostics.

The fixes:
- Log records are ingested once per identity: source timestamp plus content
  hash.
- Spans are ingested once per `traceId`/`spanId`, or per name, timestamps, and
  content.
- Data-point attribution diagnostics are recorded once per exported point.
- The identity sets are bounded (10,000 entries) and are not persisted.
  Records without a timestamp are still always counted.
- The receiver counters and the metric inventory's `exports`/`dataPoints`
  remain transport counters that count every export by design.

Evidence:
- The new router test, "Collector-forwarded OTLP semantics do not depend on
  logs/traces/metrics arrival order", covers every order, two interleaved
  redelivery sequences, and deferral then attribution.
- The existing redelivery test was extended to assert that turns, tokens, MCP
  counters, MCP model counts, and diagnostics stay stable.
- Both tests fail against the HEAD router and pass now.
- The real-Collector harness is identical for ordered Collector delivery and
  for direct traces-before-logs delivery.
- Router plus attribution-contract tests pass 196/196, and the full JavaScript
  suite passes 583/583. The frozen workspace-attribution contract is unchanged.

Housekeeping, also completed: the two pre-existing Python failures were fixed
at their source.
- **Fallback-pid test:** it asserted the stale `$(<"$fallback_pid_file")`
  form. The implementation's `cat … 2>/dev/null || true` deliberately
  tolerates the pid file disappearing between the `-f` check and the read
  under `set -e`, so the assertion now matches.
- **Claude skill-view test:** it depended on the live install under
  `$CODEX_HOME/provider-runtime`. It now renders the role views from
  `.rulesync/skills` into a temporary `CODEX_HOME`, so it passes without an
  install.

The running router keeps the previous code until the next installer run
(`bash scripts/install.sh --enable-otel-collector`),
which restarts it.

Enable/rollback procedure:

```bash
# Optional: provision the pinned host-local binary explicitly.
bash scripts/otel/provision-autodev-otel-collector.sh

bash scripts/install.sh --enable-otel-collector
bash scripts/install.sh --check
bash scripts/install.sh --disable-otel-collector
bash scripts/install.sh --check
```

Phase 4's gate evaluations are complete (2026-09-15). The Claude, GitHub
Copilot, and Antigravity OAuth-native candidates are all closed, and each
incumbent path is retained (see Phase 4). The next migration step is Phase 5,
the MiniMax API-transport evaluation (completed 2026-09-15: the adapter was retained and simplified). Two Phase 4 follow-ups remain:
- the Copilot SDK/ACP incumbent-simplification candidate;
- the owner's policy decision on headless `agy` automation.

### First deployment

```text
Codex -> Collector -> existing AutoDev OTLP aggregator
                  \-> optional generic backend
```

### Then

- Point LiteLLM telemetry at Collector during provider pilots
- Point remaining provider bridges/adapters at Collector
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
- Incumbent bridge-native spawn accounting
- Existing status/dashboard aggregation

### Exit gate

Existing AutoDev metrics remain identical in meaning and do not double-count after Collector insertion

**Met (2026-09-15).** See Status. Arrival-order independence and log/trace
redelivery idempotency were completed the same day; see the completed
follow-up item.

---

## Phase 4 — Evaluate OAuth-native Codex model providers against incumbent subscription CLI paths

The preferred simplification is one Codex harness with normal `[model_providers.*]` entries, but this phase is explicitly an evaluation. Migrate each OAuth-backed provider independently only after the provider migration gate passes. Until then, its current CLI/bridge remains the supported path and rollback baseline

### Claude OAuth pilot

This is a high-value pilot because the current Claude bridge is large and Claude Code's own `Agent`/`Task` orchestration is already disabled by that bridge

#### Status

The Claude Responses boundary is frozen by `tests/fixtures/contracts/claude-responses-contract.json` and `tests/claude-responses-contract.test.ts`. The suite runs the typed AutoDev bridge with a fake local Claude CLI and loopback telemetry server, covering normal and streaming responses, direct and shell skill reads, tool continuation and item IDs, permission denial, provider-limit incomplete output, authentication failure, privacy sanitization, and telemetry without contacting Anthropic or requiring credentials. This is the offline parity baseline for the supported Claude Code CLI path.

**Policy/operational gate evaluated (2026-09-15): the OAuth-native candidate is
closed, and the incumbent bridge is retained.** Anthropic's Claude Code
[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
page ("Authentication and credential use") states:
- OAuth authentication "is intended exclusively for purchasers of Claude Free,
  Pro, Max, Team, and Enterprise subscription plans and is designed to support
  ordinary use of Claude Code and other native Anthropic applications."
- Developers "should use API key authentication", and Anthropic does not
  permit them "to route requests through Free, Pro, or Max plan credentials" or
  to "collect, store, or intermediate Claude.ai credentials or session tokens."

A Codex `[model_providers.*]` route that carries a subscription OAuth token
over a direct or LiteLLM Anthropic transport is exactly that disallowed use. It
therefore fails the gate's "acceptable policy/API dependencies" requirement
whatever its technical parity, and Anthropic enforces this server-side.

No live OAuth transport was built, and no token was sent anywhere. The
incumbent path has the permitted shape:
- The bridge runs the unmodified Claude Code binary (`~/.local/bin/claude`)
  signed in with the user's own subscription token.
- CI runs the pinned official `@anthropic-ai/claude-code@2.1.263` package.

It stays within policy only for the user's own ordinary, individual use.
`tests/subscription-provider-policy-gates.test.ts` freezes this result. It checks the
exact set of reviewed files that reference `CLAUDE_CODE_OAUTH_TOKEN`, that the
bridge runs the Claude Code binary, that CI pins the official package, and
that no Codex model provider or router route talks to Anthropic directly.

One observation: `.github/workflows/claude-invoke.yml` passes
`openai_base_url: 'https://api.anthropic.com'`, but the Claude CI provider
never reads it. It is inert but misleading.

**API-key alternative — rejected by the owner (2026-09-15); the Claude pilot is
closed.** A Codex model provider authenticated with an Anthropic API key would
be permitted, but it would move Claude usage from subscription to pay-as-you-go
API billing. Subscription/OAuth-based usage and billing is a hard requirement
(see Requirements), so that route will not be piloted.

With both candidates closed, the Claude Code bridge is the permanent supported
Claude path. Reopen this pilot only if Anthropic permits subscription OAuth for
a non-Claude-Code model-provider route. The comparison checklist below is
retained for that case:

- OAuth token bootstrap, refresh, expiry, and secure storage
- OpenAI Responses request/stream fidelity
- Function, namespace, custom, and freeform tool behavior
- Tool-call → tool-result → next-turn continuation
- Reasoning effort/model selection
- Provider rate-limit/reset semantics
- Cancellation and long-running turns
- Role, permission, workspace, usage, and telemetry attribution

### Claude exit gate

Do not delete the supported Claude Code CLI bridge or its launch/ensure lifecycle while the OAuth-native Codex model-provider route is prohibited. The AutoDev-owned implementation has migrated to `src/providers/claude.ts`; only a future policy change plus a fully equivalent replacement could justify retiring the CLI boundary.

**Outcome (2026-09-15): retain the existing bridge permanently.** A subscription-OAuth route cannot pass the policy requirement, and an API-key route violates the subscription-billing hard requirement. The bridge is not a deletion candidate unless Anthropic's policy changes.

### GitHub Copilot OAuth pilot

#### Status

The existing Copilot offline golden-fixture contract remains the parity baseline. The fixture at
`tests/fixtures/contracts/copilot-responses-contract.json` and the boundary
suite at `tests/copilot-responses-contract.test.mjs` replay representative JSONL
normal-turn, direct-file and shell-based skill-read, permission-denied, and
provider-limit inputs through a fake local Copilot CLI. They freeze the SSE lifecycle, item/status
shape, `[DONE]` termination, telemetry observations, and provider-limit
incomplete payload without installing LiteLLM, contacting GitHub, or changing
the current Copilot proxy. The test normalizes generated IDs and timestamps,
verifies the tracked fixture remains unchanged, and checks prompt-content
privacy.

**Operational/policy gate evaluated (2026-09-15): the LiteLLM candidate is
closed, and the incumbent Copilot CLI/proxy is retained.** Evidence from the
installed LiteLLM (`litellm/llms/github_copilot/authenticator.py`,
`common_utils.py`):
- The `github_copilot` provider runs a device flow with a hard-coded GitHub
  OAuth client id, `Iv1.b507a08c87ecfe98`. That is an existing Copilot editor
  app id, not one registered to LiteLLM or AutoDev.
- It exchanges the resulting token at the undocumented
  `https://api.github.com/copilot_internal/v2/token` endpoint.
- It sends `editor-version: vscode/…` headers. The route therefore presents
  itself as a first-party Copilot editor client.

GitHub neither documents nor supports that endpoint for other clients; the only
public community thread asking whether it may be used outside VS Code has no
GitHub answer
([discussion #178117](https://github.com/orgs/community/discussions/178117)).
Anything built on it can break without notice and exposes the account to
enforcement.

GitHub's published terms add no explicit allowance. The
[Generative AI Services Terms](https://github.com/customer-terms/github-generative-ai-services-terms)
that replaced the Copilot Product Specific Terms on 2026-03-05 govern
volume-licensing customers and defer acceptable use to GitHub's Acceptable Use
Policies. The general
[Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)
(Section H, "API Terms") allow suspension for "abuse or excessively frequent
requests" and prohibit sharing tokens to exceed rate limits. The candidate
therefore fails the gate's "supported upstream
behavior", "upgrade risk", and "acceptable policy/API dependencies"
requirements, whatever its technical parity. No LiteLLM Copilot route was
configured, and no GitHub credential was used.

GitHub does offer supported, subscription-billed programmatic interfaces:
- The [Copilot SDK](https://github.com/github/copilot-sdk), generally available
  since [2026-06-02](https://github.blog/changelog/2026-06-02-copilot-sdk-is-now-generally-available/).
  It is JSON-RPC to the Copilot CLI in server mode, and usage is billed against
  the Copilot allowance.
- `copilot --acp`, an Agent Client Protocol server built into the installed
  Copilot CLI 1.0.80.

Both keep the Copilot agent runtime in the request path and expose an agent
session, not a plain model endpoint. A CLI-free Codex model provider is
therefore not available through any supported interface.

**Follow-up candidate (added, not started): replace the incumbent's
per-request CLI spawn with a supported persistent session.** Today the proxy
spawns `copilot --prompt … --output-format json` for each request. A Copilot
SDK or ACP session could replace that spawn and the JSON-line parsing with a
stable, supported protocol, while keeping subscription billing and the
retained CLI runtime. It must pass the frozen
`copilot-responses-contract` baseline and remove more complexity than it adds.

`tests/subscription-provider-policy-gates.test.ts` freezes this result. No
runtime file may use `copilot_internal`, the borrowed client id,
`api.githubcopilot.com`, or a LiteLLM `github_copilot/` route. The proxy must
spawn the official `copilot` CLI, and the Copilot route must stay on the local
proxy.

Compare against the incumbent Copilot path for:

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

LiteLLM currently uses GitHub's internal Copilot token endpoint, so validate operational and policy acceptability before removing the CLI path (evaluated 2026-09-15: not acceptable, see Status)

### Copilot exit gate

Delete the AutoDev Copilot CLI/proxy path only if the OAuth-backed Codex model provider passes the full provider migration gate and removes more complexity than it introduces. Otherwise retain the incumbent path

**Outcome (2026-09-15): retain the incumbent path.** No supported subscription-billed Copilot transport exists without the Copilot CLI, and the LiteLLM route failed the policy/operational gate. The proxy is not a deletion candidate; only its CLI invocation may be simplified (see the follow-up candidate).

### Antigravity OAuth pilot

The preferred target is the same, but the replacement transport is not yet proven. Test whether Codex can address Antigravity through a normal model-provider entry using OAuth/subscription credentials without launching `agy`

#### Status

**Supported-transport question answered (2026-09-15): no supported
subscription-billed Antigravity transport exists without `agy`. The candidate
is closed, and the incumbent bridge is retained.**

**1. Antigravity OAuth outside Google's clients is prohibited.** Section 6
("Prohibited Uses") of the
[Google Antigravity Additional Terms of Service](https://antigravity.google/terms)
states: "Using third party software, tools, or services to access the Service
(e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement."
A gemini-cli maintainer's announcement
([google-gemini/gemini-cli#20632](https://github.com/google-gemini/gemini-cli/discussions/20632),
2026-02-27) confirms that "using third-party software, tools, or services to
harvest or piggyback on Gemini CLI's OAuth authentication to access our
backend services" is prohibited, after Google suspended accounts (including
paid Ultra subscribers) for exactly that. A direct or LiteLLM transport that
reuses `agy` OAuth credentials therefore fails the policy gate outright, and
using it would risk the account.

**2. Google's supported programmatic paths without the CLI are API-key
billed.**
- The [Antigravity SDK](https://antigravity.google/docs/sdk/overview/)
  (`google-antigravity`, v0.1.x, preview) documents `GEMINI_API_KEY` or Vertex
  AI Application Default Credentials. The open request to support Google
  Account OAuth or reuse the CLI's credentials
  ([antigravity-sdk-python#20](https://github.com/google-antigravity/antigravity-sdk-python/issues/20),
  opened 2026-05-21) has no maintainer response.
- The Gemini API
  [Antigravity agent](https://ai.google.dev/gemini-api/docs/antigravity-agent)
  (preview) authenticates with `x-goog-api-key` and bills pay-as-you-go by
  model tokens and tool use. It is a managed agent on the Interactions API,
  not an OpenAI-compatible model endpoint.

Both violate the subscription-billing hard requirement.

**3. Incumbent shape.** The bridge runs Google's own `agy` CLI with
`-p … --output-format stream-json` per request. The installed `agy` 1.2.3 also
offers a persistent `--input-format stream-json` mode, but no server or ACP
mode.

**Open policy question for the incumbent (owner decision, not a code
change).** The Additional Terms prohibit third-party software "to access the
Service" and use "in connection with products not provided by us". The bridge
only invokes Google's official CLI, which performs all access. But it drives
`agy` headlessly from AutoDev and Codex orchestration, and Google has not
published an explicit allowance for that. Unlike Anthropic (which explicitly
permits the unmodified Claude Code binary with the user's own subscription)
and GitHub (whose Copilot SDK exists to embed the CLI), this remains an
unresolved account risk. Confirm acceptability with Google, or accept the risk
explicitly, before relying on the bridge for heavy automated use.

`tests/subscription-provider-policy-gates.test.ts` freezes this result. No
runtime file may reach `cloudcode-pa.googleapis.com` without `agy`. The bridge
must spawn the official `agy` CLI, and the Antigravity route must stay on the
local adapter.

Use the existing Antigravity boundary fixture from Phase 0 as the incumbent contract. Before deleting the bridge, prove:

- Supported OAuth token acquisition/refresh without the Antigravity CLI in the request path
- Compatible Responses streaming and continuation
- Codex tool/namespace/custom/freeform behavior
- Role/tool/MCP enforcement remains correct
- Provider-limit/error mapping and telemetry parity
- Operational supportability and upgrade stability

### Antigravity exit gate

Delete the Antigravity CLI bridge only after a supported direct/shared OAuth transport passes the full provider migration gate. If no candidate does, retain the bridge as the supported implementation

**Outcome (2026-09-15): retain the bridge as the supported implementation.** No supported subscription-billed transport exists without `agy`. Reopen only if Google supports subscription OAuth in the Antigravity SDK or another non-CLI interface.

---

## Phase 5 — Evaluate simplification of the MiniMax API-backed Codex model provider

MiniMax remains API-key-backed. The goal is to test whether bespoke protocol translation can be removed, not to change its authentication model

### Status

The Phase 5 slice is now landed as an offline boundary contract for the
incumbent MiniMax Responses pass-through adapter. The adapter's first provider
bridge conversion is also complete: its implementation now lives in the
strictly checked `src/providers/minimax.ts`, the installer and CI execute that
typed module directly, and the obsolete `scripts/codex-minimax-responses-proxy.mjs`
entrypoint has been deleted. This is an implementation/runtime ownership
change only; the transport remains the retained local boundary adapter and no
provider retirement gate has been bypassed. The fixture at
`tests/fixtures/contracts/minimax-responses-contract.json` and the boundary
suite `tests/minimax-responses-contract.test.ts` exercises the adapter's pure
helpers (`rewriteOutboundPayload`, `isWebResearchTool`,
`freeformInputFromArguments`, `coerceResponseBody`) against normal-stream
namespace flattening, freeform tool coercion, and preserved web-research
tools, without contacting the remote API, deploying LiteLLM, or changing the
live proxy. `coerceResponseBody`/`freeformInputFromArguments`/`isWebResearchTool`
remain exported from the typed module so the test can drive the same logic the
live adapter runs. The test asserts the
request tool shape the proxy sends upstream, the response namespace the
proxy hands back to the caller, and the `function_call -> custom_tool_call`
rewriting Codex needs to run freeform `exec`.

**✅ Transport evaluation completed (2026-09-15): retain the adapter, simplified; direct and LiteLLM transports rejected.**
Each proxy responsibility was checked against five kinds of evidence:
- MiniMax's own documentation;
- the exact requests Codex 0.154.0 sends, captured by pointing `codex exec` at a
  local endpoint in an isolated `CODEX_HOME`, for both the `minimax` profile path
  and the router's `autodev/*` responses-lite path;
- minimal live MiniMax probes, using synthetic prompts only;
- a hermetic end-to-end `codex exec` against a fake upstream that returns
  MiniMax's observed shapes;
- a scan of all 5,583 local Codex rollouts.

| Responsibility | Evidence | Outcome |
| --- | --- | --- |
| Namespace tool flatten / re-expand | The router already flattens outbound tools and re-expands namespaces on every non-Codex route. A live probe showed MiniMax accepts a top-level `namespace` tool and returns `function_call` with `namespace` set, both directly and through the simplified adapter. | **Removed from the proxy (duplicate).** Owned by the router. |
| Custom/freeform `exec` coercion | The [Create Response](https://platform.minimax.io/docs/api-reference/responses-create.md) reference documents only `function` tools. Live, MiniMax now returns native `custom_tool_call` for `exec`, or calls the nested `exec_command` directly, which Codex executes natively (hermetic test). But `exec` called with JSON arguments still makes Codex abort the turn ("tool exec invoked with incompatible payload"). Rollouts show 1,049 real coercions across 23 sessions (2026-07-14 to 2026-09-10). Every recognisable-shape miss predates the coercion (2026-09-08). | **Retained** as a safety net against a fatal, recently frequent upstream pattern. It has not fired since 2026-09-10. |
| Request headers | Codex sends `session-id`, `thread-id`, `x-codex-window-id`, `x-client-request-id`, and `x-codex-turn-metadata`. In a git workspace the metadata includes the absolute workspace path, git remote URLs, and the commit hash. The router adds `x-autodev-agent-role`, `x-autodev-session-id`/`-scope`, `x-autodev-request-id`, and `x-autodev-agent-events-url`. The proxy stripped only two of these, so the rest reached `api.minimax.io`. | **Defect fixed:** only `accept`, `authorization`, and `content-type` leave the machine. |
| Request body | Codex duplicates the full turn metadata into `client_metadata["x-codex-turn-metadata"]` (confirmed with a throwaway git repo and fake remote), and the proxy forwarded the body unchanged. MiniMax does not define the field, and live requests without it succeed. | **Defect fixed:** `client_metadata` is removed before the payload leaves the machine. |
| Item ids | MiniMax still mints `<hex>_rs`, `<hex>_fc_<n>`, `<hex>_custom_<n>`, and `<hex>_msg`. | Unchanged: the router's normalization remains required. |
| Reasoning, tool choice, web search | MiniMax accepts `reasoning.effort` `none`/`high` and `reasoning.context`, `tool_choice: auto`, `parallel_tool_calls`, strict `function` tools, and `{"type":"web_search"}` ([Server Tools](https://platform.minimax.io/docs/guides/server-tools.md)). | Pass-through; nothing needed. |
| Error mapping | An unknown model returns HTTP 400 `{"error":{"message":"invalid params, code: 2013 …","code":"invalid_prompt"}}`, passed through unchanged. | Unchanged: the router classifies failures. |
| Tool, activity, and MCP exposure telemetry | Only the proxy observes requested/executed/unavailable tool calls on this route. | **Retained.** |

**Why the proxy is not retired.**
- **Direct Codex → MiniMax** is MiniMax's own documented
  [Codex setup](https://platform.minimax.io/docs/token-plan/codex.md). It would
  send workspace paths and git remotes (header and body), lose the fatal-pattern
  coercion, and lose tool telemetry.
- **Router → MiniMax** would require moving the header/body boundary, coercion,
  and telemetry into the router, which contradicts Phase 6's goal of shrinking
  the router.
- **LiteLLM** adds nothing: MiniMax needs no protocol translation, and an extra
  hop would add a daemon and a translation risk without removing any
  responsibility.

**What changed.**
- The proxy is now a documented boundary adapter: an allowlisted header set,
  `client_metadata` removal, freeform coercion, and telemetry.
- The duplicated flatten/re-expand helpers were deleted.
- `tests/minimax-proxy.test.ts` now pushes the router's real `downstreamHeaders`
  output plus Codex's native headers through the proxy, and requires that none
  of them, and no workspace path, reaches upstream.
- The boundary fixture moved to `autodev-minimax-responses-contract-v2`:
  namespace tools forwarded, `client_metadata` dropped, web search preserved,
  and coercion retained.
- The live check through the simplified proxy returned HTTP 200 streams with
  every `event:` line intact and MiniMax's native namespace preserved.
- The installer deploys the typed adapter under `$CODEX_HOME/src/providers/minimax.ts`; stale copies of the deleted `.mjs` entrypoint are removed during reconciliation.

**✅ Residual items resolved (2026-09-15).**

**1. Unrecognisable `exec` calls now give actionable feedback.** 134 historical
MiniMax `exec` calls carried `{}` and 11 used unrecognised keys. None produced a
usable output, and 121 of those 145 were followed by the same broken call.
Intent is still never guessed. Instead, such a call becomes a `custom_tool_call`
whose script throws an explanation: it names only the argument keys, says `exec`
takes raw JavaScript, and shows `await tools.exec_command({ cmd })`.
- A hermetic `codex exec` through the adapter returned that message to the model
  as `Script error: …`, with no incompatible-payload abort.
- Tests: `tests/minimax-proxy.test.ts` covers the streaming and non-streaming
  paths and checks that values are never echoed. The contract fixture gained
  `freeform_unrecognised_feedback`.

**2. CI now uses the same boundary as a workstation.**
- **Credential leak found and fixed.** `agent-invoke.yml` had embedded
  `GH_USER_TOKEN` in the target checkout's git remote URL. Codex copies
  unsanitized remote URLs into its turn metadata
  ([openai/codex#31588](https://github.com/openai/codex/issues/31588)), so
  `mini-max-codex` would have sent the PAT to MiniMax. The remote is now
  token-free. A local, env-backed credential helper for `https://github.com`
  (after an empty entry that resets the helper list) answers from `GH_TOKEN` at
  use time, so no config file or URL contains the token. The obsolete URL
  redaction helper was deleted.
- **CI now routes through the adapter.** `run-ci-provider.sh`'s `mini-max-codex`
  branch copies the tracked `minimax` profile and model catalog into a job-local
  `CODEX_HOME` and starts the tracked adapter on loopback. It refuses a port
  something else already serves, waits for `/health`, and stops the adapter on
  exit. `minimax-codex-invoke.yml` no longer sets a direct `api.minimax.io`
  base URL.
- **Why this option.** LiteLLM would add a daemon and still need custom
  header/body/coercion logic. Rulesync cannot own a transport. Codex has no
  switch to omit the metadata.
- **Local CI simulation.** It ran with the pinned `@openai/codex@0.153.4`, a
  target remote embedding a fake token, and the skill's recorder as upstream.
  - The provider exited 0, the tool ran through the adapter, and the adapter
    stopped.
  - Upstream received no token, private repository name, `client_metadata`, or
    Codex/router header.
  - The working directory still appears inside Codex's own environment-context
    prompt message, which every model receives so it can run commands. That is
    prompt content, not metadata.
- **Tests:** `tests/workflows.test.ts` freezes the adapter route, the token-free
  remote, and the helper. Its helper test runs `git credential fill` isolated
  from the machine's global and system git config.

Current configuration already exposes MiniMax as `[model_providers.minimax]` with `MINIMAX_API_KEY`; its `base_url` points to the local proxy today

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

Point the existing MiniMax Codex model-provider entry at a direct/shared API transport and retire `src/providers/minimax.ts` only after all required Codex tool patterns and the applicable provider migration gates pass. Otherwise retain the current proxy

**Outcome (2026-09-15): retain the proxy, reduced to its boundary, coercion, and telemetry responsibilities.** A direct or LiteLLM transport fails the privacy boundary, the `exec` coercion requirement, and usage-telemetry parity. Reopen only if Codex stops embedding workspace metadata in provider requests and MiniMax's `exec` JSON pattern stays absent long enough for the coercion to be judged obsolete.

---

### Completed provider bridge conversion — GitHub Copilot (2026-09-17)

The Copilot CLI remains the supported subscription transport, but its AutoDev
Responses boundary is no longer a legacy `.mjs` implementation.
`scripts/codex-copilot-cli-responses-proxy.mjs` was moved to the strictly
checked `src/providers/copilot.ts`; the typed module preserves the existing
CLI invocation, Responses streaming and continuation shapes, role-specific MCP
configuration, skill-read detection, provider-limit payloads, and
tool/activity/skill/MCP telemetry. The installer deploys it through the
`runtime_module_names` manifest, the launch wrapper executes the installed
TypeScript source directly, and reconciliation removes stale `.mjs` copies.

The frozen offline Copilot contract remains the retirement baseline:
`tests/copilot-responses-contract.test.mjs` now imports the typed module and
continues to exercise a fake official CLI, while the MCP-scope, bridge-role,
telemetry, workflow, installer, and subscription-policy checks use the new
path. `pnpm typecheck` and the focused Copilot suites pass. This is an
implementation/runtime ownership migration only; the provider CLI is retained
per the Phase 4 policy and supportability decision.


### Completed provider bridge conversion — Antigravity (2026-09-17)

The Antigravity CLI remains the supported subscription transport because the
Phase 4 policy gate found no supported subscription-billed non-CLI interface.
Its AutoDev Responses boundary has nevertheless moved to the typed runtime:
`scripts/codex-antigravity-cli-responses-proxy.mjs` was replaced by the
strictly checked `src/providers/antigravity.ts`. The conversion preserves the
CLI invocation, workspace and permission boundaries, role-specific MCP and
skill exposure, Responses streaming and continuation behavior, provider-limit
handling, activity/tool telemetry, and bridge-native spawn-session accounting.

The installer manifest deploys the typed module directly, the launch wrapper
executes the installed TypeScript source, and reconciliation removes stale
`.mjs` copies. The frozen offline Antigravity Responses contract and dedicated
bridge-delegation, MCP-scope, role, telemetry, installer, and policy tests now
exercise the typed path. This is an implementation/runtime ownership migration
only; it does not reopen the closed OAuth-native provider retirement gate.


## Phase 6 — Shrink the AutoDev router around retained semantics

Rulesync hook declaration ownership is complete: `.rulesync/hooks.jsonc` is the
only declaration source, while AutoDev scripts remain implementations. The
installer generates and checks repository projections, including `.codex/hooks.json`
in the active project location. The Codex projection cannot represent
`prevent_idle_sleep`; Copilot and Antigravity projections are intentionally lossy.

**Status (2026-09-17):** Router HTTP and upstream proxy execution are now
fully decomposed into the typed `src/router/http.ts` and `src/router/proxy.ts`
modules. Endpoint routing, workspace/session continuity, status aggregation,
agent-event ingestion, header/payload boundaries, streaming, retry/fallback,
and exhaustion diagnostics retain their existing contracts. The legacy
`scripts/codex-model-router.mjs` remains only as the executable/public
re-export entrypoint; provider policy, cooldowns, telemetry, and lifecycle
ownership remain explicit typed modules. Phase 6 remains in progress because
that final executable entrypoint and the remaining first-party test/runtime
paths still require migration and parity proof. The provider implementation slices are complete for MiniMax, Copilot,
Antigravity, and Claude: they run from `src/providers/minimax.ts`,
`src/providers/copilot.ts`, `src/providers/antigravity.ts`, and
`src/providers/claude.ts`, while their retained boundary responsibilities
remain outside the router. The obsolete Copilot `.mjs` and Claude Python
implementations were deleted after their frozen Responses, MCP, skill-read,
tool-outcome, limit, activity, and spawn-session contracts passed through the
typed modules; installer/runtime projections now deploy typed sources directly
and remove stale copies. The router status presentation also moved out of
`scripts/`: `src/cli/router-status.ts` now consumes the typed
`src/router/status.ts` boundary, installer runtime projections deploy it under
`$CODEX_HOME/src/cli/`, and the obsolete `codex-model-router-status.mjs`
entrypoint is removed and reconciled from older installations. Its JSON and
human-readable output remain covered by the dashboard/status snapshot tests.
The router ensure decision and lifecycle owner also moved to
`src/platform/router-ensure.ts`; `src/hooks/session-start.ts` invokes it
without shelling out, and its injectable tests freeze launchd ownership,
locking, readiness, fallback, PID safety, and duplicate detection. The typed
owner retains the ensure hook's best-effort Copilot side effect through
`src/platform/copilot-ensure.ts`, while `scripts/ensure-codex-model-router.sh`
now remains only as the installed process-dispatch shim.
The provider lifecycle slice is now typed as well. Claude and MiniMax
model-gated ensure decisions live in `src/platform/claude-ensure.ts` and
`src/platform/minimax-ensure.ts`; Copilot's typed owner is now an executable
boundary. The corresponding `scripts/ensure-codex-{claude,minimax,copilot}-*`
files are process-dispatch shims only, and the MiniMax `--daemon` launchd path
executes `src/providers/minimax.ts` directly so launchd supervises the server
rather than a short-lived ensure process. `src/hooks/subagent-start.ts` calls
all three typed owners directly in a fail-closed sequence, while the existing
Antigravity owner remains the same typed path. Native TypeScript lifecycle
contract tests cover model gating, credential/CLI checks, launchd adoption,
private fallback behavior, and the no-duplicate invariant. This removes
provider policy and readiness logic from the subagent hook without changing
provider transports or the closed OAuth retirement gates.

The installer reconciliation slice also moved Antigravity's machine-local JSON
policy out of embedded Python. `src/platform/antigravity-settings.ts` now owns
permission grants and the global code-skill registration, including typed JSON
validation, duplicate removal, atomic `0600` writes, and check-mode diagnostics.
The installer keeps only optional CLI detection, root collection, and invocation
of that typed owner. The native TypeScript settings contract covers root
normalization, preserved user entries, disabled Playwright removal, stale skill
registration, and idempotence; the existing Rulesync permission-generation gate
remains unchanged.

The installer runtime-file slice is now typed. `src/platform/runtime-files.ts`
owns checkout-to-`CODEX_HOME` target mapping, atomic replacement of runtime
files, symlink removal, mode assignment, and content drift checks. Runtime
modules, rendered prompt roles, and generated role files now use that owner
instead of inline `install`/`cmp` policy. The same owner now handles absolute
symlinks, canonical skill-source validation, and link drift checks; native
TypeScript tests cover path mapping, atomic replacement, symlink handling,
modes, and drift detection.
The remaining shell installer file is a process-dispatch shim; typed CLI
modules own install and check orchestration, including the temporary Codex MCP
projection.
Obsolete launch-agent filesystem cleanup, stale runtime files, stale hooks,
and obsolete runtime directories now use `src/platform/runtime-reconciliation.ts`
with explicit path-kind contracts and symlink-safe removal. The installer no longer owns filesystem reconciliation or service policy in shell;
service restart and Collector management are typed owners as well.

The service-restart slice is now typed in `src/platform/service-restart.ts`.
That owner checks every label for a foreign `CODEX_HOME` runtime before it
touches any of them, then per label: boots the old job out and waits until
launchd has unloaded it (a job that outlives the wait is reported rather than
bootstrapped over), stops any matching stale listener and waits for the port
to be released, enables, and bootstraps. Every plist sets `RunAtLoad`, so
bootstrap starts the service; there is no `kickstart -k`, which killed the
fresh instance mid-startup and stalled each label for launchd's
`ThrottleInterval`. It then checks all services in parallel: ready, and served
by the launchd job's own process, with a crash-looping job reported at once
alongside the tail of its log. Readiness is an in-process HTTP probe; reading a
job's launchd state spawns `launchctl`, so an unready service's job is read
only every eighth attempt. Measured during a real install, a read on every
attempt stretched the services' own launches of Node and `otelcol` to 17s and
pushed the Collector past the readiness window; throttled, the worst launch
was under 7s and every service was ready in about 13s. A router or Collector that is not running fails
the install; a provider bridge only warns. The direct ensure hooks run only
when launchd is unavailable or refused a label, and the owner forwards the
Collector configuration to them. The installer now invokes the
owner as a process-dispatch boundary; installer-wide orchestration is now
owned by the typed install coordinator.
The Collector foreground and ensure slice is now typed in
`src/platform/otel-collector.ts`. Exact pinned-version/config validation,
listener duplicate protection, readiness, private state, and direct fallback
are owned there (a foreground start checks the pinned version and leaves config
validation to `otelcol --config` itself; `--check` runs `otelcol validate`); the `ensure-*` and `run-*` Collector scripts are dispatch
shims. The pinned artifact downloader/provisioning slice is now typed in
`src/platform/otel-provision.ts`: it validates the pinned manifest, selects the
host asset, downloads and verifies its SHA-256, extracts the binary, and installs
it with private permissions. The host asset follows the machine's architecture
(`src/platform/host-arch.ts`), not the provisioning Node's: a Node running under
Rosetta reports `x64` on Apple Silicon and once provisioned an Intel Collector
whose translated cold start outlasted the installer's readiness window. An
installed Collector built for another architecture is replaced, through a
staged file and a rename so a running Collector keeps its own inode. `provision-autodev-otel-collector.sh` is now only a
process-dispatch shim; installer-wide orchestration is owned by the typed
install coordinator.

The top-level install materialization sequence is now typed in
`src/platform/install-materializer.ts`. It owns runtime/role/link deployment,
stale cleanup, Rulesync repository and user projections, composed Codex config,
provider skill/MCP views, Antigravity settings, LaunchAgent rendering, and
private run-log setup. The shell installer now dispatches this sequence and
then the typed service-restart owner; the shell installer is now only a
process-dispatch entrypoint.

The concrete `autodev install` backend now lives in
`src/platform/install-command.ts`. It owns normal-install option validation and
coordinates typed mode/auth state, dependency setup, Collector provisioning,
materialization, and service restart. The shell installer dispatches the same
backend for normal installs and the typed `install-check` backend for `--check`;
it is now only a process-dispatch entrypoint.

Install-state policy is now typed in `src/platform/install-state.ts`. Collector
mode read/write and router-auth token creation preserve the private-file and
idempotence invariants without shell parsing or `openssl`; the installer only
parses options and dispatches the owner. External dependency setup is now
also typed in `src/platform/dependencies.ts`, including pipx provisioning,
pinned CodeGraphContext/CocoIndex/Python-LSP installation, and macOS native-build environment
preparation. The shell installer retains no application logic; option/check
orchestration and the temporary Codex MCP projection are typed.

LaunchAgent template rendering and drift checks now use the typed macOS owner
`src/platform/macos/launchagent.ts`, including atomic output and literal-safe
substitution for machine-local paths. The installer retains only the template
source list and process-dispatch calls.
The first test-stack slices are now complete: the AutoDev request-capture
recorder and its contract suite, bridge-role contract, portable configuration
contract, Copilot MCP contract, workflow contract, workspace-attribution
contract, native-vs-bridge contract, agent-reconciliation contract,
Antigravity delegation contract, router workspace-telemetry contract,
dashboard/status contract, MiniMax proxy contract, agent-instructions
contract, Rulesync-permissions/MCP/hooks contracts, Collector config/runtime
contracts, and root-delegation hook contract now use native TypeScript; the superseded
`.mjs` and Python files for those slices are removed. The final legacy suites
are the metrics/telemetry tests and the local setup test. The vendored recorder remains repository-only
skill content and is still offline; this does not change provider transport or
capture privacy semantics.

**Status (2026-09-17) — cross-provider orchestrator delegation.** The
execution contract now records an explicit provider `delegation` mode instead
of treating every route as spawn-capable. Codex uses native delegation; Claude and Copilot use a per-request
`autodev_spawn` MCP shim, while Antigravity uses the static Rulesync MCP
registration with the identified bridge session injected into the shim
environment. All three shim paths return one synthetic Codex `exec` item, so
the Codex runtime creates the child and the router records it as
`router_alias`. MiniMax remains available for leaf/default
roles but is removed from the root orchestrator fallback tier because its
adapter has no supported delegation path. The Copilot bridge now owns the same
session-key validation, bridge endpoint, cleanup, recovery script, and
synthetic tool-call boundary already used by the other CLI bridges. Its
telemetry continues through the shared agent-event reporter for tool/activity
observations, while child creation and usage remain on the native router path;
this avoids counting one child as both a Copilot bridge-native spawn and a
router alias.

**Telemetry hardening (2026-09-17).** Provider delegation is now fail-closed
against the generated execution contract: a route is not considered
orchestrator-capable unless its provider entry declares `native`, `codex-shim`,
or `bridge-native`. A stale `spawnTools` list cannot re-enable a provider
explicitly declared `none`. Bridge-native synthetic parent activity also stays
open until the parent request reports its terminal outcome, so a child that
finishes early cannot cause a later failed parent turn to be recorded as a
success. The focused `tests/router/subagents.test.ts` suite freezes both
invariants.

Rulesync's `subagents` feature was evaluated against this boundary and remains
deferred for AutoDev roles. Rulesync can generate provider-native agent files,
but those files would become a second owner for sandbox/MCP/skill/role policy
and would bypass the Codex-owned child lifecycle. Static shared MCP, hooks, and
skills remain Rulesync-owned; the session-scoped `autodev_spawn` definition is
intentionally generated by each bridge, not placed in a global Rulesync
projection. Reopen Rulesync subagent generation only after an exact role and
telemetry parity contract exists.

After successful provider transport migrations, separate router responsibilities into:

### Keep

- Role/provider selection policy
- Root/subagent constraints
- Concurrency
- Provider-limit semantics that are not delegated
- Workspace/session continuity
- Required Responses compatibility repairs
- AutoDev semantic telemetry
- Any provider-specific behavior for which no validated dependency replacement exists

### Delete only where upstream demonstrably owns it

- Provider CLI invocation and lifecycle for providers whose replacements pass parity
- Migrated provider HTTP/OAuth transport
- Duplicated generic response normalization
- Duplicated generic retry/health code
- Duplicated provider metrics

### Exit gate

Router code size and responsibility are materially reduced while all Phase 0 contracts still pass. No reduction target justifies deleting a provider path that has not been fully replaced

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
- Convert bridge/adapter child events to normal OTel logs/spans where practical
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
- Provider-neutral discovery where CLI-backed providers were successfully migrated

### Outcome

- If exact, remove the corresponding AutoDev renderer
- If not exact, retain the small semantic renderer rather than forcing the abstraction

---

## Phase 10 — Final cleanup

- Remove launch agents and ensure scripts only for provider CLI/proxy services that have actually been retired
- Keep bootstrap/service lifecycle for Collector, LiteLLM, retained bridges/adapters, MCP runtime, and AutoDev edge as needed
- Remove unreachable compatibility shims
- Update docs and diagrams
- Keep rollback fixtures as regression tests

---

# 7. Requirements

- Local-first operation with no mandatory hosted control plane
- Codex is the intended sole agent runtime
- Prefer OAuth/subscription-backed normal Codex model-provider entries for Codex/OpenAI, Claude, Antigravity, and Copilot only where the replacement is supported and passes the provider migration gate
- Retain the incumbent provider CLI/bridge whenever a candidate dependency or direct transport does not fully cover AutoDev's use cases
- MiniMax remains API-key-backed through its Codex model-provider entry
- Subscription/OAuth-based usage and billing is a hard requirement for the subscription-backed providers: Claude, GitHub Copilot, and Antigravity (owner decision, 2026-09-15). A candidate that moves one of them to API-key or pay-as-you-go billing is rejected rather than piloted
- Prefer direct provider endpoints when wire-compatible; use LiteLLM/shared adapters only where protocol/auth translation is required and proven
- Preserve role/capability behavior and read-only isolation
- Preserve root-orchestrator and child-agent semantics
- Preserve Codex Responses streaming/tool/item/session behavior
- Preserve existing provider-selection policy by default
- Preserve fail-closed telemetry attribution where `unavailable` is not `0`
- Never double-count native and bridge/adapter telemetry
- Keep machine-local state user-owned
- Keep generated configuration deterministic and testable
- Pin upstream dependencies to tested versions
- Require rollback per subsystem
- Require net deletion/simplification before adding a permanent infrastructure layer
- Never delete a working provider path merely because a candidate dependency advertises the relevant feature; prove the actual AutoDev contract first

---

# 8. Remaining unknowns

## Rulesync

- Exact fit for AutoDev's per-role MCP/skill capability model
- Which provider-specific discovery/view generation remains necessary after any successful Claude/Antigravity provider migration
- Which current user-level Codex settings should remain outside Rulesync permanently

## Provider authentication and LiteLLM

- Resolved 2026-09-15: Claude subscription OAuth may not be used outside Claude Code and native Anthropic apps, and API-key billing was rejected, so no Claude transport replacement remains to evaluate.
- Resolved 2026-09-15: GitHub Copilot's LiteLLM path is not policy- or operationally acceptable (undocumented `copilot_internal` endpoint, borrowed editor OAuth client). Still open: whether a supported Copilot SDK/ACP session simplifies the incumbent proxy
- Resolved 2026-09-15: no supported subscription-billed Antigravity transport exists without `agy`. Still open: whether Google accepts headless automation of the official `agy` CLI by AutoDev (owner policy decision)
- Exact MiniMax-M3 namespace/custom/freeform-tool parity through a direct/shared API transport
- Whether AutoDev routing semantics can be represented without custom callbacks
- Whether native Codex/OpenAI OAuth/provider behavior remains fully compatible with the AutoDev routing edge

## Telemetry

- Which local backend, if any, should store/query generic OTel data
- Whether incumbent `/v1/agent-events` semantics can be fully replaced with normal OTel events for each provider that successfully migrates away from its bridge
- Which current dashboard panels remain valuable after generic observability moves upstream

---

# 9. Expected deletion outcome

## Conditional deletion targets

- Repeated cross-provider rules/MCP/hooks/permissions translation where Rulesync reaches parity
- Generic OTLP HTTP receive/process/export plumbing where Collector reaches parity
- Antigravity CLI Responses bridge only after OAuth-native provider parity
- Copilot CLI/Responses proxy only after OAuth-native provider parity
- MiniMax Responses proxy only after direct/shared API parity
- Provider-specific launch/ensure lifecycle only for retired CLI bridges (Claude Code remains supported)
- Generic provider metrics already emitted equivalently by LiteLLM/OTel
- Generic provider transport/retry/health code that becomes redundant after a validated replacement

## Likely justified AutoDev code after migration

- GitHub control plane
- Role/capability contract
- Prompt composition where native Codex requires it
- Execution-contract projection
- MCP launcher/runtime boundary
- Small Codex/AutoDev compatibility edge
- Provider-selection policy if LiteLLM cannot model it cleanly
- Stateful telemetry enricher
- AutoDev-specific dashboard/status views
- Provider CLI bridges or narrow adapters for any provider whose candidate replacement does not satisfy the full contract

The success criterion is therefore **not “delete the router or provider CLIs at all costs.”** It is to leave AutoDev with only the code that is still justified by SimulatorLife/AutoDev-specific semantics or by gaps in available dependencies, while preferring normal Codex model-provider entries and standard OAuth/API transports wherever they have been proven to replace the incumbent implementation safely

## Orchestrator-only `codex_app` MCP for Plan-mode `request_user_input`

The Plan-mode collaboration prompt tells the model to use `request_user_input`
whenever it needs a user decision. The tool is provided by Codex Desktop's
bundled `codex-app-tools` plugin (server name `codex_app`). Plan-mode
breaks unless (a) the plugin is enabled at the user level, (b) Codex
Desktop actually launches the MCP server, and (c) only `request_user_input`
is exposed to the orchestrator model — the plugin's other tools
(`fork_thread`, `create_thread`, `send_message_to_thread`, `handoff_thread`,
`read_thread`, `wait_threads`, `list_threads`, `list_archived_threads`,
`set_thread_pinned`, `set_thread_archived`, `set_thread_title`,
`automation_update`) belong to the AutoDev delegation surface
(`autodev_spawn` / `multi_agent_v1__spawn_agent`) and must not leak
through `codex_app`.

The install flow now keeps all three of these consistent on every run.

- `scripts/install.sh` (the shim into the typed installer) does three
  idempotent setup steps after composing the user config:
  1. **Re-render the execution contract** from `agents/roles/*.toml` and
     the freshly-generated rulesync projection. The previous behaviour
     materialised the contract as a copy of the repo file, which drifted
     the moment a role TOML changed. The renderer now writes directly to
     the runtime target on every install.
  2. **Enable the `codex-app-tools@openai-bundled` plugin** in the
     composed `~/.codex/config.toml`. Touches only the existing
     `[plugins."codex-app-tools@openai-bundled"]` table — never adds a
     new entry — so user-owned plugin state for other plugins is
     preserved.
  3. **Enable the `codex_app` MCP server** inside the bundled plugin's
     `.mcp.json` cache. Iterates every cached version directory, sets
     `mcpServers.codex_app.enabled = true`, and skips the file if the
     entry is missing or already enabled.

- Source declarations that drive the contract shape:
  - `agents/roles/orchestrator.toml` declares
    `[mcp_servers.codex_app]` with `enabled = true` and
    `enabled_tools = ["request_user_input"]`. This is the only role TOML
    that mentions `codex_app`; every other role (default, worker,
    validator, explorer, docs-researcher, browser-tester, smart) is
    silently absent.
  - `.rulesync/mcp.jsonc` declares `codex_app` under
    `codexcli.mcpServers` with `disabled: true` and the same
    `enabled_tools: ["request_user_input"]`. The Codex CLI projection
    keeps the server disabled so Codex CLI sessions never spawn it,
    but the entry exists so the renderer can resolve launch keys for
    the orchestrator role TOML.
  - `src/config/render-execution-contract.ts` adds `codex_app` to
    `MCP_ORDER` and exempts it (and any future plugin-owned MCP) from
    the "orchestrator MCP must be enabled in root config" check via a
    `PLUGIN_MCPS` allowlist.

- Lock-in test: `tests/config/config-rendering.test.ts` reads the
  rendered `config/execution-contract.json` and asserts
  `roles.orchestrator.mcp === ["lsp", "cocoindex-code", "autodev_spawn",
  "codex_app"]` in deterministic order, that
  `roles.orchestrator.mcpTools === { codex_app: ["request_user_input"]
  }`, and that every other role has neither `codex_app` in `mcp` nor in
  `mcpTools`. Any future drift on either the role TOML side or the
  renderer side will fail this test before install --check gets a
  chance.

Re-running `scripts/install.sh` after editing a role TOML is enough to
pick up the change; the steps are idempotent — running install twice in
a row produces the same `~/.codex/src/config/execution-contract.json`,
the same plugin enabled state, and the same MCP server enabled state.

### Re-asserting the codex_app gates on every install

Two independent gates must both be set before Codex Desktop launches the
bundled `codex-app-tools` MCP server and exposes `request_user_input`:

1. the user-level plugin declaration in `$CODEX_HOME/config.toml`
   (`[plugins."codex-app-tools@openai-bundled"]` and its nested
   `mcp_servers.codex_app` table), and
2. the MCP-server entry inside the plugin's own cache at
   `$CODEX_HOME/plugins/cache/openai-bundled/codex-app-tools/<version>/.mcp.json`.

Both are now owned by the install, not patched after the fact.

**Gate 1 is declared in the portable source.** `config/config.autodev.toml`
carries `[plugins."codex-app-tools@openai-bundled"] enabled = true` plus
`[plugins."codex-app-tools@openai-bundled".mcp_servers.codex_app]` with
`enabled = true` and `enabled_tools = [ "request_user_input" ]`.
`compose` treats portable keys as authoritative over existing user state, so
every install re-asserts both values by construction. Previously the portable
source declared the plugin `enabled = false` and the installer mutated the
composed config afterwards — a band-aid that fought its own input. That
mutation (`ensureCodexAppPluginEnabled`) is removed.

**Gate 2 is re-asserted against a sentinel.** Codex Desktop regenerates the
plugin cache on startup, which drops both the `enabled` flag and the tool
allowlist. `ensureCodexAppMcpServerEnabled` therefore runs unconditionally on
every install: for each cached plugin version it compares the cache against
`CODEX_APP_ENABLED_TOOLS`, repairs any difference, and records the outcome in
`$CODEX_HOME/autodev/codex-app-tools-state.json` — deliberately outside the
regenerated cache. The sentinel records, per version, the `enabled` flag and
tool allowlist observed *before* the repair, whether a repair was needed, and
when it happened, plus a top-level `lastInstallRepairedDrift`. It is written on
every install, including clean ones, so "Codex rewrote the cache again" is
distinguishable from "nothing touched it". The sentinel is a record, never a
short-circuit: a sentinel saying the gates were already asserted does not
suppress the next install's check.

Because `enabled_tools` is asserted at the plugin level as well as in
`agents/roles/orchestrator.toml`, the plugin's thread-lifecycle tools
(`create_thread`, `fork_thread`, `handoff_thread`, `read_thread`,
`wait_threads`, `list_threads`, `list_archived_threads`,
`send_message_to_thread`, `set_thread_pinned`, `set_thread_archived`,
`set_thread_title`, `automation_update`) cannot reach any model through
`codex_app`; delegation stays on `autodev_spawn`.

Coverage lives in `tests/platform/codex-app-plugin-gate.test.ts`: cache repair
and sentinel contents, narrowing a widened tool allowlist, idempotence across
two installs, repair of drift reintroduced between installs, multi-version
caches, an absent cache as a no-op, and the portable source declaring both
user-level gates.

