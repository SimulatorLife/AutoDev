# AutoDev Observability Target State

## Goal

Use a standard, OpenTelemetry-native observability architecture with minimal custom infrastructure.

AutoDev should emit normal OpenTelemetry telemetry using established semantic conventions wherever possible. OpenLIT should consume that telemetry directly and provide storage, aggregation, tracing, analytics, and dashboards without AutoDev-specific adapters, transformations, or duplicate observability systems.

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