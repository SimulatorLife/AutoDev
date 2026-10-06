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
    safeMetricLabel("with\u0000null\u001Fcontrol"),
    "withnullcontrol"
  );
  assert.equal(safeMetricLabel("a".repeat(250)), "a".repeat(100));
});

test("safeMetricLabel falls back for values that are not usable labels", () => {
  assert.equal(safeMetricLabel(undefined), "unknown");
  assert.equal(safeMetricLabel(null), "unknown");
  assert.equal(safeMetricLabel(42), "unknown");
  assert.equal(safeMetricLabel({}), "unknown");
  assert.equal(safeMetricLabel("   "), "unknown");
  // A string made only of control characters survives the control-character
  // strip as empty, so it must take the fallback rather than emit "".
  assert.equal(safeMetricLabel("\u0000\u001F"), "unknown");
  assert.equal(safeMetricLabel("\u0000\u001F", ""), "");
  assert.equal(safeMetricLabel(undefined, "unattributed"), "unattributed");
});

test("safeMetricLabel is exported by the router barrel", async () => {
  const router = await import("@simulatorlife/autodev-runtime/router");
  assert.equal(router.safeMetricLabel, safeMetricLabel);
});

test("the router has one owner for safeMetricLabel", () => {
  const routerSources = [
    "runtime/src/router/subagents.ts",
    "runtime/src/router/usage.ts",
    "runtime/src/router/otel.ts",
    "runtime/src/router/http.ts",
    "runtime/src/router/state-collector.ts",
    "runtime/src/router/index.ts"
  ];
  const read = (relativePath: string): string =>
    readFileSync(join(repositoryRoot, relativePath), "utf8");

  // No router module may define the helper; `metric-label.ts` owns it.
  const definitions = routerSources.filter((relativePath) =>
    /export function safeMetricLabel\b/.test(read(relativePath))
  );
  assert.deepEqual(definitions, []);

  // No router module may reach it through the subagent registry. Walk the
  // binding lists that precede each `from "./subagents.ts"` instead of
  // scanning the file text, because `http.ts` and the barrel legitimately
  // import other things from `subagents.ts`.
  const misplaced: string[] = [];
  for (const relativePath of routerSources) {
    const source = read(relativePath);
    const specifier = 'from "./subagents.ts"';
    let at = source.indexOf(specifier);
    while (at !== -1) {
      const open = source.lastIndexOf("{", at);
      const close = source.lastIndexOf("}", at);
      if (open !== -1 && close > open) {
        const bindings = source
          .slice(open + 1, close)
          .split(",")
          .map((binding) => binding.replace(/^\s*type\s+/, "").trim())
          .filter(Boolean);
        if (bindings.includes("safeMetricLabel")) misplaced.push(relativePath);
      }
      at = source.indexOf(specifier, at + specifier.length);
    }
  }
  assert.deepEqual(misplaced, []);
});
