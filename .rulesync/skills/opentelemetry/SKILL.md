---
name: opentelemetry
description: Defines OpenTelemetry architecture, ownership, semantic-convention, instrumentation, and telemetry-quality rules for AutoDev. Use when implementing, modifying, debugging, reviewing, or organizing OTLP ingestion, Collector configuration, telemetry attributes, traces, metrics, logs, agent/tool/skill/MCP observability, telemetry attribution, or related dashboard/status data
---

# OpenTelemetry

Use OpenTelemetry as AutoDev's standard telemetry transport and interoperability layer while keeping AutoDev-specific semantic truth in AutoDev

## Ownership boundaries

- Prefer standard OpenTelemetry protocols, APIs, SDKs, semantic conventions, and Collector components over custom equivalents
- Use the **Collector** for generic OTLP receive/process/export concerns such as batching, filtering, redaction, retry, sampling, transformation, and fan-out
- Keep **stateful/domain-specific interpretation** in AutoDev, including workspace/session joins, rollout inspection, bridge reconciliation, provider attribution, fail-closed semantics, and other logic requiring AutoDev-owned state
- Do not turn the Collector into application state, storage, or a domain-specific attribution engine
- Do not create a parallel custom telemetry path when standard OTel can express the same observation without losing required semantics
- A custom event/control channel may remain authoritative when it provides lifecycle, authorization, correlation, or state semantics that OTel alone does not provide; mirror useful observations into OTel rather than forcing OTel to become the control protocol

## Semantic conventions

- Prefer established OpenTelemetry semantic conventions, including `gen_ai.*`, before defining an `autodev.*` equivalent
- Use `autodev.*` only for concepts genuinely specific to AutoDev
- Never fabricate an attribute because a schema provides a field; derive it from observed inputs, outputs, owned state, or a validated correlation, otherwise omit it
- Treat telemetry schemas as versioned contracts and preserve compatibility deliberately
- Avoid aliases becoming permanent competing sources of truth; normalize at a clear boundary

## Attribute placement

Place attributes according to what they describe:

| Scope | Use for |
|---|---|
| Resource | Stable producer/runtime identity and environment |
| Span | One operation or unit of work |
| Span event / log record | A point-in-time event or observation |
| Metric data point | Bounded dimensions used for aggregation |

Do not promote request-, session-, trace-, conversation-, path-, or other high-cardinality identifiers into metric dimensions

## Instrumentation

- Instrument the component that actually owns the operation
- Keep span boundaries around one meaningful operation rather than setup code, unrelated work, or large application loops
- Preserve trace/context propagation across provider, tool, subagent, MCP, and bridge boundaries where technically possible
- Avoid duplicate instrumentation of the same operation at multiple layers
- If AutoDev begins emitting first-class OTel itself, use the official OpenTelemetry API/SDK rather than hand-building additional OTLP payloads
- Do not add an OTel SDK dependency merely to re-express telemetry already emitted correctly by Codex or another upstream component

## Telemetry quality

- Keep span names and metric dimensions low-cardinality and stable
- Never export secrets, credentials, raw prompts, responses, tool arguments, or other sensitive content unless explicitly required and safely designed
- Prefer identifiers and categorical metadata over captured content
- Redact or normalize sensitive/high-cardinality data before derived metrics or external export
- Distinguish `unknown` or `unattributed` from zero; absence of evidence must not become evidence of absence
- Preserve source timestamps and stable identities where needed for deduplication, retries, and out-of-order delivery
- Telemetry must not break or materially delay the agent operation it observes

## Collector rules

- Keep Collector configuration minimal and purpose-driven
- Add processors only for a demonstrated need
- Perform redaction/normalization before consumers that derive metrics from the affected attributes
- Centralize operations requiring complete traces, such as tail sampling, after trace convergence
- Avoid processing the same telemetry independently at multiple tiers when doing so can double-count or change semantics
- Validate component stability and exact pinned versions separately from config syntax
- Maintain a direct or otherwise simple rollback path until Collector-mediated behavior has proven parity

## Review checklist

When changing telemetry, verify:

1. The owning layer is correct: producer, Collector, AutoDev semantic layer, or backend
2. Existing OTel conventions are reused before introducing `autodev.*`
3. Attribute scope and cardinality are appropriate
4. Values come from real evidence rather than inference or placeholders
5. Retries, redelivery, and cross-signal ordering cannot double-count or permanently misattribute data
6. Privacy-sensitive content is excluded or explicitly protected
7. The change does not introduce a second source of truth or redundant telemetry path
8. AutoDev-specific semantics remain testable independently of transport
9. Raw and enriched telemetry can be distinguished when diagnosing transformations
10. Dashboard/status projections derive from canonical semantic state rather than recreating attribution logic

## Architectural preference

Prefer this shape:

`producer → OTel/OTLP → Collector → AutoDev semantic aggregation → status/dashboard and optional enriched OTel export`

Transport should remain standard and replaceable; AutoDev-specific meaning should remain explicit, evidence-based, and owned by AutoDev
