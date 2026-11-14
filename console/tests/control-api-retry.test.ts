import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchControlApi,
  fetchControlApiBinary,
  postControlApi
} from "../src/lib/server/control-api.ts";

const CONFIG = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "control-api-retry-test-token"
};

function transportError(code: string): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = { code };
  return error;
}

/** A fetch that fails with each scripted error, then answers with the response. */
function scripted(
  failures: readonly Error[],
  response: () => Response = () => Response.json({ ok: true })
): { readonly fetchImpl: typeof fetch; readonly times: number[] } {
  const times: number[] = [];
  const fetchImpl = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    times.push(Date.now());
    const failure = failures[times.length - 1];
    return failure ? Promise.reject(failure) : Promise.resolve(response());
  }) as typeof fetch;
  return { fetchImpl, times };
}

test("a read retries a transport failure and then succeeds", async () => {
  const { fetchImpl, times } = scripted([transportError("ECONNRESET")]);
  const result = await fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    retryDelayMs: 1
  });
  assert.equal(result.kind, "ok");
  assert.equal(times.length, 2);
});

test("maxRetries counts retries after the first attempt", async () => {
  const failures = Array.from({ length: 10 }, () =>
    transportError("ECONNREFUSED")
  );
  const { fetchImpl, times } = scripted(failures);
  const result = await fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    maxRetries: 3,
    retryDelayMs: 1
  });
  assert.equal(times.length, 4);
  assert.deepEqual(result, {
    kind: "unreachable",
    message:
      "Nothing is listening at the configured AutoDev Control API address."
  });
});

test("the default is two retries, three attempts in total", async () => {
  const failures = Array.from({ length: 10 }, () =>
    transportError("ETIMEDOUT")
  );
  const { fetchImpl, times } = scripted(failures);
  await fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    retryDelayMs: 1
  });
  assert.equal(times.length, 3);
});

test("retry delay grows linearly with the retry number", async () => {
  const failures = Array.from({ length: 3 }, () =>
    transportError("ECONNRESET")
  );
  const { fetchImpl, times } = scripted(failures);
  await fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    maxRetries: 3,
    retryDelayMs: 40
  });
  assert.equal(times.length, 4);
  const [first, second, third] = [
    times[1]! - times[0]!,
    times[2]! - times[1]!,
    times[3]! - times[2]!
  ];
  assert.ok(first >= 35 && first < 75, "first delay ~40ms: " + first);
  assert.ok(second >= 75 && second < 115, "second delay ~80ms: " + second);
  assert.ok(third >= 115 && third < 160, "third delay ~120ms: " + third);
});

test("a failure that is not a retryable transport code is not retried", async () => {
  const { fetchImpl, times } = scripted([transportError("ENOTFOUND")]);
  const result = await fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    retryDelayMs: 1
  });
  assert.equal(times.length, 1);
  assert.equal(result.kind, "unreachable");
});

test("a service error answer is a result, never a retry", async () => {
  const { fetchImpl, times } = scripted([], () =>
    Response.json({ error: { code: "boom", message: "no" } }, { status: 503 })
  );
  const result = await fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    retryDelayMs: 1
  });
  assert.equal(times.length, 1);
  assert.equal(result.kind, "http-error");
});

test("a mutation is never retried", async () => {
  const { fetchImpl, times } = scripted([transportError("ECONNRESET")]);
  const result = await postControlApi("/control/agents/x", {}, CONFIG, {
    fetchImpl,
    maxRetries: 5,
    retryDelayMs: 1
  });
  assert.equal(times.length, 1);
  assert.equal(result.kind, "unreachable");
});

test("the deadline covers the whole retry sequence", async () => {
  const failures = Array.from({ length: 50 }, () =>
    transportError("ECONNRESET")
  );
  const { fetchImpl, times } = scripted(failures);
  const started = Date.now();
  const result = await fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    maxRetries: 50,
    retryDelayMs: 50,
    timeoutMs: 120
  });
  assert.ok(Date.now() - started < 400, "ended near the deadline");
  assert.ok(times.length < 50, "stopped retrying at the deadline");
  assert.equal(result.kind, "unreachable");
  assert.equal(
    result.kind === "unreachable" ? result.timedOut : undefined,
    true
  );
});

test("a caller abort during the retry delay stops further attempts", async () => {
  const failures = Array.from({ length: 5 }, () =>
    transportError("ECONNRESET")
  );
  const { fetchImpl, times } = scripted(failures);
  const caller = new AbortController();
  const read = fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    retryDelayMs: 200,
    signal: caller.signal,
    timeoutMs: 60_000
  });
  setTimeout(() => caller.abort(), 20);
  const result = await read;
  assert.equal(times.length, 1);
  assert.equal(result.kind, "unreachable");
  assert.equal(
    result.kind === "unreachable" ? result.timedOut === true : undefined,
    false
  );
});

test("an already-aborted caller signal is not reported as the deadline", async () => {
  const { fetchImpl } = scripted([]);
  const caller = new AbortController();
  caller.abort();
  const result = await fetchControlApi<unknown>("/control/agents", CONFIG, {
    fetchImpl,
    signal: caller.signal
  });
  assert.equal(result.kind, "unreachable");
  assert.equal(
    result.kind === "unreachable" ? result.timedOut === true : undefined,
    false
  );
});

test("the binary read shares the retry count and keeps its type validation", async () => {
  const path = "/control/playtesting/episodes/e1/media/f1?workspaceId=a%2Fb";
  const png = (): Response =>
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" }
    });
  const retried = scripted([transportError("ECONNRESET")], png);
  const ok = await fetchControlApiBinary(path, CONFIG, {
    fetchImpl: retried.fetchImpl,
    retryDelayMs: 1
  });
  assert.equal(ok.kind, "ok");
  assert.equal(retried.times.length, 2);

  const wrongType = scripted(
    [],
    () =>
      new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
  );
  const refused = await fetchControlApiBinary(path, CONFIG, {
    fetchImpl: wrongType.fetchImpl
  });
  assert.equal(refused.kind, "invalid-response");
  assert.equal(wrongType.times.length, 1);
});
