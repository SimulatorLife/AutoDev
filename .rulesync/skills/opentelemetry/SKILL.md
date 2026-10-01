---
name: opentelemetry
description: Defines OpenTelemetry architecture, ownership, semantic-convention, instrumentation, and telemetry-quality rules for AutoDev. Use when implementing, modifying, debugging, reviewing, or organizing OTLP ingestion, Collector configuration, telemetry attributes, traces, metrics, logs, agent/tool/skill/MCP observability, telemetry attribution, or related dashboard/status data
---

# OpenTelemetry

Use OpenTelemetry as AutoDev's standard telemetry transport and interoperability layer while keeping AutoDev-specific semantic truth at the operation-owning producer and in the separate control plane.

## AutoDev target-state pointer

`docs/autodev-console-target-state.md` is the sole source of truth for AutoDev's observability architecture, OpenLIT integration and local patch policy, dashboard variables, Control API, migration status, open gaps, acceptance evidence, and handoff. Read it before project-specific telemetry work and update it in the same change. This skill supplies reusable OTel engineering rules; it must not maintain a competing AutoDev migration plan.

## Ownership boundaries

- Prefer standard OpenTelemetry protocols, APIs, SDKs, semantic conventions, and Collector components over custom equivalents.
- The AutoDev OpenLIT distribution owns observability ingestion, storage, query execution, traces, and dashboards. Keep the observability substrate close to OpenLIT upstream while allowing the AutoDev-centric product shell, resource modules, and control surfaces defined in the target-state document.
- AutoDev owns correct instrumentation and context at the operation-owning producer, plus domain-specific runtime/control semantics. Do not build a parallel generic historical aggregator or dashboard.
- Use OpenLIT's first-party OTLP receiver by default. A separate AutoDev-owned Collector requires a concrete, documented policy need; a pass-through hop is not a target.
- Keep configuration mutations on the authenticated AutoDev Control API. Telemetry and dashboard/query paths are observation-only; mirror a completed control action into OTel only as an observation.
- A custom event/control channel may remain authoritative when it provides lifecycle, authorization, or state semantics OTel cannot provide. Do not force OTel to become a command protocol.

## Semantic conventions

- Prefer established OpenTelemetry semantic conventions, including `gen_ai.*` and MCP conventions, before defining AutoDev attributes.
- Use `autodev.*` only for genuinely AutoDev-specific concepts without a suitable standard; Skills may use a minimal `autodev.skill.*` vocabulary. Define its semantics in the target-state document before relying on it.
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

## Instrumentation

- Instrument the component that actually owns each operation.
- Keep span boundaries around one meaningful operation.
- Preserve trace/context propagation across provider, tool, subagent, MCP, and bridge boundaries where technically possible.
- Avoid duplicate instrumentation of the same operation at multiple layers.
- If AutoDev emits first-class OTel, use the official OpenTelemetry API/SDK rather than hand-building OTLP payloads.
- Do not add an OTel SDK merely to re-express telemetry already emitted correctly by Codex or another upstream component.

## Telemetry quality

- Keep span names and metric dimensions low-cardinality and stable.
- Never export secrets, credentials, raw prompts, responses, tool arguments, or other sensitive content unless explicitly required and safely designed.
- Prefer identifiers and categorical metadata over captured content; redact or normalize sensitive/high-cardinality data before export.
- Distinguish unknown or unattributed from zero; absence of evidence is not evidence of absence.
- Preserve source timestamps and stable identities where needed for deduplication, retries, and out-of-order delivery.
- Telemetry must not break or materially delay the agent operation.

## Collector rules

- Keep Collector configuration minimal and purpose-driven.
- Use OpenLIT's first-party OTLP receiver as the AutoDev target. Add a separate Collector only for a demonstrated need such as pre-export redaction, routing, or fan-out, and record that decision in `docs/autodev-console-target-state.md`.
- Do not put AutoDev-specific semantic translation in a Collector merely to accommodate a backend or UI.
- Validate component stability and exact pinned versions separately from configuration syntax.
- Avoid processing the same signal independently at multiple tiers when doing so can double-count or change meaning.

## Review checklist

When changing telemetry, verify:

1. The owning layer is correct: producer, OpenLIT's first-party OTLP receiver, OpenLIT backend, or AutoDev Control API.
2. Existing OTel conventions are reused before introducing `autodev.*`.
3. Attribute scope and cardinality are appropriate.
4. Values come from evidence rather than inference or placeholders.
5. Retries, redelivery, and cross-signal ordering cannot double-count or permanently misattribute data.
6. Privacy-sensitive content is excluded or explicitly protected.
7. The change does not introduce a second source of truth or redundant telemetry path.
8. AutoDev-specific semantics remain testable independently of transport.
9. Raw telemetry remains distinguishable from any producer-side enrichment.
10. Dashboards consume canonical telemetry and never recreate control or attribution logic.

## Architectural preference

`producer → standard OTLP → OpenLIT first-party OTLP receiver → stock OpenLIT storage/query/UI`

`OpenLIT /autodev UI → authenticated server-side proxy → AutoDev Control API → runtime/configuration`

The first path observes; the second authorizes and changes state. For AutoDev-specific decisions, migration, and progress, follow `docs/autodev-console-target-state.md`.
