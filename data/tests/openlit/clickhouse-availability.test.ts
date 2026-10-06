import assert from "node:assert/strict";
import test from "node:test";

import { isClickHouseUnavailable } from "./clickhouse-availability.ts";

/** The shape undici raises when a single address refused the connection. */
function fetchFailed(cause: unknown): TypeError {
  return Object.assign(new TypeError("fetch failed"), { cause });
}

/** The shape undici raises when it tried several addresses at once. */
function aggregateFetchFailed(code: string): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: new AggregateError(
      [Object.assign(new Error("connect"), { code })],
      "all failed"
    )
  });
}

test("a refused connection reads as an unavailable ClickHouse, however fetch reported it", () => {
  assert.equal(
    isClickHouseUnavailable(
      fetchFailed(Object.assign(new Error("connect"), { code: "ECONNREFUSED" }))
    ),
    true
  );
  assert.equal(
    isClickHouseUnavailable(aggregateFetchFailed("ECONNREFUSED")),
    true
  );
  assert.equal(
    isClickHouseUnavailable(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" }
      })
    ),
    true
  );
});

test("a refused connection buried two causes deep still reads as unavailable", () => {
  const nested = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect"), {
      cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" })
    })
  });
  assert.equal(isClickHouseUnavailable(nested), true);
});

test("only a refused connection counts as an absent ClickHouse", () => {
  // A host that does not resolve is a misconfiguration, not an absent server,
  // and must fail loudly rather than quietly skip.
  assert.equal(
    isClickHouseUnavailable(aggregateFetchFailed("ENOTFOUND")),
    false
  );
  assert.equal(isClickHouseUnavailable(fetchFailed("not an error")), false);
});

test("a real product failure is never mistaken for an absent server", () => {
  assert.equal(
    isClickHouseUnavailable(
      new Error(
        "Failed to bulk insert into openlit_agents_summary: Not enough memory"
      )
    ),
    false
  );
  assert.equal(isClickHouseUnavailable(undefined), false);
  assert.equal(isClickHouseUnavailable("ECONNREFUSED"), false);
});

test("a cause chain that loops cannot hang the guard", () => {
  const looping: { cause?: unknown } = {};
  looping.cause = looping;
  assert.equal(isClickHouseUnavailable(looping), false);
});
