/** Frozen per-batch coverage plans and counts for game-owned metric cells. */

import type {
  PlaytestCoverageManifest,
  PlaytestCoverageManifestCell
} from "./artifacts.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";
import type {
  PlaytestCoverageRequirement,
  PlaytestMetricRegistry
} from "./registry.ts";
import {
  type PlaytestBatchAssignment,
  type PlaytestCoverageModality,
  type PlaytestMissingReason,
  type PlaytestNumericResult,
  PLAYTESTS_COVERAGE_MANIFEST_SCHEMA,
  PLAYTESTS_COVERAGE_MODALITIES,
  PLAYTESTS_MISSING_REASONS
} from "./types.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const BUILD_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const ANALYSIS_UNITS = new Set([
  "episode",
  "decision",
  "cohort",
  "learner-identity",
  "participant"
]);
const CELL_STATUSES = new Set([
  "unsupported",
  "unsupported-modality",
  "not-assigned",
  "partial",
  "covered",
  "insufficient"
]);
const MANIFEST_KEYS = new Set([
  "schema",
  "workspaceId",
  "batchId",
  "buildSha",
  "rubricHash",
  "assignmentManifestHash",
  "mode",
  "generatedAt",
  "assignedEpisodes",
  "observedEpisodes",
  "cells",
  "contentHash"
]);
const CELL_KEYS = new Set([
  "coverageMetricId",
  "metricVersion",
  "mechanicKey",
  "phaseId",
  "scenarioFamily",
  "cohort",
  "policy",
  "modality",
  "analysisUnit",
  "requiredOpportunities",
  "requiredIndependentUnits",
  "unsupportedReason",
  "assignedEpisodes",
  "observedEpisodes",
  "missingAssignments",
  "unresolvedCohortAssignments",
  "missingMetricResults",
  "observedOpportunities",
  "eligibleOpportunities",
  "missingOpportunities",
  "observedIndependentUnits",
  "missingReasons",
  "status"
]);

export interface PlaytestCoveragePlanCell extends PlaytestCoverageRequirement {
  readonly metricVersion: number;
  readonly analysisUnit:
    "episode" | "decision" | "cohort" | "learner-identity" | "participant";
}

export interface BuildPlaytestCoverageManifestInput {
  readonly rubricHash: string;
  readonly assignmentManifestHash: string;
  readonly mode: "headless" | "browser" | "native-visual";
  readonly generatedAt: string;
  readonly batchId: string;
  readonly workspaceId: string;
  readonly buildSha: string;
  readonly plan: readonly PlaytestCoveragePlanCell[];
  readonly assignments: readonly PlaytestBatchAssignment[];
  readonly episodes: readonly PlaytestCoverageEpisode[];
}

export type PlaytestCoverageManifestDraft = Omit<
  PlaytestCoverageManifest,
  "contentHash"
>;

/** Narrow read model: only the episode facts needed to aggregate coverage. */
export interface PlaytestCoverageEpisode {
  readonly episodeId: string;
  readonly batchId: string;
  readonly assignmentId: string | null;
  readonly identity: {
    readonly workspaceId: string;
    readonly buildSha: string;
    readonly scenarioId: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly seed: string;
  };
  readonly scenarioFamily: string;
  readonly policyCohort: string;
  readonly metrics: readonly PlaytestNumericResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function cellIdentity(
  cell: Pick<
    PlaytestCoverageManifestCell,
    | "coverageMetricId"
    | "phaseId"
    | "scenarioFamily"
    | "cohort"
    | "policy"
    | "modality"
  >
): string {
  return canonicalPlaytestJson([
    cell.coverageMetricId,
    cell.phaseId,
    cell.scenarioFamily,
    cell.cohort,
    cell.policy,
    cell.modality
  ]);
}

function addCount(total: number, value: number, field: string): number {
  const sum = total + value;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError(
      `Playtest coverage ${field} exceeds the safe integer range.`
    );
  }
  return sum;
}

/** Canonical hash projection; excludes only contentHash. */
export function playtestCoverageManifestHashInput(
  manifest: PlaytestCoverageManifestDraft
): string {
  return canonicalPlaytestJson(manifest);
}

/** Freeze the registry's metric metadata into its exact coverage plan. */
export function playtestCoveragePlanForRegistry(
  registry: PlaytestMetricRegistry
): readonly PlaytestCoveragePlanCell[] {
  const metrics = new Map(
    registry.metricDefinitions.map((metric) => [metric.metricId, metric])
  );
  return registry.coverageRequirements.map((requirement) => {
    const metric = metrics.get(requirement.coverageMetricId);
    if (metric === undefined) {
      throw new TypeError(
        "Coverage plan references a missing metric definition."
      );
    }
    return {
      ...requirement,
      metricVersion: metric.version,
      analysisUnit: metric.analysisUnit
    };
  });
}

/** Fail batch admission when an eligible assignment has no declared cells. */
export function assertPlaytestCoveragePlanCoversAssignments(input: {
  readonly registry: PlaytestMetricRegistry;
  readonly plan: readonly PlaytestCoveragePlanCell[];
  readonly assignments: readonly PlaytestBatchAssignment[];
}): void {
  for (const assignment of input.assignments) {
    for (const metric of input.registry.metricDefinitions) {
      if (
        metric.modality === "human-post-play" ||
        metric.aggregationWindow !== "phase" ||
        !metric.scenarioEligibility.includes(assignment.scenarioId)
      ) {
        continue;
      }
      const planned = input.plan.some(
        (cell) =>
          cell.coverageMetricId === metric.metricId &&
          cell.scenarioFamily === assignment.scenarioFamily &&
          cell.cohort === assignment.cohort &&
          cell.policy === assignment.policyId
      );
      if (!planned) {
        throw new TypeError(
          `Coverage plan omits eligible metric "${metric.metricId}" for assignment "${assignment.assignmentId}".`
        );
      }
    }
  }
}

function metricForEpisode(
  episode: PlaytestCoverageEpisode,
  metricId: string,
  phaseId: string | null
) {
  return episode.metrics.find(
    (metric) => metric.metricId === metricId && metric.phaseId === phaseId
  );
}

function coverageCellFor(params: {
  readonly plan: PlaytestCoveragePlanCell;
  readonly input: BuildPlaytestCoverageManifestInput;
  readonly assignmentEpisodes: ReadonlyMap<string, PlaytestCoverageEpisode>;
}): PlaytestCoverageManifestCell {
  const { plan, input, assignmentEpisodes } = params;
  const candidates = input.assignments.filter(
    (assignment) =>
      assignment.scenarioFamily === plan.scenarioFamily &&
      assignment.policyId === plan.policy &&
      (assignment.cohort === null || assignment.cohort === plan.cohort)
  );
  const unresolvedCohortAssignments = candidates.filter(
    (assignment) => assignment.cohort === null
  ).length;
  const matching = candidates.filter(
    (assignment) => assignment.cohort !== null
  );
  let observedEpisodes = 0;
  let missingAssignments = 0;
  let missingMetricResults = 0;
  let observedOpportunities = 0;
  let eligibleOpportunities = 0;
  let missingOpportunities = 0;
  let observedIndependentUnits = 0;
  const independentUnitsKnown = plan.analysisUnit === "episode";
  const missingReasons = new Set<PlaytestMissingReason>();

  for (const assignment of matching) {
    const episode = assignmentEpisodes.get(assignment.assignmentId);
    if (episode === undefined) {
      missingAssignments += 1;
      continue;
    }
    if (plan.unsupportedReason !== null) {
      observedEpisodes += 1;
      continue;
    }
    const result = metricForEpisode(
      episode,
      plan.coverageMetricId,
      plan.phaseId
    );
    if (result === undefined) {
      missingMetricResults += 1;
      continue;
    }
    observedEpisodes += 1;
    observedOpportunities = addCount(
      observedOpportunities,
      result.opportunityCount ?? 0,
      "opportunity count"
    );
    eligibleOpportunities = addCount(
      eligibleOpportunities,
      result.denominator,
      "eligible opportunity count"
    );
    missingOpportunities = addCount(
      missingOpportunities,
      result.missing,
      "missing opportunity count"
    );
    if (independentUnitsKnown) {
      observedIndependentUnits = addCount(
        observedIndependentUnits,
        result.independentUnits,
        "independent-unit count"
      );
    }
    for (const reason of result.missingReasons) missingReasons.add(reason);
  }

  let status: PlaytestCoverageManifestCell["status"];
  if (plan.unsupportedReason !== null) {
    status = "unsupported";
  } else if (plan.modality !== input.mode) {
    status = "unsupported-modality";
  } else if (matching.length + unresolvedCohortAssignments === 0) {
    status = "not-assigned";
  } else if (
    missingAssignments > 0 ||
    unresolvedCohortAssignments > 0 ||
    missingMetricResults > 0
  ) {
    status = "partial";
  } else if (
    observedOpportunities >= plan.requiredOpportunities &&
    independentUnitsKnown &&
    observedIndependentUnits >= plan.requiredIndependentUnits
  ) {
    status = "covered";
  } else {
    status = "insufficient";
  }

  return {
    coverageMetricId: plan.coverageMetricId,
    metricVersion: plan.metricVersion,
    mechanicKey: plan.mechanicKey,
    phaseId: plan.phaseId,
    scenarioFamily: plan.scenarioFamily,
    cohort: plan.cohort,
    policy: plan.policy,
    modality: plan.modality,
    analysisUnit: plan.analysisUnit,
    requiredOpportunities: plan.requiredOpportunities,
    requiredIndependentUnits: plan.requiredIndependentUnits,
    unsupportedReason: plan.unsupportedReason,
    assignedEpisodes: matching.length,
    observedEpisodes,
    missingAssignments,
    unresolvedCohortAssignments,
    missingMetricResults,
    observedOpportunities,
    eligibleOpportunities,
    missingOpportunities,
    observedIndependentUnits: independentUnitsKnown
      ? observedIndependentUnits
      : null,
    missingReasons: [...missingReasons].sort(),
    status
  };
}

/** Aggregate only matching frozen assignment cells and game-owned episode rows. */
export function buildPlaytestCoverageManifestDraft(
  input: BuildPlaytestCoverageManifestInput
): PlaytestCoverageManifestDraft {
  if (
    !SHA256_PATTERN.test(input.rubricHash) ||
    !SHA256_PATTERN.test(input.assignmentManifestHash) ||
    !isText(input.batchId) ||
    !isText(input.workspaceId) ||
    !BUILD_SHA_PATTERN.test(input.buildSha) ||
    !Number.isFinite(Date.parse(input.generatedAt)) ||
    !Array.isArray(input.plan) ||
    input.plan.length === 0 ||
    input.plan.length > 256
  ) {
    throw new TypeError("Playtest coverage manifest inputs are invalid.");
  }
  const assignmentById = new Map<string, PlaytestBatchAssignment>();
  for (const assignment of input.assignments) {
    if (assignmentById.has(assignment.assignmentId)) {
      throw new TypeError("Coverage assignments must have unique IDs.");
    }
    assignmentById.set(assignment.assignmentId, assignment);
  }
  if (assignmentById.size === 0 || assignmentById.size > 1000) {
    throw new RangeError("Coverage requires between 1 and 1,000 assignments.");
  }
  const assignmentEpisodes = new Map<string, PlaytestCoverageEpisode>();
  const episodeIds = new Set<string>();
  for (const episode of input.episodes) {
    const assignmentId = episode.assignmentId;
    const assignment =
      assignmentId === null ? undefined : assignmentById.get(assignmentId);
    if (
      assignmentId === null ||
      assignment === undefined ||
      assignmentEpisodes.has(assignmentId) ||
      !isText(episode.episodeId) ||
      episodeIds.has(episode.episodeId) ||
      episode.batchId !== input.batchId ||
      episode.identity.workspaceId !== input.workspaceId ||
      episode.identity.buildSha !== input.buildSha ||
      episode.identity.scenarioId !== assignment.scenarioId ||
      episode.identity.policyId !== assignment.policyId ||
      episode.identity.policyVersion !== assignment.policyVersion ||
      episode.identity.seed !== assignment.seed ||
      episode.scenarioFamily !== assignment.scenarioFamily ||
      (assignment.cohort !== null && episode.policyCohort !== assignment.cohort)
    ) {
      throw new TypeError(
        "Coverage episode does not match its frozen assignment."
      );
    }
    assignmentEpisodes.set(assignmentId, episode);
    episodeIds.add(episode.episodeId);
  }
  const cells = input.plan.map((plan) =>
    coverageCellFor({
      plan,
      input,
      assignmentEpisodes
    })
  );
  const identities = new Set(cells.map(cellIdentity));
  if (identities.size !== cells.length) {
    throw new TypeError("Coverage plan cells must have unique identities.");
  }
  return {
    schema: PLAYTESTS_COVERAGE_MANIFEST_SCHEMA,
    workspaceId: input.workspaceId,
    batchId: input.batchId,
    buildSha: input.buildSha.toLowerCase(),
    rubricHash: input.rubricHash.toLowerCase(),
    assignmentManifestHash: input.assignmentManifestHash.toLowerCase(),
    mode: input.mode,
    generatedAt: new Date(input.generatedAt).toISOString(),
    assignedEpisodes: assignmentById.size,
    observedEpisodes: assignmentEpisodes.size,
    cells
  };
}

function assertCoverageManifestIdentity(value: Record<string, unknown>): void {
  if (
    Object.keys(value).length !== MANIFEST_KEYS.size ||
    Object.keys(value).some((key) => !MANIFEST_KEYS.has(key)) ||
    value.schema !== PLAYTESTS_COVERAGE_MANIFEST_SCHEMA ||
    !isText(value.workspaceId) ||
    !isText(value.batchId) ||
    typeof value.buildSha !== "string" ||
    !BUILD_SHA_PATTERN.test(value.buildSha) ||
    typeof value.rubricHash !== "string" ||
    !SHA256_PATTERN.test(value.rubricHash) ||
    typeof value.assignmentManifestHash !== "string" ||
    !SHA256_PATTERN.test(value.assignmentManifestHash) ||
    !PLAYTESTS_COVERAGE_MODALITIES.slice(0, 3).includes(
      value.mode as PlaytestCoverageModality
    ) ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt)) ||
    !isCount(value.assignedEpisodes) ||
    (value.assignedEpisodes as number) < 1 ||
    (value.assignedEpisodes as number) > 1000 ||
    !isCount(value.observedEpisodes) ||
    (value.observedEpisodes as number) > (value.assignedEpisodes as number) ||
    !Array.isArray(value.cells) ||
    value.cells.length === 0 ||
    value.cells.length > 256 ||
    typeof value.contentHash !== "string" ||
    !SHA256_PATTERN.test(value.contentHash)
  ) {
    throw new TypeError("Playtest coverage manifest identity is malformed.");
  }
}

function assertCoverageCellShape(
  value: unknown
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== CELL_KEYS.size ||
    Object.keys(value).some((key) => !CELL_KEYS.has(key))
  ) {
    throw new TypeError("Playtest coverage manifest cell is malformed.");
  }
}

function coverageCellStatus(
  cell: PlaytestCoverageManifestCell,
  mode: string
): PlaytestCoverageManifestCell["status"] {
  if (cell.unsupportedReason !== null) return "unsupported";
  if (cell.modality !== mode) return "unsupported-modality";
  if (cell.assignedEpisodes + cell.unresolvedCohortAssignments === 0) {
    return "not-assigned";
  }
  if (
    cell.missingAssignments > 0 ||
    cell.unresolvedCohortAssignments > 0 ||
    cell.missingMetricResults > 0
  ) {
    return "partial";
  }
  if (
    cell.observedOpportunities >= cell.requiredOpportunities &&
    cell.observedIndependentUnits !== null &&
    cell.observedIndependentUnits >= cell.requiredIndependentUnits
  ) {
    return "covered";
  }
  return "insufficient";
}

function assertCoverageCellCounts(
  cell: PlaytestCoverageManifestCell,
  mode: string
): void {
  const outcomeCounts =
    cell.observedEpisodes + cell.missingAssignments + cell.missingMetricResults;
  const independentUnitsInvalid =
    cell.analysisUnit === "episode"
      ? cell.observedIndependentUnits === null ||
        cell.observedIndependentUnits > cell.observedEpisodes
      : cell.observedIndependentUnits !== null;
  if (
    cell.observedEpisodes > cell.assignedEpisodes ||
    cell.missingAssignments > cell.assignedEpisodes ||
    cell.missingMetricResults > cell.assignedEpisodes ||
    outcomeCounts > cell.assignedEpisodes ||
    cell.eligibleOpportunities + cell.missingOpportunities >
      cell.observedOpportunities ||
    independentUnitsInvalid ||
    (cell.unsupportedReason === null &&
      (cell.requiredOpportunities < 1 || cell.requiredIndependentUnits < 1)) ||
    cell.status !== coverageCellStatus(cell, mode)
  ) {
    throw new TypeError(
      "Playtest coverage manifest cell counts are inconsistent."
    );
  }
}

function assertCoverageCell(
  value: unknown,
  mode: string,
  identities: Set<string>
): void {
  assertCoverageCellShape(value);
  const cell = value as unknown as PlaytestCoverageManifestCell;
  if (
    !isText(cell.coverageMetricId) ||
    !Number.isSafeInteger(cell.metricVersion) ||
    cell.metricVersion < 1 ||
    !isText(cell.mechanicKey) ||
    (cell.phaseId !== null && !isText(cell.phaseId)) ||
    !isText(cell.scenarioFamily) ||
    !isText(cell.cohort) ||
    !isText(cell.policy) ||
    !PLAYTESTS_COVERAGE_MODALITIES.includes(cell.modality) ||
    !ANALYSIS_UNITS.has(cell.analysisUnit) ||
    !isCount(cell.requiredOpportunities) ||
    !isCount(cell.requiredIndependentUnits) ||
    (cell.unsupportedReason !== null &&
      (!isText(cell.unsupportedReason) ||
        cell.unsupportedReason.length > 256)) ||
    !isCount(cell.assignedEpisodes) ||
    !isCount(cell.observedEpisodes) ||
    !isCount(cell.missingAssignments) ||
    !isCount(cell.unresolvedCohortAssignments) ||
    !isCount(cell.missingMetricResults) ||
    !isCount(cell.observedOpportunities) ||
    !isCount(cell.eligibleOpportunities) ||
    !isCount(cell.missingOpportunities) ||
    (cell.observedIndependentUnits !== null &&
      !isCount(cell.observedIndependentUnits)) ||
    !Array.isArray(cell.missingReasons) ||
    cell.missingReasons.some(
      (reason) =>
        typeof reason !== "string" ||
        !(PLAYTESTS_MISSING_REASONS as readonly string[]).includes(reason)
    ) ||
    !CELL_STATUSES.has(cell.status)
  ) {
    throw new TypeError("Playtest coverage manifest cell fields are invalid.");
  }
  const identity = cellIdentity(cell);
  if (identities.has(identity)) {
    throw new TypeError("Playtest coverage manifest cells are duplicated.");
  }
  identities.add(identity);
  assertCoverageCellCounts(cell, mode);
}

/** Validate structure and counts; Data verifies the content-addressed hash. */
export function assertPlaytestCoverageManifest(
  value: unknown
): asserts value is PlaytestCoverageManifest {
  if (!isRecord(value)) {
    throw new TypeError("Playtest coverage manifest must be an object.");
  }
  assertCoverageManifestIdentity(value);
  const identities = new Set<string>();
  for (const cell of value.cells as unknown[]) {
    assertCoverageCell(cell, value.mode as string, identities);
  }
}
