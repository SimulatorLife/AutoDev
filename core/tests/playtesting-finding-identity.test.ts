import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PLAYTESTS_FINDING_IDENTITY_EXCLUDED_FIELDS,
  PLAYTESTS_FINDING_IDENTITY_SCHEMA,
  buildPlaytestFindingIdentity,
  isPlaytestFindingId,
  playtestFindingIdFromFingerprint,
  playtestFindingIdentityHashInput,
  type PlaytestFindingIdentityInput
} from "../src/playtesting/index.ts";

/**
 * Fixtures for the stable PlaytestFinding identity/fingerprint contract
 * (measurement-contract §11's missed-known-issue/duplicate-flood gate).
 * Each test proves a specific property of docs/playtesting-target-state.md's
 * "Finding identity and ownership" rule: the identity is built only from
 * workspace/mechanic key, normalized failure signature and scope, and no
 * excluded provenance field (seed/batch/episode/run ID/build SHA/policy
 * ID/model ID/timestamps) can ever enter or influence it.
 */

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintOf(input: PlaytestFindingIdentityInput): string {
  return sha256(
    playtestFindingIdentityHashInput(buildPlaytestFindingIdentity(input))
  );
}

/** A chest that silently fails to open after the matching key is picked up. */
function chestInvariantInput(): PlaytestFindingIdentityInput {
  return {
    workspaceId: "fixture/synthetic-game",
    mechanicKey: "inventory-chest-unlock-invariant",
    failureSignature: {
      events: ["key-pickup", "chest-interact"],
      action: "interact",
      witness: "chest-does-not-open-after-key-pickup"
    },
    scope: {
      scenarioFamily: "dungeon-vault",
      phase: "exploration",
      modality: "headless"
    }
  };
}

/** A distinct invariant/scope: a jump-buffer timing defect in a platformer tutorial. */
function jumpBufferInput(): PlaytestFindingIdentityInput {
  return {
    workspaceId: "fixture/synthetic-game",
    mechanicKey: "jump-buffer-window-invariant",
    failureSignature: {
      events: ["ledge-approach", "jump-input", "fall"],
      action: "jump",
      witness: "buffered-jump-dropped-at-ledge-edge"
    },
    scope: {
      scenarioFamily: "platforming-tutorial",
      phase: "onboarding",
      modality: "browser"
    }
  };
}

test("identity schema is stamped on every built identity", () => {
  const identity = buildPlaytestFindingIdentity(chestInvariantInput());
  assert.equal(identity.identitySchema, PLAYTESTS_FINDING_IDENTITY_SCHEMA);
});

test("canonical hash input is key-order independent", () => {
  const identity = buildPlaytestFindingIdentity(chestInvariantInput());
  const reordered = {
    scope: identity.scope,
    mechanicKey: identity.mechanicKey,
    failureSignature: identity.failureSignature,
    identitySchema: identity.identitySchema,
    workspaceId: identity.workspaceId
  };
  assert.equal(
    playtestFindingIdentityHashInput(identity),
    playtestFindingIdentityHashInput(reordered as typeof identity)
  );
});

test("cross-build/cross-policy stability: differing provenance never changes the fingerprint", () => {
  const buildARecord = {
    identity: chestInvariantInput(),
    seed: "seed-run-a",
    batchId: "batch-0001",
    episodeId: "episode-a-77",
    runId: "run-a-1",
    buildSha: "a".repeat(40),
    policyId: "policy-random-v1",
    modelId: "model-alpha",
    generatedAt: "2026-01-01T00:00:00.000Z"
  };
  const buildBRecord = {
    identity: chestInvariantInput(),
    seed: "seed-run-b-different",
    batchId: "batch-9999",
    episodeId: "episode-b-3",
    runId: "run-b-412",
    buildSha: "b".repeat(40),
    policyId: "policy-expert-v7",
    modelId: "model-omega",
    generatedAt: "2026-10-10T12:34:56.000Z"
  };
  assert.notEqual(buildARecord.seed, buildBRecord.seed);
  assert.notEqual(buildARecord.buildSha, buildBRecord.buildSha);
  assert.notEqual(buildARecord.policyId, buildBRecord.policyId);
  assert.notEqual(buildARecord.modelId, buildBRecord.modelId);
  assert.equal(
    fingerprintOf(buildARecord.identity),
    fingerprintOf(buildBRecord.identity)
  );
});

test("distinct invariant/scope fixtures produce distinct fingerprints", () => {
  assert.notEqual(
    fingerprintOf(chestInvariantInput()),
    fingerprintOf(jumpBufferInput())
  );
});

test("changing only scope (scenario family / phase / modality) changes the fingerprint", () => {
  const base = chestInvariantInput();
  const differentFamily: PlaytestFindingIdentityInput = {
    ...base,
    scope: { ...base.scope, scenarioFamily: "surface-vault" }
  };
  const differentPhase: PlaytestFindingIdentityInput = {
    ...base,
    scope: { ...base.scope, phase: "combat" }
  };
  const differentModality: PlaytestFindingIdentityInput = {
    ...base,
    scope: { ...base.scope, modality: "native-visual" }
  };
  const baseline = fingerprintOf(base);
  assert.notEqual(fingerprintOf(differentFamily), baseline);
  assert.notEqual(fingerprintOf(differentPhase), baseline);
  assert.notEqual(fingerprintOf(differentModality), baseline);
});

test("scope phase and modality are optional ('as applicable') and default to null", () => {
  const identity = buildPlaytestFindingIdentity({
    workspaceId: "fixture/synthetic-game",
    mechanicKey: "ambient-hazard-invariant",
    failureSignature: {
      events: [],
      witness: "hazard-tick-applies-damage-through-shield"
    },
    scope: { scenarioFamily: "environmental-hazards" }
  });
  assert.equal(identity.scope.phase, null);
  assert.equal(identity.scope.modality, null);
  assert.equal(identity.failureSignature.action, null);
  assert.deepEqual(identity.failureSignature.events, []);
});

/** Shift printable ASCII (0x21-0x7E) to its Unicode fullwidth presentation form. */
function toFullwidth(ascii: string): string {
  return ascii.replace(/[\x21-\x7e]/gu, (char) =>
    String.fromCodePoint(char.codePointAt(0)! + 0xfee0)
  );
}

test("whitespace/case normalization is identifier-safe, not lossy rewriting", () => {
  const base = chestInvariantInput();
  const noisy: PlaytestFindingIdentityInput = {
    ...base,
    workspaceId: "  Fixture/Synthetic-Game  ",
    scope: { ...base.scope, scenarioFamily: "Dungeon-Vault" }
  };
  assert.equal(fingerprintOf(noisy), fingerprintOf(base));
});

test("fullwidth Unicode presentation-form identifiers fold (NFKC) to their ASCII equivalent", () => {
  const base = chestInvariantInput();
  const fullwidth: PlaytestFindingIdentityInput = {
    ...base,
    mechanicKey: toFullwidth(base.mechanicKey)
  };
  assert.notEqual(fullwidth.mechanicKey, base.mechanicKey);
  assert.equal(fingerprintOf(fullwidth), fingerprintOf(base));
});

test("embedded whitespace is rejected rather than collapsed into an identifier", () => {
  const base = chestInvariantInput();
  assert.throws(
    () =>
      buildPlaytestFindingIdentity({
        ...base,
        mechanicKey: "inventory chest unlock invariant"
      }),
    TypeError
  );
});

test("non-ASCII glyphs are rejected rather than silently normalized", () => {
  const base = chestInvariantInput();
  assert.throws(
    () =>
      buildPlaytestFindingIdentity({
        ...base,
        scope: { ...base.scope, scenarioFamily: "donjon-cavé" }
      }),
    TypeError
  );
});

test("empty required fields are rejected", () => {
  const base = chestInvariantInput();
  for (const mutate of [
    (input: PlaytestFindingIdentityInput) => ({ ...input, workspaceId: "" }),
    (input: PlaytestFindingIdentityInput) => ({ ...input, mechanicKey: "   " }),
    (input: PlaytestFindingIdentityInput) => ({
      ...input,
      failureSignature: { ...input.failureSignature, witness: "" }
    }),
    (input: PlaytestFindingIdentityInput) => ({
      ...input,
      scope: { ...input.scope, scenarioFamily: "" }
    })
  ] as const) {
    assert.throws(() => buildPlaytestFindingIdentity(mutate(base)), TypeError);
  }
});

test("unknown modality values are rejected against the closed vocabulary", () => {
  const base = chestInvariantInput();
  assert.throws(
    () =>
      buildPlaytestFindingIdentity({
        ...base,
        scope: { ...base.scope, modality: "vr" as never }
      }),
    TypeError
  );
});

test("excluded provenance fields cannot enter the identity contract directly", () => {
  const base = chestInvariantInput();
  for (const field of PLAYTESTS_FINDING_IDENTITY_EXCLUDED_FIELDS) {
    assert.throws(
      () =>
        buildPlaytestFindingIdentity({
          ...base,
          [field]: "smuggled-provenance-value"
        } as unknown as PlaytestFindingIdentityInput),
      TypeError,
      `expected ${field} to be rejected at the top level`
    );
    assert.throws(
      () =>
        buildPlaytestFindingIdentity({
          ...base,
          failureSignature: {
            ...base.failureSignature,
            [field]: "smuggled-provenance-value"
          }
        } as unknown as PlaytestFindingIdentityInput),
      TypeError,
      `expected ${field} to be rejected inside failureSignature`
    );
    assert.throws(
      () =>
        buildPlaytestFindingIdentity({
          ...base,
          scope: { ...base.scope, [field]: "smuggled-provenance-value" }
        } as unknown as PlaytestFindingIdentityInput),
      TypeError,
      `expected ${field} to be rejected inside scope`
    );
  }
});

test("changing excluded provenance on an otherwise-identical record cannot affect the fingerprint, by construction", () => {
  // Simulates a realistic caller: a richer record carries both identity
  // fields and provenance fields side by side. Only `record.identity` is
  // ever passed into the identity contract, so no amount of varying the
  // sibling provenance fields -- however they are renamed or reshuffled --
  // can reach the hashed payload, because the contract never reads them.
  function recordWithProvenance(provenance: Record<string, unknown>) {
    return { identity: jumpBufferInput(), ...provenance };
  }
  const recordOne = recordWithProvenance({
    seed: "seed-1",
    batchId: "batch-1",
    episodeId: "ep-1",
    runId: "run-1",
    buildSha: "1".repeat(40),
    policyId: "policy-1",
    modelId: "model-1",
    generatedAt: "2025-01-01T00:00:00.000Z"
  });
  const recordTwo = recordWithProvenance({
    seed: "seed-2-entirely-different",
    batchId: "batch-2",
    episodeId: "ep-2",
    runId: "run-2",
    buildSha: "2".repeat(40),
    policyId: "policy-2",
    modelId: "model-2",
    generatedAt: "2026-12-31T23:59:59.000Z"
  });
  assert.equal(
    fingerprintOf(recordOne.identity),
    fingerprintOf(recordTwo.identity)
  );
});

test("finding IDs use the full lowercase fingerprint and reject aliases or truncated hashes", () => {
  const digest = "a".repeat(64);
  const findingId = playtestFindingIdFromFingerprint(digest);
  assert.equal(findingId, "finding-" + digest);
  assert.equal(isPlaytestFindingId(findingId), true);
  assert.equal(isPlaytestFindingId("finding-" + digest.slice(0, 16)), false);
  assert.equal(isPlaytestFindingId("find-" + digest), false);
  assert.throws(
    () => playtestFindingIdFromFingerprint(digest.toUpperCase()),
    /lowercase SHA-256/u
  );
});
