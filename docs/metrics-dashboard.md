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
metrics to the model router at `127.0.0.1:4100`. `otel.log_user_prompt = false`
prevents raw prompt text from being exported. The router ingests Codex lifecycle
events and exposes them in `/status` and the local dashboard, including turn
timing, token counts, MCP server lifecycle observations,
initialization/tool-discovery latency, and recent failures.

The OTLP receiver accepts all three signal paths (`/v1/logs`, `/v1/traces`, and
`/v1/metrics`). Codex currently emits useful lifecycle logs and MCP traces but
does not emit a `ResourceMetrics` batch during the validated CLI turn, so the
metrics receiver may correctly remain at zero. The receiver counter confirms
that the endpoint is available if Codex begins emitting metrics in a later
version.

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
