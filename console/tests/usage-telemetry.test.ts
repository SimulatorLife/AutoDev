import assert from "node:assert/strict";
import test from "node:test";

import type { UsageFilterSelection } from "@simulatorlife/autodev-core";

import type { ConsoleUsageResult } from "../src/lib/server/openlit-usage.ts";

import {
  clearUsageTelemetryCacheForTests,
  readUsageTelemetry,
  USAGE_TELEMETRY_TTL_MS,
  usageTelemetryCacheKey
} from "../src/lib/server/usage-telemetry.ts";

const SELECTION: UsageFilterSelection = { range: "24H", values: {} };

/**
 * A read that answers with a snapshot the test can recognise.
 *
 * The Console's Usage reads are expensive because of the fan-out behind
 * them, so the thing under test here is how many times that fan-out is
 * asked for. A loader that counts its calls answers that question
 * directly.
 */
function countingLoader(
  calls: { count: number },
  kind: "ok" | "unreachable" = "ok"
): (selection: UsageFilterSelection) => Promise<ConsoleUsageResult> {
  return async () => {
    calls.count += 1;
    if (kind === "unreachable") return { kind: "unreachable" };
    return { kind: "ok", data: { marker: calls.count } as never };
  };
}

test("a second read inside the window is served from the cache", async () => {
  clearUsageTelemetryCacheForTests();
  const calls = { count: 0 };
  const load = countingLoader(calls);

  const first = await readUsageTelemetry(SELECTION, { load });
  const second = await readUsageTelemetry(SELECTION, { load });

  assert.equal(calls.count, 1, "the read happened once, not twice");
  assert.deepEqual(second, first, "the second caller got the first read's answer");
});

test("the window is five minutes", () => {
  assert.equal(USAGE_TELEMETRY_TTL_MS, 300_000);
});

test("two concurrent reads share one read", async () => {
  clearUsageTelemetryCacheForTests();
  const calls = { count: 0 };
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = async (
    selection: UsageFilterSelection
  ): Promise<ConsoleUsageResult> => {
    calls.count += 1;
    await gate;
    return { kind: "ok", data: { marker: calls.count } as never };
  };

  const both = Promise.all([
    readUsageTelemetry(SELECTION, { load }),
    readUsageTelemetry(SELECTION, { load })
  ]);
  release?.();
  const [first, second] = await both;

  assert.equal(
    calls.count,
    1,
    "the fan-out behind the read ran once for two concurrent callers"
  );
  assert.deepEqual(first, second);
});

test("an expired entry is read again", async () => {
  clearUsageTelemetryCacheForTests();
  const calls = { count: 0 };
  const load = countingLoader(calls);
  let clock = 1_000;
  const now = (): number => clock;

  await readUsageTelemetry(SELECTION, { load, now, ttlMs: 5_000 });
  clock = 4_000;
  await readUsageTelemetry(SELECTION, { load, now, ttlMs: 5_000 });
  assert.equal(calls.count, 1, "the entry is still inside its window");

  clock = 6_001;
  await readUsageTelemetry(SELECTION, { load, now, ttlMs: 5_000 });
  assert.equal(calls.count, 2, "the entry past its window was read again");
});

test("a failed read is not cached", async () => {
  clearUsageTelemetryCacheForTests();
  const calls = { count: 0 };
  const load = countingLoader(calls, "unreachable");

  const first = await readUsageTelemetry(SELECTION, { load });
  const second = await readUsageTelemetry(SELECTION, { load });

  assert.equal(first.kind, "unreachable");
  assert.equal(second.kind, "unreachable");
  assert.equal(
    calls.count,
    2,
    "the failure was not kept: a source that answers now must be read now"
  );
});

test("concurrent callers share one failed read", async () => {
  clearUsageTelemetryCacheForTests();
  const calls = { count: 0 };
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = async (): Promise<ConsoleUsageResult> => {
    calls.count += 1;
    await gate;
    return { kind: "unreachable" };
  };

  const both = Promise.all([
    readUsageTelemetry(SELECTION, { load }),
    readUsageTelemetry(SELECTION, { load })
  ]);
  release?.();
  const [first, second] = await both;

  assert.equal(calls.count, 1, "the failure was shared, not repeated");
  assert.equal(first.kind, "unreachable");
  assert.equal(second.kind, "unreachable");
});

test("the cache can be cleared for tests", async () => {
  clearUsageTelemetryCacheForTests();
  const calls = { count: 0 };
  const load = countingLoader(calls);

  await readUsageTelemetry(SELECTION, { load });
  clearUsageTelemetryCacheForTests();
  await readUsageTelemetry(SELECTION, { load });

  assert.equal(calls.count, 2, "the cleared entry was read again");
});

test("the cache key is the canonical form of the selection", () => {
  const one: UsageFilterSelection = {
    range: "7D",
    values: { provider: ["claude", "codex"] }
  };
  const other: UsageFilterSelection = {
    range: "7D",
    values: { provider: ["codex", "claude"] }
  };

  assert.equal(
    usageTelemetryCacheKey(one),
    usageTelemetryCacheKey(other),
    "the order of the values within one axis is not part of the question"
  );
  assert.notEqual(
    usageTelemetryCacheKey(one),
    usageTelemetryCacheKey({ range: "24H", values: { provider: ["claude", "codex"] } }),
    "a different window is a different question"
  );
  assert.notEqual(
    usageTelemetryCacheKey(one),
    usageTelemetryCacheKey({
      range: "7D",
      values: { provider: ["claude", "codex"], workspace: ["a/b"] }
    }),
    "a different axis is a different question"
  );
});

test("two different selections are read separately", async () => {
  clearUsageTelemetryCacheForTests();
  const calls = { count: 0 };
  const load = countingLoader(calls);

  await readUsageTelemetry(SELECTION, { load });
  await readUsageTelemetry(
    { range: "7D", values: { provider: ["claude"] } },
    { load }
  );

  assert.equal(calls.count, 2);
});
