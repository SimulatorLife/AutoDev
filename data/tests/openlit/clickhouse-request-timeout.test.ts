import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CLICKHOUSE_REQUEST_TIMEOUT_MS,
  insertRows,
  removeStaleRows,
  selectRows
} from "../../src/clickhouse/clickhouse-client.ts";

const ENDPOINT = "http://127.0.0.1:8123/?user=default&password=secret";

interface RecordedRequest {
  readonly signal: AbortSignal | null | undefined;
}

/** A fetch that answers at once, so only the recorded ceiling is under test. */
function answeringFetch(): typeof globalThis.fetch {
  return (async () => Response.json({ data: [] })) as typeof globalThis.fetch;
}

/**
 * Replace `fetch` with a request that never answers, so the only way the call
 * can end is the ceiling the client put on it.
 */
function hangingFetch(): typeof globalThis.fetch {
  return (async (
    _url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => {
        reject(signal.reason ?? new Error("aborted"));
      });
    })) as typeof globalThis.fetch;
}

async function withFetch(
  fetchImpl: typeof globalThis.fetch,
  body: (requests: RecordedRequest[]) => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    requests.push({ signal: init?.signal ?? null });
    return fetchImpl(url, init);
  }) as typeof globalThis.fetch;
  try {
    await body(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("a ClickHouse request that never answers is abandoned instead of hanging", async () => {
  await withFetch(hangingFetch(), async (requests) => {
    const started = Date.now();
    await assert.rejects(
      selectRows(ENDPOINT, "openlit_prompts", ["id"], { timeoutMs: 50 }),
      /timeout|abort/iu
    );
    assert.ok(
      Date.now() - started < 5000,
      "the ceiling must end the request instead of waiting on the server"
    );
    assert.equal(requests.length, 1);
    assert.ok(requests[0]?.signal, "the request must carry an abort ceiling");
  });
});

test("every ClickHouse wire helper puts a ceiling on its request", async () => {
  await withFetch(hangingFetch(), async (requests) => {
    await assert.rejects(
      insertRows(ENDPOINT, "openlit_prompts", [{ id: "1" }], { timeoutMs: 50 }),
      /timeout|abort/iu
    );
    assert.equal(requests.length, 1);
    assert.ok(
      requests[0]?.signal,
      "no ClickHouse request may be sent without a ceiling"
    );
  });
});

test("the stale-row deletions both carry a ceiling", async () => {
  await withFetch(answeringFetch(), async (requests) => {
    await removeStaleRows(
      ENDPOINT,
      [{ id: "1" }],
      {
        versionsTable: "openlit_prompt_versions",
        versionsKeyColumn: "prompt_id",
        summaryTable: "openlit_prompts",
        summaryKeyColumn: "id",
        keyOf: (row) => row.id,
        labelOf: (row) => row.id
      },
      { timeoutMs: 50 }
    );

    assert.equal(
      requests.length,
      2,
      "the versions table and the summary table are deleted separately"
    );
    for (const request of requests) {
      assert.ok(
        request.signal,
        "no ClickHouse request may be sent without a ceiling"
      );
    }
  });
});

test("a ClickHouse request carries the default ceiling when no timeout is named", async () => {
  await withFetch(answeringFetch(), async (requests) => {
    await selectRows(ENDPOINT, "openlit_prompts", ["id"]);
    assert.equal(requests.length, 1);
    assert.ok(
      requests[0]?.signal,
      "the default ceiling must still bound the request"
    );
    assert.ok(
      DEFAULT_CLICKHOUSE_REQUEST_TIMEOUT_MS > 0,
      "the default ceiling must be a positive number of milliseconds"
    );
  });
});
