import assert from "node:assert/strict";
import test from "node:test";

import { PlaytestLoopGuard } from "../src/playtesting/loop-guard.ts";
import { resolvePolicy } from "../src/playtesting/mcp.ts";
import {
  createBuiltinPlaytestPolicy,
  createFirstLegalPlaytestPolicy,
  createScoredPlaytestPolicy,
  createSeededRandomPlaytestPolicy,
  type PlaytestPolicyContext,
  PLAYTESTS_BUILTIN_POLICY_IDS
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

test("first-legal policy is a second independent arm that never consults the seed", async () => {
  const policy = createFirstLegalPlaytestPolicy();
  assert.equal(policy.id, "first-legal");
  assert.equal(policy.modelId, null);
  const context = {
    seed: "seed-a",
    episodeId: "episode-1",
    step: 0,
    observation: {},
    legalActionIds: ["zulu", "alpha", "mike"]
  } as PlaytestPolicyContext;
  // The point of the arm: a decision that cannot move when the seed, the step
  // or the scheduling order changes, so an improvement is the heuristic's
  // rather than the run's luck.
  assert.equal((await policy.chooseAction(context)).actionId, "alpha");
  assert.equal(
    (await policy.chooseAction({ ...context, seed: "seed-b", step: 99 }))
      .actionId,
    "alpha"
  );
  assert.equal(
    (
      await policy.chooseAction({
        ...context,
        legalActionIds: ["mike", "alpha"]
      })
    ).actionId,
    "alpha"
  );
});

test("first-legal rejects malformed legal actions rather than choosing one", () => {
  const policy = createFirstLegalPlaytestPolicy();
  const base = {
    seed: "s",
    episodeId: "e",
    step: 0,
    observation: {}
  };
  assert.throws(
    () =>
      policy.chooseAction({
        ...base,
        legalActionIds: []
      } as PlaytestPolicyContext),
    /unique, non-empty/u
  );
  assert.throws(
    () =>
      policy.chooseAction({
        ...base,
        legalActionIds: ["a", "a"]
      } as PlaytestPolicyContext),
    /unique, non-empty/u
  );
});

test("the built-in registry is the single owner of runnable policies", () => {
  // Every id the registry advertises must actually construct, or a game could
  // declare a policy the runner refuses.
  for (const id of PLAYTESTS_BUILTIN_POLICY_IDS) {
    assert.notEqual(
      createBuiltinPlaytestPolicy(id),
      null,
      `${id} is advertised but cannot be constructed`
    );
  }
  // And anything outside it is refused by construction, not by an ad-hoc branch
  // at the call site.
  assert.equal(createBuiltinPlaytestPolicy("not-a-policy"), null);
  // Two independent policies, which is what a comparison arm requires.
  assert.ok(PLAYTESTS_BUILTIN_POLICY_IDS.size >= 2);
});

test("every advertised policy resolves through the runner's own gate", () => {
  // `createFirstLegalPlaytestPolicy` being correct does not prove a batch can
  // use it: the runner resolves policies through its own gate, and a scored
  // policy once sat unused behind a single-entry gate with passing tests. This
  // drives that gate, not the factory.
  for (const id of PLAYTESTS_BUILTIN_POLICY_IDS) {
    const resolved = resolvePolicy(id);
    assert.equal(resolved.id, id);
    assert.ok(resolved.version.trim(), `${id} must report a version`);
  }
  // An id outside the registry is refused by name, with the runnable set named.
  assert.throws(() => resolvePolicy("heuristic-v1"), /first-legal/u);
});
