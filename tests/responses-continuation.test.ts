import assert from "node:assert/strict";
import test from "node:test";

import { awaitedToolResults } from "../src/shared/responses-continuation.ts";

const call = (callId: string) => ({ type: "custom_tool_call", call_id: callId, name: "exec", input: "" });
const output = (callId: string, value = "ok") => ({ type: "custom_tool_call_output", call_id: callId, output: value });
const user = (text: string) => ({ type: "message", role: "user", content: [ { type: "input_text", text } ] });

test("outputs at the end of the input are the awaited results", () => {
  const { outputs, messages } = awaitedToolResults([ user("go"), call("a"), call("b"), output("a", "x"), output("b", "y") ]);
  assert.deepEqual([ ...outputs ], [ [ "a", "x" ], [ "b", "y" ] ]);
  assert.deepEqual(messages, []);
});

test("messages Codex appends after the outputs do not hide them", () => {
  // Codex 0.154.0: a wait_agent output followed by the child's notification.
  const notification = user("<subagent_notification>{\"status\":{\"completed\":\"done\"}}</subagent_notification>");
  const steer = { type: "message", role: "developer", content: [ { type: "input_text", text: "steer" } ] };
  const { outputs, messages } = awaitedToolResults([ user("go"), call("a"), output("a"), notification, steer ]);
  assert.deepEqual([ ...outputs.keys() ], [ "a" ]);
  assert.deepEqual(messages, [ notification, steer ]);
});

test("a new user turn after the model's reply awaits nothing", () => {
  const input = [ user("go"), call("a"), output("a"), { type: "message", role: "assistant", content: [ { type: "output_text", text: "done" } ] }, user("next") ];
  assert.equal(awaitedToolResults(input).outputs.size, 0);
  assert.equal(awaitedToolResults([ user("hello") ]).outputs.size, 0);
  assert.equal(awaitedToolResults("plain text").outputs.size, 0);
});

test("an output before the model's latest call answered an earlier step", () => {
  const { outputs } = awaitedToolResults([ call("a"), output("a"), call("b") ]);
  assert.equal(outputs.size, 0);
});
