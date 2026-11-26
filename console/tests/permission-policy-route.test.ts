import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../app/api/permissions/route.ts";

test("the retired Console permission-policy proxy cannot forward a write to an older Runtime", () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "p".repeat(64);
  globalThis.fetch = () => {
    assert.fail("A retired proxy must never contact the Runtime.");
  };
  try {
    const response = POST();
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("location"), null);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
  }
});
