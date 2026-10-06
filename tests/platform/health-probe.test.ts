import assert from "node:assert/strict";
import test from "node:test";

import { httpHealthProbe } from "@simulatorlife/autodev-runtime/platform/health-probe";

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

interface FetchStub {
  readonly calls: FetchCall[];
  restore(): void;
}

/** Replace the global fetch so a probe can be exercised without a socket. */
function stubFetch(respond: (url: string) => unknown): FetchStub {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url);
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    }
  };
}

test("a service that answers with a success status is healthy", async () => {
  const stub = stubFetch(() => ({ ok: true }));
  try {
    assert.equal(await httpHealthProbe("http://127.0.0.1:1/health")(), true);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.url, "http://127.0.0.1:1/health");
  } finally {
    stub.restore();
  }
});

test("a service that answers with a failure status is not healthy", async () => {
  const stub = stubFetch(() => ({ ok: false }));
  try {
    assert.equal(await httpHealthProbe("http://127.0.0.1:1/health")(), false);
  } finally {
    stub.restore();
  }
});

test("an unreachable service reports not-ready instead of throwing", async () => {
  // Readiness waits poll this through a boolean contract, so a refused
  // connection has to arrive as `false` rather than reject.
  const stub = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    assert.equal(await httpHealthProbe("http://127.0.0.1:1/health")(), false);
  } finally {
    stub.restore();
  }
});

test("a caller may add fetch options, as Console does to bypass the HTTP cache", async () => {
  const stub = stubFetch(() => ({ ok: true }));
  try {
    const probe = httpHealthProbe("http://127.0.0.1:1/api/health", {
      cache: "no-store"
    });
    assert.equal(await probe(), true);
    assert.equal(stub.calls[0]?.init.cache, "no-store");
  } finally {
    stub.restore();
  }
});

test("the probe keeps its own request bound even when a caller supplies a signal", async () => {
  // The one-second ceiling is what keeps a service that accepts the connection
  // and then stalls from outliving the readiness wait driving it, so it must not
  // be something a caller's options can drop.
  const stub = stubFetch(() => ({ ok: true }));
  try {
    const callerSignal = new AbortController().signal;
    const probe = httpHealthProbe("http://127.0.0.1:1/health", {
      signal: callerSignal
    });
    assert.equal(await probe(), true);
    const signal = stub.calls[0]?.init.signal;
    assert.ok(signal, "a probe must always carry a timeout signal");
    assert.notEqual(signal, callerSignal);
  } finally {
    stub.restore();
  }
});
