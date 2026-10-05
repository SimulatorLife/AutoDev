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
   * Returns empty array if table has no rows or if ClickHouse is unreachable.
   */
  async listEvaluations(limit = 100): Promise<readonly EvaluationResult[]> {
    const { endpoint } = resolveOpenLitClickHouseConnection(this.options);
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const query =
      "SELECT id, span_id, created_at, meta, scores, " +
      "`evaluationData.evaluation`, `evaluationData.classification`, `evaluationData.explanation`, `evaluationData.verdict` " +
      "FROM openlit.openlit_evaluation " +
      `ORDER BY created_at DESC LIMIT ${safeLimit} FORMAT JSONEachRow`;

    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetchImpl(
        `${endpoint}&query=${encodeURIComponent(query)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal
        }
      );

      if (!response.ok) {
        return [];
      }

      const text = await response.text();
      return this.parseEvaluationRows(text);
    } catch {
      return [];
    }
  }

  parseEvaluationRows(text: string): readonly EvaluationResult[] {
    const lines = text
      .split(LINE_BREAK_PATTERN)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const results: EvaluationResult[] = [];

    for (const line of lines) {
      try {
        const row = JSON.parse(line) as RawClickHouseEvaluationRow;
        if (!row.id) continue;

        const evNames = row["evaluationData.evaluation"] ?? [];
        const verdicts = row["evaluationData.verdict"] ?? [];
        const scores = row.scores ?? {};

        const metrics: EvaluationMetric[] = [];
        for (const [name, value] of Object.entries(scores)) {
          const verdict = verdicts[evNames.indexOf(name)]?.toLowerCase();
          const effectiveVerdict =
            verdict ?? (Number(value) >= 0.5 ? "pass" : "fail");
          const pass =
            effectiveVerdict === "pass" || effectiveVerdict === "yes";

          metrics.push({
            name,
            value: Number(value),
            pass
          });
        }

        const passed = metrics.length > 0 ? metrics.every((m) => m.pass) : true;
        const meta = row.meta ?? {};
        const agentRole =
          meta.agentRole ?? meta.role ?? meta.agent ?? "unknown";
        const model = meta.model ?? meta["gen_ai.request.model"] ?? "unknown";
        const promptName = meta.promptName ?? meta.prompt ?? undefined;

        results.push({
          id: row.id,
          agentRole,
          ...(promptName ? { promptName } : {}),
          model,
          metrics,
          passed,
          timestamp: row.created_at
        });
      } catch {
        // Skip malformed rows
      }
    }

    return results;
  }
}
