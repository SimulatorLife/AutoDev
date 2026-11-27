import assert from "node:assert/strict";
import test from "node:test";

import { safeAutoDevSessionId as safeAutoDevelopmentSessionId } from "../src/usage/session-id.ts";

test("session identity validation accepts bounded opaque IDs and rejects sentinels/content", () => {
  assert.equal(
    safeAutoDevelopmentSessionId("  01a0ba14-d54c-78f2-9367-3f80e9a8f75f  "),
    "01a0ba14-d54c-78f2-9367-3f80e9a8f75f"
  );
  assert.equal(safeAutoDevelopmentSessionId("session:thread_42"), "session:thread_42");
  for (const value of [
    null,
    undefined,
    "",
    ' '.repeat(3),
    "unknown",
    "unattributed",
    "process-fallback",
    "process-scope",
    "/private/workspace",
    "https://example.test/session",
    "x".repeat(129)
  ]) {
    assert.equal(safeAutoDevelopmentSessionId(value), null);
  }
});
