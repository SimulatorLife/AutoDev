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
8. **Recent routing events**.

Panels, badges, metric bars, outcome bars, row toggles, and stat cards are
custom elements. Live labels are escaped before HTML insertion, while event
logs, metadata, and errors use text-only DOM updates. MCP lifecycle observations
are shown in the relevant usage cards and operational summary; there is no
standalone MCP panel.

Per-workspace usage currently has reliable totals, role, and model dimensions.
The status contract does not provide named tool or named skill attribution at
that same workspace granularity. Expanded workspace rows therefore show the
explicit empty states **“Named tool telemetry is unavailable per-workspace”**
and **“Named skill attribution is unavailable per-workspace”**, rather than
inventing a join from unrelated telemetry.

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
`usage.byRole` -- the bare `unattributed` key is roleless orchestrator traffic,
which the dashboard renders as the Orchestrator row. The line above the usage
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
`codex.skills.shadow_selection.*` metric family. The metric names and values
show that family is selector instrumentation: catalog size, selected-entry
size, query-term count, reduction, selector duration, and a shadow-selector
invocation count. None is a reliable count of a skill being loaded or used by
the task. The router therefore ignores the entire family, including its native
metric inventory and persisted cumulative cursors. The dashboard's Skills
table reports `codex.skill.injected` context outcomes only; it does not label
shadow-selection activity as skill invocations.

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
behind the router. A zero `codexTelemetry.skills.injected` value means that no
Codex skill-context injection metric was received; it does not prove that no
skill was available or used.

The dashboard labels MCP state as an observation (`ready`, `error`, or `stale`),
not as an authoritative process-health guarantee. Codex currently emits MCP
lifecycle spans rather than a persistent MCP health gauge. The router continues
to own provider selection, fallback, cooldown, concurrency, and origin
telemetry because Codex does not emit those AutoDev-specific semantics. The
dashboard's `MCP ready` count is the number of servers with a recent successful
lifecycle observation, not a count of statically enabled servers or a guarantee
that every server is currently connected. The per-origin and per-role tables
remain router-owned request telemetry; OTEL does not provide a reliable
conversation-to-origin/role join for those rows.

Validate the active rules and telemetry receiver without running a model turn:

```bash
codex execpolicy check --pretty \
  --rules /Users/henrykirk/AutoDev/scripts/codex/rules/default.rules \
  -- git status
curl --silent http://127.0.0.1:4100/status | jq '.codexTelemetry'
```
