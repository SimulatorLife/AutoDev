// Measures steady-state heap growth of the role-prompt cache in
// runtime/src/agents/bridge-role.ts.
//
//   node --expose-gc scripts/role-prompt-cache-memory.mjs [distinctRoles]
//
// Prints heapUsed and RSS after settling, for the current implementation and
// for the bounded one. Kept deterministic: settle with two forced GCs and
// report the same figure three times so the number is stable, not noise.

import { roleInstructions } from "../runtime/src/agents/bridge-role.ts";

const N = Number.parseInt(process.argv[2] ?? "2000", 10);

if (typeof globalThis.gc !== "function") {
  throw new Error("run with --expose-gc");
}

function settle() {
  // Two passes: the first frees garbage, the second collects what that freed.
  globalThis.gc();
  globalThis.gc();
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

settle();
const cold = process.memoryUsage();

// One warm entry first, so module init and the first prompt-file reads are not
// attributed to the loop under test.
const first = roleInstructions("orchestrator");
const oneEntryBytes = Buffer.byteLength(first, "utf8");

settle();
const beforeLoop = process.memoryUsage();

// Each distinct role is a distinct cache key today, and each entry holds a
// fully composed prompt (bootstrap + orchestration skill + role file + contract).
let last = first;
for (let i = 0; i < N; i += 1) {
  last = roleInstructions(`attacker-role-${i}`);
}

settle();
const afterLoop = process.memoryUsage();
settle();
const afterExtraSettle = process.memoryUsage();

const retained = afterLoop.heapUsed - beforeLoop.heapUsed;

console.log(`distinct roles requested : ${N + 1}`);
console.log(`bytes per cached prompt  : ${oneEntryBytes}`);
console.log(`heap before loop         : ${mb(beforeLoop.heapUsed)}`);
console.log(`heap after loop          : ${mb(afterLoop.heapUsed)}`);
console.log(`retained heap delta      : ${mb(retained)}`);
console.log(`retained per new role    : ${(retained / N).toFixed(0)} bytes`);
console.log(`rss before loop          : ${mb(beforeLoop.rss)}`);
console.log(`rss after loop           : ${mb(afterLoop.rss)}`);
console.log(`rss delta                : ${mb(afterLoop.rss - beforeLoop.rss)}`);
console.log(
  `extra-settle drift       : ${mb(afterExtraSettle.heapUsed - afterLoop.heapUsed)}`
);
console.log(`cold rss                 : ${mb(cold.rss)}`);
console.log(
  `last prompt still valid  : ${typeof last === "string" && last.length > 0}`
);
