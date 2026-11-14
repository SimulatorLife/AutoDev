import assert from "node:assert/strict";
import test from "node:test";

import { jsonErrorResponse } from "../src/lib/server/api-response.ts";

test("Console API errors share an uncached JSON envelope", async () => {
  const response = jsonErrorResponse(409, "conflict", "Try again.");

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), {
    kind: "error",
    code: "conflict",
    message: "Try again."
  });
});
