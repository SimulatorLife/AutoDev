/**
 * Source-owned OpenTelemetry instrumentation for the Codex tools MCP shim.
 *
 * The shim is the producer that owns the `tools/call` operation: Claude
 * sends a JSON-RPC `tools/call` request over stdio, this shim forwards the
 * call to its owning bridge, and the bridge replies with Codex's tool
 * output. Every `tools/call` therefore produces exactly one observation at
 * this producer; no other layer sees the operation.
 *
 * The shim uses the official OpenTelemetry JS SDK and OTLP HTTP exporter.
 * It never hand-builds OTLP, never duplicates telemetry from the router,
 * never reads from or writes to the router's telemetry module, and never
 * alters `/status` aggregation. Spans are only exported when a real
 * `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`)
 * is configured; without an endpoint the OTel API's no-op tracer remains
 * in place and the call path is unchanged.
 *
 * Resource identity: the shim is a separate subprocess launched by
 * Claude MCP config in src/providers/claude.ts. Its parent chain
 * (router -> Claude CLI -> shim) is the only source for any per-turn
 * `OTEL_RESOURCE_ATTRIBUTES`. This module reads the env-detected
 * resource so per-turn `autodev.workspace` and `autodev.agent.role`
 * inherited from the Claude CLI (@simulatorlife/autodev-runtime/telemetry/resource-context)
 * still flow to the shim's spans; it then layers the shim's own
 * `service.name=autodev-codex-tools-mcp` and `service.version` on top
 * so the producer is identifiable regardless of the operator-set
 * `OTEL_SERVICE_NAME`. Validated AutoDev context is only attached
 * after `safeAutoDevWorkspaceKey` / `safeAutoDevAgentRole` accept the
 * value, so the same privacy contract holds for inherited attributes.
 *
 * Privacy contract (mirrors docs/observability-target-state.md):
 * - Tool names are bounded and appear only on this MCP operation span;
 *   arguments, results, prompts, session IDs, request IDs, conversation
 *   IDs, and JSON-RPC ids are never attached.
 * - Errors use categorical `error.type` values only; raw messages,
 *   bridge URLs, HTTP status, and tool content are not exported.
 * - If tracer setup or export fails, the MCP callback still runs exactly
 *   once and its result remains authoritative.
 *
 * Semantic conventions: this shim handles the MCP server-side operation,
 * so the span kind is SERVER. MCP/GenAI attribute strings are pinned to
 * open-telemetry/semantic-conventions-genai at
 * MCP_SEMCONV_GENAI_REVISION. That mapping is Development-only and has no
 * tagged release; tests lock the revision and attributes so a convention
 * update is explicit. The older npm package's MCP/GenAI names are deprecated
 * redirects, so this producer does not treat them as its source of truth.
 * Span names follow `tools/call <gen_ai.tool.name>`; the tool name is never a
 * metric dimension. `params._meta` W3C trace context is extracted when present;
 * no session or request identifiers are recorded.
 */

import {
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  detectResources,
  envDetector,
  type Resource,
  resourceFromAttributes
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
// Stable attributes come from the versioned package. MCP/GenAI names below
// are sourced from the pinned Development model, not the package's deprecated
// redirect entries, and are guarded by the semantic-convention pin test.
import {
  ATTR_ERROR_TYPE,
  ATTR_NETWORK_TRANSPORT,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION
} from "@opentelemetry/semantic-conventions";
import {
  safeAutoDevAgentRole,
  safeAutoDevWorkspaceKey
} from "@simulatorlife/autodev-runtime/telemetry/resource-context";

const ATTR_AUTODEV_WORKSPACE = "autodev.workspace" as const;
const ATTR_AUTODEV_AGENT_ROLE = "autodev.agent.role" as const;
const ATTR_MCP_METHOD_NAME = "mcp.method.name" as const;
const ATTR_GEN_AI_TOOL_NAME = "gen_ai.tool.name" as const;
const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name" as const;

export const MCP_SEMCONV_GENAI_REVISION =
  "bcc7f9c2856fa7f4feb753f54d4ebba9455cc3dc" as const;

const MCP_METHOD_NAME_VALUE_TOOLS_CALL = "tools/call" as const;
const MCP_OPERATION_NAME_EXECUTE_TOOL = "execute_tool" as const;

const TRACER_NAME = "autodev.codex-tools-mcp";
const TRACER_VERSION = "1.0.0";
const SERVICE_NAME = "autodev-codex-tools-mcp";
const ATTR_VALUE_MAX_LENGTH = 64;
const TRAILING_SLASH_PATTERN = /\/$/u;
const SIGNAL_ENDPOINT_SUFFIX_PATTERN = /\/v1\/(?:traces|metrics|logs)$/u;

interface ShimTelemetryState {
  tracer: Tracer;
  provider: NodeTracerProvider | null;
  initialized: boolean;
  otlpExporterInstalled: boolean;
  testExporter: SpanExporter | null;
}

const state: ShimTelemetryState = {
  tracer: trace.getTracer(TRACER_NAME, TRACER_VERSION),
  provider: null,
  initialized: false,
  otlpExporterInstalled: false,
  testExporter: null
};

/**
 * Build the resource the shim attaches to its spans: an explicit shim
 * `service.name` and `service.version`, merged with the env-detected
 * attributes (`OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`) that the
 * Claude CLI passes down to this MCP server subprocess. AutoDev context
 * is validated through `safeAutoDevWorkspaceKey` / `safeAutoDevAgentRole`
 * before it can become telemetry; missing or unsafe values are dropped.
 *
 * The function is intentionally synchronous against the env detector
 * (which is itself sync); no other async detector is enabled. This
 * keeps `ensureOtelInitialized` synchronous and guarantees the SDK
 * registration happens before any tool call.
 */
function buildResource(): Resource {
  // Start with the env-detected attributes so the parent's
  // OTEL_RESOURCE_ATTRIBUTES (set by withAutoDevOtelResourceContext in
  // src/providers/claude.ts) and OTEL_SERVICE_NAME reach the shim's
  // spans. Non-AutoDev attributes pass through verbatim; AutoDev
  // context is validated below.
  const envResource = detectResources({ detectors: [envDetector] });
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(envResource.attributes)) {
    if (typeof value === "string" && value.length > 0) merged[key] = value;
  }
  // The shim's own producer identity always wins, so a misconfigured
  // OTEL_SERVICE_NAME=autodev-router cannot mislabel these spans.
  merged[ATTR_SERVICE_NAME] = SERVICE_NAME;
  merged[ATTR_SERVICE_VERSION] = TRACER_VERSION;
  const workspace = safeAutoDevWorkspaceKey(merged[ATTR_AUTODEV_WORKSPACE]);
  if (workspace) merged[ATTR_AUTODEV_WORKSPACE] = workspace;
  else delete merged[ATTR_AUTODEV_WORKSPACE];
  const role = safeAutoDevAgentRole(merged[ATTR_AUTODEV_AGENT_ROLE]);
  if (role) merged[ATTR_AUTODEV_AGENT_ROLE] = role;
  else delete merged[ATTR_AUTODEV_AGENT_ROLE];
  return resourceFromAttributes(merged);
}

function safeTrim(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > ATTR_VALUE_MAX_LENGTH) {
    return null;
  }
  return trimmed;
}

function logTelemetryError(message: string): void {
  try {
    process.stderr.write(`[autodev-codex-tools-telemetry] ${message}\n`);
  } catch {
    /* ignore */
  }
}

function resolveOtlpTraceEndpoint(): string | null {
  const specific = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (specific) return specific;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!base) return null;
  try {
    const endpoint = new URL(base);
    const path = endpoint.pathname.replace(TRAILING_SLASH_PATTERN, "");
    endpoint.pathname = SIGNAL_ENDPOINT_SUFFIX_PATTERN.test(path)
      ? path.replace(SIGNAL_ENDPOINT_SUFFIX_PATTERN, "/v1/traces")
      : `${path}/v1/traces`;
    return endpoint.toString();
  } catch {
    return null;
  }
}

function parseOtlpHeaders(
  ...sources: Array<string | undefined>
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    if (!source) continue;
    for (const item of source.split(",")) {
      const separator = item.indexOf("=");
      if (separator <= 0) continue;
      const key = item.slice(0, separator).trim();
      const encodedValue = item.slice(separator + 1).trim();
      if (!key || !encodedValue) continue;
      try {
        headers[key] = decodeURIComponent(encodedValue);
      } catch {
        headers[key] = encodedValue;
      }
    }
  }
  return headers;
}

function buildSpanProcessors(): SpanProcessor[] {
  const processors: SpanProcessor[] = [];
  const endpoint = resolveOtlpTraceEndpoint();
  if (endpoint) {
    try {
      processors.push(
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: endpoint,
            headers: parseOtlpHeaders(
              process.env.OTEL_EXPORTER_OTLP_HEADERS,
              process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS
            )
          })
        )
      );
      state.otlpExporterInstalled = true;
    } catch {
      // Keep the tool call healthy if exporter construction fails. Do not
      // log the endpoint because it may contain credential-bearing query
      // parameters.
      state.otlpExporterInstalled = false;
      logTelemetryError("otlp_exporter_configuration_failed");
    }
  }
  if (state.testExporter) {
    processors.push(new SimpleSpanProcessor(state.testExporter));
  }
  return processors;
}

/**
 * Initialize the official OpenTelemetry SDK synchronously and exactly
 * once. With no configured endpoint and no test exporter, the API's
 * no-op tracer remains in place. Exporter initialization is non-blocking
 * with respect to MCP traffic; BatchSpanProcessor sends spans
 * asynchronously.
 */
export function ensureOtelInitialized(): Tracer {
  if (state.initialized) return state.tracer;
  state.initialized = true;
  try {
    const spanProcessors = buildSpanProcessors();
    if (spanProcessors.length === 0) return state.tracer;
    const provider = new NodeTracerProvider({
      resource: buildResource(),
      spanProcessors
    });
    provider.register();
    state.provider = provider;
    state.tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  } catch {
    state.provider = null;
    state.otlpExporterInstalled = false;
    logTelemetryError("tracer_provider_initialization_failed");
  }
  return state.tracer;
}

/** Whether the official OTLP HTTP exporter is installed. Exposed for diagnostics. */
export function isOtlpExporterInstalled(): boolean {
  return state.otlpExporterInstalled;
}

/**
 * Install a test exporter before the first telemetry event. Production
 * never calls this; the test suite uses one in-memory exporter and resets
 * its contents between cases rather than replacing the global SDK.
 */
export function setTestExporter(exporter: SpanExporter | null): void {
  if (state.initialized && state.testExporter !== exporter) {
    throw new Error(
      "The codex-tools-shim telemetry test exporter must be set before the first span."
    );
  }
  state.testExporter = exporter;
}

export function getFinishedSpans(): ReadableSpan[] {
  const exporter = state.testExporter as
    (SpanExporter & { getFinishedSpans?: () => ReadableSpan[] }) | null;
  try {
    return typeof exporter?.getFinishedSpans === "function"
      ? [...exporter.getFinishedSpans()]
      : [];
  } catch {
    return [];
  }
}

export function resetTelemetryForTest(): void {
  const exporter = state.testExporter as
    (SpanExporter & { reset?: () => void }) | null;
  try {
    exporter?.reset?.();
  } catch {
    /* ignore test exporter cleanup failures */
  }
}

/** Flush queued spans and shut down the provider before the MCP process exits. */
export async function shutdownTelemetry(): Promise<void> {
  const provider = state.provider;
  state.provider = null;
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch {
    logTelemetryError("tracer_provider_shutdown_failed");
  }
}

/**
 * Reset the global provider for isolated tests. The production process
 * calls `shutdownTelemetry` once, on stdio close.
 *
 * Calling `trace.disable()` is required because the OTel API guards
 * `setGlobalTracerProvider` against duplicate registration: without
 * unregistering the global tracer provider, a follow-up `register()`
 * silently no-ops and the new tracer still delegates to the previous
 * provider's processors.
 */
export async function shutdownTelemetryForTest(): Promise<void> {
  const provider = state.provider;
  state.provider = null;
  state.tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  state.otlpExporterInstalled = false;
  state.initialized = false;
  try {
    trace.disable();
  } catch {
    /* ignore disable failures */
  }
  try {
    if (provider) await provider.shutdown();
  } catch {
    /* ignore shutdown failures */
  }
  const exporter = state.testExporter as
    (SpanExporter & { shutdown?: () => Promise<void> }) | null;
  try {
    if (exporter) await exporter.shutdown();
  } catch {
    /* ignore */
  }
}

export interface ToolCallOutcome {
  status: "ok" | "error";
  /** Categorical error tag; never includes tool arguments or output. */
  errorType?: string;
}

function attachOutcome(span: Span, outcome: ToolCallOutcome): void {
  if (outcome.status === "error") {
    const errorType = safeTrim(outcome.errorType);
    if (errorType) {
      try {
        span.setAttribute(ATTR_ERROR_TYPE, errorType);
      } catch {
        /* ignore attribute failures */
      }
    }
    try {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    span.setStatus({ code: SpanStatusCode.OK });
  } catch {
    /* ignore */
  }
}

function traceContextCarrier(metadata: unknown): Record<string, string> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const fields = metadata as Record<string, unknown>;
  const carrier: Record<string, string> = {};
  for (const key of ["traceparent", "tracestate", "baggage"] as const) {
    const value = fields[key];
    if (typeof value === "string" && value.length <= 4096) {
      carrier[key] = value;
    }
  }
  return carrier;
}

function endSpan(span: Span): void {
  try {
    span.end();
  } catch {
    // Exporter/span finalization failures must not change the MCP response.
  }
}

/**
 * Record one source-owned observation of the MCP `tools/call` operation
 * handled by the codex-tools-shim. The callback runs to completion
 * regardless of telemetry state; telemetry is never allowed to block,
 * mutate, or fail the call it observes. Tool arguments, results,
 * prompts, session IDs, request IDs, and JSON-RPC ids are never attached
 * to the span.
 *
 * The MCP and GenAI attribute names are from the incubating semantic-
 * conventions package entrypoint; their source mapping is pinned by
 * `MCP_SEMCONV_GENAI_REVISION` and asserted in tests.
 *
 * Returns the outcome reported by the callback. If the callback throws,
 * the span is finalized as ERROR and the throw propagates so the shim's
 * own error handling remains the single owner of caller-visible
 * failure semantics.
 */
export async function recordToolCallSpan(
  name: string,
  callback: () => Promise<ToolCallOutcome>,
  metadata?: unknown
): Promise<ToolCallOutcome> {
  let span: Span | null = null;
  try {
    const tracer = ensureOtelInitialized();
    const attributes: Record<string, string> = {
      [ATTR_MCP_METHOD_NAME]: MCP_METHOD_NAME_VALUE_TOOLS_CALL,
      [ATTR_GEN_AI_OPERATION_NAME]: MCP_OPERATION_NAME_EXECUTE_TOOL,
      [ATTR_NETWORK_TRANSPORT]: "pipe"
    };
    const toolName = safeTrim(name);
    if (toolName) attributes[ATTR_GEN_AI_TOOL_NAME] = toolName;
    const spanName = toolName ? `tools/call ${toolName}` : "tools/call";
    const parentContext = propagation.extract(
      context.active(),
      traceContextCarrier(metadata)
    );
    span = tracer.startSpan(
      spanName,
      { kind: SpanKind.SERVER, attributes },
      parentContext
    );
  } catch {
    // If tracing cannot initialize, run the operation without instrumentation.
    // This branch must not skip or retry the callback.
    logTelemetryError("tool_call_span_initialization_failed");
  }

  if (!span) return callback();

  try {
    const outcome = await callback();
    attachOutcome(span, outcome);
    return outcome;
  } catch (error) {
    attachOutcome(span, { status: "error", errorType: "_OTHER" });
    throw error;
  } finally {
    endSpan(span);
  }
}
