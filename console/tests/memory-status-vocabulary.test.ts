import assert from "node:assert/strict";
import test from "node:test";

import { fetchMemoryStatus } from "../src/lib/server/control-api.ts";

/**
 * The one memory read an operator can make without task-history access, and the
 * only thing that tells three states apart.
 *
 * Its validator says why it enumerates rather than accepting any string: a
 * Runtime that changed its vocabulary must render as `unavailable`, "the one
 * answer this read exists to avoid, arriving through the read meant to prevent
 * it". That claim was entirely untested — the page harness only ever answered
 * with `reachable`/`configured`, so the accepting arm ran and the refusing arm
 * never did, and the three states were equally unpinned.
 *
 * The consequence matters because every *other* memory read answers 503 when
 * storage is down. An operator reading only the records list cannot tell
 * "not configured" from "unreachable" from "nothing stored yet"; this read is
 * the only place that distinction exists, so a state that silently degrades to
 * a refusal removes it.
 */

const CONFIG = {
  baseUrl: "http://127.0.0.1:0",
  serviceToken: "s".repeat(64)
};

function status(storage: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "autodev-memory-status-v1",
    storage: { backend: "postgresql", probeTimeoutMs: 2500, ...storage }
  };
}

async function read(
  body: unknown
): Promise<Awaited<ReturnType<typeof fetchMemoryStatus>>> {
  return fetchMemoryStatus(CONFIG, {
    fetchImpl: (async () =>
      Response.json(body as never, {
        headers: { "content-type": "application/json" }
      })) as typeof fetch
  });
}

/** The three states the read exists to keep apart, each with its embeddings half. */
const STATES = [
  ["not_configured", "not_configured"],
  ["unreachable", "not_configured"],
  ["reachable", "configured"]
] as const;

for (const [state, embeddings] of STATES) {
  test(`storage reported as ${state} is read as ${state}`, async () => {
    const result = await read(status({ state, embeddings }));

    assert.equal(result.kind, "ok");
    assert.equal(
      result.kind === "ok" ? result.data.storage.state : null,
      state,
      "a state must not be normalised into another state on the way through"
    );
  });
}

/**
 * Everything the validator enumerates. Each of these is a Runtime that drifted,
 * and each must be refused rather than read as one of the three states.
 */
const REFUSALS: ReadonlyArray<readonly [string, unknown]> = [
  [
    "a state outside the contract's own list",
    status({ state: "degraded", embeddings: "configured" })
  ],
  [
    "an embeddings word outside the contract",
    status({ state: "reachable", embeddings: "pending" })
  ],
  [
    "a backend other than the one this Console speaks",
    status({ state: "reachable", embeddings: "configured", backend: "sqlite" })
  ],
  [
    "a probe timeout that is not a number",
    status({
      state: "reachable",
      embeddings: "configured",
      probeTimeoutMs: "2500"
    })
  ],
  [
    "a storage block that is not an object",
    { schema: "autodev-memory-status-v1", storage: null }
  ],
  [
    "a different schema",
    {
      ...status({ state: "reachable", embeddings: "configured" }),
      schema: "autodev-memory-status-v2"
    }
  ],
  ["a body that is not an object", null]
];

for (const [label, body] of REFUSALS) {
  test(`a storage status with ${label} is refused`, async () => {
    const result = await read(body);

    assert.equal(
      result.kind,
      "invalid-response",
      "a drifted vocabulary must not read as one of the three states"
    );
    assert.equal(
      "code" in result ? result.code : undefined,
      "autodev_control_api_invalid_memory_response",
      "the refusal has to be one the memory page reports as a failed read"
    );
  });
}
