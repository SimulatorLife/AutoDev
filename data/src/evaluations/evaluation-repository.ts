import {
  type EvaluationMetric,
  type EvaluationResult
} from "@simulatorlife/autodev-core";

import {
  type OpenLitClickHouseOptions,
  resolveOpenLitClickHouseConnection
} from "../openlit/clickhouse-config.ts";

const LINE_BREAK_PATTERN = /\r?\n/u;
// Stays below the Console's 5s Control API budget so an unresponsive
// ClickHouse ends this read instead of holding the Evaluations page until the
// Console abandons the whole Control API request.
const DEFAULT_QUERY_TIMEOUT_MS = 3000;

export class EvaluationSourceUnavailableError extends Error {
  constructor() {
    super("Evaluation history is unavailable.");
    this.name = "EvaluationSourceUnavailableError";
  }
}

export interface EvaluationQueryOptions extends OpenLitClickHouseOptions {
  readonly limit?: number;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
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

export class EvaluationRepository {
  private readonly options: OpenLitClickHouseOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: EvaluationQueryOptions = {}) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  }

  /**
   * Reads evaluation results from ClickHouse `openlit.openlit_evaluation`.
   * A query that has not completed within the timeout, body included, is
   * unavailable like any other failed read.
   */
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
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs)
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

    return lines.map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new EvaluationSourceUnavailableError();
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new EvaluationSourceUnavailableError();
      }

      const row = parsed as RawClickHouseEvaluationRow;
      if (
        typeof row.id !== "string" ||
        row.id.trim().length === 0 ||
        (row.span_id !== undefined &&
          (typeof row.span_id !== "string" || row.span_id.length > 256)) ||
        typeof row.created_at !== "string" ||
        row.created_at.trim().length === 0 ||
        (row.meta !== undefined &&
          (typeof row.meta !== "object" ||
            row.meta === null ||
            Array.isArray(row.meta)))
      ) {
        throw new EvaluationSourceUnavailableError();
      }

      const evNames = row["evaluationData.evaluation"] ?? [];
      const verdicts = row["evaluationData.verdict"] ?? [];
      const scores = row.scores ?? {};
      if (
        !Array.isArray(evNames) ||
        !evNames.every((name) => typeof name === "string") ||
        !Array.isArray(verdicts) ||
        !verdicts.every((verdict) => typeof verdict === "string") ||
        typeof scores !== "object" ||
        scores === null ||
        Array.isArray(scores)
      ) {
        throw new EvaluationSourceUnavailableError();
      }

      const metrics: EvaluationMetric[] = Object.entries(scores).map(
        ([name, value]) => {
          if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new EvaluationSourceUnavailableError();
          }
          const rawVerdict = verdicts[evNames.indexOf(name)]
            ?.trim()
            .toLowerCase();
          const pass =
            rawVerdict === "pass" ||
            rawVerdict === "passed" ||
            rawVerdict === "yes"
              ? true
              : rawVerdict === "fail" ||
                  rawVerdict === "failed" ||
                  rawVerdict === "no"
                ? false
                : null;
          return { name, value, pass };
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
    });
  }
}
