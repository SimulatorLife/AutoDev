# AutoDev Console Target State

> **Authority:** This is the single living source of truth for the AutoDev Console product model, OpenLIT fork boundary, observability/control architecture, RuleSync ownership, shared UI/design requirements, and acceptance contract.
>
> **Current implementation state:** [autodev-console-migration.md](autodev-console-migration.md).
>
> **Operational setup:** [local-setup.md](local-setup.md).
>
> **Focused Memory design:** [memory-target-state.md](memory-target-state.md) and [memory-injection-outcome-evaluation.md](memory-injection-outcome-evaluation.md).
>
> **Last reviewed:** 2026-10-09 (Usage trace drill-down, canonical filter axes, request-time OpenLIT rendering, and compact-navigation dismissal behavior).

## 1. Canonical-document contract

Changes that alter Console product behavior, OpenLIT ownership, telemetry/control boundaries, RuleSync authority, resource semantics, UI behavior, or acceptance requirements must update this document in the same PR.

Keep these concerns separate:

- **This document:** durable target-state requirements and architectural decisions.
- **autodev-console-migration.md:** observed current state, current gaps, cutover ordering, and current acceptance evidence.
- **local-setup.md:** commands, ports, environment variables, secrets materialization, and local/runtime operating instructions.
- **Focused subsystem docs:** detailed subsystem design that does not redefine shared product/ownership rules.

Update decisions in place. Do not preserve competing active plans. If a focused document conflicts with this document on shared Console, OpenLIT, RuleSync, observability, or control-plane behavior, this document is authoritative.

Implementation history that is no longer relevant to the current state belongs in Git/PR history, not in the target requirements.

## 2. Product target

Build a **single-user AutoDev control and observability console** as a deliberately reduced product built on useful OpenLIT infrastructure.

The final product is **AutoDev Console**, implemented by the root console/ Next.js application. OpenLIT remains an implementation foundation for OTLP ingestion, ClickHouse storage/querying, and selected reusable capabilities/components. It is not a second user-facing application in the target state.

The product should look and behave like a small purpose-built AutoDev operator console that happens to reuse OpenLIT infrastructure, **not** like a customized general-purpose OpenLIT installation.

### Canonical resource surface

The canonical top-level resources are:

~~~text
Configure
├── Agents
├── Providers
├── MCPs
├── Skills
├── Hooks
├── Prompts
├── Permissions
└── Tools

Observe
├── Usage
├── Evaluations
├── Playtesting
└── Memory

Operate
├── Workspaces
└── GitHub
~~~

The grouping is presentation only; all **14 resources** have first-class routes. **Playtesting** is the Observe resource at `/playtesting`; its detailed requirements are in [Playtesting Target State](playtesting-target-state.md).

There is no required generic Home/Dashboard page. The root route should redirect to a useful canonical resource rather than introduce an additional generic surface that duplicates Usage, runtime status, or GitHub activity.

Use **Workspaces**, not OpenLIT Projects, for AutoDev repositories/workspaces. OpenLIT project/environment/organization/account tenancy must not reappear under different names.

**Providers** is a top-level Configure resource in the Console navigation, listed directly after Agents. It is the canonical surface for model providers (for example Claude, Codex, Copilot, Antigravity, and MiniMax) and their models: per-role priority and model assignment across the four fixed roles (Default, Smart, Orchestrator, Subagent), provider-wide concurrent-agent limits with an Unlimited option, a provider-level disable that preserves its configuration, routes, and live readiness, health, cooldown, and failure state. Models is a tab inside Providers, not another top-level resource. Agents shows each role's effective provider/model eligibility as a read-only summary that links to Providers. Historical provider/model observability remains in **Usage**.

Configuration, desired state, actual runtime state, health, activity, and historical telemetry should be composable on the same resource pages while remaining separate architectural data/control paths.

## 3. Product and UI simplicity contract

UI simplicity is a product requirement, not merely a styling preference.

AutoDev Console is an operator console, not a general AI platform, generic observability workbench, documentation portal, chat application, dashboard builder, or multi-tenant SaaS shell.

### One application and one design system

- Use one React/Next.js shell and one shared TypeScript/TSX design system.
- All AutoDev-owned Console application/control code is TypeScript/TSX.
- Do not iframe, embed, or visually stitch together OpenLIT, LiteLLM, MCPJam, LangWatch/Langfuse, Unleash, or other dashboards.
- Reuse/adapt useful TypeScript components and interaction patterns into the shared AutoDev system instead of preserving foreign application shells.
- One resource should look and behave consistently regardless of whether its data originates in RuleSync, the Control API, OpenTelemetry/OpenLIT, MemoryService, GitHub, or evaluation storage.
- Non-TypeScript infrastructure may remain underneath the product (for example ClickHouse and the OTel receiver), but no second AutoDev-facing application/runtime should be introduced.

### Dark-only visual system

The AutoDev Console has **one dark visual theme**.

Do not ship a theme feature:

- no light theme;
- no Light/Dark/System selector;
- no theme toggle;
- no prefers-color-scheme product behavior;
- no product-level theme persistence;
- no parallel light chart palette or page-specific light styling.

Use a small semantic dark token set for background, elevated surface, input/card surface, hover/selected surface, border, primary/secondary text, accent, success, warning, error, and chart series.

Prefer adapting OpenLIT's useful dark styling/components where they fit. Remove dead light-theme assets/tokens after dependency verification. A third-party primitive may internally carry unused theme code, but AutoDev must not expose or maintain light mode as a product capability.

### Page structure and density

Prefer a small number of consistent page templates:

- resource list/table;
- resource detail;
- configuration form/panel;
- scoped observability/activity view.

Prefer dense tables, compact status summaries, tabs, drawers/sheets, and inline actions over large hero cards, decorative dashboards, nested wizards, or bespoke page layouts.

Advanced diagnostics belong in secondary tabs/drawers unless they are the page's primary purpose. Charts belong primarily on Usage/history/observability surfaces; inventory/configuration pages should not become mini dashboards merely because telemetry exists.

Shared primitives must cover at least navigation, page headers, breadcrumbs/context where needed, filters, tables, tabs, stat summaries, charts, status badges, forms, dialogs/drawers, empty/loading/error/unavailable states, permission matrices, activity/history, and code/config editors.

At narrow widths, navigation defaults to the compact rail; expanding it overlays rather than compresses page content. Selecting a destination or pressing Escape collapses the expanded navigation, while modified link-open gestures leave the current view state unchanged.

Table columns declare a relative width weight, never an absolute CSS length. The shared table resolves weights to percentages of its own width, so a table fills its container instead of overflowing the page. The table keeps a minimum width equal to the widest declared weight total: below it the table region scrolls horizontally rather than shrinking columns under the budget their content was measured for. Column headers wrap at word boundaries rather than truncating, and a single-word header that still cannot fit breaks rather than hiding which column it labels. A column's weight must be large enough for its own header: a header that renders as an ellipsis is a layout defect, not acceptable truncation. Discrete cell content (chips, badges, model ids, environment variable names) stays atomic and wraps between items, never mid-token; flowing prose wraps on word boundaries and is clamped; single-value cells truncate with the full value reachable on hover.

### One canonical edit surface

Every domain concept has one canonical editable surface. Other pages may show a compact read-only summary and link to that surface.

| Concern | Canonical edit surface | Other surfaces |
| --- | --- | --- |
| Agent definition | Agents | scoped effective summaries |
| Per-role priority and model assignment for Default/Smart/Orchestrator/Subagent, provider-wide agent limits, provider enable/disable, model enablement, priority/fallback groups, per-tier models, routing | Providers (Providers and Models tabs) | read-only effective provider/model summaries on Agents |
| MCP configuration | MCPs | read-only role/tool summaries |
| Skill definition/enablement | Skills | read-only assignments/evidence |
| Hook configuration | Hooks | read-only effective status |
| Prompt/command content | Prompts | read-only assignment/version summary |
| Permission policy | Permissions | effective matrices/summaries |
| Tool configuration | originating MCP/runtime/plugin owner | Tools is a composite catalog |
| Memory lifecycle/configuration | Memory | read-only links/summaries elsewhere |
| Evaluation definitions/actions and source-owned verdict history | Evaluations | related result summaries elsewhere |
| Gameplay playtest execution, episode evidence, session analysis, comparative findings, human-validation results | **Playtesting** | derived batch-level evaluation assertions in Evaluations when explicitly emitted; trace/cost links in Usage |
| Workspace configuration | Workspaces | workspace badges/scope links |
| GitHub workflow catalog and Actions runtime state | GitHub (read-only; workflow definitions remain repository-owned) | read-only workflow/run links elsewhere |
| Historical telemetry | Usage | small scoped summaries with links to Usage |

Do not duplicate provider, routing, permission, prompt, MCP, tool, skill, or workspace controls across several resources for convenience. Showing an item's control on its own list row and in its own detail view inside the owning resource is required by the contextual-controls rule below; it is not duplication.

### Contextual controls

Controls live with the item they act on. There is no separate settings, admin, or control page for state that belongs to a listed item.

- An item's enable/disable toggle and other item-scoped actions appear on that item's row or card in its resource list view **and** in that item's detail view. The toggle that disables a model provider sits on that provider's row in Providers and in that provider's detail view; the toggle that enables or disables a model sits next to that model in the Models view and in that model's detail view.
- When a detail view lists child items, each child row carries its own controls; a provider's detail view lists its models with their model toggles.
- Each rendering of a control uses the same typed Control API operation and the same current, pending, and could-not-be-confirmed states. A list control and a detail control are one shared component, not two implementations.
- Pages outside the owning resource show the item's state read-only and link to it; they do not embed its controls.
- When an item's state cannot be changed (for example a read-only source, a missing credential, or unobserved state), the control stays in place, disabled, with the reason, rather than disappearing.

### State correctness

Missing evidence must remain explicit:

~~~text
unknown
not observed
unavailable
pending
error
~~~

Never synthesize ready, converged, healthy, connected, zero, or success merely because configuration exists or telemetry is absent.

Configuration does not prove runtime availability. Eligibility/exposure does not prove execution. Historical tool use does not define current permissions.

### Accessibility and interaction consistency

- A safe, reversible single-choice setting applies as soon as the operator changes its select. Do not place a second Apply/Save control beside one selection; submit the complete owning form through its existing route.
- Keep explicit Apply/Save only when the operator is deliberately staging a coherent group: multiple filter axes applied as one URL state, a multi-select/checkbox set, a preview/validation step, or a consequential action that needs review or confirmation. Make the staged boundary clear; do not stage a lone workspace/scope choice.
- Visual hierarchy is explicit per interaction group: within any toolbar, form, row, or dialog that offers more than one action, exactly one renders with the highest-emphasis style; secondary and destructive actions use lower-emphasis or outline styles, and heading levels track page > section > item nesting rather than decorative sizing. A page is not required to carry a primary action merely because it has content.
- Immediate mutations stay server-authoritative: do not claim success optimistically. The refreshed control value is the confirmed state, and an unconfirmed or failed write must produce an accessible, actionable notice.
- System status is shown adjacent to the control or resource it describes, not centralized on an unrelated page. Asynchronous actions that remain in place show a visible pending state and announce it accessibly until completion. Changing or submitting any Console form or control must not cause a full document reload: safe single-choice controls auto-apply and explicit grouped Apply/Save where intentional are kept, but all GET filters and POST mutations use in-place client navigation/update while preserving URL state and server-confirmed feedback. In-place requests provide visible pending feedback during execution, preserve keyboard focus and visible focus states, and show Runtime-confirmed values or an accessible, actionable failure notice when confirmation fails.
- Every control keeps a persistent accessible name, keyboard operation, visible focus, and a reason when disabled. Auto-submit must work for keyboard selection as well as pointer input; never rely on color, hover text, or position alone.
- Prefer recognition over recall: operators choose from visible, labeled, searchable lists, dropdowns, and breadcrumbs instead of memorizing resource IDs, slugs, or command syntax, and a form shows the currently effective or previously entered value rather than requiring the operator to recall it from elsewhere.
- Keep labels, controls, and their state feedback in one aligned group. At phone widths, controls wrap or scroll within their owning region rather than hiding the action or breaking the relationship between a label and its value.
- Core workflows must be operable at both phone and desktop widths. Navigation and primary content may reflow into a single scrollable column, and secondary detail may progressively disclose into drawers or tabs, but all controls needed for core workflows remain reachable without hover- or pointer-only access.
- Use consistent keyboard/focus behavior and visible focus states.
- Preserve WCAG 2.1 AA contrast (>= 4.5:1 for text, >= 3:1 for large text and UI component boundaries) in the dark-only palette; enforced by the `contrastRatio` assertions in [`tests/autodev-console-target-state.test.ts`](../tests/autodev-console-target-state.test.ts) (test: "Console semantic text and status surfaces meet WCAG AA contrast").
- Use the same status vocabulary, icon sizing, spacing, table density, dialog behavior, and destructive-action confirmation patterns across features.
- Spacing follows shared context tokens: `PageBody` owns the page-section rhythm, related sibling blocks reuse it, and shared panel/heading components own common surface padding and heading offsets. Do not hand-roll these shared relationships in individual views; denser spacing within controls and rows remains context-specific.
- URL-addressable list/detail/filter state is preferred when it improves operator navigation and debugging.
- Internal resource and tab links use Next.js in-place navigation, not full-document reloads; they remain ordinary URL-addressable anchors for keyboard access, bookmarking, sharing, and browser history. Full dynamic-route prefetch starts only on pointer, touch, or keyboard intent, never for every visible view or tab.
- Dynamic routes show the active Console shell and an accessible loading placeholder while server-owned page data is pending; the final page replaces it with Runtime-confirmed content and counts.

## 4. Repository and module architecture

AutoDev is a **small, flat pnpm TypeScript monorepo**. Do not introduce apps/, packages/, or modules/ wrappers merely to classify code, and do not create a package per navigation resource.

~~~text
AutoDev/
├── console/                 # unified Next.js AutoDev UI
├── runtime/                 # router, providers, agents, MCP runtime, hooks, Control API
├── core/                    # shared domain contracts and pure business logic
├── data/                    # RuleSync/OpenLIT/ClickHouse/config/persistence adapters
├── .rulesync/               # canonical agent-facing configuration
├── config/                  # portable runtime/deployment configuration
├── .github/                 # CI and GitHub automation
├── docs/
├── scripts/
├── tests/
├── package.json
├── pnpm-workspace.yaml
└── rulesync.jsonc
~~~

The four code workspaces are the intended durable boundaries:

| Module | Owns |
| --- | --- |
| console/ | the single AutoDev UI, shared design system, navigation, and feature folders |
| runtime/ | long-running execution, provider/router behavior, agents, MCPs, hooks, runtime health, reconciliation, Control API |
| core/ | infrastructure-independent domain types/contracts and pure rules |
| data/ | typed adapters/repositories for RuleSync, OpenLIT/ClickHouse, Memory, evaluations, workspace/configuration, and other persistent/external boundaries |

Inside console/, keep navigation resources as feature folders, including github/. Do not create agents/, skills/, mcps/, prompts/, etc. as separate packages merely because they are top-level UI resources.

Dependency direction:

~~~text
console ───────┐
               ├──> core
runtime ───────┤
               │
console ───────┐
               ├──> data ───> core
runtime ───────┘

core ──> no AutoDev module
~~~

Rules:

- core/ remains infrastructure-independent.
- core/ owns shared Control API request contracts used by Runtime and Console; each boundary
  retains its own validation, authorization, and transport.
- data/ adapts external/canonical sources; it does not become another source of truth.
- runtime/ is the mutation/reconciliation authority.
- console/ never bypasses the Control API to mutate canonical/runtime state.
- console/ owns the shared UI library until a real second UI consumer exists.
- shared producer telemetry stays under runtime/src/telemetry/ unless multiple independent producers justify extraction.
- .rulesync/, config/, .github/, and docs/ remain root concerns, not software workspaces.
- all four code workspaces share root formatting/lint/test/TypeScript policy.

## 5. Architecture and ownership

### Observability plane

~~~text
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
      ├── Usage
      └── resource-level historical analysis
~~~

Use standard OpenTelemetry traces, metrics, and logs. Prefer official GenAI/MCP semantic conventions. Add a minimal autodev.* namespace only where no suitable standard exists.

Do not restore an AutoDev-owned historical aggregation database, general-purpose telemetry query backend, compatibility dashboard, or pass-through Collector. Add another Collector only for a documented need such as pre-export redaction, routing, or fan-out.

### Control plane

~~~text
AutoDev Console
      │ same-origin server path
      ▼
AutoDev Control API
      │
      ├── canonical configuration mutation
      ├── validation/generation/apply
      ├── desired-state reconciliation
      └── runtime/status reads
~~~

OTLP and telemetry queries are observation-only. Never use telemetry as a command/configuration channel.

Mutable resources expose desired and actual state separately:

~~~text
canonical desired configuration
          ↓
validated apply / queued action
          ↓
runtime/controller
          ↓
observed actual state
          ↓
converged | pending | error
~~~

The reusable reconciliation contract should include desired state, actual state, desired generation, observed generation, diff, convergence status, last apply, last observation, last error, and operation history.

Use desired/live/convergence interaction semantics similar to Argo CD where useful, but implement them through AutoDev Runtime/Control API rather than shipping OpenLIT's Controller daemon.

## 6. RuleSync and configuration authority

Use the pinned RuleSync tool as the source of truth for every agent-facing configuration surface it can represent **losslessly**.

RuleSync-owned concerns include, as supported:

- rules/instructions;
- commands and prompt assets;
- subagent/agent-role definitions;
- Agent Skills and supporting files;
- MCP declarations and target-specific overrides;
- hooks;
- permissions/tool capability policy.

RuleSync source files are authoritative. Provider-specific Codex/Claude/Copilot/Antigravity outputs are generated projections.

OpenLIT Prompt/Agent/MCP/Skill views are read models, not configuration databases.

For a RuleSync-owned mutation:

~~~text
Console
  ↓
Control API
  ↓
canonical RuleSync source
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
~~~

Preserve target-specific overrides. Do not invent another AutoDev configuration schema merely to force unsupported semantics into RuleSync.

AutoDev-specific runtime state that RuleSync does not model—provider credentials, live health, pricing/catalog facts, routing/cooldown/concurrency state, scheduler/runtime policy—remains owned by typed AutoDev configuration/runtime APIs.

Conceptually:

~~~text
Desired agent configuration  ← RuleSync sources
Generated provider configs   ← RuleSync projections
Actual runtime state         ← Runtime / Control API
Historical behavior          ← OpenTelemetry / OpenLIT
~~~

Lossless RuleSync subagent/permission parity is a migration gate, not an assumption. Current parity details belong in the migration tracker.

## 7. OpenLIT fork boundary

OpenLIT is retained as infrastructure and a source of useful components/patterns. Do not preserve generic OpenLIT product features merely because they already exist. The retained OpenLIT server renders URL-filtered telemetry pages at request time; its image build must not statically prerender routes that consume search state.

### Keep/adapt

Retain or adapt:

- OpenTelemetry/OTLP ingestion;
- ClickHouse telemetry storage and generic query plumbing;
- trace, metric, and log querying/exploration;
- GenAI usage/cost foundations;
- time-range, chart, widget, trace, table, filter, status, form, dialog, and detail primitives that fit the AutoDev design system;
- telemetry query/source abstractions;
- Memory connector/domain capabilities and useful Memory UI components;
- Evaluation definitions/results/history capabilities that remain independent of removed product concepts;
- Prompt Hub browsing/edit/version/diff/preview interaction patterns while RuleSync remains canonical;
- useful Agent presentation patterns, but not OpenLIT discovery/instrumentation semantics;
- desired/live/convergence interaction patterns, reimplemented through AutoDev Runtime/Control API.

The retained OpenLIT Memory page may exist only as a **temporary migration bridge**. The final Memory operator surface lives inside console/ and uses the same shell/design system as every other AutoDev resource.

### Remove from the AutoDev product/distribution

These are out of scope, not merely hidden navigation:

- **Accounts/users/auth product flows:** login/register UI, OAuth account buttons, profiles, invitations, membership, logout/account menus, account-scoped preferences, and application user-management. /login and /register must not remain interactive product routes; remove them or redirect them to the canonical Console entry. Auth middleware must not recreate an OpenLIT application-account gate.
- **Organizations/organisations:** entities, membership, switching, organization-scoped permissions/navigation.
- **Environments:** OpenLIT environment product selectors/management.
- **Projects:** OpenLIT project management/isolation/selectors. AutoDev Workspaces are not tenancy silos.
- **Rule Engine:** UI, API/runtime evaluation flow, product integration, linked-entity workflow, and fork-owned persistence once no retained capability depends on it.
- **OpenGround:** playground/evaluation-comparison product, routes, stores, APIs, and fork-owned persistence.
- **GPU dashboard/monitoring product surface.**
- **OpenLIT agent discovery/instrumentation and Controller daemon:** discovered/instrumented statuses, service discovery, instrumentation toggles, eBPF/SDK injection, OpAMP/Controller product flows.
- **Otter/chat:** chat routes, chat history/settings/usage, floating/sidebar chat entry points, Otter-only resource-management tools/APIs/stores, AI-analysis affordances that require Otter, and its provider/model configuration. If AutoDev later adds natural-language console administration, it must use AutoDev agents plus typed Control API operations rather than resurrecting Otter.
- **Documentation/help/community/marketing product chrome:** Documentation, Community/Slack, blog, getting-started marketing links, feedback/promotional navigation, and generic external product links. Focused contextual links to repository/operator docs remain allowed.
- **Generic dashboard/board authoring:** keep chart/widget/query primitives needed by AutoDev Usage, but remove the generic user-programmable dashboard product and arbitrary dashboard/widget creation workflows.
- **Arbitrary raw SQL/query-builder UI** unless a specific approved AutoDev diagnostic requires it. Browser users never receive a general telemetry SQL endpoint.
- **Generic Vault/secrets/model administration UI** where AutoDev's provider/runtime configuration owns the same concern. Do not create a second credential/model authority.
- **Theme switching/light theme:** no theme selector or light-theme product path.
- **Generic onboarding, sample/demo data, quickstarts, “create your first…” flows, and removed-feature setup pages.**
- **Multi-user collaboration/share/team affordances** with no single-user AutoDev purpose.
- **Redundant Settings pages** superseded by canonical resource pages.
- **Update/changelog/marketing popovers** that do not serve an operator requirement.
- old additive OpenLIT AutoDev pages after console/ reaches parity.

Delete dead routes, components, stores, APIs, migrations, assets, and dependencies after dependency verification. Do not keep permanently disabled compatibility code.

If a retained OpenLIT internal schema temporarily needs singleton user/organisation/project/environment rows, treat them strictly as hidden implementation details and remove the dependency when practical.

### AutoDev branding

All user-facing product wording in the AutoDev distribution says **AutoDev**, not OpenLIT: metadata, sidebar brand, headings, descriptions, onboarding/error text, SDK labels, placeholders, and visible status output.

Do not rename internal identifiers solely for branding when that would create protocol/storage/upgrade churn. Existing OpenLIT ClickHouse table names, compatibility environment variables/headers, local-storage keys, internal TypeScript types, CSS classes, OTel attributes, comments, or file names may remain where technically useful and invisible to the product contract.

### Workspaces replace tenancy

Repositories/workspaces remain privacy-safe telemetry/configuration dimensions, for example autodev.workspace, so data can aggregate globally and filter/group by workspace.

Do not create one OpenLIT account, organization, project, or environment per AutoDev workspace.

## 8. Component reuse and reference projects

Reuse should reduce custom UI code without importing foreign product structure.

Prefer in this order:

1. adapt an existing OpenLIT component that cleanly fits the AutoDev design system;
2. reuse/adapt a small compatible component from another permissively reusable source;
3. reproduce a proven interaction pattern in AutoDev components;
4. write new bespoke UI only when the domain requires it.

Before copying third-party code, verify the source revision, license/attribution requirements, dependency cost, and compatibility. Normalize reused components to AutoDev tokens, status vocabulary, accessibility, and APIs. Do not vendor an entire frontend framework/application to obtain a few controls.

| Reference | Reuse/adapt | Do not inherit |
| --- | --- | --- |
| **OpenLIT** | dark styling where useful; tables, filters, time range, charts/widgets, trace/detail patterns, Memory/Evaluation/Prompt/Agent components | generic product shell, Otter, docs/community chrome, auth/tenancy, generic dashboards, light theme, onboarding, removed modules |
| **Langfuse** | dense list/detail UX, trace inspection, filters, prompt version/diff interaction, compact observability patterns | organization/project/account SaaS hierarchy |
| **LangWatch** | composing configuration, runtime evidence, usage, failures, latency, and recent traces on one resource surface | a separate embedded observability application |
| **Helicone** | semantic visual tokens, consistent typography/layout, compact request/log detail patterns | gateway/business-account product model |
| **MCPJam Inspector** | MCP Tools/Resources/Prompts inspection, schemas, test/probe diagnostics, logs | playground/emulator shell |
| **LiteLLM** | provider/model/routing semantics: priority, fallback, concurrency, limits, cooldown/circuit state | inconsistent or duplicate dashboard styling; use as control-semantics reference, not the visual source of truth |
| **Agno Agent UI** | compact tool-call/activity/status presentation patterns where useful | chat-first application shell |
| **Argo CD** | desired/live diff, health, sync/convergence, operation history | Kubernetes/product IA |
| **Unleash** | scoped capability targeting/constraints/effective-state interaction | feature-flag product model |
| **Backstage** | lightweight feature/route registry idea if central routing becomes unwieldy | full plugin/platform framework |

The Console remains one application/package. A lightweight typed feature registry may organize routes/nav/components, but each feature does not become a package.

## 9. Resource contract

| Resource | Primary authority | Target surface |
| --- | --- | --- |
| **Agents** | RuleSync + Runtime | role definition, read-only effective provider/model eligibility, desired/actual state, health, activity |
| **Providers** | typed AutoDev routing configuration + Runtime + OTel | provider and model catalogs; a single four-column configuration table (Provider, Status, Roles, Agent Limits); per-role priority/model assignment across Default, Smart, Orchestrator, Subagent; provider-wide agent limits with Unlimited; provider-level disable preserving configuration; model enablement, priority/fallback groups, per-tier models, credential presence (never values), readiness/health, cooldown/failure state, in-flight load, links to Usage |
| **MCPs** | RuleSync + Runtime + OTel | server configuration, role exposure, Tools/Resources/Prompts, connection health, usage/errors |
| **Skills** | RuleSync + OTel | canonical definitions, role/workspace eligibility, observed exposure/use/error |
| **Hooks** | RuleSync + Runtime evidence | event/matcher/action, target projections, validation/effective status, observed executions/errors |
| **Prompts** | RuleSync | canonical prompts/commands, edit/validate/version/diff/preview, usage/evaluation linkage |
| **Permissions** | RuleSync + effective Runtime | canonical policy, role/tool/MCP matrices, target differences/validation |
| **Tools** | composite effective catalog + OTel | native/MCP/plugin/app capabilities, exposure, availability, historical use/error; no duplicate authority |
| **Usage** | OTel/OpenLIT | cross-workspace/provider/model/agent/skill/MCP requests, tokens, cost, latency, failures, traces |
| **Evaluations** | evaluation definitions/storage + OTel | definitions, runs/results/history, targets, comparisons, trace linkage; links to Playtesting only for source-authored batch-level evaluation assertions |
| **Playtesting** | game-owned adapter and rubric + typed AutoDev playtest runner/evidence store | workspace-scoped batches, episodes, replay, result/quality metrics, independent critic analysis, findings, verified experiments, matched-cohort comparisons and optional human feedback |
| **Memory** | MemoryService/Data; OpenLIT-adapted connector capabilities | browse/search/detail/provenance/lifecycle/actions/effectiveness through AutoDev Console |
| **Workspaces** | AutoDev configuration + OTel | repository catalog, enablement/scope, configuration/runtime health, aggregate usage |
| **GitHub** | workflow YAML (definitions/cron) + config/workspaces.json (workspace identity/scope) + observed GitHub Actions API (runtime state/stats) | parsed workflow definitions + cron schedules, workspace-bound observed workflow state (active vs disabled), bounded recent run sample, bounded run statistics; allowlisted operator controls (dispatch/cancel/rerun/schedule) deferred |

### Agents

Agents are configuration-defined, not discovered/instrumented applications.

Useful states include:

~~~text
Configured
Valid / Invalid
Ready / Unavailable
Converged / Pending / Error
Last activity
~~~

Agent detail may combine canonical role/prompt, assigned capabilities, a read-only effective provider/model summary linking to Providers, generated projections, actual readiness/health, and scoped activity/usage.

### Providers

Providers is the one place an operator decides which model providers may serve the fixed agent roles, in what priority order, with which model, and under which concurrency limits. Its **Providers** tab is a single compact configuration table with exactly **four primary columns**:

| Column | Contract |
|---|---|
| **Provider** | Provider ID linked to its detail view, displayed without truncation. |
| **Status** | Overall provider usability, see below. Rendered as a status pill: `Ready` in the healthy style, a blocking state in the blocking style. |
| **Roles** | The four fixed roles — **Default, Smart, Orchestrator, Subagent** — each with a white-outline icon plus two controls: a priority dropdown containing exactly `P1`, `P2`, `P3`, `Disabled`, and a model dropdown populated from that provider's available models. The column header carries a help affordance. |
| **Agent Limits** | Provider-wide concurrent-agent limits for **Per session** and **Across sessions**, each a compact `− n +` stepper, plus an **Unlimited** control and a provider-level **Disabled** control. The column header carries a help affordance. |

The page header names the surface and states its purpose — *Configure which providers to use, which models to use for each role, and agent spawn limits.* — and offers **Reset to defaults** and **Add provider**.

**Status is a single verdict, not a summary of parts.** It reads `Ready` only when the provider is healthy *and* all required configuration and credentials are present. Otherwise it names the specific blocking state rather than degrading to a generic warning — for example `Missing CODEX_ROUTE`, `Missing credential`, `Disabled`, or the live health state (`Cooling down`, `Unavailable`). A provider whose parts are individually fine but which cannot currently serve a request must not read `Ready`.

**Roles are the four fixed roles, not a capability set.** Default, Smart, Orchestrator and Subagent are the canonical roles; a provider's participation in each is expressed by its priority rather than by a separate enablement flag. Selecting `Disabled` for a role disables and **dims that role's model selector** — the control stays present so the previously chosen model is visible and recoverable, but it can no longer be changed into an active selection.

**Dropdown styling is neutral, with one deliberate exception.** Role identity is carried by a distinct, consistent **white-outline icon** and label for each role. The single exception is the `Disabled` priority itself, which is highlighted so that "this role will not be used" is visible at a glance rather than having to be read. P1, P2 and P3 share one neutral style.

**Agent Limits are provider-wide**, not per-role, and carry a provider-level **Disabled control beside the Unlimited control**. That control globally disables use of the provider regardless of individual role settings, **while preserving its configured priorities, models and limits** so re-enabling later restores the same configuration rather than requiring it to be re-entered.

**Agent Limits controls:** The **Unlimited** button clears the operator-set ceiling on both concurrency axes. Steppers restore a finite limit at the minimum allowed value when leaving Unlimited. A **Disable / Enable** button changes provider availability while preserving the provider's configured models, role priorities and limits. Each action uses the established server-confirmed mutation flow.

The Providers tab has four columns: **Provider, Status, Roles, Agent Limits**. **Status** summarizes provider usability and configuration; **Roles** exposes per-role priority/model assignment. The **Models** tab lists models across providers, each with its enable/disable control under the contextual-controls rule.

Useful states include:

~~~text
Status:   Ready / Disabled / Missing CODEX_ROUTE / Missing credential / Cooling down / Unavailable
Priority: P1 / P2 / P3 / Disabled
Limits:   Per session, Across sessions, Unlimited
~~~

Provider detail may combine its enable/disable controls, configured routes, its models with their own toggles, per-tier models, the tier priority/fallback groups the provider appears in, live readiness/cooldown/failure evidence, and small scoped Usage summaries that link to Usage. Mutations go through typed Control API provider/routing operations. Credentials are shown only as configured/missing status, never as values, and Providers must not become a second credential or model-catalog authority.

### MCPs

MCP detail should use a consistent tab set:

~~~text
Overview
Configuration
Connection / Health
Tools
Resources
Prompts
Role Access
Activity
Errors / Logs
~~~

Useful operations include ping/test, list tools, inspect schemas, list/read resources, list/preview prompts, inspect effective authorization/configuration, and view recent calls/errors.

### Skills/capabilities

Keep stages distinct:

~~~text
Configured/Enabled
      ↓
Eligible
      ↓
Selected / Exposed
      ↓
Injected
      ↓
Used
~~~

Canonical skill definitions and descriptive metadata come from `.rulesync/skills`; role eligibility is joined from the execution contract by skill name. The Console lists the complete canonical skill catalog, including skills with no assigned roles, and explicitly surfaces role references with no canonical source. A missing or invalid RuleSync catalog is not a successful empty catalog. Only an owning producer may assert observed exposure/use/error. Do not infer later stages from configuration or eligibility.

### Memory

Memory must use the same AutoDev shell, tables, forms, filters, status patterns, and detail surfaces as the rest of the Console.

Reuse the useful OpenLIT connector/domain/list/detail/graph/chart/trace components and backend integration patterns, but port/adapt them into console/. The external OpenLIT Memory page is transitional and must disappear as an operator dependency after parity.

Memory governance, telemetry, retrieval, evaluation, and provenance details are defined in memory-target-state.md and memory-injection-outcome-evaluation.md.

### Evaluations

Retain useful evaluation definitions/results/history and trace linkage without Rule Engine or OpenGround prerequisites. Evaluations target explicit AutoDev resources/telemetry. A result is passed/failed only when its source supplies an explicit verdict; missing verdicts, missing metrics, or unknown verdict values remain **Not observed**, never inferred from an arbitrary score threshold. An unavailable or malformed evaluation source must not be represented as a successful empty result set. A malformed row invalidates that query sample rather than silently dropping the row and biasing displayed totals or pass-rate denominators.

### Playtesting

**Playtesting** is a top-level **Observe** resource at `/playtesting`. It uses the shared AutoDev dark React/Next.js Console, navigation, filters, tables, cards, drawers, charts and server-authoritative controls. The [Playtesting target state](playtesting-target-state.md) defines adapters, player/analyst agents, episodes, scoring, evidence and UI reuse; this document defines shared Console layout, navigation, ownership, data semantics and security.

**Data ownership:** Playtesting owns workspace-scoped batches, episodes, decision timelines, gameplay outcomes, immutable replay/media evidence, critic reviews, findings, experiments, matched comparisons and consented human-study aggregates. `core/src/playtesting/` owns typed contracts, `runtime/src/playtesting/` owns approved execution/evidence access, and `data/src/playtesting/` uses [the existing Data ClickHouse client](../data/src/clickhouse/clickhouse-client.ts) and indexed queries when feasible, with separately bounded content-addressed replay/media artifacts. Benchmark and document the data/artifact choice before implementing independent storage. **Evaluations** owns source-authored formal evaluation results and verdicts (including explicitly projected batch assertions), and **Usage/OpenLIT** owns inference traces/costs. Store **evidence status, investigation workflow, external GitHub issue state, batch execution, game outcome, and critic calibration** independently; each is grounded in its owning source.

**Routes and views:** `console/src/features/playtesting/` owns the `/playtesting` resource with **Overview, Sessions, Findings and Compare** views; `/playtesting/sessions/[id]` provides a full-page synchronized episode/replay inspector, and `/playtesting/findings/[id]` provides optional finding deep links. Register the **Playtesting** Observe item in `core/src/navigation.ts` and mark it active for child routes. Its URL helpers and indexed, server-filtered/paginated queries preserve workspace, build, scenario, cohort and cited step across navigation and refresh. Reuse common Console primitives and tested JevHarness/NanoJev/PlayJev interaction and visualization code through accessible TypeScript components.

**Control boundaries:** Workspaces owns game adapter approval, pinned checkout, execution sandbox, resource budgets and revocation; Providers and Permissions own model routing and effective access controls; Playtesting owns bounded, authenticated run/replay requests and findings, and GitHub owns external issue state. The Playtesting tool surface reuses [Runtime's Memory MCP pattern](../runtime/src/memory/mcp.ts), [MCP tool filtering](../runtime/src/mcp/tool-filter.ts) and the existing Control API, with server-bound workspace/role authorization. Expose typed, permissioned, budget-bounded operations; no arbitrary shell runner endpoint. The developer sees honest missing/partial evidence, measured denominators, replay integrity, uncalibrated vs human-validated scores and links to original episode/frame facts. New charts/views conform to dark tokens, accessibility and in-place navigation standards, with lazy indexed detail fetching rather than loading entire traces on list pages.

### GitHub

Workflow files (`.github/workflows/*.yml`) remain authoritative for workflow *definitions* and configured cron triggers. `config/workspaces.json` is the target owner for workspace identity, enablement, and resource scope. Scheduler weights/policy remain in the scheduler's canonical policy. The Console must not fork any of these into a second schedule/configuration authority, and the GitHub page must never expose raw provider credentials, arbitrary workflow IDs, or arbitrary workflow inputs to the browser.

The Console `/github` resource and the Control API `GET /control/github` are an authenticated, read-only path that pairs parsed workflow definitions with the corresponding observed GitHub Actions runtime state:

- YAML definition facts (`name`, `path`, sorted trigger events, sorted cron schedules) come from a typed Data reader (`GithubWorkflowRepository`); `.github/workflows/*.yml` files are parsed using YAML 1.2 `on:` semantics (preserving strings vs booleans). A missing `.github/workflows` directory or any workflow file that fails YAML parse yields an explicit `unavailable`/`invalid` catalog status without synthesizing a workflow count.
- The Control API exposes an authenticated GET-only collection endpoint (`/control/github`, `schema: autodev-control-github-v1`, `readOnly: true`) that requires valid Control API service credentials and actor verification, and strictly rejects non-`GET` methods with HTTP 405 Method Not Allowed.
- Server-side `AUTODEV_GITHUB_REPOSITORY` and optional/required `AUTODEV_GITHUB_TOKEN` are validated against an enabled canonical workspace: `AUTODEV_GITHUB_REPOSITORY` (or standard runner `GITHUB_REPOSITORY`) must reference a recognized workspace entry in `config/workspaces.json` that is explicitly enabled (`enabled: true`); an unrecognized workspace, a disabled workspace, or malformed repository coordinates surface as `invalid`. `AUTODEV_GITHUB_TOKEN` is optional for public repositories because GitHub REST workflow and run GET endpoints are reachable anonymously, though authenticated requests are preferable for stable rate limits. Private repositories still require a least-privilege server-side token with read-only Actions permission (and read-only Metadata). When accessing private repositories without a token, or when requests are forbidden (HTTP 403) or rate-limited (HTTP 403/429), runtime facts surface as `unavailable`; invalid credentials (HTTP 401) surface as `invalid`. `AUTODEV_GITHUB_TOKEN` remains strictly server-side, is never transmitted to the browser, and is redacted (`[REDACTED]`) from error messages.
- Observed Actions API runtime facts — workflow enabled/disabled state, workflow id, html URL, recent run count, last run status/conclusion/timestamp/URL, and a bounded recent run sample — come from a typed Data adapter (`GithubActionsAdapter`) enforcing strict network and parsing invariants:
  - Fixed origin: contacts only `https://api.github.com` via GET-only requests (using an optional server-supplied bearer token, or anonymous access for public repositories); caller-supplied hosts are forbidden;
  - Redirects denied: all HTTP redirects are rejected (`redirect: "error"`);
  - Path safety: repository path segments are URI-encoded (`encodeURIComponent`), and path traversal segments (`.` and `..`) are rejected before any network call;
  - Streamed byte caps & timeouts: responses are streamed and strictly capped at 1MiB (`MAX_RESPONSE_BYTES = 1_048_576`), and request timeouts (`DEFAULT_TIMEOUT_MS = 10_000`) remain actively enforced throughout body consumption;
  - Fail-closed record validation: malformed collection payloads and malformed workflow or run records fail closed (`invalid_payload` / 502) rather than silently dropping or coercing records;
  - HTTP error preservation: oversized, unreadable, or unparseable error response bodies do not erase HTTP auth/rate status codes (HTTP 401 Unauthorized, 403 Forbidden, 429 Too Many Requests, and 404 Not Found remain authoritative);
  - Configured workflows cap: workflow listing is capped at 100 (`per_page=100`), failing with explicit partial status (`partial_result` / 502) if more than 100 workflows exist.
- Bounded latest-run statistics (`totalRuns`, `successfulRuns`, `failedRuns`, `inProgressRuns`, `cancelledRuns`, `successRate`) are computed over a bounded recent-run sample (default 30 runs, max bounded limit 100):
  - `successRate` denominator is strictly all sampled completed runs (in-progress, queued, waiting, requested, and pending runs are excluded; non-success conclusions including failure, timed_out, action_required, startup_failure, cancelled, or missing conclusions remain in the denominator);
  - `successRate` is null (never synthesized as zero or 100%) until at least one completed run has been observed in the sample.
- State correctness and distinctions preserved: missing credentials for private repositories, unconfigured repository scopes, forbidden access, rate-limited requests, disabled workspaces, or GitHub API failures surface as explicit `unavailable` or `invalid` runtime states with redacted diagnostic messages; the page never synthesizes idle/healthy or zero counts.
- Dispatch, cancel, rerun, and schedule mutation controls remain **explicitly unimplemented** in both the GitHub resource surface and Control API. The Console must not expose them as browser-side affordances, and `GET /control/github` rejects non-`GET` methods with HTTP 405.
- Acceptance boundary: runtime state and statistics are verified through the pinned Data, Runtime, and Console test suites against injected fetch adapters. An unauthenticated live read of public `SimulatorLife/AutoDev` confirmed the GitHub Actions workflow and run endpoints; production-credential and browser acceptance remain separate open verification steps.

## 10. Usage and telemetry contract

### Logical requests versus physical attempts

A logical routed request and physical provider attempts are distinct:

~~~text
AutoDev logical routed request
├── provider/model attempt 1
└── provider/model attempt 2 (fallback/retry)
~~~

A failed OpenAI attempt followed by a successful Anthropic fallback is one logical request and two physical attempts.

- Provider reliability, attempt latency, tokens, cache use, and provider cost belong to attempt observations.
- End-to-end duration and final outcome belong to the logical request.
- Do not duplicate attempt token/cost totals on the parent.
- Keep requested-model identity distinct from the actual physical provider/model target.

### Semantic conventions and privacy

- Prefer current official gen_ai.* and MCP conventions.
- The current MCP convention pin is open-telemetry/semantic-conventions-genai@bcc7f9c2856fa7f4feb753f54d4ebba9455cc3dc and must be revalidated when producer semantics change.
- Use standard input/output/cache token attributes where reported.
- Cache-read rate is cached input tokens divided by input tokens only where both exist; missing evidence renders unavailable, not zero.
- Keep IDs, raw paths/URLs, prompts/responses, credentials, raw tool arguments/results, and free-form errors out of metric dimensions.
- Keep dimensions bounded and stable.
- Attach provider/model/role/workspace attribution at the producer that knows it. Do not invent downstream attribution.

### Context compactions

Context-compaction telemetry is a target requirement for Usage and any future per-resource aggregate view.

Emit a bounded source-owned counter such as `autodev.context.compactions`, unit `{compaction}`, only when the producer actually performs or explicitly reports a compaction. Record it at the producer/provider boundary that can establish the event. Do not infer compaction from token counts, context pressure, truncation, long prompts, or request success.

Correlate the event with the logical request and bounded workspace/provider/requested-model/agent dimensions **only when the owning source actually knows those values**. A retry/fallback must not duplicate one compaction event.

Prompt/context contents, request/session IDs, raw paths, and other high-cardinality or sensitive values never become metric dimensions. Optional compacted/retained token counts or duration are valid only when the source reports the actual measurement.

Target Usage may show count/time-series and bounded breakdowns by workspace, provider, requested model, and agent/role where those dimensions are source-confirmed. A per-request compaction rate is valid only when the compaction numerator and logical-request denominator are defined for the **same scope and time range**. Unsupported/unobserved signals remain unavailable, never zero.

### Git change metrics

Git change-output telemetry is a target requirement for Usage and for bounded per-resource aggregate views. It answers "what did the work actually produce" next to "what did it cost".

Emit one bounded source-owned observation per commit an AutoDev-managed agent actually creates. The Runtime does not create commits itself, so the observation is recorded where the commit can be established and attributed. Recommended instruments follow the existing `autodev.*` shape and bounded-unit style of `autodev.context.compactions`:

- `autodev.git.commits`, unit `{commit}`
- `autodev.git.files_changed`, unit `{file}`
- `autodev.git.files_added`, unit `{file}`
- `autodev.git.files_deleted`, unit `{file}`
- `autodev.git.lines_added`, unit `{line}`
- `autodev.git.lines_removed`, unit `{line}`

**Attribution comes from the commit, never from the observing Runtime.** An agent commits under its own bounded AutoDev committer identity, and the actor is read back out of the commit. This is required rather than merely preferable: agents and their subagents share one workspace, so commits form a single stream with no per-actor markers, git records a committer but not which model wrote the code, and there is no subagent lifecycle boundary at which a per-agent range could be read. A session-scoped or time-windowed attribution would therefore credit every subagent's commits to the orchestrator's role and model.

The identity is bounded and permanent-safe, because a commit outlives the session and may be pushed: a fixed local domain plus an allowlisted role and provider. It carries no session id, model id, path, URL, or free text. An out-of-vocabulary provider collapses to `other` rather than being written verbatim, and an unknown role yields no identity at all, so that commit remains the operator's rather than becoming agent output attributed to nobody. The identity is supplied as process environment, not repository configuration: nothing is persisted into the workspace, managed workspaces stay read-only, and the operator's own commits are unaffected.

Every commit carries an `autodev.git.attribution` dimension from a closed set of `commit_identity` and `unattributed`. An actor supplied by the observer rather than read from the commit is dropped from the dimensions and recorded as `unattributed`, so a shared-workspace commit cannot be blended onto a role; a query grouping commits by role, provider, or model must exclude unattributed commits rather than average over them.

Definitions must be exact, because these words are otherwise used loosely:

- a **commit** is counted once for the commit object actually created. An amend, rebase, cherry-pick, or revert is a distinct commit and counts as one; re-reporting an already observed commit does not count again.
- **files changed** is the count of distinct paths whose status in that commit's diff is added, modified, deleted, or renamed. Files added and files deleted are **subsets** of files changed, not additions to it — a displayed total must never sum all three and double-count.
- **lines added** and **lines removed** are the insertions and deletions reported for that commit's diff.

Only report a measurement the source actually observed:

- do not infer commits, files, or lines from tool-call counts, task success, edit counts, session end, or diff-size heuristics;
- do not attribute a change to a provider/model/agent/role the producing source did not know at commit time. Git records that a commit exists; it does not record which model wrote it. Correlation with session, requested model, agent/role, provider, and workspace is valid only where the owning Runtime source actually knows those values, under the same bounded-dimension and allowlist/`other` rules as other `autodev.*` producers;
- merge commits, binary files, and diffs the source cannot summarize are either measured or explicitly excluded with a stated reason. They are never silently folded into a total, and a partial measurement is reported as partial rather than as a complete, smaller number;
- where diff statistics are unavailable, the value is unavailable, never zero.

Privacy and cardinality are stricter here than for most signals:

- file paths, repository URLs, branch names, and commit metadata never become metric dimensions — aggregate counts only;
- per-file and per-commit detail belongs in traces/events with bounded redacted identifiers, never in metric labels;
- commit SHAs and session/request identifiers stay out of dimensions, consistent with the semantic conventions and privacy rules above.

Deduplication and scope:

- the same commit must not be counted twice when more than one producer can observe it, for example a session producer and a later workspace reconciliation pass;
- a rate or ratio — commits per logical request, lines per commit, files per session — is valid only when numerator and denominator are defined for the **same scope and time range**. Otherwise it renders unavailable.

Target Usage may show counts, time series, and bounded breakdowns by workspace, provider, requested model, and agent/role where those dimensions are source-confirmed, plus a per-session view where session identity is source-confirmed. This telemetry observes change output; it does not become a second Git, workspace, or GitHub authority, and it grants the Console no Git mutation path.

### MCP

The AutoDev Codex-tools MCP shim owns its server-side tools/call round trip. Its span duration is the shim round trip, not assumed downstream execution duration. Preserve W3C context where available and export bounded categorical/error metadata only.

### Skills

Use a minimal autodev.skill.* contract where no standard skill semantic convention exists. Configuration is not proof of runtime use. Avoid unbounded skill-name metric dimensions; prefer traces/events and bounded queries where appropriate.

### Memory

Memory telemetry must remain governed by the focused Memory design. At the shared Console level:

- memory research stages are observable within the logical request trace;
- packet injection is distinct from model use and task success;
- task/PR outcomes are never inferred from provider-routing success;
- metric dimensions remain bounded and content-free;
- GenAI attempt spans remain the source of model cost;
- memory operations do not replace MemoryService authorization/state;
- sensitive query/claim/evidence/session/memory identifiers do not become telemetry dimensions.

Detailed stage/metric definitions remain in memory-target-state.md so this shared target does not duplicate the Memory implementation contract.

### Usage dashboard

Keep one **Usage** product surface; do not add a redundant Analytics page.

Use the retained OpenLIT time-range control. Core owns the canonical `USAGE_VARIABLE_IDS` tuple shared by Console and Data; the fixed OpenLIT endpoint mirrors this bounded list at its service boundary and accepts no arbitrary variable IDs. Typed single/multi-select + All variables should support URL persistence where applicable:

- workspace;
- provider;
- requested model;
- agent/role;
- skill only where safely present.

Widgets opt in only to variables whose semantics apply. Unsupported signal/filter combinations fail closed rather than silently changing semantics. Bind selections through typed parameterized inputs; never concatenate browser-controlled SQL. Provider-attempt spans carry only validated `autodev.workspace` and `autodev.agent.role` context from the logical request so those filters work without a cross-span join; these remain span attributes, never metric dimensions.

The Console's same-origin server calls only fixed read-only Usage telemetry endpoints with a dedicated server-to-server credential. The summary endpoint is `POST /api/autodev/usage` (`autodev-openlit-usage-v3`): it accepts bounded time/filter selections, not raw SQL or arbitrary widget IDs, and returns fixed validated widget data, supported filter values, and a bounded recent-attempt list. The trace-detail endpoint accepts only a validated OpenTelemetry SpanId and resolves its TraceId server-side. Both use the dedicated Usage credential and never reuse mutation credentials.

Target views include logical requests, attempts/provider reliability, input/output/cache tokens, cost, latency, failures, MCP activity, relevant skill evidence, traces, and source-confirmed context compactions. Usage presents a bounded recent-attempt list; selecting a span opens its privacy-filtered trace detail. Current verified widgets/evidence belong in the migration tracker. Evaluation-to-trace navigation uses the same fixed read-only `GET /api/autodev/usage/span/:spanId` endpoint with the dedicated Usage service credential. It accepts only a validated OpenTelemetry SpanId, resolves its TraceId server-side, and returns at most 200 privacy-filtered span summaries (IDs/parent, operation/service, timestamp, duration, status) without span attributes, events, prompts, responses, tool arguments, SQL, or tenant context.

Use OpenLIT's compact time-scope, summary, and breakdown-chart patterns ([Costs analytics](https://docs.openlit.io/latest/openlit/costs/analytics)) inside the AutoDev-owned dark Console; do not import its generic shell, dashboard builder, or tenant model. If the Usage request is unreachable, unauthorized, fails HTTP, or returns an invalid schema, keep the shared scope/filter controls and show one shared unavailable state, but do not render metric cards or charts as if a validated snapshot had been read. Distinguish transport failure from invalid response. A valid partial snapshot may still show its observed metrics alongside per-signal `Not observed` states.

Cost is read only from OpenLIT's `gen_ai.usage.cost` attribute and is labeled as an estimate, not a provider bill: stock OpenLIT may compute it from a pricing catalog when no provider-reported amount exists. If no attempt carries a cost value, the Console reports `Not observed`; an empty aggregate is not a measured `$0`.

### Active Sessions

The Usage scope selector gains an **Active Sessions** option that scopes the page to sessions running right now, instead of to a historical interval.

It is presented in the same control as the time ranges, because that is where an operator looks when changing what Usage shows, and moving it to a second control would trade that discoverability for a distinction the label can already carry. The control's label must therefore name both kinds of selection and must not keep reading **Time range**: label the control **Usage scope**, and list Active Sessions alongside Last 24 hours / 7 days / 30 days / 90 days / Custom range.

That is a presentation requirement, not a semantic one. Behind the control, Active Sessions is a scope over live runtime state, not a temporal window, and the selection must be represented as such end to end. It is deliberately not a retained OpenLIT time-range value, because every retained value maps to a bounded historical query while this one has no window at all. Implementations must not approximate it as a shortened or derived range, and must not synthesize an active-session set from span recency: **absence of telemetry is not evidence that a session is inactive.**

"Active" is defined solely by the Runtime's own live session/concurrency state published on the authenticated read-only Control API runtime projection — the same authority behind the Agents runtime panel. There is no second session registry and no Console-side session cache that could disagree with it.

Because this scope reaches from the observability plane into the control plane:

- it reads runtime state through the Control API with the existing scoped service credential, and does not issue a Usage telemetry query for it;
- it stays read-only. Active Sessions never mutates, cancels, or acts on a session; session control stays on the owning resource;
- results are bounded, and a truncated result reports partial/overflow explicitly rather than quietly showing fewer sessions.

State semantics follow the shared rule that missing evidence stays explicit:

- when the runtime is unreachable, draining, or reports no session evidence, the view renders `unavailable` / `not observed`; it must never render a synthesized `0` active sessions, because no evidence and an idle runtime are different facts;
- a measured zero — runtime reachable and reporting no live sessions — is a valid reading and renders as `0`;
- sessions that end, or that the runtime never registered, simply leave the scope. That is normal, not an error, and it must not be backfilled into the scope from history.

Widget applicability is explicit rather than inherited. Under Active Sessions, window-based widgets whose semantics require a bounded interval render their not-applicable/unavailable state instead of continuing to display the previous window's numbers, while genuinely live readings (current active sessions, in-flight requests, live concurrency and denial state) render from the runtime projection. The existing Usage filter dimensions still apply where the runtime source actually knows them, and unsupported signal/filter combinations fail closed rather than silently changing semantics. The CUSTOM range start/end inputs do not apply to this scope and are not presented as though they did.

Selection state is shared with the rest of the Usage selection: Active Sessions is URL-persisted, restoring that URL reproduces the scope, and entering or leaving it must not carry stale window state into a reading whose semantics differ.

Session identifiers stay out of metric dimensions, and any per-session rows carry bounded redacted fields only, consistent with the semantic conventions and privacy rules above. This scope adds no new historical aggregation store, compatibility dashboard, or query backend.

## 11. Control API and authorization

The Control API is the only AutoDev mutation/action boundary.

Target resource families include:

~~~text
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
/control/tools
/control/memory
/control/evaluations
/control/playtesting   # proposed, typed workspace-scoped playtest operations (not implemented)
/control/github
~~~

Use named typed operations only; no arbitrary command endpoint.

For RuleSync-owned resources, mutations change canonical RuleSync input and execute validation/generation/apply. Runtime-owned resources mutate their typed owner. Tools is primarily a composite read model. Usage uses its dedicated fixed read-only telemetry path rather than becoming a mutation/control resource.

`/control/github` is a fixed read-only collection route that pairs parsed workflow definitions with observed Actions API runtime state/statistics (the schema is `autodev-control-github-v1`); it rejects non-`GET` methods with HTTP 405 and never exposes dispatch/cancel/rerun/schedule mutations. Tokens, repository coordinates outside the workspace registry, and arbitrary workflow inputs are enforced server-side; the browser never sees raw credentials or accepts arbitrary workflow identifiers.

The browser uses same-origin TypeScript server routes/proxies. The private Control API listener remains separate from the model/OTLP router listener.

### Single-user identity and security

AutoDev has no built-in account system.

When no explicit viewer/operator allowlists are configured, the Control API may use the fixed local autodev-local operator identity only alongside its server-side service credential. The Console attaches trusted actor identity server-side; browser-supplied actor/role headers are never trusted. Configured allowlists disable the implicit local identity and require an explicit allowed actor.

Requirements:

- no AutoDev account/login/signup product;
- same-origin browser mutations with CSRF protection;
- private/scoped server credential from Console to Control API;
- installation/operator authorization appropriate to deployment;
- optional reverse-proxy/SSO protection for remote exposure without AutoDev accounts;
- least privilege per resource/action;
- redacted audit record for each mutation;
- no bearer token, external identity secret, or raw mutation body in telemetry.

A completed control action may emit bounded control telemetry; OTel is never the command path.

## 12. OpenLIT maintenance strategy

Maintain a dedicated AutoDev OpenLIT fork/distribution. Upstream contributions are optional and must not block AutoDev.

Keep ingestion, OTel semantics, storage schemas, and generic query execution as close to upstream as practical while allowing substantial divergence in product shell, navigation, domain modules, and control pages.

Do not rewrite foundational OpenLIT storage/query abstractions merely to remove hidden singleton tenancy internals.

Receiver authentication remains mandatory. Retain the local bearer-auth patch for OTLP/HTTP and OTLP/gRPC until the pinned upstream behavior genuinely replaces it.

Every upstream upgrade must verify:

- the pinned patch/application sequence;
- retained receiver/storage/query behavior;
- AutoDev Usage/query behavior;
- removal of excluded product features;
- the single AutoDev Console shell;
- dark-only styling and canonical navigation;
- retained component integrations;
- no reintroduction of account/tenancy/discovery/Controller concepts.

Current OpenLIT version/image/patch evidence belongs in autodev-console-migration.md.

## 13. Acceptance contract

### Console UI/product

- console/ is the sole final user-facing application.
- Canonical resource navigation exposes **14 resources**, with **Playtesting** under Observe.
- The Providers tab uses four columns — **Provider, Status, Roles, Agent Limits**. Status reads `Ready` only when the provider is healthy and fully configured, otherwise naming the blocking state. Roles shows **Default, Smart, Orchestrator, Subagent** with distinct white-outline icons, `P1/P2/P3/Disabled` priority dropdowns and model selectors that dim when disabled. The Disabled priority is highlighted; P1–P3 use a neutral style. Agent Limits provides **Per session** and **Across sessions** steppers, an **Unlimited** button and a **Disable / Enable** button that preserves configured models, priorities and limits.
- Provider routing precedence is configured through **per-role priorities** and **per-tier routing settings**.
- Item-scoped controls are contextual: each appears on the item's list row and in its detail view inside the owning resource (provider toggles on Providers rows and provider detail; model toggles on Models rows, model detail, and the provider detail's model list), backed by one typed operation; other resources show read-only state with a link.
- Dark-only operation is enforced; there is no light/system theme or theme selector.
- Otter/chat is absent.
- Documentation/Community/blog/marketing navigation is absent.
- Accounts/profile/logout, organization/project/environment selectors, generic onboarding, generic dashboard builder, Rule Engine, OpenGround, GPU, discovery/instrumentation UX, and removed product surfaces are absent.
- Memory, Evaluations, **Playtesting**, Agents, Prompts, Usage, and other retained functionality appears inside the shared AutoDev shell rather than opening a second operator application.
- **Playtesting** has a dedicated active sidebar item, Overview/Sessions/Findings/Compare views, indexed workspace-filtered evidence and a full-page episode replay. Evidence links, absent media, human-data privacy, run authorization, in-place navigation and large-history pagination are validated with bounded data retrieval.
- Shared tables/tabs/forms/status/dialog/filter/chart primitives produce consistent spacing, density, keyboard/focus behavior, and status vocabulary.
- Safe single-choice settings apply on selection without a second Apply control; multi-axis filters, multi-select sets, and reviewed transactions retain an explicit submit boundary with its purpose made clear. Changing or submitting any Console form or control does not cause a full document reload, executing via in-place client navigation and updates while preserving URL state, native form semantics, keyboard focus, accessible pending feedback, and server-confirmed state.
- Each concern has one canonical editable surface; cross-resource summaries are read-only/linking.
- Core routes handle loading, empty, unavailable, error, and normal states without demo/fallback data.
- Useful filters/detail routes are URL-addressable where appropriate.
- Browser/visual regression acceptance covers the shared shell and representative list/detail/form/observability pages.

### Telemetry

- one logical request versus N physical attempts is preserved;
- token/cost/latency accounting is not duplicated;
- cache-read and unsupported metrics use unavailable semantics;
- dimensions remain bounded/privacy-safe;
- attribution comes from owning producers;
- MCP/skill/memory observations are asserted only from real evidence;
- compactions are emitted only for actual/reported source events and never synthesized;
- the Usage Active Sessions option is presented in the same scope control as the time ranges under a label that names both kinds of selection and no longer reads "Time range"; it scopes to Runtime-reported live sessions rather than a derived or shortened time range, renders `unavailable`/`not observed` instead of a synthesized `0` when runtime session evidence is absent, distinguishes a measured `0` from missing evidence, fails closed on unsupported widget/filter combinations, and adds no second session authority;
- git change metrics (`commits`, `files changed`, `files added`, `files deleted`, `lines added`, `lines removed`) are measured from the commit itself rather than inferred, attribute the actor from the commit's own bounded committer identity rather than from the observing session, count each commit once across producers, keep files-added/deleted as subsets of files-changed so totals never double-count, carry no file paths, repository URLs, branch names, or commit SHAs as metric dimensions, report partial measurements as partial, and render unavailable rather than zero when diff statistics are missing.

### RuleSync/configuration

- canonical sources round-trip through the pinned generator;
- generated provider configs are deterministic projections;
- no editable duplicate authority remains after a completed migration slice;
- supported-target behavior remains equivalent before removing incumbent authority;
- Console mutations update canonical source then reconcile runtime.

### Control/security

- authenticated/authorized reads and mutations;
- CSRF/scoped service credentials;
- viewer/operator boundaries where configured;
- redacted audit records;
- desired/actual/pending/error convergence;
- telemetry/query paths cannot mutate AutoDev;
- GitHub operations are typed, allowlisted, scoped, and server-credentialed.

### GitHub

- `.github/workflows/*.yml` files remain the authoritative source for workflow definitions and cron schedules; the Data reader preserves YAML 1.2 `on:` semantics and exposes `valid`/`invalid`/`unavailable` catalog status without fabricating a workflow count.
- The Data `GithubActionsAdapter` contacts only the fixed `https://api.github.com` origin via GET requests (with an optional server-supplied bearer token, or anonymous access for public repositories); redirects are denied (`redirect: "error"`), path segments are encoded with `.` and `..` traversal rejected, responses are streamed and bounded to 1MiB with active timeouts, malformed records fail closed (`invalid_payload`), and oversized or unparseable error bodies preserve HTTP auth/rate status (401, 403, 429, 404). The adapter redacts tokens from error messages and never returns a synthetic zero/healthy result when credentials, repository, or API evidence are absent.
- The Control API `/control/github` route is an authenticated, read-only GET endpoint (`schema: autodev-control-github-v1`, `readOnly: true`, `runtimeFactsAvailable` flag) requiring Control API credentials and rejecting non-`GET` methods with HTTP 405; the Console renders explicit `Unavailable`/`Invalid` runtime status with redacted messages rather than synthesizing zeros or healthy state.
- `AUTODEV_GITHUB_REPOSITORY` validated against an enabled canonical workspace in `config/workspaces.json` (`enabled: true`) is required for observed runtime facts; unrecognized or disabled workspaces yield `invalid`. `AUTODEV_GITHUB_TOKEN` is optional for public repositories (accessible anonymously, though authenticated requests are preferred for stable rate limits) and required for private repositories (least-privilege with read-only Actions permission); missing credentials for private repositories, forbidden access, or rate-limited requests yield `unavailable`.
- Workflows are capped at 100 with explicit partial status (`partial_result`) if more exist; run statistics are computed over a bounded recent-run sample (default 30 runs); `successRate` denominator is all sampled completed runs (in-progress excluded; non-success/missing conclusions in denominator; null when 0 completed runs in sample).
- Dispatch, cancel, rerun, and schedule mutation controls remain explicitly unimplemented in both the Console resource and the Control API; tests must not relax this and must not introduce mutation routes.
- Production-credential and browser acceptance for the read-only state/statistics path remains unobserved. A live unauthenticated read of public `SimulatorLife/AutoDev` confirmed that the workflow and run endpoints are available; the pinned Data, Runtime, and Console test suites continue to verify behavior against injected fetch adapters.

### Fork/upgrades

- pinned OpenLIT revision/patch application passes;
- excluded product modules do not reappear;
- all AutoDev-owned application/control modules remain TypeScript/TSX;
- OpenLIT Controller is not shipped;
- retained features no longer depend on removed tenancy/Rule Engine/OpenGround concepts;
- storage/query/receiver behavior remains intact unless explicitly approved.

### Migration/cutover

- no production view relies on hard-coded sample usage/health/convergence values;
- workspace imports use declared package contracts;
- no legacy root implementation/facade returns;
- RuleSync subagents/permissions switch only after lossless parity;
- old OpenLIT AutoDev pages and temporary external Memory UI bridge are removed after Console parity;
- a real producer is verified through authenticated OpenLIT before legacy router history/receiver paths are deleted;
- obsolete sync/proxy/patch/dependency paths are removed after consumers disappear;
- current-main CI/workflow evidence supports the migration gate.

Do not remove an incumbent path until its replacement has end-to-end evidence. Do not keep permanent compatibility paths after cutover.

## 14. Documentation policy

- This document is the only broad AutoDev Console/observability/configuration target-state authority.
- autodev-console-migration.md owns current migration status/evidence and should stay concise/current rather than accumulating patch history.
- local-setup.md owns operational commands, ports, environment variables, and local secret/bootstrap details.
- memory-target-state.md owns detailed Memory architecture/telemetry/governance while deferring to this document on shared Console/OpenLIT UI rules.
- [playtesting-target-state.md](playtesting-target-state.md) owns Playtesting's runner/adapter, analysis, human-calibration, session UI and source-reuse details while deferring here on navigation, Console design, resource ownership, evaluator semantics and controls.
- Focused docs such as provider routing, prompt ownership, and codebase context may document subsystem behavior but explicitly defer here on shared ownership/target-state questions.
- Reusable skills should link here for AutoDev-specific decisions rather than copying them.
- Completed ledgers and superseded target-state documents should be deleted rather than retained as active competing guidance.
- OpenLIT/OTel upstream behavior is evidence and a dependency to pin/test, not a prerequisite for AutoDev to ship local extensions.

## Final target

AutoDev is a **single-user, dark-only, deliberately compact control and observability Console** built on a reduced OpenLIT telemetry foundation.

Retain OpenTelemetry ingestion, storage and querying alongside selected reusable components; use the **14 canonical AutoDev resources** as the product surface, with clear RuleSync/runtime ownership and distinct configuration, live state and historical telemetry.
