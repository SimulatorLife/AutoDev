# AutoDev Console Target State

> **Authority:** This is the single living source of truth for the AutoDev Console product model, OpenLIT fork boundary, observability/control architecture, RuleSync ownership, shared UI/design requirements, and acceptance contract.
>
> **Current implementation state:** [autodev-console-migration.md](autodev-console-migration.md).
>
> **Operational setup:** [local-setup.md](local-setup.md).
>
> **Focused Memory design:** [memory-target-state.md](memory-target-state.md) and [memory-injection-outcome-evaluation.md](memory-injection-outcome-evaluation.md).
>
> **Last reviewed:** 2026-10-04 (GitHub read-only Actions state/statistics path alignment).

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
├── MCPs
├── Skills
├── Hooks
├── Prompts
├── Permissions
└── Tools

Observe
├── Usage
├── Evaluations
└── Memory

Operate
├── Workspaces
└── GitHub
~~~

The grouping is presentation only; the 12 resources remain first-class routes.

There is no required generic Home/Dashboard page. The root route should redirect to a useful canonical resource rather than introduce a thirteenth surface that duplicates Usage, runtime status, or GitHub activity.

Use **Workspaces**, not OpenLIT Projects, for AutoDev repositories/workspaces. OpenLIT project/environment/organization/account tenancy must not reappear under different names.

Provider, model, routing, and runtime configuration are required domain data but remain secondary surfaces under **Agents** and relevant detail views rather than additional top-level navigation. Provider/model observability remains available in **Usage**.

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

### One canonical edit surface

Every domain concept has one canonical editable surface. Other pages may show a compact read-only summary and link to that surface.

| Concern | Canonical edit surface | Other surfaces |
| --- | --- | --- |
| Agent definition, provider/model eligibility, routing | Agents | scoped effective summaries |
| MCP configuration | MCPs | read-only role/tool summaries |
| Skill definition/enablement | Skills | read-only assignments/evidence |
| Hook configuration | Hooks | read-only effective status |
| Prompt/command content | Prompts | read-only assignment/version summary |
| Permission policy | Permissions | effective matrices/summaries |
| Tool configuration | originating MCP/runtime/plugin owner | Tools is a composite catalog |
| Memory lifecycle/configuration | Memory | read-only links/summaries elsewhere |
| Evaluation definitions/actions | Evaluations | related result summaries elsewhere |
| Workspace configuration | Workspaces | workspace badges/scope links |
| GitHub workflow catalog and Actions runtime state | GitHub (read-only; workflow definitions remain repository-owned) | read-only workflow/run links elsewhere |
| Historical telemetry | Usage | small scoped summaries with links to Usage |

Do not duplicate provider, routing, permission, prompt, MCP, tool, skill, or workspace controls across several pages for convenience.

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

- Use consistent keyboard/focus behavior and visible focus states.
- Preserve readable contrast in the dark-only palette.
- Use the same status vocabulary, icon sizing, spacing, table density, dialog behavior, and destructive-action confirmation patterns across features.
- Core workflows must remain usable at typical desktop widths; secondary details may collapse into drawers/tabs rather than creating alternate mobile product structures.
- URL-addressable list/detail/filter state is preferred when it improves operator navigation and debugging.

### Navigation responsiveness

Moving between sections, list/detail views, tabs, and filters must feel immediate and must never reload the document:

- The root layout is the single owner of the persistent shell (sidebar and header); pages render only their own content or an explicit unavailable state. The active section is derived from the route, not threaded through pages. The document scrolls (the sidebar is pinned), matching the App Router's navigation scroll reset.
- Because navigations no longer rebuild the document, every `ConsoleForm` requires a key for the server-rendered data its uncontrolled fields' defaults come from, so Back/forward, link, and submit navigations remount the fields with the values the page now shows rather than stale typed input. The key is never derived from the router's URL state: it updates before the deferred page content does, so a URL-derived key would remount the form with the previous page's defaults.
- Links and forms inside a section carry the section's whole URL scope (for Memory: workspace, record filters, and time window), so selecting a record, filtering, or switching tabs changes only what was chosen.
- Every internal link is a `ConsoleLink` (a Next.js `Link`, i.e. a real `<a href>`), so the App Router swaps only the page segment. Links never prefetch merely for being in the viewport; intent fully prefetches the destination page, once, so its server data usually arrives before the click. Hover and keyboard focus count once they rest on a link for 65 ms (so sweeping across the sidebar or tabbing through a table does not render every page passed); touch and mouse-down count immediately. Ordinary navigations are never served from the client router cache (`staleTimes.dynamic: 0`); intent-prefetched pages may be reused for at most 30 seconds (`staleTimes.static: 30`, the Next.js minimum). Each `ConsoleLink` also shows a delayed pending indicator while a destination's server data is still loading, because client navigation keeps the current page visible and suppresses the browser's own loading indicator. External destinations remain plain anchors.
- GET filter/scope forms submit through `ConsoleForm` (`next/form`) for the same soft navigation and show the same delayed pending indicator, marking the form busy, until the filtered page commits; mutations remain same-origin POST routes.
- Routes declare no `loading.tsx` boundaries: on Next.js 15.5, a prefetched route loading component makes same-path search-param navigations (tabs, filters, record selection) reuse an aliased prefetch entry that intermittently never commits.
- Page data loads in parallel; a page must not serialize independent Control API reads, and Control API reads must not redo deterministic work whose inputs are unchanged (for example, workflow YAML is re-parsed only when a file's content changes).
- Every server-rendered element is sent twice on a document load (HTML and the RSC payload) and parsed again during server rendering, so payload size is navigation latency. Styling repeated per row is declared once: `DataTable` styles its cells from the table body, and `StatusBadge` takes its shape and dot from the `status-badge` utility in `app/globals.css`, leaving only each variant's colors per badge.
- A view awaits only the reads its visible content needs. Secondary, scope-wide summaries that need extra reads stream after the page and must never hold a tab switch; while they refresh they keep the previous values visibly marked as refreshing.

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

OpenLIT is retained as infrastructure and a source of useful components/patterns. Do not preserve generic OpenLIT product features merely because they already exist.

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
| **Agents** | RuleSync + Runtime | role definition, provider/model eligibility, routing/runtime controls, desired/actual state, health, activity |
| **MCPs** | RuleSync + Runtime + OTel | server configuration, role exposure, Tools/Resources/Prompts, connection health, usage/errors |
| **Skills** | RuleSync + OTel | canonical definitions, role/workspace eligibility, observed exposure/use/error |
| **Hooks** | RuleSync + Runtime evidence | event/matcher/action, target projections, validation/effective status, observed executions/errors |
| **Prompts** | RuleSync | canonical prompts/commands, edit/validate/version/diff/preview, usage/evaluation linkage |
| **Permissions** | RuleSync + effective Runtime | canonical policy, role/tool/MCP matrices, target differences/validation |
| **Tools** | composite effective catalog + OTel | native/MCP/plugin/app capabilities, exposure, availability, historical use/error; no duplicate authority |
| **Usage** | OTel/OpenLIT | cross-workspace/provider/model/agent/skill/MCP requests, tokens, cost, latency, failures, traces |
| **Evaluations** | evaluation definitions/storage + OTel | definitions, runs/results/history, targets, comparisons, trace linkage |
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

Agent detail may combine canonical role/prompt, assigned capabilities, provider/model/routing controls, generated projections, actual readiness/health, and scoped activity/usage.

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

Only an owning producer may assert observed exposure/use/error. Do not infer later stages from configuration.

### Memory

Memory must use the same AutoDev shell, tables, forms, filters, status patterns, and detail surfaces as the rest of the Console.

Reuse the useful OpenLIT connector/domain/list/detail/graph/chart/trace components and backend integration patterns, but port/adapt them into console/. The external OpenLIT Memory page is transitional and must disappear as an operator dependency after parity.

Memory governance, telemetry, retrieval, evaluation, and provenance details are defined in memory-target-state.md and memory-injection-outcome-evaluation.md.

### Evaluations

Retain useful evaluation definitions/results/history and trace linkage without Rule Engine or OpenGround prerequisites. Evaluations target explicit AutoDev resources/telemetry.

### GitHub

Workflow files (`.github/workflows/*.yml`) remain authoritative for workflow *definitions* and configured cron triggers. `config/workspaces.json` is the target owner for workspace identity, enablement, and resource scope. Scheduler weights/policy remain in the scheduler's canonical policy. The Console must not fork any of these into a second schedule/configuration authority, and the GitHub page must never expose raw provider credentials, arbitrary workflow IDs, or arbitrary workflow inputs to the browser.

The Console `/github` resource and the Control API `GET /control/github` are an authenticated, read-only path that pairs parsed workflow definitions with the corresponding observed GitHub Actions runtime state:

- YAML definition facts (`name`, `path`, sorted trigger events, sorted cron schedules) come from a typed Data reader (`GithubWorkflowRepository`); `.github/workflows/*.yml` files are parsed using YAML 1.2 `on:` semantics (preserving strings vs booleans). A missing `.github/workflows` directory or any workflow file that fails YAML parse yields an explicit `unavailable`/`invalid` catalog status without synthesizing a workflow count.
- The Control API exposes an authenticated GET-only collection endpoint (`/control/github`, `schema: autodev-control-github-v1`, `readOnly: true`) that requires valid Control API service credentials and actor verification, and strictly rejects non-`GET` methods with HTTP 405 Method Not Allowed.
- Server-side `AUTODEV_GITHUB_TOKEN` and `AUTODEV_GITHUB_REPOSITORY` are validated against an enabled canonical workspace: `AUTODEV_GITHUB_REPOSITORY` (or standard runner `GITHUB_REPOSITORY`) must reference a recognized workspace entry in `config/workspaces.json` that is explicitly enabled (`enabled: true`). Missing credentials or unconfigured repository scopes surface as `unavailable`; an unrecognized workspace, a disabled workspace, or malformed repository coordinates surface as `invalid`. `AUTODEV_GITHUB_TOKEN` remains strictly server-side, is never transmitted to the browser, and is redacted (`[REDACTED]`) from error messages.
- Observed Actions API runtime facts — workflow enabled/disabled state, workflow id, html URL, recent run count, last run status/conclusion/timestamp/URL, and a bounded recent run sample — come from a typed Data adapter (`GithubActionsAdapter`) enforcing strict network and parsing invariants:
  - Fixed origin: contacts only `https://api.github.com`; caller-supplied hosts are forbidden;
  - Redirects denied: all HTTP redirects are rejected (`redirect: "error"`);
  - Path safety: repository path segments are URI-encoded (`encodeURIComponent`), and path traversal segments (`.` and `..`) are rejected before any network call;
  - Streamed byte caps & timeouts: responses are streamed and strictly capped at 1MiB (`MAX_RESPONSE_BYTES = 1_048_576`), and request timeouts (`DEFAULT_TIMEOUT_MS = 3000`, below the Console's 5s Control API budget so a slow GitHub API degrades to an explicit runtime-unavailable state instead of failing the page) remain actively enforced throughout body consumption;
  - Conditional revalidation: the long-lived Control API adapter remembers each endpoint's last validated body and ETag per credential digest and sends `If-None-Match`; every read still reaches GitHub, but unchanged answers return a bodiless 304 (not counted against the rate limit) instead of a re-downloaded, re-parsed payload;
  - Fail-closed record validation: malformed collection payloads and malformed workflow or run records fail closed (`invalid_payload` / 502) rather than silently dropping or coercing records;
  - HTTP error preservation: oversized, unreadable, or unparseable error response bodies do not erase HTTP auth/rate status codes (HTTP 401 Unauthorized, 403 Forbidden, 429 Too Many Requests, and 404 Not Found remain authoritative);
  - Configured workflows cap: workflow listing is capped at 100 (`per_page=100`), failing with explicit partial status (`partial_result` / 502) if more than 100 workflows exist.
- Bounded latest-run statistics (`totalRuns`, `successfulRuns`, `failedRuns`, `inProgressRuns`, `cancelledRuns`, `successRate`) are computed over a bounded recent-run sample (default 30 runs, max bounded limit 100):
  - `successRate` denominator is strictly all sampled completed runs (in-progress, queued, waiting, requested, and pending runs are excluded; non-success conclusions including failure, timed_out, action_required, startup_failure, cancelled, or missing conclusions remain in the denominator);
  - `successRate` is null (never synthesized as zero or 100%) until at least one completed run has been observed in the sample.
- State correctness and distinctions preserved: missing credentials, unconfigured repository, disabled workspace, or GitHub API failures surface as explicit `unavailable` or `invalid` runtime states with redacted diagnostic messages; the page never synthesizes idle/healthy or zero counts.
- Dispatch, cancel, rerun, and schedule mutation controls remain **explicitly unimplemented** in both the GitHub resource surface and Control API. The Console must not expose them as browser-side affordances, and `GET /control/github` rejects non-`GET` methods with HTTP 405.
- Acceptance boundary: runtime state and statistics are verified through the pinned Data, Runtime, and Console test suites against injected fetch adapters. No live production credential, remote repository, or browser acceptance was performed; live acceptance with production tokens remains a separate open verification step.

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

Use the retained OpenLIT time-range control. Typed single/multi-select + All variables should support URL persistence where applicable:

- workspace;
- provider;
- requested model;
- agent/role;
- skill only where safely present.

Widgets opt in only to variables whose semantics apply. Unsupported signal/filter combinations fail closed rather than silently changing semantics. Bind selections through typed parameterized inputs; never concatenate browser-controlled SQL.

The Console's same-origin server calls only a fixed read-only Usage adapter/endpoint with a dedicated server-to-server credential. It accepts bounded time/filter selections, not raw SQL or arbitrary widget IDs, and does not reuse mutation credentials.

Target views include logical requests, attempts/provider reliability, input/output/cache tokens, cost, latency, failures, MCP activity, relevant skill evidence, traces, and source-confirmed context compactions. Current verified widgets/evidence belong in the migration tracker.

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
- Canonical resource navigation contains exactly the intended 12 resources, grouped consistently; no duplicate generic Home/Analytics/Settings product is required.
- Dark-only operation is enforced; there is no light/system theme or theme selector.
- Otter/chat is absent.
- Documentation/Community/blog/marketing navigation is absent.
- Accounts/profile/logout, organization/project/environment selectors, generic onboarding, generic dashboard builder, Rule Engine, OpenGround, GPU, discovery/instrumentation UX, and removed product surfaces are absent.
- Memory, Evaluations, Agents, Prompts, Usage, and other retained functionality appears inside the shared AutoDev shell rather than opening a second operator application.
- Shared tables/tabs/forms/status/dialog/filter/chart primitives produce consistent spacing, density, keyboard/focus behavior, and status vocabulary.
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
- compactions are emitted only for actual/reported source events and never synthesized.

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
- The Data `GithubActionsAdapter` contacts only the fixed `https://api.github.com` origin with server-supplied bearer tokens; redirects are denied (`redirect: "error"`), path segments are encoded with `.` and `..` traversal rejected, responses are streamed and bounded to 1MiB with active timeouts, malformed records fail closed (`invalid_payload`), and oversized or unparseable error bodies preserve HTTP auth/rate status (401, 403, 429, 404). The adapter redacts tokens from error messages and never returns a synthetic zero/healthy result when credentials, repository, or API evidence are absent.
- The Control API `/control/github` route is an authenticated, read-only GET endpoint (`schema: autodev-control-github-v1`, `readOnly: true`, `runtimeFactsAvailable` flag) requiring Control API credentials and rejecting non-`GET` methods with HTTP 405; the Console renders explicit `Unavailable`/`Invalid` runtime status with redacted messages rather than synthesizing zeros or healthy state.
- Server-side `AUTODEV_GITHUB_TOKEN` and `AUTODEV_GITHUB_REPOSITORY` validated against an enabled canonical workspace in `config/workspaces.json` (`enabled: true`) are required for observed runtime facts; missing credentials yield `unavailable`, while unrecognized or disabled workspaces yield `invalid`.
- Workflows are capped at 100 with explicit partial status (`partial_result`) if more exist; run statistics are computed over a bounded recent-run sample (default 30 runs); `successRate` denominator is all sampled completed runs (in-progress excluded; non-success/missing conclusions in denominator; null when 0 completed runs in sample).
- Dispatch, cancel, rerun, and schedule mutation controls remain explicitly unimplemented in both the Console resource and the Control API; tests must not relax this and must not introduce mutation routes.
- Production-credential, remote-repository, and browser acceptance for the read-only state/statistics path remains unobserved; verification is strictly through the pinned Data, Runtime, and Console test suites against injected fetch adapters.

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
- Focused docs such as provider routing, prompt ownership, and codebase context may document subsystem behavior but explicitly defer here on shared ownership/target-state questions.
- Reusable skills should link here for AutoDev-specific decisions rather than copying them.
- Completed ledgers and superseded target-state documents should be deleted rather than retained as active competing guidance.
- OpenLIT/OTel upstream behavior is evidence and a dependency to pin/test, not a prerequisite for AutoDev to ship local extensions.

## Final target

AutoDev is a **single-user, dark-only, deliberately compact control and observability Console** built on a reduced OpenLIT telemetry foundation.

Retain the useful OpenTelemetry ingestion/storage/querying and selected reusable components/capabilities; remove the generic OpenLIT product shell; make the 12 AutoDev resources the canonical product surface; keep RuleSync/runtime ownership explicit; and never conflate configuration, actual runtime state, or historical telemetry.
