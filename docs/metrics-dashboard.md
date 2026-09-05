# AutoDev metrics dashboard

The live dashboard is maintained in the [AutoDev Metrics Dashboard issue](https://github.com/SimulatorLife/AutoDev/issues/2).
It is refreshed hourly by `metrics-dashboard.yml` and can also be run manually.
Each run also writes a step summary and uploads a 90-day JSON snapshot artifact.

The default lookback is 90 days and can be changed with the numeric
`lookback_days` dispatch input.

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
copies, not symlinks. After changing the tracked implementation, synchronize
and restart the local services before checking live telemetry:

```bash
bash /Users/henrykirk/AutoDev/scripts/codex/install-codex-integration.sh --restart
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
sanitized tool/source/server labels. Unknown metric names remain visible in
the inventory but are not interpreted until their schema and operational value
are validated.

## Subagents spawned

The **Subagents spawned** table is the one place that counts every subagent
behind the router, whichever provider spawned it. It is fed by
`status.subagents`, not by OTEL: Codex's `codex.multi_agent.spawn` metric only
covers Codex-exported threads, and `usage.byRole` only covers subagents that
made a router request at all.

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
so it appears here and in `subagents.byRole` but contributes no turns to
**Usage by orchestrator and subagents** -- an orchestrator that delegated
entirely inside its CLI still shows exactly one model's usage there. See
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

The dashboard's Operational summary table groups Codex receiver,
state-database, and concurrency values as category/metric/value rows instead of
embedding those values in prose. Each table section has one heading that also
owns its collapse toggle. The primary Provider health and usage, Usage by
orchestrator and subagents, MCP server telemetry, Skills, and Hooks tables are
expanded by default; the combined Skill selection/context table is visible
inside Skills, while secondary metric inventory, spawn-failure, task, and
recent-event sections can be expanded independently. The Subagents spawned
table is also expanded by default and sits directly above the spawn-failure
section, so observed spawns and the failures that prevented them read together.

Totals footers are shown for homogeneous roll-up tables: provider/usage,
MCP lifecycle, Skills injections, hook/runtime calls, observed metric counts,
and spawn-failure reasons. The Operational summary and combined Skill
selection/context table intentionally do not have totals because their rows
mix incompatible units; the Codex task snapshot and recent-event list are entity/event views rather than additive
measurements.



The Hooks table combines native tool calls, hook runs (`codex.hooks.run` and
its duration histogram), thread starts, and multi-agent spawns. The Type and
Name columns distinguish these event families, while rows are grouped by
sanitized hook/source/handler labels where available; thread and spawn totals
are shown as rows rather than duplicated in a subtitle.
`codex.turn.token_usage` and native turn counters remain inventory-only because
the router already derives token and turn totals from lifecycle logs.

The router persists these OTEL aggregates in a versioned `otelTelemetry` section
of `$CODEX_HOME/codex-router-state.json`. It also persists hashed cumulative
series cursors so a restart does not count the next cumulative export twice.
Session IDs, raw attributes, prompts, tool arguments, paths, and queries are
not written to the state file. Active sessions and in-flight requests remain
process-local and are intentionally reset on restart.

Skill metrics may use cumulative or delta OTLP temporality. For cumulative
points, Codex resends the running total on every export, so the router tracks
the last observed point per series (metric name, attributes, and
`startTimeUnixNano`) and only applies the delta; delta points are applied once
per export timestamp. Both forms tolerate duplicate resends and counter
resets. `codex.skill.injected` carries a `skill` and `status` attribute; some
Codex versions attach `invoke_type` instead of, or alongside, `status`, which
the router tolerates and aggregates separately. The source-backed
`codex.thread.skills.description_truncated_chars` metric is not currently in
the official catalog; when present, the router totals and averages it
separately.

The Skills table separates context injections from invocation counts. The
`codex.skill.injected` totals show recognized skill injection outcomes and may
be de-duplicated by Codex within a turn; they are not a count of every operation
performed under a skill. The `Invocations` column uses the separate
`codex.skills.shadow_selection.invocation` signal when available, which is the
closer native measure for repeated skill selection/use. Injection and invocation
shares, statuses, and invoke types are kept distinct.

The table also shows root-vs-subagent agent kind, model, and plugin where native
metadata is present. Agent kind is derived from `session_source`: a
`subagent_thread_spawn_*` source is `subagent`, other non-empty sources are
`root`, and missing metadata is `unknown`. This does not identify the human who
selected a skill or recover the exact child role/thread. The combined Skill
selection & context telemetry table exposes aggregate catalog/selection
diagnostics, turn duration, and enabled/kept/truncated/description-truncation
aggregates. None of these thread-level histograms provides a reliable skill-name dimension, so the
router does not invent per-skill availability counts. No prompt or skill
content is exported or stored; only metric attributes and numeric aggregates
are retained.

These are Codex-native metrics, not a generic audit stream for every provider
behind the router. A zero `codexTelemetry.skills` value means that no Codex
skill metric was received; it does not prove that no skill was available or
used. Structured skill selections in normal Codex child threads are included
when the child exporter sends the corresponding `ResourceMetrics` batch.

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
