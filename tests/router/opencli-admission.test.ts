import "@simulatorlife/autodev-runtime/router/http";

import assert from "node:assert/strict";
import test from "node:test";

import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  activeProviderRequests,
  getActiveRequests,
  proxyConcreteResponse,
  proxyFallbackChain
} from "@simulatorlife/autodev-runtime/router/proxy";
import {
  type Candidate,
  type ProviderRoute,
  ROUTING_POLICY,
  validateRoutingConfig
} from "@simulatorlife/autodev-runtime/router/routing";

function deferred<T = void>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function recorder(): any {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    body: "",
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

const KEY = "CODEX_ROUTER_OPENCLI_API_KEY";
const chatgptModel = "opencli-chatgpt-balanced";
const geminiModel = "opencli-gemini-3.8-flash";

/**
 * The site's configured route, with room for one request: the tests below
 * exercise what admission does once a route is full, which one turn then is.
 */
function candidate(provider: "opencli-chatgpt" | "opencli-gemini"): Candidate {
  const model = provider === "opencli-chatgpt" ? chatgptModel : geminiModel;
  const configured = ROUTING_POLICY.routeForModel(model);
  assert.ok(configured);
  assert.equal(configured.provider, provider);
  const { healthUrl: _healthUrl, ...withoutHealthProbe } = configured;
  return {
    ...withoutHealthProbe,
    model,
    baseUrl: `http://${provider}.test/v1`,
    maxConcurrentRequests: 1
  };
}

function response(id: string): Response {
  return Response.json({
    id,
    status: "completed",
    output: [],
    model: chatgptModel
  });
}

async function roleRequest(
  routes: Candidate[],
  id: string,
  signal: AbortSignal | null = null
) {
  const outgoing = recorder();
  await proxyFallbackChain(
    outgoing,
    { candidates: routes, role: "worker", subject: "admission regression" },
    { model: "autodev/worker", input: [], stream: false },
    false,
    id,
    null,
    null,
    signal
  );
  return outgoing;
}

async function concreteRequest(
  route: ProviderRoute,
  model: string,
  id: string,
  signal: AbortSignal | null = null
) {
  const outgoing = recorder();
  await proxyConcreteResponse(
    outgoing,
    route,
    { model, input: [], stream: false },
    false,
    id,
    null,
    null,
    signal
  );
  return outgoing;
}

async function withMockedProviders(fn: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const previousKey = process.env[KEY];
  process.env[KEY] = "test-key";
  COOLDOWNS.clearAll();
  activeProviderRequests.clear();
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env[KEY];
    else process.env[KEY] = previousKey;
    COOLDOWNS.clearAll();
    activeProviderRequests.clear();
  }
}

test("opencli sites declare separate, validated capacities: one per browser tab", () => {
  const chatgpt = ROUTING_POLICY.routeForModel(chatgptModel);
  const gemini = ROUTING_POLICY.routeForModel(geminiModel);
  assert.equal(chatgpt?.maxConcurrentRequests, 3);
  assert.equal(gemini?.maxConcurrentRequests, 1);
  assert.notEqual(chatgpt?.provider, gemini?.provider);
});

test("route capacities reject zero, fractional, and non-numeric limits", () => {
  const configured = ROUTING_POLICY.config;
  for (const invalid of [0, -1, 1.5, "1", null]) {
    assert.throws(
      () =>
        validateRoutingConfig({
          ...configured,
          routes: {
            ...configured.routes,
            "opencli-chatgpt": {
              ...configured.routes?.["opencli-chatgpt"],
              maxConcurrentRequests: invalid
            }
          }
        }),
      /maxConcurrentRequests must be a positive integer/
    );
  }
});

test(
  "a busy candidate is retried after the available alternative becomes unavailable",
  { concurrency: false },
  async () => {
    await withMockedProviders(async () => {
      const enteredFirst = deferred();
      const enteredAlternative = deferred();
      const releaseFirst = deferred();
      let chatgptRequests = 0;
      let geminiRequests = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("opencli-gemini.test/health")) {
          enteredAlternative.resolve();
          return new Response("temporarily unavailable", { status: 503 });
        }
        if (url.includes("opencli-gemini.test/v1/responses")) {
          geminiRequests += 1;
          return response("unexpected-gemini");
        }
        chatgptRequests += 1;
        if (chatgptRequests === 1) {
          enteredFirst.resolve();
          await releaseFirst.promise;
        }
        return response(`chatgpt-${chatgptRequests}`);
      }) as typeof fetch;
      const first = roleRequest(
        [candidate("opencli-chatgpt")],
        "cap-fallback-first"
      );
      await enteredFirst.promise;
      const unavailableAlternative = {
        ...candidate("opencli-gemini"),
        healthUrl: "http://opencli-gemini.test/health"
      };
      const second = roleRequest(
        [candidate("opencli-chatgpt"), unavailableAlternative],
        "cap-fallback-second"
      );
      await enteredAlternative.promise;
      assert.equal(chatgptRequests, 1);
      assert.equal(geminiRequests, 0);
      releaseFirst.resolve();
      assert.equal((await first).statusCode, 200);
      const result = await second;
      assert.equal(result.statusCode, 200);
      assert.match(result.body, /chatgpt-2/);
      assert.equal(chatgptRequests, 2);
      assert.equal(geminiRequests, 0);
      assert.equal(COOLDOWNS.isCooling("opencli-chatgpt"), false);
    });
  }
);

test(
  "a concurrent role turn uses an available alternate instead of queueing behind opencli",
  { concurrency: false },
  async () => {
    await withMockedProviders(async () => {
      const entered = deferred();
      const releaseFirst = deferred();
      const calls: string[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/health")) return response("healthy");
        calls.push(url);
        if (url.includes("opencli-chatgpt.test")) {
          entered.resolve();
          await releaseFirst.promise;
          return response("first");
        }
        return response("alternate");
      }) as typeof fetch;
      const first = roleRequest(
        [candidate("opencli-chatgpt")],
        "cap-alternate-first"
      );
      await entered.promise;
      assert.equal(getActiveRequests("opencli-chatgpt"), 1);
      const second = await roleRequest(
        [candidate("opencli-chatgpt"), candidate("opencli-gemini")],
        "cap-alternate-second"
      );
      assert.equal(second.statusCode, 200);
      assert.match(second.body, /alternate/);
      assert.equal(
        calls.filter((url) => url.includes("opencli-chatgpt.test")).length,
        1
      );
      assert.equal(
        calls.filter((url) => url.includes("opencli-gemini.test")).length,
        1
      );
      releaseFirst.resolve();
      assert.equal((await first).statusCode, 200);
      assert.equal(getActiveRequests("opencli-chatgpt"), 0);
      assert.equal(COOLDOWNS.isCooling("opencli-chatgpt"), false);
    });
  }
);

test(
  "sole-candidate role turns queue and complete on the same opencli provider",
  { concurrency: false },
  async () => {
    await withMockedProviders(async () => {
      const entered = deferred();
      const releaseFirst = deferred();
      let calls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/health")) return response("healthy");
        calls += 1;
        if (calls === 1) {
          entered.resolve();
          await releaseFirst.promise;
        }
        return response(`turn-${calls}`);
      }) as typeof fetch;
      const only = candidate("opencli-chatgpt");
      const first = roleRequest([only], "cap-sole-first");
      await entered.promise;
      const second = roleRequest([only], "cap-sole-second");
      await Promise.resolve();
      assert.equal(
        calls,
        1,
        "waiting turn must not reach the bridge before a slot is free"
      );
      releaseFirst.resolve();
      assert.equal((await first).statusCode, 200);
      const result = await second;
      assert.equal(result.statusCode, 200);
      assert.match(result.body, /turn-2/);
      assert.equal(calls, 2);
      assert.equal(getActiveRequests(only.provider), 0);
    });
  }
);

test(
  "direct concrete requests queue without switching providers and aborted queued requests never dispatch",
  { concurrency: false },
  async () => {
    await withMockedProviders(async () => {
      const entered = deferred();
      const releaseFirst = deferred();
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          entered.resolve();
          await releaseFirst.promise;
        }
        return response(`concrete-${calls}`);
      }) as typeof fetch;
      const route = candidate("opencli-chatgpt");
      const first = concreteRequest(route, chatgptModel, "cap-concrete-first");
      await entered.promise;
      const controller = new AbortController();
      const aborted = concreteRequest(
        route,
        chatgptModel,
        "cap-concrete-aborted",
        controller.signal
      );
      controller.abort();
      await aborted;
      assert.equal(calls, 1);
      const second = concreteRequest(
        route,
        chatgptModel,
        "cap-concrete-second"
      );
      releaseFirst.resolve();
      assert.equal((await first).statusCode, 200);
      assert.equal((await second).statusCode, 200);
      assert.equal(
        calls,
        2,
        "aborted queued request must not reach the bridge"
      );
      assert.equal(getActiveRequests(route.provider), 0);
    });
  }
);
