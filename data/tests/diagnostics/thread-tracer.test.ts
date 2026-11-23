import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { findSessionRollouts } from "../../src/diagnostics/rollout-discovery.ts";
import {
  countCodePoints,
  redactSecrets,
  traceThread
} from "../../src/diagnostics/thread-tracer.ts";
import { CHILD, fixture, rolloutLine, ROOT } from "./fixture.ts";

function childRollout(home: string): string {
  const dir = path.join(home, "sessions", "2026", "09", "18");
  return path.join(dir, `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`);
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
    assert.equal(trace.tools.mcp__lsp__lsp_index_files, 1);
    assert.equal(trace.toolFailures.length, 1);
    assert.equal(trace.toolFailures[0]?.category, "transport-closed");
  } finally {
    cleanup();
  }
});

test("a root thread, which carries no agent role, is the orchestrator", () => {
  const { home, cleanup } = fixture();
  try {
    const dir = path.join(home, "sessions", "2026", "09", "18");
    const trace = traceThread(
      path.join(dir, `rollout-2026-09-18T17-00-00-${ROOT}.jsonl`),
      { items: false }
    );
    assert.equal(trace.id, ROOT);
    assert.equal(trace.parentId, null);
    assert.equal(trace.role, "orchestrator");
  } finally {
    cleanup();
  }
});

test("a silence of a minute or more inside a turn is a gap", () => {
  const { home, cleanup } = fixture();
  try {
    const trace = traceThread(childRollout(home), { items: false });
    assert.ok(trace.gaps.length > 0);
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

test("filesystem MCP calls are the investigation's reads, searches and first edit", () => {
  const { home, cleanup } = fixture();
  try {
    const dir = path.join(home, "sessions", "2026", "09", "18");
    const file = path.join(dir, `rollout-2026-09-18T17-00-00-${CHILD}.jsonl`);
    const mcp = (at: string, tool: string, args: Record<string, unknown>) =>
      rolloutLine(at, "event_msg", {
        type: "item_completed",
        item: { type: "McpToolCall", server: "filesystem", tool, arguments: args }
      });
    writeFileSync(
      file,
      [
        rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
          id: CHILD,
          session_id: ROOT,
          cwd: "/tmp/repo"
        }),
        mcp("2026-09-18T21:20:01.000Z", "read_text_file", {
          path: "/tmp/repo/README.md"
        }),
        mcp("2026-09-18T21:20:02.000Z", "read_multiple_files", {
          paths: ["/tmp/repo/README.md", "/tmp/repo/src/a.ts"]
        }),
        mcp("2026-09-18T21:20:03.000Z", "search_files", {
          path: "/tmp/repo",
          pattern: "needle"
        }),
        mcp("2026-09-18T21:20:04.000Z", "edit_file", {
          path: "/tmp/repo/src/a.ts"
        }),
        mcp("2026-09-18T21:20:05.000Z", "read_text_file", {
          path: "/tmp/repo/late.md"
        })
      ].join("\n")
    );
    const investigation = traceThread(file, { items: false }).investigation;
    assert.equal(investigation.firstEditAt, "2026-09-18T21:20:04.000Z");
    assert.equal(investigation.toolCalls, 3);
    assert.equal(investigation.filesRead, 2);
    assert.equal(investigation.repeatedReads, 1);
    assert.equal(investigation.searches, 1);
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
          input: 'await tools.read_file({path:"README.md"})'
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
          input: 'await tools.read_file({path:".env"})'
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

function promptRollout(home: string, lines: string[]): string {
  const file = childRollout(home);
  writeFileSync(
    file,
    [
      rolloutLine("2026-09-18T21:20:00.000Z", "session_meta", {
        id: CHILD,
        session_id: ROOT,
        cwd: "/tmp/repo"
      }),
      ...lines
    ].join("\n")
  );
  return file;
}

function developerMessage(at: string, ...texts: string[]): string {
  return rolloutLine(at, "response_item", {
    type: "message",
    role: "developer",
    content: texts.map((text) => ({ type: "input_text", text }))
  });
}

function execCall(at: string, callId: string, input: string): string {
  return rolloutLine(at, "response_item", {
    type: "custom_tool_call",
    name: "exec",
    call_id: callId,
    input
  });
}

test("the initial developer prompt is measured in bytes and code points, not tokens", () => {
  const { home, cleanup } = fixture();
  try {
    const file = promptRollout(home, [
      // "rules 😀\nok": 11 UTF-16 units, 10 code points, 13 UTF-8 bytes.
      developerMessage("2026-09-18T21:20:01.000Z", "rules 😀", "ok"),
      // "é": 1 code point, 2 UTF-8 bytes.
      developerMessage("2026-09-18T21:20:02.000Z", "é"),
      rolloutLine("2026-09-18T21:20:03.000Z", "response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "working" }]
      }),
      developerMessage("2026-09-18T21:20:04.000Z", "a later developer message")
    ]);
    const prompt = traceThread(file, { items: false }).efficiency?.prompt;
    assert.ok(prompt);
    assert.equal(prompt.initialDeveloperBytes, 15);
    assert.equal(prompt.initialDeveloperChars, 11);
    assert.equal(prompt.initialDeveloperTokens, null);
  } finally {
    cleanup();
  }
});

test("every tool call that reads a SKILL.md counts once per skill it names", () => {
  const { home, cleanup } = fixture();
  try {
    const file = promptRollout(home, [
      execCall(
        "2026-09-18T21:20:01.000Z",
        "c1",
        "cat /x/.agents/skills/kiss/SKILL.md && sed -n 1,5p /x/.agents/skills/kiss/SKILL.md"
      ),
      execCall(
        "2026-09-18T21:20:02.000Z",
        "c2",
        "cat /x/.agents/skills/kiss/SKILL.md /x/.agents/skills/dry/SKILL.md"
      ),
      rolloutLine("2026-09-18T21:20:03.000Z", "response_item", {
        type: "function_call",
        name: "read_file",
        call_id: "c3",
        arguments: JSON.stringify({ path: "/x/skills/bug-fix/SKILL.md" })
      }),
      execCall("2026-09-18T21:20:04.000Z", "c4", "ls /x/.agents/skills")
    ]);
    const prompt = traceThread(file, { items: false }).efficiency?.prompt;
    assert.ok(prompt);
    assert.deepEqual(prompt.skillsRead, ["bug-fix", "dry", "kiss"]);
    assert.deepEqual(prompt.skillReadCounts, {
      "bug-fix": 1,
      dry: 1,
      kiss: 2
    });
    assert.deepEqual(
      Object.keys(prompt.skillReadCounts),
      prompt.skillsRead,
      "the counts are keyed by exactly the names in skillsRead"
    );
  } finally {
    cleanup();
  }
});

test("a code point count treats a surrogate pair as one and an unpaired surrogate as one", () => {
  const samples = [
    "",
    "plain",
    "😀",
    "a\uD800b",
    "\uDC00\uD83D\uDE00",
    "trailing\uD83D",
    "e\u0301"
  ];
  for (const sample of samples)
    assert.equal(countCodePoints(sample), Array.from(sample).length, sample);
  assert.equal(countCodePoints("a\uD800b"), 3);
  assert.equal(countCodePoints("e\u0301"), 2, "not a grapheme count");
});

test("traceThread derives clientSurface from each thread session_meta originator without inheriting", () => {
  const { sessionsRoot, cleanup } = fixture();
  try {
    const rollouts = findSessionRollouts(sessionsRoot, ROOT);
    const traces = rollouts.map((file) => traceThread(file, { items: false }));
    const root = traces.find((trace) => trace.id === ROOT);
    const child = traces.find((trace) => trace.id === CHILD);
    assert.equal(root?.clientSurface, "codex_desktop");
    assert.equal(child?.clientSurface, null);
  } finally {
    cleanup();
  }
});
