import assert from "node:assert/strict";
import test from "node:test";

import * as responses from "@simulatorlife/autodev-runtime/router/responses";

// The router's SSE handling is its hottest loop: every chunk of every streaming
// response passes through it, and the buffered path walks a whole response body
// once per non-streaming request. Both used to walk the same bytes several times
// -- split, JSON.parse, rebuild, re-serialize -- for answers a single walk could
// give. These tests pin that down two ways.
//
// The parity tests pin behaviour, so the fused pass cannot quietly diverge from
// the three passes it replaced.
//
// The parse counters are the performance regression guard, and they are
// deterministic on purpose: timing assertions flake on loaded CI machines and
// then get "fixed" by loosening the threshold, which is exactly the wrong
// outcome. Counting parses measures the thing that actually regressed -- going
// back to redundant passes -- and fails the instant anyone reintroduces one.

const PUBLIC_MODEL = "autodev/orchestrator";
const SSE_LINE_WITH_NEWLINE = /(\r?\n)/;

/** A frame that needs rewriting on both counts: model and tool namespace. */
const REWRITTEN_FRAME = `data: ${JSON.stringify({
  type: "response.output_item.added",
  output_index: 0,
  item: {
    id: "fc_1",
    type: "function_call",
    name: "multi_agent_v1__spawn_agent"
  }
})}
\n
`;

/** A frame that needs nothing: a plain text delta. */
const UNCHANGED_FRAME = `data: ${JSON.stringify({
  type: "response.output_text.delta",
  item_id: "msg_1",
  delta: "hello"
})}
\n
`;

function frameSet(): string[] {
  const deltas = Array.from(
    { length: 5 },
    (_, index) =>
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: "msg_1",
        delta: `chunk ${index}`
      })}\n\n`
  );
  return [
    `data: ${JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_1",
        model: "upstream-model",
        status: "in_progress"
      }
    })}\n\n`,
    ...deltas,
    REWRITTEN_FRAME,
    `data: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "fc_2", type: "function_call", name: "read_file" }
    })}\n\n`,
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "upstream-model",
        status: "completed",
        output: [
          {
            id: "fc_1",
            type: "function_call",
            name: "multi_agent_v1__spawn_agent"
          },
          { id: "fc_2", type: "function_call", name: "read_file" }
        ]
      }
    })}\n\n`,
    "data: [DONE]\n\n"
  ];
}

/**
 * The three-pass implementation the fused path replaced, reconstructed against
 * the still-exported pure helpers so parity is compared against real behaviour
 * rather than against a restatement of it.
 */
function threePassTransform(frame: string): string {
  return frame
    .split(SSE_LINE_WITH_NEWLINE)
    .map((line) => {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") return line;
      try {
        const parsed = JSON.parse(line.slice(6));
        return `data: ${JSON.stringify(
          responses.rewriteResponseValue(parsed, PUBLIC_MODEL)
        )}`;
      } catch {
        return line;
      }
    })
    .join("");
}

/** Counts JSON.parse calls made inside `run`. */
function countParses<T>(run: () => T): { result: T; parses: number } {
  const original = JSON.parse;
  let parses = 0;
  JSON.parse = function countedParse(...args: Parameters<typeof JSON.parse>) {
    parses += 1;
    return original.apply(JSON, args) as unknown;
  } as typeof JSON.parse;
  try {
    return { result: run(), parses };
  } finally {
    JSON.parse = original;
  }
}

test("processSseEvent matches the three-pass output it replaced", () => {
  for (const frame of frameSet()) {
    const { output } = responses.processSseEvent(frame, {
      publicModel: PUBLIC_MODEL
    });
    assert.equal(output, threePassTransform(frame), `frame: ${frame}`);
  }
});

test("processSseEvent counts the same tool calls and dedupes the same ids", () => {
  for (const frame of frameSet()) {
    const oldSeen = new Set<string>();
    const oldCount = responses.countToolCallsFromSse(frame, oldSeen);
    const newSeen = new Set<string>();
    const { toolCalls } = responses.processSseEvent(frame, {
      publicModel: PUBLIC_MODEL,
      seenToolCalls: newSeen
    });
    assert.equal(toolCalls, oldCount, `frame: ${frame}`);
    assert.deepEqual([...newSeen].sort(), [...oldSeen].sort());
  }
});

test("a frame that needs no rewrite is emitted byte for byte", () => {
  // This is the payoff of tracking whether the rewrite changed anything: an
  // untouched frame is never round-tripped through JSON.stringify, so the proxy
  // stops normalizing whitespace in payloads it was never modifying.
  const { output } = responses.processSseEvent(UNCHANGED_FRAME, {
    publicModel: PUBLIC_MODEL
  });
  assert.equal(output, UNCHANGED_FRAME);
});

test("a frame that does need a rewrite is still rewritten", () => {
  // Guards the optimization from being "fixed" by deleting the rewrite.
  const { output } = responses.processSseEvent(REWRITTEN_FRAME, {
    publicModel: PUBLIC_MODEL
  });
  assert.notEqual(output, REWRITTEN_FRAME);
  assert.match(output, /"namespace":"multi_agent_v1"/);
  assert.match(output, /"name":"spawn_agent"/);
});

test("the rewriters report no change when they have nothing to do", () => {
  const unchanged = responses.rewriteResponseValueTracking(
    { type: "response.output_text.delta", delta: "hi" },
    PUBLIC_MODEL
  );
  assert.equal(unchanged.changed, false);
  assert.equal(
    responses.rewriteResponseValueTracking(
      { model: "upstream-model" },
      PUBLIC_MODEL
    ).changed,
    true
  );
  assert.equal(
    responses.rewriteResponseValueTracking(
      { item: { name: "multi_agent_v1__spawn_agent" } },
      PUBLIC_MODEL
    ).changed,
    true
  );
});

test("processSseEvent parses each data line exactly once", () => {
  const frames = frameSet();
  // One JSON call per `data:` line that holds JSON, and nothing else.
  let expected = 0;
  for (const frame of frames)
    for (const line of frame.split(SSE_LINE_WITH_NEWLINE)) {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
      try {
        JSON.parse(line.slice(6));
        expected += 1;
      } catch {
        // not a JSON line
      }
    }
  const { parses } = countParses(() => {
    for (const frame of frames)
      responses.processSseEvent(frame, {
        publicModel: PUBLIC_MODEL,
        seenToolCalls: new Set<string>()
      });
  });
  assert.equal(parses, expected);
});

test("summarizeBufferedSse parses each data line exactly once", () => {
  const body = frameSet().join("");
  let expected = 0;
  for (const line of body.split(SSE_LINE_WITH_NEWLINE)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      JSON.parse(line.slice(6));
      expected += 1;
    } catch {
      // not a JSON line
    }
  }
  const { result, parses } = countParses(() =>
    responses.summarizeBufferedSse(body)
  );
  assert.equal(parses, expected);
  // And it answers everything the three separate scans used to answer.
  assert.equal(result.toolCalls, responses.countToolCallsFromSse(body));
  assert.deepEqual(
    responses.bufferedEnvelope(result),
    responses.responseTextFromSse(body)
  );
  assert.equal(
    result.firstCompleted?.model,
    "upstream-model",
    "the completed response is still found"
  );
});

test("summarizeBufferedSse tolerates malformed and comment frames", () => {
  const body = [
    ": keep-alive",
    "data: not json",
    `data: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: "ok"
    })}`,
    "data: [DONE]",
    ""
  ].join("\n");
  const summary = responses.summarizeBufferedSse(body);
  assert.equal(summary.text, "ok");
  assert.equal(summary.toolCalls, 0);
  assert.equal(summary.firstCompleted, null);
  assert.deepEqual(responses.bufferedEnvelope(summary).output_text, "ok");
});
