# AutoDev Console Migration Tracker

> **Scope:** Current implementation state, gaps, cutover dependencies, and acceptance evidence for the AutoDev Console/OpenLIT migration.
>
> **Authority:** [autodev-console-target-state.md](autodev-console-target-state.md) is authoritative for product, architecture, UI, ownership, and correctness requirements. This file records only observed implementation state and remaining migration work.
>
> **Last reviewed:** 2026-10-04.

## Current baseline

The repository is on the four-workspace TypeScript layout (Console, Runtime, Core, Data) and the obsolete root implementation tree is gone. OpenLIT plus the AutoDev Control API are the target observability/control foundation, but the migration is not complete: the unified Console still lacks full feature parity, the OpenLIT product shell still contains unwanted generic product code, RuleSync role/permission parity is incomplete, and router-owned direct OTLP/history paths remain.

The active local OpenLIT baseline is:

- upstream OpenLIT openlit-2.1.0 at commit 9938c66638666ca5d3bcb850350faa82e510924b;
- published baseline image ghcr.io/openlit/openlit@sha256:94552ccd09379b5e2fec3c51c4fec1b41d88d6b56b0a5ccc895c116673884fa8;
- active local patch level p25, image autodev-openlit:openlit-9938c6663866-pd8ea85e2259187eb;
- active local image digest sha256:fabd1db9f0ce2f840c738e532d94bdc5937efaf8942dc41120fb02547337de75;
- standard lock at $CODEX_HOME/openlit-patched.lock;
- telemetry retention 730 hours (about 30 days), with durable local volumes and no automated backup.

Local p25 acceptance has verified the OpenLIT container, /memory HTTP 200, unauthenticated OTLP rejection, authenticated content-free OTLP acceptance/persistence, live Usage filtering, and service-token redaction. Remote deployment acceptance remains open.

## Gap ledger

| Area | State | Remaining target gap / next dependency |
| --- | --- | --- |
| Flat monorepo | **Partial cleanup** | Four root workspaces are registered and root src/ is gone. Finish manifest/import hygiene and Console/Data integration; do not add a fifth application workspace. |
| Console | **Runnable foundation** | Make console/ the sole final user-facing application; finish all 12 canonical routes, shared design system, real states/data, retained OpenLIT feature integration, and production lifecycle. GitHub is still missing. |
| UI/product subtraction | **Partial** | Remove remaining OpenLIT-only shell/product code, including the newly explicit dark-only/no-Otter/no-Documentation/no-generic-dashboard-builder target. Retire the old additive AutoDev OpenLIT pages after Console parity. |
| Workspace boundaries | **Partial cleanup** | Keep callers on declared workspace contracts and remove dependency/import leaks; no root implementation facade. |
| RuleSync ownership | **Partial** | Skills, hooks, commands/prompts, and MCP declarations are established. Agent/subagent and permission generation remain deferred until lossless parity exists for the current role/runtime contract. |
| Control API | **Partial** | Typed reads cover most configuration resources and a partial Tools catalog. Provider-role enablement and governed Memory lifecycle operations exist; general typed mutation/reconciliation remains incomplete. |
| Desired/actual state | **Mostly conceptual** | Implement reusable desired/actual generations, diff, last apply/observation, operation history, and authoritative converged/pending/error state across mutable resources. |
| Workspaces | **Partial** | Data reads the scheduler weights projection, but the canonical workspace registry still lacks complete enablement, agent/resource scope, configuration health, runtime availability, and remote acceptance. |
| Data | **Partial** | RuleSync/OpenLIT/Usage/Memory adapters exist. Finish runtime-state, effective-tool, evaluation execution, workspace, and retained-feature integrations without creating a parallel observability backend. |
| Usage | **Live locally; remote unverified** | Current typed range/filter/query path is live locally. Add source-confirmed context-compaction telemetry/widgets and complete remote/browser acceptance. |
| Memory | **Backend foundation + JIT + governed APIs** | Detailed state is maintained in memory-target-state.md and memory-injection-outcome-evaluation.md. Port the retained Memory operator experience into the unified Console, complete embedding/deployment acceptance, additional harness capture, controlled real-task evaluation, and broader analytics. |
| Evaluations | **Read integration implemented** | ClickHouse read adapter, Control API collection, and Console results/history exist. Automated execution/triggering remains deferred. |
| MCPs | **RuleSync-backed diagnostics** | Configuration/list/detail views exist with explicit unobserved handling. Continue runtime evidence and mutation/reconciliation integration. |
| Prompts | **RuleSync-backed hub/detail** | Canonical content/provenance/linkage exists. Complete edit/validate/save/version/diff/preview/generate/apply flows without creating an independent OpenLIT prompt authority. |
| Tools | **Partial read catalog** | Complete native/provider/plugin/MCP inventory, health/availability, role exposure, use/error counts, and trace linkage. Tools remains a composite read model rather than a second configuration authority. |
| GitHub | **Not started** | Add Console route, /control/github family, typed Actions API reads, and allowlisted dispatch/cancel/rerun/schedule operations scoped to configured workspaces. |
| Context compactions | **Not observed** | No producer currently emits the target compaction signal. Add source-owned instrumentation before adding count/rate/breakdown widgets; absence remains unavailable, never zero. |
| OpenLIT fork | **Partial/additive** | Receiver auth, Usage, login/signup removal, branding, Controller/GPU removals, and AutoDev additions exist. Complete product subtraction and make Console the only final UI. |
| Telemetry cutover | **Partial** | Standalone AutoDev Collector is removed. Verify a real Codex/router producer through authenticated OpenLIT, separate any required live-control correlation, then remove router historical aggregation, receiver routes, and legacy direct mode. |
| CI | **Tests/typecheck/format green; lint red** | Current full lint reports 133 errors. Repair findings at owning source paths without weakening checks; obtain visible current-main workflow evidence for migration acceptance. |

## Current Usage baseline

The verified Usage board currently contains:

| View | Semantics |
| --- | --- |
| Logical routed requests | one per autodev.routed_request, including final failures |
| Logical requests by agent/role | routed-request activity grouped by bounded role |
| Input/output tokens | summed on physical GenAI attempts |
| Cache-read rate | cached input / input only where both are reported |
| P95 attempt latency | physical attempt duration |
| Physical attempts by provider | grouped by gen_ai.provider.name |
| MCP tool calls | shim-owned tools/call round trips |
| P95 MCP tool-call duration | shim-side MCP span duration |
| MCP tool-call errors | errored MCP tools/call spans |
| MCP calls by tool | top bounded tool-name groups |

Provider does not filter logical-request count because a logical route can touch multiple providers. Provider filters apply to attempt-level widgets. Context compactions are target-only until a producer reports them.

## Remaining work by dependency

This is the migration order. The gap ledger above is the status authority; do not maintain a second independent numbered backlog elsewhere.

1. **Finish the unified Console shell and design system.** Implement the target dark-only UI contract, all canonical routes, canonical edit surfaces, real loading/error/empty/unavailable states, and no foreign embedded dashboards.
2. **Complete OpenLIT product subtraction as Console parity lands.** Delete unwanted product routes/components/stores/APIs/dependencies rather than merely hiding them. Retire the legacy additive AutoDev OpenLIT pages and the temporary external Memory-page bridge when their Console replacements are verified.
3. **Finish RuleSync authority where parity is possible.** Migrate subagents/roles and permissions only after every current field has an explicit owner and deterministic supported-target parity; then delete duplicate editable authorities.
4. **Finish workspace/data integration and boundary hygiene.** Keep the four-workspace architecture, complete typed adapters, and avoid rebuilding a second telemetry/query backend.
5. **Complete telemetry cutover.** Verify a real producer through authenticated OpenLIT, separate required live-control state, then remove router-owned historical OTLP aggregation/receiver paths and direct mode.
6. **Implement reusable mutation/reconciliation.** Apply canonical edits through the Control API, validate/generate/apply where needed, observe runtime, and expose desired/actual generations, diff, operation history, and convergence.
7. **Finish retained features.** Bring Memory, Evaluations, Prompts, Usage, trace/resource linkage, Tools, and provider/model/routing detail to target parity inside Console.
8. **Implement GitHub and context compactions.** Add their typed APIs/producers and UI only with authoritative evidence and bounded controls/dimensions.
9. **Delete transitional synchronization/compatibility paths.** Reassess OpenLIT projection syncs, singleton bootstrap, old proxies/facades, obsolete patches, stale dependencies, branches, and PRs after their consumers are gone.

## RuleSync parity gate

The pinned RuleSync 16.30.2 generator recognizes subagents and permissions, but its current target projections do not losslessly preserve AutoDev's role contract. Known gaps include orchestrator role kind, router provider alias, nickname candidates, reasoning summary, per-role skill enablement/bundling, per-role web-search policy, per-MCP enabled_tools for Claude/Copilot, and Runtime-specific provider delegation/spawn/permission-mode policy.

Generation scope also differs by target (for example Antigravity CLI permissions are global-only and Copilot permissions are project-only). Keep the current role TOML/generated execution contract until ownership/parity is explicit. Do not invent a second AutoDev declarative schema merely to force migration.

After parity:

- remove duplicate editable agent-role authority under agents/roles/;
- remove duplicate editable prompt/role authority where RuleSync can represent it;
- keep config/execution-contract.json only as a deterministic generated runtime artifact if still useful;
- update tests that currently freeze deferred RuleSync permissions/subagents.

## Telemetry cutover gate

The standalone AutoDev Collector has been removed. The router still exposes legacy direct OTLP ingress on port 4100 alongside the OpenLIT path on 4318. Before deleting router OTLP code:

- verify a real Codex/router producer through authenticated OpenLIT ingestion in the deployed stack;
- separate any required live routing/control correlation from historical aggregation;
- remove router-owned historical aggregation, metric series, lookback history, and persistence;
- remove router OTLP receiver routes and direct mode only after replacement evidence exists.

Do not delete live runtime/control state merely because it currently shares a telemetry module.

## Current acceptance evidence

As of 2026-10-04:

- pnpm install --frozen-lockfile --offline passes;
- pnpm test passes root 1243/1245 (two skipped), Core 25/25, Data 140/149 (nine environment-gated skips), Console 42/42, Runtime 127/130 (three environment-gated skips);
- pnpm run typecheck passes the root project and all four workspaces;
- pnpm run format:check passes repository-wide;
- pnpm run lint:ci reports 133 errors;
- OpenLIT p24-p25 patch application/build checks pass;
- focused CronLog/Pricing/Evaluation suites pass 166/166;
- Usage-variable/API-route suites pass 11/11;
- p25 patch-application suite passes 6/6;
- patched p25 client typecheck passes;
- local p25 health, Memory route, authenticated OTLP persistence, Usage filters, and service-token redaction probes pass;
- remote receiver/deployment acceptance and full browser-rendered Console acceptance remain open.

Patch-by-patch implementation history, superseded local image tags, and resolved intermediate failures belong in Git history/PR evidence rather than the active target or migration requirements. Keep this tracker focused on the current baseline and still-open gaps.

## Cutover rule

Do not remove an incumbent path until the replacement has end-to-end evidence. Once cutover is proven, remove the obsolete compatibility path instead of preserving permanent duplicate implementations.
