// Micro-benchmark for the router's per-SSE-frame drain work.
//
//   node scripts/sse-drain-bench.mjs
//
// This is the hottest loop in the router: every chunk of every streaming
// response passes through it. It used to run three independent passes over the
// same frame -- inspect (split + JSON.parse), count tool calls (split +
// JSON.parse), transform (split + JSON.parse + two full deep rebuilds +
// JSON.stringify) -- so the bytes were split three times and parsed three times,
// and every frame was re-serialized even when nothing about it needed changing.
//
// The frame mix is a realistic Codex turn: mostly small delta frames, a few
// tool-call frames, and one `response.completed` frame carrying the whole
// accumulated output. Only that last frame actually needs the model rewritten,
// which is the point -- the old drain paid a deep rebuild and a stringify for
// every frame to change one of them.
//
// `oldDrain` below is the previous implementation, reconstructed against the
// still-exported pure helpers, so the two columns measure the same work.

import {
  bufferedEnvelope,
  countToolCallsFromSse,
  processSseEvent,
  responseTextFromSse,
  rewriteResponseValue,
  summarizeBufferedSse
} from "../runtime/src/router/responses.ts";

const PUBLIC_MODEL = "autodev/orchestrator";
const SSE_LINE_WITH_NEWLINE = /(\r?\n)/;

/** A realistic Codex turn: created, in-progress, items, deltas, completed. */
function buildFrameSet({ textDeltas = 40, reasoningDeltas = 12 } = {}) {
  const frames = [];
  frames.push(
    `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: {
        id: "resp_01",
        model: "gpt-5.6-terra",
        status: "in_progress",
        usage: null
      }
    })}\n\n`
  );
  frames.push(
    `data: ${JSON.stringify({
      type: "response.in_progress",
      response: { id: "resp_01", model: "gpt-5.6-terra", status: "in_progress" }
    })}\n\n`
  );
  frames.push(
    `data: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "rs_1", type: "reasoning", summary: [] }
    })}\n\n`
  );
  for (let index = 0; index < reasoningDeltas; index += 1) {
    frames.push(
      `data: ${JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        delta: "Considering the next step in the migration. ".repeat(3)
      })}\n\n`
    );
  }
  frames.push(
    `data: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 1,
      item: { id: "msg_1", type: "message", role: "assistant", content: [] }
    })}\n\n`
  );
  for (let index = 0; index < textDeltas; index += 1) {
    frames.push(
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: "msg_1",
        delta: "The router rewrites the model field and tool namespaces. ".repeat(2)
      })}\n\n`
    );
  }
  // Tool calls: these are the frames the namespace rewrite exists for.
  const output = [
    {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "x".repeat(400) }]
    },
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "y".repeat(2400) }]
    }
  ];
  for (let index = 0; index < 6; index += 1) {
    frames.push(
      `data: ${JSON.stringify({
        type: "response.output_item.added",
        output_index: 2 + index,
        item: {
          id: `fc_${index}`,
          type: "function_call",
          name: "multi_agent_v1__spawn_agent"
        }
      })}\n\n`
    );
    output.push({
      id: `fc_${index}`,
      type: "function_call",
      name: `multi_agent_v1__spawn_agent`,
      arguments: JSON.stringify({ index })
    });
  }
  // The terminal frame: the whole accumulated output, and the one frame whose
  // `model` field actually has to be rewritten.
  frames.push(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_01",
        model: "gpt-5.6-terra",
        status: "completed",
        output,
        usage: { input_tokens: 1200, output_tokens: 800, total_tokens: 2000 }
      }
    })}\n\n`
  );
  frames.push("data: [DONE]\n\n");
  return frames;
}

/** The previous implementation: three passes, re-serialize unconditionally. */
function oldTransform(frame, publicModel) {
  return frame
    .split(SSE_LINE_WITH_NEWLINE)
    .map((line) => {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") return line;
      try {
        const parsed = JSON.parse(line.slice(6));
        return `data: ${JSON.stringify(rewriteResponseValue(parsed, publicModel))}`;
      } catch {
        return line;
      }
    })
    .join("");
}

function oldDrain(frame, seen) {
  let sink = 0;
  // Pass 1: inspect.
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
    try {
      JSON.parse(line.slice(6));
      sink += 1;
    } catch {
      // ignore
    }
  }
  // Pass 2: count.
  sink += countToolCallsFromSse(frame, seen);
  // Pass 3: transform.
  return sink + oldTransform(frame, PUBLIC_MODEL).length;
}

function newDrain(frame, seen) {
  return processSseEvent(frame, {
    publicModel: PUBLIC_MODEL,
    seenToolCalls: seen
  });
}

// Parity first: a faster answer that differs is not a faster answer.
const frames = buildFrameSet();
for (const frame of frames) {
  const oldOut = oldTransform(frame, PUBLIC_MODEL);
  const { output } = processSseEvent(frame, { publicModel: PUBLIC_MODEL });
  if (oldOut !== output) {
    throw new Error(`output differs for frame:\nold: ${oldOut}\nnew: ${output}`);
  }
  const oldSeen = new Set();
  const newSeen = new Set();
  const oldCount = countToolCallsFromSse(frame, oldSeen);
  const { toolCalls } = processSseEvent(frame, {
    publicModel: PUBLIC_MODEL,
    seenToolCalls: newSeen
  });
  if (oldCount !== toolCalls) {
    throw new Error(`tool-call count differs: ${oldCount} vs ${toolCalls}`);
  }
}
console.log(`parity: ${frames.length} frames identical (output + tool-call count)\n`);

function bench(label, fn, iterations) {
  const seen = new Set();
  for (let index = 0; index < 300; index += 1) {
    for (const frame of frames) fn(frame, seen);
    seen.clear();
  }
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    for (const frame of frames) fn(frame, seen);
    seen.clear();
  }
  return Number(process.hrtime.bigint() - started) / iterations / 1000;
}

const ITERATIONS = 3000;
console.log(
  `frames/turn: ${frames.length}   bytes/turn: ${frames.reduce(
    (sum, frame) => sum + frame.length,
    0
  )}   iterations: ${ITERATIONS}\n`
);
console.log("variant                       us/turn     us/frame");
const before = bench("old (3 splits, 3 parses, 2 rebuilds)", oldDrain, ITERATIONS);
const after = bench("new (1 split, 1 parse, no-op rewrite)", newDrain, ITERATIONS);
console.log(
  `\nper turn:  ${before.toFixed(1)} us -> ${after.toFixed(1)} us  (${(before / after).toFixed(2)}x)`
);
console.log(
  `per frame: ${(before / frames.length).toFixed(3)} us -> ${(after / frames.length).toFixed(3)} us  (${(before / after).toFixed(2)}x)`
);
console.log(`removed:    ${(100 * (1 - after / before)).toFixed(1)}% of the per-frame cost`);

// ---------------------------------------------------------------------------
// The buffered (non-streaming) path, which is the same pattern over a whole
// response body rather than one frame.
// ---------------------------------------------------------------------------

/** One buffered Codex response: every frame above, joined into a single body. */
const body = frames.join("");

/** The previous buffered path: three independent parses of the same body. */
function oldBuffered() {
  let firstCompleted = null;
  for (const event of body.split(/\r?\n\r?\n/)) {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data: ") || line.slice(6) === "[DONE]") continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.type !== "response.completed") continue;
        const response = parsed.response;
        if (response && typeof response === "object") {
          firstCompleted = response;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (firstCompleted) break;
  }
  const toolCalls = countToolCallsFromSse(body);
  const parsed = rewriteResponseValue(responseTextFromSse(body), PUBLIC_MODEL);
  return JSON.stringify(parsed).length + toolCalls + (firstCompleted ? 1 : 0);
}

function newBuffered() {
  const summary = summarizeBufferedSse(body);
  const parsed = rewriteResponseValue(bufferedEnvelope(summary), PUBLIC_MODEL);
  return (
    JSON.stringify(parsed).length +
    summary.toolCalls +
    (summary.firstCompleted ? 1 : 0)
  );
}

if (oldBuffered() !== newBuffered())
  throw new Error(`buffered path differs: ${oldBuffered()} vs ${newBuffered()}`);
console.log(`buffered parity: identical result (${newBuffered()} bytes)`);

function benchBody(label, fn, iterations) {
  for (let index = 0; index < 300; index += 1) fn();
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) fn();
  return Number(process.hrtime.bigint() - started) / iterations / 1000;
}

console.log(`\nbuffered body: ${body.length} bytes, iterations: ${ITERATIONS}`);
const bufferedBefore = benchBody("old (3 parses of the body)", oldBuffered, ITERATIONS);
const bufferedAfter = benchBody("new (1 parse of the body)", newBuffered, ITERATIONS);
console.log(
  `\nbuffered:     ${bufferedBefore.toFixed(1)} us -> ${bufferedAfter.toFixed(1)} us  (${(bufferedBefore / bufferedAfter).toFixed(2)}x)`
);
console.log(`removed:      ${(100 * (1 - bufferedAfter / bufferedBefore)).toFixed(1)}% of the buffered cost`);
