# AutoDev Console — OpenLIT Fork Target State and Reference Projects

## Goal

Build an **AutoDev-centric control and observability console** by forking OpenLIT and retaining its strong OpenTelemetry-native observability foundation while replacing its generic multi-tenant product shell with AutoDev's actual domain model.

The fork should make **Agents, Providers, Models, MCP Servers, Skills, Workspaces, Routing, Runtime Configuration, and Telemetry** first-class concepts. Configuration, current runtime state, and historical observability should appear together in one product, while remaining separate architectural data/control paths underneath.

## OpenLIT fork target state

Treat this as a **product/UX fork, not a destructive observability/storage fork**.

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

### Keep from OpenLIT

Preserve OpenLIT's difficult, standards-based infrastructure wherever practical:

- OpenTelemetry/OTLP ingestion
- ClickHouse telemetry storage
- trace, metric, and log querying
- GenAI observability and cost/usage foundations
- dashboard/widget infrastructure
- telemetry source/query abstractions
- trace exploration
- evaluation infrastructure where useful
- OpenLIT Controller concepts for desired state, actions, polling, convergence, and actual-state reporting
- generic UI/component primitives that fit AutoDev
- standard OTel GenAI/MCP semantic conventions

Keep these areas close to upstream so future OpenLIT improvements and security fixes remain reasonably mergeable.

### Remove or collapse from the AutoDev product surface

Remove concepts that add no useful distinction for AutoDev users:

- Organisation management
- Project management
- Environment management
- generic OpenLIT onboarding around those concepts
- organisation/project/environment selectors
- generic product navigation that does not fit AutoDev
- redundant OpenLIT configuration pages superseded by AutoDev-specific resources
- the existing AutoDev standalone dashboard once the new console fully replaces it

Do **not** necessarily remove these concepts from OpenLIT's underlying schemas/query machinery. Where OpenLIT requires them internally, collapse them to implicit singleton/default values:

```text
Organisation  → implicit AutoDev organisation
Project       → implicit AutoDev project
Environment   → implicit/default environment
```

This avoids rewriting foundational OpenLIT assumptions merely to hide irrelevant UX.

Likewise, retain standard telemetry concepts such as `deployment.environment.name` where useful; remove the unnecessary **OpenLIT product abstraction**, not legitimate OTel metadata.

### Add as first-class AutoDev resources

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

Each should support, where applicable:

- configured/desired state
- observed/actual state
- enabled/disabled state
- health
- role/workspace scope
- availability
- validation/errors
- pending changes
- activity/history
- corresponding telemetry and usage

The UI should compose control and observability together:

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

Control data comes from the **AutoDev Control API**. Historical/runtime observability comes from **OpenTelemetry/OpenLIT**.

## Architecture boundary

Keep the two planes explicitly separate:

```text
Observability
AutoDev → standard OTel → Collector → OpenLIT storage/querying → UI

Control
AutoDev Console → authenticated AutoDev Control API → AutoDev runtime
```

Never use OTLP as a command/configuration channel.

For runtime changes that need reconciliation, use a desired-state model:

```text
Desired state
      ↓
queued/applicable change
      ↓
runtime/controller
      ↓
actual state
      ↓
reported convergence/error
```

This should apply to provider/model availability, MCP servers, skills, runtime configuration, and other mutable agent capabilities.

## Recommended external reference projects

| Project | Use it for | What AutoDev should take |
|---|---|---|
| **OpenLIT** | Observability foundation | OTel ingestion, ClickHouse/querying, traces, metrics, logs, dashboards, cost/usage, and Controller desired-state/action patterns |
| **LiteLLM** | **Providers, Models, MCP Servers** | Provider/model catalogs, deployments, enablement, routing/fallbacks, MCP management, limits and centralized control-plane resource UX |
| **LangWatch** | **Overall product UX** | Combining observability, coding-agent monitoring, provider/gateway configuration, routing and operational controls in one AI-focused product |
| **MCPJam Inspector** | **MCP detail/debugging UX** | Tools, resources, prompts, connection state, requests, logs, authorization and MCP activity inspection |
| **Unleash** | **Skills and scoped enablement** | Enabled/disabled state plus targeting, role/workspace constraints, strategies and effective configuration |
| **Argo CD** | **Desired vs. actual state** | Desired/live state, health, pending changes, convergence, drift, errors and operation history |
| **Backstage** | **Modular product architecture** | Separate cohesive modules/routes for Agents, Providers, Models, MCP, Skills, Workspaces and Telemetry instead of a monolithic settings area |

## Resource-specific guidance

**Providers + Models — LiteLLM first, LangWatch second.** Treat provider and individual model availability, routing priority, fallbacks, limits, concurrency and role eligibility as first-class configuration rather than environment-variable settings.

**MCP Servers — MCPJam + LiteLLM.** Each MCP server should have Overview, Configuration, Tools, Resources, Prompts, Role Access, Activity and Errors/Logs. Separate desired enablement from actual connection/health.

**Skills — Unleash + OpenLIT.** Model the lifecycle explicitly:

```text
Enabled → Eligible → Selected → Injected → Used
```

Configuration controls role/workspace eligibility; telemetry measures actual selection, injection, use and errors.

**Agents — OpenLIT Controller + Argo CD.** Show configured intent, current runtime state, pending changes and convergence rather than representing every mutation as an instantaneous toggle.

**Overall UI — LangWatch + OpenLIT.** Avoid separate "admin" and "analytics" applications. Configuration, live status and historical telemetry should be different views of the same AutoDev resources.

## Fork implementation strategy

Maintain a dedicated AutoDev fork/distribution of OpenLIT rather than scattering copied OpenLIT code inside AutoDev.

- Pin the upstream OpenLIT version/commit used by each AutoDev release.
- Keep an upstream remote and periodically integrate useful security/foundation changes.
- Concentrate divergence in navigation, AutoDev domain modules, control-plane APIs, and collapsed tenancy UX.
- Avoid unnecessary modifications to ingestion, storage, schemas and generic query execution.
- Keep AutoDev-specific code modular, preferably under clearly owned modules/routes rather than editing unrelated OpenLIT functionality throughout the tree.
- Maintain regression tests around both OpenLIT foundation behavior and AutoDev-specific resource/control behavior.
- Treat upstream contributions as optional; AutoDev must never depend on them being accepted.

## Final target

The target is **not**:

> OpenLIT with an AutoDev settings page.

It is:

> **An AutoDev control and observability console built as an AutoDev-centric OpenLIT distribution: retain OpenLIT's OpenTelemetry-native ingestion, storage, querying and observability foundations; collapse its generic organisation/project/environment product model; and make agents, workspaces, providers, models, MCP servers, skills, routing and runtime configuration first-class resources, using proven interaction patterns from LiteLLM, LangWatch, MCPJam, Unleash, Argo CD and Backstage.**