import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchWorkspacePlaytestApproval,
  PLAYTESTING_CONTROL_API_TIMEOUT_MS
} from "../src/lib/server/control-api.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "test-control-token"
};
const WORKSPACE_ID = "SimulatorLife/RacingGame";
const APPROVAL = {
  schema: "autodev-control-workspace-playtest-approval-v1",
  workspaceId: WORKSPACE_ID,
  workspaceEnabled: true,
  approval: null
};

/**
 * A Control API that accepts the request and answers it after `delayMs`.
 *
 * The Workspaces page reads one approval per workspace as a single fan-out,
 * and the Control API answers that read set from the ClickHouse-backed
 * playtesting store.
 */
function answerAfter(delayMs: number): typeof globalThis.fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(Response.json(APPROVAL));
      }, delayMs);
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Request aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    })) as typeof globalThis.fetch;
}

test(
  "the workspace playtesting approval read carries the playtesting budget",
  { timeout: 30_000 },
  async () => {
    // Six seconds is past the generic 5-second Control API deadline and well
    // inside the playtesting budget. This read is a playtesting read: the
    // Control API answers it from the same ClickHouse-backed store as the
    // playtesting page's own reads, and the Workspaces page reads one per
    // workspace as a single fan-out.
    const result = await fetchWorkspacePlaytestApproval(WORKSPACE_ID, CONFIG, {
      maxRetries: 0,
      fetchImpl: answerAfter(6000)
    });

    assert.equal(
      result.kind,
      "ok",
      "a playtesting read that answers after the generic Control API deadline must not be reported as a Control API failure: " +
        JSON.stringify(result)
    );
    if (result.kind === "ok") {
      assert.equal(result.data.workspaceId, WORKSPACE_ID);
    }
  }
);

test("a caller may still state its own deadline for the workspace approval read", {
  timeout: 30_000
}, async () => {
  const result = await fetchWorkspacePlaytestApproval(WORKSPACE_ID, CONFIG, {
    maxRetries: 0,
    timeoutMs: 200,
    fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const abortError = new Error("This operation was aborted");
        abortError.name = "AbortError";
        signal.addEventListener("abort", () => reject(abortError), {
          once: true
        });
      })) as typeof globalThis.fetch
  });

  assert.equal(result.kind, "unreachable");
  assert.equal(
    result.kind === "unreachable" ? result.timedOut : undefined,
    true,
    "and it names the deadline rather than the service being down"
  );
  assert.ok(
    PLAYTESTING_CONTROL_API_TIMEOUT_MS > 5000,
    "the playtesting budget must outlast the generic Control API deadline"
  );
});
