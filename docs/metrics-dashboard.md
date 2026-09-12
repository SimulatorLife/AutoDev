# AutoDev metrics dashboard

The live dashboard is maintained in the [AutoDev Metrics Dashboard issue](https://github.com/SimulatorLife/AutoDev/issues/2).
It is refreshed hourly by `metrics-dashboard.yml` and can also be run manually.
Each run also writes a step summary and uploads a 90-day JSON snapshot artifact.

The default lookback is 90 days and can be changed with the numeric
`lookback_days` dispatch input.

## Local live dashboard

The router serves the live dashboard at `http://127.0.0.1:4100/dashboard`. It
fetches the raw `/status` JSON on initial load and refreshes it every three
seconds (`setInterval(..., 3000)`), so the page is an operational view rather
than a separately maintained data snapshot. The `/status` endpoint remains
JSON for every `Accept` header; the dashboard does not change that API
contract.

The page has one componentized hierarchy:

1. KPI cards.
2. **Provider health**.
3. **Orchestrator & subagent usage**, containing **Spawn breakdown** and
   **Spawn failures**.
4. **Usage by workspace**.
5. **Skill telemetry**, containing **Skill context telemetry**.
6. **Hooks & runtime telemetry**.
7. **Operational summary**, containing **Native metrics observed**.
8. **Codex state & workspace telemetry**, surfacing the local
   `state_5.sqlite` collector (status, recent threads, projects, the
   `conversation.id` -> thread join) and per-workspace first-class event
   coverage (executed / requested / unavailable tool observations,
   skill exposures, and OTLP `codex.tool_result` executed vs unattributed
   coverage). Fail closed: a workspace without any bridge event or
   OTLP-resolved tool result keeps its per-workspace attribution at the
   `unavailable` state rather than reading as a zero.
9. **Recent routing events**.

Panels, badges, metric bars, outcome bars, row toggles, and stat cards are
custom elements. Live labels are escaped before HTML insertion, while event
logs, metadata, and errors use text-only DOM updates. MCP lifecycle observations
are shown in the relevant usage cards and operational summary; there is no
standalone MCP panel.

Per-workspace usage always has reliable totals, role, and model dimensions.
Named tool, named skill, and MCP server attribution at that same workspace granularity --
`status.usage.byWorkspace[*].byTool`, `...bySkill`, and `...byMcp` -- are optional fields:
the dashboard renders them when the status payload includes them and falls
back to an explicit unavailable state when it does not, rather than inventing
a join from unrelated telemetry or silently showing a zero that would be
indistinguishable from "observed, but nothing happened." Expanded workspace
rows show **"Named tool telemetry is unavailable per-workspace"**,
**"Named skill attribution is unavailable per-workspace"**, and
**"MCP server telemetry is unavailable per-workspace"** only when the
corresponding field is entirely absent from that workspace's bucket; once the
router starts populating it, the same rows show **"No named tool calls
observed for this workspace yet"**, **"No named skill uses observed for
this workspace yet"**, and **"No MCP servers observed for this workspace yet"**
if the field is present but empty, and the actual per-tool/per-skill/per-MCP
breakdown otherwise. This is a fail-closed distinction on
purpose: "unavailable" must never be collapsed into "zero," because the two
mean different things to an operator debugging a workspace with no visible
tool or server activity. Model views inside expanded workspaces also embed
model-level MCP counts and server breakdowns.

Expanded workspace rows render a separate **"Skills exposed"** section from
**"Skill usage"**: `status.usage.byWorkspace[*].bySkill` is the confirmed-use
join (explicit `invoke_type=explicit` activations and verified `SKILL.md`
reads -- the same source as `skillUses`), while `...bridgeSkills` is the
exposure join, populated from bridge `skill_exposed` events (a skill made
available to a session, e.g. via a role contract, with no claim that it was
ever read or invoked). These are two different facts about a workspace and
are never merged into one count or one section: a workspace can have skills
exposed to it long before -- or without ever -- confirming a use. When
`bySkill` is empty for a workspace that does have `bridgeSkills` entries, the
"Skill usage" section says **"No confirmed skill uses yet for this workspace
-- see Skills exposed below"** instead of the generic **"No named skill uses
observed for this workspace yet"** empty state, so an operator does not read
"no skill uses" as "nothing skill-related happened here" when the exposure
row already tells a different story. The "Skills exposed" section shows the
actual exposed-skill breakdown from `bridgeSkills` (`{ skill, count }`) and
falls back to **"No skills exposed to this workspace yet"** or **"Skill
exposure telemetry is unavailable per-workspace"** using the same
availability-vs-empty distinction as every other per-workspace join.

The workspace Tools section prefers the OTLP-sourced `byTool` join. When that
join is unavailable (`null`) or reports zero rows, the dashboard falls back to
`status.usage.byWorkspace[*].bridgeTools` -- a bridge's `tool_executed`
observations (`{ tool, server, count, byStatus }`) -- as the sole source for
that render; the two are never summed together, so a tool call a bridge
reports and an OTLP `codex.tool.call` datapoint later confirms is not counted
twice. The **Tool calls** column and its totals footer are derived from
whichever source the Tools section actually rendered.

When present, each `byTool`/`bySkill` entry is attributed under the exact
same project/workspace bucket as its parent `usage.byWorkspace` entry. The
router derives that attribution from local request context, verified hooks,
thread metadata, semantic OTLP conversation joins, or authenticated bridge
events; it never distributes global metrics by timing or process cwd. The
dashboard accepts either an array of rows
(matching the shape of the existing global `codexTelemetry.tools.byTool` and
`codexTelemetry.skills.injected.bySkill` tables -- name, count, optional
`byStatus`, and for tools optional `source`/`server`) or a plain object keyed
by tool/skill name (matching the existing `byRole`/`byModel`/`byProvider`
per-workspace dimension shape), since the status contract does not yet commit
to one representation over the other. Rendering never assumes network
connectivity, ordering, or that the field will appear in a given rollout
stage -- the fallback path is exercised whenever the field is missing, which
is also what today's status responses produce.

The workspace table's **Tool calls** column and totals use the same source of
truth as each workspace's expanded "Tools" section: they sum the rendered named
tool rows, preferring `w.byTool` and falling back to `w.bridgeTools` only when
`w.byTool` is null or empty (via `resolveWorkspaceToolRows`, both normalized
through `normalizeWorkspaceNamedUsage`). When per-workspace tool telemetry is
unavailable from both sources, the dashboard handles this explicitly
(displaying `—`) without inventing unrelated counts or falling back to
response-output tool-call counts (`w.toolCalls`).

## Reported metrics

- Agent PR-and-ping PRs raised and successfully merged, by target repository.
- Provider workflow invocations, split into succeeded, failed, and other
  conclusions, by provider and target repository where attribution is available.
- The last ten agent PRs in a table with links and creation timestamps (minute precision, `EST5EDT` / America/New_York).
- PRs closed by the centralized stale-empty janitor.

Provider workflows include the target repository in their run name so new
invocations can be attributed without scraping every PR comment. Runs created
before that instrumentation are retained in the provider totals but appear in
the `unattributed` bucket when a target cannot be recovered. The dashboard is a
rolling operational view rather than a permanent audit ledger; use the retained
artifacts for recent raw snapshots.


## Codex OpenTelemetry

The local Codex configuration exports privacy-safe OTLP logs, traces, and
metrics to the model router at `127.0.0.1:4100`. `analytics.enabled = true` is
required alongside the OTLP `metrics_exporter` for Codex to initialize its
native metrics provider; without it, the configured `metrics_exporter` is
never wired up and no metrics are emitted. `analytics.enabled` only gates
metrics initialization and does not affect prompt export: `otel.log_user_prompt
= false` independently prevents raw prompt text from being exported. The
router ingests Codex lifecycle
events and exposes them in `/status` and the local dashboard, including turn
timing, token counts, MCP server lifecycle observations,
initialization/tool-discovery latency, and recent failures.

The installed router and dashboard hooks under `$CODEX_HOME/hooks/` are runtime
copies, not symlinks. After changing the tracked implementation, run the
installer before checking live telemetry: it synchronizes those copies and
restarts every service, so nothing is left running the code it replaced.

```bash
bash /Users/henrykirk/AutoDev/scripts/codex/install-codex-integration.sh
bash /Users/henrykirk/AutoDev/scripts/codex/install-codex-integration.sh --check
curl --silent http://127.0.0.1:4100/status | jq '.codexTelemetry.skills'
```

The OTLP receiver accepts all three signal paths (`/v1/logs`, `/v1/traces`, and
`/v1/metrics`). Codex currently emits useful lifecycle logs and MCP traces; the
metrics receiver may correctly remain at zero outside of skill telemetry until
Codex emits other `ResourceMetrics` batches during a validated CLI turn. When
Codex does emit `codex.skill.injected` (a counter) and
`codex.thread.skills.enabled_total`, `codex.thread.skills.kept_total`, and
`codex.thread.skills.truncated` (histograms), the
router aggregates them into `codexTelemetry.skills`, surfaced in `/status`, the
dashboard's Skills section, and `codex-model-router-status.mjs`. The receiver
counter confirms that the endpoint is available if Codex begins emitting other
metrics in a later version.

The router also keeps a privacy-safe inventory of every metric name received
(`codexTelemetry.metrics.observed`) without retaining its attributes or values.
It parses the low-cardinality SQLite health metrics into
`codexTelemetry.sqlite` and native tool-call counts/durations into
`codexTelemetry.tools`. These are intentionally separate from the existing
log-derived turn/token counters to avoid double-counting.

The dashboard and CLI expose the observed metric-name inventory, SQLite
initialization/fallback totals and durations, and native tool calls grouped by
sanitized tool/source/server labels. Native tool metrics use `tool` in current Codex OTLP exports; older
versions may use `toolName` or `tool_name`. The router accepts all three. Legacy persisted `unknown-tool`
buckets created before the modern attribute was available are discarded during
restore because they cannot be mapped back to a real tool. Newly missing tool
names remain visible as `unknown-tool` for diagnosis. Unknown metric names
remain visible in the inventory but are not interpreted until their schema and
operational value are validated.

## Subagents spawned

The **Subagents spawned** table is the one place that counts every subagent
behind the router, whichever provider spawned it. It is fed by
`status.subagents`, not by OTEL: Codex's `codex.multi_agent.spawn` metric only
covers Codex-exported threads. It is also the only table that counts a spawn as
a spawn -- `usage.byRole` counts the *turns* subagents ran, which is a different
measurement, and one a child that spawned but never ran does not contribute to.

Two mechanisms are distinguished. `router_alias` spawns are Codex child threads
that asked the router for an `autodev/<role>` alias, driven by Codex itself or
by MiniMax through the namespace-flattening proxy. `bridge_native` spawns
happen inside a provider CLI -- Claude's `Agent` tool, Antigravity's
`invoke_subagent` -- where no router request exists, and are
reported by the bridge to `POST /v1/agent-events`. Before that channel existed,
a Claude- or Antigravity-served orchestrator reported zero subagents, which is
indistinguishable from a provider that refused to delegate.

A `bridge_native` count is per child, not per tool call: Antigravity's
`invoke_subagent` dispatches a batch of up to sixteen subagents in one call, so
the bridge reports one count per entry and takes each child's role from the
batch. The Role column reading `unattributed` for an Antigravity row therefore
means the CLI step exported no tool arguments, not that the delegation was
anonymous. A `bridge_native` subagent never makes a router request of its own,
so its turn reaches **Orchestrator & subagent usage** and **Provider health**
only through the bridge's report. Those reports are now
counted: each child opens a usage turn attributed to the provider, workspace,
and model of the request the bridge was serving, and closes with the duration
the CLI spent on it (or, when the bridge reports no close, with the time
elapsed before the parent turn ended). An orchestrator that delegated entirely
inside its CLI therefore shows its children's work rather than exactly one
model's usage.

Those turns are counted in the usage buckets only, never through the router's
event path: provider health, cooldown, and the fallback chain describe routing
decisions the router made, and a child it never routed must not move them. A
child whose CLI exported no role is counted under `unattributed-subagent` in
`usage.byRole.orchestrator` contains root/orchestrator turns, while direct
requests without a role contract remain under `unattributed`. The dashboard
renders the former as the Orchestrator row. The line above the usage
table names how many CLI-delegated turns are included. See
`docs/provider-routing.md` -> "Counting subagents across providers".

The totals row is the all-time count; the table rows roll up only the 50 most
recent spawns retained in `subagents.recent`, which is what carries the
provider/mechanism/role/tool combination. The summary line also reports
Codex's own OTLP spawn counter separately, because adding it to the router's
count would double-count every `router_alias` spawn. Attribution of a
`router_alias` spawn to a provider is a session join -- which provider served
that session's `autodev/orchestrator` turn -- and reads `unattributed` when the
router never saw that session's parent turn. See
`docs/provider-routing.md` -> "Counting subagents across providers".

A provider's row in **Provider health** sums every model observed for
that provider, not only the models its tiers configure. A directly pinned model
and a CLI subagent's own model both appear in usage under a key no tier names;
summing the configured list alone made the provider rows add up to less than
the totals row beneath them.

### Provider health table and controls

The **Provider health** table renders the operational state, routing priority, effective limits, and administration controls for every configured provider:

- **Routing priority:** Formatted by `formatRoutingPriority(providerName, p, status)`, this column maps the provider's configured priority groups across capability tiers (`default`, `smart`, `orchestrator`) from `status.routing.providerGroups`, displaying priority tiers such as `default: P1 · smart: P1 · orchestrator: P2`.
- **Effective limits & cooldowns:** Formatted by `formatEffectiveLimitsAndCooldowns(p)`, this column displays active cooldown badges with cooldown kind (`transient`, `hard`, `probe`, `config`), failure class, remaining countdown duration, declared reset time (`resets <timestamp>`), and any live provider limit details (`p.effectiveLimits`, `p.liveLimits`, `p.limits`). This replaces the redundant `Last failure` column with comprehensive, real-time cooldown and limit diagnostics.
- **Active:** Displays live agent workflow activity for the provider (`<status-badge>`), retaining non-zero counts and active styling during tool, user, and subagent waits. The table keeps only the `Active` column (transport-level in-flight requests are omitted from this table and surfaced separately under **Operational summary** and the Status CLI).
- **Administrative toggle controls:** The **Control** column features an interactive iOS-like toggle switch (`.btn-provider-toggle`) to dynamically enable or disable a provider:
  - Designed as a wordless iOS-style toggle switch: displays a green background (`#34c759`) when enabled and a grey background (`#48484a`) when disabled, with no text labels.
  - Features `role="switch"`, `aria-checked`, dynamic `aria-label`, and `title` tooltip for accessibility.
  - Clicking invokes `toggleProvider(providerName, shouldEnable, buttonEl)`.
  - While pending, the button is disabled and dimmed, tracked in `pendingProviderToggles` to prevent duplicate concurrent submissions without misleading text transitions.
  - The browser issues a `POST /v1/providers/:provider` request with JSON payload `{ "enabled": shouldEnable }`.
  - Upon success, the dashboard triggers an immediate `refresh()` to re-fetch `/status` and re-render table state.
  - If the request fails, the error message is displayed in the dashboard `#error` element and the button re-enables.
  - Disabled providers are marked with `.provider-disabled` styling and an error-state health badge displaying `disabled`. The panel header displays a disabled provider count (e.g. `4 / 5 ready · 0 active · 1 disabled`) when nonzero.

### Provider administration and status contract

The model router exposes provider state and administrative controls via the following contracts:

- **Loopback mutation endpoint:** `POST /v1/providers/:provider` allows enabling or disabling a provider at runtime. The endpoint is strictly restricted to loopback connections (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`, `localhost`); requests from other origins return HTTP 403 `router_access_denied`. Only `POST` is accepted (other methods return HTTP 405 `router_method_not_allowed`). The request body must be a JSON object containing boolean `enabled` (`{ "enabled": boolean }`).
- **Persistence and default behavior:** Providers default to enabled. Disabling or enabling a provider immediately updates the in-memory `disabledProviders` set and calls `persistRouterStateNow()` to persist `disabledProviders` atomically to `$CODEX_HOME/codex-router-state.json`. On daemon startup, `loadRouterState()` reloads the persisted disabled list, preserving administrative state across restarts.
- **Disable semantics:** Disabled providers are excluded from role alias candidates, orchestrator candidates (including session continuation hoisting), last-resort retry passes, and bounded exhaustion waits. A direct concrete model request to a disabled provider is immediately rejected with HTTP 503 `router_provider_unavailable` (`failureClass: "provider_disabled"`). If all providers for a tier are disabled, requests fail immediately with HTTP 503 `router_provider_exhausted`.
- **Status payload additions (`/status`):**
  - `status.routing`: Surfaces configuration source, existence, orchestrator configuration, role mappings, `providerGroups` priority hierarchy, `configuredProviders`, `enabledProviders`, `disabledProviders`, and sanitized route definitions.
  - `status.limits`: Surfaces effective global cooldowns, probe timeouts, last-resort max attempts, exhaustion wait window, selection deadline, upstream timeout, concrete retries, shutdown drain timeout, and per-session concurrency limits.
  - `status.providers[*].enabled`: Boolean flag reflecting administrative enabled state (`false` when disabled).
  - `status.providers[*].status`: Reports `"disabled"` when disabled, `"ready"` when operational, or the active cooldown failure class.
  - `status.providers[*].active`: Live agent activity for the provider (migrated from ambiguous `activeRequests`), representing active turn execution.
  - `status.inFlightRequests` / `status.providers[*].inFlightRequests`: Transport-layer diagnostic counters representing open HTTP connections to upstream provider models.

### Live agent activity vs. in-flight requests transport diagnostics

The router and dashboard cleanly separate **live agent activity** from **in-flight transport diagnostics**:

- **Live agent activity (`Active` badges, KPIs, provider rows):**
  Measures active agent workflow turns currently being executed by the orchestrator, subagents, or user sessions. Crucially, an agent does **not** stop being active when an intermediate model HTTP request finishes: during tool execution (`tool_executed`, `tool_requested`), user input waits, or child subagent waits, the agent and provider remain live. When `/status` indicates an active or waiting state (e.g. `status` or `state` is `"active"`, `"waiting"`, `"waiting_tool"`, `"waiting_user"`, `"waiting_subagent"`), the dashboard's `Active agents` KPI, provider table `Active` column, and `<status-badge active="">` remain visibly active and non-zero rather than flickering to zero between model invocations.
- **`Active agents` KPI total is the canonical live-agent count, not a max
  of unrelated counters:** The headline number is read directly from
  `status.liveActivity` (falling back to `status.usage.totals.active` for an
  older payload) -- both are the same unfiltered `agentActivity.countLive()`
  call the router makes internally, so it is the single source of truth for
  "how many agents are live right now." The dashboard's
  `computeKpiAgentTotals(status)` helper computes this value and **never**
  takes a `Math.max()` against per-provider active-request counts
  (`status.providers[*].active`) or subagent concurrency-slot counts
  (`status.concurrency.activeSubagentThreads` / `activeSessions`) --
  those measure transport-layer requests and scheduling slots, not live
  agent identities, and folding them into the headline via `Math.max` used
  to silently inflate the total above the number of agents actually live.
  One subagent active in one workspace renders as exactly `1`.
- **Orchestrator/subagent role breakdown stays consistent with the total:**
  The `N orchestrators · N subagents` breakdown shown under the KPI is read
  from the same `status.usage.byRole` partition the router sums to produce
  `usage.totals.active`, so the breakdown's components sum to the canonical
  total above rather than being independently maxed against a different
  counter (e.g. a concurrency-slot count that can under- or over-count
  relative to role-attributed activity).
- **Concurrency slot counts (`status.concurrency.activeSubagentThreads`,
  `activeSessions`) are scheduling context, not agent counts:** These
  fields describe how many subagent execution slots or session slots are
  currently occupied for concurrency-limiting purposes. They are shown in
  the Operational summary's Concurrency rows for that purpose, but are
  deliberately excluded from the `Active agents` KPI total and its role
  breakdown, since a slot and a live agent identity are not always in a
  1:1 relationship.
- **`workspaces with active agents` is non-additive context, not a KPI
  component:** The KPI's workspace count -- labeled `workspaces with active
  agents` -- is derived from the live `status.usage.activity.byWorkspace`
  state snapshot, not only from persisted workspace usage buckets. It counts
  known workspaces with a live state (`active`, `resumed`, `tool_wait`,
  `user_wait`, or `subagent_wait`) and excludes `unattributed`/`unknown`
  activity that cannot be safely assigned to a workspace. This count is
  rendered alongside the agent total purely for attribution context (how
  many distinct workspaces the live agents belong to); it is never summed
  into `Active agents`, since one agent is attributed to exactly one
  workspace and a workspace can host more than one live agent.
- **In-flight requests (`inFlightRequests`):**
  A distinct, transport-level diagnostic metric measuring active HTTP requests currently open between the router daemon and upstream provider model APIs. Incremented upon socket dispatch and decremented upon response completion or cancellation. The dashboard's **Operational summary** labels in-flight requests separately under Concurrency (`In-flight requests`), and `scripts/codex-model-router-status.mjs` displays both `Active` (live agent activity) and `In-Flight` (transport requests) side-by-side in its provider table.

### Lifecycle event contract and configurable freshness TTL

The router integrates with upstream agent runtimes through explicit agent activity events:

- **Lifecycle events:** Provider bridges emit `{ type: "activity", state, childIds? }` events for `tool_wait`, `user_wait`, `subagent_wait`, `resumed`, `finished`, `failed`, and non-transitioning `heartbeat` refreshes; router-visible response tool calls and continuations supply the native path.
- **Configurable freshness TTL (`CODEX_ROUTER_AGENT_ACTIVITY_TTL_MS`):** Defaults to `300000` ms / 5 minutes.
- **Live states:** `active`, `resumed`, `tool_wait`, `user_wait`, and `subagent_wait` count as live; `finished` and `failed` are terminal. An open agent request remains live until it settles; non-terminal wait activity older than the TTL becomes `stale` and is removed from live counts without killing or restarting processes.
- **Heartbeat freshness drives the `Active agents` KPI:** Every lifecycle
  event refreshes that agent's last-seen timestamp, acting as a heartbeat.
  `status.liveActivity` (and therefore the `Active agents` KPI total,
  role breakdown, and `workspaces with active agents` context count) only
  ever counts entries whose heartbeat is still within the TTL window above.
  If a bridge stops emitting lifecycle events for an agent (e.g. it crashed
  without emitting `finished`/`failed`), that agent silently ages out of
  every one of those counts once its heartbeat exceeds the TTL -- there is
  no separate "stale but still counted" state surfaced in the KPI; stale
  activity simply stops contributing to the canonical live count.

The dashboard's Operational summary groups Codex receiver, state-database,
and concurrency values as category/metric/value rows instead of embedding those
values in prose. Each panel heading owns its collapse toggle. Provider health,
Orchestrator & subagent usage, Usage by workspace, Skill telemetry, and Hooks &
runtime telemetry are expanded by default; Spawn breakdown, Spawn failures,
Skill context telemetry, Native metrics observed, Operational summary, and
Recent routing events are independently collapsible. The Subagents spawned
roll-up remains in the orchestrator/subagent area rather than becoming a
separate top-level panel.

Totals footers are shown only for homogeneous roll-up tables: provider/usage,
Skills injections, hook/runtime calls, observed metric counts, and spawn-failure
reasons. Operational summary and Skill context telemetry intentionally have no
totals because their rows mix incompatible units; recent routing events are an
event view rather than an additive measurement. MCP observations likewise do
not form a standalone table or panel.

Totals footers are shown only when the section has at least 2 populated,
non-total data rows. The renderer drives that policy through a single helper
(`shouldRenderTotals(populatedRowCount)`) used by every totals footer, so a
section with 0 or 1 populated body rows never renders a totals row -- a
single-row totals footer would only echo the row above it. The empty/unavailable
branches (`No subagent spawns recorded yet`, `No spawn failures observed`,
`No workspace usage observed yet.`, `No skill telemetry recorded yet`,
`No hooks or runtime events recorded yet`, `No native metrics observed`)
and the loading/placeholder/empty colspan rows that show before the first
response arrives are not counted as populated rows: those branches clear the
footer directly and only reach the helper once real data rows have been
rendered.



The Hooks table combines native tool calls, hook runs (`codex.hooks.run` and
its duration histogram), thread starts, and multi-agent spawns. The Type and
Name columns distinguish these event families, while rows are grouped by
sanitized hook/source/handler labels where available; thread and spawn totals
are shown as rows rather than duplicated in a subtitle.
`codex.turn.token_usage` and native turn counters remain inventory-only because
the router already derives token and turn totals from lifecycle logs.

The current OTLP field mapping for this table is: tool rows use
`codex.tool.call` and `codex.tool.call.duration_ms`, with `tool` as the name
(`toolName` and `tool_name` are accepted spellings), `source` as the source,
server metadata from `server`, `mcp_server`, `serverName`, or `server_name`,
and `success` (`true`/`false`, sometimes string-encoded by OTLP) for the
status bucket. Hook rows use
`codex.hooks.run` and `codex.hooks.run.duration_ms`, with `hook_name`,
`source`, `handler_type`, and `status`. A missing or non-applicable server/handler is rendered as
`-`; the router never infers a server from a tool name, and real API values are
preserved.

The router persists these OTEL aggregates in a versioned `otelTelemetry` section
of `$CODEX_HOME/codex-router-state.json`. It also persists hashed cumulative
series cursors so a restart does not count the next cumulative export twice.
Session IDs, raw attributes, prompts, tool arguments, paths, and queries are
not written to the state file. Active sessions and in-flight requests remain
process-local and are intentionally reset on restart.

The current OTEL persistence schema is version 2. Old aggregates written with
the previous attribution schema are not migrated. To remove incorrectly
attributed aggregates, reset the persisted `otelTelemetry` section (or remove
the state file when a full telemetry reset is acceptable) and restart the
router; refreshing the dashboard alone does not clear persisted data. The
restart is required for the router to load the new schema and write a clean
snapshot.

Skill metrics may use cumulative or delta OTLP temporality. For cumulative
points, Codex resends the running total on every export, so the router tracks
only the retained skill-context series (metric name, attributes, and
`startTimeUnixNano`) and applies the delta; delta points are applied once per
export timestamp. Both forms tolerate duplicate resends and counter resets.
`codex.skill.injected` carries the modern `skillName` and `status` attributes;
older Codex versions may use `skill` or `skill_name`. The router accepts all
three spellings and uses `unknown` only when none is present. Some Codex
versions attach `invoke_type` instead of, or alongside, `status`, which the
router tolerates and aggregates separately. The source-backed
`codex.thread.skills.description_truncated_chars` metric is not currently in
the official catalog; when present, the router totals and averages it
separately.

The [official OpenAI Codex skills documentation](https://developers.openai.com/codex/skills)
describes explicit `$skill`
invocation and implicit prompt-based selection, but does not document the
`codex.skills.shadow_selection.*` metric family. The upstream Codex source
provides stronger evidence about its meaning: [PR #39008](https://github.com/openai/codex/pull/39008)
adds `task_context_fusion_v1` to the existing shadow-selection experiment, and
the source labels the module “temporary” and says it “should be removed after
evaluation” ([source](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/ext/skills/src/shadow_selection_experiment/mod.rs#L1-L1)).
Most importantly, the public `SkillsExtensionConfig` comment defines
`shadow_selection_enabled` as “Whether cheap skill selectors run in shadow mode
without changing prompt contents” ([source](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/ext/skills/src/config.rs#L14-L15)).

This distinction matters for telemetry. The shadow family measures selector
experiments: catalog size, selected-entry size, query-term count, reduction,
and selector duration. Its `.invocation` metric is an evaluation signal: the
source records actual implicit invocations to test whether each selector would
have ranked the invoked skill (`hit`/`rank`), and increments once per selector
method ([source](https://github.com/openai/codex/blob/21cfd369efca2df70c904c580b2e7e2e3eddb3c3/codex-rs/ext/skills/src/shadow_selection_experiment/mod.rs#L232-L266))—not a total of skills used. The router therefore ignores the entire
family, including the bare `codex.skills.shadow_selection` name emitted by
current Codex builds, its older dotted sub-metric names, native metric inventory,
and persisted cumulative cursors. The dashboard separates skill context injection from actual activation. The
`codex.skill.injected` table reports injected context outcomes; explicit
`invoke_type=explicit` events populate `skills.used` and
`usage.byWorkspace[*].skillUses`. Implicit selection, exposure, and skipped or
failed injection events do not count as actual uses.

The table also shows root-vs-subagent agent kind, model, and plugin where native
metadata is present. Agent kind is derived from `session_source`: a
`subagent_thread_spawn_*` source is `subagent`, other non-empty sources are
`root`, and missing metadata is `unknown`. The Skill context telemetry table
exposes retained turn-duration and enabled/kept/truncated/description-
truncation aggregates. These thread-level histograms do not provide a reliable
skill-name dimension, so the router does not invent per-skill availability
counts. No prompt or skill content is exported or stored; only metric
attributes and numeric aggregates are retained.

These are Codex-native metrics, not a generic audit stream for every provider
behind the router. `skillContextsInjected` measures context loading, while
`skillUses` measures explicit activations and verified `SKILL.md` reads. A
`PreToolUse` hook (`scripts/codex/skill-read-telemetry.mjs`) recognizes only
canonical `SKILL.md` reads under the approved skill roots, deduplicates each
skill once per turn, and sends a privacy-safe `skill_used` event correlated to
the parent session. It never records skill contents, prompts, command text, or
absolute paths. The hook fails open and the router fails closed when the
session cannot be attributed to a workspace. Exposure, prompt mentions, and
arbitrary files do not count as uses. Exposure is not discarded, though: a
bridge `skill_exposed` event (a role contract or plugin making a skill
available to a session) is recorded separately as
`status.usage.byWorkspace[*].bridgeSkills`, rendered in the workspace's
"Skills exposed" section, distinct from and never added into `skillUses` or
`bySkill`.

The dashboard labels MCP state as an observation (`ready`, `error`, or `stale`),
not as an authoritative process-health guarantee. Codex currently emits MCP
lifecycle spans rather than a persistent MCP health gauge. The router continues
to own provider selection, fallback, cooldown, concurrency, and origin
telemetry because Codex does not emit those AutoDev-specific semantics.

The dashboard's route cards show **observed** MCP counts, not `ready` counts.
An `observed` count measures the number of unique MCP server names observed
through lifecycle spans in that route or partition scope; repeated lifecycle
spans do not inflate it. In contrast, `ready` counts only servers whose most
recent lifecycle observation was successful and occurred within the freshness
TTL (`OTEL_HEALTH_TTL_MS`). In the Operational summary, the ratio of ready to
observed servers is displayed as operational health context (`MCP ready / observed`).

Both route cards apply role-specific union semantics using `/status` partitions:
- The **Orchestrator** card displays the unique observed-server union for the orchestrator role.
- The **Subagents** card displays the unique observed-server union across explicit subagent roles.
- If the native stream has no explicit role attribution, both cards fall back to the global observed count instead of displaying a misleading zero; the unattributed/unknown partition remains visible in `/status`.

MCP server entries (`status.codexTelemetry.mcpServers`) and summaries
(`status.codexTelemetry.mcpSummary`) are partitioned into independently
aggregated buckets:
- `byRole`
- `byWorkspace`
- `byModel`
- `byAgent`

Each bucket retains `observed`, `ready`, `error`, `stale`, and `lastSeenAt`.
At the workspace granularity, `status.usage.byWorkspace[*].byMcp` provides
workspace-level MCP breakdown, following the same fail-closed semantics as
`byTool` and `bySkill`. Existing model views embed model-level MCP counts and
server breakdowns directly without creating a standalone MCP panel.

When resolving context across MCP, tool, hook, skill, and bridge telemetry,
the router applies canonical precedence in this order:
1. Explicit event or resource attributes
2. Verified provider bridge / request context
3. Verified `conversation.id` -> session/thread-state join
4. `unattributed` fallback

Ownership is never inferred from static MCP configuration, ambient active
requests, tool names, or concurrent activity. Native Codex events that lack
causal metadata are attributed to explicit `unattributed` dimensions rather
than guessed. MCP lifecycle spans that lack a verified conversation or request
identity remain globally observed in `mcpSummary` and `mcpServers`, but are
not assigned to a role, workspace, model, or agent. The same canonical context partitions are exposed under
`status.codexTelemetry.dimensions` for `mcp`, `tools`, `hooks`, `skills`, and
`bridge` telemetry. These are event-count dimensions (not unique-server
counts), and every family carries the same `byRole`, `byWorkspace`, `byModel`,
and `byAgent` keys with `lastSeenAt` timestamps.

Strict privacy guarantees
are preserved: prompts, credentials, absolute filesystem paths, and unbounded
raw identifiers are excluded from telemetry.

Validate the active rules and telemetry receiver without running a model turn:

```bash
codex execpolicy check --pretty \
  --rules /Users/henrykirk/AutoDev/scripts/codex/rules/default.rules \
  -- git status
curl --silent http://127.0.0.1:4100/status | jq '.codexTelemetry'
```
