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

The dashboard's visible Operational summaries table groups Codex receiver,
state-database, and concurrency values as category/metric/value rows instead of
embedding those values in prose. The detailed Codex telemetry, Skills, Skill
catalog/context, and Native runtime telemetry sections are collapsed by default
and can be expanded independently; the observed metric inventory, Codex tasks,
and recent routing events retain the same collapsible behavior.

Totals footers are shown for homogeneous roll-up tables: provider/usage,
MCP lifecycle, Skills injections, native runtime calls, observed metric counts,
and spawn-failure reasons. The Operational summary and Skill catalog/context
tables intentionally do not have totals because their rows mix incompatible
units; the Codex task snapshot and recent-event list are entity/event views
rather than additive measurements.



Hook runs (`codex.hooks.run` and its duration histogram) are shown in the
Native runtime telemetry section alongside native tool calls, grouped by
sanitized hook/source/handler labels.
Native thread starts and multi-agent spawn counters are shown there with
low-cardinality source, role, and model breakdowns where Codex supplies them.
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

The Skills table breaks injected totals down by skill, share of all injections,
outcome status, invocation type, root-vs-subagent agent kind, model, and
plugin. Agent kind is derived from the native `session_source` metadata: a
`subagent_thread_spawn_*` source is classified as `subagent`, other non-empty
sources as `root`, and missing metadata as `unknown`. This does not identify the
human who selected a skill or recover the exact child role/thread. A separate
Skill catalog & context histograms table shows the thread-level sample count,
total, and average for enabled, kept, truncated, and description-truncation
metrics; these histograms are intentionally not attributed to individual skills
because Codex does not provide a reliable skill dimension on them. The
shadow-selection metrics remain in the observed inventory until their schema
and dimensions are validated for safe aggregation. No prompt or skill content
is exported or stored; only metric attributes and numeric aggregates are
retained.

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
