import {
  type EvaluationMetric,
  type EvaluationResult
} from "@simulatorlife/autodev-core";

import {
  type OpenLitClickHouseOptions,
  resolveOpenLitClickHouseConnection
} from "../openlit/clickhouse-config.ts";

const LINE_BREAK_PATTERN = /\r?\n/u;

export class EvaluationSourceUnavailableError extends Error {
  constructor() {
    super("Evaluation history is unavailable.");
    this.name = "EvaluationSourceUnavailableError";
  }
}

export interface EvaluationQueryOptions extends OpenLitClickHouseOptions {
  readonly limit?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface RawClickHouseEvaluationRow {
  readonly id: string;
  readonly span_id?: string;
  readonly created_at: string;
  readonly meta?: Record<string, string>;
  readonly "evaluationData.evaluation"?: readonly string[];
  readonly "evaluationData.classification"?: readonly string[];
  readonly "evaluationData.explanation"?: readonly string[];
  readonly "evaluationData.verdict"?: readonly string[];
  readonly scores?: Record<string, number>;
}

/** Verdicts ClickHouse rows spell as success, and as failure. */
const PASSING_VERDICTS: ReadonlySet<string> = new Set([
  "pass",
  "passed",
  "yes"
]);
const FAILING_VERDICTS: ReadonlySet<string> = new Set(["fail", "failed", "no"]);

/**
 * A metric verdict, as three states rather than two.
 *
 * A score says nothing about whether an evaluation passed, so an absent or
 * unrecognised verdict is `null` -- "not observed" -- and never `false`. The
 * label set was a nested ternary inside a loop inside a map; a row that failed
 * validation two lines earlier still had to be read through it.
 */
function verdictPass(verdict: string | undefined): boolean | null {
  const normalized = verdict?.trim().toLowerCase();
  if (normalized === undefined) return null;
  if (PASSING_VERDICTS.has(normalized)) return true;
  if (FAILING_VERDICTS.has(normalized)) return false;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The identity and timing every row needs before it can describe a run. */
function hasUsableIdentity(row: RawClickHouseEvaluationRow): boolean {
  if (typeof row.id !== "string" || row.id.trim().length === 0) return false;
  if (typeof row.created_at !== "string" || row.created_at.trim().length === 0)
    return false;
  if (
    row.span_id !== undefined &&
    (typeof row.span_id !== "string" || row.span_id.length > 256)
  )
    return false;
  return row.meta === undefined || isRecord(row.meta);
}

/**
 * The measurement columns must be presentable as lists.
 *
 * ClickHouse's `Array(String)` columns arrive as `[]` when unset and as
 * whatever it sent otherwise, so `?? []` covers the unset case and the type
 * checks cover the rest. A missing scores column is an empty object, which is
 * a row with no metrics rather than a broken row.
 */
function hasUsableMeasurements(row: RawClickHouseEvaluationRow): boolean {
  const names = row["evaluationData.evaluation"] ?? [];
  const verdicts = row["evaluationData.verdict"] ?? [];
  return (
    Array.isArray(names) &&
    names.every((name) => typeof name === "string") &&
    Array.isArray(verdicts) &&
    verdicts.every((verdict) => typeof verdict === "string") &&
    isRecord(row.scores ?? {})
  );
}

/**
 * One newline-delimited ClickHouse row into one evaluation result.
 *
 * Every rejection is the same `EvaluationSourceUnavailableError`: the caller
 * cannot act on *which* field was wrong, because ClickHouse is the upstream
 * and a row it cannot be read from is not a partial result. That made the three
 * inline guard blocks interchangeable, so they are named here instead -- a
 * reader can see what is being required without counting which `throw` it hit.
 */
function parseEvaluationRow(line: string): EvaluationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new EvaluationSourceUnavailableError();
  }
  if (!isRecord(parsed)) throw new EvaluationSourceUnavailableError();
  const row = parsed as unknown as RawClickHouseEvaluationRow;
  if (!hasUsableIdentity(row) || !hasUsableMeasurements(row))
    throw new EvaluationSourceUnavailableError();

  const evNames = row["evaluationData.evaluation"] ?? [];
  const verdicts = row["evaluationData.verdict"] ?? [];
  const scores = row.scores ?? {};

  const metrics: EvaluationMetric[] = Object.entries(scores).map(
    ([name, value]) => {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new EvaluationSourceUnavailableError();
      }
      return {
        name,
        value,
        pass: verdictPass(verdicts[evNames.indexOf(name)])
      };
    }
  );

  const hasFailedMetric = metrics.some((metric) => metric.pass === false);
  const allMetricsPassed =
    metrics.length > 0 && metrics.every((metric) => metric.pass === true);
  const passed = hasFailedMetric ? false : allMetricsPassed ? true : null;
  const meta = row.meta ?? {};
  const agentRole = meta.agentRole ?? meta.role ?? meta.agent ?? "unknown";
  const model = meta.model ?? meta["gen_ai.request.model"] ?? "unknown";
  const promptName = meta.promptName ?? meta.prompt ?? undefined;

  return {
    id: row.id,
    ...(row.span_id?.trim() ? { spanId: row.span_id.trim() } : {}),
    agentRole,
    ...(promptName ? { promptName } : {}),
    model,
    metrics,
    passed,
    timestamp: row.created_at
  };
}

export class EvaluationRepository {
  private readonly options: OpenLitClickHouseOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: EvaluationQueryOptions = {}) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Reads evaluation results from ClickHouse `openlit.openlit_evaluation`. */
  async listEvaluations(limit = 100): Promise<readonly EvaluationResult[]> {
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const query =
      "SELECT id, span_id, created_at, meta, scores, " +
      "`evaluationData.evaluation`, `evaluationData.classification`, `evaluationData.explanation`, `evaluationData.verdict` " +
      "FROM openlit.openlit_evaluation " +
      `ORDER BY created_at DESC LIMIT ${safeLimit} FORMAT JSONEachRow`;

    try {
      const { endpoint } = resolveOpenLitClickHouseConnection(this.options);
      const response = await this.fetchImpl(
        `${endpoint}&query=${encodeURIComponent(query)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" }
        }
      );

      if (!response.ok) throw new EvaluationSourceUnavailableError();
      return this.parseEvaluationRows(await response.text());
    } catch (error) {
      if (error instanceof EvaluationSourceUnavailableError) throw error;
      throw new EvaluationSourceUnavailableError();
    }
  }

  parseEvaluationRows(text: string): readonly EvaluationResult[] {
    const lines = text
      .split(LINE_BREAK_PATTERN)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    return lines.map(parseEvaluationRow);
  }
}
