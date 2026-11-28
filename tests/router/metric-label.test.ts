import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { safeMetricLabel } from "@simulatorlife/autodev-runtime/router/metric-label";

const repositoryRoot = join(import.meta.dirname, "..", "..");

test("safeMetricLabel bounds and sanitises dimension labels", () => {
  assert.equal(safeMetricLabel("gpt-5"), "gpt-5");
  assert.equal(safeMetricLabel("  spaced  "), "spaced");
  assert.equal(
    safeMetricLabel("with\0null\u{1F}control"),
    "withnullcontrol"
  );
  assert.equal(safeMetricLabel("a".repeat(250)), "a".repeat(100));
});

test("safeMetricLabel falls back for values that are not usable labels", () => {
  assert.equal(safeMetricLabel(undefined), "unknown");
  assert.equal(safeMetricLabel(null), "unknown");
  assert.equal(safeMetricLabel(42), "unknown");
  assert.equal(safeMetricLabel({}), "unknown");
  assert.equal(safeMetricLabel(' '.repeat(3)), "unknown");
  // A string made only of control characters survives the control-character
  // strip as empty, so it must take the fallback rather than emit "".
  assert.equal(safeMetricLabel("\0\u{1F}"), "unknown");
  assert.equal(safeMetricLabel("\0\u{1F}", ""), "");
  assert.equal(safeMetricLabel(undefined, "unattributed"), "unattributed");
});

test("safeMetricLabel is exported by the router barrel", async () => {
  const router = await import("@simulatorlife/autodev-runtime/router");
  assert.equal(router.safeMetricLabel, safeMetricLabel);
});

test("the router has one owner for safeMetricLabel", () => {
  const routerSources = [
    "runtime/src/router/execution-contract.ts",
    "runtime/src/router/usage.ts",
    "runtime/src/router/http.ts",
    "runtime/src/router/index.ts"
  ];
  const read = (relativePath: string): string =>
    readFileSync(join(repositoryRoot, relativePath), "utf8");

  // No router module may define the helper; `metric-label.ts` owns it.
  const definitions = routerSources.filter((relativePath) =>
    /export function safeMetricLabel\b/.test(read(relativePath))
  );
  assert.deepEqual(definitions, []);
});
