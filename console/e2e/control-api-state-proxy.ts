/**
 * A Control API stand-in that can be put into the states a real service can be
 * in, so the Console's own failure states can be measured in a browser.
 *
 * The Console's pages read the Control API on the server and promise the
 * operator an explicit state when a read cannot be answered: unavailable,
 * unauthorized, or an error. A unit test can prove the mapping from a failed
 * read to a rendered state; it cannot prove that the page an operator opens
 * shows that state rather than an empty table, a zero count, or the last
 * data it managed to load. This proxy is what makes the difference
 * measurable: it sits between the Console and the Control API fixture and
 * answers the way a service answers when it is down, when it refuses, or
 * when it fails.
 *
 * It is deliberately not the fixture. The fixture answers a healthy service
 * with deterministic data, and the fixture's own contract is that its
 * responses are synthetic and complete. This one only ever *degrades* the
 * answer it forwards, and it always answers the control route honestly, so a
 * spec that flips the state and puts it back is leaving no trace.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";

const PORT = Number(process.env.AUTODEV_STATE_PROXY_PORT ?? 4370);
const UPSTREAM =
  process.env.AUTODEV_STATE_PROXY_UPSTREAM ?? "http://127.0.0.1:4368";

/** The states a service can be in when the Console asks it a question. */
const STATES = [
  "normal",
  "slow",
  "unavailable",
  "unauthorized",
  "error"
] as const;

type ProxyState = (typeof STATES)[number];

const DELAY_MS = Number(process.env.AUTODEV_STATE_PROXY_DELAY_MS ?? 3000);

/**
 * How long the proxy waits for the service it stands in front of.
 *
 * A service that accepts a request and then never answers is a state the
 * Console has to answer for, but the proxy used to wait on it forever: the
 * Console's read then waited on the proxy, and the page an operator opens
 * waited with it. The proxy's own deadline is longer than the Console's
 * five-second one on purpose -- the Console's deadline is the one that
 * should normally fire, and this is the backstop for a read that outlives it.
 */
const UPSTREAM_TIMEOUT_MS = Number(
  process.env.AUTODEV_STATE_PROXY_UPSTREAM_TIMEOUT_MS ?? 10_000
);

let state: ProxyState = "normal";

function isProxyState(value: unknown): value is ProxyState {
  return (
    typeof value === "string" && (STATES as readonly string[]).includes(value)
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": encoded.length
  });
  response.end(encoded);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One header value.
 *
 * A header that arrived more than once arrives as an array, and an array is
 * not a header value: the first one is the one the caller meant.
 */
function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

/**
 * The answer a degraded service gives, in the Control API's own error
 * envelope, so the Console reads the code the envelope carries.
 */
function degradedAnswer(degraded: ProxyState): {
  readonly status: number;
  readonly body: unknown;
} {
  if (degraded === "unauthorized")
    return {
      status: 401,
      body: {
        error: {
          message: "The Control API refused this reader's credential.",
          type: "autodev_control_api_error",
          code: "autodev_control_api_unauthorized"
        }
      }
    };
  return {
    status: 503,
    body: {
      error: {
        message: "The Control API is not available right now.",
        type: "autodev_control_api_error",
        code: "autodev_control_api_unavailable"
      }
    }
  };
}

const server = createServer(
  async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__state") {
      if (request.method === "GET") {
        sendJson(response, 200, { state });
        return;
      }
      if (request.method === "POST") {
        const raw = await readBody(request);
        let requested: unknown;
        try {
          requested = (JSON.parse(raw) as { readonly state?: unknown }).state;
        } catch {
          sendJson(response, 400, { error: "the state must be sent as JSON" });
          return;
        }
        if (!isProxyState(requested)) {
          sendJson(response, 400, { error: `unknown state`, states: STATES });
          return;
        }
        state = requested;
        sendJson(response, 200, { state });
        return;
      }
      response.writeHead(405).end();
      return;
    }
    if (state === "unavailable") {
      // A service that is down does not answer at all: the connection is
      // closed without a response, which is what the Console sees when the
      // Control API is not listening.
      request.socket.destroy();
      return;
    }
    if (state === "slow") {
      // A service that is up but slow: the answer is the healthy one, it just
      // arrives late, which is the state a page has to show something for
      // while it waits.
      await new Promise((resolve) => {
        setTimeout(resolve, DELAY_MS);
      });
    }
    if (state !== "normal" && state !== "slow") {
      const answer = degradedAnswer(state);
      sendJson(response, answer.status, answer.body);
      return;
    }
    const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: request.method ?? "GET",
      headers: {
        authorization: headerValue(request.headers.authorization),
        "x-autodev-actor": headerValue(request.headers["x-autodev-actor"]),
        "content-type":
          headerValue(request.headers["content-type"]) || "application/json",
        // One connection per forwarded request. A pooled connection can be one
        // the service has already closed, and a request written into a closed
        // connection is never answered -- the caller waits for an answer that
        // cannot arrive. The traffic here is a test fixture's, so the
        // connection cost is not worth a hang.
        connection: "close"
      },
      body:
        request.method === "GET" || request.method === "HEAD"
          ? null
          : await readBody(request),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    }).catch(() => null);
    if (upstream === null) {
      // The service this proxy stands in front of is not there, or it did not
      // answer in time. That is a state the Console has to answer for, not a
      // reason for the proxy to fall over: a harness that dies with its
      // upstream cannot measure the degraded states it exists to measure.
      const answer = degradedAnswer("unavailable");
      sendJson(response, answer.status, answer.body);
      return;
    }
    const payload = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
      "content-length": payload.length
    });
    response.end(payload);
  }
);

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`control api state proxy on ${String(PORT)}\n`);
});
