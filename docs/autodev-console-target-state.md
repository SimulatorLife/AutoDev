# AutoDev Console Target State

> **Authority:** This is the single living source of truth for AutoDev's OpenLIT fork, observability architecture, control-plane/UI ownership, RuleSync configuration ownership, migration state, acceptance evidence, and future console work.
>
> **Last reviewed:** 2026-10-03.
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

| Module     | Owns                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console/` | The single AutoDev React/Next.js application, shared design system/components, navigation, and feature folders for Agents, MCPs, Skills, Hooks, Memory, Evaluations, Permissions, Tools, Usage, Prompts, and Workspaces |
| `runtime/` | Long-running AutoDev execution: model router, provider bridges, agent execution, MCP processes, hook execution, runtime health, desired-state reconciliation, and the Control API transport                             |
| `core/`    | Infrastructure-independent AutoDev domain types/contracts and pure rules shared by Console, Runtime, and Data                                                                                                           |
| `data/`    | Typed adapters/repositories for RuleSync canonical sources, OpenLIT/ClickHouse queries, memory/evaluation persistence, workspace/config reads, and other external/persistent data boundaries                            |

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

**Current state:** `pnpm-workspace.yaml` registers the four root workspaces,
and the obsolete root `src/` implementation tree has been removed. Runtime owns
the router, Control API, providers, agents, MCP, hooks, telemetry, configuration,
CLI, and platform installation/provisioning behavior under `runtime/src/`.
Data owns RuleSync/OpenLIT read-model adapters, Usage queries, and persistence;
the remaining OpenLIT singleton workspace bootstrap is an internal migration
detail, not a per-workspace tenancy model. Console, Runtime, and Data consume
Core through the `@simulatorlife/autodev-core` workspace contract. Workspace
boundary cleanup and Console/Data integration remain incomplete; the root
package is repository tooling, not another application module.

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

- **Accounts/users**: completely remove login/sign-up functionality and UI, account-management product flows, OAuth account UI, user profiles, invitations, membership management, and account-scoped preferences. AutoDev is a single-user/local control plane; deployment-level authentication (e.g. reverse proxy) may protect a remotely exposed instance without reintroducing an application account model:
  - `/login` and `/register` UI forms, inputs, and OAuth buttons are removed; requests to these routes immediately redirect to `/home`.
  - Auth middleware no longer gates pages/APIs or redirects unauthenticated visitors to `/login`.
  - Sidebar navigation excludes user action dropdowns, avatar/email displays, and logout/signout triggers.
  - Server-side session helpers resolve the single local user record automatically without requiring interactive authentication.
  - OAuth environment variables (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`) are purged from deployment configs.
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

### User-facing branding: "AutoDev", not "OpenLIT"

All user-facing product wording in the AutoDev distribution must say **AutoDev**, not **OpenLIT**. This includes:

- browser title / metadata;
- sidebar brand name, logo alt text, and search placeholder;
- version popover label;
- page headings, descriptions, and instructional copy;
- getting-started / onboarding text;
- SDK setup headings (e.g. "Install AutoDev SDK", "Initialize AutoDev");
- error messages returned to users (API responses, evaluation feedback, controller polling);
- string constants in the message catalog (`en.ts`);
- API key placeholders (e.g. `YOUR_AUTODEV_API_KEY`);
- console log / status output from sync and startup scripts.

**Do not rename** internal/technical identifiers where doing so would break protocol, storage, or code compatibility:

- ClickHouse table names (`openlit_*`, `otel_*`);
- environment variables (`OPENLIT_API_KEY`, `OPENLIT_URL`, `OPENLIT_DB_PASSWORD`, etc.);
- HTTP headers (`x-openlit-project-id`, `x-openlit-organisation-id`);
- localStorage keys (`openlit:my-apps-hidden:`, `openlit:environment:`);
- TypeScript types/interfaces (`OpenLITQuery`, `OpenLitContextIds`);
- CSS classes (`openlit-scrollbar`);
- OpenTelemetry attributes (`openlit.agent.*`, `openlit.lifecycle.*`);
- internal code comments describing OpenLIT architecture;
- file/component names that are internal implementation details.

### Workspaces replace OpenLIT tenancy concepts

AutoDev repositories/workspaces such as `SimulatorLife/AutoDev` and `SimulatorLife/RacingGame` remain privacy-safe OTel/configuration dimensions (for example `autodev.workspace`) so telemetry can aggregate across all workspaces and filter/group by one or more workspaces.

Do not create one OpenLIT project, environment, organization, or account per workspace.

## 6. First-class AutoDev resources

The top-level resources/pages are:

| Resource        | Primary authority                             | Main purpose                                                                                                              |
| --------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Agents**      | RuleSync + AutoDev runtime                    | agent/role definitions, provider/model eligibility, routing/runtime configuration, desired/actual state, health, activity |
| **MCPs**        | RuleSync + runtime + OTel                     | MCP server configuration, role exposure, tools/resources/prompts, connection/health, usage/errors                         |
| **Skills**      | RuleSync + OTel                               | canonical skill definitions, role/workspace eligibility, exposure/use/error evidence                                      |
| **Hooks**       | RuleSync                                      | hook definitions, event/matcher configuration, generated target projections, validation/effective state                   |
| **Memory**      | adapted OpenLIT memory/connectors             | browse/search/write/copy memory through supported connectors with AutoDev styling                                         |
| **Evaluations** | adapted OpenLIT evaluations                   | evaluation definitions/results/history tied back to agents/prompts/models/traces where possible                           |
| **Permissions** | RuleSync + effective runtime state            | canonical permission policy, role/tool/MCP capability matrices, generated target differences                              |
| **Tools**       | generated/effective capability catalog + OTel | unified catalog of native tools, MCP tools, plugin/app tools and role exposure/usage                                      |
| **Usage**       | OpenTelemetry/OpenLIT                         | cross-workspace/provider/model/agent/skill/MCP usage, cost, tokens, latency, failures and traces                          |
| **Prompts**     | RuleSync; OpenLIT Prompt Hub patterns         | canonical prompts/commands with versions/diffs/preview where useful; OpenLIT is a projection, never authority             |
| **Workspaces**  | AutoDev configuration + OTel                  | configured repositories/workspaces, availability/health, resource scope and aggregate usage                               |

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

Widgets opt in only to variables whose semantics apply. Bind user selections through typed parameterized query inputs; never concatenate user-controlled SQL. The unified Console's same-origin server adapter calls only a fixed, read-only OpenLIT Usage endpoint with a dedicated server-to-server credential. It accepts bounded time/filter selections, never raw SQL or arbitrary widget IDs, and does not reuse Control API mutation credentials or browser sessions.

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

### Memory

The owning Runtime `MemoryService` emits one `memory.research` parent span with
bounded child spans for `memory.query`, `memory.retrieve`, `memory.rerank`,
`memory.validate`, `memory.reconstruct`, and `memory.packet`; `memory.embed` is
present only when an embedding adapter is configured. Span attributes are
bounded categories and counts (memory kind, validation/review disposition,
rejection category, candidate counts, packet character/token counts). Never
attach task/query text, claims, transcript contents, file paths, repository or
memory IDs, or free-form verifier/model errors. These spans observe the memory
operation; they do not replace MemoryService authorization or state. The
MemoryService also emits `autodev.memory.operations` and
`autodev.memory.operation.duration` with only the fixed operation name and
success/error outcome; `autodev.memory.candidates` counts retrieved, retained,
revised, rejected, packet-included, and packet-omitted candidates with bounded
kind/reason dimensions. `autodev.memory.packet.characters` and
`autodev.memory.packet.tokens` record packet size, with the token histogram
omitted when no token counter is configured. `autodev.memory.injections` records
`injected` versus `empty` at the request-assembly boundary; it does not claim the
model used a packet or that a task succeeded. `autodev.memory.outcome_reports`
counts only newly appended reporter-supplied outcomes (not idempotent retries)
with bounded outcome, report-kind, mode, and injection-result categories derived
from the report and its matched injection event. The separate
`autodev.memory.use_reports` counter increments only for newly appended,
curator-assessed injection-use reports and uses only bounded `use.kind` and
`use.memory_mode` dimensions; it never includes packet IDs or evidence. Orchestrator preparation runs inside
the logical routed-request span, making the `memory.research` tree, actual packet
injection result/size, and final provider-routing outcome inspectable in one trace.
That final request outcome is not a downstream task/PR outcome. The Runtime also
persists append-only, content-free injection decisions and reporter-supplied outcome
reports through MemoryService/Data; outcome reports are not inferred from routed
request status, retrieval, or a PR link. The one-to-one opaque correlation token is
kept in the scoped Memory Control API/Data path, never in prompts or telemetry
attributes. The existing GenAI attempt spans remain the source for model cost
rather than duplicating it here. The router registers its configured MeterProvider
before constructing its shared MemoryService host, so Runtime-owned meters use the
same OTLP exporter. Operation-duration observations are per-span;
nested stages overlap and must not be summed into a total. These metrics
contain no task, repository, memory, claim, path, or actor identifiers; the existing GenAI attempt
spans remain the source for model cost rather than duplicating it here.
The workspace/repository/time-scoped `memory.injection.outcome.aggregate` and
`memory.injection.use.aggregate` spans record only resulting cohort-cell and
exposure/report counts; query selectors, task/run/agent IDs, memory IDs, and
evidence remain out of telemetry. Use cohorts count curator-assessed injection
packet use separately from task outcomes and do not infer model use from output
text or provider routing.

The explicit procedure-to-skill transaction emits `memory.promote` with only bounded target
and outcome categories; the skill name, body, evidence URI, and memory id stay out
of span attributes. The root reconstructor calls the existing orchestrator alias through the loopback router,
with developer-only input to avoid recursive JIT. W3C context is injected on that
HTTP request and extracted at the router boundary so the nested routed-request
and GenAI attempt spans remain children of `memory.reconstruct`; prompt and
claim text remain out of span attributes.

The root router now calls `MemoryService.research` in-process before provider
selection for a user-authored orchestrator turn when `AUTODEV_MEMORY_DATABASE_URL`
and a validated repository workspace are available. The bounded packet is
appended as advisory `instructions`; tool-result continuations without a new
user steer are not re-researched. The Git verifier only retains a
claim when its cited source commit is ancestral and every cited tracked source
file—including canonical `rulesync://skills/.../SKILL.md` evidence—is unchanged
in the current working tree. The root path then reconstructs at most
two candidates through the existing orchestrator model over the local router;
invalid or unavailable outputs fail closed as uncertain. This is current-file/
commit validation plus routed reconstruction, not a complete RuleSync, PR/issue,
runtime-config, or provider-model curator.

The authenticated Control API now has scoped, paginated read routes for memory
records/experiences and record history/provenance. It shares the router's
in-process MemoryService and trusted repository-root registry; reads require an
explicit workspace scope and continue to pass through the canonical visibility
checks. Run-bound experiences remain private unless an operator explicitly
requests workspace/repository-bounded task history and the Control API is
configured with `AUTODEV_MEMORY_READ_TASK_HISTORY=1`; this grant does not widen
durable-memory visibility. `GET /control/memory/cohorts` additionally requires
that operator grant, an explicit repository, and an inclusive occurrence-time
window no wider than 365 days; it rejects task/run/agent/role selectors and
returns fixed-dimension exposure/report counts with explicit unreported cells.
Outcomes remain reporter-supplied; this aggregate does not claim task success,
model use, or PR verification. Operator-only actions expose propose, revise, current-state verify and
promotion, invalidation, supersession, guarded procedure-to-skill promotion, and
curator-gated raw-experience purge through MemoryService. Each action is audited
without recording claims or evidence payloads. Purge refuses experiences cited
by any durable memory and keeps only a hashed append-only tombstone. Skill promotion requires two distinct successful runs with passing
validation, rechecks current Git state, writes a non-overwriting canonical
RuleSync skill, and invalidates the redundant fuzzy memory while retaining
source history. Codex SessionEnd is wired to a best-effort native capture
hook; the server validates an observed session/root pair and stores only
normalized metadata, digest, and a source reference. Claude Code SessionEnd is
also opt-in through an operator-owned workspace-to-transcript binding and
keeps outcome/session mapping unknown. Other harness capture adapters remain
unimplemented. An end-to-end isolated test materializes and executes the
installed Codex hook against an authenticated loopback Control API; actual
Codex desktop hook trust/approval still needs live operator verification.
OpenLIT patches 08–17 retain the AutoDev Memory connector as read-only for generic CRUD, add
status-gated governed lifecycle actions and provenance/history detail, persist per-experience
injection/outcome detail, add evidence-backed outcome reporting and bounded experience/session
cohort tables, remove the GPU product surface, and delegate AutoDev actor authorization to the
Control API instead of an OpenLIT session. Mutations continue through server-side credentials and
AutoDev MemoryService governance. The tested 17-patch prefix passed seven focused upstream Jest
suites (66/66) and its patched-client typecheck. Patch 18 removes the OpenLIT Controller/OpAMP and
discovery runtime while retaining the authenticated first-party OTLP receiver. Patch 19 removes
the remaining OpAMP image artifacts, moves the receiver to /app/otel/otelcol-contrib, and keeps the
entrypoint as PID 1 to signal, supervise, and reap both UI and receiver processes. Patch 20 removes
obsolete Controller-only English/Hindi message constants. Patch 21 removes the
remaining Controller table bootstrap from ClickHouse. The full 21-patch sequence applies to the pinned source (tests/openlit-patches-apply.test.ts, 6/6); patched-client typecheck and eight focused upstream Jest suites (58/58) pass. scripts/openlit/build-local.sh built the linux/arm64 p21 image autodev-openlit:openlit-9938c6663866-p01204b3d1c6d87af with digest sha256:e18e53a018a3a5baaa81e7cac4b4fb089faddac9847abab2d72e77963cff8729 using a separate validation lock under .tmp. An isolated p21 ClickHouse/OpenLIT stack returned 401 without OTLP auth and 200 with a bearer token, persisted one trace, created no Controller tables in its fresh ClickHouse volume, and stopped with exit 143 after the Collector logged Shutdown complete. This verifies only an isolated stack; the standard lock and running container remain on p14. Existing persistent volumes are not automatically purged of historical Controller tables. The Next Console `/memory` route now provides a safe
entry card to the configured OpenLIT Memory page and does not duplicate record browsing, detail,
cohort, or mutation UI; the patched OpenLIT page remains the sole primary memory operator surface.
`AUTODEV_OPENLIT_UI_URL` configures the browser-reachable UI base, is validated as HTTP(S) without
embedded credentials, and is only used to form the fixed `/memory` link. Broader memory
effectiveness analytics, controlled evaluations, and live deployment acceptance remain pending.

OpenLIT can display these spans after trace links and memory analytics are
wired. The repository does not yet have a memory-specific dashboard, a
provider-backed embedding adapter, additional native-harness capture calls, a
root workspace resolver for every deployment, or a deployment-scheduled retention
policy. A one-shot Runtime retention runner processes an operator-selected cutoff
in bounded batches and is disabled by default; raw erasure remains an explicit
audited per-experience transaction. Configured telemetry must not be described as
an observed dashboard or as memory use when no packet was injected.

### Skills

Use a minimal `autodev.skill.*` semantic contract because no suitable standard skill convention exists. Current trustworthy runtime observations include exposure/use and producer-reported unavailable/error; configuration itself is not runtime proof.

Do not put skill name into broadly aggregated metric dimensions if it creates unbounded cardinality; use traces/events and bounded dashboard queries where appropriate.

## 9. AutoDev Usage dashboard

The current verified Usage board contains seven router widgets plus four MCP widgets:

| View                           | Semantics                                                  |
| ------------------------------ | ---------------------------------------------------------- |
| Logical routed requests        | one per `autodev.routed_request`, including final failures |
| Logical requests by agent/role | routed-request activity grouped by bounded role            |
| Input/output tokens            | sum on physical GenAI attempts                             |
| Cache-read rate                | cached input / input where both are reported               |
| P95 attempt latency            | physical attempt duration                                  |
| Physical attempts by provider  | attempts grouped by `gen_ai.provider.name`                 |
| MCP tool calls                 | shim-owned `tools/call` round trips                        |
| P95 MCP tool-call duration     | shim-side MCP span duration                                |
| MCP tool-call errors           | errored MCP `tools/call` spans                             |
| MCP calls by tool              | top bounded tool-name groups                               |

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

**Local single-user identity:** when no viewer/operator actor allowlists are
configured, the Control API accepts only the fixed `autodev-local` actor as an
operator, and only alongside its server-side service credential. The Console
must attach that actor on the server; browser-provided actor or role headers are
never trusted. Configuring either allowlist disables this local identity and
requires an explicit actor. The legacy OpenLIT proxy still forwards its
verified session actor until that UI is retired.

Security requirements:

- no built-in AutoDev user/account system;
- complete removal of login and sign-up flows/UI; direct local single-user access;
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

The current patch set establishes receiver bearer auth, generic dashboard variable/query bindings, Usage widgets, a dedicated read-only Usage query endpoint, isolated AutoDev control UI, login/signup removal, and user-facing OpenLIT→AutoDev branding. The Usage endpoint and Console adapter are source-integrated and unit/type checked; building the pinned patched image and querying live telemetry remain unverified. The target fork may diverge further in **product shell, navigation, AutoDev domain modules, and control pages**, while keeping ingestion, OTel semantics, storage schemas, and generic query execution as close to upstream as practical.

Do not rewrite foundational OpenLIT storage/query abstractions merely to remove hidden singleton organisation/project/environment concepts.

Receiver authentication remains mandatory. The pinned upstream receiver does not natively enforce the AutoDev bearer requirement; retain the local `bearertokenauth` patch for OTLP/HTTP and OTLP/gRPC until the pinned upstream behavior genuinely replaces it.

## 12. Current migration state and gap ledger

This section records the **observed repository state**, not the desired target. It must be updated as migration slices land so target-state statements do not get mistaken for completed implementation.

Current review baseline: AutoDev `main` after the patch 22 Memory UI, PR-evidence validation, and workspace-lock fixes recorded below.

### Migration status

| Area                 | Current state                                  | Remaining gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flat monorepo        | **Partial**                                    | The four root workspaces are registered and the root `src/` tree is gone. Runtime now owns the CLI, platform installation/provisioning, Router, Control API, and runtime behavior; Data owns the OpenLIT singleton bootstrap and RuleSync/OpenLIT read models. Remaining work is workspace dependency/import hygiene and completing the Console/Data integrations; no fifth software workspace or root application source should be introduced. |
| Console              | **Runnable foundation**                        | Next.js App Router and all 11 canonical routes build and run. Seven resource views use server-side Control API reads; Agent and Prompt detail routes use the existing typed detail endpoints. The retained OpenLIT Memory connector/page has governed lifecycle, provenance/history, per-experience outcome reporting/detail, bounded outcome/session cohorts, curator-assessed per-injection use reporting, and a count-only use-cohort table. Patch 22 keeps experience reads on the canonical Memory adapter detail path and adds only the audited POST report proxy plus the GET use-cohort proxy. The 22-patch source sequence applies; six focused Jest suites (69/69), patched-client lint/typecheck, and Prisma validation pass. A local p22 linux/arm64 image build passes as `autodev-openlit:openlit-9938c6663866-p00823204fd1df76c` (`sha256:3cd644576391dfaf46dc286a6e860add7612655b8646531c58c5966b014adab4`) with the separate `.tmp/openlit-p22-validation.lock`. It is not promoted to the standard image lock; the standard deployment remains at p14, and deployed receiver drain/live acceptance and Console integration remain pending. The Next Console `/memory` route now provides a validated link to that sole operator UI instead of a second memory application; deployed UI/Control API acceptance remains pending. Evaluations remains unavailable pending adapters; Tools now reads a partial typed Control API capability projection, with runtime status and usage linkage still unknown. Usage has a typed OpenLIT query adapter and dedicated service-auth endpoint, but patched-image/live-query acceptance remains unverified. Other detail integrations and full OpenLIT features remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Workspace boundaries | **Partial**                                    | Runtime owns the migrated shared contracts, configuration tools, Router, Control API, and platform owners under `runtime/src/`; callers use public workspace subpaths and all superseded root `src/` implementations are deleted. Data owns the RuleSync Agent/Prompt and Provider/Model OpenLIT projections, Usage client, memory persistence, and the internal singleton workspace bootstrap. Console/Data integrations and remaining Runtime/Data adapter cleanup are incomplete; the root package remains test/developer orchestration and is not a fifth code module. |
| RuleSync ownership   | **Partial**                                    | Skills, hooks, commands/prompts, and MCP declarations are established; subagent/agent-role and permissions generation remain explicitly deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Control API          | **Partial**                                    | Typed reads cover configuration resources and a partial Tools capability catalog from role MCP/plugin allowlists plus native web-research flags; local single-user access uses the fixed `autodev-local` actor with the private service credential. Provider-role enablement and governed Memory propose/revise/verify/invalidate/supersede/procedure-to-skill promotion actions are audited mutations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Data layer           | **Early**                                      | RuleSync/config/ClickHouse adapters remain; typed RuleSync MCP source reading, Agent/Prompt projection, and Provider/Model OpenLIT projection syncs now live in Data, with a shared typed ClickHouse connection resolver; RuleSync remains authoritative for agent-facing sources, while the Data model catalog is an OpenLIT read-model input; the new PostgreSQL/pgvector memory schema and repository are implemented. The v4 audited raw-experience purge, v5 retention-scan index, and v6 evidence-reference search vector are covered by SQL-shape/fake-repository tests; disposable PostgreSQL/pgvector integration verifies file and pull-request reference search, retention, and purge. Routine integration tests remain environment-gated. The typed OpenLIT Usage client and scoped Memory Control API are implemented and tested. RuleSync skill writes now use a no-overwrite Data API behind Runtime promotion policy. OpenLIT patches 08–17 add the AutoDev Memory connector, governed lifecycle actions, provenance/history, per-experience outcomes/reporting, bounded experience/session cohorts, GPU product removal, and Control API-owned actor authorization; the tested p17 prefix passes seven focused upstream Jest suites (66/66) and client typecheck. Patch 18 removes Controller/OpAMP and discovery; patch 19 removes remaining image build/runtime artifacts and supervises the authenticated first-party OTLP receiver; patch 20 removes unused Controller strings; patch 21 removes Controller table creation from the ClickHouse bootstrap. The full 21-patch apply, patched-client typecheck, eight focused Jest suites (58/58), and p21 linux/arm64 image build pass. The validation image is not in the standard lock, deployed receiver drain acceptance remains open, and the standard lock/deployment remain at p14. Live Control API/UI acceptance and broader memory analytics remain incomplete. Evaluations, runtime-state, and effective-tool integrations also remain incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Usage                | **Adapter wired; deployment unverified**       | Sample values have been removed. URL-persisted typed filters call a dedicated OpenLIT service endpoint that executes only the seeded Usage widgets through `runWidgetQuery` and typed distinct-value adapters; unsupported/partial metrics remain unknown. The Console now exposes OpenLIT's 24H/7D/1M/3M/CUSTOM range model with URL-persisted UTC date bounds; its 90-day query limit and approximately 30-day retention are stated in the UI. Patched-image build and live telemetry-query acceptance are still required.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Memory               | **Backend foundation + root JIT; Control API** | Core scopes/lifecycle, PostgreSQL+pgvector/full-text storage, trajectory capture API, governed Runtime service, Git current-state verifier, bounded routed orchestrator-model reconstruction with deterministic test fallback, official MCP facade/stdio CLI with host-bound `experience_append`, root-router pre-provider JIT, and scoped/paginated Memory Control API with operator lifecycle actions are implemented. Data retrieval now soft-ranks exact/nearby file evidence and caller-visible task-kind matches after hard scope/validity filters; disposable PostgreSQL/pgvector tests verify path ordering, task-kind privacy, reference search, and retention/purge. Migration 8 adds append-only request-level injection events and reporter-supplied outcome joins; disposable PostgreSQL/pgvector integration verified the end-to-end operator Control API report/join across distinct request run/thread IDs, idempotent concurrent reports, and append-only triggers. The operator-only outcome routes require an explicit task-history grant and evidence, but do not verify PR status or model use. `GET /control/memory/cohorts` reads parameterized repository/time-bounded aggregates (maximum 365 days), preserves unreported exposure cells, and returns no task/run/agent identifiers or evidence; disposable PostgreSQL integration verifies reported and unreported group counts. The aggregate reports counts, not success rates or model use. The Git verifier checks cited file identity and canonical RuleSync skill/command/hook/MCP files. A cited canonical same-repository PR must now be closed/merged, approved, have successful status checks, and have no unresolved current review threads before it can contribute lineage; the thread listing must be complete within the 100-thread query bound. One bounded GraphQL lookup per research context can batch one PR and one issue, reading thread state but not comment text. Canonical same-repository GitHub issue state is surfaced as dated context and never treated as task success; semantic issue-state reconciliation and review-thread contents remain unverified. Routine integration tests remain environment-gated. OpenLIT patches 08–17 add status-gated lifecycle actions, provenance/history and per-experience injection/outcome detail, evidence-backed outcome reporting, bounded experience/session cohorts, GPU product removal, and Control API-owned actor authorization in the retained AutoDev Memory page. The tested p17 prefix passes seven focused upstream Jest suites (66/66) and patched-client typecheck. Patch 18 removes Controller/OpAMP and discovery; patch 19 removes the remaining image artifacts and keeps a PID-1 shell supervising the UI plus authenticated first-party receiver; patch 20 removes stale Controller messages. The full 21-patch apply, client typecheck, eight focused Jest suites (58/58), and p21 linux/arm64 image build pass. The validation image is not in the standard lock; deployed receiver drain/UI acceptance remains pending, and the standard lock/running deployment are still at p14. The cohort view preserves unreported cells and shows counts only, not success rates or model-use claims. Claude Code has an opt-in, operator-bound transcript capture API; Copilot CLI and Gemini CLI still lack harness-bound capture adapters. Other remaining gaps are a configured live embedding-provider acceptance test, complete RuleSync/runtime validators, semantic issue-state reconciliation, review-thread comment-content analysis, and semantic superseding-change validation beyond cited-path history, deployment scheduling and broader memory-class erasure, default per-run MCP launch configuration, controlled real-task evaluations and broader memory analytics, and verified OpenLIT deployment. Explicit audited raw-experience purge is implemented in MemoryService/Control API and refuses to erase referenced provenance.                       |
| Evaluations          | **UI shell**                                   | Feature view exists; retained OpenLIT evaluation execution/history/query paths are not yet integrated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| MCPs                 | **RuleSync-backed list/detail configuration views** | Data parses canonical `.rulesync/mcp.jsonc` JSONC declarations, base enablement, and explicit target overrides (including `disabled: true` and null removals); the Control API joins configured role exposure and flags references without a canonical declaration. Console list/detail pages show transport/default/target configuration and role access plus a clearly partial configured tool allowlist, without exposing launch values or credentials. Connection health and the complete live tool/resource/prompt inventory remain unknown; probing, diagnostics, and activity remain incomplete. |
| Prompts              | **Read-oriented prototype**                    | Canonical RuleSync prompts can be surfaced, but edit/validate/save/version/diff/generate/apply and usage/evaluation linkage are missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Tools                | **Partial configuration catalog**      | A read-only `/control/tools` projection now joins explicitly enumerated role MCP/plugin tools with native web-research capabilities and marks coverage partial. Runtime health and OpenTelemetry usage are not invented; a complete native/provider/app inventory, unbounded MCP server tool lists, health, and use/error/trace linkage remain open. |
| Desired/actual state | **Mostly conceptual**                          | Agent configuration is labeled configured, with validity unknown and convergence not observed; most other resource state still lacks reconciled desired/observed generations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| OpenLIT product fork | **Partial/additive**                           | Receiver auth, dashboard variables, Usage, login/signup removal, branding, and old AutoDev pages are patched; the unwanted OpenLIT product modules are not yet comprehensively removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Telemetry cutover    | **Standalone Collector removed; router cleanup incomplete** | The AutoDev-owned standalone Collector binary, provisioning, config, scripts, and service are deleted; installation migrates the obsolete saved `collector` mode to the existing `direct` router ingress and unloads/removes stale Collector LaunchAgent files. Authenticated OpenLIT OTLP/HTTP ingestion is locally verified (protected trace POST → ClickHouse), and the opt-in `openlit` mode sends producers to OpenLIT on `:4318`. The default `direct` mode still uses the AutoDev router OTLP receiver on `:4100`; live Codex-to-OpenLIT acceptance and removal of router-owned historical aggregation/receiver paths remain. |
| CI evidence          | **Workspace tests pass; static gates remain red** | On 2026-10-03, `pnpm install --frozen-lockfile --offline` passes. Full `pnpm test` passes root 1217/1219 (two skipped), Core 24/24, Data 135/144 (nine environment-gated skips), Console 40/40, and Runtime 127/130 (three environment-gated skips). Focused memory Git-curation tests pass 18/18, router reconstruction tests pass 4/4, and targeted ESLint passes; changed Runtime files have no TypeScript diagnostics. Full `pnpm typecheck` still reports 492 root and 111 Runtime diagnostics; Core/Data/Console typechecks pass. Full `pnpm lint:ci` and format checks were not rerun (the last recorded run reported 126 lint errors and 13 formatted files). GitHub commit checks, deployed receiver drain/live acceptance, and Console integration remain unverified. A p22 arm64 image build and isolated smoke passed (`/memory` 200, unauthenticated OTLP 401, bearer OTLP 200, one span persisted); the standard lock and running container remain at p14. |

### Correctness rule: unknown must remain unknown

The Console must never turn missing integration data into optimistic state. Transitional code currently contains examples such as sample Usage metrics and synthesized `ready`/`converged`/healthy values.

Replace these with explicit states such as:

```text
unknown
not observed
unavailable
pending
error
```

until the owning source reports the value.

Examples that must not survive cutover:

- hard-coded Usage request/token/provider counts;
- MCP rows that report `Connected` or `100%` health without a runtime probe;
- agent definitions that become `ready`/`converged` merely because a config file exists;
- permission/config values duplicated as constants instead of read from canonical/effective state.

### Remaining structural cutover

#### 1. Physical migration complete; finish workspace hygiene

The root `src/` implementation tree is absent. Router, Control API,
configuration, CLI, platform installation/provisioning, providers, agents,
MCP, hooks, and telemetry are owned by Runtime; RuleSync/OpenLIT projections,
Usage queries, memory persistence, and the internal OpenLIT singleton
workspace bootstrap are owned by Data. The remaining work is boundary cleanup
and integration—not another move from root `src/`.

Keep callers on workspace package contracts, declare dependencies at the
owning workspace, and do not reintroduce a root implementation or a permanent
`runtime/ → ../../../src/*` facade.

**Verified slices:** the Responses continuation parser, provider-limit contract, workspace resolver, canonical tool-name vocabulary, agent-context headers, execution contract, Responses item-id policy, environment parser, executable resolver, and process-output owner were moved from legacy `src/shared/` into `runtime/src/shared/`; OTel resource context, agent-event reporting, and GitHub metrics are physically Runtime-owned under `runtime/src/telemetry/`. All eight hook implementations and all five Agent modules now live under `runtime/src/hooks/` and `runtime/src/agents/`, all four provider implementations and the Claude turn/tool-surface modules live under `runtime/src/providers/`, all five MCP modules live under `runtime/src/mcp/`, and all Router implementations now live under `runtime/src/router/` except the Control API, which is owned by `runtime/src/control-api/`. Configuration CLI/composition/rendering owners live under `runtime/src/config/`; host/service/file/reconciliation, ensure/restart, and platform state owners live under `runtime/src/platform/`. Runtime's public subpaths are the caller boundary. RuleSync's stable `CODEX_HOME/src/hooks/` dispatch paths and provider/router service paths are materialized from Runtime-owned sources into their established installed paths. The legacy `src/shared/`, `src/telemetry/`, `src/hooks/`, `src/providers/`, `src/mcp/`, `src/agents/`, and `src/router/` implementation directories and superseded installer copy entries are removed; tests exercise workspace exports, installation-manifest closure, stable hook/router/platform install paths, and source-tree path resolution. The obsolete root source tree, root CLI/platform implementations, and copied compatibility implementations are removed; OpenLIT Agents/Prompts/Models sync adapters and singleton bootstrap are Data-owned; host/service/file/reconciliation and ensure/restart implementations have Runtime-owned package exports.

Also complete workspace hygiene:

- declare actual workspace dependencies in each package manifest;
- import `@simulatorlife/autodev-core` / `@simulatorlife/autodev-data` rather than crossing package boundaries through `../src` paths;
- update root lint/format/typecheck/test scripts so all four workspaces are first-class rather than relying on root dependency hoisting or `src/`-only globs;
- remove root dependencies once ownership moves to the appropriate workspace.

#### 2. Complete `console/` as the one real product application

The Console now has an App Router, same-origin server-rendered routes, a
shared shell, and a build/start path. It remains a foundation rather than full
feature parity.

Required cutover includes:

- production deployment and lifecycle integration for the Next.js application;
- canonical 11-route left navigation;
- shared AutoDev design system and styles;
- server-side/same-origin adapters for retained OpenLIT reads and missing Data features;
- URL-addressable resource/detail pages wherever typed Control API or retained-feature APIs exist;
- real loading/error/empty/unknown states;
- real data loading rather than demo/default props;
- no iframe or embedded foreign dashboard surfaces.

Once it reaches parity, retire the older OpenLIT `/autodev/providers`, `/autodev/runtime`, `/autodev/skills`, and `/autodev/mcps` product shell from `02-autodev-pages.patch`.

#### 3. Finish RuleSync canonical ownership

Current RuleSync generation still omits `permissions` and `subagents`, while editable agent-role definitions remain under `agents/roles/*.toml`.

**Pinned-generator verification (RuleSync 16.30.2):** both features are
recognized for the configured targets, but feature availability is not
lossless semantic parity. The subagent/permission schemas and target
projections do not preserve the current role contract, including the
orchestrator role kind, router provider alias, nickname candidates, reasoning
summary, per-role skill enablement/bundling, per-role web-search policy, and
per-MCP `enabled_tools` for Claude and Copilot. The generated
`config/execution-contract.json` also carries runtime-specific provider
delegation/spawn/permission-mode policy that RuleSync does not model.

Generation scope differs by target: Antigravity CLI permissions are global-only
and Copilot permissions are project-only; Antigravity CLI permission generation
targets the user home rather than repository output roots. Enabling both
features now would therefore produce incomplete or non-portable projections.
Keep the current TOML source and generated runtime contract until every
agent-facing field has an explicit owner and deterministic parity is proven
across targets. Do not introduce a second AutoDev schema merely to force these
fields into RuleSync.

Target migration:

```text
.rulesync/
├── subagents/
├── permissions.jsonc
├── commands/
├── skills/
├── hooks.jsonc
└── mcp.jsonc
        │
        ▼
      RuleSync
        │
        ▼
provider-native generated projections
```

After parity is proven:

- remove duplicate editable agent-role authority from `agents/roles/`;
- remove duplicate editable role-prompt authority where RuleSync can represent it;
- keep `config/execution-contract.json` only if useful as a deterministic generated runtime artifact, never as another editable source;
- update tests that currently assert RuleSync permissions/subagents remain deferred.

#### 4. Finish the data/integration layer

Expand `data/` around typed adapters, not a second observability backend:

```text
data/src/
├── rulesync/
├── openlit/
├── usage/
├── memory/
├── evaluations/
├── runtime/
├── tools/
└── configuration/
```

Prefer retained OpenLIT query/storage abstractions to building an AutoDev-specific raw-ClickHouse observability engine.

Clarify Workspace authority as well: scheduler `weights.json` may provide scheduling weight, but should not silently become the complete workspace registry unless it intentionally owns repository identity, base branch, enabled state, configuration health, and related workspace metadata.

### Remaining OpenLIT subtraction

The current OpenLIT patch set is still substantially:

```text
stock OpenLIT
+ AutoDev additions
+ branding/auth changes
```

The target is a reduced AutoDev distribution. Remove dead product code, not only sidebar entries, after dependency verification.

Still to remove/collapse:

- account/user product flows and session assumptions that exist only for OpenLIT's account model;
- Organizations/organisations and membership/switching;
- OpenLIT Projects and project isolation/selectors as user concepts;
- OpenLIT Environments and environment selectors/management;
- Rule Engine UI, APIs, persistence, and runtime coupling;
- OpenGround UI/APIs/stores/persistence;
- GPU dashboard/monitoring product surface (patch 15 removes it from the patched client, and the p21 arm64 image builds; deployed-image confirmation remains pending);
- discovered/instrumented Agent concepts, instrumentation toggles, and related workload-discovery UX (patch 18 removes the source paths; p21 build succeeds, but deployed-image confirmation remains pending);
- generic OpenLIT onboarding/navigation that does not map to the canonical AutoDev product;
- the old additive AutoDev page patch once `console/` replaces it.

OpenLIT login/signup removal and AutoDev branding are already present. Patch 17 removes OpenLIT-session-derived actors from the patched source and delegates actor authorization to the AutoDev Control API single-user/local model from §10; because the standard image lock and running deployment remain on p14, deployed verification is pending. Optional reverse-proxy/SSO authentication may protect remote deployments without restoring an AutoDev account database.

Patch 18 removes the OpenLIT Go Controller/OpAMP/eBPF discovery/instrumentation source tree. Patch 19 removes its image build artifacts, relocates the still-bundled first-party receiver, and keeps the entrypoint shell as PID 1 to supervise, signal, and reap the UI and receiver. Patch 20 removes dead Controller-only message constants, and patch 21 stops creating Controller tables in fresh ClickHouse initialization; it does not purge existing volumes. The full 21-patch series applies and passes the patched client typecheck, eight focused Jest suites (58/58), and an arm64 p21 image build. An isolated p21 container verified bearer auth, trace persistence, and graceful Collector shutdown; deployed receiver acceptance is still open. A local p22 arm64 image now builds, but the standard lock and running container remain at p14. Preserve only useful desired-state/convergence interaction patterns in the TypeScript AutoDev Control API/runtime.

### Remaining telemetry cleanup

The standalone AutoDev Collector binary/provisioner, configuration, launch plist,
and dispatch scripts have been removed. `install-materializer` unloads the old
`com.codex.otel-collector` label, removes its stale plist and installed launcher
copies, and `install-state` migrates a previously saved `collector` selection
once to `direct`. OpenLIT's first-party receiver remains the only supported
Collector infrastructure. Its protected OTLP/HTTP path has a local
trace-through-ClickHouse acceptance test.

The router still has a legacy `direct` ingress on port 4100 in addition to the
opt-in `openlit` ingress on port 4318. Before deleting router OTLP code, separate
live routing/control correlation from historical aggregation:

```text
runtime/src/router/otel.ts
router OTLP endpoints / ingestOtelSignal(...)
config/config.autodev.toml direct-mode OTLP endpoints on 127.0.0.1:4100
```

Remaining telemetry work:

- verify a real Codex/router producer through authenticated OpenLIT ingestion in the deployed stack;
- remove router-owned historical OTLP aggregation, metric series, lookback history, and persistence that OpenLIT now owns;
- remove router OTLP receiver routes and the `direct` mode after its live-control subset is separated;
- remove dead dashboard dependencies such as `chart.js` when no retained code needs them.

Do not remove runtime state merely because it currently lives in the same router
telemetry module; move the small live-control subset first if it is still required.

### Remaining Control API and reconciliation work

Current reads cover:

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

Provider-role enablement is the main fully implemented mutation. The target requires typed mutation/reconciliation flows for RuleSync-owned and runtime-owned resources where editing is supported.

For RuleSync-owned changes:

```text
Console
  ↓
Control API
  ↓
edit canonical RuleSync source
  ↓
validate
  ↓
RuleSync generate
  ↓
apply
  ↓
observe runtime
  ↓
converged | pending | error
```

Use a reusable desired/actual state contract with at least:

```text
desired state
actual state
desired generation
observed generation
diff
convergence status
last apply
last observation
last error
operation history
```

`Tools` remains primarily a composite read model rather than another mutation authority. Memory and Evaluations may retain/adapt their own OpenLIT TypeScript APIs where appropriate.

### Remaining retained-feature integrations

The following selected OpenLIT capabilities are still mostly placeholders in the new Console and need real integration:

**Memory**

- real connector-backed records/search/write/copy behavior;
- source/connector and workspace/agent scope;
- activity/history where available;
- no organization/project/environment tenancy dependencies.

**Evaluations**

- evaluation definitions/suites;
- runs/results/history;
- prompt/agent/model targets;
- trace linkage and comparisons;
- rerun actions;
- no Rule Engine or OpenGround prerequisite.

**Prompts**

- RuleSync remains canonical;
- add edit, validate, save, version/diff, preview, generate/apply;
- link prompt versions to usage, traces, and evaluations;
- do not create an independent OpenLIT prompt authority.

**Usage**

- replace all sample/default metrics with live OpenLIT data;
- retain logical-request versus physical-attempt semantics;
- add real time/workspace/provider/model/role/skill filters;
- connect request/token/cache/cost/latency/failure/MCP/skill metrics to retained query infrastructure.

**Tools**

- build the effective catalog across native tools, MCP tools, plugin/provider capabilities, permissions, runtime availability, and telemetry;
- expose role eligibility, health/availability when known, use/error counts, and trace linkage.

### Ordered migration sequence

Use this order unless a dependency requires a narrower prerequisite slice:

1. **Eliminate duplicate Console architecture:** make `console/` the canonical UI and stop expanding the old OpenLIT AutoDev pages.
2. **Make Console runnable:** add Next.js routing/build/start, the shared design system, same-origin adapters, and real data loading; remove fake/default state.
3. **Finish RuleSync ownership:** migrate subagents/roles and permissions, generate provider projections, and remove duplicate editable authorities.
4. **Finish workspace boundary hygiene (physical migration complete):** keep implementation within `console/`, `runtime/`, `core/`, and `data/`; close dependency/import leaks, maintain package contracts, and do not restore the removed root `src/` tree.
5. **Complete OpenLIT product subtraction:** remove accounts/session product assumptions, Organizations, Projects, Environments, Rule Engine, OpenGround, GPU, discovered/instrumented Agents, and obsolete onboarding/navigation.
6. **Complete telemetry cleanup (standalone Collector removal done):** verify a real Codex producer through authenticated OpenLIT ingestion, separate live-control correlation from historical router state, then delete the router-owned history backend, receiver routes, and legacy `direct` mode.
7. **Complete the Data layer:** integrate OpenLIT/Usage/Memory/Evaluations/runtime/tools without recreating a parallel observability backend.
8. **Implement real mutation and reconciliation:** desired/actual generations, diff, pending/error state, apply/history across mutable resources.
9. **Implement the selected reference-project interaction patterns** from §14 inside the one AutoDev TypeScript UI.
10. **Finish retained OpenLIT feature integration:** Memory, Evaluations, Prompts, Usage, trace/resource linkage.
11. **Delete transitional synchronization and compatibility paths:** reassess the Data-owned OpenLIT projection syncs, the root singleton workspace bootstrap, old proxies/facades, obsolete patches, and dead dependencies once their consumers are gone.
12. **Keep repository hygiene current:** close or supersede deeply stale/diverged migration PRs and branches rather than treating them as permanent backlog.

## 13. Operational entry points

Current local stack lifecycle:

```bash
bash scripts/openlit/up.sh
bash scripts/openlit/down.sh
```

Run the AutoDev Console independently while the old OpenLIT UI still occupies
port 3000:

```bash
pnpm --filter @simulatorlife/autodev-console dev
pnpm --filter @simulatorlife/autodev-console build
pnpm --filter @simulatorlife/autodev-console start
```

The Console defaults to port 3300 (`AUTODEV_CONSOLE_PORT` overrides it). Set
`AUTODEV_CONTROL_API_TOKEN` only in the Console server environment; the
Control API base defaults to `http://127.0.0.1:4101` and can be configured with
`AUTODEV_CONTROL_API_BASE_URL`. To query Usage, set
`AUTODEV_OPENLIT_USAGE_TOKEN` in the Console server environment to the
separately generated value in `$CODEX_HOME/openlit-secrets.env`;
`AUTODEV_OPENLIT_USAGE_URL` defaults to `http://127.0.0.1:3000`. The Console
Memory portal links to the retained OpenLIT Memory page using the separately
configured, browser-reachable `AUTODEV_OPENLIT_UI_URL` (same local default); it
is not used as a service API credential or forwarded to the Control API. Do not
source or expose the full secret file to browser code.

The two Console server-only tokens are seeded into the server environment by
exactly one writer: `scripts/openlit/bootstrap-secrets.sh`, which is the same
script that populates `$CODEX_HOME/openlit-secrets.env` and is invoked from
`scripts/openlit/up.sh`. It writes the canonical secret file outside the
repository and additionally materializes a mode-0600 `console/.env.local`
that Next.js auto-loads on every server-side request from the `pnpm`
Console workflow. That file carries only the two Console-required server
credentials plus their non-secret local base URL defaults; the OpenLIT
database password and the OTLP receiver token are deliberately not
included. The launchd-managed Console path does not depend on
`console/.env.local` — `scripts/run-codex-console.sh` reads the canonical
secret file via an exact-key parser and exports only the two tokens
needed by the Next.js server.

Current out-of-band OpenLIT projections:

```bash
pnpm --filter @simulatorlife/autodev-data openlit:sync-prompts
pnpm --filter @simulatorlife/autodev-data openlit:sync-agents
pnpm --filter @simulatorlife/autodev-data openlit:sync-models
pnpm --filter @simulatorlife/autodev-data openlit:sync-workspaces
```

The Data-owned agents, prompts, and models adapters populate OpenLIT read models; they do not supersede canonical RuleSync/AutoDev configuration ownership. The remaining workspace bootstrap is only an internal singleton migration, not a per-workspace OpenLIT tenancy adapter.

The asynchronous GitHub issue metrics workflow remains a separate GitHub-development reporting surface (`.github/workflows/metrics-dashboard.yml`, issue #2). It is not a replacement observability backend for AutoDev runtime telemetry.

## 14. Reference projects and remaining integrations

Use these projects as **interaction/architecture references**, not as embedded applications. Reimplement/adapt the useful patterns inside AutoDev's shared TypeScript/TSX component system.

| Project              | AutoDev use                                                                                                      | Current gap                                                                                                                                 | Remaining adaptation                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenLIT**          | telemetry/storage/query foundation plus retained Memory, Evaluations, Usage, and useful Prompt/Agent UI patterns | Backend foundation is present, but the retained product features are not yet wired into the new Console and unwanted product modules remain | Reuse/query retained infrastructure; integrate Memory/Evaluations/Usage/Prompt behavior; subtract accounts/tenancy/Rule Engine/OpenGround/GPU/discovery UX                                          |
| **LiteLLM**          | provider/model/routing/MCP control patterns                                                                      | AutoDev currently has only limited provider-role mutation and basic provider/model views                                                    | Add provider/model availability, priority, fallback order, concurrency, limits, cooldown/circuit health, effective routing, and usage/health detail under Agents/resource detail views              |
| **LangWatch**        | unified control + observability resource UX                                                                      | Console list pages largely separate configuration from runtime evidence                                                                     | Compose configuration, actual health/state, requests/tokens/cost/failures/latency, and recent traces on the same Agent/provider/MCP/skill/workspace pages                                           |
| **MCPJam Inspector** | MCP inspection/debugging                                                                                         | AutoDev MCP UI is mainly server + role exposure                                                                                             | Add connection/probe state, Tools, Resources, Prompts, schemas, read/preview operations, diagnostics, activity, authorization/config context, and error/log views                                   |
| **Unleash**          | scoped capability enablement                                                                                     | Skills/MCP capability scope is mostly display-only and often falls back to broad defaults                                                   | Add explicit enabled state, agent-role/workspace targeting, constraints, effective state, and clear configured/eligible/observed distinctions                                                       |
| **Argo CD**          | desired/live state and convergence                                                                               | AutoDev has convergence types but not a robust reconciliation/diff model                                                                    | Add desired vs actual, generations, diff, health, pending/applying/error, last apply/observation, and operation history across mutable resources                                                    |
| **Backstage**        | lightweight modular frontend composition                                                                         | `ConsoleApp` still centralizes feature switching                                                                                            | Add a small typed feature/route registry so each Console feature contributes route/nav/component/data requirements without creating separate packages or adopting Backstage's full plugin framework |

### Provider/model/routing detail

Provider/model configuration remains secondary to Agents rather than new top-level navigation.

Target resource detail should combine:

```text
Configuration                  Runtime / Observability
────────────────────           ─────────────────────────
Enabled                        Health / circuit state
Allowed agent roles            Requests
Models                         Tokens
Priority / routing             Cost
Fallbacks                      Failure rate
Concurrency / limits           Latency
Cooldown                       Recent traces
```

Model detail should surface provider, availability, role eligibility, relevant capabilities/context metadata, pricing where used, usage, failures, and routing position.

### MCP detail

Target MCP server detail:

```text
Overview
Configuration
Connection / Health
Tools
Resources
Prompts
Role Access
Activity
Errors / Logs
```

Useful operations include ping/test, list tools, inspect schemas, list/read resources, list/preview prompts, inspect effective authorization/configuration, and view recent calls/errors.

### Scoped capability targeting

For Skills and other capability assignments, keep configuration state distinct from runtime evidence:

```text
Enabled
   ↓
Eligible for role/workspace
   ↓
Selected / Exposed
   ↓
Injected
   ↓
Used
```

Do not infer one stage from another. Use Unleash-style targeting/constraint UX only as an interaction model; RuleSync remains the canonical configuration source.

### Modular Console composition

The Console remains one application and one package. If central routing becomes
unwieldy, use a lightweight typed feature/route registry such as:

```ts
interface ConsoleFeature {
  id: CanonicalNavSection;
  route: string;
  component: React.ComponentType;
}
```

Do not turn each feature into a package merely to achieve modularity.

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

### Migration/cutover

- `console/` is a runnable TypeScript/Next.js product, not only render-test components;
- no production Console view relies on hard-coded sample usage/health/convergence data;
- cross-workspace imports use declared workspace package contracts rather than reaching into sibling `src/` trees;
- `runtime/` owns migrated implementations directly; no permanent re-export facade into legacy root `src/`;
- every migrated legacy `src/` slice is deleted after parity;
- RuleSync `subagents` and `permissions` are enabled only after lossless parity, then duplicate editable authorities are removed;
- old OpenLIT AutoDev pages are removed once the unified Console replaces them;
- a real Codex producer is verified through authenticated OpenLIT ingestion before router historical OTLP aggregation/receiver paths are deleted;
- retained live runtime/control state is separated from historical observability before deleting legacy telemetry modules;
- obsolete OpenLIT sync jobs, patches, endpoints, and dependencies are removed once they have no consumers;
- current `main` receives visible CI/workflow evidence for the monorepo and OpenLIT acceptance gates.

### Resource-state correctness

- missing data renders `unknown`/`not observed`/`unavailable`, never synthetic success;
- desired and actual state have independent provenance;
- convergence is computed from observed generations/state rather than config presence;
- health reflects a real runtime probe or authoritative observed state;
- configuration does not count as runtime use;
- tool/skill/MCP exposure does not count as execution;
- Usage widgets contain no production fallback/demo values.

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
