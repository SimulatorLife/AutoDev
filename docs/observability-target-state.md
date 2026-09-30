# AutoDev Observability Target State

## Problem statement

AutoDev currently risks owning too much custom observability and control UI instead of relying on standard telemetry and an established AI-first platform. The goal is to avoid bespoke metrics schemas, backends, adapters, and duplicate dashboards while still supporting AutoDev-specific runtime controls.

## Goal / Target State

Use a standard, OpenTelemetry-native observability architecture with minimal custom infrastructure. AutoDev should emit standard traces, metrics, and logs over OTLP using official OpenTelemetry GenAI/MCP semantic conventions wherever possible, while OpenLIT serves as the primary observability backend and UI for storage, aggregation, tracing, analytics, and dashboards without AutoDev-specific adapters, transformations, duplicate telemetry models, or parallel observability systems. AutoDev-specific runtime controls should be limited to a small TypeScript control API and a thin OpenLIT UI extension.

## Target Architecture

```text
AutoDev / Agents / Providers / Tools / MCP
                  │
                  │ Standard OTLP
                  ▼
       OpenTelemetry Collector
                  │
                  │ Standard OTLP
                  ▼
               OpenLIT
                  │
                  ▼
             OpenLIT UI
```

The Collector may be the one bundled with OpenLIT if it satisfies the required deployment and configuration needs.

## Telemetry

Emit standard OpenTelemetry **traces, metrics, and logs**.

Prefer official OpenTelemetry semantic conventions, especially:

- `gen_ai.*` for models, agents, inference, tokens, and tool execution.
- OpenTelemetry MCP conventions for MCP clients, servers, sessions, and operations.
- Standard service, deployment, error, duration, and resource attributes.

Examples include:

```text
gen_ai.operation.name
gen_ai.provider.name
gen_ai.request.model
gen_ai.agent.name
gen_ai.agent.id
gen_ai.conversation.id
gen_ai.tool.name

gen_ai.client.operation.duration
gen_ai.client.token.usage
gen_ai.invoke_agent.duration
gen_ai.invoke_agent.tool_calls
gen_ai.execute_tool.duration

mcp.client.operation.duration
mcp.server.operation.duration
mcp.client.session.duration
mcp.server.session.duration
```

Use custom `autodev.*` telemetry only when AutoDev represents a concept for which no suitable standard semantic convention exists.

Avoid placing high-cardinality identifiers such as request IDs, trace IDs, session IDs, full paths, or URLs on normal metric dimensions. Keep those in traces and logs where appropriate.

## Agent Model

Represent orchestration using normal trace relationships.

An orchestrator invocation, subagent invocation, model operation, and tool execution should form a trace hierarchy such as:

```text
invoke_agent orchestrator
├── invoke_agent implementation
│   ├── model operation
│   ├── execute_tool GitHub
│   └── execute_tool LSP
├── invoke_agent reviewer
└── invoke_agent validator
```

Each operation should own its own duration, token usage, tool calls, errors, and other telemetry rather than relying on inferred or duplicated accounting.

## OpenTelemetry Collector

The Collector is the standard telemetry boundary.

It should handle normal observability concerns such as:

- OTLP ingestion
- batching
- filtering
- sampling
- redaction
- routing
- retries
- exporter configuration

It should not contain AutoDev-specific semantic translation merely to make OpenLIT understand the data.

AutoDev should emit telemetry that is already semantically correct.

## OpenLIT

Use OpenLIT as-is as the observability backend and UI.

OpenLIT should provide:

- telemetry persistence
- trace exploration
- agent and LLM analytics
- model usage
- token usage
- cost analysis where available
- tool usage
- latency and duration analysis
- error analysis
- filtering and historical queries
- dashboards and visualizations

AutoDev should not duplicate these capabilities with a custom analytics backend or custom observability dashboard.

## AutoDev Responsibilities

AutoDev should own:

- correct instrumentation
- semantic context
- agent relationships
- provider/model attribution
- tool and MCP instrumentation
- domain-specific telemetry that cannot be represented by standard conventions
- operational control-plane APIs where live runtime state is not appropriately modeled as observability data

AutoDev should not own:

- observability storage
- historical telemetry databases
- generic telemetry aggregation
- trace exploration
- analytics infrastructure
- generic charting
- an alternative observability UI

## Principle

**Standard OpenTelemetry is the contract. OpenLIT is the consumer. AutoDev remains independent of the observability backend.**

The ideal result is:

```text
standard instrumentation
        ↓
standard OTLP
        ↓
standard OpenTelemetry Collector
        ↓
OpenLIT unchanged
        ↓
OpenLIT UI
```

No custom observability protocol, no parallel telemetry model, no AutoDev-specific OpenLIT adapter, no custom backend, and ideally no custom observability dashboard.

## Telemetry/Metric Requirements

1. Ability to track/scope/filter metrics to a specific:
  1. Agent/subagent role/name/ID
  2. Model provider (e.g. Claude, OpenAI, LLaMA, etc.)
  3. Model (e.g. `claude-opus-5-5`, `gpt-4o`, `llama-2-70b-chat-hf`, etc.)
  4. Session ID
  5. Workspace (e.g. repo/project/codebase/path)
  6. Time (start/end timestamps, duration)
  7. MCP server (if applicable, e.g. if it is a tool call)
  8. Root/orchestrator agent versus subagent

As/if all metrics have all these dimensions, it should be possible to filter and aggregate metrics by any combination of these dimensions.

Ex.
- "What is the total token usage for all agents using `claude-opus-5-5` in workspace `foo` over the last 24 hours?"
- "What is the average tool execution duration for all agents in session `abc123`?"
- "What is the error-rate for all agents of type `reviewer`?"
- "What is the per-session skill usage rate for provider `Antigravity`?"
- "What is the token usage today?"
- "Does agent `browser-tester` have access to MCP server `Playwright`? Is it using it? Are those calls succeeding or failing?"
- "How many subagents does an `orchestrator` agent using model `gpt-6-sol` spawn on average per session?"

- Tracking/metrics/telemetry for:
  - Agent invocation duration
  - Model operation duration
  - Tool execution duration
  - Token usage (input, output, total)
  - Tool calls (count)
  - Errors (count, type, context)
  - Skills (skills exposed/available/enabled, skill usage)
  - MCP servers (available/exposed/enabled, uses, duration, errors)
  - Session lifecycle (start, end, duration, errors)
  - Diff (lines added, lines removed, files changed, etc.)
  - Commits & pushes (count, duration, errors)


# OpenLIT extensions, maintained locally by AutoDev

## Summary
Make OpenLIT the observability UI and backend, while AutoDev retains a separate control plane. Maintain the small OpenLIT extensions AutoDev needs locally from the start; upstreaming them is optional and must never block adoption. Keep the rest of OpenLIT as close to stock as possible.

## UI and extension boundaries
- Keep OpenLIT’s stock observability and dashboards. Add an **AutoDev Usage** dashboard for tokens, model requests, cache-read rate, and cost where available; do not add a separate Analytics page. Add Provider, MCP, and Skills *observability* through stock dashboards and trace views.
- Implement dashboard-wide variables as a **generic OpenLIT UI extension**: time, workspace, provider, model, and agent/role; value sources, All and multi-select, URL/dashboard state, and safe parameterized bindings. Variables apply only to widgets that declare them and use the shared telemetry schema—not AutoDev-specific field assumptions.
- Isolate AutoDev-specific pages under `/autodev`: **Providers**, **MCPs**, **Skills**, and **Runtime Controls**. These expose current configuration, availability, and actions; historical usage and operation analysis stay in OpenLIT’s stock observability surfaces.
- Keep the OpenLIT query engine, storage, and telemetry semantics unchanged. Maintain a pinned, AutoDev-owned OpenLIT fork/patch set with changes confined to the generic variable extension and `/autodev` modules/routes. An upstream contribution may be made independently.

## Data and control flow
- Emit standard GenAI/MCP OpenTelemetry from the components that own each operation; route OTLP through the Collector to OpenLIT. Define workspace and role attribution in the shared instrumentation schema, not in UI-specific adapters.
- Count model operations separately from provider attempts/retries. Define cache-read rate as cached input tokens divided by input tokens; show it as unavailable when cache counts are not reported. Keep session identity in traces/logs rather than metric dimensions.
- Keep provider mutations on the AutoDev TypeScript Control API. The `/autodev` extension calls that API explicitly; telemetry and OpenLIT queries remain read-only. Keep AutoDev’s status API for live control state, but remove historical observability aggregation from it.
- After verifying cutover, retire the local dashboard and its renderer/telemetry aggregation in `/Users/henrykirk/AutoDev/src/router/dashboard.html`; update the Collector pipeline in `/Users/henrykirk/AutoDev/config/otel/collector.yaml` to export to OpenLIT. Update the observability target and dashboard/platform documentation to reflect the new ownership split.

## Tests and acceptance
- Test generic dashboard variables for value sources, All/multi-select, saved state, shared bindings, widget opt-in, and safe parameterization.
- Test telemetry dimensions, request-versus-attempt semantics, cache-rate and unavailable cases, privacy, and deduplication.
- Test that `/autodev` actions use the Control API, are authorized, and cannot be triggered through OTLP or dashboard queries.
- Verify an end-to-end Collector → OpenLIT flow and filtered views before removing the local dashboard. Do not create a permanent parallel observability path.

## Assumptions
- OpenLIT remains locally deployable; use the existing pinned Collector.
- OpenLIT history begins at cutover. Do not fabricate historical trends from AutoDev’s cumulative counters or bounded event rings.
- OpenTelemetry/UI extensions remain AutoDev-owned and usable regardless of whether upstream accepts them.