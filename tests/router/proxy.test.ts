import "@simulatorlife/autodev-runtime/router/http";

import assert from "node:assert/strict";
import test from "node:test";

import {
  COOLDOWN_CONFIG,
  COOLDOWNS,
  type CooldownSummary
} from "@simulatorlife/autodev-runtime/router/cooldown";
import { getRecentRouterEvents } from "@simulatorlife/autodev-runtime/router/events";
import {
  CHAIN_SELECTION_DEADLINE_MS,
  CONCRETE_STATUS_MAX_ATTEMPTS,
  concreteRequestAttribution,
  declaredLimit,
  downstreamHeaders,
  EXHAUSTION_WAIT_MS,
  exhaustionBody,
  exhaustionHeaders,
  exhaustionWaitWindowMs,
  fallbackable,
  nonNegativeDuration,
  payloadForCandidate,
  positiveDuration,
  proxyConcreteResponse,
  proxyFallbackChain,
  proxyOrchestratorResponse,
  proxyRoleResponse
} from "@simulatorlife/autodev-runtime/router/proxy";
import {
  CONFIGURED_ORCHESTRATOR_MODEL,
  type ProviderRoute,
  ROUTES,
  ROUTING_POLICY
} from "@simulatorlife/autodev-runtime/router/routing";
import {
  agentActivity,
  ingestAgentEvents
} from "@simulatorlife/autodev-runtime/router/server";
import {
  noteOrchestratorSession,
  orchestratorProviderForSession,
  resetSubagentTelemetry,
  subagentProviderForThread
} from "@simulatorlife/autodev-runtime/router/subagents";
import { TOOL_CALL_OWNERSHIP } from "@simulatorlife/autodev-runtime/router/tool-call-ownership";
import { getDefaultUsageTracker } from "@simulatorlife/autodev-runtime/router/usage";
import { AUTODEV_WORKSPACE_KEY_HEADER } from "@simulatorlife/autodev-runtime/telemetry/resource-context";

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

const route = (provider: string, envKey: string): ProviderRoute => ({
  provider,
  pattern: /.*/,
  baseUrl: `http://${provider}.test/v1`,
  envKey
});

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("downstream headers and payload candidates preserve router-owned boundaries", () => {
  const previousKey = process.env.TEST_PROVIDER_KEY;
  process.env.TEST_PROVIDER_KEY = "sk-test-provider";
  try {
    const claude = ROUTES.find((candidate) => candidate.provider === "claude")!;
    const headers = downstreamHeaders(
      { ...claude, envKey: "TEST_PROVIDER_KEY" },
      null,
      '{"workspace":"safe"}',
      "worker",
      "req-1",
      { key: "session-1", scope: "identified" }
    );
    assert.equal(headers.authorization, "Bearer sk-test-provider");
    assert.equal(headers["x-codex-turn-metadata"], '{"workspace":"safe"}');
    assert.equal(headers["x-autodev-agent-role"], "worker");
    assert.equal(headers["x-autodev-session-id"], "session-1");
    assert.equal(headers["x-autodev-request-id"], "req-1");
  } finally {
    if (previousKey === undefined) delete process.env.TEST_PROVIDER_KEY;
    else process.env.TEST_PROVIDER_KEY = previousKey;
  }
});

test("downstream headers propagate the role read-only flag for non-orchestrator roles", () => {
  const previousKey = process.env.TEST_PROVIDER_KEY;
  process.env.TEST_PROVIDER_KEY = "sk-test-provider";
  try {
    const claude = ROUTES.find((candidate) => candidate.provider === "claude")!;
    const claudeRoute = { ...claude, envKey: "TEST_PROVIDER_KEY" };
    const explorerHeaders = downstreamHeaders(
      claudeRoute,
      null,
      null,
      "explorer",
      "req-2",
      { key: "session-2", scope: "identified" }
    );
    assert.equal(explorerHeaders["x-autodev-read-only"], "1");

    const workerHeaders = downstreamHeaders(
      claudeRoute,
      null,
      null,
      "worker",
      "req-3",
      { key: "session-3", scope: "identified" }
    );
    assert.equal(workerHeaders["x-autodev-read-only"], "0");

    const orchestratorHeaders = downstreamHeaders(
      claudeRoute,
      null,
      null,
      "orchestrator",
      "req-4",
      { key: "session-4", scope: "identified" }
    );
    assert.equal(
      orchestratorHeaders["x-autodev-read-only"],
      undefined,
      "orchestrator must not advertise a child read-only flag"
    );

    assert.deepEqual(
      payloadForCandidate(
        { model: "autodev/worker", reasoning: { effort: "none" } },
        { model: "sonnet", reasoningEffort: "high" }
      ),
      { model: "sonnet", reasoning: { effort: "high" } }
    );
  } finally {
    if (previousKey === undefined) delete process.env.TEST_PROVIDER_KEY;
    else process.env.TEST_PROVIDER_KEY = previousKey;
  }
});

test("declared limits, fallback classification, and exhaustion diagnostics remain structured", () => {
  const headers = new Headers({
    "x-autodev-limit-class": "quota_exhausted",
    "x-autodev-limit-resets-at": "2026-09-17T00:00:00.000Z",
    "x-autodev-limit-source": "reported"
  });
  const limit = declaredLimit(headers, "");
  assert.deepEqual(limit, {
    limitClass: "quota_exhausted",
    limitType: null,
    resetsAt: "2026-09-17T00:00:00.000Z",
    source: "reported"
  });
  assert.equal(fallbackable(503, "busy"), true);
  assert.equal(fallbackable(400, "invalid model name"), true);

  const summary: CooldownSummary[] = [
    {
      provider: "claude",
      model: "sonnet",
      state: "transient",
      failureClass: "capacity",
      resetsAt: null,
      retryAfterMs: 2000,
      detail: null
    }
  ];
  const body = exhaustionBody({
    subject: "worker turn",
    summary,
    failures: ["claude: HTTP 503"],
    model: "sonnet",
    requestId: "req-exhausted",
    lastResortAttempts: 1,
    deadlineReached: false
  });
  assert.equal((body as any).error.code, "router_provider_exhausted");
  assert.match((body as any).error.message, /worker turn/);
  assert.deepEqual(exhaustionHeaders({ summary, requestId: "req-exhausted" }), {
    "x-autodev-request-id": "req-exhausted",
    "retry-after": "2"
  });
});

test("an exhausted quota names the window the provider reported", () => {
  // agy reports a quota as "Resets in 24m43s." on stderr. That is an inferred
  // limit, so it keeps the transient ladder instead of sleeping 25 minutes on
  // the strength of free text -- but the window it named is still the truth
  // about the provider, and dropping it left the reader with a bare
  // "retry in 480s" derived from a failure streak that had nothing to do with
  // it. Both times are stated because they legitimately differ.
  const resetsAt = new Date(Date.now() + 24 * 60_000 + 43_000).toISOString();
  const summary: CooldownSummary[] = [
    {
      provider: "antigravity-gemini",
      model: "gemini-3.8-flash-high",
      state: "transient",
      failureClass: "quota_exhausted",
      resetsAt,
      retryAfterMs: 480_000,
      detail: null
    }
  ];
  const body = exhaustionBody({
    subject: "the orchestrator",
    summary,
    failures: ["antigravity: HTTP 429"],
    model: "gemini-3.8-flash-high",
    requestId: "req-quota",
    lastResortAttempts: 1,
    deadlineReached: false
  });
  const message = (body as any).error.message as string;
  assert.match(message, /quota_exhausted/);
  assert.match(message, /provider reports usage resets in 25m/);
  assert.match(message, /retrying in 480s/);
  // The provider's stated reset travels to the client as well, so a caller
  // that can schedule around it does not have to parse the prose.
  assert.equal(
    exhaustionHeaders({ summary, requestId: "req-quota" })[
      "x-autodev-limit-resets-at"
    ],
    resetsAt
  );
});

test("a reset the retry actually lands on is stated once, not twice", () => {
  const resetsAt = new Date(Date.now() + 480_000).toISOString();
  const summary: CooldownSummary[] = [
    {
      provider: "antigravity-gemini",
      model: "gemini-3.8-flash-high",
      state: "hard",
      failureClass: "quota_exhausted",
      resetsAt,
      retryAfterMs: 480_000,
      detail: null
    }
  ];
  const body = exhaustionBody({
    subject: "the orchestrator",
    summary,
    failures: ["antigravity: HTTP 429"],
    model: "gemini-3.8-flash-high",
    requestId: "req-hard",
    lastResortAttempts: 0,
    deadlineReached: false
  });
  const message = (body as any).error.message as string;
  assert.match(
    message,
    new RegExp(
      String.raw`resets at ${resetsAt.replaceAll(".", String.raw`\.`)}`
    )
  );
  assert.doesNotMatch(message, /retrying in/);
});

test("a concrete request's role and origin come from its thread, not its provider", () => {
  assert.deepEqual(
    concreteRequestAttribution({
      key: "s-root",
      scope: "identified",
      thread: "s-root"
    }),
    { role: "orchestrator", origin: "orchestrator" }
  );
  assert.deepEqual(
    concreteRequestAttribution({
      key: "s-root",
      scope: "identified",
      thread: "child-thread"
    }),
    { role: null, origin: "subagent" }
  );
  // A session with no thread id has no place in an agent tree.
  assert.deepEqual(
    concreteRequestAttribution({ key: "s-only", scope: "identified" }),
    { role: null, origin: "direct" }
  );
  assert.deepEqual(concreteRequestAttribution(null), {
    role: null,
    origin: "direct"
  });
});

test(
  "a concrete model picked for the root thread is attributed to the orchestrator; one picked for a child is not",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp_attr",
        status: "completed",
        model: "sonnet",
        output: []
      })) as typeof fetch;
    const usage = getDefaultUsageTracker();
    const roleAttempts = (role: string) =>
      usage.usageTelemetry.byRole[role]?.attempts ?? 0;
    try {
      const orchestratorBefore = roleAttempts("orchestrator");
      await proxyConcreteResponse(
        responseRecorder(),
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-concrete-root",
        null,
        null,
        null,
        {
          key: "s-concrete-root",
          scope: "identified",
          thread: "s-concrete-root"
        }
      );
      const root = agentActivity.getRecord("s-concrete-root");
      assert.equal(root?.role, "orchestrator");
      assert.equal(root?.origin, "orchestrator");
      const rootEvents = getRecentRouterEvents().filter(
        (event) => event.requestId === "req-concrete-root"
      );
      assert.ok(rootEvents.length > 0);
      for (const event of rootEvents) {
        assert.equal(event.role, "orchestrator");
        assert.equal(event.origin, "orchestrator");
      }
      assert.ok(roleAttempts("orchestrator") > orchestratorBefore);

      // A Codex model on a child thread is a subagent, never the orchestrator.
      const orchestratorAfterRoot = roleAttempts("orchestrator");
      await proxyConcreteResponse(
        responseRecorder(),
        route("codex", "LITELLM_API_KEY"),
        { model: CONFIGURED_ORCHESTRATOR_MODEL, input: [], stream: false },
        false,
        "req-concrete-child",
        null,
        null,
        null,
        {
          key: "s-concrete-root",
          scope: "identified",
          thread: "concrete-child"
        }
      );
      const child = agentActivity.getRecord("thread:concrete-child");
      assert.equal(child?.role, null);
      assert.equal(child?.origin, "subagent");
      const childEvents = getRecentRouterEvents().filter(
        (event) => event.requestId === "req-concrete-child"
      );
      assert.ok(childEvents.length > 0);
      for (const event of childEvents) {
        assert.equal(event.role, null);
        // Persisted with the event, so a replay after a restart still counts
        // this roleless request as a subagent's.
        assert.equal(event.origin, "subagent");
      }
      assert.equal(roleAttempts("orchestrator"), orchestratorAfterRoot);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "concrete proxy retries one fallbackable status without rerouting",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1
        ? new Response("temporarily unavailable", { status: 503 })
        : jsonResponse({
            id: "resp_1",
            status: "completed",
            model: "sonnet",
            output: []
          });
    }) as typeof fetch;
    try {
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-retry",
        null,
        null,
        null,
        { key: "session-retry", scope: "identified" }
      );
      assert.equal(calls, CONCRETE_STATUS_MAX_ATTEMPTS);
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /"status":"completed"/);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "a concrete request under a hard cooldown is refused locally, with no upstream attempt",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        id: "resp_never",
        status: "completed",
        model: "sonnet",
        output: []
      });
    }) as typeof fetch;
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    try {
      COOLDOWNS.cooldownProvider("claude", {
        failureClass: "quota_exhausted",
        resetsAt,
        structured: true
      });
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-cooled-concrete",
        null,
        null,
        null,
        { key: "session-cooled", scope: "identified" }
      );
      // The provider said it is out of usage until the reset it named, so it
      // is not asked again: there is no alternative provider to fall back to.
      assert.equal(calls, 0);
      // The refusal is terminal, in the chain's exhaustion shape: no
      // `retry-after`, because a window measured in days is an instruction the
      // caller cannot hurry.
      assert.equal(response.statusCode, 400);
      assert.equal(
        response.headers["x-autodev-limit-class"],
        "quota_exhausted"
      );
      assert.equal(response.headers["x-autodev-limit-resets-at"], resetsAt);
      assert.equal(response.headers["retry-after"], undefined);
      const body = JSON.parse(response.body);
      assert.equal(body.error.code, "router_provider_exhausted");
      assert.equal(body.error.retryable, false);
      assert.equal(body.error.failureClass, "quota_exhausted");
      assert.equal(body.error.model, "sonnet");
      assert.match(body.error.message, /claude/);
      assert.ok(
        body.error.message.includes(resetsAt),
        "the message names the provider's window"
      );
      const events = getRecentRouterEvents().filter(
        (event) => event.requestId === "req-cooled-concrete"
      );
      assert.ok(
        events.some(
          (event) =>
            event.phase === "skipped" &&
            event.failureClass === "quota_exhausted"
        ),
        "a refused cooled route is a skip, not an attempt"
      );
      assert.ok(
        events.some(
          (event) => event.phase === "result" && event.status === 400
        ),
        "the refusal is recorded as a failure result"
      );
      assert.ok(
        !events.some((event) => event.phase === "selected"),
        "a refused cooled route is never selected"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "a concrete request that reports a structured limit cools the route and is refused locally afterwards",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json(
        { error: { message: "quota exhausted" } },
        {
          status: 429,
          headers: {
            "x-autodev-limit-class": "quota_exhausted",
            "x-autodev-limit-source": "reported",
            "x-autodev-limit-resets-at": resetsAt
          }
        }
      );
    }) as typeof fetch;
    try {
      const first = responseRecorder();
      await proxyConcreteResponse(
        first,
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-limit-first",
        null,
        null,
        null,
        { key: "session-limit", scope: "identified" }
      );
      assert.equal(calls, 1);
      assert.equal(first.statusCode, 429);
      assert.equal(first.headers["x-autodev-limit-class"], "quota_exhausted");
      // The provider's own report cools the route, with the reset it named.
      const entry = COOLDOWNS.get("claude", Date.now(), "sonnet");
      assert.equal(entry?.kind, "hard");
      assert.equal(entry?.resetsAt, resetsAt);

      const second = responseRecorder();
      await proxyConcreteResponse(
        second,
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-limit-second",
        null,
        null,
        null,
        { key: "session-limit", scope: "identified" }
      );
      assert.equal(calls, 1);
      assert.equal(second.statusCode, 400);
      assert.equal(second.headers["x-autodev-limit-class"], "quota_exhausted");
      assert.equal(second.headers["retry-after"], undefined);
      assert.equal(
        JSON.parse(second.body).error.code,
        "router_provider_exhausted"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "a transient cooldown does not block a concrete request",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        id: "resp_transient",
        status: "completed",
        model: "sonnet",
        output: []
      });
    }) as typeof fetch;
    try {
      COOLDOWNS.cooldownProvider("claude", { failureClass: "upstream_error" });
      const entry = COOLDOWNS.get("claude", Date.now(), "sonnet");
      assert.equal(entry?.kind, "transient");
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-transient-concrete",
        null,
        null,
        null,
        { key: "session-transient", scope: "identified" }
      );
      // A transient cooldown is a blip the fallback chain treats as last-resort
      // material; a concrete request has no other provider to try, so it is
      // attempted rather than refused.
      assert.equal(calls, 1);
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
  "a hard cooldown with no known reset still permits a bounded probe",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        id: "resp_probe",
        status: "completed",
        model: "sonnet",
        output: []
      });
    }) as typeof fetch;
    try {
      COOLDOWNS.cooldownProvider("claude", {
        failureClass: "quota_exhausted",
        structured: true
      });
      const entry = COOLDOWNS.get("claude", Date.now(), "sonnet");
      assert.equal(entry?.kind, "hard");
      assert.equal(entry?.resetsAt, null);
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        route("claude", "LITELLM_API_KEY"),
        { model: "sonnet", input: [], stream: false },
        false,
        "req-no-reset-concrete",
        null,
        null,
        null,
        { key: "session-no-reset", scope: "identified" }
      );
      // Without a known reset the provider may have recovered, so the request
      // is probed once rather than refused.
      assert.equal(calls, 1);
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
  "role-scoped specialists reach Copilot after a late Antigravity quota failure",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const saved = {
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      CODEX_ROUTER_COPILOT_API_KEY: process.env.CODEX_ROUTER_COPILOT_API_KEY
    };
    process.env.LITELLM_API_KEY = "antigravity-key";
    process.env.CODEX_ROUTER_COPILOT_API_KEY = "copilot-key";
    const originalFetch = globalThis.fetch;
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("antigravity-gemini.test")) {
        now += CHAIN_SELECTION_DEADLINE_MS + 1;
        return new Response("quota exhausted", { status: 429 });
      }
      return jsonResponse({
        id: "resp_late_fallback",
        status: "completed",
        model: "copilot",
        output: []
      });
    }) as typeof fetch;
    try {
      for (const role of ["browser-tester", "playtester"] as const) {
        COOLDOWNS.clearAll();
        calls.length = 0;
        const response = responseRecorder();
        await proxyFallbackChain(
          response,
          {
            candidates: [
              {
                ...route("antigravity-gemini", "LITELLM_API_KEY"),
                model: "gemini-3.8-flash-medium"
              },
              {
                ...route("copilot", "CODEX_ROUTER_COPILOT_API_KEY"),
                model: "copilot"
              }
            ],
            role,
            subject: `${role} turn`
          },
          { model: `autodev/${role}`, input: [], stream: false },
          false,
          `req-late-fallback-${role}`,
          null,
          null
        );
        assert.deepEqual(calls, [
          "http://antigravity-gemini.test/v1/responses",
          "http://copilot.test/v1/responses"
        ]);
        assert.equal(response.statusCode, 200);
        assert.match(response.body, /resp_late_fallback/);
      }
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "fallback chain tries candidates in declared order and stops after success",
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
      return url.includes("claude.test")
        ? new Response("capacity", { status: 503 })
        : jsonResponse({
            id: "resp_2",
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
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" },
            { ...route("minimax", "MINIMAX_API_KEY"), model: "MiniMax-M3" }
          ],
          role: "worker",
          subject: "worker turn",
          sessionKey: "session-chain",
          session: { key: "session-chain", scope: "identified" }
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-chain",
        null,
        null
      );
      assert.deepEqual(calls, [
        "http://claude.test/v1/responses",
        "http://minimax.test/v1/responses"
      ]);
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /resp_2/);
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

test(
  "a provider-reported Antigravity quota error cools only the route that returned it",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "antigravity-test-key";
    const originalFetch = globalThis.fetch;
    const requestedModels: string[] = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      if (!String(input).endsWith("/responses"))
        throw new Error(`Unexpected Antigravity test URL: ${String(input)}`);
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        model?: string;
      };
      requestedModels.push(payload.model ?? "");
      return Response.json(
        { error: { message: "quota exhausted" } },
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-autodev-limit-class": "quota_exhausted",
            "x-autodev-limit-source": "reported",
            "x-autodev-limit-resets-at": new Date(
              Date.now() + 3_600_000
            ).toISOString()
          }
        }
      );
    }) as typeof fetch;

    const request = async (
      provider: string,
      model: string,
      requestId: string
    ) =>
      proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [{ ...route(provider, "LITELLM_API_KEY"), model }],
          role: "worker",
          subject: "worker turn",
          sessionKey: "agy-model-family-session",
          session: { key: "agy-model-family-session", scope: "identified" }
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        requestId,
        null,
        null
      );

    try {
      await request(
        "antigravity-claude-gpt",
        "claude-opus-5-5-high",
        "req-agy-claude-quota"
      );
      assert.equal(
        COOLDOWNS.get(
          "antigravity-claude-gpt",
          Date.now(),
          "gpt-oss-120b-medium"
        )?.failureClass,
        "quota_exhausted",
        "Claude and GPT-OSS share the antigravity-claude-gpt quota"
      );
      assert.equal(
        COOLDOWNS.get(
          "antigravity-gemini",
          Date.now(),
          "gemini-3.8-flash-medium"
        ),
        null,
        "a Claude quota failure must not block Antigravity Gemini"
      );

      COOLDOWNS.clearAll();
      await request(
        "antigravity-gemini",
        "gemini-3.8-flash-medium",
        "req-agy-gemini-quota"
      );
      assert.equal(
        COOLDOWNS.get("antigravity-gemini", Date.now(), "gemini-3.8-flash-high")
          ?.failureClass,
        "quota_exhausted",
        "Gemini variants share the antigravity-gemini quota"
      );
      assert.equal(
        COOLDOWNS.get(
          "antigravity-claude-gpt",
          Date.now(),
          "claude-opus-5-5-high"
        ),
        null,
        "a Gemini quota failure must not block Antigravity Claude/GPT-OSS"
      );
      assert.deepEqual(requestedModels, [
        "claude-opus-5-5-high",
        "gemini-3.8-flash-medium"
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "a tool result goes back to the provider that streamed the call",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    TOOL_CALL_OWNERSHIP.clear();
    const originalFetch = globalThis.fetch;
    const saved = {
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
    };
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
    const call = {
      type: "custom_tool_call",
      id: "ctc_owned",
      call_id: "call_owned_1",
      name: "exec",
      input: "text(1)",
      status: "completed"
    };
    const sse = [
      {
        type: "response.created",
        response: { id: "resp_call", status: "in_progress", output: [] }
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, input: "", status: "in_progress" }
      },
      { type: "response.output_item.done", output_index: 0, item: call },
      {
        type: "response.completed",
        response: { id: "resp_call", status: "completed", output: [call] }
      }
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join("");
    try {
      globalThis.fetch = (async () =>
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        })) as typeof fetch;
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates: [
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
          ],
          role: "worker",
          subject: "worker turn"
        },
        { model: "autodev/worker", input: [], stream: true },
        true,
        "req-issue",
        null,
        null
      );
      const answering = {
        model: "autodev/worker",
        stream: false,
        input: [
          call,
          {
            type: "custom_tool_call_output",
            call_id: "call_owned_1",
            output: "ok"
          }
        ]
      };
      assert.equal(TOOL_CALL_OWNERSHIP.ownerFor(answering), "claude");

      // The worker tier shuffles its providers per request, so one draw could
      // land on Claude by chance; every draw must.
      const firstTried: string[] = [];
      let current: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        current.push(String(input));
        return jsonResponse({
          id: "resp_next",
          status: "completed",
          output: []
        });
      }) as typeof fetch;
      for (let draw = 0; draw < 12; draw += 1) {
        current = [];
        await proxyRoleResponse(
          responseRecorder(),
          "worker",
          answering,
          false,
          `req-answer-${draw}`,
          null,
          null
        );
        firstTried.push(current[0] ?? "");
      }
      for (const url of firstTried)
        assert.match(
          url,
          /127\.0\.0\.1:4000/,
          "the Claude bridge, which issued the call, is tried first"
        );
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      TOOL_CALL_OWNERSHIP.clear();
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "one subagent thread is one live agent, however many requests it makes",
  { concurrency: false },
  async () => {
    // Observed 2026-09-18: an explorer that made 45 tool calls in two minutes
    // showed as dozens of live agents, because each request was its own
    // activity subject and each one ending in a tool call stayed live in
    // tool_wait until the TTL.
    COOLDOWNS.clearAll();
    agentActivity.reset();
    resetSubagentTelemetry();
    const originalFetch = globalThis.fetch;
    const saved = {
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
    };
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
    let sequence = 0;
    globalThis.fetch = (async () => {
      sequence += 1;
      const call = {
        type: "function_call",
        id: `fc_${sequence}`,
        call_id: `call_${sequence}`,
        name: "wait",
        arguments: "{}",
        status: "completed"
      };
      return jsonResponse({
        id: `resp_${sequence}`,
        status: "completed",
        output: [call]
      });
    }) as typeof fetch;
    try {
      noteOrchestratorSession("root-1", "codex", {
        model: CONFIGURED_ORCHESTRATOR_MODEL,
        workspace: null,
        requestId: "req-root"
      });
      for (let turn = 0; turn < 5; turn += 1) {
        await proxyRoleResponse(
          responseRecorder(),
          "explorer",
          { model: "autodev/explorer", input: [], stream: false },
          false,
          `req-child-${turn}`,
          null,
          null,
          null,
          { key: "root-1", scope: "identified", thread: "child-1" }
        );
      }
      assert.equal(
        getDefaultUsageTracker().countLiveAgentActivity({ role: "explorer" }),
        1
      );
      assert.equal(agentActivity.getState("thread:child-1"), "tool_wait");
      // A second child of the same root is a second agent.
      await proxyRoleResponse(
        responseRecorder(),
        "explorer",
        { model: "autodev/explorer", input: [], stream: false },
        false,
        "req-child2-0",
        null,
        null,
        null,
        { key: "root-1", scope: "identified", thread: "child-2" }
      );
      assert.equal(
        getDefaultUsageTracker().countLiveAgentActivity({ role: "explorer" }),
        2
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      agentActivity.reset();
      resetSubagentTelemetry();
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "a subagent's bridge events describe the subagent, never its orchestrator",
  { concurrency: false },
  async () => {
    // Observed 2026-09-19 with a MiniMax-served explorer under a Codex-served
    // orchestrator: every event the explorer's bridge posted landed on the
    // shared session key -- the orchestrator's record -- so the dashboard showed
    // no orchestrator, two explorers, and agents flipping in and out of view.
    COOLDOWNS.clearAll();
    agentActivity.reset();
    resetSubagentTelemetry();
    const originalFetch = globalThis.fetch;
    const saved = {
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
    };
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
    let sequence = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      sequence += 1;
      const call = {
        type: "custom_tool_call",
        id: `ctc_${sequence}`,
        call_id: `call_${sequence}`,
        name: "exec",
        input: "wait",
        status: "completed"
      };
      const completed = {
        id: `resp_${sequence}`,
        status: "completed",
        output: [call]
      };
      // Codex answers in SSE even to a non-streaming caller; the bridges answer in JSON.
      if (String(input).startsWith("https://chatgpt.com/")) {
        return new Response(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        );
      }
      return jsonResponse(completed);
    }) as typeof fetch;
    const root = { key: "root-1", scope: "identified", thread: "root-1" };
    const child = { key: "root-1", scope: "identified", thread: "child-1" };
    try {
      await proxyOrchestratorResponse(
        responseRecorder(),
        { model: "autodev/orchestrator", input: [], stream: false },
        false,
        "req-root-1",
        null,
        null,
        null,
        root
      );
      await proxyRoleResponse(
        responseRecorder(),
        "explorer",
        { model: "autodev/explorer", input: [], stream: false },
        false,
        "req-child-1",
        null,
        null,
        null,
        child
      );
      // The child's bridge reports that its request settled, as every bridge does at the end of a response.
      ingestAgentEvents({
        requestId: "req-child-1",
        events: [{ type: "activity", state: "finished" }, { type: "heartbeat" }]
      });

      const orchestrator = agentActivity.getRecord("root-1");
      assert.equal(
        orchestrator?.role,
        "orchestrator",
        "the child must not overwrite the orchestrator"
      );
      assert.notEqual(
        orchestrator?.provider,
        "minimax",
        "the child's provider must not replace the orchestrator's"
      );
      // It ended its request in a tool call (its wait on the child) and stays live; the
      // child's per-request report must not have finished it.
      assert.equal(orchestrator?.state, "tool_wait");
      // The router settled the child's request with a tool call: it is waiting on
      // that tool, not finished, whatever its bridge said about the request.
      assert.equal(agentActivity.getState("thread:child-1"), "tool_wait");
      assert.equal(
        getDefaultUsageTracker().countLiveAgentActivity({ role: "explorer" }),
        1
      );
      assert.equal(
        getDefaultUsageTracker().countLiveAgentActivity({
          role: "orchestrator"
        }),
        1
      );

      // What a child's bridge alone can report -- its own in-CLI delegation --
      // lands on the child.
      ingestAgentEvents({
        requestId: "req-child-1",
        events: [{ type: "activity", state: "subagent_wait" }]
      });
      assert.equal(agentActivity.getState("thread:child-1"), "subagent_wait");
      assert.equal(agentActivity.getRecord("root-1")?.role, "orchestrator");
      assert.equal(agentActivity.getState("root-1"), "tool_wait");
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      agentActivity.reset();
      resetSubagentTelemetry();
      COOLDOWNS.clearAll();
    }
  }
);

test("extractSelectedSkillContext returns the body of the selected-skill input item", async () => {
  const { extractSelectedSkillContext } =
    await import("@simulatorlife/autodev-runtime/router/proxy");
  const body = "<skill>...</skill>";
  assert.equal(
    extractSelectedSkillContext({
      input: [
        {
          type: "message",
          role: "user",
          content_item_kinds: ["skills.selected_skill_instructions"],
          content: body
        }
      ]
    }),
    body
  );
  // String content is supported.
  assert.equal(
    extractSelectedSkillContext({
      messages: [
        {
          type: "message",
          content_item_kinds: ["skills.selected_skill_instructions"],
          content: body
        }
      ]
    }),
    body
  );
  // An item without the right content_item_kinds is ignored.
  assert.equal(
    extractSelectedSkillContext({
      input: [
        {
          type: "message",
          content_item_kinds: ["plugins.recommendations"],
          content: body
        }
      ]
    }),
    null
  );
  assert.equal(extractSelectedSkillContext({}), null);
  assert.equal(extractSelectedSkillContext(null), null);
});

test("downstreamHeadersWithSkillContext forwards skill context and codex session id", async () => {
  const { downstreamHeadersWithSkillContext } =
    await import("@simulatorlife/autodev-runtime/router/proxy");
  const claude = ROUTES.find((candidate) => candidate.provider === "claude")!;
  const headers = downstreamHeadersWithSkillContext(
    { ...claude, envKey: "TEST_PROVIDER_KEY" },
    null,
    null,
    "explorer",
    "req-9",
    { key: "session-9", scope: "identified" },
    {
      skillContext: "<skill>...</skill>",
      codexSessionId: "codex-session-9",
      workspace: { key: "SimulatorLife/AutoDev" }
    }
  );
  assert.equal(headers["x-autodev-skill-context"], "<skill>...</skill>");
  assert.equal(headers["x-autodev-codex-session"], "codex-session-9");
  assert.equal(headers["x-autodev-workspace-key"], "SimulatorLife/AutoDev");

  const codex = ROUTES.find((candidate) => candidate.provider === "codex")!;
  const externalHeaders = downstreamHeadersWithSkillContext(
    codex,
    null,
    null,
    "worker",
    "req-external",
    null,
    { workspace: { key: "SimulatorLife/AutoDev" } }
  );
  assert.equal(
    externalHeaders[AUTODEV_WORKSPACE_KEY_HEADER],
    undefined,
    "AutoDev's internal workspace identity must not be sent to the external Codex API"
  );
});

test("an orchestrator turn may wait out a first-strike transient cooldown; a role request keeps its short window", () => {
  assert.equal(exhaustionWaitWindowMs(false), EXHAUSTION_WAIT_MS);
  assert.ok(
    exhaustionWaitWindowMs(true) >= COOLDOWN_CONFIG.providerCooldownMs,
    "with a shorter window a single-provider orchestrator tier can never be rescued by waiting"
  );
});

test("duration settings are strictly positive except the bounded wait, which takes 0 to mean never wait", () => {
  // docs/provider-routing.md makes this distinction explicit after promising a
  // `0` that, read against CODEX_ROUTER_PROVIDER_COOLDOWN_MS, would have been a
  // lie: every cooldown duration ignores 0 and falls back silently.
  assert.equal(positiveDuration("0", 30_000), 30_000);
  assert.equal(positiveDuration("-1", 30_000), 30_000);
  assert.equal(positiveDuration("", 30_000), 30_000);
  assert.equal(positiveDuration("nonsense", 30_000), 30_000);
  assert.equal(positiveDuration("15000", 30_000), 15_000);

  assert.equal(nonNegativeDuration("0", 20_000), 0);
  assert.equal(nonNegativeDuration("-1", 20_000), 20_000);
  assert.equal(nonNegativeDuration("", 20_000), 20_000);
  assert.equal(nonNegativeDuration("nonsense", 20_000), 20_000);

  // And the default-shaped environment really is the documented one: the wait
  // window disables at 0, the cooldown duration cannot.
  assert.ok(
    COOLDOWN_CONFIG.providerCooldownMs > 0,
    "a zero transient cooldown would remove load-shedding entirely, which is why it is not accepted"
  );
});

test(
  "the last-resort busy check does not count the caller's own agent",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    agentActivity.reset();
    const originalFetch = globalThis.fetch;
    const saved = {
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
    };
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp_wait",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "wait",
            arguments: "{}",
            status: "completed"
          }
        ]
      })) as typeof fetch;
    try {
      await proxyRoleResponse(
        responseRecorder(),
        "explorer",
        { model: "autodev/explorer", input: [], stream: false },
        false,
        "req-self",
        null,
        null,
        null,
        { key: "root-3", scope: "identified", thread: "self" }
      );
      // Waiting on a tool, the agent stays live on its provider.
      assert.equal(
        getDefaultUsageTracker().countLiveAgentActivity({ role: "explorer" }),
        1
      );
      assert.equal(
        getDefaultUsageTracker().countLiveAgentActivity(
          { role: "explorer" },
          Date.now(),
          undefined,
          "thread:self"
        ),
        0
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      agentActivity.reset();
    }
  }
);

test(
  "a fallback candidate whose connection breaks is retried in place, not cooled and abandoned",
  { concurrency: false },
  async () => {
    // Observed 2026-09-24: chatgpt.com connections failed with EPIPE mid-upload;
    // each one cooled Codex, the orchestrator tier's only provider, and failed
    // the root turn where a reconnect would have served it.
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (calls.length === 1)
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
        });
      return jsonResponse({
        id: "resp_reconnected",
        status: "completed",
        model: "sonnet",
        output: []
      });
    }) as typeof fetch;
    try {
      const response = responseRecorder();
      await proxyFallbackChain(
        response,
        {
          candidates: [
            { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
          ],
          role: "worker",
          subject: "worker turn"
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-reconnect",
        null,
        null
      );
      assert.deepEqual(calls, [
        "http://claude.test/v1/responses",
        "http://claude.test/v1/responses"
      ]);
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /resp_reconnected/);
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
  "last resort still attempts a transiently cooled provider that other agents are live on",
  { concurrency: false },
  async () => {
    // Observed 2026-09-24: Codex, the only orchestrator provider, was live in
    // other sessions, so the last-resort pass excluded it and every root turn
    // got an instant 503 for as long as the cooldown lasted (up to 596s):
    // nothing could make the attempt whose success clears it.
    COOLDOWNS.clearAll();
    agentActivity.reset();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "claude-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({
        id: `resp_${calls}`,
        status: "completed",
        model: "sonnet",
        output: [
          {
            type: "function_call",
            id: `fc_${calls}`,
            call_id: `call_${calls}`,
            name: "wait",
            arguments: "{}",
            status: "completed"
          }
        ]
      });
    }) as typeof fetch;
    const candidates = [
      { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" }
    ];
    try {
      // Another session's agent is parked in a tool call on the provider.
      await proxyFallbackChain(
        responseRecorder(),
        {
          candidates,
          role: "worker",
          subject: "worker turn",
          sessionKey: "other-root",
          session: { key: "other-root", scope: "identified", thread: "other" }
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-other",
        null,
        null
      );
      assert.equal(
        getDefaultUsageTracker().countLiveAgentActivity({ provider: "claude" }),
        1
      );
      COOLDOWNS.cooldownProvider("claude", {
        failureClass: "unavailable",
        now: Date.now()
      });
      COOLDOWNS.cooldownProvider("claude", {
        failureClass: "unavailable",
        now: Date.now()
      });
      assert.ok(
        (COOLDOWNS.get("claude")?.until ?? 0) - Date.now() > EXHAUSTION_WAIT_MS,
        "the cooldown outlasts the bounded wait, so only last resort can serve"
      );

      const response = responseRecorder();
      await proxyFallbackChain(
        response,
        {
          candidates,
          role: "worker",
          subject: "worker turn",
          sessionKey: "this-root",
          session: { key: "this-root", scope: "identified", thread: "this" }
        },
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-this",
        null,
        null
      );
      assert.equal(calls, 2);
      assert.equal(response.statusCode, 200);
      assert.equal(
        COOLDOWNS.isCooling("claude"),
        false,
        "the success clears the cooldown for every session"
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      agentActivity.reset();
      COOLDOWNS.clearAll();
    }
  }
);

test("a route that refused the request is named as such, not as a provider that did not finish", () => {
  // A refusal is not an outage: the route is healthy and cannot serve *this*
  // request. Saying it "did not complete the turn" sent the reader hunting
  // for a provider failure that was not there, and the providers with usage
  // left looked like the problem.
  const summary: CooldownSummary[] = [
    {
      provider: "claude",
      model: "sonnet",
      state: "available",
      failureClass: null,
      resetsAt: null,
      retryAfterMs: 0,
      detail: null
    },
    {
      provider: "antigravity-gemini",
      model: "gemini-3.8-flash-high",
      state: "available",
      failureClass: null,
      resetsAt: null,
      retryAfterMs: 0,
      detail: null
    }
  ];
  const body = exhaustionBody({
    subject: "the orchestrator",
    summary,
    failures: [
      "claude: cannot serve this request (the request names an image and carries none of its bytes)",
      "antigravity: cannot serve this request (image content)"
    ],
    observed: new Map([
      ["claude", "unsupported_request"],
      ["antigravity-gemini", "unsupported_request"]
    ]),
    model: "claude-opus-5-5",
    requestId: "req-refused",
    lastResortAttempts: 2,
    deadlineReached: false
  });
  const message = (body as any).error.message as string;
  assert.match(message, /claude: cannot serve this request/);
  assert.match(message, /antigravity-gemini: cannot serve this request/);
  assert.doesNotMatch(
    message,
    /did not complete the turn/,
    "a refusal must not read as a provider that failed to finish"
  );
  // No candidate can serve this request, and the same request will be
  // refused again: a retry buys nothing, so the body must not promise one.
  assert.equal((body as any).error.retryable, false);
  assert.match(message, /Retrying will not help/);
  assert.deepEqual(
    exhaustionHeaders({
      summary,
      observed: new Map([
        ["claude", "unsupported_request"],
        ["antigravity-gemini", "unsupported_request"]
      ]),
      requestId: "req-refused"
    }),
    { "x-autodev-request-id": "req-refused" },
    "a request no retry can serve must not carry a retry-after"
  );
});

test("a refusal names the providers that were never asked, and why", () => {
  // A provider that is switched off, or disabled for the role, never becomes
  // a candidate, and the refusal named only the providers that were tried:
  // an operator who had enabled one for the role could not see why it was
  // never asked.
  const summary: CooldownSummary[] = [
    {
      provider: "minimax",
      model: "MiniMax-M3",
      state: "transient",
      failureClass: "quota_exhausted",
      resetsAt: null,
      retryAfterMs: 30_000,
      detail: null
    }
  ];
  const body = exhaustionBody({
    subject: "role explorer",
    summary,
    failures: ["minimax: quota exhausted"],
    observed: new Map([["minimax", "quota_exhausted"]]),
    model: "autodev/explorer",
    requestId: "req-excluded",
    lastResortAttempts: 0,
    deadlineReached: false,
    excluded: [
      {
        provider: "opencli-chatgpt",
        reason: "its subagent role is disabled"
      }
    ]
  });
  const message = (body as any).error.message as string;
  assert.match(message, /minimax: quota_exhausted/u);
  assert.match(message, /opencli-chatgpt: its subagent role is disabled/u);
  assert.deepEqual((body as any).error.details.excluded, [
    {
      provider: "opencli-chatgpt",
      reason: "its subagent role is disabled"
    }
  ]);
});

test("a route that refused does not make a request another route could serve un-retryable", () => {
  // Codex was out of usage; the two routes that could have served the request
  // refused it. Codex will serve it once its window resets, so the request
  // stays retryable and the retry keeps its window.
  const summary: CooldownSummary[] = [
    {
      provider: "codex",
      model: "gpt-5-codex",
      state: "hard",
      failureClass: "quota_exhausted",
      resetsAt: new Date(Date.now() + 600_000).toISOString(),
      retryAfterMs: 600_000,
      detail: null
    },
    {
      provider: "claude",
      model: "sonnet",
      state: "available",
      failureClass: null,
      resetsAt: null,
      retryAfterMs: 0,
      detail: null
    }
  ];
  const observed = new Map([["claude", "unsupported_request"]]);
  const body = exhaustionBody({
    subject: "the orchestrator",
    summary,
    failures: ["codex: HTTP 429", "claude: cannot serve this request"],
    observed,
    model: "gpt-5-codex",
    requestId: "req-mixed",
    lastResortAttempts: 1,
    deadlineReached: false
  });
  const message = (body as any).error.message as string;
  assert.match(message, /codex: quota_exhausted/);
  assert.match(message, /claude: cannot serve this request/);
  assert.equal(
    (body as any).error.retryable,
    true,
    "a route that is merely out of usage will serve the request later"
  );
  assert.equal(
    exhaustionHeaders({ summary, observed, requestId: "req-mixed" })[
      "retry-after"
    ],
    "600"
  );
});

test(
  "sticky preferred provider waits out a short cooldown instead of switching providers mid-session",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    agentActivity.reset();
    const originalFetch = globalThis.fetch;
    const saved = {
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
    };
    process.env.LITELLM_API_KEY = "shared-key";
    process.env.MINIMAX_API_KEY = "minimax-key";

    const candidates = [
      { ...route("claude", "LITELLM_API_KEY"), model: "sonnet" },
      { ...route("minimax", "MINIMAX_API_KEY"), model: "MiniMax-M2.7" }
    ];

    const contactedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      contactedUrls.push(String(input));
      return jsonResponse({
        id: "resp_sticky_ok",
        status: "completed",
        output: []
      });
    }) as typeof fetch;

    try {
      // Place the sticky preferred provider ("claude") into a short 30ms cooldown.
      const now = Date.now();
      COOLDOWNS.cooldownProvider("claude", {
        now: now - (COOLDOWNS.config.providerCooldownMs - 30),
        failureClass: "throttled",
        structured: false
      });
      assert.equal(COOLDOWNS.isCooling("claude", now, "sonnet"), true);

      const response = responseRecorder();
      await proxyFallbackChain(
        response,
        {
          candidates,
          preferredProvider: "claude",
          role: "orchestrator",
          subject: "the orchestrator",
          sessionKey: "sticky-session-1",
          session: {
            key: "sticky-session-1",
            scope: "identified",
            thread: "sticky-session-1"
          }
        },
        { model: "autodev/orchestrator", input: [], stream: false },
        false,
        "req-sticky-wait",
        null,
        null
      );

      assert.equal(response.statusCode, 200);
      assert.equal(contactedUrls.length, 1);
      assert.match(
        contactedUrls[0]!,
        /^http:\/\/claude\.test\/v1\/responses$/,
        "must wait out the short cooldown and stay on the sticky provider (claude) rather than switching to minimax"
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      agentActivity.reset();
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "proxyRoleResponse records the subagent thread's provider and sticks to it across multi-turn requests",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    agentActivity.reset();
    resetSubagentTelemetry();
    const originalFetch = globalThis.fetch;
    const saved = {
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
    };
    process.env.LITELLM_API_KEY = "claude-key";
    process.env.MINIMAX_API_KEY = "minimax-key";

    const contactedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      contactedUrls.push(String(input));
      return jsonResponse({
        id: "resp_subagent_ok",
        status: "completed",
        output: []
      });
    }) as typeof fetch;

    try {
      const session = {
        key: "subagent-session-stickiness-1",
        scope: "identified" as const,
        thread: "subagent-session-stickiness-1"
      };

      // Turn 1
      await proxyRoleResponse(
        responseRecorder(),
        "worker",
        { model: "autodev/worker", input: [], stream: false },
        false,
        "req-sub-turn-1",
        null,
        null,
        null,
        session
      );
      const responseCalls1 = contactedUrls.filter((u) =>
        u.endsWith("/responses")
      );
      assert.equal(responseCalls1.length, 1);
      const firstUrl = responseCalls1[0];
      const firstProvider = subagentProviderForThread(
        "subagent-session-stickiness-1"
      );
      assert.ok(firstProvider, "Turn 1 must record the thread's provider");

      // Turn 2 in the same session without tool call ownership:
      // must stick to the provider chosen on turn 1
      contactedUrls.length = 0;
      await proxyRoleResponse(
        responseRecorder(),
        "worker",
        {
          model: "autodev/worker",
          input: [
            {
              type: "message",
              role: "user",
              content: "follow-up task"
            }
          ],
          stream: false
        },
        false,
        "req-sub-turn-2",
        null,
        null,
        null,
        session
      );
      const responseCalls2 = contactedUrls.filter((u) =>
        u.endsWith("/responses")
      );
      assert.equal(responseCalls2.length, 1);
      assert.equal(
        responseCalls2[0],
        firstUrl,
        "Turn 2 must reuse the same provider from Turn 1 rather than reshuffling"
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      agentActivity.reset();
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "context-window overflow (2013) on a stateless fallback route is treated as unsupported_request and rescued by last-resort on the sticky bridge without cooling down the refusing provider",
  { concurrency: false },
  async () => {
    // Regression for session 01a1bc3f-e5cf-7642-bfa0-34930eb04b1c:
    // Antigravity had a brief probe_unavailable / transient cooldown blip and
    // the router failed over to MiniMax, which returned HTTP 400
    // "invalid params, context window exceeds limit (2013)". Previously that
    // was treated as a terminal request_error and killed the orchestrator turn
    // without running last_resort or exhaustion_wait on Antigravity.
    COOLDOWNS.clearAll();
    agentActivity.reset();
    const originalFetch = globalThis.fetch;
    const saved = {
      LITELLM_API_KEY: process.env.LITELLM_API_KEY,
      MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
    };
    process.env.LITELLM_API_KEY = "shared-key";
    process.env.MINIMAX_API_KEY = "minimax-key";

    const candidates = [
      {
        ...route("antigravity-gemini", "LITELLM_API_KEY"),
        model: "gemini-3.8-flash-high"
      },
      { ...route("minimax", "MINIMAX_API_KEY"), model: "MiniMax-M3.1-Flash" }
    ];

    // Put Antigravity in a 120s transient cooldown (3 strikes = 120s,
    // exceeding sticky wait window of 60s so primary selection skips it
    // without sleeping and falls back to MiniMax).
    const now = Date.now();
    COOLDOWNS.cooldownProvider("antigravity-gemini", {
      failureClass: "unavailable",
      now
    });
    COOLDOWNS.cooldownProvider("antigravity-gemini", {
      failureClass: "unavailable",
      now
    });
    COOLDOWNS.cooldownProvider("antigravity-gemini", {
      failureClass: "unavailable",
      now
    });

    const responseCalls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      responseCalls.push(url);
      if (url === "http://minimax.test/v1/responses") {
        return Response.json(
          {
            error: {
              message: "invalid params, context window exceeds limit (2013)",
              type: "invalid_request_error",
              code: "invalid_request_error"
            }
          },
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return jsonResponse({
        id: "resp_rescued_by_last_resort",
        status: "completed",
        model: "gemini-3.8-flash-high",
        output: []
      });
    }) as typeof fetch;

    try {
      const response = responseRecorder();
      await proxyFallbackChain(
        response,
        {
          candidates,
          preferredProvider: "antigravity-gemini",
          role: "orchestrator",
          subject: "the orchestrator",
          sessionKey: "01a1bc3f-e5cf-7642-bfa0-34930eb04b1c",
          session: {
            key: "01a1bc3f-e5cf-7642-bfa0-34930eb04b1c",
            scope: "identified",
            thread: "01a1bc3f-e5cf-7642-bfa0-34930eb04b1c"
          }
        },
        { model: "autodev/orchestrator", input: [], stream: false },
        false,
        "req-2013-rescue",
        null,
        null
      );

      assert.deepEqual(responseCalls, [
        "http://minimax.test/v1/responses",
        "http://antigravity-gemini.test/v1/responses"
      ]);
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /resp_rescued_by_last_resort/);
      assert.equal(
        COOLDOWNS.isCooling("minimax"),
        false,
        "a context-window refusal on an oversized transcript must not cool down MiniMax for normal requests"
      );
      assert.equal(
        COOLDOWNS.isCooling("antigravity-gemini"),
        false,
        "the successful last-resort turn on Antigravity clears its transient cooldown"
      );
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      agentActivity.reset();
      COOLDOWNS.clearAll();
    }
  }
);

test(
  "stateful/web bridge responses floor downstream usage.input_tokens to the wire prompt estimate so Codex auto-compaction triggers before context overflow",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    agentActivity.reset();
    const originalFetch = globalThis.fetch;
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "shared-key";

    const largeTranscriptText = "x".repeat(50_000);
    globalThis.fetch = (async () =>
      jsonResponse({
        id: "resp_bridge_usage_floor",
        status: "completed",
        model: "gemini-3.8-flash-high",
        usage: {
          input_tokens: 0,
          output_tokens: 250,
          total_tokens: 250
        },
        output: []
      })) as typeof fetch;

    try {
      const response = responseRecorder();
      await proxyFallbackChain(
        response,
        {
          candidates: [
            {
              ...route("antigravity-gemini", "LITELLM_API_KEY"),
              model: "gemini-3.8-flash-high"
            }
          ],
          role: "orchestrator",
          subject: "the orchestrator"
        },
        {
          model: "autodev/orchestrator",
          instructions: "Orchestrator instructions",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: largeTranscriptText }]
            }
          ],
          stream: false
        },
        false,
        "req-usage-floor",
        null,
        null
      );

      assert.equal(response.statusCode, 200);
      const parsed = JSON.parse(response.body) as {
        usage: {
          input_tokens: number;
          output_tokens: number;
          total_tokens: number;
        };
      };
      assert.ok(
        parsed.usage.input_tokens >= 10_000,
        `expected usage.input_tokens to be floored to wire transcript estimate (>= 10000), got ${parsed.usage.input_tokens}`
      );
      assert.equal(parsed.usage.output_tokens, 250);
      assert.equal(
        parsed.usage.total_tokens,
        parsed.usage.input_tokens + parsed.usage.output_tokens
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      agentActivity.reset();
      COOLDOWNS.clearAll();
    }
  }
);

test("declaredLimit reads OpenAI/Codex usage limits and reset headers", () => {
  const now = Date.parse("2026-10-14T14:00:00.000Z");
  const codexQuota = declaredLimit(
    new Headers({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": "1792000000"
    }),
    JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "The usage limit has been reached"
      }
    }),
    now
  );
  assert.deepEqual(codexQuota, {
    limitClass: "quota_exhausted",
    limitType: "quota",
    resetsAt: new Date(1_792_000_000 * 1000).toISOString(),
    source: "reported"
  });

  const rateLimited = declaredLimit(
    new Headers({ "retry-after": "45" }),
    JSON.stringify({
      error: {
        code: "rate_limit_exceeded"
      }
    }),
    now
  );
  assert.deepEqual(rateLimited, {
    limitClass: "throttled",
    limitType: "rate",
    resetsAt: "2026-10-14T14:00:45.000Z",
    source: "reported"
  });
});

test("compaction requests fail closed on empty or tool-call-only responses and fail over cleanly", async () => {
  const previousKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "sk-compaction-test";
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return jsonResponse({
        id: "resp_bad_compaction",
        object: "response",
        status: "completed",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "read_file",
            arguments: "{}"
          }
        ]
      });
    }
    return jsonResponse({
      id: "resp_good_compaction",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "## Summary\nClean summary produced."
            }
          ]
        }
      ]
    });
  }) as typeof fetch;

  try {
    const response = responseRecorder();
    await proxyFallbackChain(
      response,
      {
        candidates: [
          { ...route("claude", "LITELLM_API_KEY"), model: "claude-opus-5-5" },
          {
            ...route("antigravity-claude-gpt", "LITELLM_API_KEY"),
            model: "claude-opus-5-5-high"
          }
        ],
        role: "orchestrator",
        subject: "the orchestrator"
      },
      {
        model: "autodev/orchestrator",
        instructions: "Compact history",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "You are performing a CONTEXT CHECKPOINT COMPACTION. Summarize conversation."
              }
            ]
          }
        ],
        stream: false
      },
      false,
      "req-compaction-failover",
      null,
      null
    );

    assert.equal(calls, 2);
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body) as { id?: string };
    assert.equal(body.id, "resp_good_compaction");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previousKey;
    agentActivity.reset();
    COOLDOWNS.clearAll();
  }
});

test("proxyOrchestratorResponse restores compact root bootstrap after compaction drops developer context", async () => {
  const previousKey = process.env.LITELLM_API_KEY;
  process.env.LITELLM_API_KEY = "sk-bootstrap-test";
  const originalFetch = globalThis.fetch;
  const forwardedPayloads: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url, init) => {
    if (!String(url).includes("/v1/responses")) {
      return jsonResponse({ status: "ok" });
    }
    forwardedPayloads.push(
      JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    );
    return jsonResponse({
      id: "resp_ok",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_ok",
          role: "assistant",
          content: [{ type: "output_text", text: "continuing" }]
        }
      ]
    });
  }) as typeof fetch;

  try {
    const compactedInput = [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<compacted-summary>\nPreviously investigated files.\n</compacted-summary>"
          }
        ]
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue the fix" }]
      }
    ];
    const response = responseRecorder();
    await proxyOrchestratorResponse(
      response,
      { model: "autodev/orchestrator", input: compactedInput, stream: false },
      false,
      "req-bootstrap-recover",
      null,
      null,
      null,
      { key: "root-recover", scope: "identified", thread: "root-recover" }
    );
    assert.equal(response.statusCode, 200);
    assert.equal(forwardedPayloads.length, 1);
    const firstItems = forwardedPayloads[0]?.input as Array<{
      role?: string;
      content?: Array<{ text?: string }>;
    }>;
    assert.equal(firstItems.length, 3);
    assert.equal(firstItems[1]?.role, "developer");
    const injectedText = firstItems[1]?.content?.[0]?.text ?? "";
    assert.match(injectedText, /# Root orchestrator bootstrap/);
    assert.match(injectedText, /Do NOT re-read `orchestration\/SKILL\.md`/);
    assert.match(injectedText, /re-probe `ALL_TOOLS`/);
    assert.ok(
      injectedText.length < 2500,
      `post-compaction bootstrap should stay compact, got ${injectedText.length} chars`
    );

    const responseAlreadyBootstrapped = responseRecorder();
    await proxyOrchestratorResponse(
      responseAlreadyBootstrapped,
      { model: "autodev/orchestrator", input: firstItems, stream: false },
      false,
      "req-bootstrap-already",
      null,
      null,
      null,
      { key: "root-recover", scope: "identified", thread: "root-recover" }
    );
    assert.equal(responseAlreadyBootstrapped.statusCode, 200);
    const secondItems = forwardedPayloads[1]?.input as unknown[];
    assert.equal(secondItems.length, firstItems.length);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previousKey;
    agentActivity.reset();
    COOLDOWNS.clearAll();
  }
});

test("empty role-scoped MCP candidate chain names missing role MCP injection providers rather than generic provider_disabled", async () => {
  const response = responseRecorder();
  try {
    await proxyFallbackChain(
      response,
      {
        candidates: [],
        role: "browser-tester",
        origin: "subagent",
        agentRole: "browser-tester",
        subject: "role browser-tester"
      },
      { model: "autodev/browser-tester", input: [], stream: false },
      false,
      "req-browser-tester-empty",
      null,
      null
    );
    assert.equal(response.statusCode, 400);
    const parsed = JSON.parse(response.body) as {
      error?: { message?: string };
    };
    assert.match(
      parsed.error?.message ?? "",
      /role-scoped MCP injection \(playwright\).*browser-tester/u
    );
    assert.match(parsed.error?.message ?? "", /antigravity|copilot/u);
  } finally {
    agentActivity.reset();
    COOLDOWNS.clearAll();
  }
});

test(
  "a concrete request whose 200 SSE stream fails with a limit cools the route and records the limit class",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "test-key";
    const originalFetch = globalThis.fetch;
    const resetsAt = new Date(Date.now() + 24 * 60_000).toISOString();
    const failedPayload = JSON.stringify({
      type: "response.failed",
      response: {
        id: "resp_sse_limit",
        status: "failed",
        error: {
          type: "quota_exhausted",
          message: "Individual quota reached. Resets in 24m.",
          limit: {
            class: "quota_exhausted",
            type: "quota",
            resets_at: resetsAt,
            source: "inferred"
          }
        }
      }
    });
    globalThis.fetch = (async () =>
      new Response(
        [
          "event: response.created\n" +
            'data: {"type":"response.created","response":{"id":"resp_sse_limit","status":"in_progress"}}\n\n',
          "event: response.failed\n" + "data: " + failedPayload + "\n\n",
          "data: [DONE]\n\n"
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )) as typeof fetch;
    try {
      const response = responseRecorder();
      await proxyConcreteResponse(
        response,
        route("antigravity-argon", "LITELLM_API_KEY"),
        { model: "gemini-3-argon-high", input: [], stream: true },
        true,
        "req-concrete-sse-limit",
        null,
        null,
        null,
        { key: "session-sse-limit", scope: "identified" }
      );
      const entry = COOLDOWNS.get("antigravity-argon");
      assert.ok(
        entry,
        "in-stream limit failure must cool down the concrete route"
      );
      assert.equal(entry.kind, "hard");
      assert.equal(entry.failureClass, "quota_exhausted");
      assert.equal(entry.resetsAt, resetsAt);
      const events = getRecentRouterEvents().filter(
        (event) => event.requestId === "req-concrete-sse-limit"
      );
      const resultEvent = events.find((event) => event.phase === "result");
      assert.equal(resultEvent?.outcome, "failure");
      assert.equal(resultEvent?.failureClass, "quota_exhausted");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      agentActivity.reset();
      COOLDOWNS.clearAll();
    }
  }
);

test("proxyOrchestratorResponse re-probes Priority 1 immediately after compaction and re-pins the serving provider", async () => {
  COOLDOWNS.clearAll();
  agentActivity.reset();
  resetSubagentTelemetry();
  const previousKeys = {
    LITELLM_API_KEY: process.env.LITELLM_API_KEY,
    MINIMAX_API_KEY: process.env.MINIMAX_API_KEY
  };
  process.env.LITELLM_API_KEY = "sk-compaction-p1-claude";
  process.env.MINIMAX_API_KEY = "sk-compaction-p2-minimax";

  // The tier under test is exactly Priority-1 claude and Priority-2 minimax.
  // The configured orchestrator groups also rank antigravity-claude-gpt
  // second, and providers sharing a rank are shuffled, so leaving it enabled
  // made the Priority-2 fallback below a coin flip.
  const savedAssignments = new Map(
    ["codex", "claude", "antigravity-claude-gpt", "minimax"].map((provider) => [
      provider,
      ROUTING_POLICY.assignmentFor(provider, "orchestrator")
    ])
  );
  for (const provider of ["codex", "antigravity-claude-gpt"])
    ROUTING_POLICY.setProviderAssignment(provider, "orchestrator", {
      priority: "disabled",
      model: null
    });
  ROUTING_POLICY.setProviderAssignment("claude", "orchestrator", {
    priority: 1,
    model: "claude-opus-5-5"
  });
  ROUTING_POLICY.setProviderAssignment("minimax", "orchestrator", {
    priority: 2,
    model: "MiniMax-M3.1-Flash"
  });

  const requestedUrls: string[] = [];
  let claudeHealthy = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes(":4000/health")) {
      return claudeHealthy
        ? jsonResponse({ status: "ok" })
        : new Response("down", { status: 503 });
    }
    if (url.includes(":18765/health")) {
      return jsonResponse({ status: "ok" });
    }
    return jsonResponse({
      id: "resp_reprobe",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_reprobe",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }]
        }
      ]
    });
  }) as typeof fetch;

  const session = {
    key: "sess-compaction-reprobe",
    scope: "identified" as const,
    thread: "sess-compaction-reprobe"
  };

  try {
    // 1. Mid-window turn while pinned to fallback (minimax) stays on minimax.
    noteOrchestratorSession(session.key, "minimax", {
      model: "MiniMax-M3.1-Flash"
    });
    const normalTurn = responseRecorder();
    await proxyOrchestratorResponse(
      normalTurn,
      {
        model: "autodev/orchestrator",
        input: [{ type: "message", role: "user", content: "next step" }],
        stream: false
      },
      false,
      "req-reprobe-1",
      null,
      null,
      null,
      session
    );
    assert.equal(normalTurn.statusCode, 200);
    assert.equal(orchestratorProviderForSession(session.key), "minimax");
    assert.ok(
      requestedUrls.some((url) => url.includes(":18765/v1/responses")),
      "mid-window turn must stay cache-pinned on fallback minimax"
    );

    // 2. First turn immediately after compaction re-probes P1 (claude) and switches.
    requestedUrls.length = 0;
    const compactedFreshInput = [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Another language model started to solve this problem\nSummary"
          }
        ]
      }
    ];
    const postCompactTurn = responseRecorder();
    await proxyOrchestratorResponse(
      postCompactTurn,
      {
        model: "autodev/orchestrator",
        input: compactedFreshInput,
        stream: false
      },
      false,
      "req-reprobe-2",
      null,
      null,
      null,
      session
    );
    assert.equal(postCompactTurn.statusCode, 200);
    assert.equal(orchestratorProviderForSession(session.key), "claude");
    assert.ok(
      requestedUrls.some((url) => url.includes(":4000/v1/responses")),
      "fresh post-compaction turn must re-probe and recover to Priority-1 claude"
    );

    // 3. Subsequent turn in the same compacted window has assistant history -> stays pinned on claude
    // even if minimax were remembered (here claude is remembered and checked).
    noteOrchestratorSession(session.key, "minimax", {
      model: "MiniMax-M3.1-Flash"
    });
    requestedUrls.length = 0;
    const midWindowTurn = responseRecorder();
    await proxyOrchestratorResponse(
      midWindowTurn,
      {
        model: "autodev/orchestrator",
        input: [
          ...compactedFreshInput,
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "step 1 done" }]
          },
          { type: "message", role: "user", content: "step 2" }
        ],
        stream: false
      },
      false,
      "req-reprobe-3",
      null,
      null,
      null,
      session
    );
    assert.equal(midWindowTurn.statusCode, 200);
    assert.ok(
      requestedUrls.some((url) => url.includes(":18765/v1/responses")),
      "turn with assistant history after compaction must keep session cache pinning"
    );

    // 4. If P1 is down at compaction boundary, fall back cleanly to P2 and keep P2 pinned.
    claudeHealthy = false;
    noteOrchestratorSession(session.key, "minimax", {
      model: "MiniMax-M3.1-Flash"
    });
    requestedUrls.length = 0;
    const postCompactDownTurn = responseRecorder();
    await proxyOrchestratorResponse(
      postCompactDownTurn,
      {
        model: "autodev/orchestrator",
        input: compactedFreshInput,
        stream: false
      },
      false,
      "req-reprobe-4",
      null,
      null,
      null,
      session
    );
    assert.equal(postCompactDownTurn.statusCode, 200);
    assert.equal(orchestratorProviderForSession(session.key), "minimax");
    assert.ok(
      requestedUrls.some((url) => url.includes(":4000/health")),
      "fresh post-compaction turn probes P1 first before falling back to P2"
    );
    assert.ok(
      requestedUrls.some((url) => url.includes(":18765/v1/responses")),
      "unavailable P1 falls back to P2 minimax"
    );

    // 5. Pending TOOL_CALL_OWNERSHIP still beats compaction re-probing.
    claudeHealthy = true;
    TOOL_CALL_OWNERSHIP.record(["call_compact_owned"], "minimax");
    requestedUrls.length = 0;
    const ownedTurn = responseRecorder();
    await proxyOrchestratorResponse(
      ownedTurn,
      {
        model: "autodev/orchestrator",
        input: [
          ...compactedFreshInput,
          {
            type: "function_call_output",
            call_id: "call_compact_owned",
            output: "ok"
          }
        ],
        stream: false
      },
      false,
      "req-reprobe-5",
      null,
      null,
      null,
      session
    );
    assert.equal(ownedTurn.statusCode, 200);
    assert.ok(
      requestedUrls.some((url) => url.includes(":18765/v1/responses")),
      "owned tool call output must stay with the tool call issuer"
    );
  } finally {
    TOOL_CALL_OWNERSHIP.clear();
    globalThis.fetch = originalFetch;
    for (const [provider, previous] of savedAssignments) {
      if (previous) {
        ROUTING_POLICY.setProviderAssignment(
          provider,
          "orchestrator",
          previous
        );
      } else {
        ROUTING_POLICY.clearProviderAssignment(provider, "orchestrator");
      }
    }
    if (previousKeys.LITELLM_API_KEY === undefined)
      delete process.env.LITELLM_API_KEY;
    else process.env.LITELLM_API_KEY = previousKeys.LITELLM_API_KEY;
    if (previousKeys.MINIMAX_API_KEY === undefined)
      delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = previousKeys.MINIMAX_API_KEY;
    agentActivity.reset();
    COOLDOWNS.clearAll();
  }
});
