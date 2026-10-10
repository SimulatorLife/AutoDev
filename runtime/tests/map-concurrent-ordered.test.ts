import assert from "node:assert/strict";
import test from "node:test";

import { mapConcurrentOrdered } from "../src/shared/map-concurrent-ordered.ts";

test("mapConcurrentOrdered bounds in-flight work and preserves input order", async () => {
  const active: number[] = [];
  let peak = 0;
  const result = await mapConcurrentOrdered(
    [0, 1, 2, 3, 4],
    2,
    async (item) => {
      active.push(item);
      peak = Math.max(peak, active.length);
      await new Promise((resolve) => setTimeout(resolve, (4 - item) * 2));
      active.splice(active.indexOf(item), 1);
      return item * 10;
    }
  );

  assert.equal(peak, 2);
  assert.deepEqual(result, [0, 10, 20, 30, 40]);
});

test("mapConcurrentOrdered drains a failed batch before propagating its first error", async () => {
  const started: number[] = [];
  let peerSettled = false;

  await assert.rejects(
    mapConcurrentOrdered([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        throw new Error("first ranked item failed");
      }
      if (item === 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        peerSettled = true;
      }
      return item;
    }),
    /first ranked item failed/u
  );

  assert.deepEqual(started, [0, 1]);
  assert.equal(peerSettled, true);
});

test("mapConcurrentOrdered refuses a non-positive or fractional concurrency", async () => {
  await assert.rejects(
    mapConcurrentOrdered([], 0, async () => 1),
    RangeError
  );
  await assert.rejects(
    mapConcurrentOrdered([], 1.5, async () => 1),
    RangeError
  );
});
