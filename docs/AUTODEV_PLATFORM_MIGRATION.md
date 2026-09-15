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

## Current Codex model-provider shape

`scripts/codex/config.autodev.toml` already exposes the external routes through Codex's `[model_providers.*]` mechanism. MiniMax is already represented as `[model_providers.minimax]` and uses `MINIMAX_API_KEY`, but its current `base_url` still points at the bespoke local MiniMax Responses proxy. Claude and Antigravity are likewise represented as Codex model providers, but those entries currently point at CLI-backed local bridges

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
- Shared MCP declarations (boundary hardening complete; live cutover remains deferred pending target-equivalence decision)
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

### Claude Code Max / Anthropic OAuth

The earlier plan was too conservative in treating Claude Code itself as inherently required. LiteLLM does more than forward a Claude Code client's headers: its Anthropic provider can use `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer ...`, recognizes Anthropic OAuth token handling, and adds the required OAuth beta header

More importantly, AutoDev's current Claude bridge explicitly disables Claude Code's `Agent`/`Task` tools and states that the parent Codex process remains responsible for orchestration. The bridge is therefore not required merely because AutoDev needs Claude Code to be a second agent harness; today it also serves subscription authentication, protocol/tool translation, limits, permissions, and telemetry behavior that a replacement must reproduce or make unnecessary

**Preferred target, conditional on validation:** configure Claude as a normal Codex model provider using Claude subscription OAuth, with LiteLLM providing Responses↔Anthropic translation/authentication if it proves sufficient. Codex continues to own roles, tools, MCP, skills, sandboxing, and orchestration. Retain the Claude Code CLI bridge if the replacement does not fully satisfy the contract

The migration requires parity tests for Responses streaming, namespace/custom/freeform tools, multi-turn tool continuation, reasoning, rate limits, OAuth bootstrap/refresh/expiry, model selection, error fidelity, permissions, and telemetry before deleting the bridge

### MiniMax

LiteLLM has a MiniMax provider and generic Responses-to-chat transformation code with namespace and custom-tool handling

AutoDev already exposes MiniMax through Codex's native model-provider configuration and authenticates it with `MINIMAX_API_KEY`; the remaining custom part is that the provider entry currently targets `codex-minimax-responses-proxy.mjs` rather than the MiniMax API or a shared gateway directly

**Preferred target, conditional on validation:** keep MiniMax API-key usage and remove the bespoke MiniMax proxy only if direct provider support or LiteLLM can preserve the exact Codex Responses/tool contract. MiniMax does not need an OAuth/subscription migration, and the current proxy remains valid if no simpler path reaches parity

### Antigravity

The audit found LiteLLM guidance for tracking Antigravity traffic, but no equivalent native Antigravity OAuth provider that has been proven to replace AutoDev's CLI bridge today

That means the replacement path is unproven, not predetermined

**Preferred target, conditional on validation:** expose Antigravity through a normal Codex `[model_providers.*]` entry using OAuth/subscription credentials through a compatible direct or shared protocol adapter, without launching the Antigravity CLI. Retain the current CLI bridge unless a supported OAuth transport and equivalent Responses/tool/permission/telemetry semantics are demonstrated

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
| Rulesync likely removes Claude role skill views immediately | Unproven | Retain until per-role skill filtering parity is demonstrated |
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

# 5. Preferred provider target architecture — conditional on parity

A **native Codex model provider** here means a normal Codex `[model_providers.*]` entry. Its endpoint may be the provider directly or a shared LiteLLM compatibility endpoint when protocol translation is required. Avoiding a provider CLI in the request path is the preferred simplification, not a precondition or predetermined end state

Codex remains the sole intended agent harness and therefore owns tools, MCP, skills, sandboxing, orchestration, and child-agent behavior

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
| Claude | OAuth/subscription | Codex model provider → direct or LiteLLM Anthropic transport | Claude Code bridge |
| Antigravity | OAuth/subscription | Codex model provider → compatible direct/shared transport | Antigravity CLI bridge |
| GitHub Copilot | OAuth/subscription | Codex model provider → direct or LiteLLM Copilot transport | Copilot CLI/proxy |
| MiniMax | API key | Existing Codex model provider → direct/shared API transport | MiniMax Responses proxy |

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
(`scripts/codex/execution-contract.json`) is frozen against a canonical
fixture at `tests/fixtures/contracts/execution-contract.json`.
`tests/test_local_setup.py::LocalSetupTests::test_execution_contract_matches_frozen_phase0_baseline_fixture`
asserts that both the tracked artifact and a fresh render from the role TOML
sources match that fixture byte-for-byte (as parsed JSON), so any future
refactor of role rendering (including a Rulesync migration) has an executable
baseline to diff against instead of "whatever the renderer currently
produces." Updating the fixture is itself the documented, intentional signal
that the contract's shape was meant to change.

Copilot direct-file and shell-based skill-read paths are frozen (`tests/fixtures/contracts/copilot-responses-contract.json` exercised via `tests/copilot-responses-contract.test.mjs`). Antigravity's Responses boundary is now frozen as well: `tests/fixtures/contracts/antigravity-responses-contract.json` and `tests/antigravity-responses-contract.test.mjs` exercise normal stream/SSE completion, direct and shell-based skill reads, permission denial, and provider-limit incomplete output through a fake local `agy` executable and temporary loopback telemetry server. The contract also asserts sanitized response IDs/timestamps, prompt-content privacy, telemetry observations, and fixture immutability; it does not contact a provider or require credentials. Other provider contracts remain pending. The Claude Responses boundary is now frozen as well: `tests/fixtures/contracts/claude-responses-contract.json` and `tests/claude-responses-contract.test.mjs` exercise the incumbent Python bridge against a fake local Claude CLI and loopback telemetry server for normal and streaming completion, direct and shell-based skill reads, tool continuation/item IDs, permission denial, provider-limit incomplete output, authentication failure, sanitized identifiers/timestamps, prompt privacy, telemetry, and fixture immutability. This contract is offline-only and does not contact Anthropic or require credentials; OAuth-native transport parity and bridge retirement remain pending. Dashboard contract assertions were also hardened to tolerate formatting-only whitespace and to match the current provider-health labels (`Models` and `Errors & cooldowns`); no dashboard runtime behavior changed. Focused Claude/provider-contract and dashboard tests pass. The full `pnpm test` baseline remains red in three unrelated router-limit/status assertions (`scripts/codex-model-router.test.mjs`), and `pnpm run test:python` remains red in one unrelated installer string assertion (`tests/test_local_setup.py`); none were introduced or modified by this slice.

The Phase 0 "provider selection order and randomization" capture is landed
as a deterministic fixture. The fixture at
`tests/fixtures/contracts/provider-selection-order.json` records the eight
non-empty `providerPriority` listings the router produces under seeded
randomness (`mulberry32(0xC0FFEE)`) for the `default`, `smart`, and
`orchestrator` tiers, plus the second eight listings for `default`, and the
live tier membership that each listing must stay within.
`tests/provider-selection-order.test.mjs` drives those listings through the
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
must stay within. `tests/root-subagent-provider-selection.test.mjs` drives
those scenarios through the exported `roleForModel`,
`orchestratorCandidates`, `roleCandidates`, and `payloadForCandidate`
helpers and asserts every shape against the fixture, including the schema
tag, the root alias being declared a leaf (`roleForModel` returns
`null`), every subagent alias resolving to its role, concrete model names
and unknown aliases remaining role-less, the root-only continuation
preference being a preference (never a pin), and the leaf effort remaining
untouched under `payloadForCandidate`. The test is
fully offline and deterministic and is distinct from the existing
`tests/provider-selection-order.test.mjs`, which freezes only the
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
`tests/cooldown-behavior.test.mjs` drives those scenarios through the
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
`scripts/codex/lib/responses-item-ids.mjs`: the frozen
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
and the absence of the `maxThreads` alias). `tests/concurrency-contract.test.mjs` drives every parser scenario and drives
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
slice only after verification.** `node --test tests/concurrency-contract.test.mjs`
reports 25 passing scenarios (parser + admission + constants) and
`node --test scripts/codex-model-router.test.mjs` reports 181 passing
tests with no failures; the parser fix also clears the three unrelated
baseline failures (`scripts/codex-model-router.test.mjs` lines 3313,
3367, and 5255) that were caused by the same root cause and previously
inlined the `maxThreads` field in their expectations. **Commands / results.**
`node --test tests/concurrency-contract.test.mjs` -> 25 pass, 0 fail;
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
(matching `status.providers`). `tests/agent-reconciliation-contract.test.mjs`
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
`node --test tests/agent-reconciliation-contract.test.mjs` reports
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
`tests/native-vs-bridge-child-counts.test.mjs` drive the existing router
helpers and `ingestAgentEvents` with deterministic IDs and timestamps. They
pin mechanism ordering, exact empty/non-empty projection keys, per-child
bridge batch counts, started-to-settled outcomes and row settlement tallies,
newest-first 50-row recency, roleless bridge attribution,
inherited-child-model resolution, ignored unknown mechanisms, late-report
settlement, overflow failure, and the non-additive Codex-native spawn counter
with spawn failures kept outside `status.subagents.total`. The dashboard/status
snapshot fixture at `tests/fixtures/contracts/dashboard-status-snapshot.json`
(schema `autodev-dashboard-status-snapshot-v1`) and
`tests/dashboard-status-snapshot.test.mjs` freeze exact `/status` field
presence, privacy-safe metadata, pending/populated `codexState`, provider rows,
dashboard grouping and empty states, totals-footer visibility, the status CLI
`byMechanism` summary, and extract-and-evaluate HTML rendering without prompt,
response, credential, or absolute-path leakage. The dashboard now distinguishes
its bounded recent-window subtotal from the cumulative all-time total as
`X recent / Y total` when the 50-row window cannot cover history; the totals
footer and status CLI use the same distinction without fallback inflation.
These two contracts mark `Native versus bridge-native child counts` and
`Dashboard/status snapshots` frozen. **Validation.** The focused contracts
pass exactly: `node --test tests/native-vs-bridge-child-counts.test.mjs` ->
24 pass, 0 fail; `node --test tests/dashboard-status-snapshot.test.mjs` ->
5 pass, 0 fail. The requested regression commands also pass: agent
reconciliation 16, workspace attribution 8, concurrency 25, router 182,
metrics 19, workspace telemetry 18, and router state snapshot 3, all with
0 failures. The full `pnpm test` run reports 575 pass, 0 fail; both
`pnpm run validate:actionlint` and `pnpm run validate:shell` exit 0;
`python3 -m unittest tests.test_otel_autodev_attributes tests.test_otel_autodev_attributes_emission`
reports 44 pass, 0 fail; and `git diff --check` is clean. LSP diagnostics
for `scripts/codex-model-router-status.mjs`,
`tests/native-vs-bridge-child-counts.test.mjs`, and
`tests/dashboard-status-snapshot.test.mjs` report 0 errors, warnings, info,
and hints. An independent validator reproduced 29/29 focused passes and
reported no privacy, determinism, labeling, or documentation blockers.

The Phase 0 "workspace attribution and tool/skill/MCP attribution" capture is now frozen as a deterministic contract. **Finding.** Existing behavioral tests covered workspace-local named tool/skill/MCP evidence, fail-closed unavailable-versus-empty rendering, workspace-id joins, privacy normalization, and attribution diagnostics, but no fixture pinned the public `status.usage.byWorkspace` rows or diagnostic reasons. **Slice.** `tests/fixtures/contracts/workspace-attribution-contract.json` (schema `autodev-workspace-attribution-v1`) and `tests/workspace-attribution-contract.test.mjs` now freeze empty dimensions, workspace-local bridge evidence, skill exposure versus use, MCP exposure versus confirmed use, registered/unknown/ambiguous workspace identifiers, privacy hashing, deterministic named rows, and additive privacy-safe OTel attributes. The fixture registers slot/telemetry inputs directly where needed so it is host-independent; admission limits remain covered by the separate concurrency contract. **Completed slice only after verification.** The focused contract reports 8 passing tests; existing workspace telemetry and OTel attribute suites remain green. `Workspace attribution` and `Tool/skill/MCP attribution` are marked frozen below; the final child-count and dashboard/status slices are documented immediately below.

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
`scripts/codex/config.autodev.toml`, the existing composer, and the existing
rulesync-pinned fixtures. No additional Phase 0 contract is required before
starting this work.

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

### Hardening slice

The Phase 1 portable-source boundary is now hardened. The stale caveat in
`scripts/codex/config.autodev.toml` claiming that the source was not yet
composed into the installed config was removed; the source now states that it
is composed into `$CODEX_HOME/config.toml` by
`scripts/codex/compose-user-config.py`. The frozen contract fixture
`tests/fixtures/contracts/portable-autodev-config-contract.json` (schema
`autodev-portable-autodev-config-v1`) and
`tests/portable-autodev-config-contract.test.mjs` pin the portable scalar set,
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

Phase 2 remains shadow-only for MCP, canonical skills, and hooks; the shared
instruction rules surface is the first completed live cutover. Rulesync is
pinned to `16.30.2` and continues to generate tracked shadow fixtures under
`tests/fixtures/rulesync-shadow/` for `codexcli`, `claudecode`, `copilot`, and
`antigravity-cli`.

**Completed first live surface — shared instruction rules.**
`.rulesync/rules/overview.md` is now byte-identical to `AGENTS.md`; the live
`CLAUDE.md` and `.github/copilot-instructions.md` artifacts are also byte-
identical to that canonical body. Rulesync `16.30.2` requires YAML frontmatter
in input rule files, so the live-generation workflow and focused tests build an
ephemeral frontmatter input root around the canonical bytes instead of adding a
second tracked instruction source or changing `AGENTS.md`. The workflow performs
an isolated `rules` generation and compares all three live outputs, while the
existing shadow drift job continues to validate `mcp,rules,skills,hooks` in its
isolated fixture root. `tests/test_rulesync_live_rules.py` freezes byte identity,
ephemeral all-target generation, and the live workflow boundary; the existing
`tests/test_rulesync_mcp_shadow.py` now uses the same ephemeral input technique
for rules generation. This is a Rulesync compatibility seam, not a second
source of instructions.

**Completed second incremental live surface — Copilot canonical skills.** The
Rulesync-generated Copilot skill surface at `.github/skills/` now contains
exactly `ccc`, `lsp-mcp-server`, and `orchestration`, with generated
frontmatter and bodies checked against `.rulesync/skills/`. The focused
`tests/test_rulesync_live_skills.py` contract and the workflow's read-only
Copilot `skills` drift check freeze that surface; `ccc` reference files remain
shadow-only because the first cutover is intentionally limited to the three
canonical `SKILL.md` files. Codex's user-level `scripts/codex/skills/` links,
Claude's role-filtered provider views, and Antigravity's explicit skill
registry remain AutoDev-owned and were not cut over. MCP, hooks, and permissions
remain shadow-only/deferred. Validation is complete: the seven Rulesync suites
(`test_rulesync_live_rules`, `test_rulesync_live_skills`,
`test_rulesync_mcp_shadow`, `test_rulesync_skills_shadow`,
`test_rulesync_hooks_shadow`, `test_rulesync_permissions_inventory`, and
`test_rulesync_mcp_boundary`) report 36 passing tests; `pnpm test` reports
582 passing tests; actionlint and
ShellCheck exit 0; `git diff --check` is clean; and LSP diagnostics for the
new live-skills test and updated Rulesync tests report no issues. Shared MCP remains the next live-equivalence candidate; Codex, Claude, and
Antigravity skill surfaces remain explicitly out of this cutover.

**Completed shared-MCP evaluation and hardening — no live cutover.** The
contract fixture `tests/fixtures/contracts/rulesync-mcp-boundary.json` (schema
`autodev-rulesync-mcp-boundary-v1`) and
`tests/test_rulesync_mcp_boundary.py` now freeze Rulesync `16.30.2` projections
for all four targets, including the `lsp`/`cocoindex-code` launcher arguments,
OpenAI Developer Docs placement, Playwright disabled/absent behavior, and
forbidden server absence. They also freeze the live ownership boundary:
`scripts/codex/config.autodev.toml` remains authoritative for `lsp`,
`cocoindex-code`, and `playwright`, while installer/provider-specific MCP
registries remain outside Rulesync. Temporary generation roots and fixture/live
config immutability are asserted. The focused boundary plus existing MCP shadow
suite reports 8 passing tests. This hardening item is complete, but no MCP live
cutover is claimed because the target projections and existing installer/bridge
owners are not yet one behaviorally equivalent surface.

**Target-by-target MCP behavioral-equivalence decision — no promotion approved.**
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

Keep all four MCP projections shadow-only. The rollback baseline is unchanged:
retain `scripts/codex/config.autodev.toml`/composer, installer-managed Copilot
and Antigravity registries, and Claude/Copilot/Antigravity bridge-owned MCP
construction. Reopen promotion only after target-specific tests prove the full
decision gate rather than only matching names and launcher strings.

The Rulesync source covers shared MCP declarations, the common repository
instructions represented by `AGENTS.md`, the three portable AutoDev-owned
skills (`ccc`, `lsp-mcp-server`, and `orchestration`), and the six existing
command hooks across `SessionStart`, `SubagentStart`, `UserPromptSubmit`, and
`PreToolUse`. It produces target-shaped shadow files without writing live
provider or user configuration. Rulesync currently emits only `PreToolUse` for
Antigravity, and Codex-only fields such as `prevent_idle_sleep` remain outside
the portable source as explicit parity limitations.

The shared instruction rules cutover and the Copilot canonical-skill slice are
the only live Rulesync surfaces so far. Existing live hooks, MCP configuration,
Codex/user-level skills, Claude role-specific skill views, and Antigravity skill
registration remain AutoDev-owned so target-specific guidance and runtime
enforcement are not silently removed during this parity phase. Role-specific skill assignment and
exposure remain AutoDev-owned:
the execution contract, provider skill-view renderer, Claude role views,
Antigravity `include_only` registration, symlink installer, MCP launcher,
provider bridges, hooks, and permissions remain outside Rulesync.

The permission source inventory is complete:
`tests/test_rulesync_permissions_inventory.py` snapshots and contract-tests
the three live permission sources without writing to any of them —
Codex's `approval_policy`/`sandbox_mode`/`sandbox_workspace_write.network_access`
scalars and per-server `default_tools_approval_mode` in
`scripts/codex/config.autodev.toml`, the role-dependent
`--disallowed-tools`/`--allowed-tools` construction (`DISALLOWED_CLAUDE_TOOLS`,
`CROSS_SESSION_CLAUDE_TOOLS`, `PLAYWRIGHT_AGENT_ROLES`,
`PLAYWRIGHT_DISALLOWED_TOOLS`, `RESEARCH_CAPABLE_ROLES`,
`CLAUDE_RESEARCH_ALLOWED_TOOLS`, and the `readOnly` role-contract deny list) in
`scripts/codex-claude-cli-responses-proxy.py`, and the dynamic
`mcp(...)`/`read_file(...)`/`unsandboxed(...)` grant markers that
`grant_agy_code_mcp_permissions`/`check_agy_code_mcp_permissions` compute
against the machine-local `$HOME/.gemini/antigravity-cli/settings.json` in
`scripts/codex/install-codex-integration.sh`. The test also asserts no
`.rulesync/permissions.jsonc` source exists and that `permissions` is absent
from both `rulesync.jsonc`'s `features` array and the CI drift workflow's
`--features` list.

Permissions *generation* through Rulesync remains deferred, not because the
inventory is incomplete but because each source resists a single portable
translation: Codex's scalars are composed at the user level against
whatever machine-local `scripts/codex/config.toml` already exists (global,
not per-project, and merged rather than overwritten — see
`scripts/codex/compose-user-config.py`); Claude's current bridge tool boundary is computed
per request from the agent role (orchestrator-with-shim vs. leaf,
read-only vs. mutating, Playwright-eligible vs. not, research-capable vs.
not), not a static file Rulesync could diff against; and Antigravity's current CLI grants
are appended idempotently to a machine-local settings file
(`$HOME/.gemini/antigravity-cli/settings.json`) keyed off install-time
environment (`AUTODEV_AGY_READ_ROOTS`), not a repository-tracked artifact.
These bridge/CLI-specific permission layers become removable only if a validated replacement moves the corresponding enforcement cleanly into Codex or another accepted boundary. Until then they remain part of the incumbent provider contract

CI drift protection is enforced by `.github/workflows/rulesync-mcp-shadow-drift.yml`, a
read-only workflow triggered on `push` to `main`, `pull_request`, and `workflow_dispatch`
(path-filtered to `.rulesync/**`, `rulesync.jsonc`, `tests/fixtures/rulesync-shadow/**`,
`AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `package.json`,
`pnpm-lock.yaml`, and the workflow file itself). Because pinned Rulesync `16.30.2`
requires frontmatter while the canonical `.rulesync/rules/overview.md` must remain
byte-identical to `AGENTS.md`, the workflow copies the full `.rulesync` tree to a
temporary input root and replaces only the temporary rule file with a generated
frontmatter wrapper around the canonical bytes. It then runs the pinned generation
with `--input-roots` and `--check`; no duplicate tracked instruction source is used.
The workflow performs this ephemeral rules check for the live instruction files and
uses the same temporary-input technique for the isolated `mcp,rules,skills,hooks`
shadow check.

### Remediation

When the CI drift check or local `--check` reports drift due to intentional updates to `.rulesync/` or `rulesync.jsonc`:

1. Refresh the tracked shadow fixtures using the pinned generation command:
   ```bash
   temp_root="$(mktemp -d)"
   trap 'rm -rf "$temp_root"' EXIT
   mkdir -p "$temp_root/input"
   cp -R .rulesync/. "$temp_root/input/"
   {
     printf '%s\n' '---' 'root: true' 'targets: ["*"]' 'description: "AutoDev shared workspace instructions for all AI tooling"' 'globs: ["**/*"]' '---'
     cat .rulesync/rules/overview.md
   } > "$temp_root/input/rules/overview.md"
   pnpm exec rulesync generate \
     --input-roots "$temp_root/input" \
     --targets codexcli,claudecode,copilot,antigravity-cli \
     --features mcp,rules,skills,hooks \
     --output-roots tests/fixtures/rulesync-shadow \
     --delete \
     --silent
   ```
2. Verify that focused tests pass:
   ```bash
   python3 -m unittest tests/test_rulesync_mcp_shadow.py
   python3 -m unittest tests/test_rulesync_skills_shadow.py
   python3 -m unittest tests/test_rulesync_hooks_shadow.py
   ```
3. Commit the refreshed fixtures under `tests/fixtures/rulesync-shadow/`

Pin an exact tested Rulesync version rather than tracking `latest`

### Migrate first

- Root/shared instructions (live cutover complete; byte-identity and ephemeral-generation checks frozen above)
- Canonical skills (Copilot `.github/skills/` live cutover complete; Codex, Claude, and Antigravity remain AutoDev-owned)
- Shared MCP declarations
- Hook declarations (shadow-only translation complete; target limitations documented)
- Permissions declarations (inventory complete, see Status above; generation deferred while provider-CLI-specific permission layers still exist)

### Process

1. Import/translate existing sources into `.rulesync/`
2. Generate into an isolated shadow root
3. Diff against current Codex/Claude/Copilot/Antigravity outputs
4. Test global and project scopes separately
5. Verify unrelated user config survives
6. Add CI drift checks (enforced via `.github/workflows/rulesync-mcp-shadow-drift.yml`)
7. Switch one generated surface at a time (shared instruction rules and the Copilot canonical-skill slice complete; shared-MCP boundary hardening complete, with live cutover still deferred)

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
checksums. `scripts/codex/otel/provision-autodev-otel-collector.sh` downloads
only the host-matching asset, verifies its checksum, and installs the
machine-local binary under `$CODEX_HOME/otelcol`; no Collector binary is
vendored in the repository.

The runtime is supervised by
`scripts/codex/launchagents/com.codex.otel-collector.plist` and the foreground
runner/ensure hooks under `scripts/codex/otel/`. The runner validates the exact
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

The focused runtime, configuration, and composer tests pass. A real
`otelcol v0.160.0` smoke run accepted logs, traces, and metrics, forwarded all
three JSON signals to a loopback receiver, forwarded a repeated cumulative
metrics batch, and emitted no prompt marker in Collector stderr. The pinned
Collector config was also updated from the deprecated `otlphttp` exporter alias
to `otlp_http` after the real binary surfaced that warning.

The full Python suite is otherwise green at 261 passing and 1 skipped live-
binary test; one pre-existing model-router assertion remains red because it
still expects `$(<"$fallback_pid_file")` while the current unrelated router
implementation uses `cat`. The JavaScript suite remains 582/582 green, and
ShellCheck, actionlint, whitespace checks, and LSP diagnostics for the changed
Python files are clean.

**Completed implementation slices:** pinned artifact verification; foreground
runner and ensure lifecycle; launch-agent rendering; opt-in installer mode;
composer endpoint switching; direct-mode rollback; hermetic runtime tests;
and real-binary forwarding smoke coverage.

**Phase 3 exit gate remains pending live launch-agent verification.** This
workspace validation did not load a new user LaunchAgent or alter the active
Codex session. Before marking Phase 3 fully complete, run the enable/check/
disable procedure on the target macOS user account, verify launchd restart and
shutdown behavior, and confirm AutoDev semantic counters remain unchanged and
do not double-count after a real Collector insertion. Until that evidence is
recorded, Phase 3 is implemented but not marked fully complete.

Enable/rollback procedure:

```bash
# Optional: provision the pinned host-local binary explicitly.
bash scripts/codex/otel/provision-autodev-otel-collector.sh

bash scripts/codex/install-codex-integration.sh --enable-otel-collector
bash scripts/codex/install-codex-integration.sh --check
bash scripts/codex/install-codex-integration.sh --disable-otel-collector
bash scripts/codex/install-codex-integration.sh --check
```

The next migration step is Phase 4: begin the independently gated Claude
OAuth-native Codex provider pilot, using the frozen incumbent Claude Responses
contract as the rollback baseline.

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

---

## Phase 4 — Evaluate OAuth-native Codex model providers against incumbent subscription CLI paths

The preferred simplification is one Codex harness with normal `[model_providers.*]` entries, but this phase is explicitly an evaluation. Migrate each OAuth-backed provider independently only after the provider migration gate passes. Until then, its current CLI/bridge remains the supported path and rollback baseline

### Claude OAuth pilot

This is a high-value pilot because the current Claude bridge is large and Claude Code's own `Agent`/`Task` orchestration is already disabled by that bridge

#### Status

The incumbent Claude Responses boundary is frozen by `tests/fixtures/contracts/claude-responses-contract.json` and `tests/claude-responses-contract.test.mjs`. The suite runs the actual Python bridge with a fake local Claude CLI and loopback telemetry server, covering normal and streaming responses, direct and shell skill reads, tool continuation and item IDs, permission denial, provider-limit incomplete output, authentication failure, privacy sanitization, and telemetry without contacting Anthropic or requiring credentials. This establishes the offline parity baseline only; OAuth bootstrap/refresh/expiry, LiteLLM/direct transport compatibility, operational/policy review, and bridge deletion remain unproven and are still required by the provider migration gate.

Compare direct/shared Claude OAuth transport against the incumbent bridge for:

- OAuth token bootstrap, refresh, expiry, and secure storage
- OpenAI Responses request/stream fidelity
- Function, namespace, custom, and freeform tool behavior
- Tool-call → tool-result → next-turn continuation
- Reasoning effort/model selection
- Provider rate-limit/reset semantics
- Cancellation and long-running turns
- Role, permission, workspace, usage, and telemetry attribution

### Claude exit gate

Delete `codex-claude-cli-responses-proxy.py` and its launch/ensure lifecycle only when a Codex model-provider route using subscription OAuth is behaviorally equivalent across the full provider migration gate. Otherwise retain the existing bridge

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
privacy. Live LiteLLM compatibility, operational/policy review, and proxy deletion remain pending.

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

LiteLLM currently uses GitHub's internal Copilot token endpoint, so validate operational and policy acceptability before removing the CLI path

### Copilot exit gate

Delete the AutoDev Copilot CLI/proxy path only if the OAuth-backed Codex model provider passes the full provider migration gate and removes more complexity than it introduces. Otherwise retain the incumbent path

### Antigravity OAuth pilot

The preferred target is the same, but the replacement transport is not yet proven. Test whether Codex can address Antigravity through a normal model-provider entry using OAuth/subscription credentials without launching `agy`

Use the existing Antigravity boundary fixture from Phase 0 as the incumbent contract. Before deleting the bridge, prove:

- Supported OAuth token acquisition/refresh without the Antigravity CLI in the request path
- Compatible Responses streaming and continuation
- Codex tool/namespace/custom/freeform behavior
- Role/tool/MCP enforcement remains correct
- Provider-limit/error mapping and telemetry parity
- Operational supportability and upgrade stability

### Antigravity exit gate

Delete the Antigravity CLI bridge only after a supported direct/shared OAuth transport passes the full provider migration gate. If no candidate does, retain the bridge as the supported implementation

---

## Phase 5 — Evaluate simplification of the MiniMax API-backed Codex model provider

MiniMax remains API-key-backed. The goal is to test whether bespoke protocol translation can be removed, not to change its authentication model

### Status

The Phase 5 slice is now landed as an offline boundary contract for the
incumbent MiniMax Responses pass-through proxy. The fixture at
`tests/fixtures/contracts/minimax-responses-contract.json` and the boundary
suite `tests/minimax-responses-contract.test.mjs` exercise the proxy's pure
helpers (`rewrite`, `flattenOutboundTools`, `isWebResearchTool`,
`freeformInputFromArguments`, `coerceResponseBody`) against normal-stream
namespace flattening, freeform tool coercion, and preserved web-research
tools, without contacting the remote API, deploying LiteLLM, or changing the
live proxy. `coerceResponseBody`/`freeformInputFromArguments`/`isWebResearchTool`
were promoted from `export function` to the consolidated export block so the
test can drive the same logic the live proxy runs. The test asserts the
request tool shape the proxy sends upstream, the response namespace the
proxy hands back to the caller, and the `function_call -> custom_tool_call`
rewriting Codex needs to run freeform `exec`. Live LiteLLM compatibility,
operational/policy review, and proxy deletion remain pending.

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

Point the existing MiniMax Codex model-provider entry at a direct/shared API transport and retire `codex-minimax-responses-proxy.mjs` only after all required Codex tool patterns and the applicable provider migration gates pass. Otherwise retain the current proxy

---

## Phase 6 — Shrink the AutoDev router around retained semantics

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

- Whether Claude OAuth through LiteLLM or a direct transport matches the current bridge's full Responses/tool/limit/telemetry contract
- Claude OAuth token acquisition/refresh/expiry behavior when used without the Claude Code CLI
- Whether GitHub Copilot's LiteLLM path is stable and policy-acceptable enough to replace the incumbent CLI/proxy
- Whether a supported direct OAuth transport for Antigravity exists and whether LiteLLM or another shared adapter can provide it without invoking `agy`
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
- Claude Code CLI Responses bridge only after OAuth-native provider parity
- Antigravity CLI Responses bridge only after OAuth-native provider parity
- Copilot CLI/Responses proxy only after OAuth-native provider parity
- MiniMax Responses proxy only after direct/shared API parity
- Provider-specific launch/ensure lifecycle only for retired CLI bridges
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
