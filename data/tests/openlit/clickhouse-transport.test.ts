import assert from "node:assert/strict";
import test from "node:test";

import { syncRulesyncModels } from "@simulatorlife/autodev-data/openlit";

const connection = {
  clickhouseUrl: "http://clickhouse.test:8123",
  dbUser: "adapter-user",
  dbPassword: "adapter-secret",
  dbName: "openlit"
};

interface RecordedRequest {
  readonly method: string;
  readonly query: string;
  readonly contentType: string | undefined;
  readonly body: string | undefined;
}

interface StubResponse {
  readonly status?: number;
  readonly text?: string;
}

/**
 * Stand in for ClickHouse, recording every request the adapter makes and
 * answering each query from `responses`, keyed by a substring of the query.
 *
 * The catalog tables are read as `FORMAT JSONEachRow`, so a read is answered
 * with newline-delimited JSON rather than the `{ data: [...] }` envelope the
 * `FORMAT JSON` tables use.
 */
function stubClickHouse(responses: Readonly<Record<string, StubResponse>>) {
  const realFetch = globalThis.fetch;
  const recorded: RecordedRequest[] = [];

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const query = url.searchParams.get("query") ?? "";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    recorded.push({
      method: init?.method ?? "GET",
      query,
      contentType: headers["Content-Type"],
      body: typeof init?.body === "string" ? init.body : undefined
    });

    const match = Object.keys(responses).find((candidate) =>
      query.includes(candidate)
    );
    const response = match === undefined ? undefined : responses[match];
    const status = response?.status ?? 200;

    if (status >= 400) {
      return new Response(response?.text ?? "", { status });
    }
    return new Response(response?.text ?? "", { status });
  }) as typeof globalThis.fetch;

  return {
    recorded,
    /** The nth request the adapter made, so a missing one fails loudly. */
    requestAt(index: number): RecordedRequest {
      const found = recorded[index];
      assert.ok(found, `the adapter never sent request ${index}`);
      return found;
    },
    restore: () => {
      globalThis.fetch = realFetch;
    }
  };
}

/**
 * Split an `application/x-ndjson` body into its rows.
 *
 * The catalog tables take newline-delimited JSON with no trailing newline, so
 * there is no terminator to strip here -- the last line is a row, not an empty
 * one.
 */
function ndjsonBody(
  body: string | undefined
): readonly Record<string, unknown>[] {
  assert.ok(body, "an ndjson insert must send a body");
  assert.ok(
    !body.endsWith("\n"),
    "the catalog tables are written without a trailing newline"
  );
  return body
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the catalog adapter reads, then writes, the two ClickHouse tables it owns", async () => {
  const clickhouse = stubClickHouse({});
  try {
    const result = await syncRulesyncModels(connection);

    assert.ok(result.totalProviders > 0);
    assert.ok(result.totalModels > 0);
    assert.deepEqual(
      clickhouse.recorded.map((request) => [request.method, request.query]),
      [
        [
          "POST",
          "SELECT provider_id FROM openlit.openlit_provider_metadata FORMAT JSONEachRow"
        ],
        [
          "POST",
          "SELECT provider, model_id, context_window, input_price_per_m_token, output_price_per_m_token FROM openlit.openlit_provider_models FORMAT JSONEachRow"
        ],
        [
          "POST",
          "INSERT INTO openlit.openlit_provider_metadata FORMAT JSONEachRow"
        ],
        [
          "POST",
          "INSERT INTO openlit.openlit_provider_models FORMAT JSONEachRow"
        ]
      ]
    );

    const providers = clickhouse.requestAt(2);
    const models = clickhouse.requestAt(3);
    assert.equal(providers.contentType, "application/x-ndjson");
    assert.equal(models.contentType, "application/x-ndjson");

    const providerRows = ndjsonBody(providers.body);
    assert.equal(providerRows.length, result.providersInserted.length);
    assert.ok(
      providerRows.every((row) => typeof row.provider_id === "string"),
      "every provider row carries its id"
    );

    const modelRows = ndjsonBody(models.body);
    assert.equal(modelRows.length, result.modelsInserted.length);
    assert.ok(
      modelRows.every((row) => typeof row.model_id === "string"),
      "every model row carries its model id"
    );
  } finally {
    clickhouse.restore();
  }
});

test("a catalog table that already holds the row is not rewritten", async () => {
  const clickhouse = stubClickHouse({
    "FROM openlit.openlit_provider_metadata FORMAT": {
      text: '{"provider_id":"claude"}\n'
    }
  });
  try {
    const result = await syncRulesyncModels(connection);

    assert.deepEqual(result.providersUnchanged, ["claude"]);
    assert.ok(
      !result.providersInserted.includes("claude"),
      "a provider ClickHouse already holds is not inserted again"
    );
    const insert = clickhouse.recorded.find((request) =>
      request.query.includes("INSERT INTO openlit.openlit_provider_metadata")
    );
    assert.ok(insert, "the providers ClickHouse does not hold are inserted");
    assert.ok(
      !ndjsonBody(insert.body).some((row) => row.provider_id === "claude"),
      "the row ClickHouse already holds is not written a second time"
    );
  } finally {
    clickhouse.restore();
  }
});

test("a rejected insert names the status ClickHouse returned", async () => {
  const clickhouse = stubClickHouse({
    "INSERT INTO openlit.openlit_provider_metadata": {
      status: 507,
      text: "Not enough memory"
    }
  });
  try {
    await assert.rejects(syncRulesyncModels(connection), {
      message: "ClickHouse statement failed (507): Not enough memory"
    });
  } finally {
    clickhouse.restore();
  }
});

test("a rejected read names the status ClickHouse returned", async () => {
  const clickhouse = stubClickHouse({
    "FROM openlit.openlit_provider_metadata FORMAT": {
      status: 404,
      text: "no table"
    }
  });
  try {
    await assert.rejects(syncRulesyncModels(connection), {
      message: "ClickHouse statement failed (404): no table"
    });
  } finally {
    clickhouse.restore();
  }
});
