# AutoDev Console Target State

> **Authority:** This is the single living source of truth for AutoDev's OpenLIT fork, observability architecture, control-plane/UI ownership, RuleSync configuration ownership, migration state, acceptance evidence, and future console work.
>
> **Last reviewed:** 2026-09-30.
>
> **Runtime status:** The original observability migration is complete: the local router dashboard, in-process history aggregation, and pass-through AutoDev Collector are decommissioned. OpenLIT and the AutoDev Control API are the active observability/control foundation. The next target is to evolve the maintained OpenLIT distribution into the AutoDev Console described here.

## 1. Canonical-document contract

Every change touching telemetry, OpenLIT, RuleSync projections, agent/provider/MCP/skill configuration, dashboard/UI behavior, or the AutoDev Control API must:

1. Read this document before work and update it in the same PR when target decisions, verified facts, gaps, implementation status, or acceptance evidence change.
2. Update decisions in place. Do not preserve competing active plans in other docs.
3. Distinguish **target**, **verified current state**, and **open migration work**.
4. Keep implementation references repo-relative and keep secrets/machine-local values out of the repository.
5. Keep secondary docs and reusable skills concise and link here rather than copying this target state.

If another AutoDev document conflicts with this one on console, observability, OpenLIT, RuleSync ownership, or control-plane architecture, this document is authoritative.

## 2. Product goal

Build an **AutoDev-centric control and observability console** as a maintained OpenLIT distribution.

OpenLIT remains the standards-based telemetry foundation; AutoDev replaces OpenLIT's generic multi-tenant product shell with AutoDev's actual operating model. The product should make these resources first-class:

```text
AutoDev Console
├── Overview
├── Usage
├── Agents
├── Providers
├── Models
├── MCP Servers
├── Skills
├── Workspaces
├── Routing
├── Telemetry
│   ├── Traces
│   ├── Metrics
│   └── Logs
└── Settings
```

Configuration, desired state, observed runtime state, health, activity, and historical telemetry should appear together on the same resource surfaces while remaining separate architectural data/control paths underneath.

This is a **product/UX fork, not a destructive observability/storage fork**.

## 3. Core architecture

### Observability plane

```text
AutoDev producers
    │ standard OTLP
    ▼
OpenLIT first-party OTLP receiver
    │
    ▼
OpenLIT storage/query layer
    │
    ├── traces
    ├── metrics
    ├── logs
    ├── Usage dashboards
    └── resource-level historical analysis
```

Use standard OpenTelemetry traces, metrics, and logs as the telemetry contract. Prefer official GenAI and MCP semantic conventions and add a minimal `autodev.*` namespace only for concepts with no suitable standard.

Do not restore an AutoDev-owned historical aggregation database, general-purpose query service, compatibility dashboard, or pass-through Collector. Add a separate Collector only for a concrete documented policy need such as pre-export redaction, routing, or fan-out.

### Control plane

```text
AutoDev Console
    │ authenticated same-origin server path
    ▼
AutoDev Control API
    │
    ├── canonical configuration mutation
    ├── validation/generation/apply
    ├── desired-state reconciliation
    └── runtime/status reads
```

OTLP, telemetry queries, and dashboards are observation-only. **Never use telemetry as a command/configuration channel.**

For mutable resources, expose desired and actual state explicitly:

```text
canonical desired configuration
          ↓
validated apply / queued action
          ↓
runtime/controller
          ↓
observed actual state
          ↓
converged | pending | error
```

Borrow OpenLIT Controller/Argo CD semantics for desired state, actions, convergence, and actual-state reporting. Do not force AutoDev configuration through OpenLIT's eBPF/workload-management mechanisms when a direct AutoDev runtime/configuration owner exists.

## 4. RuleSync is the canonical agent-configuration source

Use the pinned RuleSync tool **as the single source of truth for every agent-facing configuration surface it natively represents**. Do not create an AutoDev-specific replacement schema or a second authoritative copy in OpenLIT/ClickHouse.

Canonical RuleSync-owned concerns include:

- rules/instructions;
- commands and prompt assets;
- subagent/agent-role definitions;
- Agent Skills and their supporting files;
- MCP server declarations and target-specific overrides;
- hooks;
- permissions and tool/capability policy where RuleSync can represent them.

The target canonical tree is RuleSync-native, including `.rulesync/commands/`, `.rulesync/subagents/`, `.rulesync/skills/`, `.rulesync/mcp.jsonc`, `.rulesync/hooks.jsonc`, and `.rulesync/permissions.jsonc` as applicable, with `rulesync.jsonc` selecting the supported features/targets.

### Ownership rules

- **RuleSync source files are authoritative.** Provider-specific Codex/Claude/Copilot/Antigravity files are generated projections, not editable truth.
- Existing native AutoDev agent-role files and prompt-composition paths are migration inputs only where RuleSync has not yet become authoritative; remove the duplicate authority once their semantics are represented losslessly in RuleSync.
- OpenLIT Prompt/Agent/MCP/Skill views are **read models/projections** of canonical RuleSync state. They must never become an independent configuration database.
- A UI mutation for a RuleSync-owned resource must update the canonical RuleSync source through a typed Control API operation, validate it, run the pinned RuleSync generation/reconciliation path, apply the resulting runtime configuration, and report desired/actual state. Do not mutate only an OpenLIT row.
- Preserve RuleSync's target-specific overrides rather than forking its concepts into new AutoDev formats.
- AutoDev-specific state that RuleSync does not model—provider credentials, live provider health, model pricing/catalog facts, routing/cooldown/concurrency state, and other runtime-only data—remains owned by typed AutoDev configuration/runtime APIs.

The console should therefore read:

```text
Desired agent configuration  ← RuleSync canonical sources
Generated provider configs   ← RuleSync projections
Actual runtime state         ← AutoDev runtime / Control API
Historical behavior          ← OpenTelemetry / OpenLIT
```

## 5. OpenLIT fork boundary

### Keep from OpenLIT

Preserve and stay close to upstream for:

- OpenTelemetry/OTLP ingestion;
- ClickHouse telemetry storage and generic query plumbing;
- trace, metric, and log exploration;
- GenAI observability and cost/usage foundations;
- dashboard/widget primitives;
- telemetry source/query abstractions;
- evaluations where useful;
- first-party receiver and standard semantic handling;
- generic UI components that fit AutoDev;
- Controller patterns for desired state/action/convergence.

### Collapse or remove from the AutoDev product surface

Remove user-facing concepts that do not add useful distinctions for AutoDev:

- Organisation management;
- Project management;
- Environment management;
- organisation/project/environment selectors;
- generic onboarding built around those concepts;
- generic navigation superseded by AutoDev resources;
- redundant configuration surfaces superseded by AutoDev pages.

Do **not** delete these assumptions from OpenLIT's storage/query/security internals merely to hide them. Where required internally, collapse them to singleton/default values:

```text
Organisation  → implicit AutoDev organisation
Project       → implicit AutoDev project
Environment   → implicit/default environment
```

Retain legitimate OTel metadata such as `deployment.environment.name`; remove the unnecessary OpenLIT product abstraction, not useful telemetry semantics.

### Workspaces are analytical dimensions, not OpenLIT projects

AutoDev repositories/workspaces such as `SimulatorLife/AutoDev` and `SimulatorLife/RacingGame` remain privacy-safe OTel attributes (for example `autodev.workspace`) so the same OpenLIT project can aggregate across them and filter/group by workspace.

Do not create one OpenLIT project per AutoDev workspace unless true storage/access isolation is required.

## 6. First-class AutoDev resources

The AutoDev fork should model these as first-class TypeScript modules/resources:

```text
AgentRole
Workspace
Provider
Model
McpServer
Skill
RoutingPolicy
RuntimeConfig
```

Each resource supports, where applicable:

- canonical/configured desired state;
- actual/observed runtime state;
- enabled/disabled state;
- health and availability;
- agent-role/workspace scope;
- validation/errors;
- pending changes and convergence;
- activity/history;
- relevant traces, metrics, cost, and usage.

Keep modules cohesive rather than building a monolithic settings screen.

## 7. UI contract

### One product, not separate admin and analytics apps

Keep control and observability separate in architecture, but compose them on the same resource pages.

Example:

```text
Provider: Anthropic

Configuration                  Runtime / Observability
────────────────────           ─────────────────────────
Enabled                        Actual state / health
Allowed roles                  Requests
Models                         Tokens
Routing priority               Cost
Fallbacks                      Failure rate
Concurrency                    Recent traces
```

### Resource pages

**Agents**
- desired configuration from RuleSync;
- generated/provider projection status;
- actual runtime/health;
- assigned skills/MCPs/models;
- pending config convergence;
- recent activity/traces.

**Providers + Models**
- enablement and role eligibility;
- model catalog/availability;
- routing priority/fallbacks;
- concurrency/limits;
- health;
- requests, tokens, cost, failures, latency, traces.

**MCP Servers**
- Overview, Configuration, Tools, Resources, Prompts, Role Access, Activity, Errors/Logs;
- desired enablement versus actual connection/health;
- server/tool usage from OTel.

**Skills**
- canonical RuleSync definition and role/workspace eligibility;
- desired enablement/configuration;
- observed exposure/use/error evidence;
- usage trends and related traces.

Do not infer runtime skill use from configuration. Keep the distinction:

```text
Configured/Enabled → Eligible → Exposed/Selected → Used
```

`Configured/Enabled` and `Eligible` are control-plane facts. `Exposed`, `used`, `unavailable`, and `error` are telemetry facts only when an owning producer reports them. Unknown remains unknown.

**Workspaces**
- analytical scope and health/usage rollups;
- no OpenLIT project silo per workspace.

**Routing**
- provider/model priority and fallback policy;
- limits/cooldowns/concurrency;
- logical request versus physical attempt diagnostics.

### Usage

Keep a single **Usage** dashboard; do not add a redundant Analytics page.

Use OpenLIT's stock time-range control. Generic dashboard variables should support typed single/multi-select + All with URL/dashboard persistence. Target variables include:

- workspace;
- provider;
- requested model;
- agent/role;
- skill where the queried telemetry actually carries skill identity safely.

Widgets opt in only to variables whose semantics apply. Bind user selections through typed parameterized query inputs; never concatenate user-controlled SQL.

## 8. Telemetry contract

### Logical requests versus physical attempts

A logical routed request and physical provider/model attempts are different observations:

```text
AutoDev logical routed request
├── GenAI provider/model attempt 1
└── GenAI provider/model attempt 2 (fallback/retry)
```

For a failed OpenAI attempt followed by successful Anthropic fallback, count **one logical request and two physical attempts**.

- Provider reliability, attempt latency, tokens, cache use, and provider cost belong to attempt spans/metrics.
- End-to-end duration and final outcome belong to the logical routed request.
- Do not copy attempt token/cost totals to the parent and count them again.
- Keep `autodev.requested_model` for the caller's routed model when needed across parent/attempt levels; keep `gen_ai.request.model` for the physical upstream target.

### Semantic conventions

- Prefer current official `gen_ai.*` and MCP conventions.
- The current MCP convention pin is `open-telemetry/semantic-conventions-genai@bcc7f9c2856fa7f4feb753f54d4ebba9455cc3dc` (2026-09-29); it is a Development contract and must be revalidated when producer semantics change.
- Use standard input/output/cache token attributes where reported.
- Cache-read rate is cached input tokens divided by input tokens for attempts where both are available; missing evidence renders **unavailable**, not zero.
- Keep IDs, raw paths, URLs, prompts/responses, credentials, raw tool arguments/results, and free-form errors out of metric dimensions.
- Keep metric dimensions bounded and stable.
- Attach provider/model/role/workspace context at the producer that actually knows it. Do not infer missing attribution downstream merely to satisfy a dashboard.

### MCP

The AutoDev Codex-tools MCP shim owns the server-side `tools/call` round trip. Its span duration is the MCP shim's round-trip duration, not Codex's downstream tool execution duration. Preserve W3C trace context where available and export only bounded categorical/error metadata.

### Skills

Use a minimal `autodev.skill.*` semantic contract because no suitable standard skill convention exists. Current trustworthy runtime observations include exposure/use and producer-reported unavailable/error; configuration itself is not runtime proof.

Do not put skill name into broadly aggregated metric dimensions if it creates unbounded cardinality; use traces/events and bounded dashboard queries where appropriate.

## 9. AutoDev Usage dashboard

The current verified Usage board contains seven router widgets plus four MCP widgets:

| View | Semantics |
| --- | --- |
| Logical routed requests | one per `autodev.routed_request`, including final failures |
| Logical requests by agent/role | routed-request activity grouped by bounded role |
| Input/output tokens | sum on physical GenAI attempts |
| Cache-read rate | cached input / input where both are reported |
| P95 attempt latency | physical attempt duration |
| Physical attempts by provider | attempts grouped by `gen_ai.provider.name` |
| MCP tool calls | shim-owned `tools/call` round trips |
| P95 MCP tool-call duration | shim-side MCP span duration |
| MCP tool-call errors | errored MCP `tools/call` spans |
| MCP calls by tool | top bounded tool-name groups |

Provider does not filter the logical-request count because a single logical route may touch multiple providers. Provider filters apply to attempt-level widgets.

The pinned ClickHouse adapter maps standard `service.name` queries to ClickHouse's dedicated `ServiceName` projection. Structured trace queries bind time, keys, and values using query parameters; unsupported signal/variable combinations fail closed.

## 10. Control API and authorization

The Control API is the only AutoDev state/action boundary. Target resource families include:

```text
/control/agents
/control/providers
/control/models
/control/mcps
/control/skills
/control/workspaces
/control/routing
/control/runtime
```

Use named typed operations only; no arbitrary command endpoint.

For RuleSync-owned resources, mutations change the canonical RuleSync source and run validation/generation/apply. For runtime-only resources, mutate the authoritative typed AutoDev owner.

The OpenLIT browser should use a same-origin server-side path/proxy. The private AutoDev control listener remains separate from the model/OTLP router listener.

Security requirements:

- authenticated user/session at the console boundary;
- CSRF protection for browser mutations;
- scoped service credential from console server to Control API;
- independently verified actor identity;
- viewer/operator authorization;
- least privilege per resource/action;
- redacted audit record for each mutation;
- no bearer token, raw actor identifier, secret, or mutation body in telemetry.

