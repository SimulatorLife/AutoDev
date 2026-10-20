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
 *
 * Four scopes answer with a failure instead of a snapshot, one for each way
 * the Usage contract says a read can fail, so the page's failure paths can
 * be reached at all rather than only described.
 */
import { createServer, type ServerResponse } from "node:http";

const PORT = Number(process.env.AUTODEV_OPENLIT_USAGE_FIXTURE_PORT ?? 4312);
const WORKSPACE_ID = "fixture/game";
const LOGICAL_REQUESTS = 12;

/**
 * The scopes that answer with a failure instead of a snapshot.
 *
 * The Usage contract distinguishes four ways a read can fail, and the Console
 * has to say which one happened: the transport failed, the response did not
 * validate, the service rejected the credential, or the service answered with
 * an HTTP error. A fixture that only ever answers correctly can only prove
 * that the Console renders a snapshot; it cannot prove that the Console keeps
 * metric cards off the page when the read failed, or that it names the
 * failure rather than reporting an empty interval.
 *
 * The scopes are chosen by the selection the Console sends, because that is
 * the only handle the Console's read has on the source: the request body
 * carries the scope it was asked for. Each one therefore reaches a different
 * failure path in the same request.
 */
const INVALID_RESPONSE_SCOPE = "7D";
const HTTP_ERROR_SCOPE = "3M";
const UNREACHABLE_SCOPE = "1M";
const UNAUTHORIZED_SCOPE = "CUSTOM";

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

/**
 * The scope the Console asked for.
 *
 * The request body carries the whole selection, and the scope is the part of
 * it that says which failure this read should meet.
 */
function requestedScope(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== "object") return null;
    const selection = (parsed as { readonly selection?: unknown }).selection;
    if (selection === null || typeof selection !== "object") return null;
    const range = (selection as { readonly range?: unknown }).range;
    return typeof range === "string" ? range : null;
  } catch {
    return null;
  }
}

/**
 * The answer for one scope.
 *
 * The three failure scopes each break the read in a different way, because
 * the three are different facts about the source: a body the contract cannot
 * validate, an HTTP status the source chose, and a connection that died
 * before the source answered at all.
 */
function respond(scope: string | null, response: ServerResponse): void {
  if (scope === INVALID_RESPONSE_SCOPE) {
    // A body that is not the Usage contract. The schema is right and the
    // payload is not, so the source answered and the answer is unusable.
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({ schema: "autodev-openlit-usage-v5", widgets: "none" })
      );
    return;
  }
  if (scope === HTTP_ERROR_SCOPE) {
    response
      .writeHead(503, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "the usage source is unavailable" }));
    return;
  }
  if (scope === UNAUTHORIZED_SCOPE) {
    // The source answered and refused the server credential. The Console
    // never sends that credential to the browser, so this is a fact about the
    // server-to-server read and nothing the operator can fix in the page.
    response
      .writeHead(401, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "the usage credential was refused" }));
    return;
  }
  if (scope === UNREACHABLE_SCOPE) {
    // The connection dies before the source answers, so the Console never
    // learns a status: the read failed in transport, not in the payload.
    response.socket?.destroy();
    return;
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify(usageResponse()));
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
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    respond(requestedScope(Buffer.concat(chunks).toString("utf8")), response);
  });
});
server.listen(PORT, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
