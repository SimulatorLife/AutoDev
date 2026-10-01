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

Build a **single-user, AutoDev-centric control and observability console** as a deliberately simplified OpenLIT fork.

OpenLIT remains the standards-based telemetry/storage foundation, but the product shell is reduced to AutoDev's actual operating model. Do not preserve generic OpenLIT features merely because they already exist.

The canonical left navigation is:

```text
AutoDev Console
├── Agents
├── MCPs
├── Skills
├── Hooks
├── Memory
├── Evaluations
├── Permissions
├── Tools
├── Usage
├── Prompts
└── Workspaces
```

Use **Workspaces**, not OpenLIT Projects, for AutoDev repositories/workspaces. "Project" may appear only as domain wording where an external tool requires it; it must not restore OpenLIT's project isolation/tenancy model.

Provider, model, routing, and runtime configuration remain required but should be secondary configuration under **Agents** and relevant resource-detail views rather than additional top-level destinations. Provider/model telemetry remains available in **Usage**.

Configuration, desired state, observed runtime state, health, activity, and historical telemetry should appear together on the same resource surfaces while remaining separate architectural data/control paths underneath.

This is a **product and UX fork with aggressive feature subtraction**, while preserving the OpenTelemetry/ClickHouse/querying substrate that is still useful.

### Unified UI requirement

The console is one product, not a collection of embedded dashboards.

- Use one shared React/Next.js UI shell and one shared design system/component library.
- All AutoDev-owned Console application code—including UI, pages/components, state/query clients, server routes, Control API integration, configuration/reconciliation code, and new adapters—must be **TypeScript/TSX**. Do not add Python, Go, Rust, or another runtime for AutoDev-owned application/control functionality.
- Reuse/adapt TypeScript pieces from OpenLIT or other projects only when they fit the shared component system; otherwise reproduce the interaction pattern in AutoDev's TypeScript UI rather than embedding a foreign application.
- Do not iframe or visually stitch together LiteLLM, MCPJam, LangWatch, Unleash, or other dashboards.
- Shared primitives must cover navigation, page headers, filters, data tables, detail tabs, stat cards, charts, status/health badges, forms, dialogs/drawers, empty/loading/error states, permission matrices, activity/history, and code/config editors where needed.
- One resource should look and behave consistently regardless of whether its data originates in RuleSync, the Control API, OpenTelemetry/OpenLIT, a memory connector, or evaluation storage.
- Non-TypeScript third-party infrastructure may remain an implementation dependency underneath the product (for example ClickHouse or the OTel receiver), but no new AutoDev-facing UI/control application should require a second language/runtime.

### Flat monorepo organization

AutoDev should be a **small, flat pnpm TypeScript monorepo**. Do not introduce `apps/`, `packages/`, or `modules/` wrapper directories merely to classify code, and do not create a package per left-navigation resource. Package boundaries represent durable architectural/runtime boundaries; the Console's tabs remain feature folders inside one frontend.

Target repository shape:

```text
AutoDev/
├── console/                 # Unified React/Next.js AutoDev UI
├── runtime/                 # Router, providers, agents, MCP runtime, hooks, Control API
├── core/                    # Shared domain types, contracts, and pure business logic
├── data/                    # RuleSync/OpenLIT/ClickHouse/config/persistence/query adapters
│
├── .rulesync/               # Canonical agent-facing configuration
├── config/                  # Portable provider/runtime/deployment configuration
├── .github/                 # CI and GitHub automation
├── docs/
├── scripts/
├── tests/
├── package.json
├── pnpm-workspace.yaml
└── rulesync.jsonc
```

The initial code-module target is deliberately only **four workspaces**:

| Module | Owns |
| --- | --- |
| `console/` | The single AutoDev React/Next.js application, shared design system/components, navigation, and feature folders for Agents, MCPs, Skills, Hooks, Memory, Evaluations, Permissions, Tools, Usage, Prompts, and Workspaces |
| `runtime/` | Long-running AutoDev execution: model router, provider bridges, agent execution, MCP processes, hook execution, runtime health, desired-state reconciliation, and the Control API transport |
| `core/` | Infrastructure-independent AutoDev domain types/contracts and pure rules shared by Console, Runtime, and Data |
| `data/` | Typed adapters/repositories for RuleSync canonical sources, OpenLIT/ClickHouse queries, memory/evaluation persistence, workspace/config reads, and other external/persistent data boundaries |

Do **not** create packages such as `agents/`, `skills/`, `mcps/`, or `prompts/` merely because those are top-level UI resources. Inside `console/`, keep them as cohesive feature folders:

```text
console/src/features/
├── agents/
├── mcps/
├── skills/
├── hooks/
├── memory/
├── evaluations/
├── permissions/
├── tools/
├── usage/
├── prompts/
└── workspaces/
```

Likewise, keep cohesive runtime responsibilities as folders inside `runtime/` rather than separate deployables:

```text
runtime/src/
├── control-api/
├── router/
├── providers/
├── agents/
├── mcp/
├── hooks/
├── telemetry/
└── platform/
```

### Module boundaries

Use this dependency direction:

```text
console ───────┐
               ├──> core
runtime ───────┤
               │
console ───────┐
               ├──> data ───> core
runtime ───────┘

core ──> no AutoDev module
```

Additional rules:

- `core/` must stay infrastructure-independent: no React/Next.js, filesystem, HTTP-server, OpenLIT, ClickHouse, RuleSync CLI, or provider-process dependencies.
- `data/` adapts external/canonical data sources to `core/` contracts; it does not become a second source of truth.
- `runtime/` is the mutation/reconciliation authority. The Console must not bypass the Control API to mutate RuleSync or runtime state directly.
- `console/` owns the shared AutoDev UI library initially. Do not create a separate `ui/` workspace until there is a real second UI consumer.
- Keep shared OpenTelemetry producer code under `runtime/src/telemetry/` initially. Extract a root `telemetry/` workspace only if multiple independent producers genuinely require it.
- Keep `.rulesync/`, `config/`, `.github/`, and `docs/` at repository root; they are canonical configuration/automation/documentation roots, not software packages.
- All four code workspaces are TypeScript/TSX and use the same root linting, formatting, test, and TypeScript policies.

The target `pnpm-workspace.yaml` should eventually enumerate the four root workspaces directly:

```yaml
packages:
  - "console"
  - "runtime"
  - "core"
  - "data"
```

**Current state:** AutoDev still has one root package with implementation under `src/`, and `pnpm-workspace.yaml` does not yet enumerate code workspaces. The structure above is the migration target, not a claim about the current checkout.

Do not reorganize code merely to satisfy this shape in one large move. Migrate by coherent slices, preserve behavior, and remove each old `src/` path after its replacement is validated.

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

### Keep and adapt from OpenLIT

Preserve or adapt the parts that directly serve AutoDev:

- OpenTelemetry/OTLP ingestion;
- ClickHouse telemetry storage and generic query plumbing;
- trace, metric, and log querying/exploration used by AutoDev surfaces;
- GenAI observability and cost/usage foundations;
- dashboard/widget/chart primitives needed by **Usage**;
- telemetry source/query abstractions;
- **Agents** UI patterns, but not OpenLIT's discovered/instrumented application model;
- **Memory** and its connector abstraction;
- **Evaluations** and useful evaluation result/history UI;
- **Prompt Hub** interaction patterns such as prompt browsing, editing, versions, preview/diff where useful, while RuleSync remains canonical;
- generic TypeScript/TSX UI primitives that fit the shared AutoDev design system;
- desired-state/action/convergence interaction patterns from the OpenLIT Controller where useful, reimplemented through AutoDev's TypeScript control/runtime architecture rather than by shipping the Controller.

### Remove from the AutoDev product and distribution

These are **out of scope**, not hidden optional navigation:

- **Accounts/users**: remove sign-up/login/account-management product flows, OAuth account UI, user profiles, invitations, membership management, and account-scoped preferences. AutoDev is a single-user/local control plane; deployment-level authentication may protect a remotely exposed instance without reintroducing an application account model.
- **Organizations/organisations**: remove organization entities, membership, organization switching, permissions tied to organizations, and organization-scoped navigation.
- **Environments**: remove OpenLIT environment management/selectors/configuration as a product concept. Standard telemetry such as `deployment.environment.name` may still exist when technically useful.
- **Projects**: remove OpenLIT project management/isolation/selectors. AutoDev **Workspaces** are analytical/configuration resources, not OpenLIT tenancy silos.
- **Rule Engine**: remove its UI, API/runtime evaluation flow, SDK-facing product integration, rule conditions/linked-entity workflow, and fork-owned persistence/migrations once no retained feature depends on them. Rule/role/capability behavior belongs to canonical RuleSync/AutoDev configuration instead.
- **OpenGround**: remove the playground/evaluation-comparison product, routes, stores, APIs, and fork-owned persistence/migrations. AutoDev does not need a general LLM playground.
- **GPU monitoring/dashboard**: remove the GPU dashboard and GPU-specific AutoDev UI/query surfaces; do not package the separate GPU monitoring experience as part of the AutoDev Console.
- **OpenLIT agent discovery/instrumentation and Controller daemon**: remove the `discovered`/`instrumented` agent statuses, controller-discovered service/application lists, instrumentation toggles, eBPF/SDK-injection workflow, and Go Controller daemon from the AutoDev distribution. AutoDev agents are known from canonical configuration, and desired-state reconciliation belongs in the TypeScript AutoDev Control API/runtime.
- generic OpenLIT onboarding and navigation for any removed feature;
- redundant OpenLIT configuration pages superseded by AutoDev resource pages.

Prefer deleting dead routes, components, stores, APIs, migrations, and navigation after dependency verification rather than keeping permanently disabled compatibility code. If an OpenLIT internal schema currently requires a singleton user/organisation/project/environment record during transition, treat it strictly as an internal implementation detail and remove that dependency when practical; never expose it as an AutoDev concept.

### Workspaces replace OpenLIT tenancy concepts

AutoDev repositories/workspaces such as `SimulatorLife/AutoDev` and `SimulatorLife/RacingGame` remain privacy-safe OTel/configuration dimensions (for example `autodev.workspace`) so telemetry can aggregate across all workspaces and filter/group by one or more workspaces.

Do not create one OpenLIT project, environment, organization, or account per workspace.

## 6. First-class AutoDev resources

The top-level resources/pages are:

| Resource | Primary authority | Main purpose |
| --- | --- | --- |
| **Agents** | RuleSync + AutoDev runtime | agent/role definitions, provider/model eligibility, routing/runtime configuration, desired/actual state, health, activity |
| **MCPs** | RuleSync + runtime + OTel | MCP server configuration, role exposure, tools/resources/prompts, connection/health, usage/errors |
| **Skills** | RuleSync + OTel | canonical skill definitions, role/workspace eligibility, exposure/use/error evidence |
| **Hooks** | RuleSync | hook definitions, event/matcher configuration, generated target projections, validation/effective state |
| **Memory** | adapted OpenLIT memory/connectors | browse/search/write/copy memory through supported connectors with AutoDev styling |
| **Evaluations** | adapted OpenLIT evaluations | evaluation definitions/results/history tied back to agents/prompts/models/traces where possible |
| **Permissions** | RuleSync + effective runtime state | canonical permission policy, role/tool/MCP capability matrices, generated target differences |
| **Tools** | generated/effective capability catalog + OTel | unified catalog of native tools, MCP tools, plugin/app tools and role exposure/usage |
| **Usage** | OpenTelemetry/OpenLIT | cross-workspace/provider/model/agent/skill/MCP usage, cost, tokens, latency, failures and traces |
| **Prompts** | RuleSync; OpenLIT Prompt Hub patterns | canonical prompts/commands with versions/diffs/preview where useful; OpenLIT is a projection, never authority |
| **Workspaces** | AutoDev configuration + OTel | configured repositories/workspaces, availability/health, resource scope and aggregate usage |

Provider/model/routing/runtime state is still first-class domain data, but is surfaced under **Agents** and resource details instead of adding more top-level navigation.

### Agents are configuration-defined

The Agents page starts from canonical RuleSync agent/subagent definitions and AutoDev runtime configuration.

Do not use OpenLIT's `discovered`, `instrumented`, or SDK/application-source model. Useful AutoDev statuses are configuration/runtime facts such as:

```text
Configured
Valid / Invalid
Ready / Unavailable
Converged / Pending / Error
Last activity
```

An agent detail view can combine:

- canonical RuleSync role definition and prompt;
- assigned skills, MCP servers, permissions, tools, providers and models;
- provider/model/routing/runtime controls;
- generated target projections;
- actual runtime readiness/health;
- recent runs, traces, tokens, cost and failures.

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
- canonical RuleSync agent/role definition;
- provider/model eligibility, routing and runtime configuration as secondary tabs/panels;
- skills, MCPs, permissions, tools and hooks affecting the role;
- generated provider projections and validation;
- actual runtime readiness/health and convergence;
- recent activity/traces/usage.

**MCPs**
- Overview, Configuration, Tools, Resources, Prompts, Role Access, Activity and Errors/Logs;
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

**Hooks**
- canonical RuleSync hook event, matcher and command/action;
- target support and generated projection;
- validation/effective status;
- recent hook execution/errors only where trustworthy runtime evidence exists.

**Memory**
- keep/adapt OpenLIT's useful connector-backed memory browsing/search/write/copy UI;
- use the same AutoDev navigation, tables, forms, detail patterns and filters as the rest of the console;
- do not reintroduce OpenLIT account/organisation/project/environment scoping.

**Evaluations**
- keep/adapt OpenLIT evaluation definitions, result/history and trace linkage;
- remove Rule Engine coupling and OpenGround as prerequisites;
- make evaluations operate directly on explicit AutoDev resources/telemetry.

**Permissions**
- canonical RuleSync permission policy;
- effective per-agent/role capability matrix;
- target/provider projection differences and validation;
- never infer permissions from historical tool usage.

**Tools**
- aggregate native runtime tools, MCP-provided tools, plugin/app tools and other effective tool capabilities into one catalog;
- show source, roles/agents exposed to, availability/health where meaningful, and historical use/error telemetry;
- configuration continues to be owned by the originating canonical source rather than by a duplicate Tools database.

**Prompts**
- adapt useful Prompt Hub UI concepts such as browse, edit, preview, version/diff and usage linkage;
- canonical content remains RuleSync commands/prompts/rules as applicable;
- remove OpenLIT Rule Engine linking as the activation mechanism.

**Workspaces**
- configured repository/workspace catalog;
- health/availability and applicable agent/resource scope;
- aggregate and drill-down usage;
- no OpenLIT project/environment/organization/account silo per workspace.

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
/control/hooks
/control/permissions
/control/prompts
/control/workspaces
/control/routing
/control/runtime
```

Use named typed operations only; no arbitrary command endpoint.

For RuleSync-owned resources, mutations change the canonical RuleSync source and run validation/generation/apply. For runtime-only resources, mutate the authoritative typed AutoDev owner. **Tools** is primarily a composite read model over effective capabilities and usage rather than a second configuration authority. **Memory** and **Evaluations** may retain/adapt their OpenLIT TypeScript APIs where they remain useful and independent of removed tenancy/Rule Engine/OpenGround concepts.

The AutoDev Console browser should use same-origin TypeScript server routes/proxies. The private AutoDev control listener remains separate from the model/OTLP router listener.

Security requirements:

- no built-in AutoDev user/account system;
- same-origin browser mutations with CSRF protection;
- private/scoped service credential from console server to Control API;
- installation/operator-level authorization appropriate to the local deployment;
- optional deployment-level reverse-proxy/SSO authentication when the console is exposed remotely, without creating AutoDev accounts;
- least privilege per resource/action;
- redacted audit record for each mutation;
- no bearer token, external identity secret, or raw mutation body in telemetry.

A completed control action may emit a bounded `autodev.control.mutation` observation; OTel is not the command path.

## 11. OpenLIT distribution and maintenance strategy

Maintain a dedicated AutoDev OpenLIT fork/distribution. Upstream contributions are optional and must never block AutoDev.

Current verified baseline:

- OpenLIT `openlit-2.1.0` at commit `9938c66638666ca5d3bcb850350faa82e510924b`;
- published image `ghcr.io/openlit/openlit@sha256:94552ccd09379b5e2fec3c51c4fec1b41d88d6b56b0a5ccc895c116673884fa8`;
- verified local arm64 image `autodev-openlit:openlit-9938c6663866-p85c36c5cf93c4ac2`;
- local image digest `sha256:09fc25e5e141e723744b758857105af6a5e9747eab942d10133df7e7dd2374ab`;
- lock file `$CODEX_HOME/openlit-patched.lock`;
- telemetry retention currently 730 hours (~30 days) with durable local volumes and no automated backup.

The current patch set established receiver bearer auth, generic dashboard variable/query bindings, Usage widgets, and isolated AutoDev control UI. The target fork may diverge further in **product shell, navigation, AutoDev domain modules, and control pages**, while keeping ingestion, OTel semantics, storage schemas, and generic query execution as close to upstream as practical.

Do not rewrite foundational OpenLIT storage/query abstractions merely to remove hidden singleton organisation/project/environment concepts.

Receiver authentication remains mandatory. The pinned upstream receiver does not natively enforce the AutoDev bearer requirement; retain the local `bearertokenauth` patch for OTLP/HTTP and OTLP/gRPC until the pinned upstream behavior genuinely replaces it.

## 12. Current verified implementation state

The original M0-M6 observability migration is complete.

- The legacy `/dashboard`, `src/router/dashboard.html`, Chart.js dashboard asset, lookback aggregator/history-only dashboard pipeline, and pass-through AutoDev Collector are decommissioned.
- AutoDev producers emit logical-request/physical-attempt telemetry and owned MCP/skill observations.
- The Control API has a dedicated control-only listener (default `4101` in the current local integration); the model/OTLP router remains separate.
- OpenLIT receiver authentication, ClickHouse persistence/TTL, generic dashboard variables, Usage queries, and the current `/autodev` control surfaces have been verified.
- All 11 Usage widgets (7 router + 4 MCP) have live-query evidence with the expected variable/scope behavior.
- RuleSync prompt, agent, model, and workspace projections are currently synchronized into OpenLIT for visibility. The **target** is to finish making RuleSync itself authoritative for all supported agent-facing configuration surfaces rather than preserving parallel native authorities.
- AutoDev uses one canonical OpenLIT project/workspace boundary internally; AutoDev workspaces remain OTel analytical attributes.
- The latest recorded repository validation for the completed migration was 1163 passed, 0 failed, 2 skipped, with focused patch/variable checks green.

### Remaining product-fork work

The next phase is deliberate product subtraction and reassembly, not restoration of old observability paths:

1. Replace OpenLIT navigation with the exact AutoDev left-nav defined in §2.
2. Remove account/user, organization, environment and project product concepts and their UI/API paths; keep only temporary hidden compatibility data where unavoidable during migration.
3. Remove Rule Engine, OpenGround and GPU dashboard/product code from the AutoDev distribution.
4. Remove the OpenLIT Go Controller/eBPF discovery/instrumentation runtime; preserve only useful desired-state/convergence concepts in AutoDev's TypeScript control layer.
5. Replace OpenLIT's discovered/instrumented Agents model with RuleSync-configured AutoDev agents/roles.
6. Make MCPs, Skills, Hooks, Permissions, Tools, Prompts and Workspaces first-class TypeScript modules using canonical RuleSync/AutoDev sources.
7. Keep/adapt OpenLIT Memory, Evaluations, Agents UI patterns, Usage/telemetry foundations, and Prompt Hub interaction patterns where they fit the target.
8. Move provider/model/routing/runtime controls into Agents and relevant detail surfaces rather than top-level navigation.
9. Complete RuleSync canonical ownership for all supported agent-facing configuration still held in duplicate native sources.
10. Route RuleSync-owned console mutations through typed Control API operations that edit/validate/generate/apply canonical RuleSync state.
11. Consolidate every retained/borrowed surface onto one shared TypeScript/TSX design system and component library.
12. Add desired/actual/pending/error state consistently across mutable resources.
13. Delete superseded OpenLIT routes/components/stores/APIs/migrations after each replacement reaches parity; do not retain hidden permanent feature forks.

## 13. Operational entry points

Current local stack lifecycle:

```bash
bash scripts/openlit/up.sh
bash scripts/openlit/down.sh
```

Current out-of-band OpenLIT projections:

```bash
pnpm openlit:sync-prompts
pnpm openlit:sync-agents
pnpm openlit:sync-models
pnpm openlit:sync-workspaces
```

These sync commands populate OpenLIT read models; they do not supersede canonical RuleSync/AutoDev configuration ownership.

The asynchronous GitHub issue metrics workflow remains a separate GitHub-development reporting surface (`.github/workflows/metrics-dashboard.yml`, issue #2). It is not a replacement observability backend for AutoDev runtime telemetry.

## 14. Reference projects and patterns

Use existing projects as architecture/interaction references rather than inventing each control surface from scratch.

| Project | Primary use | Borrow |
| --- | --- | --- |
| **OpenLIT** | observability foundation | OTel ingestion, ClickHouse/querying, traces/metrics/logs, dashboards, cost/usage, Controller desired-state patterns |
| **LiteLLM** | Providers, Models, MCP Servers | provider/model catalogs, deployments, enablement, routing/fallbacks, MCP management, limits |
| **LangWatch** | overall product UX | unified AI observability + operational/provider/gateway controls |
| **MCPJam Inspector** | MCP detail/debugging | tools/resources/prompts, connection state, requests, logs, auth/activity inspection |
| **Unleash** | Skills/scoped capabilities | enabled state plus targeting/constraints/role/workspace scope |
| **Argo CD** | desired versus actual state | desired/live state, health, pending operations, convergence, errors/history |
| **Backstage** | modular console architecture | cohesive top-level modules/routes instead of one monolithic settings area |

Use interaction models and architecture; copy source only after reviewing the exact license/dependency boundary.

## 15. Tests and acceptance

### Generic dashboard/filtering
- stock OpenLIT time range;
- typed workspace/provider/model/role/skill bindings where supported;
- All/multi-select;
- URL/saved-state persistence;
- widget opt-in;
- safe parameterization;
- fail-closed unsupported scopes/signals.

### Telemetry
- one logical request versus N physical attempts;
- no duplicated token/cost/latency accounting;
- cache-read unavailable semantics;
- bounded dimensions;
- privacy/redaction;
- source-owned workspace/role/provider/model attribution;
- MCP and skill observations only when evidence exists.

### RuleSync/configuration
- canonical RuleSync sources round-trip through the pinned generator;
- generated provider configs are deterministic projections;
- no editable duplicate authority remains after each migration slice;
- role/skill/MCP/permission behavior remains equivalent across supported targets;
- console mutations update canonical RuleSync state and then reconcile runtime state.

### Control
- authenticated/authorized reads and mutations;
- CSRF and scoped service credential;
- viewer/operator boundaries;
- audit record and bounded mutation telemetry;
- desired/actual/pending/error convergence;
- OTLP/query paths cannot mutate AutoDev.

### Fork/upgrades
- pinned OpenLIT revision and patch application;
- upstream upgrade regression suite;
- no user/account/organization/environment/project UX remains;
- Rule Engine, OpenGround, GPU dashboard, and discovered/instrumented agent concepts are absent from the AutoDev product;
- canonical left navigation matches §2;
- all AutoDev-owned application/control modules are TypeScript/TSX and use the shared component/design system; the OpenLIT Go Controller is not shipped;
- Memory/Evaluations/Agents/Prompt patterns retained only where they no longer depend on removed OpenLIT product concepts;
- storage/query/receiver behavior remains intact unless explicitly approved.

Do not remove an incumbent path until the replacement has end-to-end evidence. Do not keep permanent compatibility paths after cutover.

## 16. Secondary-document policy

- This document is the only broad AutoDev Console/observability/configuration target-state document. Completed migration ledgers and superseded target-state docs should be deleted rather than retained as competing active guidance.
- `docs/README.md` indexes the remaining focused operational/design docs and their scope.
- `.rulesync/skills/opentelemetry/SKILL.md` contains reusable OTel engineering rules and must point here for AutoDev-specific decisions.
- Focused docs such as provider routing, local setup, prompt ownership, or codebase context may document current operation or subsystem-specific design, but must explicitly defer to this document on shared ownership/target-state questions.
- This document replaces the former observability target/runbook and broader platform/UI migration ledgers; do not recreate parallel broad plans.
- OpenLIT and OTel upstream behavior is evidence and a dependency to pin/test, not a prerequisite for AutoDev to ship local extensions.

## Final target

The target is **not** "OpenLIT with an AutoDev settings page."

It is:

> **A single-user AutoDev control and observability console built from a deliberately reduced OpenLIT foundation: retain the OpenTelemetry-native ingestion, storage, querying, Usage, Memory, Evaluations, and useful Agents/Prompt UI primitives; remove accounts, organizations, environments, projects, Rule Engine, OpenGround, GPU monitoring, and discovered/instrumented agent concepts; make Agents, MCPs, Skills, Hooks, Memory, Evaluations, Permissions, Tools, Usage, Prompts, and Workspaces the canonical product surface; use RuleSync as the source of truth for agent-facing configuration it supports; and implement every AutoDev-facing surface in one shared TypeScript/TSX design system without conflating control state with observability data.**
