import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchControlApi,
  postControlApi
} from "../src/lib/server/control-api.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "control-api-deadline-test-token"
};

/**
 * A service that accepts the request and never answers it.
 *
 * Only the reader's own deadline can end this, which is the thing under test:
 * the promise it returns settles when the signal it was given aborts.
 */
function hang(): typeof globalThis.fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const abortError = new Error("This operation was aborted");
      abortError.name = "AbortError";
      signal.addEventListener("abort", () => reject(abortError), {
        once: true
      });
    })) as typeof globalThis.fetch;
}

test(
  "a caller-supplied signal does not remove the Console's own deadline",
  { timeout: 15_000 },
  async () => {
    // A caller that hands in its own signal used to *replace* the deadline, so
    // the read waited for the caller instead. A caller that waits for the read
    // then waits forever, and the page the read belongs to never renders. The
    // deadline belongs to the Console: it has to hold whatever the caller asked
    // for.
    const caller = new AbortController();
    const result = await fetchControlApi<unknown>("/control/agents", CONFIG, {
      fetchImpl: hang(),
      maxRetries: 0,
      signal: caller.signal,
      timeoutMs: 60
    });

    assert.equal(
      result.kind,
      "unreachable",
      "the read ended at the deadline instead of waiting for the caller: " +
        JSON.stringify(result)
    );
    assert.equal(
      result.kind === "unreachable" ? result.timedOut : undefined,
      true,
      "and it names the deadline rather than the caller's abort"
    );
  }
);

test(
  "a caller-supplied signal still ends a write that outlives the deadline",
  { timeout: 15_000 },
  async () => {
    const caller = new AbortController();
    const result = await postControlApi(
      "/control/agents/default",
      { enabled: true },
      CONFIG,
      {
        fetchImpl: hang(),
        maxRetries: 0,
        signal: caller.signal,
        timeoutMs: 60
      }
    );

    assert.equal(
      result.kind,
      "unreachable",
      "the write ended at the deadline instead of waiting for the caller: " +
        JSON.stringify(result)
    );
  }
);

test(
  "a caller's own abort still ends the read before the deadline does",
  { timeout: 15_000 },
  async () => {
    const caller = new AbortController();
    const read = fetchControlApi<unknown>("/control/agents", CONFIG, {
      fetchImpl: hang(),
      maxRetries: 0,
      signal: caller.signal,
      timeoutMs: 60_000
    });
    caller.abort();

    const result = await read;
    assert.equal(
      result.kind,
      "unreachable",
      "the caller's abort ended the read: " + JSON.stringify(result)
    );
    assert.equal(
      result.kind === "unreachable" ? result.timedOut === true : undefined,
      false,
      "and it is not reported as the Console's deadline, because it was not"
    );
  }
);
