import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDERS_CONTROL_API_TIMEOUT_MS,
  readProvidersSurface
} from "../app/providers/providers-reads.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "test-control-token"
};

/**
 * A Control API that accepts the request and answers it after `delayMs`.
 *
 * The shape is the one the live Control API produced under load: the service
 * is there, it is holding the connection open, and it answers -- just not
 * inside the Console's generic deadline.
 */
function answerAfter(delayMs: number): typeof globalThis.fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(Response.json({ schema: "autodev-control-providers-v3" }));
      }, delayMs);
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Request aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
    })) as typeof globalThis.fetch;
}

test(
  "the Providers surfaces read the Control API on a budget that fits their fan-out",
  { timeout: 30_000 },
  async () => {
    // Six seconds is past the generic 5-second Control API deadline and well
    // inside the Providers budget. Measured against the live Control API on a
    // loaded host, the Providers fan-out drains in 2.6-7.2 seconds, so the
    // generic deadline expired against a service that was answering every
    // request and the Console reported that as a Control API failure.
    const reads = await readProvidersSurface(CONFIG, {
      maxRetries: 0,
      fetchImpl: answerAfter(6000),
      includeModels: true,
      includeProviderVersions: true
    });

    // The response stub deliberately supplies only a schema marker. Reaching
    // contract validation proves that the transport completed without hitting
    // the generic deadline; this test does not exercise response schemas.
    for (const [label, result] of Object.entries(reads)) {
      assert.equal(
        result?.kind,
        "invalid-response",
        `a Providers read that answers after the generic Control API deadline must reach response validation rather than time out (${label}): ` +
          JSON.stringify(result)
      );
    }
  }
);

test("the Providers budget is the surface's, and a caller may still state its own", () => {
  assert.equal(PROVIDERS_CONTROL_API_TIMEOUT_MS, 20_000);
  assert.ok(
    PROVIDERS_CONTROL_API_TIMEOUT_MS > 5000,
    "the Providers budget must outlast the generic Control API deadline"
  );
});

test(
  "a Providers read that outlasts even the Providers budget is still a deadline, not a hang",
  { timeout: 30_000 },
  async () => {
    // The budget is a deadline, not a promise to wait forever: a Control API
    // that never answers still ends the read, and still says that the
    // deadline was what ended it.
    const reads = await readProvidersSurface(CONFIG, {
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

    const providers = reads.providers;
    assert.equal(providers.kind, "unreachable");
    assert.equal(
      providers.kind === "unreachable" ? providers.timedOut : undefined,
      true,
      "and it names the deadline rather than the service being down"
    );
  }
);
