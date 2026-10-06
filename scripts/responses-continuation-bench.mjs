// Micro-benchmark for awaitedToolResults, the per-request utility that turns a
// Responses request's trailing tool results into a resume map.
//
//   node scripts/responses-continuation-bench.mjs
//
// Runs the same call at three tail sizes. The old implementation built the tail
// with `unshift` in a reverse scan (quadratic in the tail length) and then
// allocated a second copy with `tail.slice(firstOutput)`, so the per-call cost
// grew with the square of the trailing run. The shape is realistic: a long
// conversation prefix followed by a run of tool outputs, which is what a turn
// with many parallel tool calls looks like.

import { awaitedToolResults } from "../runtime/src/shared/responses-continuation.ts";

function buildInput(tailOutputs, prefixPairs = 300) {
  const input = [];
  for (let index = 0; index < prefixPairs; index += 1) {
    input.push({ type: "reasoning", id: `reason-${index}` });
    input.push({
      type: "function_call",
      call_id: `call-${index}`,
      name: "exec"
    });
    input.push({
      type: "function_call_output",
      call_id: `call-${index}`,
      output: "done"
    });
  }
  for (let index = 0; index < tailOutputs; index += 1) {
    input.push({
      type: "function_call_output",
      call_id: `tail-${index}`,
      output: `result-${index}`
    });
  }
  return input;
}

const us = (ns) => (ns / 1000).toFixed(2);
console.log("tail   iters     us/call   outputs");
for (const [tail, iters] of [
  [250, 4000],
  [1000, 1500],
  [4000, 400]
]) {
  const input = buildInput(tail);
  // Warm the JIT and the constant sets before timing.
  for (let index = 0; index < 200; index += 1) awaitedToolResults(input);
  const started = process.hrtime.bigint();
  for (let index = 0; index < iters; index += 1) awaitedToolResults(input);
  const perCall = Number(process.hrtime.bigint() - started) / iters;
  const { outputs, messages } = awaitedToolResults(input);
  console.log(
    `${String(tail).padStart(4)} ${String(iters).padStart(7)} ${us(perCall).padStart(9)}   ${outputs.size} outputs, ${messages.length} messages`
  );
}
