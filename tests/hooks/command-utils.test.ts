import assert from "node:assert/strict";
import test from "node:test";

import * as commandUtils from "../../src/hooks/command-utils.ts";

test("command utilities expose only paths consumed by root delegation", () => {
  assert.deepEqual(Object.keys(commandUtils).sort(), [
    "codexHome",
    "repositoryRoot"
  ]);
});
