# AutoDev Observability & Metrics Runbook

The incumbent local router dashboard (`/dashboard`) was decommissioned in Milestone M6 of the observability migration. AutoDev metrics, traces, prompt synchronization, agent cataloging, and operational controls are now consolidated under the OpenLIT stack and the AutoDev Control API.

The canonical architecture, data boundaries, and verification ledger live in [docs/observability-target-state.md](observability-target-state.md).

---

## 1. OpenLIT Observability Stack

The local OpenLIT stack runs via Docker Compose (`openlit` and `openlit-clickhouse`) and provides unified observability across all model providers, subagents, tools, and skills:

| View / Function            | URL                                                                                        | Description                                                                                                                                                                                                                                                                                                                                                   |
| :------------------------- | :----------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Usage Board**            | [http://localhost:3000/dashboards/usage](http://localhost:3000/dashboards/usage)           | Real-time usage analytics across 11 widgets (requests, tokens, latency, cost, and 4 dedicated MCP tool widgets) with parameterized workspace, provider, model, and role filters.                                                                                                                                                                              |
| **Prompt Hub**             | [http://localhost:3000/prompt-hub](http://localhost:3000/prompt-hub)                       | Canonical rulesync commands synced from `.rulesync/commands` into ClickHouse (`openlit_prompts` and `openlit_prompt_versions`).                                                                                                                                                                                                                               |
| **Agents Hub**             | [http://localhost:3000/agents](http://localhost:3000/agents)                               | Rulesync agent roles synced with their tools, skills, models, and system prompts into ClickHouse (`openlit_agents_summary` and `openlit_agent_versions`).                                                                                                                                                                                                     |
| **Organisation & Project** | [http://localhost:3000/organisation/projects](http://localhost:3000/organisation/projects) | Unified `SimulatorLife` organisation and canonical `AutoDev` project in `production`. Workspaces (`SimulatorLife/AutoDev`, `SimulatorLife/RacingGame`, `SimulatorLife/Colourful-Life`, etc.) are represented as standard OpenTelemetry analytical attributes (`autodev.workspace`), enabling macro rollups and micro drilldowns without data isolation silos. |
| **Costs & Models**         | [http://localhost:3000/costs?tab=models](http://localhost:3000/costs?tab=models)           | Canonical AutoDev model catalog (25 models across 6 providers) and token pricing synced to ClickHouse (`openlit_provider_metadata` and `openlit_provider_models`).                                                                                                                                                                                            |
| **Traces & Spans**         | [http://localhost:3000/traces](http://localhost:3000/traces)                               | OpenTelemetry spans emitted by the router and MCP shims via OTLP/HTTP (`http://127.0.0.1:4318/v1/traces`).                                                                                                                                                                                                                                                    |

### Stack Lifecycle

```bash
# Start or restart OpenLIT stack
bash scripts/openlit/up.sh

# Stop OpenLIT stack
bash scripts/openlit/down.sh

# Re-synchronize Prompts, Agents, Models, and Workspaces out of band
pnpm openlit:sync-prompts
pnpm openlit:sync-agents
pnpm openlit:sync-models
pnpm openlit:sync-workspaces
```

---

## 2. AutoDev Control API

The AutoDev Control API exposes typed operational views and provider-role policy mutations over a dedicated listener on port `4101`:

- **Providers**: `GET /control/providers` (and UI at `http://localhost:3000/autodev/providers`)
- **MCP Servers**: `GET /control/mcps` (and UI at `http://localhost:3000/autodev/mcps`)
- **Skills**: `GET /control/skills` (and UI at `http://localhost:3000/autodev/skills`)
- **Runtime**: `GET /control/runtime` (and UI at `http://localhost:3000/autodev/runtime`)
- **Workspaces**: `GET /control/workspaces`

Security requirements:

- All requests require the bearer token from `$CODEX_HOME/openlit-secrets.env` (`AUTODEV_CONTROL_API_TOKEN`).
- Caller identity must be asserted via `X-AutoDev-Actor` and match configured `AUTODEV_CONTROL_VIEWERS` or `AUTODEV_CONTROL_OPERATORS` in `$CODEX_HOME/.env`.
- Mutations (`PATCH /control/providers/:provider/roles/:role`) require the `operator` role and produce an audited OpenTelemetry mutation span.

---

## 3. GitHub Issue Metrics

The asynchronous GitHub metrics workflow remains active for tracking PR throughput and agent invocation metrics:

- Workflow: `.github/workflows/metrics-dashboard.yml`
- Issue tracking: [AutoDev Metrics Dashboard issue](https://github.com/SimulatorLife/AutoDev/issues/2)
- Engine: `src/telemetry/github-metrics.ts`
