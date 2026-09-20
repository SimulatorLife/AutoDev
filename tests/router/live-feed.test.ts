import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_FEED_CATEGORIES,
  LiveFeedRecorder
} from "../../src/router/live-feed.ts";

test("live feed recorder keeps bounded, categorized, privacy-safe summaries", () => {
  const feed = new LiveFeedRecorder(2);
  feed.record({
    category: "routing",
    type: "routing.selected",
    summary: "selected claude/sonnet",
    requestId: "req-1"
  });
  feed.record({
    category: "tools",
    type: "tool_executed",
    summary: "tool_executed: exec_command",
    requestId: "req-1"
  });
  feed.record({
    category: "mcp",
    type: "otel.traces",
    summary: "make_rmcp_client"
  });

  assert.deepEqual(
    feed.getRecentEvents().map((event) => event.category),
    ["mcp", "tools"]
  );
  assert.equal(feed.getRecentEvents()[0]?.summary, "make_rmcp_client");
  assert.equal(feed.getRecentEvents()[1]?.requestId, "req-1");
  assert.deepEqual(LIVE_FEED_CATEGORIES, [
    "routing",
    "tools",
    "hooks",
    "skills",
    "mcp",
    "telemetry",
    "runtime"
  ]);
});

test("live feed restore rejects unknown categories and preserves known events", () => {
  const feed = new LiveFeedRecorder();
  feed.restore([
    {
      category: "routing",
      type: "routing.result",
      summary: "success",
      timestamp: "2026-09-19T00:00:00.000Z"
    },
    { category: "unknown", type: "secret", summary: "should not render" }
  ]);

  assert.equal(feed.getRecentEvents().length, 1);
  assert.equal(feed.getRecentEvents()[0]?.category, "routing");
});
