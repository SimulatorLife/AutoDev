/**
 * `PlayerPolicyValidity`: whether a player policy may stand in for people.
 *
 * The measurement contract (§6) requires this artifact and says two things
 * about it that decide the whole design here:
 *
 * - "held-out human decision-state IDs **when available**";
 * - "Prerogister acceptance bounds against relevant human data; **absent data
 *   means unvalidated-synthetic-cohort**", and such a cohort must downgrade
 *   novice/learner UX generalizations to model-specific signals rather than
 *   leave an authoritative claim with a footnote.
 *
 * So the verdict is derived, never asserted. With no human data the answer is
 * `unvalidated-synthetic`, which is the contract's own word, not a threshold
 * this codebase chose. With human data the bounds are supplied by the caller —
 * the project preregisters them, Core applies them — because choosing those
 * numbers here would fabricate exactly the judgement §6 reserves for the
 * project.
 *
 * Every metric is `null` when unmeasured. A `0` legality rate and an unmeasured
 * one are different facts, and only one of them belongs on a claim that
 * authorizes a policy to speak for a player.
 */
import type { PlayerPolicyValidity } from "./artifacts.ts";
import type { PlaytestComparison } from "./types.ts";

/**
 * Acceptance bounds the caller preregistered against human data. Absent bounds
 * are not a permissive default: they mean nobody registered the criteria, so
 * the cohort stays synthetic.
 */
export interface PlaytestPolicyCompetenceBounds {
  readonly minLegalityRate: number;
  readonly minRepeatability: number;
  readonly minActionAgreement: number;
  readonly maxDistributionDivergence: number;
  readonly minCoverage: number;
}

export interface BuildPlaytestPolicyValidityInput {
  readonly workspaceId: string;
  readonly buildSha: string;
  readonly cohortId: string;
  readonly observationSchemaHash: string;
  readonly actionSchemaHash: string;
  readonly policyId: string;
  readonly policyVersion: string;
  /** Held-out human decision states. Empty when no human data exists. */
  readonly heldOutHumanStateIds: readonly string[];
  /** Preregistered bounds; omit when none were registered. */
  readonly bounds?: PlaytestPolicyCompetenceBounds | undefined;
  readonly legalityRate: number | null;
  readonly repeatability: number | null;
  readonly actionAgreement: number | null;
  readonly distributionDivergence: number | null;
  readonly coverage: number;
  readonly failureModes: readonly string[];
  readonly interval: PlaytestComparison["metrics"][number]["interval"];
  readonly createdAt: string;
}

const SHA256 = /^[a-f\d]{64}$/iu;
/** A build is identified by a 40-character Git revision or a 64-char digest. */
const BUILD_ID = /^([a-f\d]{40}|[a-f\d]{64})$/iu;
const BUILDER_ID = /^[^/\s]+\/[^/\s]+$/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const MAX_HELD_OUT_STATES = 4096;

/** Proportion in [0, 1]; a rate outside it is a data error, not an extreme. */
function isRate(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertBounds(bounds: PlaytestPolicyCompetenceBounds): void {
  for (const [name, value] of [
    ["minLegalityRate", bounds.minLegalityRate],
    ["minRepeatability", bounds.minRepeatability],
    ["minActionAgreement", bounds.minActionAgreement],
    ["maxDistributionDivergence", bounds.maxDistributionDivergence],
    ["minCoverage", bounds.minCoverage]
  ] as const) {
    if (!isRate(value)) {
      throw new TypeError(`${name} must be a proportion between 0 and 1.`);
    }
  }
}

/**
 * Derive the validity record for one build/cohort/policy.
 *
 * `competence` is never supplied by the caller. The three possible values map
 * to three distinct situations, and collapsing them is what would let an
 * unmeasured policy authorize a human-proxy claim:
 *
 * - `unvalidated-synthetic` — no human data or no preregistered bounds;
 * - `insufficient` — bounds exist but a required metric was not measured, so
 *   the criteria cannot be applied;
 * - `passed` / `failed` — every required metric was measured and applied
 *   against the preregistered bounds.
 */
export function buildPlaytestPolicyValidity(
  input: BuildPlaytestPolicyValidityInput
): PlayerPolicyValidity {
  if (!BUILDER_ID.test(input.workspaceId)) {
    throw new TypeError("workspaceId must be an owner/repository pair.");
  }
  if (!BUILD_ID.test(input.buildSha)) {
    throw new TypeError("buildSha must be a Git revision or content digest.");
  }
  for (const hash of [input.observationSchemaHash, input.actionSchemaHash]) {
    if (!SHA256.test(hash)) {
      throw new TypeError("Observation and action schema hashes must be SHA-256.");
    }
  }
  for (const id of [input.cohortId, input.policyId, input.policyVersion]) {
    if (!BOUNDED_ID.test(id)) {
      throw new TypeError("cohortId, policyId and policyVersion must be identifiers.");
    }
  }
  if (!isRate(input.coverage)) {
    throw new TypeError("coverage must be a proportion between 0 and 1.");
  }
  if (
    input.heldOutHumanStateIds.length > MAX_HELD_OUT_STATES ||
    input.heldOutHumanStateIds.some(
      (id) => !BOUNDED_ID.test(id)
    )
  ) {
    throw new TypeError("Held-out human state ids must be bounded identifiers.");
  }
  for (const metric of [
    input.legalityRate,
    input.repeatability,
    input.actionAgreement,
    input.distributionDivergence
  ]) {
    if (metric !== null && !isRate(metric)) {
      throw new TypeError("Measured policy metrics must be proportions.");
    }
  }
  if (input.bounds !== undefined) assertBounds(input.bounds);

  const hasHumanData = input.heldOutHumanStateIds.length > 0;
  const bounds = input.bounds;

  let competence: PlayerPolicyValidity["competence"];
  if (!hasHumanData || bounds === undefined) {
    // The contract's answer, not a judgement made here. Either leg missing
    // means nobody can say the policy stands in for a person.
    competence = "unvalidated-synthetic";
  } else {
    const measured = [
      input.legalityRate,
      input.repeatability,
      input.actionAgreement,
      input.distributionDivergence
    ];
    if (measured.some((metric) => metric === null)) {
      // A criterion that was never measured has not been met. Reporting
      // `passed` here is how an unmeasured metric becomes an authorization.
      competence = "insufficient";
    } else {
      competence =
        input.legalityRate! >= bounds.minLegalityRate &&
        input.repeatability! >= bounds.minRepeatability &&
        input.actionAgreement! >= bounds.minActionAgreement &&
        input.distributionDivergence! <= bounds.maxDistributionDivergence &&
        input.coverage >= bounds.minCoverage
          ? "passed"
          : "failed";
    }
  }

  return {
    workspaceId: input.workspaceId,
    buildSha: input.buildSha,
    cohortId: input.cohortId,
    observationSchemaHash: input.observationSchemaHash,
    actionSchemaHash: input.actionSchemaHash,
    policyId: input.policyId,
    policyVersion: input.policyVersion,
    heldOutHumanStateIds: [...input.heldOutHumanStateIds],
    competence,
    legalityRate: input.legalityRate,
    repeatability: input.repeatability,
    actionAgreement: input.actionAgreement,
    distributionDivergence: input.distributionDivergence,
    coverage: input.coverage,
    failureModes: [...input.failureModes],
    interval: input.interval,
    createdAt: input.createdAt
  };
}

/**
 * Whether a validity record may support a claim about human players.
 *
 * §6 requires an unvalidated cohort to downgrade novice/learner UX
 * generalizations to model-specific signals and disable human-proxy
 * comparisons. Returning the reason keeps that downgrade from being a silent
 * branch: a caller has to carry the sentence into its own output.
 */
export function playtestHumanProxyRefusal(
  validity: PlayerPolicyValidity
): string | null {
  if (validity.competence === "passed") return null;
  const detail =
    validity.competence === "unvalidated-synthetic"
      ? "it was validated only against a synthetic cohort"
      : validity.competence === "insufficient"
        ? "a preregistered criterion was never measured"
        : "it fell below a preregistered acceptance bound";
  return (
    `The ${validity.policyId} policy for cohort ${validity.cohortId} cannot ` +
    `support a human-player claim because ${detail}. Report it as a ` +
    "model-specific signal instead."
  );
}
