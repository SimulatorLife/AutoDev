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
- The last ten agent PR links with creation timestamps (minute precision).
- PRs closed by the centralized stale-empty janitor.

Provider workflows include the target repository in their run name so new
invocations can be attributed without scraping every PR comment. Runs created
before that instrumentation are retained in the provider totals but appear in
the `unattributed` bucket when a target cannot be recovered. The dashboard is a
rolling operational view rather than a permanent audit ledger; use the retained
artifacts for recent raw snapshots.
