import "@simulatorlife/autodev-runtime/router/http";

import assert from "node:assert/strict";
import test from "node:test";

import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import { proxyFallbackChain } from "@simulatorlife/autodev-runtime/router/proxy";
import type { ProviderRoute } from "@simulatorlife/autodev-runtime/router/routing";
import { agentActivity } from "@simulatorlife/autodev-runtime/router/server";

/**
 * A streamed candidate that fails before it has sent any output has told the
 * client nothing, so the chain asks the next candidate on the same stream.
 *
 * The bridges open their stream at once and report every failure inside it
 * (a turn can outlast the router's wait for response headers), so before this
 * no failure of theirs could fall back: the failure was forwarded, the
 * client retried, and a provider that had refused the request -- which sets
 * no cooldown -- was handed every retry again.
 */

type JsonRecord = Record<string, unknown>;

function responseRecorder(): any {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    writeHeads: 0,
    get body(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
    writeHead(status: number, headers: Record<string, string | number>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
      this.writeHeads += 1;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

const candidate = (provider: string) => ({
  provider,
  pattern: /.*/,
  baseUrl: `http://${provider}.test/v1`,
  envKey: "STREAM_FALLBACK_TEST_KEY",
  model: `${provider}-model`
});

function sse(events: readonly JsonRecord[]): Response {
  return new Response(
    events
      .map(
        (event) =>
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

const created = (id: string): JsonRecord => ({
  type: "response.created",
  response: { id, object: "response", status: "in_progress", output: [] }
});

const inProgress = (id: string): JsonRecord => ({
  type: "response.in_progress",
  response: { id, object: "response", status: "in_progress", output: [] }
});

const failed = (id: string, error: JsonRecord): JsonRecord => ({
  type: "response.failed",
  response: { id, object: "response", status: "failed", output: [], error }
});

const REFUSAL = {
  type: "provider_request_unsupported",
  code: "SITE_BUSY",
  message: "the site's tab was busy for the whole of the turn"
};

function answer(id: string, text: string): JsonRecord[] {
  const item = {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }]
  };
  return [
    created(id),
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] }
    },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      }
    }
  ];
}

/** The event types the client was sent, in order. */
function eventTypes(body: string): string[] {
  return Array.from(body.matchAll(/^event: (.+)$/gmu), (match) => match[1]!);
}

async function withUpstreams(
  streams: Record<string, () => Response>,
  body: (
    run: (candidates: ProviderRoute[]) => Promise<any>,
    asked: string[]
  ) => Promise<void>
): Promise<void> {
  COOLDOWNS.clearAll();
  agentActivity.reset();
  const previousKey = process.env.STREAM_FALLBACK_TEST_KEY;
  process.env.STREAM_FALLBACK_TEST_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const provider = new URL(String(input)).hostname.replace(/\.test$/u, "");
    asked.push(provider);
    const stream = streams[provider];
    assert.ok(stream, `unexpected upstream ${provider}`);
    return stream();
  }) as typeof fetch;
  let request = 0;
  try {
    await body(async (candidates) => {
      const response = responseRecorder();
      request += 1;
      await proxyFallbackChain(
        response,
        { candidates: candidates as any, role: "worker", subject: "worker" },
        { model: "autodev/worker", input: [], stream: true },
        true,
        `req-stream-fallback-${request}`,
        null,
        null
      );
      return response;
    }, asked);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.STREAM_FALLBACK_TEST_KEY;
    else process.env.STREAM_FALLBACK_TEST_KEY = previousKey;
    agentActivity.reset();
    COOLDOWNS.clearAll();
  }
}

test("a streamed refusal before any output is answered by the next candidate on the same stream", async () => {
  await withUpstreams(
    {
      alpha: () =>
        sse([
          created("resp_alpha"),
          inProgress("resp_alpha"),
          failed("resp_alpha", REFUSAL)
        ]),
      beta: () => sse(answer("resp_beta", "answered by beta"))
    },
    async (run, asked) => {
      const response = await run([candidate("alpha"), candidate("beta")]);
      assert.deepEqual(asked, ["alpha", "beta"]);
      assert.equal(response.writeHeads, 1, "one stream, opened once");
      assert.equal(response.writableEnded, true);
      const types = eventTypes(response.body);
      // The client never hears of the candidate that could not serve it: it
      // sees a response that was in progress, and then the answer.
      assert.ok(!types.includes("response.failed"));
      assert.doesNotMatch(response.body, /tab was busy/u);
      assert.match(response.body, /answered by beta/u);
      assert.equal(types.at(-1), "response.completed");
      // A refusal is not an outage: the provider that refused stays in
      // rotation for the requests it can serve.
      assert.equal(COOLDOWNS.isCooling("alpha"), false);
    }
  );
});

test("a streamed limit before any output cools the provider down and falls back", async () => {
  const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await withUpstreams(
    {
      alpha: () =>
        sse([
          created("resp_alpha"),
          failed("resp_alpha", {
            type: "opencli_proxy_error",
            code: "UPLOADS_EXHAUSTED",
            message: "chatgpt upload rate limit reached",
            limit: {
              class: "throttled",
              type: "rate",
              resets_at: resetsAt,
              source: "inferred"
            }
          })
        ]),
      beta: () => sse(answer("resp_beta", "answered by beta"))
    },
    async (run, asked) => {
      const response = await run([candidate("alpha"), candidate("beta")]);
      assert.deepEqual(asked, ["alpha", "beta"]);
      assert.match(response.body, /answered by beta/u);
      assert.ok(!eventTypes(response.body).includes("response.failed"));
      const cooldown = COOLDOWNS.get("alpha");
      assert.equal(cooldown?.failureClass, "throttled");
      assert.equal(cooldown?.resetsAt, resetsAt);
      assert.equal(COOLDOWNS.isCooling("beta"), false);
    }
  );
});

test("a stream that breaks off before any output falls back too", async () => {
  await withUpstreams(
    {
      alpha: () => sse([created("resp_alpha"), inProgress("resp_alpha")]),
      beta: () => sse(answer("resp_beta", "answered by beta"))
    },
    async (run, asked) => {
      const response = await run([candidate("alpha"), candidate("beta")]);
      assert.deepEqual(asked, ["alpha", "beta"]);
      assert.match(response.body, /answered by beta/u);
      assert.equal(eventTypes(response.body).at(-1), "response.completed");
      assert.equal(COOLDOWNS.isCooling("alpha"), true);
    }
  );
});

test("a failure after output has started ends the turn where it is", async () => {
  await withUpstreams(
    {
      alpha: () =>
        sse([
          ...answer("resp_alpha", "half an answer").slice(0, 3),
          failed("resp_alpha", {
            type: "upstream_error",
            message: "the provider stopped"
          })
        ]),
      beta: () => sse(answer("resp_beta", "answered by beta"))
    },
    async (run, asked) => {
      const response = await run([candidate("alpha"), candidate("beta")]);
      // The client has part of an answer: a second provider's answer on the
      // same stream would be spliced onto it.
      assert.deepEqual(asked, ["alpha"]);
      assert.match(response.body, /half an answer/u);
      assert.equal(eventTypes(response.body).at(-1), "response.failed");
      assert.equal(response.writableEnded, true);
    }
  );
});

test("a chain that runs out with the stream open ends it with the account of the chain", async () => {
  const refuse = (id: string) => () => sse([created(id), failed(id, REFUSAL)]);
  await withUpstreams(
    { alpha: refuse("resp_alpha"), beta: refuse("resp_beta") },
    async (run, asked) => {
      const response = await run([candidate("alpha"), candidate("beta")]);
      assert.deepEqual(asked, ["alpha", "beta"]);
      assert.equal(response.writableEnded, true);
      const failures = eventTypes(response.body).filter(
        (type) => type === "response.failed"
      );
      assert.equal(failures.length, 1, "one failure, the chain's own");
      assert.match(response.body, /No candidate can serve worker/u);
      assert.match(response.body, /alpha: cannot serve this request/u);
      assert.match(response.body, /beta: cannot serve this request/u);
    }
  );
});
