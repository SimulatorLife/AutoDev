import {
  evaluationCriterionVerdict,
  type EvaluationMetric,
  type EvaluationOutcome,
  evaluationOutcome,
  type EvaluationResult,
  type EvaluationResultsFilter,
  type EvaluationResultSubject,
  type EvaluationTraceSpan,
  type EvaluationVerdict
} from "@simulatorlife/autodev-core";

import {
  type OpenLitClickHouseOptions,
  resolveOpenLitClickHouseConnection
} from "../openlit/clickhouse-config.ts";

/** Producer label for rows written by AutoDev evaluation runs. */
export const AUTODEV_EVALUATION_SOURCE = "autodev";

/**
 * Storage encoding of AutoDev evaluation rows in OpenLIT's
 * `openlit_evaluation.meta` map. Owned here so writers and readers agree.
 */
export const EVALUATION_META = {
  source: "source",
  definition: "autodev.evaluation.definition",
  revision: "autodev.evaluation.definition.revision",
  run: "autodev.evaluation.run",
  runStartedAt: "autodev.evaluation.run.started_at",
  runExpected: "autodev.evaluation.run.expected",
  caseId: "autodev.evaluation.case",
  target: "autodev.evaluation.target",
  agentRole: "autodev.agent.role",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  prompt: "autodev.prompt.name",
  judgeModel: "autodev.evaluation.judge.model",
  outcome: "autodev.evaluation.outcome",
  error: "autodev.evaluation.error",
  traceId: "trace_id",
  thresholdPrefix: "autodev.evaluation.threshold.",
  /** OpenLIT's own judge-model label (`provider/model`). */
  openlitModel: "model"
} as const;

/** OpenLIT sources that mark sampling skips or human feedback, not judged evaluations. */
const NON_EVALUATION_SOURCES = ["auto_skipped", "manual_feedback"] as const;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESULTS_LIMIT = 500;
const MAX_RUNS_LIMIT = 100;
const MAX_TRACE_SPANS = 200;
const MAX_EXPLANATION_LENGTH = 1000;
const MAX_CLASSIFICATION_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 200;
const LINE_BREAK_PATTERN = /\r?\n/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/u;
const NON_NEGATIVE_INTEGER_PATTERN = /^\d{1,9}$/u;
const ISO_UTC = "'%Y-%m-%dT%H:%i:%SZ'";

export interface EvaluationRepositoryOptions extends OpenLitClickHouseOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/** One store read; `unavailable` carries a redacted diagnostic, never a fabricated empty value. */
export type EvaluationStoreRead<T> =
  | { readonly status: "available"; readonly value: T }
  | { readonly status: "unavailable"; readonly message: string };

export type EvaluationStoreWrite =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface StoredEvaluationRun {
  readonly runId: string;
  readonly definitionId: string;
  readonly startedAt: string | null;
  readonly lastResultAt: string | null;
  readonly expectedResults: number | null;
  readonly observedResults: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly unknown: number;
}

export interface EvaluationMetricRecord {
  readonly name: string;
  readonly score: number;
  readonly threshold: number;
  readonly classification: string | null;
  readonly explanation: string | null;
}

/** A result produced by an AutoDev evaluation run, ready to persist. */
export interface EvaluationResultRecord {
  readonly id: string;
  readonly createdAt: Date;
  readonly definitionId: string;
  readonly definitionRevision: string;
  readonly runId: string;
  readonly runStartedAt: string;
  readonly runExpectedResults: number;
  readonly caseId: string;
  readonly subject: EvaluationResultSubject;
  readonly responseModel: string | null;
  readonly judgeModel: string;
  readonly metrics: readonly EvaluationMetricRecord[];
  /** Bounded categorical code when the case could not be judged. */
  readonly error: string | null;
  readonly spanId: string | null;
  readonly traceId: string | null;
}

interface QueryParameters {
  readonly [name: string]: string | number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: unknown, maxLength?: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return maxLength === undefined ? trimmed : trimmed.slice(0, maxLength);
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    return null;
  return value as string[];
}

function countValue(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && NON_NEGATIVE_INTEGER_PATTERN.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function finiteNumber(value: unknown): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

/** OpenLIT verdicts report whether the criterion's issue was detected. */
function storedVerdict(value: string | undefined): EvaluationVerdict {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "yes") return "fail";
  if (normalized === "no") return "pass";
  return "unknown";
}

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * Typed adapter for OpenLIT's `openlit_evaluation` result store and the
 * `otel_traces` spans linked to evaluation results. Every filter is a bound
 * ClickHouse query parameter; no caller-supplied SQL is ever executed.
 */
export class EvaluationRepository {
  private readonly options: OpenLitClickHouseOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: EvaluationRepositoryOptions = {}) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listResults(
    filter: EvaluationResultsFilter = {},
    limit = 100
  ): Promise<EvaluationStoreRead<EvaluationResult[]>> {
    const parameters: Record<string, string | number> = {
      limit: Math.max(1, Math.min(Math.trunc(limit), MAX_RESULTS_LIMIT))
    };
    const conditions = [
      `meta['${EVALUATION_META.source}'] NOT IN (${sqlStringList(NON_EVALUATION_SOURCES)})`
    ];
    const filterColumns: ReadonlyArray<
      [keyof EvaluationResultsFilter, string]
    > = [
      ["definition", EVALUATION_META.definition],
      ["run", EVALUATION_META.run],
      ["agent", EVALUATION_META.agentRole],
      ["model", EVALUATION_META.requestModel],
      ["prompt", EVALUATION_META.prompt]
    ];
    for (const [field, metaKey] of filterColumns) {
      const value = filter[field];
      if (value === undefined) continue;
      parameters[field] = value;
      conditions.push(`meta['${metaKey}'] = {${field}:String}`);
    }
    const read = await this.select(
      `${RESULT_COLUMNS} FROM openlit_evaluation WHERE ${conditions.join(" AND ")} ` +
        "ORDER BY created_at DESC LIMIT {limit:UInt32}",
      parameters
    );
    return read.status === "available" ? parseResultRows(read.value) : read;
  }

  async getResult(
    id: string
  ): Promise<EvaluationStoreRead<EvaluationResult | null>> {
    if (!UUID_PATTERN.test(id)) return { status: "available", value: null };
    const read = await this.select(
      `${RESULT_COLUMNS} FROM openlit_evaluation WHERE id = toUUID({id:String}) ` +
        `AND meta['${EVALUATION_META.source}'] NOT IN (${sqlStringList(NON_EVALUATION_SOURCES)}) LIMIT 1`,
      { id }
    );
    if (read.status !== "available") return read;
    const parsed = parseResultRows(read.value);
    return parsed.status === "available"
      ? { status: "available", value: parsed.value[0] ?? null }
      : parsed;
  }

  /** Aggregated AutoDev runs, newest first, from their stored results. */
  async listRuns(
    options: { readonly definition?: string; readonly limit?: number } = {}
  ): Promise<EvaluationStoreRead<StoredEvaluationRun[]>> {
    const parameters: Record<string, string | number> = {
      source: AUTODEV_EVALUATION_SOURCE,
      limit: Math.max(
        1,
        Math.min(Math.trunc(options.limit ?? 20), MAX_RUNS_LIMIT)
      )
    };
    const conditions = [
      `meta['${EVALUATION_META.source}'] = {source:String}`,
      `meta['${EVALUATION_META.run}'] != ''`
    ];
    if (options.definition !== undefined) {
      parameters.definition = options.definition;
      conditions.push(
        `meta['${EVALUATION_META.definition}'] = {definition:String}`
      );
    }
    const outcome = `meta['${EVALUATION_META.outcome}']`;
    const read = await this.select(
      `SELECT meta['${EVALUATION_META.run}'] AS run_id, ` +
        `any(meta['${EVALUATION_META.definition}']) AS definition_id, ` +
        `min(meta['${EVALUATION_META.runStartedAt}']) AS started_at, ` +
        `formatDateTime(toTimeZone(max(created_at), 'UTC'), ${ISO_UTC}) AS last_result_at, ` +
        `max(toUInt32OrZero(meta['${EVALUATION_META.runExpected}'])) AS expected, ` +
        "count() AS observed, " +
        `countIf(${outcome} = 'passed') AS passed, ` +
        `countIf(${outcome} = 'failed') AS failed, ` +
        `countIf(${outcome} = 'error') AS errored, ` +
        `countIf(${outcome} NOT IN ('passed', 'failed', 'error')) AS unknown ` +
        `FROM openlit_evaluation WHERE ${conditions.join(" AND ")} ` +
        "GROUP BY run_id ORDER BY min(created_at) DESC, run_id DESC LIMIT {limit:UInt32}",
      parameters
    );
    if (read.status !== "available") return read;
    const runs: StoredEvaluationRun[] = [];
    for (const row of read.value) {
      const runId = optionalText(row.run_id);
      const definitionId = optionalText(row.definition_id);
      const expected = countValue(row.expected);
      const counts = [
        row.observed,
        row.passed,
        row.failed,
        row.errored,
        row.unknown
      ].map(countValue);
      if (
        !runId ||
        !definitionId ||
        expected === null ||
        counts.includes(null)
      ) {
        return malformed();
      }
      const [observed, passed, failed, errored, unknown] = counts as number[];
      runs.push({
        runId,
        definitionId,
        startedAt: optionalText(row.started_at),
        lastResultAt: optionalText(row.last_result_at),
        expectedResults: expected > 0 ? expected : null,
        observedResults: observed!,
        passed: passed!,
        failed: failed!,
        errored: errored!,
        unknown: unknown!
      });
    }
    return { status: "available", value: runs };
  }

  /**
   * Spans of the trace linked to an evaluation result, by recorded trace id or
   * by resolving the result's span id. Only categorical span fields are read.
   */
  async listTraceSpans(link: {
    readonly traceId: string | null;
    readonly spanId: string | null;
  }): Promise<EvaluationStoreRead<EvaluationTraceSpan[]>> {
    let condition: string;
    const parameters: Record<string, string | number> = {
      limit: MAX_TRACE_SPANS
    };
    if (link.traceId && TRACE_ID_PATTERN.test(link.traceId)) {
      condition = "TraceId = {trace:String}";
      parameters.trace = link.traceId;
    } else if (link.spanId && SPAN_ID_PATTERN.test(link.spanId)) {
      condition =
        "TraceId = (SELECT TraceId FROM otel_traces WHERE SpanId = {span:String} LIMIT 1)";
      parameters.span = link.spanId;
    } else {
      return { status: "available", value: [] };
    }
    const read = await this.select(
      "SELECT SpanId, ParentSpanId, SpanName, ServiceName, " +
        `formatDateTime(toTimeZone(Timestamp, 'UTC'), ${ISO_UTC}) AS started_at, ` +
        "toString(Duration) AS duration_ns, toString(StatusCode) AS status_code, " +
        "SpanAttributes['gen_ai.provider.name'] AS provider, " +
        "SpanAttributes['gen_ai.request.model'] AS request_model, " +
        "SpanAttributes['gen_ai.response.model'] AS response_model, " +
        "SpanAttributes['gen_ai.usage.input_tokens'] AS input_tokens, " +
        "SpanAttributes['gen_ai.usage.output_tokens'] AS output_tokens " +
        `FROM otel_traces WHERE ${condition} ORDER BY Timestamp ASC LIMIT {limit:UInt32}`,
      parameters
    );
    if (read.status !== "available") return read;
    const spans: EvaluationTraceSpan[] = [];
    for (const row of read.value) {
      const spanId = optionalText(row.SpanId);
      const name = optionalText(row.SpanName, 200);
      const startedAt = optionalText(row.started_at);
      if (!spanId || !name || !startedAt) return malformed();
      const durationNs = countValue(row.duration_ns);
      const status = String(row.status_code ?? "").toLowerCase();
      spans.push({
        spanId,
        parentSpanId: optionalText(row.ParentSpanId),
        name,
        serviceName: optionalText(row.ServiceName, 200),
        startedAt,
        durationMs: durationNs === null ? null : durationNs / 1_000_000,
        status: status.includes("error")
          ? "error"
          : status.includes("ok")
            ? "ok"
            : "unset",
        provider: optionalText(row.provider, 128),
        requestModel: optionalText(row.request_model, 128),
        responseModel: optionalText(row.response_model, 128),
        inputTokens: countValue(row.input_tokens),
        outputTokens: countValue(row.output_tokens)
      });
    }
    return { status: "available", value: spans };
  }

  async insertResults(
    records: readonly EvaluationResultRecord[]
  ): Promise<EvaluationStoreWrite> {
    if (records.length === 0) return { ok: true };
    const body = `${records.map((record) => JSON.stringify(encodeRecord(record))).join("\n")}\n`;
    const response = await this.request(
      "INSERT INTO openlit_evaluation (id, span_id, created_at, meta, scores, " +
        "`evaluationData.evaluation`, `evaluationData.classification`, " +
        "`evaluationData.explanation`, `evaluationData.verdict`) FORMAT JSONEachRow",
      {},
      body
    );
    return response.status === "available"
      ? { ok: true }
      : { ok: false, message: response.message };
  }

  private async select(
    query: string,
    parameters: QueryParameters
  ): Promise<EvaluationStoreRead<Record<string, unknown>[]>> {
    const response = await this.request(
      `${query} FORMAT JSONEachRow`,
      parameters
    );
    if (response.status !== "available") return response;
    const rows: Record<string, unknown>[] = [];
    for (const line of response.value.split(LINE_BREAK_PATTERN)) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        return malformed();
      }
      if (!isRecord(row)) return malformed();
      rows.push(row);
    }
    return { status: "available", value: rows };
  }

  /**
   * One bounded ClickHouse HTTP exchange. A SELECT travels in the request
   * body; an INSERT keeps its statement in the URL and rows in the body.
   */
  private async request(
    statement: string,
    parameters: QueryParameters,
    rows?: string
  ): Promise<EvaluationStoreRead<string>> {
    let connection: ReturnType<typeof resolveOpenLitClickHouseConnection>;
    let password: string;
    try {
      connection = resolveOpenLitClickHouseConnection(this.options);
      password =
        new URL(connection.endpoint).searchParams.get("password") ?? "";
    } catch {
      return {
        status: "unavailable",
        message: "OpenLIT ClickHouse connection is not configured."
      };
    }
    const url = new URL(connection.endpoint);
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(`param_${name}`, String(value));
    }
    if (rows !== undefined) {
      url.searchParams.set("query", statement);
      url.searchParams.set("date_time_input_format", "best_effort");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: rows ?? statement,
        redirect: "error",
        signal: controller.signal
      });
      const text = await readBoundedText(response);
      if (!response.ok) {
        return {
          status: "unavailable",
          message: redact(
            `OpenLIT evaluation store returned HTTP ${response.status}` +
              (text ? `: ${firstLine(text)}` : "."),
            password
          )
        };
      }
      if (text === null) {
        return {
          status: "unavailable",
          message: "OpenLIT evaluation store response exceeded the size limit."
        };
      }
      return { status: "available", value: text };
    } catch (error: unknown) {
      const reason = controller.signal.aborted
        ? "timed out"
        : error instanceof Error
          ? error.message
          : "request failed";
      return {
        status: "unavailable",
        message: redact(
          `OpenLIT evaluation store is unreachable (${reason}).`,
          password
        )
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

const RESULT_COLUMNS =
  "SELECT toString(id) AS id, span_id, " +
  `formatDateTime(toTimeZone(created_at, 'UTC'), ${ISO_UTC}) AS created_at, ` +
  "meta, scores, `evaluationData.evaluation` AS evaluations, " +
  "`evaluationData.classification` AS classifications, " +
  `arrayMap(x -> substring(x, 1, ${MAX_EXPLANATION_LENGTH}), \`evaluationData.explanation\`) AS explanations, ` +
  "`evaluationData.verdict` AS verdicts";

function malformed<T>(): EvaluationStoreRead<T> {
  return {
    status: "unavailable",
    message: "OpenLIT evaluation store returned a malformed row."
  };
}

function firstLine(text: string): string {
  return (text.split(LINE_BREAK_PATTERN)[0] ?? "")
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function redact(message: string, secret: string): string {
  return secret ? message.replaceAll(secret, "[REDACTED]") : message;
}

async function readBoundedText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  /* eslint-disable no-await-in-loop -- sequential reads enforce the aggregate response cap. */
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(next.value);
  }
  /* eslint-enable no-await-in-loop */
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8"
  );
}

function parseResultRows(
  rows: readonly Record<string, unknown>[]
): EvaluationStoreRead<EvaluationResult[]> {
  const results: EvaluationResult[] = [];
  for (const row of rows) {
    const result = parseResultRow(row);
    if (!result) return malformed();
    results.push(result);
  }
  return { status: "available", value: results };
}

interface StoredEvaluationData {
  readonly meta: Record<string, unknown>;
  readonly scores: Record<string, unknown>;
  readonly evaluations: readonly string[];
  readonly classifications: readonly string[];
  readonly explanations: readonly string[];
  readonly verdicts: readonly string[];
}

/**
 * Metrics of one stored row. AutoDev rows derive verdicts from their recorded
 * thresholds; other producers keep their stored verdict, with no threshold.
 */
function parseMetrics(
  data: StoredEvaluationData,
  autodev: boolean
): EvaluationMetric[] {
  const names = [
    ...data.evaluations,
    ...Object.keys(data.scores).filter(
      (name) => !data.evaluations.includes(name)
    )
  ];
  return names.map((name) => {
    const index = data.evaluations.indexOf(name);
    const score = finiteNumber(data.scores[name]);
    const threshold = autodev
      ? finiteNumber(data.meta[`${EVALUATION_META.thresholdPrefix}${name}`])
      : null;
    const stored = index === -1;
    return {
      name,
      score,
      threshold,
      verdict:
        threshold === null
          ? storedVerdict(stored ? undefined : data.verdicts[index])
          : evaluationCriterionVerdict(score, threshold),
      classification: stored
        ? null
        : optionalText(data.classifications[index], MAX_CLASSIFICATION_LENGTH),
      explanation: stored
        ? null
        : optionalText(data.explanations[index], MAX_EXPLANATION_LENGTH)
    };
  });
}

function storedEvaluationData(
  row: Record<string, unknown>
): StoredEvaluationData | null {
  const meta = row.meta ?? {};
  const scores = row.scores ?? {};
  const evaluations = stringArray(row.evaluations);
  const classifications = stringArray(row.classifications);
  const explanations = stringArray(row.explanations);
  const verdicts = stringArray(row.verdicts);
  return isRecord(meta) &&
    isRecord(scores) &&
    evaluations &&
    classifications &&
    explanations &&
    verdicts
    ? { meta, scores, evaluations, classifications, explanations, verdicts }
    : null;
}

function parseResultRow(row: Record<string, unknown>): EvaluationResult | null {
  const id = optionalText(row.id);
  const createdAt = optionalText(row.created_at);
  const data = storedEvaluationData(row);
  if (!id || !createdAt || !data) return null;
  const { meta } = data;
  const text = (key: string, maxLength?: number): string | null =>
    optionalText(meta[key], maxLength);
  const source = text(EVALUATION_META.source, 64);
  const metrics = parseMetrics(data, source === AUTODEV_EVALUATION_SOURCE);

  const error = text(EVALUATION_META.error, 64);
  const runId = text(EVALUATION_META.run, 64);
  const expected = countValue(meta[EVALUATION_META.runExpected]);
  const spanId = optionalText(row.span_id, 64);
  const traceId = text(EVALUATION_META.traceId, 64);
  return {
    id,
    source,
    definitionId: text(EVALUATION_META.definition, 64),
    definitionRevision: text(EVALUATION_META.revision, 64),
    run: runId
      ? {
          id: runId,
          startedAt: text(EVALUATION_META.runStartedAt, 64),
          expectedResults: expected !== null && expected > 0 ? expected : null
        }
      : null,
    caseId: text(EVALUATION_META.caseId, 64),
    subject: {
      targetKey: text(EVALUATION_META.target, 256),
      agent: text(EVALUATION_META.agentRole, 64),
      model: text(EVALUATION_META.requestModel, 128),
      prompt: text(EVALUATION_META.prompt, 64)
    },
    responseModel: text(EVALUATION_META.responseModel, 128),
    // OpenLIT's `model` meta names its judge, never the evaluated subject.
    judgeModel:
      source === AUTODEV_EVALUATION_SOURCE
        ? text(EVALUATION_META.judgeModel, 128)
        : text(EVALUATION_META.openlitModel, 128),
    metrics,
    outcome: evaluationOutcome(metrics, error),
    error,
    spanId: spanId && SPAN_ID_PATTERN.test(spanId) ? spanId : null,
    traceId: traceId && TRACE_ID_PATTERN.test(traceId) ? traceId : null,
    createdAt
  };
}

function encodeRecord(record: EvaluationResultRecord): Record<string, unknown> {
  const metrics: EvaluationMetric[] = record.metrics.map((metric) => ({
    name: metric.name,
    score: metric.score,
    threshold: metric.threshold,
    verdict: evaluationCriterionVerdict(metric.score, metric.threshold),
    classification: metric.classification,
    explanation: metric.explanation
  }));
  const outcome: EvaluationOutcome = evaluationOutcome(metrics, record.error);
  const meta: Record<string, string> = {
    [EVALUATION_META.source]: AUTODEV_EVALUATION_SOURCE,
    [EVALUATION_META.definition]: record.definitionId,
    [EVALUATION_META.revision]: record.definitionRevision,
    [EVALUATION_META.run]: record.runId,
    [EVALUATION_META.runStartedAt]: record.runStartedAt,
    [EVALUATION_META.runExpected]: String(record.runExpectedResults),
    [EVALUATION_META.caseId]: record.caseId,
    [EVALUATION_META.judgeModel]: record.judgeModel,
    [EVALUATION_META.outcome]: outcome
  };
  const optional: Array<[string, string | null]> = [
    [EVALUATION_META.target, record.subject.targetKey],
    [EVALUATION_META.agentRole, record.subject.agent],
    [EVALUATION_META.requestModel, record.subject.model],
    [EVALUATION_META.prompt, record.subject.prompt],
    [EVALUATION_META.responseModel, record.responseModel],
    [EVALUATION_META.error, record.error],
    [EVALUATION_META.traceId, record.traceId]
  ];
  for (const [key, value] of optional) if (value) meta[key] = value;
  for (const metric of metrics) {
    meta[`${EVALUATION_META.thresholdPrefix}${metric.name}`] = String(
      metric.threshold
    );
  }
  return {
    id: record.id,
    span_id: record.spanId ?? "",
    created_at: record.createdAt.toISOString(),
    meta,
    scores: Object.fromEntries(
      metrics.map((metric) => [metric.name, metric.score])
    ),
    "evaluationData.evaluation": metrics.map((metric) => metric.name),
    "evaluationData.classification": metrics.map(
      (metric) => metric.classification ?? ""
    ),
    "evaluationData.explanation": metrics.map((metric) =>
      (metric.explanation ?? "").slice(0, MAX_EXPLANATION_LENGTH)
    ),
    "evaluationData.verdict": metrics.map((metric) =>
      metric.verdict === "fail" ? "yes" : "no"
    )
  };
}
