---
name: opentelemetry
description: Use when implementing, reviewing, or debugging OpenTelemetry instrumentation, OTLP transport, Collector configuration, semantic conventions, traces, metrics, logs, attribution, or telemetry quality. Apply project-specific architecture from its owning documentation.
---

# OpenTelemetry

Use OpenTelemetry as a standard telemetry transport and interoperability layer. Keep domain-specific semantic truth at the operation-owning producer. Where a project has a separate control plane, keep state-changing operations in that authorized plane.

## Project architecture and authority

Identify the project's canonical observability or architecture target-state document, if one exists, using repository guidance, architecture documentation, and configuration. Read the applicable design decisions before changing telemetry, and verify them against the current implementation and dependency versions. Update the owning documentation when those decisions change.

If no canonical document exists, establish the relevant constraints from the codebase, configuration, and available project guidance. Do not invent an architecture, backend, migration plan, or documentation layout. This skill supplies reusable OpenTelemetry engineering guidance, not a competing source of project-specific architecture.

## Ownership boundaries

- Prefer standard OpenTelemetry protocols, APIs, SDKs, semantic conventions, and Collector components over custom equivalents.
- Keep ingestion, storage, query execution, and dashboards with the configured observability backend; do not introduce a competing generic historical aggregator.
- Instrument operations and context at their actual owner. Keep domain-specific runtime/control semantics in the owning application.
- Prefer the configured backend's supported OTLP receiver; add an intermediate Collector only for a documented policy or processing need.
- Keep configuration mutations with their authorized owner. Telemetry is observation-only; use a separate control plane when the project's architecture calls for one.
- A custom event/control channel may remain authoritative when it provides lifecycle, authorization, or state semantics OTel cannot provide. Do not force OTel to become a command protocol.

## Semantic conventions

- Prefer established OpenTelemetry semantic conventions, including `gen_ai.*` and MCP conventions, before defining application-specific attributes.
- Define custom namespaced attributes only for domain concepts without a suitable standard; document their semantics in the owning contract.
- Never fabricate an attribute because a schema has a field; derive values from observed inputs, outputs, owned state, or validated correlation.
- Treat telemetry schemas as versioned contracts and avoid permanent aliases or competing sources of truth.

## Attribute placement

| Scope                   | Use                                              |
| ----------------------- | ------------------------------------------------ |
| Resource                | Stable producer/runtime identity and environment |
| Span                    | One operation or unit of work                    |
| Span event / log record | Point-in-time observation                        |
| Metric data point       | Bounded, low-cardinality aggregation dimensions  |

Do not promote request-, session-, trace-, conversation-, path-, or other high-cardinality identifiers into metric dimensions. Use trace/span/log context for per-session investigation.

Use the project's shared metric-label bounding implementation where one exists; do not duplicate it.

## Instrumentation

- Instrument the component that actually owns each operation.
- Keep span boundaries around one meaningful operation.
- Preserve trace/context propagation across service, process, transport, and other execution boundaries where technically possible, including agent and tool boundaries when applicable.
- Avoid duplicate instrumentation of the same operation at multiple layers.
- When emitting first-class OTel, use the official OpenTelemetry API/SDK rather than hand-building OTLP payloads.
- Do not add an OTel SDK merely to re-express telemetry already emitted correctly by an upstream component.

## Telemetry quality

- Keep span names and metric dimensions low-cardinality and stable.
- Never export secrets, credentials, raw prompts, responses, tool arguments, or other sensitive content unless explicitly required and safely designed.
- Prefer identifiers and categorical metadata over captured content; redact or normalize sensitive/high-cardinality data before export.
- Distinguish unknown or unattributed from zero; absence of evidence is not evidence of absence.
- Preserve source timestamps and stable identities where needed for deduplication, retries, and out-of-order delivery.
- Telemetry must not break or materially delay the instrumented operation.

## Collector rules

- Keep Collector configuration minimal and purpose-driven.
- Follow the project's configured OTLP receiver and Collector ownership; justify additional hops with concrete needs such as redaction, routing, or fan-out.
- Do not put domain-specific semantic translation in a Collector merely to accommodate a backend or UI.
- Validate component stability and exact pinned versions separately from configuration syntax.
- Avoid processing the same signal independently at multiple tiers when doing so can double-count or change meaning.

## Review checklist

When changing telemetry, verify:

1. The owning layer is correct: producer, receiver/Collector, configured observability backend, or authorized control plane.
2. Existing OTel conventions are reused before introducing custom attributes.
3. Attribute scope and cardinality are appropriate.
4. Values come from evidence rather than inference or placeholders.
5. Retries, redelivery, and cross-signal ordering cannot double-count or permanently misattribute data.
6. Privacy-sensitive content is excluded or explicitly protected.
7. The change does not introduce a second source of truth or redundant telemetry path.
8. Domain-specific semantics remain testable independently of transport.
9. Raw telemetry remains distinguishable from any producer-side enrichment.
10. Dashboards consume canonical telemetry and never recreate control or attribution logic.

## Architectural preference

`producer → standard OTLP → configured receiver → observability backend`

Where a separate control plane exists: `authorized client → control interface → state owner`.

The telemetry path observes; the control path authorizes and changes state. Apply the project's documented architecture; no particular backend, control-plane implementation, or repository layout is required.
