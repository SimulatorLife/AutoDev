import "@simulatorlife/autodev-runtime/router/http";

import assert from "node:assert/strict";
import test from "node:test";

import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  CONCRETE_STATUS_MAX_ATTEMPTS,
  probeProvider,
  proxyConcreteResponse,
  proxyFallbackChain,
  UPSTREAM_TRANSPORT_MAX_ATTEMPTS
} from "@simulatorlife/autodev-runtime/router/proxy";
import type { ProviderRoute } from "@simulatorlife/autodev-runtime/router/routing";

function responseRecorder(): any {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: "",
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    writeHead(status: number, headers: Record<string, string | number>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.body = Buffer.concat(chunks).toString("utf8");
      this.writableEnded = true;
    },
    on() {
      return this;
    },
    removeListener() {
      return this;
    }
  };
}

const testRoute = (
  provider: string,
  envKey: string,
  healthUrl?: string
): ProviderRoute => ({
  provider,
  pattern: /.*/,
  baseUrl: `http://${provider}.test/v1`,
  envKey,
  healthUrl
});

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "content-type": "application/json" }
  });
}

function transportError(code = "ECONNRESET"): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = { code, syscall: "read" };
  return err;
}

test(
  "probeProvider retries timeout once with PROBE_RETRY_TIMEOUT_MS and succeeds",
  { concurrency: false },
  async () => {
    const previousKey = process.env.TEST_PROBE_KEY;
    process.env.TEST_PROBE_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    const calls: { url: string; timeoutMs?: number }[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push({ url });
      if (calls.length === 1) {
        throw new DOMException("The operation timed out", "TimeoutError");
      }
      return new Response("OK", { status: 200 });
    }) as typeof fetch;

    try {
      const route = testRoute(
        "mock-probe",
        "TEST_PROBE_KEY",
        "http://mock-probe.test/health"
      );
      const result = await probeProvider(route);
      assert.equal(result.ok, true);
      assert.equal(calls.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.TEST_PROBE_KEY;
      else process.env.TEST_PROBE_KEY = previousKey;
    }
  }
);

test(
  "probeProvider does not retry non-timeout probe errors",
  { concurrency: false },
  async () => {
    const previousKey = process.env.TEST_PROBE_KEY;
    process.env.TEST_PROBE_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("Internal Server Error", { status: 500 });
    }) as typeof fetch;

    try {
      const route = testRoute(
        "mock-probe",
        "TEST_PROBE_KEY",
        "http://mock-probe.test/health"
      );
      const result = await probeProvider(route);
      assert.equal(result.ok, false);
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.TEST_PROBE_KEY;
      else process.env.TEST_PROBE_KEY = previousKey;
    }
  }
);

test(
  "probeProvider exhausts retries after second timeout and returns probe failure",
  { concurrency: false },
  async () => {
    const previousKey = process.env.TEST_PROBE_KEY;
    process.env.TEST_PROBE_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new DOMException("The operation was aborted", "AbortError");
    }) as typeof fetch;

    try {
      const route = testRoute(
        "mock-probe",
        "TEST_PROBE_KEY",
        "http://mock-probe.test/health"
      );
      const result = await probeProvider(route);
      assert.equal(result.ok, false);
      assert.equal(calls, 2);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.TEST_PROBE_KEY;
      else process.env.TEST_PROBE_KEY = previousKey;
    }
  }
);

test(
  "concrete request retries pre-response transport failure up to UPSTREAM_TRANSPORT_MAX_ATTEMPTS",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < UPSTREAM_TRANSPORT_MAX_ATTEMPTS) {
        throw transportError("ECONNRESET");
      }
      return jsonResponse({
        id: "resp_transport_ok",
        status: "completed",
        model: "sonnet",
        output: []
      });
    }) as typeof fetch;

    try {
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        testRoute("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-transport-retry",
        null,
        null,
        null,
        { key: "session-transport-retry", scope: "identified" }
      );
      assert.equal(calls, UPSTREAM_TRANSPORT_MAX_ATTEMPTS);
      assert.equal(response.statusCode, 200);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "concrete request exhausts transport attempts, cools down provider, and sends 502",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw transportError("ECONNRESET");
    }) as typeof fetch;

    try {
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        testRoute("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-transport-exhaust",
        null,
        null,
        null,
        { key: "session-transport-exhaust", scope: "identified" }
      );
      assert.equal(calls, UPSTREAM_TRANSPORT_MAX_ATTEMPTS);
      assert.equal(response.statusCode, 502);
      assert.ok(COOLDOWNS.isCooling("claude"));
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "concrete request retries status failure at most once and stops after CONCRETE_STATUS_MAX_ATTEMPTS",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("bad gateway", { status: 502 });
    }) as typeof fetch;

    try {
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        testRoute("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-status-retry-limit",
        null,
        null,
        null,
        { key: "session-status-limit", scope: "identified" }
      );
      assert.equal(calls, CONCRETE_STATUS_MAX_ATTEMPTS);
      assert.equal(response.statusCode, 502);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "concrete transport and status failures share one retry budget",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw transportError();
      return new Response("bad gateway", { status: 502 });
    }) as typeof fetch;

    try {
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        testRoute("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-shared-retry-budget",
        null,
        null,
        null,
        { key: "session-shared-retry-budget", scope: "identified" }
      );

      // A transport retry already consumed the sole concrete-status retry
      // position, matching the previous shared attempt counter.
      assert.equal(calls, 2);
      assert.equal(response.statusCode, 502);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "concrete request does not retry after client abort",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    const ac = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      ac.abort();
      throw transportError("ECONNRESET");
    }) as typeof fetch;

    try {
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        testRoute("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-abort-noretry",
        null,
        null,
        ac.signal,
        { key: "session-abort", scope: "identified" }
      );
      assert.equal(calls, 1);
      assert.equal(COOLDOWNS.isCooling("claude"), false);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "fallback chain candidate retries transport errors up to UPSTREAM_TRANSPORT_MAX_ATTEMPTS before fallback",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousClaude = process.env.LITELLM_API_KEY;
    const previousMiniMax = process.env.MINIMAX_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("claude.test")) {
        throw transportError("ECONNRESET");
      }
      return jsonResponse({
        id: "resp_fallback_ok",
        status: "completed",
        model: "MiniMax-M3",
        output: []
      });
    }) as typeof fetch;

    try {
      const response = responseRecorder();
      await proxyFallbackChain(
        response,
        {
          candidates: [
            { ...testRoute("claude", "LITELLM_API_KEY"), model: "sonnet" },
            { ...testRoute("minimax", "MINIMAX_API_KEY"), model: "MiniMax-M3" }
          ],
          role: "worker",
          subject: "worker turn",
          sessionKey: "session-transport-chain",
          session: { key: "session-transport-chain", scope: "identified" }
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-transport-chain",
        null,
        null
      );
      const claudeCalls = calls.filter((c) => c.includes("claude.test"));
      const minimaxCalls = calls.filter((c) => c.includes("minimax.test"));
      assert.equal(claudeCalls.length, UPSTREAM_TRANSPORT_MAX_ATTEMPTS);
      assert.equal(minimaxCalls.length, 1);
      assert.equal(response.statusCode, 200);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousClaude === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousClaude;
      if (previousMiniMax === undefined) delete process.env.MINIMAX_API_KEY;
      else process.env.MINIMAX_API_KEY = previousMiniMax;
      COOLDOWNS.clearAll();
    }
  }
);
