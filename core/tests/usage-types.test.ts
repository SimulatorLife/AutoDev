import assert from "node:assert/strict";
import test from "node:test";

import { USAGE_VARIABLE_IDS } from "../src/index.ts";

test("Usage filter axes have one canonical, stable order", () => {
  assert.deepEqual(USAGE_VARIABLE_IDS, [
    "workspace",
    "provider",
    "model",
    "agent",
    "skill"
  ]);
});
