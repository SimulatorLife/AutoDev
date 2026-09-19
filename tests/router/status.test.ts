import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRouterStatus,
  serializeRouterStatus
} from "../../src/router/status.ts";

test("router status boundary preserves the legacy response shape", () => {
  const status = {
    router: "codex-model-router",
    providers: { claude: { status: "ready" } }
  };
  const parsed = parseRouterStatus(status);

  assert.equal(parsed, status);
  assert.equal(serializeRouterStatus(parsed), JSON.stringify(status, null, 2));
});

test("router status boundary rejects non-object responses", () => {
  assert.throws(() => parseRouterStatus(null), /must be a JSON object/);
  assert.throws(() => parseRouterStatus([]), /must be a JSON object/);
});
