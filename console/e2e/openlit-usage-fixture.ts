/**
 * Deterministic, explicitly synthetic Usage telemetry fixture for browser
 * acceptance tests.
 *
 * It serves the fixed read-only `autodev-openlit-usage-v5` contract that
 * Data and the Console already speak, so the Console can render a Usage
 * surface without a live OpenLIT deployment. Only the widgets the acceptance
 * assertions depend on are observed; the rest answer as unobserved rather
 * than as zero, because a synthetic fixture that invented zeros would make
 * the surface look measured when nothing measured it.
 */
import { createServer } from "node:http";

const PORT = Number(process.env.AUTODEV_OPENLIT_USAGE_FIXTURE_PORT ?? 4312);
const WORKSPACE_ID = "fixture/game";
const LOGICAL_REQUESTS = 12;

/** The widget set the v5 contract requires, in the contract's own order. */
const USAGE_WIDGET_IDS = [
  "logical-requests",
  "requests-by-agent",
  "requests-by-workspace",
  "input-tokens",
  "output-tokens",
  "cache-rate",
  "p95-latency",
  "attempts-by-provider",
  "mcp-calls",
  "mcp-duration",
  "mcp-errors",
  "mcp-by-tool",
  "attempt-errors-by-provider",
  "context-compactions",
  "context-compactions-over-time",
  "context-compactions-by-workspace",
  "context-compactions-by-model",
  "context-compactions-by-agent",
  "git-commits",
  "git-files-changed",
  "git-files-added",
  "git-files-deleted",
  "git-lines-added",
  "git-lines-removed",
  "git-partial-commits",
  "git-commits-by-workspace",
  "git-commits-by-provider",
  "git-commits-by-agent",
  "skill-events-by-event",
  "estimated-cost"
] as const;

interface UsageWidget {
  readonly key: string;
  readonly querySucceeded: boolean;
  readonly observed: boolean;
  readonly partial: boolean;
  readonly rows: readonly unknown[];
  readonly valuePath?: string;
  readonly xAxis?: string;
  readonly yAxis?: string;
}

function unobserved(key: string): UsageWidget {
  return {
    key,
    querySucceeded: false,
    observed: false,
    partial: false,
    rows: []
  };
}

/**
 * The observed widgets the acceptance assertions read.
 *
 * `logical-requests` and `requests-by-workspace` agree on the same total, so
 * the breakdown is internally consistent with the count it sits beside.
 */
function observedWidgets(): readonly UsageWidget[] {
  return [
    {
      key: "logical-requests",
      querySucceeded: true,
      observed: true,
      partial: false,
      rows: [{ requests: String(LOGICAL_REQUESTS) }],
      valuePath: "0.requests"
    },
    {
      key: "requests-by-workspace",
      querySucceeded: true,
      observed: true,
      partial: false,
      rows: [{ g0: WORKSPACE_ID, requests: String(LOGICAL_REQUESTS) }],
      xAxis: "g0",
      yAxis: "requests"
    }
  ];
}

function usageResponse(): unknown {
  const observed = new Map(
    observedWidgets().map((widget) => [widget.key, widget])
  );
  return {
    schema: "autodev-openlit-usage-v5",
    widgets: USAGE_WIDGET_IDS.map(
      (key) => observed.get(key) ?? unobserved(key)
    ),
    filterOptions: {
      workspace: { supported: true, values: [WORKSPACE_ID] },
      provider: { supported: false, values: [] },
      model: { supported: false, values: [] },
      agent: { supported: false, values: [] },
      skill: { supported: false, values: [] }
    },
    traceList: { kind: "unavailable" }
  };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  // The Usage contract is a POST: the Console sends its selection in the
  // body, and the source answers with the widgets for that selection.
  if (request.method !== "POST") {
    response.writeHead(405).end();
    return;
  }
  if (url.pathname !== "/api/autodev/usage") {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(usageResponse()));
});
server.listen(PORT, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
