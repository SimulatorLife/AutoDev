import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { redactSecrets, traceThread } from "../../src/diagnostics/thread-tracer.ts";

import { CHILD, fixture, rolloutLine, ROOT } from "./fixture.ts";

function childRollout(home: string): string {
  const dir = path.join(home, "sessions", "2026", "09", "18");
  const file = path.join(dir, `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`);
  return file;
}

test("a thread's turns, gaps and tool calls are read from its rollout", () => {
  const { home, cleanup } = fixture();
  try {
    const trace = traceThread(childRollout(home), { items: false });
    assert.equal(trace.id, CHILD);
    assert.equal(trace.sessionId, ROOT);
    assert.equal(trace.parentId, ROOT);
    assert.equal(trace.role, "worker");
    assert.equal(trace.nickname, "ImplementationCoder");
    assert.equal(trace.model, "autodev/worker");
    assert.equal(trace.turns.length, 1);
    assert.equal(trace.turns[0]?.outcome, "aborted:interrupted");
    assert.equal(trace.tools["mcp__lsp__lsp_index_files"], 1);
    assert.equal(trace.toolFailures.length, 1);
    assert.equal(trace.toolFailures[0]?.category, "transport-closed");
  } finally {
    cleanup();
  }
});

test("a silence of a minute or more inside a turn is a gap", () => {
  const { home, cleanup } = fixture();
  try {
    const trace = traceThread(childRollout(home), { items: false });
    assert.ok(trace.gaps.length >= 1);
    assert.ok(trace.gaps.every((gap) => gap.seconds >= 60));
  } finally {
    cleanup();
  }
});

test("the investigation counts stop at the first file change", () => {
  const { home, cleanup } = fixture();
  try {
    const dir = path.join(home, "sessions", "2026", "09", "18");
    const file = path.join(dir, `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`);
    writeFileSync(
      file,
      [
        rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
          id: CHILD,
          session_id: ROOT,
          cwd: "/tmp/repo"
        }),
        rolloutLine("2026-09-18T21:20:01.000Z", "event_msg", {
          type: "item_completed",
          item: {
            type: "CommandExecution",
            parsed_cmd: [
              { type: "read", path: "/tmp/repo/README.md" },
              { type: "read", path: "/tmp/repo/README.md" },
              { type: "search", query: "needle", path: "/tmp/repo" }
            ]
          }
        }),
        rolloutLine("2026-09-18T21:20:02.000Z", "event_msg", {
          type: "item_completed",
          item: { type: "McpToolCall", server: "codegraphcontext" }
        }),
        rolloutLine("2026-09-18T21:20:03.000Z", "event_msg", {
          type: "item_completed",
          item: { type: "FileChange" }
        }),
        rolloutLine("2026-09-18T21:20:04.000Z", "event_msg", {
          type: "item_completed",
          item: { type: "CommandExecution", parsed_cmd: [] }
        })
      ].join("\n")
    );
    const trace = traceThread(file, { items: false });
    const investigation = trace.investigation;
    assert.equal(investigation.observed, true);
    assert.equal(investigation.firstEditAt, "2026-09-18T21:20:03.000Z");
    assert.equal(investigation.toolCalls, 2);
    assert.equal(investigation.filesRead, 1);
    assert.equal(investigation.repeatedReads, 1);
    assert.equal(investigation.searches, 1);
    assert.equal(investigation.context.cgc, 1);
  } finally {
    cleanup();
  }
});

test("token usage, cache drops and compactions are accumulated", () => {
  const { home, cleanup } = fixture();
  try {
    const dir = path.join(home, "sessions", "2026", "09", "18");
    const file = path.join(dir, `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`);
    writeFileSync(
      file,
      [
        rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
          id: CHILD,
          session_id: ROOT,
          agent_role: "worker",
          cwd: "/tmp/repo"
        }),
        rolloutLine("2026-09-18T21:20:01.000Z", "event_msg", {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 1000,
              input_tokens: 800,
              cached_input_tokens: 400,
              output_tokens: 100,
              reasoning_output_tokens: 50
            },
            last_token_usage: {
              input_tokens: 800,
              cached_input_tokens: 400
            }
          }
        }),
        rolloutLine("2026-09-18T21:20:02.000Z", "event_msg", {
          type: "context_compacted"
        }),
        rolloutLine("2026-09-18T21:20:03.000Z", "compacted", {
          replacement_history: [
            { type: "message", text: "kept" },
            { type: "image", image_url: "data:image/png;base64,AAAA" }
          ]
        })
      ].join("\n")
    );
    const trace = traceThread(file, { items: false });
    const efficiency = trace.efficiency;
    assert.ok(efficiency);
    assert.equal(efficiency.tokens.observed, true);
    assert.equal(efficiency.tokens.totalTokens, 1000);
    assert.equal(efficiency.tokens.cachedInputTokens, 400);
    assert.equal(efficiency.tokens.cacheHitPct, 50);
    assert.equal(efficiency.tokens.reasoningPct, 50);
    assert.equal(efficiency.tokens.peakInputTokens, 800);
    assert.equal(efficiency.compaction.count, 1);
    assert.equal(efficiency.compaction.contextCompactedEvents, 1);
    assert.equal(efficiency.compaction.maxReplacementItems, 2);
    assert.equal(efficiency.compaction.maxReplacementImages, 1);
  } finally {
    cleanup();
  }
});

test("a rollout without item records reports the investigation as unavailable, not zero", () => {
  const { home, cleanup } = fixture();
  try {
    const dir = path.join(home, "sessions", "2026", "09", "18");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`);
    writeFileSync(
      file,
      `${rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
        id: CHILD,
        session_id: ROOT
      })}\n`
    );
    const trace = traceThread(file, { items: false });
    assert.equal(trace.investigation.observed, false);
  } finally {
    cleanup();
  }
});

test("a malformed rollout line is skipped instead of aborting the read", () => {
  const { home, cleanup } = fixture();
  try {
    const dir = path.join(home, "sessions", "2026", "09", "18");
    const file = path.join(dir, `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`);
    writeFileSync(
      file,
      [
        rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
          id: CHILD,
          session_id: ROOT,
          agent_role: "worker"
        }),
        "{ not json",
        rolloutLine("2026-09-18T21:20:05.000Z", "response_item", {
          type: "custom_tool_call",
          name: "exec",
          call_id: "c1",
          input: "await tools.read_file({path:\"README.md\"})"
        })
      ].join("\n")
    );
    const trace = traceThread(file, { items: false });
    assert.equal(trace.tools.read_file, 1);
  } finally {
    cleanup();
  }
});

test("secrets are redacted before they are quoted", () => {
  const redacted = redactSecrets(
    "Authorization: Bearer abcdefghijklmnop and API_KEY=sk-abcdefghijklmnopqrstuvwx"
  );
  assert.doesNotMatch(redacted, /abcdefghijklmnop/u);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwx/u);
  assert.match(redacted, /\[redacted\]/u);
});

test("a quoted tool failure keeps the secret out of the report", () => {
  const { home, cleanup } = fixture();
  try {
    const dir = path.join(home, "sessions", "2026", "09", "18");
    const file = path.join(dir, `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`);
    writeFileSync(
      file,
      [
        rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
          id: CHILD,
          session_id: ROOT
        }),
        rolloutLine("2026-09-18T21:20:01.000Z", "response_item", {
          type: "custom_tool_call",
          name: "exec",
          call_id: "c1",
          input: "await tools.read_file({path:\".env\"})"
        }),
        rolloutLine("2026-09-18T21:20:02.000Z", "response_item", {
          type: "custom_tool_call_output",
          call_id: "c1",
          output: [
            {
              type: "input_text",
              text: "tool call failed: API_KEY=sk-abcdefghijklmnopqrstuvwx Authorization: Bearer abcdefghijklmnop"
            }
          ]
        })
      ].join("\n")
    );
    const trace = traceThread(file, { items: false });
    const failure = trace.toolFailures[0];
    assert.ok(failure);
    assert.doesNotMatch(failure.detail, /sk-abcdefghijklmnopqrstuvwx/u);
    assert.doesNotMatch(failure.detail, /Bearer abcdefghijklmnop/u);
  } finally {
    cleanup();
  }
});
