/**
 * `PlayerPolicyValidity` derivation.
 *
 * The artifact was declared and used nowhere until the diagnostic ladder took
 * competence-checked observers. The point of these tests is that `competence`
 * is *derived*, never asserted: no amount of supplied metrics turns an
 * unmeasured policy into one that may speak for a person.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPlaytestPolicyValidity,
  playtestHumanProxyRefusal,
  type BuildPlaytestPolicyValidityInput
} from "@simulatorlife/autodev-core";

const BOUNDS = {
  minLegalityRate: 0.9,
  minRepeatability: 0.8,
  minActionAgreement: 0.75,
  maxDistributionDivergence: 0.2,
  minCoverage: 0.5
} as const;

function input(
  overrides: Partial<BuildPlaytestPolicyValidityInput> = {}
): BuildPlaytestPolicyValidityInput {
  return {
    workspaceId: "owner/game",
    buildSha: "a".repeat(40),
    cohortId: "novice",
    observationSchemaHash: "b".repeat(64),
    actionSchemaHash: "c".repeat(64),
    policyId: "policy-1",
    policyVersion: "1",
    heldOutHumanStateIds: ["human-state-1", "human-state-2"],
    bounds: BOUNDS,
    legalityRate: 0.95,
    repeatability: 0.9,
    actionAgreement: 0.8,
    distributionDivergence: 0.1,
    coverage: 0.6,
    failureModes: [],
    interval: null,
    createdAt: "2026-10-10T00:00:00.000Z",
    ...overrides
  };
}

test("a synthetic cohort is unvalidated even with perfect-looking metrics", () => {
  // No human decision states exist, so every number here is measured against
  // synthetic data. Reporting `passed` would let a policy measured only
  // against itself authorize a claim about players.
  const validity = buildPlaytestPolicyValidity(
    input({ heldOutHumanStateIds: [] })
  );
  assert.equal(validity.competence, "unvalidated-synthetic");
  assert.deepEqual(validity.heldOutHumanStateIds, []);
  assert.match(
    playtestHumanProxyRefusal(validity)!,
    /only against a synthetic cohort/u
  );
});

test("human states without preregistered bounds stay synthetic", () => {
  // Someone supplied human data but never registered the acceptance criteria.
  // The bounds are the project's to preregister, so their absence is not a
  // permissive default.
  const validity = buildPlaytestPolicyValidity(input({ bounds: undefined }));
  assert.equal(validity.competence, "unvalidated-synthetic");
  assert.equal(validity.heldOutHumanStateIds.length, 2);
});

test("an unmeasured criterion is insufficient, not passed", () => {
  // Repeatability was never measured. The criterion has not been met; it has
  // not been missed. Reporting `passed` here is precisely how an absent metric
  // becomes an authorization.
  const validity = buildPlaytestPolicyValidity(
    input({ repeatability: null })
  );
  assert.equal(validity.competence, "insufficient");
  assert.equal(validity.repeatability, null);
  assert.match(
    playtestHumanProxyRefusal(validity)!,
    /never measured/u
  );
});

test("measured metrics are applied against the caller's preregistered bounds", () => {
  assert.equal(buildPlaytestPolicyValidity(input()).competence, "passed");
  assert.equal(
    playtestHumanProxyRefusal(buildPlaytestPolicyValidity(input())),
    null
  );

  for (const [name, overrides] of [
    ["legalityRate", { legalityRate: 0.5 }],
    ["repeatability", { repeatability: 0.5 }],
    ["actionAgreement", { actionAgreement: 0.5 }],
    ["distributionDivergence", { distributionDivergence: 0.9 }],
    ["coverage", { coverage: 0.1 }]
  ] as const) {
    const validity = buildPlaytestPolicyValidity(input(overrides));
    assert.equal(validity.competence, "failed", `${name} below bound must fail`);
    assert.match(
      playtestHumanProxyRefusal(validity)!,
      /below a preregistered acceptance bound/u
    );
  }
});

test("bounds decide the verdict, not the numbers alone", () => {
  // The same measurements pass a lax bound set and fail a strict one. That is
  // the point: the threshold belongs to whoever preregistered it.
  const measured = input();
  assert.equal(buildPlaytestPolicyValidity(measured).competence, "passed");
  assert.equal(
    buildPlaytestPolicyValidity({
      ...measured,
      bounds: { ...BOUNDS, minLegalityRate: 0.99 }
    }).competence,
    "failed"
  );
});

test("a metric outside [0, 1] is a data error, not an extreme result", () => {
  for (const overrides of [
    { legalityRate: 1.5 },
    { repeatability: -0.1 },
    { coverage: 2 },
    { distributionDivergence: Number.NaN }
  ]) {
    assert.throws(
      () => buildPlaytestPolicyValidity(input(overrides)),
      /proportion/u
    );
  }
  assert.throws(
    () =>
      buildPlaytestPolicyValidity(
        input({ bounds: { ...BOUNDS, minCoverage: 1.2 } })
      ),
    /proportion between 0 and 1/u
  );
});

test("identity is bound to one exact build and schema pair", () => {
  for (const overrides of [
    { buildSha: "not-a-sha" },
    { observationSchemaHash: "short" },
    { actionSchemaHash: "" },
    { workspaceId: "no-owner" },
    { cohortId: "has space" }
  ]) {
    assert.throws(() => buildPlaytestPolicyValidity(input(overrides)), TypeError);
  }
});

test("held-out human state ids are bounded identifiers, not free text", () => {
  assert.throws(
    () =>
      buildPlaytestPolicyValidity(
        input({ heldOutHumanStateIds: ["a".repeat(2000)] })
      ),
    /bounded identifiers/u
  );
  assert.throws(
    () => buildPlaytestPolicyValidity(input({ heldOutHumanStateIds: [""] })),
    /bounded identifiers/u
  );
});

test("the returned record copies its lists rather than aliasing the input", () => {
  const states = ["human-state-1"];
  const modes = ["stalled-progress"];
  const validity = buildPlaytestPolicyValidity(
    input({ heldOutHumanStateIds: states, failureModes: modes })
  );
  states.push("human-state-2");
  modes.push("lost-state");
  assert.deepEqual(validity.heldOutHumanStateIds, ["human-state-1"]);
  assert.deepEqual(validity.failureModes, ["stalled-progress"]);
});
