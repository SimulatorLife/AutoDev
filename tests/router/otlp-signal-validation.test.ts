import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type AddressInfo } from "node:net";
import test from "node:test";

import { checkOtelPayload } from "@simulatorlife/autodev-runtime/router/otel";
import {
  getRouterStatus,
  handle,
  resetOtelTelemetry
} from "@simulatorlife/autodev-runtime/router/server";

/**
 * The OTLP receiver used to believe any parseable JSON body.
 *
 * `ingestOtelSignal` took `payload: OtelPayload`, but its only production caller
 * handed it `JSON.parse` output, so the compiler checked nothing and every
 * field was read downstream as `payload?.resourceLogs ?? []`. That tolerates a
 * missing field and nothing else -- `?? []` does not make a non-iterable
 * iterable -- and the receiver counter was incremented before anything looked
 * at the body.
 *
 * The three failures that produced, all from bodies that were valid JSON:
 *
 * - a string where the batch array belongs iterated per character, ingested
 *   nothing, answered 200, and incremented the received count, so the receiver
 *   reported telemetry arriving that carried no telemetry;
 * - a shape that threw mid-ingestion left the body counted as *both* received
 *   and invalid, and the throw surfaced as "OTLP request must be valid JSON",
 *   which accuses an operator's syntax of something their syntax never did;
 * - `recordOtelLiveFeed` saw the unvalidated body too.
 */

/** Posts `body` to `path` on a loopback router, and reports what came back. */
async function withRouter(
  run: (
    post: (path: string, body: string) => Promise<Response>
  ) => Promise<void>
): Promise<void> {
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const post = (path: string, body: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
  try {
    await run(post);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function receiverCounters(): Readonly<Record<string, number>> {
  return (getRouterStatus().codexTelemetry as { readonly receiver: unknown })
    .receiver as Readonly<Record<string, number>>;
}

/** Bodies that parse as JSON but are not an OTLP payload for `logs`. */
const MALFORMED: readonly (readonly [string, string, RegExp])[] = [
  [
    "resourceLogs is an object",
    JSON.stringify({ resourceLogs: {} }),
    /must be an array/u
  ],
  [
    "resourceLogs is a string",
    JSON.stringify({ resourceLogs: "oops" }),
    /must be an array/u
  ],
  [
    "resourceLogs holds a null batch",
    JSON.stringify({ resourceLogs: [null] }),
    /must contain objects/u
  ],
  ["top level is an array", "[]", /must be a JSON object/u],
  ["top level is a string", '"hello"', /must be a JSON object/u],
  ["top level is null", "null", /must be a JSON object/u]
];

test("checkOtelPayload accepts a body, an empty batch, and one for another signal", () => {
  for (const value of [
    {},
    { resourceLogs: [] },
    { resourceLogs: [{ scopeLogs: [] }] },
    { resourceLogs: null },
    { resourceSpans: [{ scopeSpans: [] }] }
  ])
    assert.equal(
      checkOtelPayload("logs", value).ok,
      true,
      `${JSON.stringify(value)} is a usable logs payload`
    );
});

test("checkOtelPayload judges each body against the signal that was posted to", () => {
  // `/v1/traces` is judged on `resourceSpans`, so a bad traces field is caught
  // there and a bad logs field is not -- each endpoint reads only its own.
  assert.equal(checkOtelPayload("traces", { resourceSpans: "x" }).ok, false);
  assert.equal(checkOtelPayload("logs", { resourceLogs: "x" }).ok, false);
  assert.equal(checkOtelPayload("metrics", { resourceMetrics: {} }).ok, false);
  assert.equal(checkOtelPayload("traces", { resourceSpans: [] }).ok, true);
  assert.equal(
    checkOtelPayload("traces", { resourceSpans: [{ scopeSpans: [null] }] }).ok,
    false
  );
  // A body carrying another signal's field is not rejected for it: OTLP/HTTP
  // permits an absent batch field, and rejecting one would break a producer
  // that sends a valid, empty batch.
  assert.equal(checkOtelPayload("logs", { resourceSpans: [] }).ok, true);
});

for (const [label, body, expectedMessage] of MALFORMED) {
  test(`a logs body where ${label} is rejected as a shape error, not invalid JSON`, async () => {
    await withRouter(async (post) => {
      resetOtelTelemetry();
      const response = await post("/v1/logs", body);
      assert.equal(response.status, 400);
      assert.match(await response.text(), expectedMessage);

      const receiver = receiverCounters();
      // The defect this pins: the counter moved before the body was inspected,
      // so a rejected payload was credited as received *and* as invalid.
      assert.equal(receiver.logs, 0, "a rejected payload is never received");
      assert.equal(receiver.invalid, 1, "and is counted exactly once invalid");
    });
  });
}

test("unparseable JSON keeps the JSON message, so the two failures stay distinct", async () => {
  await withRouter(async (post) => {
    resetOtelTelemetry();
    const response = await post("/v1/logs", "{not json");
    assert.equal(response.status, 400);
    assert.match(await response.text(), /must be valid JSON/u);
    const receiver = receiverCounters();
    assert.equal(receiver.logs, 0);
    assert.equal(receiver.invalid, 1);
  });
});

test("a well-formed empty batch is still received", async () => {
  await withRouter(async (post) => {
    resetOtelTelemetry();
    const response = await post(
      "/v1/logs",
      JSON.stringify({ resourceLogs: [] })
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {});
    const receiver = receiverCounters();
    assert.equal(
      receiver.logs,
      1,
      "a valid batch is still counted as received"
    );
    assert.equal(receiver.invalid, 0);
  });
});

test("a well-formed non-empty batch is received on every signal", async () => {
  await withRouter(async (post) => {
    for (const [signal, field, scopeField] of [
      ["logs", "resourceLogs", "scopeLogs"],
      ["traces", "resourceSpans", "scopeSpans"],
      ["metrics", "resourceMetrics", "scopeMetrics"]
    ] as const) {
      resetOtelTelemetry();
      const response = await post(
        `/v1/${signal}`,
        JSON.stringify({ [field]: [{ [scopeField]: [] }] })
      );
      assert.equal(response.status, 200, `a valid ${signal} batch is accepted`);
      assert.equal(
        receiverCounters()[signal],
        1,
        `${signal} is counted as received exactly once`
      );
      assert.equal(receiverCounters().invalid, 0);
    }
  });
});
