# AutoDev Observability Target State & Migration Ledger

> **Authority:** This is the single living source of truth for AutoDev observability architecture, decisions, findings, gaps, migration progress, acceptance evidence, and handoff.
> **Last reviewed:** 2026-09-29.
> **Runtime status:** The target is not implemented. The local router dashboard, in-process telemetry aggregation, provider admin route, and AutoDev-owned pass-through Collector remain incumbent paths until the cutover gates below pass.

## 1. Canonical-document contract

Every agent or contributor changing telemetry, provider bridges, OTLP configuration, router status, OpenLIT integration, or observability UI must:

1. Read this document before work and update it in the same change/PR as new findings, decisions, implementation, tests, or changed status.
2. Keep current facts, target decisions, open gaps, progress, and handoff here. Mark claims as verified, decided, assumed, or open, and cite repo-relative paths, upstream references, and test evidence.
3. Update a decision in place when it changes; do not append another competing plan or preserve superseded advice as active guidance. Keep history only when needed to explain a migration or decision.
4. Keep this document DRY: state each target rule once. Other docs may describe current operation or broader non-observability work, but must link here instead of copying the target, roadmap, status, or handoff.
5. Before handoff, record the current phase, completed evidence, next action, and unresolved gap IDs. Never mark a workstream complete without its exit evidence.

If this document conflicts with an observability plan elsewhere, this document is authoritative; reconcile the other material in the same change. Use repo-relative paths, not machine-specific absolute paths.

## 2. Goal, ownership, and topology

### Goal

Use standard OpenTelemetry traces, metrics, and logs as the telemetry contract and OpenLIT as the primary observability backend and UI. Avoid an AutoDev-owned observability database, general-purpose aggregation/query service, or parallel metrics dashboard. Preserve AutoDev-specific runtime controls through a small TypeScript Control API and isolated OpenLIT UI extension.

### Ownership

| Concern                                                         | Owner and boundary                                                                                                                                                                                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OTel semantics and context                                      | The component that owns the operation emits standard GenAI/MCP semantics and validated AutoDev context. Use a minimal `autodev.*` namespace only for genuinely AutoDev-specific concepts.                               |
| Ingestion, storage, query, traces, and observability dashboards | Stock OpenLIT, including its bundled OTLP Collector/receiver.                                                                                                                                                           |
| Generic dashboard variables                                     | A small, reusable, AutoDev-maintained OpenLIT UI/query-binding extension. It may add minimal generic query plumbing for safe typed bindings; it does not change telemetry meaning, storage schemas, or query semantics. |
| AutoDev configuration and live control state                    | AutoDev’s typed Control API, called by isolated `/autodev` UI routes. No telemetry or dashboard query is a command channel.                                                                                             |
| Additional standalone Collector                                 | Not part of the target by default. Add one only if a concrete policy need (for example redaction before export, routing, or fan-out) is documented and approved here.                                                   |

### Target data paths

```text
Observability:
AutoDev producers -- standard OTLP --> OpenLIT bundled Collector/receiver
  --> stock OpenLIT storage, query, traces, and dashboards

Control:
Authenticated OpenLIT /autodev UI
  --> same-origin server-side proxy
  --> authenticated AutoDev Control API
  --> AutoDev runtime/configuration
```

Do not maintain both the AutoDev Collector and OpenLIT’s bundled Collector as pass-through hops. The current AutoDev Collector config has no processors and forwards OTLP to the router; it has no established permanent policy role.

### OpenLIT maintenance policy

- AutoDev owns and maintains the minimal OpenLIT fork/patch set it needs immediately; upstreaming is optional and never a prerequisite for development, release, or operation.
- Pin the exact OpenLIT upstream tag/commit and container image digest. Keep patches isolated to generic dashboard-variable UI/bindings and AutoDev-specific `/autodev` components/routes. Test the patch set against the pinned revision before upgrades.
- Keep stock OpenLIT ingestion, storage, telemetry schema, and query semantics unchanged. The sole permitted query-layer change is minimal generic plumbing required to bind typed dashboard variables safely; use parameters, never SQL string interpolation.
- Keep OpenLIT locally deployable. Do not require a hosted control plane. The exact OpenLIT revision, image digest, local persistence configuration, and process lifecycle remain open until verified (see G1).

## 3. OpenLIT UI and dashboard contracts

### Navigation and ownership

- Use OpenLIT’s stock observability UI and dashboards. Provide a **Usage** dashboard for token usage, logical requests, cache-read rate, latency, tool calls, and agent runs; include cost where OpenLIT has pricing data. Do not add a separate Analytics page.
- Use stock dashboards and trace views for historical Provider, MCP, Skills, and error analysis.
- Keep AutoDev-only current state and actions under `/autodev` pages: **Providers**, **MCPs**, **Skills**, and **Runtime controls**. These pages show authoritative configuration, exposure/availability, and control state; they link to OpenLIT for historical activity rather than rebuilding charts.
- Keep trace exploration and session-level investigation in OpenLIT’s trace/log UI.

### Dashboard variables

- Keep time range in OpenLIT’s existing time-range control; do not reimplement it as a custom variable.
- Add generic non-time variables for **workspace**, **provider**, **model**, and **agent/role**. A variable has a typed value source, supports single/multi-select and All, and persists selection in URL/dashboard state.
- A widget opts into the variables it uses. Selected values affect every opted-in widget consistently and do not affect widgets that do not declare them.
- Bind values through typed, parameterized query inputs. Do not concatenate user-controlled values into SQL.
- The variable system remains schema-driven: instrumentation/resource schema owns the attribute used for workspace or role. Do not hardwire AutoDev field names or special cases into the generic OpenLIT variable engine.

## 4. Telemetry semantics and quality

### Request and trace accounting

A logical routed request and a physical provider/model attempt are different observations. Preserve them as a parent/child trace:

```text
AutoDev logical routed request (one count)
├── GenAI provider/model attempt 1 (one physical attempt)
└── GenAI provider/model attempt 2 (fallback/retry)
```

For a fallback such as OpenAI failure followed by Anthropic success, count one logical request and two physical attempts. Record provider reliability, attempt latency, tokens, and cost on the attempt that incurred them; record end-to-end duration and final outcome on the logical request. Do not copy attempt token/cost totals onto the parent and count them again.

### Semantic conventions

- Prefer current official `gen_ai.*` and MCP semantic conventions for provider/model operations, agents, tokens, tools, MCP operations, errors, and duration.
- Use `gen_ai.usage.input_tokens` and `gen_ai.usage.cache_read.input_tokens` for cache accounting where emitted. Cached input is a subset of input; cache-read rate is cached input divided by input. Show unavailable—not zero—when the source does not report either value.
- Use `autodev.skill.*` for the minimal Skills vocabulary because no suitable standard Skills semantic model is established. Keep availability/exposure, enablement, and actual use/outcome distinct. Exact keys and event boundaries must be defined and tested before producer migration (G5).
- Attach provider, model, agent/role, and privacy-safe workspace context at the producer that knows it. Do not infer missing attribution downstream or adapt telemetry to fit a dashboard.
- Keep request, session, conversation, thread, trace IDs, raw paths, and URLs out of metric dimensions. Use trace/span/log context for session-level queries. Metric dimensions must remain bounded and stable.
- Never export secrets, raw prompts/responses, credentials, or raw tool arguments. Distinguish unknown/unattributed/unavailable from zero. Preserve source timestamps and deduplicate retries/redelivery at the operation owner.

## 5. AutoDev Control API and authorization

The current provider-admin route is not a unified control API. The target resource model is:

| Resource  | Read state               | Mutation contract                                                                                                                                 |
| --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Providers | `GET /control/providers` | `PATCH /control/providers/{provider}/roles/{role}` with a typed desired-state field; migrate the existing provider/role enablement here first.    |
| MCPs      | `GET /control/mcps`      | Read-only until the authoritative writable configuration and apply lifecycle are identified; then add explicit resource-specific operations only. |
| Skills    | `GET /control/skills`    | Read-only until the authoritative writable configuration and apply lifecycle are identified; then add explicit resource-specific operations only. |
| Runtime   | `GET /control/runtime`   | Expose live operational state. Add only named, typed operations with an identified owner; no arbitrary command endpoint.                          |

The OpenLIT browser must not call the Control API directly. A same-origin OpenLIT server-side proxy must authenticate the user session, enforce CSRF protection, apply authorization, and call the private AutoDev API with a scoped service credential and verified actor identity. The Control API independently validates that identity and resource/action scope. Use **viewer** access for reads and **operator** access for mutations. If the selected OpenLIT deployment cannot establish an authenticated identity, keep mutations disabled until an explicit local authentication path exists; loopback-only networking is not user authorization.

Record each attempted mutation’s actor, resource/action, requested change, and outcome in a redacted audit record. Emit any corresponding OTel observation after the control operation; OTLP ingestion, dashboards, and query execution remain read-only.

## 6. Current implementation, findings, and open gaps

### Verified repository state

| Area                | Current evidence                                                                                                                                                                                                                                                                                                    | Target delta                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local UI and status | `src/router/dashboard.html` is a long, section-based page with one lookback selector, not task-oriented navigation. `src/router/http.ts` serves it and builds `/status` from runtime, usage, OTel, and event data. Token counters are present in status but the dashboard does not render a token-usage view.       | Retire the local observability UI after OpenLIT parity; retain only runtime-control status needed by real clients.                                   |
| Local aggregation   | `src/router/otel.ts` owns in-process OTel tracking, cumulative token counters, persistence, and a bounded 500-event lookback ring. `src/router/usage.ts` owns AutoDev usage buckets and workspace/provider/model breakdowns.                                                                                        | Move historical observability to OpenLIT; keep no parallel historical aggregator or synthetic backfill.                                              |
| Existing controls   | `src/router/http.ts` has a provider-admin POST path for role enablement, restricted to loopback. No unified `/control/providers`, `/control/mcps`, `/control/skills`, or `/control/runtime` API was found. Loopback restriction alone does not satisfy the target user-auth authorization boundary.                 | Extract/replace with the typed, authenticated resource API above; preserve only explicitly owned operations.                                         |
| Collector           | `config/otel/collector.yaml` receives on localhost port 4318 and exports JSON OTLP to the AutoDev router on port 4100. The config has no processor or demonstrated policy boundary.                                                                                                                                 | Route producers to OpenLIT’s bundled receiver and retire the AutoDev-owned Collector/config/runtime after parity.                                    |
| OpenLIT integration | No OpenLIT deployment, pinned image, or extension source is present in the inspected project configuration. OpenLIT’s public docs describe built-in OTLP ingestion and dashboards; its documented custom-dashboard bindings clearly include time range, while general non-time variables need local implementation. | Pin a specific upstream revision/digest, verify its actual APIs, and maintain the needed patch locally without waiting for an upstream contribution. |
| Secondary docs      | `docs/AUTODEV_PLATFORM_MIGRATION.md` retains historical Collector/AutoDev-aggregation and dashboard proposals; `docs/metrics-dashboard.md` documents the incumbent UI. `.rulesync/skills/opentelemetry/SKILL.md` now points to this ledger for project-specific architecture.                                       | Keep current-operation/history where useful, but link here rather than duplicating target guidance.                                                  |

### Open gaps

| ID  | Gap to resolve                                                                                                                                                                  | Exit evidence                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Choose and pin the local OpenLIT upstream revision and image digest; verify bundled OTLP receiver, persistence, local lifecycle, and supported auth against that exact version. | Reproducible local deployment and a recorded version/digest.                                                                          |
| G2  | Determine the smallest safe typed binding path through the pinned OpenLIT dashboard/query APIs for non-time variables.                                                          | Generic variable tests prove All/multi-select, URL state, widget opt-in, and parameter safety without a custom AutoDev query service. |
| G3  | Specify the shared producer/resource schema for workspace and role context, and inventory which providers/bridges actually emit each dimension.                                 | Versioned schema plus provider-by-provider fixture evidence; missing context stays unknown, not fabricated.                           |
| G4  | Define the logical routed-request span boundary and propagate trace context through retries/fallbacks and provider/model child attempts.                                        | A two-attempt fallback fixture yields one logical request, two physical attempts, and non-duplicated duration/token/cost totals.      |
| G5  | Define the minimal `autodev.skill.*` fields/events and separate exposure, enablement, and confirmed use.                                                                        | Contract tests and examples for exposed-but-unused, used, unavailable, and error cases.                                               |
| G6  | Map OpenLIT authenticated identity/roles to a scoped server-side proxy and decide which MCP/Skills/runtime state is writable and how changes are applied.                       | Viewer/operator, CSRF, service-auth, private-network, audit, and resource mutation tests; unsupported actions remain read-only.       |
| G7  | Inventory every `/status` and local telemetry consumer before narrowing/removing the incumbent projection.                                                                      | Caller map, migrated tests/CLI consumers, and a removal checklist with no remaining dashboard-only consumer.                          |
| G8  | Select OpenLIT retention/backup policy for new history. Existing cumulative counters and bounded rings cannot reconstruct faithful historic time series.                        | Documented local retention/backup policy; no synthetic backfill.                                                                      |

## 7. Migration tracker and handoff

Update this table as work advances; link each completed row to evidence rather than copying execution logs into this document.

| ID  | Workstream                                                             | State                                                                | Exit gate                                                                                                                                                      |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Canonical ledger and related-doc alignment                             | Complete (2026-09-29)                                                | Consolidated target and maintenance contract; secondary docs and the OTel skill point here; `tests/opentelemetry-skill.test.ts` and `git diff --check` pass.   |
| M1  | Pin and run local OpenLIT; route OTLP directly to its bundled receiver | Not started                                                          | G1 closed; standard traces/metrics/logs arrive and persist with privacy controls.                                                                              |
| M2  | Add generic OpenLIT non-time variables                                 | Not started                                                          | G2 closed; typed bindings pass security and interaction tests; stock time control remains authoritative.                                                       |
| M3  | Emit and verify source-owned GenAI/MCP/Skills semantics                | Partial: incumbent telemetry exists, target contract is not verified | G3–G5 closed; logical/attempt accounting, dimensions, cache semantics, and privacy pass fixtures.                                                              |
| M4  | Implement typed Control API and secure OpenLIT proxy                   | Partial: one loopback-only provider mutation exists                  | G6 closed; read/write roles and audit are enforced across the boundary.                                                                                        |
| M5  | Add isolated `/autodev` Providers, MCPs, Skills, and Runtime pages     | Not started                                                          | Pages use only the Control API for current state/actions and OpenLIT stock views for history.                                                                  |
| M6  | Cut over and remove the incumbent observability path                   | Not started                                                          | M1–M5 verified; G1–G8 closed; end-to-end acceptance below passes; dashboard-only routes, aggregation, storage, and AutoDev pass-through Collector are deleted. |

### Cutover acceptance

Before M6 is complete, verify:

- OpenLIT filters time with its stock control and applies the generic non-time variables consistently to opted-in widgets.
- A synthetic routed request with a failed first provider and successful fallback yields one logical request and two attempt records without duplicate token, cost, or latency totals.
- Token/cache counters use the documented GenAI semantics; absent cache evidence renders unavailable.
- Workspace/role attribution, MCP operations, and skill events retain source identity and fail closed on missing evidence.
- Prompts, credentials, raw arguments, session IDs, and file paths are not exported as metric dimensions or sensitive telemetry.
- Viewer/operator authorization, CSRF protection, scoped service authentication, and audit records are verified. OTLP and dashboards cannot mutate AutoDev.
- Every producer’s configured endpoint reaches only the intended OpenLIT receiver; no double export or silent drop is observed.
- All non-dashboard consumers of `/status` still work after removing telemetry-only fields and routes.

After cutover, remove the local dashboard, Chart.js/dashboard-only assets, generic router telemetry aggregation/persistence, obsolete lookback machinery, and AutoDev pass-through Collector. Keep only instrumentation/context actually owned by AutoDev and the explicit Control API/runtime state. Do not keep a compatibility dashboard or duplicate aggregation path. Roll back by restoring the prior pinned deployment/configuration as a release-level action, not by maintaining permanent shims.

### Current handoff

- **Current phase:** Documentation consolidation is complete; runtime migration has not started.
- **Next:** Close G1–G6 design/discovery in dependency order, then advance M1–M5. Keep each finding and result in this ledger.

## 8. References and secondary-document policy

- `docs/AUTODEV_PLATFORM_MIGRATION.md` remains the broader platform migration record. Its historical Collector tests and provider-migration evidence may stay, but observability target decisions, open questions, and progress belong only here.
- `docs/metrics-dashboard.md` is the incumbent dashboard runbook until cutover. It must not define the target or duplicate migration status; after M6 replace it with a short pointer to the OpenLIT/control runbook.
- `.rulesync/skills/opentelemetry/SKILL.md` contains reusable OTel engineering principles and must direct AutoDev observability work here for project-specific ownership and handoff.
- OpenLIT references: [Telemetry overview](https://github.com/openlit/openlit/blob/main/docs/latest/openlit/observability/telemetry/overview.mdx), [dashboard filters and bindings](https://github.com/openlit/openlit/blob/main/docs/latest/openlit/dashboards/filters-and-dynamic-bindings.mdx). Verify these capabilities against the pinned revision; upstream behavior is evidence, not a dependency.
- GenAI token semantics: [OpenTelemetry GenAI events](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md). Pin the semantic-conventions revision used for producer contracts.
