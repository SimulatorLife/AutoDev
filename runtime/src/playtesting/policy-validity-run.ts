/**
 * Derive `PlayerPolicyValidity` from the run a batch actually executed.
 *
 * §6 of the measurement contract requires this artifact, and until now nothing
 * outside Core could produce one: `buildPlaytestPolicyValidity` existed and was
 * correct, but no Runtime or Console path fed it a real run, so a live system
 * had no validity record at all. This module is that path.
 *
 * The basis is the batch's own frozen coverage manifest rather than a page of
 * the episode table. That manifest is the content-addressed record of what each
 * policy and cohort was actually observed doing, and reading it avoids the two
 * ways an episode page distorts this: a truncated page would undercount a
 * policy's coverage, and a paginated read would make the totals depend on which
 * page answered.
 *
 * Three decisions keep the result from fabricating authority, and each follows
 * the contract rather than this codebase's convenience:
 *
 * 1. **Coverage is measured or the cell is named, never scored as zero.** A
 *    cell with no eligible opportunities has no coverage figure to report, and
 *    `0` there would assert the policy was observed and never behaved. Those
 *    land in `unmeasurable` with a reason instead.
 * 2. **The policy version must be declared.** The manifest names policies; the
 *    approved benchmark declares what each id means. A validity record pinned
 *    to a guessed version would look checkable and not be.
 * 3. **Human evidence arrives only as an operator preregistration block.** The
 *    held-out decision-state ids and acceptance bounds are the judgement §6
 *    reserves for the project, so they are not tool inputs: a caller that could
 *    pass `heldOutHumanStateIds` in a call could assert human data exists on the
 *    strength of nothing — the defect the diagnostic ladder's observer list had.
 *    No such block is wired yet, so every record produced today is
 *    `unvalidated-synthetic`, which is §6's own word for absent data.
 *
 * Nothing here invents a threshold. The competence verdict belongs to Core,
 * which applies bounds the project supplied or refuses to score.
 */
import { createHash } from "node:crypto";

import {
  buildPlaytestPolicyValidity,
  type PlayerPolicyValidity,
  type PlaytestBatch,
  playtestHumanProxyRefusal,
  type PlaytestPolicyCompetenceBounds,
  playtestPolicyValidityHashInput
} from "@simulatorlife/autodev-core";

/**
 * The project's §6 preregistration, supplied by the operator rather than by a
 * caller of an analysis tool. Absent today; when absent, every derived record
 * is `unvalidated-synthetic`.
 */
export interface PlaytestPolicyHumanPreregistration {
  /** Held-out human decision-state ids, per policy. Absent keys mean none. */
  readonly heldOutHumanStateIdsByPolicyId?: Readonly<
    Record<string, readonly string[]>
  >;
  /** Preregistered acceptance bounds, per policy. Absent keys mean none. */
  readonly boundsByPolicyId?: Readonly<
    Record<string, PlaytestPolicyCompetenceBounds>
  >;
}

export interface DerivePlaytestPolicyValidityInput {
  readonly batch: PlaytestBatch;
  /** Approved benchmark's `policyVersions`; declares what each policy id means. */
  readonly policyVersions: Readonly<Record<string, string>>;
  readonly preregistration?: PlaytestPolicyHumanPreregistration | undefined;
  readonly createdAt: string;
}

export interface PlaytestDerivedPolicyValidity {
  readonly validity: PlayerPolicyValidity;
  /**
   * SHA-256 over Core's canonical form of the record.
   *
   * This is the id a `competenceReportRefs` locator cites, so a benchmark can
   * attest to a specific validity record rather than to a policy name. It is
   * computed here because Core carries no hashing: `node:crypto` cannot be
   * bundled into the browser-reachable console package.
   */
  readonly validityId: string;
  /** The citable locator for this record, as a benchmark would write it. */
  readonly locator: { readonly kind: "policy-validity"; readonly id: string };
  /** §6's required downgrade sentence, or null when the policy passed. */
  readonly humanProxyRefusal: string | null;
  readonly observedEpisodes: number;
  readonly observedOpportunities: number;
  readonly eligibleOpportunities: number;
}

/**
 * Why a policy/cohort the batch planned produced no validity record.
 *
 * Each is a fact about the run rather than a score, so a caller can tell an
 * unmeasured policy from one that failed.
 */
export type PlaytestPolicyValiditySkipReason =
  | "no-eligible-opportunities"
  | "no-observed-episodes"
  | "policy-version-undeclared"
  | "schema-hashes-unavailable";

export interface PlaytestUnmeasurablePolicyCell {
  readonly policyId: string;
  readonly cohortId: string;
  readonly policyVersion: string | null;
  readonly reason: PlaytestPolicyValiditySkipReason;
}

export interface DerivePlaytestPolicyValidityResult {
  readonly records: readonly PlaytestDerivedPolicyValidity[];
  readonly unmeasurable: readonly PlaytestUnmeasurablePolicyCell[];
}

interface CellTotals {
  readonly eligibleOpportunities: number;
  readonly observedOpportunities: number;
  readonly observedEpisodes: number;
}

/** Stable order, so the same batch always yields byte-identical output. */
const POLICY_COHORT_ORDER = new Intl.Collator("en", {
  sensitivity: "variant",
  numeric: true
});

function byPolicyThenCohort(
  left: { readonly policyId: string; readonly cohortId: string },
  right: { readonly policyId: string; readonly cohortId: string }
): number {
  return (
    POLICY_COHORT_ORDER.compare(left.policyId, right.policyId) ||
    POLICY_COHORT_ORDER.compare(left.cohortId, right.cohortId)
  );
}

function skip(
  policyId: string,
  cohortId: string,
  policyVersion: string | null,
  reason: PlaytestPolicyValiditySkipReason
): PlaytestUnmeasurablePolicyCell {
  return { policyId, cohortId, policyVersion, reason };
}

/**
 * Derive one validity record per policy/cohort the batch actually observed.
 *
 * The four competence metrics stay `null` unless human data exists to measure
 * them against, because each is a comparison between the policy's behaviour and
 * a person's. A rate computed from synthetic episodes would let a policy stand
 * in for a player on the strength of its agreement with itself.
 */
export function derivePlaytestPolicyValidity(
  input: DerivePlaytestPolicyValidityInput
): DerivePlaytestPolicyValidityResult {
  const { batch, policyVersions, preregistration } = input;
  const manifest = batch.coverageManifest;

  if (manifest === null) {
    // No frozen manifest means nothing recorded what this batch observed, so
    // there is no cell to name. The caller reports the missing basis itself.
    return { records: [], unmeasurable: [] };
  }

  const totals = new Map<string, CellTotals>();
  const pairs = new Map<string, { policyId: string; cohortId: string }>();
  for (const cell of manifest.cells) {
    const id = JSON.stringify([cell.policy, cell.cohort]);
    pairs.set(id, { policyId: cell.policy, cohortId: cell.cohort });
    const previous = totals.get(id);
    totals.set(id, {
      eligibleOpportunities:
        (previous?.eligibleOpportunities ?? 0) + cell.eligibleOpportunities,
      observedOpportunities:
        (previous?.observedOpportunities ?? 0) + cell.observedOpportunities,
      observedEpisodes:
        (previous?.observedEpisodes ?? 0) + cell.observedEpisodes
    });
  }

  const records: PlaytestDerivedPolicyValidity[] = [];
  const unmeasurable: PlaytestUnmeasurablePolicyCell[] = [];

  for (const pair of [...pairs.values()].sort(byPolicyThenCohort)) {
    const counted = totals.get(
      JSON.stringify([pair.policyId, pair.cohortId])
    ) ?? {
      eligibleOpportunities: 0,
      observedOpportunities: 0,
      observedEpisodes: 0
    };
    const policyVersion = policyVersions[pair.policyId] ?? null;

    if (
      batch.observationSchemaHash === null ||
      batch.actionSchemaHash === null
    ) {
      // The adapter never completed capabilities, so the schemas this batch's
      // observations would be judged against were never negotiated.
      unmeasurable.push(
        skip(
          pair.policyId,
          pair.cohortId,
          policyVersion,
          "schema-hashes-unavailable"
        )
      );
      continue;
    }
    if (counted.observedEpisodes === 0) {
      unmeasurable.push(
        skip(
          pair.policyId,
          pair.cohortId,
          policyVersion,
          "no-observed-episodes"
        )
      );
      continue;
    }
    if (counted.eligibleOpportunities === 0) {
      // Nothing was eligible, so there is no coverage to measure. Scoring this
      // as 0 would assert the policy was observed and never behaved.
      unmeasurable.push(
        skip(
          pair.policyId,
          pair.cohortId,
          policyVersion,
          "no-eligible-opportunities"
        )
      );
      continue;
    }
    if (policyVersion === null) {
      // Without a declared version the record could not be tied to what
      // actually ran, so it would look checkable and not be.
      unmeasurable.push(
        skip(pair.policyId, pair.cohortId, null, "policy-version-undeclared")
      );
      continue;
    }

    const validity = buildPlaytestPolicyValidity({
      workspaceId: batch.workspaceId,
      buildSha: batch.buildSha,
      cohortId: pair.cohortId,
      observationSchemaHash: batch.observationSchemaHash,
      actionSchemaHash: batch.actionSchemaHash,
      policyId: pair.policyId,
      policyVersion,
      heldOutHumanStateIds:
        preregistration?.heldOutHumanStateIdsByPolicyId?.[pair.policyId] ?? [],
      bounds: preregistration?.boundsByPolicyId?.[pair.policyId],
      // Unmeasured is not zero: each of these compares the policy with a
      // person, and this run measured no person.
      legalityRate: null,
      repeatability: null,
      actionAgreement: null,
      distributionDivergence: null,
      coverage: counted.observedOpportunities / counted.eligibleOpportunities,
      failureModes: [],
      interval: null,
      createdAt: input.createdAt
    });

    const validityId = createHash("sha256")
      .update(playtestPolicyValidityHashInput(validity))
      .digest("hex");
    records.push({
      validity,
      validityId,
      locator: { kind: "policy-validity", id: validityId },
      humanProxyRefusal: playtestHumanProxyRefusal(validity),
      observedEpisodes: counted.observedEpisodes,
      observedOpportunities: counted.observedOpportunities,
      eligibleOpportunities: counted.eligibleOpportunities
    });
  }

  return { records, unmeasurable };
}
