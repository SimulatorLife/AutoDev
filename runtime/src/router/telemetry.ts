/**
 * Source-owned OpenTelemetry instrumentation for the AutoDev router.
 *
 * Every routed logical request and every physical provider/model attempt is
 * emitted as standard OTel spans. The router uses the official OTel JS SDK
 * and OTLP HTTP exporter; it never hand-builds OTLP payloads, never adds a
 * Collector, never modifies OpenLIT, and never duplicates telemetry. Spans
 * are only exported when a real OTEL_EXPORTER_OTLP_ENDPOINT is configured;
 * if the exporter is unavailable or initialization fails, telemetry degrades
 * to a no-op tracer without blocking the routed turn.
 *
 * Span topology:
 *   autodev.routed_request          (one logical AutoDev routed request)
 *   └── gen_ai.client_operation     (one physical provider/model attempt,
 *                                    including fallback AND retries)
 *
 * Standard gen_ai.* attributes are only attached when the owning response
 * (or attempted response) supplies a real value; absent values produce no
 * attribute. Token counts live on the attempt that consumed them; the
 * logical request never carries attempt tokens, so totals are never
 * double-counted between parent and child.
 *
 * Privacy: this module never exports raw paths, prompts, credentials,
 * request/session/conversation/thread/trace IDs, or tool arguments as
 * metric dimensions or as sensitive span attributes. autodev.workspace and
 * autodev.agent.role are attached only after value validation (non-empty,
 * non-"unattributed", trimmed, bounded length).
 */

import {
  type Context,
  context,
  type Meter,
  metrics,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  type InMemoryMetricExporter,
  MeterProvider,
  type MetricReader,
  PeriodicExportingMetricReader
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
// Stable attribute keys come from the semantic-conventions index.
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION
} from "@opentelemetry/semantic-conventions";
import { parseTurnMetadataJson } from "@simulatorlife/autodev-runtime/shared/resolve-workspace";
import {
  safeAutoDevAgentRole,
  safeAutoDevWorkspaceKey
} from "@simulatorlife/autodev-runtime/telemetry/resource-context";
// Experimental (incubating) attribute keys are imported via the package's
// `./incubating` subpath. NodeNext module resolution does not always resolve
// the subpath declaration, so the keys are also declared inline below to
// guarantee the source-of-truth attribute names compile under all settings.
const ATTR_GEN_AI_OPERATION_NAME = "gen_ai.operation.name" as const;
const ATTR_GEN_AI_PROVIDER_NAME = "gen_ai.provider.name" as const;
const ATTR_GEN_AI_REQUEST_MODEL = "gen_ai.request.model" as const;
const ATTR_GEN_AI_RESPONSE_MODEL = "gen_ai.response.model" as const;
const ATTR_GEN_AI_RESPONSE_FINISH_REASONS =
  "gen_ai.response.finish_reasons" as const;
const ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS =
  "gen_ai.usage.cache_read.input_tokens" as const;
const ATTR_GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens" as const;
const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens" as const;
const ATTR_HTTP_RESPONSE_STATUS_CODE = "http.response.status_code" as const;
const ATTR_GEN_AI_TOKEN_TYPE = "gen_ai.token.type" as const;
const ATTR_GEN_AI_ERROR_TYPE = "error.type" as const;
const ATTR_AUTODEV_WORKSPACE = "autodev.workspace" as const;
const ATTR_AUTODEV_AGENT_ROLE = "autodev.agent.role" as const;
export const METRIC_CONTEXT_COMPACTIONS = "autodev.context.compactions";
export const METRIC_GIT_COMMITS = "autodev.git.commits";
export const METRIC_GIT_FILES_CHANGED = "autodev.git.files_changed";
export const METRIC_GIT_FILES_ADDED = "autodev.git.files_added";
export const METRIC_GIT_FILES_DELETED = "autodev.git.files_deleted";
export const METRIC_GIT_LINES_ADDED = "autodev.git.lines_added";
export const METRIC_GIT_LINES_REMOVED = "autodev.git.lines_removed";
/** Marks a commit whose diff could not be fully summarized. */
export const ATTR_AUTODEV_GIT_PARTIAL = "autodev.git.partial" as const;
/**
 * How the actor on a commit was established.
 *
 * `commit_identity` means the commit itself carried an AutoDev committer, so
 * the actor is read from git. `unattributed` means the commit was observed but
 * carries no agent identity -- a human commit, or one made before this
 * identity existed. Both are facts worth querying; a downstream breakdown must
 * be able to exclude the unattributed ones rather than average over them.
 */
export const ATTR_AUTODEV_GIT_ATTRIBUTION = "autodev.git.attribution" as const;
export const GIT_ATTRIBUTION_VALUES = Object.freeze([
  "commit_identity",
  "unattributed"
] as const);
/**
 * Process-local commit-idempotency bound. A commit observed by two producers
 * (a session and a later reconciliation pass) must still be counted once.
 */
const MAX_TRACKED_GIT_COMMITS = 1_000;
const trackedGitCommits = new Set<string>();

function claimGitCommit(commit: string): boolean {
  if (trackedGitCommits.has(commit)) return false;
  trackedGitCommits.add(commit);
  if (trackedGitCommits.size > MAX_TRACKED_GIT_COMMITS) {
    const oldest = trackedGitCommits.values().next().value;
    if (oldest !== undefined) trackedGitCommits.delete(oldest);
  }
  return true;
}

/** Test seam: the commit dedup set is process-wide and must be resettable. */
export function resetTrackedGitCommitsForTest(): void {
  trackedGitCommits.clear();
}
export const ATTR_AUTODEV_REQUEST_KIND = "autodev.request_kind" as const;
export const ATTR_AUTODEV_COMPACTION_TRIGGER =
  "autodev.compaction.trigger" as const;
export const ATTR_AUTODEV_COMPACTION_REASON =
  "autodev.compaction.reason" as const;
export const ATTR_AUTODEV_COMPACTION_IMPLEMENTATION =
  "autodev.compaction.implementation" as const;
export const ATTR_AUTODEV_COMPACTION_PHASE =
  "autodev.compaction.phase" as const;
export const ATTR_AUTODEV_COMPACTION_STRATEGY =
  "autodev.compaction.strategy" as const;
const METRIC_GEN_AI_CLIENT_TOKEN_USAGE = "gen_ai.client.token.usage";
const METRIC_GEN_AI_CLIENT_OPERATION_DURATION =
  "gen_ai.client.operation.duration";
const METRIC_LOGICAL_REQUEST_COUNT = "autodev.router.logical_requests";
const METRIC_LOGICAL_REQUEST_DURATION =
  "autodev.router.logical_request.duration";
const METRIC_CACHE_READ_TOKENS = "autodev.gen_ai.cache_read.input_tokens";
const METRIC_SKILL_EVENTS = "autodev.skill.events";

const TRACER_NAME = "autodev.router";
const TRACER_VERSION = "1.0.0";
const SERVICE_NAME = "autodev-router";
const ATTR_VALUE_MAX_LENGTH = 64;
const SIGNAL_ENDPOINT_SUFFIX_PATTERN = /\/v1\/(?:traces|metrics|logs)$/u;
const TRAILING_SLASH_PATTERN = /\/$/u;
const METRIC_AGENT_ROLES = new Set([
  "orchestrator",
  "subagent",
  "worker",
  "explorer",
  "docs-researcher",
  "validator",
  "default",
  "smart",
  "browser-tester",
  "playtester",
  "playtest-analyst"
]);

interface RouterTelemetryState {
  tracer: Tracer;
  provider: NodeTracerProvider | null;
  meterProvider: MeterProvider | null;
  meter: Meter | null;
  metricReaderForTest: MetricReader | null;
  testExporter: SpanExporter | null;
  initialized: boolean;
  metricsInitialized: boolean;
  otlpExporterInstalled: boolean;
}

const state: RouterTelemetryState = {
  tracer: trace.getTracer(TRACER_NAME, TRACER_VERSION),
  provider: null,
  meterProvider: null,
  meter: null,
  metricReaderForTest: null,
  testExporter: null,
  initialized: false,
  metricsInitialized: false,
  otlpExporterInstalled: false
};

interface AttemptMetricContext {
  attributes: Record<string, string>;
  startedAt: number;
}

interface LogicalMetricContext {
  attributes: Record<string, string>;
  startedAt: number;
  requestId: string | null;
  compactionSignal?: ParsedCompactionSignal | null;
}

const attemptMetricContexts = new WeakMap<Span, AttemptMetricContext>();
const logicalMetricContexts = new WeakMap<Span, LogicalMetricContext>();

interface RouterMetricInstruments {
  logicalRequests: ReturnType<Meter["createCounter"]>;
  logicalRequestDuration: ReturnType<Meter["createHistogram"]>;
  genAiOperationDuration: ReturnType<Meter["createHistogram"]>;
  genAiTokenUsage: ReturnType<Meter["createHistogram"]>;
  cacheReadTokens: ReturnType<Meter["createHistogram"]>;
  skillEvents: ReturnType<Meter["createCounter"]>;
  contextCompactions: ReturnType<Meter["createCounter"]>;
  gitCommits: ReturnType<Meter["createCounter"]>;
  gitFilesChanged: ReturnType<Meter["createCounter"]>;
  gitFilesAdded: ReturnType<Meter["createCounter"]>;
  gitFilesDeleted: ReturnType<Meter["createCounter"]>;
  gitLinesAdded: ReturnType<Meter["createCounter"]>;
  gitLinesRemoved: ReturnType<Meter["createCounter"]>;
}

let instruments: RouterMetricInstruments | null = null;

function safeTrim(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > ATTR_VALUE_MAX_LENGTH) return null;
  return trimmed;
}

export function safeProviderName(
  provider: string | null | undefined
): string | null {
  return safeTrim(provider);
}

export function safeModelName(model: string | null | undefined): string | null {
  return safeTrim(model);
}

function logTelemetryError(message: string): void {
  try {
    process.stderr.write(`[autodev-telemetry] ${message}\n`);
  } catch {
    /* ignore */
  }
}

export function resolveOtlpSignalEndpoint(
  base: string,
  signal: "traces" | "metrics"
): string | null {
  try {
    const endpoint = new URL(base);
    const path = endpoint.pathname.replace(TRAILING_SLASH_PATTERN, "");
    endpoint.pathname = SIGNAL_ENDPOINT_SUFFIX_PATTERN.test(path)
      ? path.replace(SIGNAL_ENDPOINT_SUFFIX_PATTERN, `/v1/${signal}`)
      : `${path}/v1/${signal}`;
    return endpoint.toString();
  } catch {
    return null;
  }
}

function readOtlpTraceEndpoint(): string | null {
  const specific = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (specific) return specific;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? resolveOtlpSignalEndpoint(base, "traces") : null;
}

function readOtlpMetricEndpoint(): string | null {
  const specific = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  if (specific) return specific;
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? resolveOtlpSignalEndpoint(base, "metrics") : null;
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

function createOtlpMetricReader(): MetricReader | null {
  const endpoint = readOtlpMetricEndpoint();
  if (!endpoint) return null;
  try {
    return new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: endpoint,
        headers: parseOtlpHeaders(
          process.env.OTEL_EXPORTER_OTLP_HEADERS,
          process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS
        )
      }),
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 10_000,
      cardinalityLimits: { default: 500 }
    });
  } catch {
    logTelemetryError("otlp_metric_exporter_configuration_failed");
    return null;
  }
}

function initializeMetrics(): void {
  if (state.metricsInitialized) return;
  state.metricsInitialized = true;
  const readers = [state.metricReaderForTest, createOtlpMetricReader()].filter(
    (reader): reader is MetricReader => reader !== null
  );
  try {
    if (readers.length === 0) {
      state.meter = metrics.getMeter(TRACER_NAME, TRACER_VERSION);
    } else {
      state.meterProvider = new MeterProvider({
        resource: resourceFromAttributes({
          [ATTR_SERVICE_NAME]: SERVICE_NAME,
          [ATTR_SERVICE_VERSION]: TRACER_VERSION
        }),
        readers
      });
      if (!metrics.setGlobalMeterProvider(state.meterProvider)) {
        logTelemetryError("global_meter_provider_already_registered");
      }
      state.meter = state.meterProvider.getMeter(TRACER_NAME, TRACER_VERSION);
    }
    instruments = createMetricInstruments(state.meter);
  } catch {
    state.meterProvider = null;
    state.meter = metrics.getMeter(TRACER_NAME, TRACER_VERSION);
    instruments = createMetricInstruments(state.meter);
    logTelemetryError("metric_provider_initialization_failed");
  }
}

function createMetricInstruments(meter: Meter): RouterMetricInstruments {
  return {
    logicalRequests: meter.createCounter(METRIC_LOGICAL_REQUEST_COUNT, {
      description: "Logical routed requests completed by the AutoDev router.",
      unit: "{request}"
    }),
    logicalRequestDuration: meter.createHistogram(
      METRIC_LOGICAL_REQUEST_DURATION,
      {
        description:
          "End-to-end duration of one AutoDev logical routed request.",
        unit: "s"
      }
    ),
    genAiOperationDuration: meter.createHistogram(
      METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
      {
        description: "Duration of one physical GenAI provider/model operation.",
        unit: "s"
      }
    ),
    genAiTokenUsage: meter.createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
      description:
        "Number of input or output tokens used by one GenAI operation.",
      unit: "token"
    }),
    cacheReadTokens: meter.createHistogram(METRIC_CACHE_READ_TOKENS, {
      description: "Reported cached input tokens, a subset of input tokens.",
      unit: "token"
    }),
    skillEvents: meter.createCounter(METRIC_SKILL_EVENTS, {
      description:
        "Accepted AutoDev skill lifecycle observations; skill names are intentionally excluded from metric dimensions.",
      unit: "{event}"
    }),
    contextCompactions: meter.createCounter(METRIC_CONTEXT_COMPACTIONS, {
      description:
        "Source-confirmed context compactions completed by the AutoDev router.",
      unit: "{compaction}"
    }),
    gitCommits: meter.createCounter(METRIC_GIT_COMMITS, {
      description: "Commits created by AutoDev-managed agent work.",
      unit: "{commit}"
    }),
    gitFilesChanged: meter.createCounter(METRIC_GIT_FILES_CHANGED, {
      description:
        "Distinct paths touched by a commit (added, deleted, modified, or renamed).",
      unit: "{file}"
    }),
    gitFilesAdded: meter.createCounter(METRIC_GIT_FILES_ADDED, {
      description: "Paths added by a commit; a subset of files changed.",
      unit: "{file}"
    }),
    gitFilesDeleted: meter.createCounter(METRIC_GIT_FILES_DELETED, {
      description: "Paths deleted by a commit; a subset of files changed.",
      unit: "{file}"
    }),
    gitLinesAdded: meter.createCounter(METRIC_GIT_LINES_ADDED, {
      description: "Lines inserted by a commit, as reported by git numstat.",
      unit: "{line}"
    }),
    gitLinesRemoved: meter.createCounter(METRIC_GIT_LINES_REMOVED, {
      description: "Lines deleted by a commit, as reported by git numstat.",
      unit: "{line}"
    })
  };
}

function elapsedSeconds(startedAt: number): number {
  return Math.max(0, (performance.now() - startedAt) / 1000);
}

function metricRole(role: string | null | undefined): string | null {
  const safeRole = safeAutoDevAgentRole(role);
  return safeRole && METRIC_AGENT_ROLES.has(safeRole) ? safeRole : null;
}

function metricAttributes(options: {
  provider?: string | null | undefined;
  model?: string | null | undefined;
  workspace?: { key?: string | null | undefined } | null | undefined;
  role?: string | null | undefined;
  providerRole?: string | null | undefined;
}): Record<string, string> {
  const attributes: Record<string, string> = {};
  const provider = safeProviderName(options.provider);
  const model = safeModelName(options.model);
  const workspace = safeAutoDevWorkspaceKey(options.workspace?.key);
  const role = metricRole(options.role);
  if (provider) attributes[ATTR_GEN_AI_PROVIDER_NAME] = provider;
  if (model) attributes[ATTR_GEN_AI_REQUEST_MODEL] = model;
  if (workspace) attributes[ATTR_AUTODEV_WORKSPACE] = workspace;
  if (role) attributes[ATTR_AUTODEV_AGENT_ROLE] = role;
  if (
    options.providerRole === "orchestrator" ||
    options.providerRole === "subagent"
  ) {
    attributes["autodev.router.provider_role"] = options.providerRole;
  }
  return attributes;
}

function recordTokenMetrics(
  attributes: Record<string, string>,
  usage: AttemptUsage | null | undefined
): void {
  if (!instruments || !usage) return;
  const input = finiteTokenCount(usage.input);
  const output = finiteTokenCount(usage.output);
  const cacheRead = finiteTokenCount(usage.cacheRead);
  if (input !== null) {
    instruments.genAiTokenUsage.record(input, {
      ...attributes,
      [ATTR_GEN_AI_TOKEN_TYPE]: "input"
    });
  }
  if (output !== null) {
    instruments.genAiTokenUsage.record(output, {
      ...attributes,
      [ATTR_GEN_AI_TOKEN_TYPE]: "output"
    });
  }
  if (cacheRead !== null && input !== null && cacheRead <= input) {
    instruments.cacheReadTokens.record(cacheRead, attributes);
  }
}

/** Exported for deterministic tests and runtime diagnostics; contains no secret. */
export function isOtlpExporterInstalled(): boolean {
  return state.otlpExporterInstalled;
}

/**
 * Install a test exporter before the tracer provider is initialized.
 * Production does not call this; the test suite uses one in-memory exporter
 * and resets its contents between cases rather than replacing the global SDK.
 */
export function setTelemetryExporter(exporter: SpanExporter | null): void {
  if (state.initialized) {
    throw new Error(
      "The telemetry test exporter must be set before the first span."
    );
  }
  state.testExporter = exporter;
}

/** Configure one in-memory metrics exporter before the first telemetry event. */
export function setTelemetryMetricExporterForTest(
  exporter: InMemoryMetricExporter
): void {
  if (state.metricsInitialized) {
    throw new Error(
      "The telemetry test metric exporter must be set before the first telemetry event."
    );
  }
  state.metricReaderForTest = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000
  });
}

export async function flushTelemetryMetrics(): Promise<void> {
  try {
    await state.meterProvider?.forceFlush();
  } catch {
    logTelemetryError("metric_export_flush_failed");
  }
}

function buildSpanProcessors(): SpanProcessor[] {
  const processors: SpanProcessor[] = [];
  const endpoint = readOtlpTraceEndpoint();
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
      // Keep routing healthy if exporter construction fails. Do not log the
      // endpoint because it may contain credential-bearing query parameters.
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
 * Initialize the official OpenTelemetry SDK synchronously and exactly once.
 * With no configured endpoint and no test exporter, the API's no-op tracer
 * remains in place. Exporter initialization is non-blocking with respect to
 * provider requests; BatchSpanProcessor sends spans asynchronously.
 */
export function ensureOtelInitialized(): Tracer {
  if (state.initialized) return state.tracer;
  state.initialized = true;
  initializeMetrics();
  try {
    const spanProcessors = buildSpanProcessors();
    if (spanProcessors.length === 0) return state.tracer;
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: SERVICE_NAME,
        [ATTR_SERVICE_VERSION]: TRACER_VERSION
      }),
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

export function resetTelemetryExporter(): void {
  const exporter = state.testExporter as
    (SpanExporter & { reset?: () => void }) | null;
  try {
    exporter?.reset?.();
  } catch {
    /* ignore test exporter cleanup failures */
  }
  resetCompactionDedupForTest();
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROHIBITED_ID_PREFIX_PATTERN =
  /^(?:(?:sess(?:ion)?|thread|turn|conversation|conv|request|req|user|usr)[_.-]|win(?:dow)?[_.-]?(?:id)?[_.-])/i;
const PROHIBITED_RAW_ID_PATTERN =
  /^(?:sess(?:ion)?|thread|turn|window|win|request|req|conversation|conv|user|usr)[_.-]id(?:[_.-]|$)/i;
const SAFE_CATEGORICAL_LABEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const HEX_HASH_PATTERN = /^[0-9a-f]{32,64}$/i;

function hasProhibitedIdPrefixWithDigit(value: string): boolean {
  const prefix = PROHIBITED_ID_PREFIX_PATTERN.exec(value)?.[0];
  if (!prefix) return false;

  let containsDigit = false;
  for (const character of value.slice(prefix.length).toLowerCase()) {
    const code = character.charCodeAt(0);
    if ((code < 48 || code > 57) && (code < 97 || code > 122)) {
      return false;
    }
    if (code >= 48 && code <= 57) containsDigit = true;
  }
  return containsDigit;
}

/**
 * Source-supported enumerations for the `autodev.context.compactions` metric
 * dimensions. `sanitizeCategoricalLabel` only bounds the shape and length of
 * a string, not its cardinality, so an untrusted `x-codex-turn-metadata`
 * header could otherwise multiply series with one safe 64-character label
 * per `trigger`/`reason`/`implementation`/`phase`/`strategy` value. The
 * router collapses any value outside the matching allowlist onto the
 * single `COMPACTION_DIMENSION_OTHER` bucket, so the counter still
 * increments for a source-confirmed compaction but the cardinality of
 * each dimension is bounded by the size of its allowlist plus one.
 *
 * To add a new value, extend the matching allowlist explicitly. Hidden
 * aliasing or a competing source of truth is intentionally avoided.
 */
export const COMPACTION_DIMENSION_ALLOWLISTS = {
  trigger: new Set([
    "threshold",
    "manual",
    "overflow",
    "pressure",
    "remote",
    "scheduled",
    "explicit"
  ]),
  reason: new Set([
    "context_window_exceeded",
    "window_pressure",
    "overflow",
    "token_budget",
    "explicit_request",
    "auto_recovery",
    "ttl_exceeded"
  ]),
  implementation: new Set([
    "summarize",
    "truncate",
    "drop_middle",
    "rewrite",
    "hybrid",
    "rolling_window"
  ]),
  phase: new Set(["pre_turn", "mid_turn", "post_turn"]),
  strategy: new Set([
    "drop_middle",
    "summarize_head",
    "summarize_tail",
    "rolling_window",
    "truncate_oldest",
    "hybrid"
  ])
} as const;

export const COMPACTION_DIMENSION_OTHER = "other";

/**
 * Collapse a compaction metric dimension value to a source-supported
 * enumeration. The untrusted value first passes through
 * `sanitizeCategoricalLabel` for shape, length, and ID-safety; only then
 * is it mapped onto the supplied allowlist or onto
 * `COMPACTION_DIMENSION_OTHER`. A non-string, empty, oversized, ID-like,
 * or otherwise unsafe value returns `null`, which the metric recorder
 * treats as "no dimension reported".
 */
export function compactCompactionDimension(
  rawValue: unknown,
  allowlist: ReadonlySet<string>
): string | null {
  const safe = sanitizeCategoricalLabel(rawValue);
  if (!safe) return null;
  return allowlist.has(safe) ? safe : COMPACTION_DIMENSION_OTHER;
}

export function sanitizeCategoricalLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > ATTR_VALUE_MAX_LENGTH) return null;
  if (trimmed === "unattributed" || trimmed.toLowerCase() === "unknown") {
    return null;
  }
  if (!SAFE_CATEGORICAL_LABEL_PATTERN.test(trimmed)) return null;
  if (UUID_PATTERN.test(trimmed)) return null;
  if (
    hasProhibitedIdPrefixWithDigit(trimmed) ||
    PROHIBITED_RAW_ID_PATTERN.test(trimmed)
  ) {
    return null;
  }
  if (HEX_HASH_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export interface CompactionMetadata {
  trigger?: string | null | undefined;
  reason?: string | null | undefined;
  implementation?: string | null | undefined;
  phase?: string | null | undefined;
  strategy?: string | null | undefined;
}

export interface ParsedCompactionSignal {
  isCompaction: boolean;
  compaction?: CompactionMetadata | null | undefined;
}

const COMPACTION_METADATA_FIELDS = [
  "trigger",
  "reason",
  "implementation",
  "phase",
  "strategy"
] as const satisfies readonly (keyof CompactionMetadata)[];

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function turnMetadataRecord(
  metadata: string | Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (typeof metadata === "string") return parseTurnMetadataJson(metadata);
  return isMetadataRecord(metadata) ? metadata : null;
}

function sanitizedCompactionMetadata(
  value: unknown
): CompactionMetadata | null {
  if (!isMetadataRecord(value)) return null;

  const compaction: CompactionMetadata = {};
  for (const field of COMPACTION_METADATA_FIELDS) {
    const label = sanitizeCategoricalLabel(value[field]);
    if (label) compaction[field] = label;
  }
  return Object.keys(compaction).length > 0 ? compaction : null;
}

export function parseCompactionSignal(
  metadata: string | Record<string, unknown> | null | undefined
): ParsedCompactionSignal {
  const parsed = turnMetadataRecord(metadata);
  if (!parsed || parsed.request_kind !== "compaction") {
    return { isCompaction: false };
  }
  return {
    isCompaction: true,
    compaction: sanitizedCompactionMetadata(parsed.compaction)
  };
}

const COMPACTION_DEDUP_CACHE_SIZE = 1000;
const recordedCompactionRequestIds = new Set<string>();
const recordedCompactionQueue: string[] = [];

export function resetCompactionDedupForTest(): void {
  recordedCompactionRequestIds.clear();
  recordedCompactionQueue.length = 0;
}

export interface RecordContextCompactionOptions {
  requestId?: string | null | undefined;
  provider?: string | null | undefined;
  model?: string | null | undefined;
  role?: string | null | undefined;
  providerRole?: string | null | undefined;
  workspace?: { key?: string | null | undefined } | null | undefined;
  compaction?: CompactionMetadata | null | undefined;
}

function claimCompactionRequestId(
  requestId: string | null | undefined
): boolean {
  if (!requestId) return true;
  if (recordedCompactionRequestIds.has(requestId)) return false;

  recordedCompactionRequestIds.add(requestId);
  recordedCompactionQueue.push(requestId);
  if (recordedCompactionQueue.length > COMPACTION_DEDUP_CACHE_SIZE) {
    const oldest = recordedCompactionQueue.shift();
    if (oldest) recordedCompactionRequestIds.delete(oldest);
  }
  return true;
}

const COMPACTION_METRIC_DIMENSIONS = [
  [
    "trigger",
    ATTR_AUTODEV_COMPACTION_TRIGGER,
    COMPACTION_DIMENSION_ALLOWLISTS.trigger
  ],
  [
    "reason",
    ATTR_AUTODEV_COMPACTION_REASON,
    COMPACTION_DIMENSION_ALLOWLISTS.reason
  ],
  [
    "implementation",
    ATTR_AUTODEV_COMPACTION_IMPLEMENTATION,
    COMPACTION_DIMENSION_ALLOWLISTS.implementation
  ],
  [
    "phase",
    ATTR_AUTODEV_COMPACTION_PHASE,
    COMPACTION_DIMENSION_ALLOWLISTS.phase
  ],
  [
    "strategy",
    ATTR_AUTODEV_COMPACTION_STRATEGY,
    COMPACTION_DIMENSION_ALLOWLISTS.strategy
  ]
] as const;

function addCompactionMetricDimensions(
  attributes: Record<string, string>,
  compaction: CompactionMetadata
): void {
  for (const [field, attribute, allowlist] of COMPACTION_METRIC_DIMENSIONS) {
    const value = compactCompactionDimension(compaction[field], allowlist);
    if (value) attributes[attribute] = value;
  }
}

function compactionMetricAttributes(
  options: RecordContextCompactionOptions
): Record<string, string> {
  const attributes = metricAttributes({
    provider: options.provider,
    model: options.model,
    workspace: options.workspace,
    role: options.role,
    providerRole: options.providerRole
  });
  if (options.compaction) {
    addCompactionMetricDimensions(attributes, options.compaction);
  }
  return attributes;
}

export function recordContextCompaction(
  options: RecordContextCompactionOptions
): boolean {
  if (!claimCompactionRequestId(options.requestId)) return false;
  ensureOtelInitialized();
  if (!instruments) return false;

  const attributes = compactionMetricAttributes(options);
  try {
    instruments.contextCompactions.add(1, attributes);
    return true;
  } catch {
    logTelemetryError("context_compaction_recording_failed");
    return false;
  }
}

export interface RecordGitCommitOptions {
  readonly commit: string;
  readonly filesChanged: number;
  readonly filesAdded: number;
  readonly filesDeleted: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly partial?: boolean | undefined;
  readonly workspace?: { key?: string | null | undefined } | null | undefined;
  readonly role?: string | null | undefined;
  readonly provider?: string | null | undefined;
  readonly model?: string | null | undefined;
  /**
   * Whether `role`/`provider` came from the commit's own committer identity.
   *
   * When false they are dropped rather than emitted: an actor supplied by the
   * observing Runtime is a guess whenever more than one actor could have made
   * the commit, and a blended number is worse than an unattributed one.
   */
  readonly actorFromCommitIdentity?: boolean | undefined;
}

/**
 * Record one commit's change output.
 *
 * Only the dimensions the producing source actually knew are attached. The
 * commit id is used for idempotency and is deliberately *not* an attribute:
 * it is unbounded and identifies a specific object, both of which the privacy
 * rules forbid. File paths, repository URLs, and branch names never reach here
 * because the measurement never carries them.
 *
 * Returns false when the commit was already recorded, was not measurable, or
 * telemetry is unavailable -- so a caller can tell "not counted" from "counted".
 */
export function recordGitCommit(options: RecordGitCommitOptions): boolean {
  if (!options.commit) return false;
  // Deduplicate before anything else: a second producer observing the same
  // commit must not double-count it.
  if (!claimGitCommit(options.commit)) return false;

  const counters = [
    options.filesChanged,
    options.filesAdded,
    options.filesDeleted,
    options.linesAdded,
    options.linesRemoved
  ];
  if (counters.some((value) => !Number.isFinite(value) || value < 0)) {
    return false;
  }

  ensureOtelInitialized();
  if (!instruments) return false;

  const attributes: Record<string, string> = metricAttributes({
    // Actor dimensions are only carried when the commit itself established
    // them. `metricAttributes` already drops anything that fails its bounded
    // allowlist, so an unknown role contributes no dimension at all.
    provider: options.actorFromCommitIdentity ? options.provider : null,
    model: options.model,
    workspace: options.workspace,
    role: options.actorFromCommitIdentity ? options.role : null
  });
  attributes[ATTR_AUTODEV_GIT_ATTRIBUTION] = options.actorFromCommitIdentity
    ? "commit_identity"
    : "unattributed";
  if (options.partial) attributes[ATTR_AUTODEV_GIT_PARTIAL] = "true";

  try {
    instruments.gitCommits.add(1, attributes);
    instruments.gitFilesChanged.add(options.filesChanged, attributes);
    instruments.gitFilesAdded.add(options.filesAdded, attributes);
    instruments.gitFilesDeleted.add(options.filesDeleted, attributes);
    instruments.gitLinesAdded.add(options.linesAdded, attributes);
    instruments.gitLinesRemoved.add(options.linesRemoved, attributes);
    return true;
  } catch {
    logTelemetryError("git_commit_recording_failed");
    return false;
  }
}

export interface LogicalRequestSpanOptions {
  requestId: string | null;
  role: string | null;
  providerRole: "orchestrator" | "subagent";
  workspace: { key: string; cwd?: string | null | undefined } | null;
  subject: string;
  requestedModel: string | null;
  memoryMode?: "jit" | "retrieval-only" | "disabled" | "invalid" | undefined;
  turnMetadataHeader?: string | null | undefined;
  compactionSignal?: ParsedCompactionSignal | null | undefined;
}

type LogicalSpanAttributes = Record<string, string | number | boolean>;

/**
 * Copy the bounded request context onto each operation that Usage may query
 * independently. The logical request remains the authority; child attempts
 * carry the same safe workspace/role span attributes so a provider breakdown
 * can honor those filters without joining across spans or widening metric
 * dimensions.
 */
function addAutoDevSpanContext(
  attributes: LogicalSpanAttributes,
  context: {
    readonly workspace?: { readonly key?: string | null } | null | undefined;
    readonly role?: string | null | undefined;
  }
): void {
  const workspace = safeAutoDevWorkspaceKey(context.workspace?.key);
  if (workspace) attributes[ATTR_AUTODEV_WORKSPACE] = workspace;
  const role = safeAutoDevAgentRole(context.role);
  if (role) attributes[ATTR_AUTODEV_AGENT_ROLE] = role;
}

function addCompactionSpanAttributes(
  attributes: LogicalSpanAttributes,
  signal: ParsedCompactionSignal
): void {
  if (!signal.isCompaction) return;
  attributes[ATTR_AUTODEV_REQUEST_KIND] = "compaction";
  if (!signal.compaction) return;

  const compactionAttributes = [
    ["trigger", ATTR_AUTODEV_COMPACTION_TRIGGER],
    ["reason", ATTR_AUTODEV_COMPACTION_REASON],
    ["implementation", ATTR_AUTODEV_COMPACTION_IMPLEMENTATION],
    ["phase", ATTR_AUTODEV_COMPACTION_PHASE],
    ["strategy", ATTR_AUTODEV_COMPACTION_STRATEGY]
  ] as const satisfies readonly (readonly [keyof CompactionMetadata, string])[];
  for (const [field, attribute] of compactionAttributes) {
    const value = signal.compaction[field];
    if (value) attributes[attribute] = value;
  }
}

function logicalRequestSpanData(options: LogicalRequestSpanOptions): {
  attributes: LogicalSpanAttributes;
  model: string | null;
  compactionSignal: ParsedCompactionSignal;
} {
  const attributes: LogicalSpanAttributes = {
    "autodev.router.subject": safeTrim(options.subject) ?? "request",
    "autodev.router.provider_role": options.providerRole
  };
  addAutoDevSpanContext(attributes, options);
  const model = safeModelName(options.requestedModel);
  if (model) attributes["autodev.requested_model"] = model;
  if (options.memoryMode) {
    attributes["autodev.memory.mode"] = options.memoryMode;
  }

  const compactionSignal =
    options.compactionSignal ??
    parseCompactionSignal(options.turnMetadataHeader);
  addCompactionSpanAttributes(attributes, compactionSignal);
  return { attributes, model, compactionSignal };
}

export function startLogicalRequestSpan(
  options: LogicalRequestSpanOptions
): Span {
  ensureOtelInitialized();
  const { attributes, model, compactionSignal } =
    logicalRequestSpanData(options);

  const span = state.tracer.startSpan("autodev.routed_request", {
    kind: SpanKind.INTERNAL,
    attributes
  });
  logicalMetricContexts.set(span, {
    attributes: metricAttributes({
      model,
      workspace: options.workspace,
      role: options.role,
      providerRole: options.providerRole
    }),
    startedAt: performance.now(),
    requestId: options.requestId,
    compactionSignal
  });
  return span;
}

export interface EndLogicalRequestSpanOptions {
  status: "ok" | "error";
  errorMessage?: string | null | undefined;
  provider?: string | null | undefined;
}

export function endLogicalRequestSpan(
  span: Span,
  options: EndLogicalRequestSpanOptions
): void {
  try {
    if (options.status === "error") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: safeTrim(options.errorMessage) ?? "routing failure"
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    const metricContext = logicalMetricContexts.get(span);
    if (metricContext && instruments) {
      const outcome = options.status === "error" ? "error" : "success";
      const attributes = {
        ...metricContext.attributes,
        "autodev.router.outcome": outcome
      };
      instruments.logicalRequests.add(1, attributes);
      instruments.logicalRequestDuration.record(
        elapsedSeconds(metricContext.startedAt),
        attributes
      );
      if (
        options.status !== "error" &&
        metricContext.compactionSignal?.isCompaction
      ) {
        recordContextCompaction({
          requestId: metricContext.requestId,
          provider:
            options.provider ??
            metricContext.attributes[ATTR_GEN_AI_PROVIDER_NAME] ??
            null,
          model: metricContext.attributes[ATTR_GEN_AI_REQUEST_MODEL] ?? null,
          workspace: metricContext.attributes[ATTR_AUTODEV_WORKSPACE]
            ? { key: metricContext.attributes[ATTR_AUTODEV_WORKSPACE] }
            : null,
          role: metricContext.attributes[ATTR_AUTODEV_AGENT_ROLE] ?? null,
          providerRole:
            (metricContext.attributes["autodev.router.provider_role"] as
              "orchestrator" | "subagent" | null) ?? null,
          compaction: metricContext.compactionSignal.compaction
        });
      }
      logicalMetricContexts.delete(span);
    }
    span.end();
  } catch {
    logTelemetryError("logical_span_finalization_failed");
  }
}

export type SkillObservationEvent =
  "exposed" | "used" | "unavailable" | "error";

const SAFE_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SKILL_SOURCES = new Set(["role_contract", "skill_read"]);

/**
 * Record one accepted skill fact at the router's semantic boundary. Skill
 * names and source are span-only; metric dimensions are the bounded event,
 * workspace, and allowlisted agent role. Never attach paths, request IDs,
 * plugin IDs, or skill content.
 */
export function recordSkillObservation(options: {
  event: SkillObservationEvent;
  skill: string;
  source?: string | null;
  role?: string | null;
  workspace?: { key?: string | null } | null;
}): boolean {
  const name = safeTrim(options.skill);
  if (!name || !SAFE_SKILL_NAME_PATTERN.test(name)) return false;

  ensureOtelInitialized();
  const attributes: Record<string, string> = {
    "autodev.skill.event": options.event,
    "autodev.skill.name": name
  };
  const source = safeTrim(options.source);
  if (source && SKILL_SOURCES.has(source)) {
    attributes["autodev.skill.source"] = source;
  }
  const role = safeAutoDevAgentRole(options.role);
  if (role) attributes[ATTR_AUTODEV_AGENT_ROLE] = role;
  const workspace = safeAutoDevWorkspaceKey(options.workspace?.key);
  if (workspace) attributes[ATTR_AUTODEV_WORKSPACE] = workspace;

  try {
    const span = state.tracer.startSpan("autodev.skill", {
      kind: SpanKind.INTERNAL,
      attributes
    });
    if (options.event === "error") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: "skill operation failed"
      });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();

    instruments?.skillEvents.add(1, {
      "autodev.skill.event": options.event,
      ...(role && METRIC_AGENT_ROLES.has(role)
        ? { [ATTR_AUTODEV_AGENT_ROLE]: role }
        : {}),
      ...(workspace ? { [ATTR_AUTODEV_WORKSPACE]: workspace } : {})
    });
    return true;
  } catch {
    logTelemetryError("skill_observation_failed");
    return false;
  }
}

export interface AttemptSpanOptions {
  provider: string | null;
  model: string | null;
  /** AutoDev logical model selector, which may differ from the provider target. */
  requestedModel?: string | null;
  selection: string;
  attemptNumber: number;
  role?: string | null;
  workspace?: { key: string; cwd?: string | null } | null;
}

/**
 * Start a child GenAI client-operation span for one physical
 * provider/model attempt. The new span is parented to whatever span is
 * currently active in the OTel context, so the logical AutoDev
 * routed-request span (started by startLogicalRequestSpan and made active
 * via context.with(trace.setSpan(...))) becomes the parent.
 */
export function startAttemptSpan(options: AttemptSpanOptions): Span {
  ensureOtelInitialized();
  const attributes: Record<string, string | number | boolean> = {
    [ATTR_GEN_AI_OPERATION_NAME]: "chat",
    "autodev.router.selection": safeTrim(options.selection) ?? "primary",
    "autodev.router.attempt_number": options.attemptNumber
  };
  addAutoDevSpanContext(attributes, options);
  const provider = safeProviderName(options.provider);
  if (provider) attributes[ATTR_GEN_AI_PROVIDER_NAME] = provider;
  const model = safeModelName(options.model);
  if (model) attributes[ATTR_GEN_AI_REQUEST_MODEL] = model;
  const requestedModel = safeModelName(options.requestedModel);
  if (requestedModel) attributes["autodev.requested_model"] = requestedModel;
  const span = state.tracer.startSpan("gen_ai.client_operation", {
    kind: SpanKind.CLIENT,
    attributes
  });
  attemptMetricContexts.set(span, {
    attributes: {
      ...metricAttributes({
        provider: options.provider,
        model: options.model,
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(options.role ? { role: options.role } : {})
      }),
      [ATTR_GEN_AI_OPERATION_NAME]: "chat"
    },
    startedAt: performance.now()
  });
  return span;
}

export interface AttemptUsage {
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
}

export interface EndAttemptSpanOptions {
  status: "ok" | "error";
  statusCode?: number | null;
  errorType?: string | null;
  errorMessage?: string | null;
  finishReason?: string | null;
  usage?: AttemptUsage | null;
  responseModel?: string | null;
}

function finiteTokenCount(value: number | null | undefined): number | null {
  if (typeof value !== "number") return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function attachAttemptSpanAttributes(
  span: Span,
  options: EndAttemptSpanOptions
): void {
  if (
    typeof options.statusCode === "number" &&
    Number.isFinite(options.statusCode)
  ) {
    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, options.statusCode);
  }
  const responseModel = safeModelName(options.responseModel);
  if (responseModel)
    span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, responseModel);
  const finishReason = safeTrim(options.finishReason);
  if (finishReason) {
    span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [finishReason]);
  }
  if (options.usage) attachUsageAttributes(span, options.usage);
  if (options.status === "error") {
    const errorType = safeTrim(options.errorType);
    if (errorType) span.setAttribute(ATTR_GEN_AI_ERROR_TYPE, errorType);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: safeTrim(options.errorMessage) ?? "transport/upstream failure"
    });
  } else {
    span.setStatus({ code: SpanStatusCode.OK });
  }
}

function attachUsageAttributes(span: Span, usage: AttemptUsage): void {
  const input = finiteTokenCount(usage.input);
  const output = finiteTokenCount(usage.output);
  const cacheRead = finiteTokenCount(usage.cacheRead);
  if (input !== null) span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, input);
  if (output !== null)
    span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, output);
  if (cacheRead !== null && input !== null && cacheRead <= input) {
    span.setAttribute(ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, cacheRead);
  }
}

function recordAttemptMetrics(
  span: Span,
  options: EndAttemptSpanOptions
): void {
  const metricContext = attemptMetricContexts.get(span);
  if (!metricContext || !instruments) return;
  const attributes = { ...metricContext.attributes };
  const responseModel = safeModelName(options.responseModel);
  const errorType = safeTrim(options.errorType);
  if (responseModel) attributes[ATTR_GEN_AI_RESPONSE_MODEL] = responseModel;
  if (errorType) attributes[ATTR_GEN_AI_ERROR_TYPE] = errorType;
  instruments.genAiOperationDuration.record(
    elapsedSeconds(metricContext.startedAt),
    attributes
  );
  recordTokenMetrics(attributes, options.usage);
  attemptMetricContexts.delete(span);
}

export function endAttemptSpan(
  span: Span,
  options: EndAttemptSpanOptions
): void {
  try {
    attachAttemptSpanAttributes(span, options);
    recordAttemptMetrics(span, options);
    span.end();
  } catch {
    logTelemetryError("attempt_span_finalization_failed");
  }
}

/**
 * Adapt a context with a given parent span as the active span, run the
 * callback, and restore the previous context. Used by proxy entry points
 * to make the logical AutoDev routed-request span the active context for
 * any attempt spans that follow.
 */
export function withLogicalSpan<T>(
  span: Span,
  callback: () => Promise<T>
): Promise<T> {
  ensureOtelInitialized();
  const ctxWithSpan: Context = trace.setSpan(context.active(), span);
  return context.with(ctxWithSpan, callback);
}

export function withExtractedTraceContext<T>(
  carrier: Record<string, string | string[] | undefined>,
  callback: () => T
): T {
  try {
    const remoteContext = propagation.extract(context.active(), carrier);
    return context.with(remoteContext, callback);
  } catch {
    // Trace propagation is observational and must not affect the routed task.
    return callback();
  }
}

export function routerTelemetryTracer(): Tracer {
  return ensureOtelInitialized();
}
