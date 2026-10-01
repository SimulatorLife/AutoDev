import type {
  UsageFilterOptions,
  UsageFilterSelection,
  UsageMetricsData,
  UsageSnapshot,
  UsageVariableId,
  UsageWidgetId
} from "@simulatorlife/autodev-core";

const TRAILING_SLASHES = /\/+$/u;
const USAGE_API_PATH = "/api/autodev/usage";
const REQUEST_TIMEOUT_MS = 30_000;
type SupportedUsageVariableId = Exclude<UsageVariableId, "skill">;

const USAGE_VARIABLE_IDS: readonly SupportedUsageVariableId[] = [
  "workspace",
  "provider",
  "model",
  "agent"
];
const USAGE_WIDGET_IDS: readonly UsageWidgetId[] = [
  "logical-requests",
  "requests-by-agent",
  "input-tokens",
  "output-tokens",
  "cache-rate",
  "p95-latency",
  "attempts-by-provider",
  "mcp-calls",
  "mcp-duration",
  "mcp-errors",
  "mcp-by-tool"
];
const USAGE_WIDGET_ID_SET = new Set<string>(USAGE_WIDGET_IDS);

interface OpenLITRatio {
  readonly numerator: string;
  readonly denominator: string;
  readonly multiplier?: number;
}

interface OpenLITWidgetResult {
  readonly key: UsageWidgetId;
  readonly observed: boolean;
  readonly rows: readonly unknown[];
  readonly valuePath?: string;
  readonly ratio?: OpenLITRatio;
  readonly xAxis?: string;
  readonly yAxis?: string;
}

interface OpenLITUsageResponse {
  readonly schema: "autodev-openlit-usage-v1";
  readonly widgets: readonly OpenLITWidgetResult[];
  readonly filterOptions: Readonly<
    Record<
      SupportedUsageVariableId,
      { readonly supported: boolean; readonly values: readonly string[] }
    >
  >;
}

export interface OpenLITUsageClientConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

export type OpenLITUsageResult =
  | { readonly kind: "ok"; readonly data: UsageSnapshot }
  | { readonly kind: "unauthorized"; readonly status: number }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "unreachable" };

export class OpenLITUsageClient {
  readonly baseUrl: string;
  readonly serviceToken: string;
  readonly fetchImpl: typeof fetch;

  constructor(config: OpenLITUsageClientConfig) {
    this.baseUrl = config.baseUrl.replace(TRAILING_SLASHES, "");
    this.serviceToken = config.serviceToken;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  async query(selection: UsageFilterSelection): Promise<OpenLITUsageResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}${USAGE_API_PATH}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.serviceToken}`,
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ selection }),
          signal: controller.signal
        }
      );
      if (response.status === 401 || response.status === 403)
        return { kind: "unauthorized", status: response.status };
      if (!response.ok) return { kind: "http-error", status: response.status };

      const parsed = parseOpenLITUsageResponse(await response.json());
      if (!parsed) return { kind: "unreachable" };
      return { kind: "ok", data: toUsageSnapshot(parsed) };
    } catch {
      return { kind: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOpenLITUsageResponse(
  value: unknown
): OpenLITUsageResponse | null {
  if (!isRecord(value) || value.schema !== "autodev-openlit-usage-v1") {
    return null;
  }
  if (!Array.isArray(value.widgets)) return null;

  const widgets: OpenLITWidgetResult[] = [];
  const seenWidgetIds = new Set<UsageWidgetId>();
  for (const candidate of value.widgets) {
    const widget = parseWidgetResult(candidate);
    if (!widget || seenWidgetIds.has(widget.key)) return null;
    seenWidgetIds.add(widget.key);
    widgets.push(widget);
  }

  const filterOptions = parseFilterOptions(value.filterOptions);
  if (!filterOptions) return null;
  return { schema: "autodev-openlit-usage-v1", widgets, filterOptions };
}

function parseWidgetResult(candidate: unknown): OpenLITWidgetResult | null {
  if (
    !isRecord(candidate) ||
    typeof candidate.key !== "string" ||
    !USAGE_WIDGET_ID_SET.has(candidate.key) ||
    typeof candidate.observed !== "boolean" ||
    !Array.isArray(candidate.rows)
  ) {
    return null;
  }

  const ratio =
    candidate.ratio === undefined ? undefined : parseRatio(candidate.ratio);
  if (candidate.ratio !== undefined && ratio === null) return null;
  return {
    key: candidate.key as UsageWidgetId,
    observed: candidate.observed,
    rows: candidate.rows,
    ...(typeof candidate.valuePath === "string"
      ? { valuePath: candidate.valuePath }
      : {}),
    ...(ratio ? { ratio } : {}),
    ...(typeof candidate.xAxis === "string" ? { xAxis: candidate.xAxis } : {}),
    ...(typeof candidate.yAxis === "string" ? { yAxis: candidate.yAxis } : {})
  };
}

function parseRatio(value: unknown): OpenLITRatio | null {
  if (
    !isRecord(value) ||
    typeof value.numerator !== "string" ||
    typeof value.denominator !== "string"
  ) {
    return null;
  }
  if (
    value.multiplier !== undefined &&
    (typeof value.multiplier !== "number" || !Number.isFinite(value.multiplier))
  ) {
    return null;
  }
  return {
    numerator: value.numerator,
    denominator: value.denominator,
    ...(typeof value.multiplier === "number"
      ? { multiplier: value.multiplier }
      : {})
  };
}

function parseFilterOptions(
  value: unknown
): OpenLITUsageResponse["filterOptions"] | null {
  if (!isRecord(value)) return null;
  const filterOptions = {} as Record<
    SupportedUsageVariableId,
    { readonly supported: boolean; readonly values: readonly string[] }
  >;
  for (const id of USAGE_VARIABLE_IDS) {
    const option = value[id];
    if (
      !isRecord(option) ||
      typeof option.supported !== "boolean" ||
      !Array.isArray(option.values) ||
      !option.values.every((entry) => typeof entry === "string")
    ) {
      return null;
    }
    filterOptions[id] = {
      supported: option.supported,
      values: option.values as string[]
    };
  }
  return filterOptions;
}

function readValuePath(rows: readonly unknown[], path: string): unknown {
  const separator = path.indexOf(".");
  if (separator <= 0) return null;
  const rowIndex = Number(path.slice(0, separator));
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) return null;
  const row = rows[rowIndex];
  if (!isRecord(row)) return null;
  return row[path.slice(separator + 1)];
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function observedMetric(
  widget: OpenLITWidgetResult | undefined
): number | null {
  if (!widget?.observed || !widget.valuePath) return null;
  return numberValue(readValuePath(widget.rows, widget.valuePath));
}

function ratioMetric(widget: OpenLITWidgetResult | undefined): number | null {
  if (!widget?.observed || !widget.ratio) return null;
  const numerator = numberValue(
    readValuePath(widget.rows, widget.ratio.numerator)
  );
  const denominator = numberValue(
    readValuePath(widget.rows, widget.ratio.denominator)
  );
  if (numerator === null || denominator === null || denominator === 0)
    return null;
  return (numerator / denominator) * (widget.ratio.multiplier ?? 1);
}

function groupedRows(
  widget: OpenLITWidgetResult | undefined
): readonly { readonly name: string; readonly count: number }[] | null {
  if (!widget?.observed || !widget.xAxis || !widget.yAxis) return null;
  const rows: { readonly name: string; readonly count: number }[] = [];
  for (const candidate of widget.rows) {
    if (!isRecord(candidate)) return null;
    const name = candidate[widget.xAxis];
    const count = numberValue(candidate[widget.yAxis]);
    if (typeof name !== "string" || count === null || count < 0) return null;
    rows.push({ name, count });
  }
  return rows;
}

function toUsageSnapshot(response: OpenLITUsageResponse): UsageSnapshot {
  const widgets = new Map(
    response.widgets.map((widget) => [widget.key, widget])
  );
  const attempts = groupedRows(widgets.get("attempts-by-provider"));
  const requests = groupedRows(widgets.get("requests-by-agent"));
  const calls = groupedRows(widgets.get("mcp-by-tool"));
  const metrics: UsageMetricsData = {
    logicalRequests: observedMetric(widgets.get("logical-requests")),
    totalInputTokens: observedMetric(widgets.get("input-tokens")),
    totalOutputTokens: observedMetric(widgets.get("output-tokens")),
    cacheReadRate: ratioMetric(widgets.get("cache-rate")),
    p95LatencyMs: milliseconds(observedMetric(widgets.get("p95-latency"))),
    physicalAttempts:
      attempts === null
        ? null
        : attempts.reduce((total, row) => total + row.count, 0),
    mcpCalls: observedMetric(widgets.get("mcp-calls")),
    p95McpDurationMs: milliseconds(observedMetric(widgets.get("mcp-duration"))),
    mcpErrors: observedMetric(widgets.get("mcp-errors")),
    requestsByRole:
      requests === null
        ? null
        : requests.map(({ name, count }) => ({ role: name, count })),
    attemptsByProvider:
      attempts === null
        ? null
        : attempts.map(({ name, count }) => ({ provider: name, count })),
    callsByTool:
      calls === null
        ? null
        : calls.map(({ name, count }) => ({ tool: name, count }))
  };
  const filterOptions: UsageFilterOptions = {
    workspace: observedFilterOptions(response, "workspace"),
    provider: observedFilterOptions(response, "provider"),
    model: observedFilterOptions(response, "model"),
    agent: observedFilterOptions(response, "agent"),
    skill: null
  };
  return { metrics, filterOptions };
}

function observedFilterOptions(
  response: OpenLITUsageResponse,
  id: SupportedUsageVariableId
): readonly string[] | null {
  const option = response.filterOptions[id];
  return option.supported ? option.values : null;
}

function milliseconds(value: number | null): number | null {
  if (value === null) return null;
  const durationMs = value * 1000;
  return Number.isFinite(durationMs) ? durationMs : null;
}
