import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const MEMORY_ROUTES = path.join(
  import.meta.dirname,
  "..",
  "src",
  "control-api",
  "memory.ts"
);

const CONTRACT_TYPES = [
  "ControlApiMemoryRecordsResponse",
  "ControlApiMemoryExperiencesResponse",
  "ControlApiMemoryHistoryResponse",
  "ControlApiMemoryWhyResponse",
  "ControlApiMemoryRecordDetailResponse",
  "ControlApiMemoryStatusResponse",
  "ControlApiMemoryInjectionOutcomesResponse",
  "ControlApiMemoryInjectionUseAssessmentsResponse",
  // The three cohort pages were the last memory responses still sent raw. They
  // happened to conform; nothing had said so, which is the same position the
  // history route was in before it turned out not to conform.
  "ControlApiMemoryCohortsResponse",
  "ControlApiMemoryUseCohortsResponse",
  "MemoryInjectionOutcomeCohortPage"
];

test("every declared memory response is checked against its own route payload", () => {
  // The `/history` route answered with the repository's `{ events }` while the
  // contract declared `transitions`, and nothing in the build noticed: the
  // payload was spread into `sendJson(body: unknown)`, so the route and the
  // contract were free to disagree and the Console discovered it in production.
  //
  // A `satisfies` clause turns that disagreement into a compile error. The
  // clause only helps if it is actually there, so this asserts each declared
  // response type is used at its route rather than trusting that someone added
  // them all.
  const source = readFileSync(MEMORY_ROUTES, "utf8");
  for (const type of CONTRACT_TYPES) {
    assert.ok(
      source.includes(`satisfies ${type}`),
      `${type} is declared in Core but no route payload is checked against it`
    );
  }
});

test("the memory routes do not spread a service result onto the wire unchecked", () => {
  // `sendJson` accepts `unknown`, so an unannotated payload compiles whatever
  // it contains. Each of these spreads a service result; every one of them must
  // sit inside a `satisfies` clause or the check above is decoration.
  const source = readFileSync(MEMORY_ROUTES, "utf8");
  const spreads = [
    "...result },",
    "...page },",
    "memory } satisfies",
    "history.events",
    "why.sourceExperiences",
    "status.probeTimeoutMs"
  ];
  for (const spread of spreads) {
    const at = source.indexOf(spread);
    if (at === -1) continue;
    const window = source.slice(Math.max(0, at - 400), at + 400);
    assert.ok(
      window.includes("satisfies ControlApiMemory"),
      `a memory route payload spreading \`${spread}\` is not checked against a declared contract`
    );
  }
});
