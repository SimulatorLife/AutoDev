# AutoDev Console — UI and Control-Plane Reference Projects

## Goal

Build an AutoDev-centric control and observability console on top of the OpenLIT foundation without inventing established interaction patterns unnecessarily. Keep OpenLIT's OpenTelemetry ingestion, storage, querying, traces, metrics, logs, and dashboard primitives, while borrowing proven control-plane concepts from projects that already manage models, providers, MCP servers, capabilities, targeting, and desired runtime state.

## Recommended references

| Project | Use it for | What AutoDev should take |
|---|---|---|
| **OpenLIT** | Observability foundation | Keep OTel ingestion, ClickHouse/query infrastructure, traces, metrics, logs, dashboards, cost/usage analysis, and the Controller's desired-state/action pattern. The current Controller already discovers workloads, receives configuration/actions, applies instrumentation/lifecycle changes, and reports actual state. |
| **LiteLLM** | **Providers, Models, MCP Servers** | Primary reference for the control-plane resource model: provider/model catalogs, model deployments, routing/fallbacks, MCP registration, access, and centralized management. LiteLLM explicitly treats LLMs, MCP servers, and agents as resources of one control plane. |
| **LangWatch** | **Overall unified product UX** | Primary reference for combining observability and operational controls in one AI-focused interface. Study its coding-agent monitoring, gateway, virtual keys, budgets, routing, governance, and provider configuration rather than separating analytics and administration into unrelated products. |
| **MCPJam Inspector** | **MCP detail/debugging UI** | Use its server-centric treatment of tools, resources, prompts, authorization, JSON-RPC activity, traces, testing, and evaluation when designing AutoDev's MCP Server detail pages. |
| **Unleash** | **Skills and role-scoped enablement** | Borrow the feature-management mental model: enabled/disabled state plus targeting rules, constraints, strategies, kill switches, and scoped activation. Map this to skills enabled for particular agent roles/workspaces rather than treating skill availability as a simple global Boolean. |
| **Argo CD** | **Desired vs. actual state** | Borrow its clear distinction between desired state, observed/live state, health, pending operations, drift, convergence, and history. Apply this pattern to provider, model, MCP, skill, and runtime configuration. |
| **Backstage** | **AutoDev module architecture** | Reference its plugin/extension architecture so Providers, Models, MCP, Skills, Agents, Workspaces, and Telemetry remain cohesive modules rather than accumulating inside a monolithic settings page. |

## Recommended AutoDev information architecture

```text
AutoDev
├── Overview
├── Usage
├── Agents
├── Providers
├── Models
├── MCP Servers
├── Skills
├── Workspaces
├── Routing
├── Telemetry
│   ├── Traces
│   ├── Metrics
│   └── Logs
└── Settings
```

Treat each top-level resource as both a **control surface and an observability surface**. Keep the underlying data paths separate, but compose them together in the UI.

For example, a Provider page should combine:

```text
Provider: Anthropic

Configuration                  Runtime / Observability
────────────────────           ─────────────────────────
Enabled                        Actual state / health
Allowed agent roles            Requests
Available models               Tokens
Priority / routing             Cost
Fallbacks                      Failure rate
Concurrency                    Recent traces
```

Configuration comes from the **AutoDev Control API**; operational history comes from **OpenLIT/OTel**.

## Resource-specific guidance

**Providers + Models — LiteLLM first, LangWatch second.** Model provider availability, individual model enablement, routing priority, fallbacks, concurrency and role availability should look and behave like first-class managed resources rather than environment-variable configuration.

**MCP Servers — MCPJam + LiteLLM.** Give each server an overview plus Configuration, Tools, Resources, Prompts, Role Access, Activity and Logs/Errors. Show connection status and actual capabilities separately from desired enablement.

**Skills — Unleash + OpenLIT.** Model the lifecycle as `Enabled → Eligible → Selected → Injected → Used`. Configuration should support role/workspace targeting; OpenLIT telemetry should provide historical selection, use, effectiveness and error data.

**Agents — OpenLIT Controller + Argo CD.** Explicitly expose desired state versus actual state and pending convergence. A toggle should not falsely imply an instantaneous mutation.

```text
Skill: codebase-context

Desired     Enabled for reviewer
Actual      Enabled
Health      Healthy
Last sync   12s ago
Usage 7d    327 runs
```

**Overall UI — LangWatch + OpenLIT.** Avoid creating a separate admin application alongside an observability application. AutoDev should feel like one product in which configuration, live state and historical evidence are different views of the same resource.

## Implementation principle

Use these projects as **interaction-model and architecture references**, not as dependencies that AutoDev must adopt wholesale. Prefer reusing OpenLIT's existing components and infrastructure where they fit; implement AutoDev-specific functionality as isolated TypeScript modules and APIs. Only copy source code when its license and dependency boundary have been reviewed explicitly.

The target is not “OpenLIT plus an AutoDev settings page.” It is:

> **An AutoDev control and observability console built on OpenLIT's telemetry foundation, using LiteLLM's resource-management concepts, LangWatch's unified AI-operations UX, MCPJam's MCP inspection model, Unleash's scoped capability controls, Argo CD's desired-state semantics, and Backstage's modular product architecture.**