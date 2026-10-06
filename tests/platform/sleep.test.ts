import assert from "node:assert/strict";
import test from "node:test";

import { sleep } from "@simulatorlife/autodev-runtime/platform/sleep";

test("sleep resolves only after the requested delay", async () => {
  const started = Date.now();
  await sleep(40);
  assert.ok(
    Date.now() - started >= 30,
    "sleep must actually wait rather than resolve immediately"
  );
});

test("sleep resolves with no value, so it satisfies the deps `sleep` contract", async () => {
  const asDepsMember: (ms: number) => Promise<void> = sleep;
  assert.equal(await asDepsMember(1), undefined);
});

test("a zero delay still resolves rather than hanging the readiness wait", async () => {
  const outcome = await Promise.race([
    sleep(0).then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000))
  ]);
  assert.equal(outcome, "resolved");
});
