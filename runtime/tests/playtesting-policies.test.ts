import assert from "node:assert/strict";
import test from "node:test";

import { PlaytestLoopGuard } from "../src/playtesting/loop-guard.ts";
import {
  createScoredPlaytestPolicy,
  createSeededRandomPlaytestPolicy
} from "../src/playtesting/policies.ts";

const visible = {
  goal: "reach exit",
  visibleState: { room: "hall", inventory: { key: true, coin: 2 } },
  legalActionIds: ["open", "wait"]
} as const;

test("Jev loop guard catches repeated visible state/action pairs", () => {
  const guard = new PlaytestLoopGuard("reach exit", {
    window: 4,
    maxRepeats: 3
  });
  assert.equal(guard.inspect(visible, "wait").loop, false);
  assert.equal(guard.inspect(visible, "wait").loop, false);
  const repeated = guard.inspect(visible, "wait");
  assert.equal(repeated.loop, true);
  assert.match(repeated.observationHash, /^[a-f0-9]{16}$/u);
  assert.equal(repeated.signature, repeated.observationHash + ":wait");
});

test("loop hashing ignores object insertion order but changes on visible state/action changes", () => {
  const guard = new PlaytestLoopGuard("reach exit", {
    window: 4,
    maxRepeats: 2
  });
  const reversed = {
    goal: "reach exit",
    visibleState: { inventory: { coin: 2, key: true }, room: "hall" },
    legalActionIds: ["open", "wait"]
  } as const;
  assert.equal(guard.inspect(visible, "open").loop, false);
  assert.equal(guard.inspect(reversed, "open").loop, true);
  assert.equal(
    guard.inspect({ ...visible, visibleState: { room: "exit" } }, "open").loop,
    false
  );
});

test("generic loop guard does not inherit Jev's hosted choice limit", () => {
  const legalActionIds = Array.from({ length: 256 }, (_, index) => `a${index}`);
  const guard = new PlaytestLoopGuard("inspect", { window: 2, maxRepeats: 2 });
  const observation = { ...visible, goal: "inspect", legalActionIds };
  assert.equal(guard.inspect(observation, "a255").loop, false);
  assert.equal(guard.inspect(observation, "a255").loop, true);
});

test("loop guard rejects illegal action ids and invalid guard bounds", () => {
  const guard = new PlaytestLoopGuard("reach exit");
  assert.throws(() => guard.inspect(visible, "hack"), /currently legal/u);
  assert.throws(
    () => new PlaytestLoopGuard("reach exit", { window: 1, maxRepeats: 2 }),
    /window size/u
  );
});

test("seeded random policy is deterministic and selects only offered legal actions", async () => {
  const policy = createSeededRandomPlaytestPolicy();
  const context = {
    seed: "s-42",
    episodeId: "e-1",
    step: 7,
    observation: { room: "hall" },
    legalActionIds: ["left", "right", "wait"]
  } as const;
  const first = await policy.chooseAction(context);
  assert.deepEqual(await policy.chooseAction(context), first);
  assert.ok(new Set<string>(context.legalActionIds).has(first.actionId));
  assert.equal(first.prediction, null);
  assert.notEqual(
    (await policy.chooseAction({ ...context, step: 8 })).actionId,
    first.actionId
  );
});

test("random policy rejects missing seed/episode and malformed legal actions", async () => {
  const policy = createSeededRandomPlaytestPolicy();
  const context = {
    seed: "",
    episodeId: "e-1",
    step: 0,
    observation: null,
    legalActionIds: ["a"]
  } as const;
  await assert.rejects(async () => {
    await policy.chooseAction(context);
  }, /requires a seed/u);
  await assert.rejects(async () => {
    await policy.chooseAction({
      ...context,
      seed: "seed",
      legalActionIds: ["a", "a"]
    });
  }, /unique/u);
});

test("target-owned scored policy has deterministic ties and rejects non-finite scores", async () => {
  const policy = createScoredPlaytestPolicy({
    id: "fixture-heuristic",
    version: "1",
    cohort: "intermediate",
    strategy: "prefer-advance",
    score: (_context, _actionId) => 1
  });
  assert.equal(
    (
      await policy.chooseAction({
        seed: "seed",
        episodeId: "e-1",
        step: 0,
        observation: null,
        legalActionIds: ["z", "a"]
      })
    ).actionId,
    "a"
  );
  const invalid = createScoredPlaytestPolicy({
    id: "bad",
    version: "1",
    cohort: "fixture",
    strategy: "bad",
    score: () => Number.NaN
  });
  await assert.rejects(async () => {
    await invalid.chooseAction({
      seed: "seed",
      episodeId: "e-1",
      step: 0,
      observation: null,
      legalActionIds: ["a"]
    });
  }, /finite/u);
});
