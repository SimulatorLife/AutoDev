import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ROUTING_POLICY as routing } from "../src/router/routing.ts";
import { payloadForCandidate } from "../src/router/proxy.ts";

type JsonRecord = Record<string, any>;

const contract = await import("./fixtures/contracts/root-subagent-provider-selection.json", { with: { type: "json" } }).then((m) => (m.default ?? m) as JsonRecord);

assert.equal(contract.schema, "autodev-root-subagent-provider-selection-v1");

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seeded = (): () => number => mulberry32(Number.parseInt(String(contract.seed), 16));
const shape = (candidate: JsonRecord): JsonRecord => ({ provider: candidate.provider, model: candidate.model, ...("reasoningEffort" in candidate ? { reasoningEffort: candidate.reasoningEffort } : {}) });

describe("root versus subagent provider selection", () => {
  test("keeps the root alias distinct from every leaf alias", () => {
    assert.equal(routing.roleForModel(contract.aliases.orchestrator.model), contract.aliases.orchestrator.roleForModel);
    for (const [role, alias] of Object.entries(contract.aliases.subagents)) assert.equal(routing.roleForModel(alias), role);
    for (const model of contract.aliases.nonAliases.concreteModels) assert.equal(routing.roleForModel(model), null);
    for (const model of contract.aliases.nonAliases.unknownModels) assert.equal(routing.roleForModel(model), null);
  });

  test("freezes seeded leaf membership, models, and ordering", () => {
    for (const role of ["default", "smart"]) {
      assert.deepEqual(routing.roleCandidates(role, seeded()).map(shape), contract.subagentCandidates[role]);
      assert.deepEqual(new Set(routing.roleCandidates(role, seeded()).map(({ provider }) => provider)), new Set(contract.tiers[role]));
    }
    for (const role of ["docs-researcher", "browser-tester", "explorer", "worker", "validator"]) {
      assert.deepEqual(routing.roleCandidates(role, seeded()).map(shape), contract.subagentCandidates.default);
    }
  });

  test("freezes root fallback reasoning and preferred continuation ordering", () => {
    assert.deepEqual(routing.orchestratorCandidates(seeded()).map(shape), contract.orchestratorCandidates.unpreferred);
    for (const [provider, expected] of Object.entries(contract.orchestratorCandidates.preferred)) {
      assert.deepEqual(routing.orchestratorCandidates(seeded(), provider).map(shape), expected);
    }
    assert.deepEqual(new Set(routing.orchestratorCandidates(seeded(), "claude").map(({ provider }) => provider)), new Set(contract.tiers.orchestrator));
    assert.deepEqual(routing.orchestratorCandidates(seeded(), "unknown").map(shape), contract.orchestratorCandidates.unpreferred);
  });

  test("freezes root-only fallback reasoning overrides and leaf effort preservation", () => {
    const root = routing.orchestratorCandidates(seeded());
    assert.deepEqual(payloadForCandidate({ model: "autodev/orchestrator", reasoning: { effort: "xhigh" } }, root[0]!), contract.payloads.orchestratorPrimary);
    assert.deepEqual(payloadForCandidate({ model: "autodev/orchestrator", reasoning: { effort: "xhigh" } }, root.at(-1)!), contract.payloads.orchestratorFallback);
    assert.deepEqual(payloadForCandidate({ model: "autodev/explorer", reasoning: { effort: "xhigh" } }, routing.roleCandidates("explorer", seeded())[0]!), contract.payloads.subagent);
  });
});
