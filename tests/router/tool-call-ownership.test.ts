import assert from "node:assert/strict";
import test from "node:test";

import { collectToolCallIds } from "../../src/router/responses.ts";
import {
  awaitedCallIds,
  ToolCallOwnership
} from "../../src/router/tool-call-ownership.ts";

// Recorded in the 2026-09-18 incident: one worker turn hopped antigravity ->
// minimax -> claude between requests, so the provider that ran the step was
// never the one that received its results.

test("the tool results ending the input name the calls a request is answering", () => {
  const payload = {
    input: [
      {
        type: "custom_tool_call_output",
        call_id: "call_old",
        output: "settled earlier"
      },
      { type: "message", role: "assistant", content: [] },
      { type: "custom_tool_call", call_id: "call_a", name: "exec", input: "" },
      {
        type: "function_call",
        call_id: "call_b",
        name: "wait",
        arguments: "{}"
      },
      { type: "custom_tool_call_output", call_id: "call_a", output: "x" },
      { type: "function_call_output", call_id: "call_b", output: "y" }
    ]
  };
  assert.deepEqual(awaitedCallIds(payload).sort(), ["call_a", "call_b"]);
  assert.deepEqual(
    awaitedCallIds({
      input: [{ type: "message", role: "user", content: "new turn" }]
    }),
    []
  );
  // A notification Codex appends after the output keeps the results awaited.
  const notified = {
    input: [
      ...payload.input,
      {
        type: "message",
        role: "user",
        content: "<subagent_notification>{}</subagent_notification>"
      }
    ]
  };
  assert.deepEqual(awaitedCallIds(notified).sort(), ["call_a", "call_b"]);
  assert.deepEqual(awaitedCallIds(null), []);
});

test("the provider that issued a call owns its result", () => {
  const ownership = new ToolCallOwnership();
  ownership.record(["call_a"], "claude");
  ownership.record(["call_z"], "minimax");
  assert.equal(
    ownership.ownerFor({
      input: [
        { type: "custom_tool_call_output", call_id: "call_a", output: "" }
      ]
    }),
    "claude"
  );
  assert.equal(
    ownership.ownerFor({
      input: [
        { type: "function_call_output", call_id: "call_unknown", output: "" }
      ]
    }),
    null
  );
  assert.equal(
    ownership.ownerFor({
      input: [{ type: "message", role: "user", content: "hi" }]
    }),
    null
  );
});

test("ownership is bounded, oldest calls first", () => {
  const ownership = new ToolCallOwnership(2);
  ownership.record(["call_1", "call_2", "call_3"], "claude");
  const answering = (callId: string) => ({
    input: [{ type: "custom_tool_call_output", call_id: callId, output: "" }]
  });
  assert.equal(ownership.ownerFor(answering("call_1")), null);
  assert.equal(ownership.ownerFor(answering("call_3")), "claude");
});

test("call ids are collected from streamed items and from completed responses", () => {
  const ids = new Set<string>();
  collectToolCallIds(
    {
      type: "custom_tool_call",
      id: "ctc_1",
      call_id: "call_a",
      name: "exec",
      input: ""
    },
    ids
  );
  collectToolCallIds(
    {
      output: [
        { type: "message", id: "msg_1", content: [] },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_b",
          name: "wait",
          arguments: "{}"
        }
      ]
    },
    ids
  );
  collectToolCallIds({ type: "reasoning", id: "rs_1" }, ids);
  assert.deepEqual([...ids].sort(), ["call_a", "call_b"]);
});
