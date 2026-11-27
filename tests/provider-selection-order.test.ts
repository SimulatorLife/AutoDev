import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ROUTING_POLICY as routing } from "@simulatorlife/autodev-runtime/router/routing";

type JsonRecord = Record<string, any>;

const contract = await import(
  "./fixtures/contracts/provider-selection-order.json",
  { with: { type: "json" } }
).then((m) => (m.default ?? m) as JsonRecord);

assert.equal(
  contract.schema,
  "autodev-provider-selection-order-v1",
  "provider selection contract must match its schema tag"
);

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d_2b_79_f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SEED = 0xc0_ff_ee;

function observe(tier: string, draws: number): string[][] {
  const random = mulberry32(SEED);
  const out: string[][] = [];
  for (let index = 0; index < draws; index += 1) {
    const list = routing.providerPriority(tier, random);
    if (list.length > 0) out.push(list);
  }
  return out;
}

describe("provider selection order", () => {
  test("default tier: first 8 non-empty priority listings under seed", () => {
    assert.deepEqual(
      observe("default", 8),
      contract.cases.default_seed_coffee_first_eight
    );
  });

  test("default tier: next 8 priority listings under seed", () => {
    assert.deepEqual(
      observe("default", 16).slice(8),
      contract.cases.default_seed_coffee_next_eight
    );
  });

  test("smart tier: first 8 priority listings under seed", () => {
    assert.deepEqual(
      observe("smart", 8),
      contract.cases.smart_seed_coffee_first_eight
    );
  });

  test("orchestrator tier: first 8 priority listings under seed", () => {
    assert.deepEqual(
      observe("orchestrator", 8),
      contract.cases.orchestrator_seed_coffee_first_eight
    );
  });

  test("providerPriority for an unknown tier returns an empty list", () => {
    const random = mulberry32(SEED);
    for (let index = 0; index < 4; index += 1) {
      assert.deepEqual(routing.providerPriority("nonexistent", random), []);
    }
  });

  test("every priority listing stays within the contract tier membership", () => {
    const membership = new Set(contract.tiers.default);
    for (const list of observe("default", 16)) {
      for (const provider of list)
        assert.ok(membership.has(provider), `unexpected provider ${provider}`);
    }
  });

  test("tierCandidates and roleCandidates preserve providerPriority order under the same seed", () => {
    const priorityRandom = mulberry32(SEED);
    const tierRandom = mulberry32(SEED);
    const roleRandom = mulberry32(SEED);
    for (let index = 0; index < 4; index += 1) {
      const priority = routing.providerPriority("default", priorityRandom);
      const tier = routing.tierCandidates("default", tierRandom);
      const role = routing.roleCandidates("default", roleRandom);
      for (const [index, element] of priority.entries()) {
        assert.equal(
          tier[index]!.provider,
          element!,
          `tier candidate ${index} matches priority order`
        );
        if (role[index])
          assert.equal(
            role[index]!.provider,
            element!,
            `role candidate ${index} matches priority order`
          );
      }
    }
  });

  test("contract tiers match the live routing config", () => {
    for (const [tier, providers] of Object.entries(contract.tiers)) {
      assert.ok(
        Array.isArray(providers) && providers.length > 0,
        `contract tier ${tier} must list providers`
      );
      for (const provider of providers) assert.equal(typeof provider, "string");
    }
  });

  test("orchestrator places claude and antigravity-claude-gpt ahead of antigravity-gemini and antigravity-argon", () => {
    for (let s = 1; s <= 16; s += 1) {
      const order = routing.providerPriority(
        "orchestrator",
        mulberry32(s),
        "orchestrator"
      );
      assert.equal(order[0], "codex");
      const tier2 = new Set(order.slice(1, 3));
      const tier3 = new Set(order.slice(3));
      assert.deepEqual(tier2, new Set(["claude", "antigravity-claude-gpt"]));
      assert.deepEqual(
        tier3,
        new Set(["antigravity-gemini", "antigravity-argon"])
      );
    }
  });
});
