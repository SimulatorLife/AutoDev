import assert from "node:assert/strict";
import test from "node:test";

import { normalizeNativeTrajectory } from "../src/memory/trajectory.ts";

test("Letta trajectory normalization validates native transcripts but returns only a safe reference summary", () => {
  const transcript = [
    {
      type: "session_meta",
      payload: {
        id: "session-1",
        cwd: "/workspace/repo",
        timestamp: "2026-09-30T10:00:00Z"
      }
    },
    {
      type: "response_item",
      timestamp: "2026-09-30T10:00:01Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "private task prompt secret=do-not-persist"
          }
        ]
      }
    },
    {
      type: "response_item",
      timestamp: "2026-09-30T10:00:02Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "private tool output" }]
      }
    }
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");

  const summary = normalizeNativeTrajectory({
    source: "codex",
    transcript,
    uri: "https://memory.example/trajectory?token=must-not-persist&ref=sha"
  });

  assert.equal(summary.format, "letta-trajectory-v1");
  assert.equal(summary.source, "codex");
  assert.equal(summary.recordCount, 3);
  assert.equal(summary.diagnosticCount, 0);
  assert.equal(summary.roleCounts.user, 1);
  assert.equal(summary.roleCounts.assistant, 1);
  assert.equal(summary.firstTimestamp, "2026-09-30T10:00:01.000Z");
  assert.equal(summary.uri, "https://memory.example/trajectory?ref=sha");
  assert.equal("records" in summary, false);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /private task prompt|private tool output|do-not-persist/
  );
  assert.match(summary.digest, /^[a-f0-9]{64}$/);
});

test("native trajectory normalization refuses unbounded transcript payloads", () => {
  assert.throws(
    () =>
      normalizeNativeTrajectory({
        source: "codex",
        transcript: "x".repeat(32 * 1024 * 1024 + 1),
        uri: "file:///trajectory.jsonl"
      }),
    RangeError
  );
});
