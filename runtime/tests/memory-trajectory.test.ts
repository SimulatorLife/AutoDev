import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_NATIVE_TRAJECTORY_BYTES,
  type NativeTrajectorySource,
  normalizeNativeTrajectory
} from "../src/memory/trajectory.ts";

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
  assert.equal(summary.normalizerId, "@letta-ai/trajectory");
  assert.match(summary.normalizerVersion, /^\d+\.\d+\.\d+/u);
  assert.equal(summary.recordCount, 3);
  assert.equal(summary.diagnosticCount, 0);
  assert.deepEqual(summary.diagnosticCodes, []);
  assert.equal(summary.timestampsInferred, false);
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

test("trajectory normalization marks synthesized times as inferred metadata", () => {
  const transcript = [
    {
      type: "user",
      uuid: "user-record",
      sessionId: "session-a",
      cwd: "/workspace/repo",
      message: { role: "user", content: "private prompt" }
    },
    {
      type: "assistant",
      uuid: "assistant-record",
      sessionId: "session-a",
      message: { role: "assistant", content: "private response" }
    }
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");

  const summary = normalizeNativeTrajectory({
    source: "claude-code",
    transcript,
    uri: "file:///workspace/session.jsonl"
  });

  assert.equal(summary.timestampsInferred, true);
  assert.ok(
    summary.diagnosticCodes.some((code) => code.startsWith("timestamps_"))
  );
  assert.deepEqual(
    summary.diagnosticCodes,
    [...summary.diagnosticCodes].sort()
  );
  assert.match(JSON.stringify(summary), /timestampsInferred/);
  assert.doesNotMatch(
    JSON.stringify(summary),
    /private prompt|private response/
  );
});

test("native trajectory normalization refuses unbounded transcript payloads", () => {
  assert.throws(
    () =>
      normalizeNativeTrajectory({
        source: "codex",
        transcript: "x".repeat(MAX_NATIVE_TRAJECTORY_BYTES + 1),
        uri: "file:///trajectory.jsonl"
      }),
    RangeError
  );
});

test("Letta normalization accepts each enabled native harness source", () => {
  const transcripts: Readonly<Record<NativeTrajectorySource, string>> = {
    codex: [
      { type: "session_meta", payload: { id: "codex-session" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "private codex prompt" }]
        }
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "private codex answer" }]
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
    "claude-code": [
      {
        type: "user",
        uuid: "claude-user-1",
        sessionId: "claude-session",
        timestamp: "2026-10-01T10:00:00Z",
        cwd: "/workspace/repo",
        message: { role: "user", content: "private Claude prompt" }
      },
      {
        type: "assistant",
        uuid: "claude-assistant-1",
        sessionId: "claude-session",
        timestamp: "2026-10-01T10:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "private Claude answer" }]
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
    "copilot-cli": [
      {
        type: "session.start",
        timestamp: "2026-10-01T10:00:00Z",
        data: {
          sessionId: "copilot-session",
          context: { cwd: "/workspace/repo", branch: "main" }
        }
      },
      {
        type: "hook.start",
        timestamp: "2026-10-01T10:00:01Z",
        data: {
          hookType: "userPromptSubmitted",
          input: {
            sessionId: "copilot-session",
            cwd: "/workspace/repo",
            prompt: "private Copilot prompt"
          }
        }
      },
      {
        type: "assistant.message",
        timestamp: "2026-10-01T10:00:02Z",
        data: { content: "private Copilot answer", model: "test-model" }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
    "gemini-cli": JSON.stringify({
      messages: [
        {
          type: "user",
          timestamp: "2026-10-01T10:00:00Z",
          content: "private Gemini prompt"
        },
        {
          type: "gemini",
          timestamp: "2026-10-01T10:00:01Z",
          model: "gemini-test",
          content: "private Gemini answer"
        }
      ]
    }),
    openhands: JSON.stringify([
      {
        id: "openhands-user",
        kind: "MessageEvent",
        source: "user",
        timestamp: "2026-10-01T10:00:00Z",
        llm_message: {
          content: [{ type: "text", text: "private OpenHands prompt" }]
        }
      },
      {
        id: "openhands-assistant",
        kind: "MessageEvent",
        source: "agent",
        timestamp: "2026-10-01T10:00:01Z",
        llm_message: {
          content: [{ type: "text", text: "private OpenHands answer" }]
        }
      }
    ]),
    "letta-code": [
      {
        kind: "user",
        text: "private Letta prompt",
        captured_at: "2026-10-01T10:00:00Z"
      },
      {
        kind: "assistant",
        text: "private Letta answer",
        captured_at: "2026-10-01T10:00:01Z"
      }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n"),
    opencode: JSON.stringify({
      info: {
        id: "opencode-session",
        directory: "/workspace/repo",
        time: { created: "2026-10-01T10:00:00Z" }
      },
      messages: [
        {
          info: {
            id: "opencode-user",
            role: "user",
            time: { created: "2026-10-01T10:00:00Z" }
          },
          parts: [{ type: "text", text: "private OpenCode prompt" }]
        },
        {
          info: {
            id: "opencode-assistant",
            role: "assistant",
            time: { created: "2026-10-01T10:00:01Z" }
          },
          parts: [{ type: "text", text: "private OpenCode answer" }]
        }
      ]
    }),
    cursor: [
      {
        id: "cursor-user",
        role: "user",
        message: { content: "private Cursor prompt" }
      },
      {
        id: "cursor-assistant",
        role: "assistant",
        message: { content: "private Cursor answer" }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")
  };

  for (const source of [
    "codex",
    "claude-code",
    "copilot-cli",
    "gemini-cli",
    "openhands",
    "letta-code",
    "opencode",
    "cursor"
  ] as const) {
    const summary = normalizeNativeTrajectory({
      source,
      transcript: transcripts[source],
      uri: `file:///workspace/repo/${source}.transcript`
    });
    assert.equal(summary.source, source);
    assert.equal(summary.normalizerId, "@letta-ai/trajectory");
    assert.ok(summary.normalizerVersion.length > 0);
    assert.ok(summary.recordCount > 0, `${source} must decode records`);
    assert.doesNotMatch(
      JSON.stringify(summary),
      /private (?:codex|Claude|Copilot|Gemini) (?:prompt|answer)/u
    );
  }
});
