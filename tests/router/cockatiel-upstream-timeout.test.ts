import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import test from "node:test";

process.env.CODEX_ROUTER_UPSTREAM_TIMEOUT_MS = "35";

await import("@simulatorlife/autodev-runtime/router/http");

const { COOLDOWNS } =
  await import("@simulatorlife/autodev-runtime/router/cooldown");
const { proxyConcreteResponse } =
  await import("@simulatorlife/autodev-runtime/router/proxy");

type RecordedResponse = ServerResponse & {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
  headersSent: boolean;
  writableEnded: boolean;
};

function responseRecorder(): RecordedResponse {
  const chunks: Buffer[] = [];
  const res: RecordedResponse = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: "",
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    writeHead(status: number, headers: Record<string, string | number>) {
      res.statusCode = status;
      res.headers = headers;
      res.headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      res.body = Buffer.concat(chunks).toString("utf8");
      res.writableEnded = true;
    },
    on() {
      return res;
    },
    removeListener() {
      return res;
    }
  } as unknown as RecordedResponse;
  return res;
}

test(
  "Cockatiel's upstream deadline covers streamed body consumption",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    const previousKey = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "timeout-test-key";
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (_input, init) => {
      calls += 1;
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.created","response":{"id":"timeout-stream"}}\n\n'
              )
            );
            signal?.addEventListener(
              "abort",
              () => controller.error(signal.reason),
              { once: true }
            );
          }
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" }
        }
      );
    }) as typeof fetch;

    try {
      const response = responseRecorder();
      const startedAt = Date.now();
      await proxyConcreteResponse(
        response,
        {
          provider: "claude",
          pattern: /.*/,
          baseUrl: "http://claude.test/v1",
          envKey: "LITELLM_API_KEY"
        },
        { model: "sonnet", input: [], stream: true },
        true,
        "req-stream-timeout",
        null,
        null,
        null,
        { key: "session-stream-timeout", scope: "identified" }
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(calls, 1, "a stream failure is not retried in place");
      assert.ok(elapsedMs >= 25, `deadline stayed active: ${elapsedMs}ms`);
      assert.ok(elapsedMs < 1000, `deadline ended the stream: ${elapsedMs}ms`);
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /"reason":"provider_timeout"/);
      assert.equal(response.writableEnded, true);
    } finally {
      globalThis.fetch = originalFetch;
      if (previousKey === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previousKey;
      COOLDOWNS.clearAll();
    }
  }
);
