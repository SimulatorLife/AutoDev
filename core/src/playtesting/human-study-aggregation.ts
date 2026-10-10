/**
 * Core-owned, infrastructure-free human-study aggregation.
 *
 * Native miniPXI/full-PXI items are preserved verbatim; ENJ is aggregated as
 * its own distinct, null-safe construct. Aggregation is arm-aware (grouped
 * by itemId and the exposed build id) so a participant with both an A and a
 * B exposure never collides into one respondent count, and a withdrawn
 * participant can be excluded and the arms/paired differences recomputed
 * without re-deriving anything from raw identifiers. Small-cell suppression
 * is applied at the boundary that renders a summary, never inside the raw
 * computation, so the exact math stays independently verifiable.
 *
 * See docs/playtesting-measurement-contract.md#7-human-labels-and-change-sensitivity.
 */

import { type HumanPlaytestStudy } from "./artifacts.ts";
import {
  aggregateMiniPxiEnj,
  type MiniPxiEnjResponseEvent
} from "./evaluators.ts";
import type {
  HumanStudyResponse,
  PlaytestPxiConstructId
} from "./human-study-import.ts";
import {
  type PlaytestMissingReason,
  PLAYTESTS_MEASUREMENT_VERSION
} from "./types.ts";

/** Minimum retained-participant count a human-study summary may disclose unsuppressed. */
export const HUMAN_STUDY_SMALL_CELL_SUPPRESSION_THRESHOLD = 5;

/** Per-(item, exposed build) aggregate; never identifies a respondent. */
export interface HumanStudyItemAggregate {
  readonly itemId: string;
  readonly mean: number | null;
  readonly respondentCount: number;
  readonly missingCount: number;
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly unit: string;
  readonly missingReasons: readonly PlaytestMissingReason[];
}

/** One item aggregate scoped to a specific exposed build ("arm"). */
export interface HumanStudyArmItemAggregate extends HumanStudyItemAggregate {
  readonly armBuildId: string;
}

/** Within-participant B-minus-A difference for one item, averaged over complete pairs only. */
export interface HumanStudyPairedDifference {
  readonly itemId: string;
  readonly meanDifference: number | null;
  readonly pairedParticipants: number;
}

export interface HumanStudyAggregateResult {
  readonly studyId: string;
  readonly revision: number;
  readonly retainedParticipants: number;
  readonly arms: readonly HumanStudyArmItemAggregate[];
  readonly constructs: readonly HumanStudyConstructAggregate[];
  readonly pairedDifferences: readonly HumanStudyPairedDifference[];
}

/** Full-PXI construct average per exposed build; missingness follows the study policy. */
export interface HumanStudyConstructAggregate {
  readonly constructId: PlaytestPxiConstructId;
  readonly armBuildId: string;
  readonly mean: number | null;
  readonly respondentCount: number;
  readonly missingCount: number;
  readonly unit: string;
  readonly missingReasons: readonly PlaytestMissingReason[];
}

export interface HumanStudyPairedArmBuildIds {
  readonly a: string;
  readonly b: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function aggregateHumanStudyItem(
  itemId: string,
  responses: readonly HumanStudyResponse[]
): HumanStudyItemAggregate {
  if (itemId === "ENJ" && responses[0]?.instrument === "miniPXI") {
    const events: MiniPxiEnjResponseEvent[] = responses.map((response) => ({
      respondentId: response.pseudonymousParticipantId,
      nativeValue: response.nativeValue,
      ...(response.missingReason === undefined
        ? {}
        : { missingReason: response.missingReason })
    }));
    const result = aggregateMiniPxiEnj(
      "n/a",
      PLAYTESTS_MEASUREMENT_VERSION,
      events
    );
    return {
      itemId,
      mean: result.mean,
      respondentCount: result.respondentCount,
      missingCount: result.missingCount,
      categoryCounts: result.categoryCounts,
      unit: result.unit,
      missingReasons: result.missingReasons
    };
  }
  const categoryCounts: Record<string, number> = {};
  let sum = 0;
  let respondentCount = 0;
  let missingCount = 0;
  const missingReasons: PlaytestMissingReason[] = [];
  const seen = new Set<string>();
  const scale = responses[0];
  if (
    responses.some(
      (response) =>
        response.nativeMinimum !== scale?.nativeMinimum ||
        response.nativeMaximum !== scale?.nativeMaximum ||
        response.nativeUnit !== scale?.nativeUnit
    )
  ) {
    throw new TypeError(`Inconsistent native scale for item "${itemId}".`);
  }
  for (const response of responses) {
    if (seen.has(response.pseudonymousParticipantId)) {
      throw new TypeError(
        `Duplicate "${itemId}" response for one participant within one arm; resolve lineage before aggregating.`
      );
    }
    seen.add(response.pseudonymousParticipantId);
    if (response.nativeValue === null) {
      missingCount += 1;
      missingReasons.push(response.missingReason ?? "unobserved");
      continue;
    }
    const category = String(response.nativeValue);
    sum += response.nativeValue;
    respondentCount += 1;
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }
  return {
    itemId,
    mean: respondentCount === 0 ? null : sum / respondentCount,
    respondentCount,
    missingCount,
    categoryCounts,
    unit: scale?.nativeUnit ?? "native-Likert-minus3-plus3",
    missingReasons
  };
}

/**
 * Aggregate a retained (non-withdrawn) set of human-study item responses.
 * Grouping is always by (itemId, exposed build id) so two exposures from
 * one participant never collide; pass `pairedArmBuildIds` to additionally
 * compute the complete-pair B-minus-A difference for each item.
 */
export function aggregateHumanStudyResponses(
  study: HumanPlaytestStudy,
  responses: readonly HumanStudyResponse[],
  options: { readonly pairedArmBuildIds?: HumanStudyPairedArmBuildIds } = {}
): HumanStudyAggregateResult {
  if (responses.some((response) => response.studyId !== study.studyId)) {
    throw new TypeError(
      "Cannot aggregate responses from a different human study."
    );
  }
  const retained = responses.filter((response) => !response.withdrawn);
  const retainedParticipants = new Set(
    retained.map((response) => response.pseudonymousParticipantId)
  ).size;

  const arms = aggregateArms(retained);
  const constructs = aggregatePxiConstructs(study, retained);
  const pairedDifferences = options.pairedArmBuildIds
    ? aggregatePairedDifferences(retained, options.pairedArmBuildIds)
    : [];

  return {
    studyId: study.studyId,
    revision: study.version,
    retainedParticipants,
    arms,
    constructs,
    pairedDifferences
  };
}

function aggregatePxiConstructs(
  study: HumanPlaytestStudy,
  responses: readonly HumanStudyResponse[]
): HumanStudyConstructAggregate[] {
  if (study.instrument !== "PXI") return [];
  const byParticipantConstruct = new Map<string, HumanStudyResponse[]>();
  for (const response of responses) {
    if (response.constructId === undefined) {
      throw new TypeError(
        "Full-PXI response is missing its trusted construct mapping."
      );
    }
    const key = JSON.stringify([
      response.constructId,
      response.build.id,
      response.pseudonymousParticipantId
    ]);
    const group = byParticipantConstruct.get(key) ?? [];
    group.push(response);
    byParticipantConstruct.set(key, group);
  }

  const aggregates = new Map<
    string,
    {
      constructId: PlaytestPxiConstructId;
      buildId: string;
      unit: string;
      sum: number;
      respondentCount: number;
      missingCount: number;
      missingReasons: PlaytestMissingReason[];
    }
  >();
  for (const participantItems of byParticipantConstruct.values()) {
    const first = participantItems[0]!;
    if (
      participantItems.length !== 3 ||
      new Set(participantItems.map((item) => item.itemId)).size !== 3 ||
      participantItems.some(
        (item) =>
          item.constructId !== first.constructId ||
          item.nativeUnit !== first.nativeUnit
      )
    ) {
      throw new TypeError(
        "Each participant/build PXI construct must have exactly three consistently mapped items."
      );
    }
    const observed = participantItems.filter(
      (item) => item.nativeValue !== null
    );
    const incomplete = observed.length !== 3;
    const value =
      observed.length === 0 ||
      (incomplete && study.missingItemPolicy === "null-construct")
        ? null
        : observed.reduce((sum, item) => sum + item.nativeValue!, 0) /
          observed.length;
    const key = JSON.stringify([first.constructId, first.build.id]);
    const aggregate = aggregates.get(key) ?? {
      constructId: first.constructId!,
      buildId: first.build.id,
      unit: first.nativeUnit,
      sum: 0,
      respondentCount: 0,
      missingCount: 0,
      missingReasons: []
    };
    if (value === null) {
      aggregate.missingCount += 1;
      aggregate.missingReasons.push(
        ...participantItems
          .filter((item) => item.nativeValue === null)
          .map((item) => item.missingReason ?? "unobserved")
      );
    } else {
      aggregate.sum += value;
      aggregate.respondentCount += 1;
    }
    aggregates.set(key, aggregate);
  }
  return Array.from(aggregates.values(), (aggregate) => ({
    constructId: aggregate.constructId,
    armBuildId: aggregate.buildId,
    mean:
      aggregate.respondentCount === 0
        ? null
        : aggregate.sum / aggregate.respondentCount,
    respondentCount: aggregate.respondentCount,
    missingCount: aggregate.missingCount,
    unit: aggregate.unit,
    missingReasons: aggregate.missingReasons
  })).sort(
    (left, right) =>
      compareStrings(left.constructId, right.constructId) ||
      compareStrings(left.armBuildId, right.armBuildId)
  );
}

function aggregateArms(
  responses: readonly HumanStudyResponse[]
): HumanStudyArmItemAggregate[] {
  const byArm = new Map<string, HumanStudyResponse[]>();
  for (const response of responses) {
    const key = `${response.itemId}\u0000${response.build.id}`;
    const group = byArm.get(key) ?? [];
    group.push(response);
    byArm.set(key, group);
  }
  const arms: HumanStudyArmItemAggregate[] = [];
  for (const [key, armResponses] of byArm) {
    const [itemId, armBuildId] = key.split("\u0000") as [string, string];
    arms.push({ ...aggregateHumanStudyItem(itemId, armResponses), armBuildId });
  }
  arms.sort(
    (left, right) =>
      compareStrings(left.itemId, right.itemId) ||
      compareStrings(left.armBuildId, right.armBuildId)
  );
  return arms;
}

function pairedDifferenceForItem(
  itemId: string,
  responses: readonly HumanStudyResponse[],
  buildA: string,
  buildB: string
): HumanStudyPairedDifference {
  const valuesA = new Map<string, number>();
  const valuesB = new Map<string, number>();
  for (const response of responses) {
    if (response.itemId !== itemId || response.nativeValue === null) continue;
    const destination =
      response.build.id === buildA
        ? valuesA
        : response.build.id === buildB
          ? valuesB
          : null;
    destination?.set(response.pseudonymousParticipantId, response.nativeValue);
  }
  let sum = 0;
  let pairedParticipants = 0;
  for (const [participantId, valueA] of valuesA) {
    const valueB = valuesB.get(participantId);
    if (valueB === undefined) continue;
    sum += valueB - valueA;
    pairedParticipants += 1;
  }
  return {
    itemId,
    meanDifference: pairedParticipants === 0 ? null : sum / pairedParticipants,
    pairedParticipants
  };
}

function aggregatePairedDifferences(
  responses: readonly HumanStudyResponse[],
  builds: HumanStudyPairedArmBuildIds
): HumanStudyPairedDifference[] {
  const itemIds = new Set(responses.map((response) => response.itemId));
  return Array.from(itemIds, (itemId) =>
    pairedDifferenceForItem(itemId, responses, builds.a, builds.b)
  ).sort((left, right) => compareStrings(left.itemId, right.itemId));
}

/**
 * Tombstone every response belonging to `participantId`. This only marks
 * the Core-owned artifact; the restricted repository is responsible for
 * actually deleting the underlying raw/PII storage and any cached summary.
 */
export function withdrawHumanStudyParticipant(
  responses: readonly HumanStudyResponse[],
  participantId: string
): readonly HumanStudyResponse[] {
  return responses.map((response) =>
    response.pseudonymousParticipantId === participantId
      ? { ...response, withdrawn: true }
      : response
  );
}

/** Apply the v1 small-cell privacy floor; `null` means "render as suppressed". */
export function applyHumanStudySmallCellSuppression(
  aggregate: HumanStudyAggregateResult,
  threshold: number = HUMAN_STUDY_SMALL_CELL_SUPPRESSION_THRESHOLD
): HumanStudyAggregateResult | null {
  return aggregate.retainedParticipants < threshold ? null : aggregate;
}
