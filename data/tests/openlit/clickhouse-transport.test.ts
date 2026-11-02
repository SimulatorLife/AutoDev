import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { syncRulesyncAgents } from "@simulatorlife/autodev-data/openlit";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

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
  readonly rows?: readonly unknown[];
  readonly text?: string;
}

/**
 * Stand in for ClickHouse, recording every request the adapter makes and
 * answering each query from `responses`, keyed by a substring of the query.
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
    return Response.json({ data: response?.rows ?? [] });
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

function jsonEachRowBody(
  body: string | undefined
): readonly Record<string, unknown>[] {
  assert.ok(body, "a JSONEachRow insert must send a body");
  assert.ok(
    body.endsWith("\n"),
    "the final newline is what tells ClickHouse the last row is complete"
  );
  const lines = body.split("\n");
  assert.equal(lines.at(-1), "", "the body ends with exactly one terminator");
  return lines
    .slice(0, -1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the agents adapter reads, then writes, the two ClickHouse tables it owns", async () => {
  const clickhouse = stubClickHouse({});
  try {
    const result = await syncRulesyncAgents({ repositoryRoot, ...connection });

    assert.ok(result.totalCatalogAgents > 0);
    assert.deepEqual(
      clickhouse.recorded.map((request) => [request.method, request.query]),
      [
        [
          "GET",
          "SELECT agent_key, service_name, source FROM openlit_agents_summary FORMAT JSON"
        ],
        [
          "GET",
          "SELECT agent_key, version_hash, version_number, system_prompt, tools, runtime_config FROM openlit_agent_versions FORMAT JSON"
        ],
        ["POST", "INSERT INTO openlit_agents_summary FORMAT JSONEachRow"],
        ["POST", "INSERT INTO openlit_agent_versions FORMAT JSONEachRow"]
      ]
    );

    const summaries = clickhouse.requestAt(2);
    const versions = clickhouse.requestAt(3);
    assert.equal(summaries.contentType, "application/json");
    assert.equal(versions.contentType, "application/json");

    const summaryRows = jsonEachRowBody(summaries.body);
    assert.equal(
      summaryRows.length,
      result.inserted.length + result.updated.length
    );
    assert.ok(
      summaryRows.every((row) => typeof row.agent_key === "string"),
      "every summary row carries its primary key"
    );

    const versionRows = jsonEachRowBody(versions.body);
    assert.equal(versionRows.length, summaryRows.length);
    assert.ok(
      versionRows.every((row) => typeof row.version_hash === "string"),
      "every version row carries its content hash"
    );
  } finally {
    clickhouse.restore();
  }
});

test("a rejected insert names the table it failed to write", async () => {
  const clickhouse = stubClickHouse({
    "INSERT INTO openlit_agents_summary": {
      status: 507,
      text: "Not enough memory"
    }
  });
  try {
    await assert.rejects(
      syncRulesyncAgents({ repositoryRoot, ...connection }),
      {
        message:
          "Failed to bulk insert into openlit_agents_summary: Not enough memory"
      }
    );
  } finally {
    clickhouse.restore();
  }
});

test("a rejected read names the table and the status ClickHouse returned", async () => {
  const clickhouse = stubClickHouse({
    "FROM openlit_agents_summary FORMAT": { status: 404, text: "no table" }
  });
  try {
    await assert.rejects(
      syncRulesyncAgents({ repositoryRoot, ...connection }),
      {
        message:
          "Failed to query openlit_agents_summary from ClickHouse (404): no table"
      }
    );
  } finally {
    clickhouse.restore();
  }
});
