/**
 * Canonical batch-run contract: one ordered, bounded assignment inventory per
 * server-generated batch, deterministic aggregate denominators, and the
 * frozen surveillance/discovery critique selection built from that inventory.
 *
 * Pure and infrastructure-free. Runtime executes assignments and computes the
 * SHA-256 of {@link playtestAssignmentManifestHashInput}; Data re-verifies it.
 */

import type {
  PlaytestBatchState,
  PlaytestBenchmark,
  PlaytestGameOutcomeKind
} from "./artifacts.ts";
import { assertPlaytestAssignmentBranch } from "./branching.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";
import {
  groupByStratum,
  samplePlaytestDiscovery,
  samplePlaytestSurveillance
} from "./sampling.ts";
import {
  type PlaytestAssignmentManifest,
  type PlaytestAssignmentOutcome,
  type PlaytestAssignmentTerminalState,
  type PlaytestBatchAssignment,
  type PlaytestCompletionCounts,
  type PlaytestDiscoverySelection,
  type PlaytestDiscoverySignal,
  type PlaytestNumericResult,
  type PlaytestReviewSelection,
  PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA,
  PLAYTESTS_REVIEW_SELECTION_SCHEMA,
  PLAYTESTS_REVIEW_STRATIFICATION,
  type PlaytestSelectedReviewSession,
  type PlaytestSurveillanceSelection
} from "./types.ts";

/** First-milestone bound: one batch freezes at most 1,000 assignments. */
export const PLAYTESTS_MAX_BATCH_ASSIGNMENTS = 1000;

/** First-milestone maximum complete sessions reviewed per batch. */
export const PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS = 40;

/**
 * Bound on one explicit Console analyst dispatch. It cannot exceed the
 * preregistered per-batch critique ceiling.
 */
export const PLAYTESTS_MAX_ANALYSIS_SESSIONS =
  PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS;

/**
 * Prepared cross-session MCP reads return complete packets in one response;
 * keep that transport bound separate from Console dispatch, which returns
 * packet identifiers and lets the analyst read packets one at a time.
 */
export const PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS = 16;
export const PLAYTESTS_MAX_ASSIGNMENT_MANIFEST_BYTES = 256 * 1024;
export const PLAYTESTS_ASSIGNMENT_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const MAX_ASSIGNMENT_TEXT = 256;
const MAX_ASSIGNMENT_STEPS = 100_000;
const SHA256_PATTERN = /^[a-f\d]{64}$/u;

function isText(value: unknown, maximum = MAX_ASSIGNMENT_TEXT): boolean {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  );
}

/**
 * Reject malformed, oversized, duplicate-ID or duplicate-content inventories.
 * Identical seed text under different policies/scenarios is a valid paired
 * design; an exact repeated (scenario, policy, version, seed) cell is not.
 */
export function assertPlaytestBatchAssignments(
  assignments: readonly PlaytestBatchAssignment[],
  allowUnresolvedCohorts = false
): void {
  if (
    !Array.isArray(assignments) ||
    assignments.length === 0 ||
    assignments.length > PLAYTESTS_MAX_BATCH_ASSIGNMENTS
  ) {
    throw new RangeError(
      "A playtest batch requires between 1 and " +
        String(PLAYTESTS_MAX_BATCH_ASSIGNMENTS) +
        " assignments."
    );
  }
  const ids = new Set<string>();
  const cells = new Set<string>();
  for (const assignment of assignments) {
    if (
      typeof assignment.assignmentId !== "string" ||
      !PLAYTESTS_ASSIGNMENT_ID_PATTERN.test(assignment.assignmentId) ||
      !isText(assignment.scenarioId) ||
      !isText(assignment.scenarioFamily) ||
      !isText(assignment.policyId) ||
      !isText(assignment.policyVersion) ||
      (!isText(assignment.cohort) &&
        (!allowUnresolvedCohorts || assignment.cohort !== null)) ||
      !isText(assignment.seed) ||
      !Number.isSafeInteger(assignment.maxSteps) ||
      assignment.maxSteps < 1 ||
      assignment.maxSteps > MAX_ASSIGNMENT_STEPS
    ) {
      throw new TypeError("A playtest batch assignment is malformed.");
    }
    if (ids.has(assignment.assignmentId)) {
      throw new TypeError(
        "Duplicate playtest assignment id: " + assignment.assignmentId + "."
      );
    }
    ids.add(assignment.assignmentId);
    if (assignment.branch !== undefined) {
      assertPlaytestAssignmentBranch(assignment.branch);
    }
    const cell = canonicalPlaytestJson([
      assignment.scenarioId,
      assignment.policyId,
      assignment.policyVersion,
      assignment.seed,
      assignment.branch ?? null
    ]);
    if (cells.has(cell)) {
      throw new TypeError(
        "Duplicate playtest assignment content for assignment " +
          assignment.assignmentId +
          "."
      );
    }
    cells.add(cell);
  }
}

/** Require every assignment cell to belong to the frozen target benchmark. */
export function assertPlaytestAssignmentsMatchBenchmark(
  assignments: readonly PlaytestBatchAssignment[],
  benchmark: PlaytestBenchmark
): void {
  assertPlaytestBatchAssignments(assignments);
  const scenarios = new Map(
    benchmark.scenarioInventory.map((scenario) => [
      scenario.scenarioId,
      scenario.family
    ])
  );
  const seeds = new Set(benchmark.seedInventory.map((entry) => entry.seed));
  for (const assignment of assignments) {
    if (scenarios.get(assignment.scenarioId) !== assignment.scenarioFamily) {
      throw new TypeError(
        "Batch assignment scenario/family does not match the frozen benchmark inventory."
      );
    }
    if (
      benchmark.policyVersions[assignment.policyId] !== assignment.policyVersion
    ) {
      throw new TypeError(
        "Batch assignment policy version does not match the frozen benchmark inventory."
      );
    }
    if (!seeds.has(assignment.seed)) {
      throw new TypeError(
        "Batch assignment seed is not present in the frozen benchmark inventory."
      );
    }
  }
}

/**
 * Runtime-owned persisted episode identity: unique per frozen batch
 * assignment. A game's own episode id is only its protocol handle -- games may
 * derive it from the seed, so it repeats across builds and batches and must
 * never key persisted evidence.
 */
export function playtestEpisodeRecordId(
  batchId: string,
  assignmentId: string
): string {
  return batchId + "." + assignmentId;
}

/** Canonical hash projection; excludes only contentHash. */
export function playtestAssignmentManifestHashInput(
  manifest: Omit<PlaytestAssignmentManifest, "contentHash">
): string {
  const hashable = { ...manifest } as Record<string, unknown>;
  delete hashable.contentHash;
  return canonicalPlaytestJson(hashable);
}

/** Structural manifest validation; callers separately verify the SHA-256. */
export function assertPlaytestAssignmentManifest(
  value: unknown
): asserts value is PlaytestAssignmentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Assignment manifest must be an object.");
  }
  const manifest = value as Partial<PlaytestAssignmentManifest>;
  const keys = [
    "schema",
    "batchId",
    "workspaceId",
    "buildSha",
    "configHash",
    "rubricHash",
    "approvalRevision",
    "createdAt",
    "assignments",
    "contentHash"
  ];
  if (
    Object.keys(manifest).length !== keys.length ||
    Object.keys(manifest).some((key) => !keys.includes(key)) ||
    manifest.schema !== PLAYTESTS_ASSIGNMENT_MANIFEST_SCHEMA ||
    !isText(manifest.batchId, 128) ||
    !isText(manifest.workspaceId) ||
    !isText(manifest.buildSha) ||
    !isText(manifest.configHash) ||
    !isText(manifest.rubricHash) ||
    !Number.isSafeInteger(manifest.approvalRevision) ||
    (manifest.approvalRevision as number) < 1 ||
    typeof manifest.createdAt !== "string" ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    typeof manifest.contentHash !== "string" ||
    !SHA256_PATTERN.test(manifest.contentHash)
  ) {
    throw new TypeError("Assignment manifest is malformed.");
  }
  assertPlaytestBatchAssignments(
    manifest.assignments as readonly PlaytestBatchAssignment[],
    true
  );
  const manifestBytes = new TextEncoder().encode(
    playtestAssignmentManifestHashInput(
      manifest as Omit<PlaytestAssignmentManifest, "contentHash">
    )
  ).byteLength;
  if (manifestBytes > PLAYTESTS_MAX_ASSIGNMENT_MANIFEST_BYTES) {
    throw new RangeError(
      "Playtest assignment manifest exceeds its durable storage bound."
    );
  }
}

/**
 * Nine batch denominators from terminal assignment outcomes. Unfinished
 * assignments count only as assigned; instrumentation gaps are never losses.
 */
export function playtestBatchCountsFromAssignments(input: {
  readonly assignmentCount: number;
  readonly outcomes: readonly PlaytestAssignmentOutcome[];
  readonly reviewed: number;
}): PlaytestCompletionCounts {
  const { assignmentCount, outcomes, reviewed } = input;
  if (
    !Number.isSafeInteger(assignmentCount) ||
    assignmentCount < 1 ||
    outcomes.length > assignmentCount ||
    new Set(outcomes.map((outcome) => outcome.assignmentId)).size !==
      outcomes.length ||
    !Number.isSafeInteger(reviewed) ||
    reviewed < 0
  ) {
    throw new RangeError("Batch assignment outcomes are inconsistent.");
  }
  const count = (state: PlaytestAssignmentTerminalState): number =>
    outcomes.filter((outcome) => outcome.state === state).length;
  const eligible = outcomes.filter((outcome) => outcome.eligible).length;
  if (
    reviewed > outcomes.filter((outcome) => outcome.episodeId !== null).length
  ) {
    throw new RangeError("Reviewed sessions exceed the terminal inventory.");
  }
  return {
    assigned: assignmentCount,
    started: outcomes.filter((outcome) => outcome.started).length,
    completed: count("completed"),
    crashed: count("crashed"),
    infrastructureFailed: count("infrastructure-failed"),
    cancelled: count("cancelled"),
    budgetTruncated: count("budget-truncated"),
    reviewed,
    eligible
  };
}

/**
 * Terminal batch execution state. Game crashes and losses complete a batch;
 * cancellation/revocation, an aborted owner or an all-infrastructure failure
 * do not. Budget truncation is preserved as truncated.
 */
export function playtestBatchTerminalState(input: {
  readonly assignmentCount: number;
  readonly outcomes: readonly PlaytestAssignmentOutcome[];
  readonly cancelled: boolean;
  readonly aborted: boolean;
}): Exclude<PlaytestBatchState, "queued" | "running"> {
  if (input.cancelled) return "cancelled";
  if (
    input.aborted ||
    input.outcomes.length !== input.assignmentCount ||
    input.outcomes.every((outcome) => outcome.state === "infrastructure-failed")
  ) {
    return "failed";
  }
  if (input.outcomes.some((outcome) => outcome.state === "budget-truncated")) {
    return "truncated";
  }
  return "completed";
}

/** Batch-stable selection seed derived only from the frozen inventory hash. */
export function playtestReviewSelectionSeed(inventoryHash: string): string {
  if (!SHA256_PATTERN.test(inventoryHash)) {
    throw new TypeError("Review selection requires a frozen inventory hash.");
  }
  return "review-selection:" + inventoryHash;
}

/** Outcome stratum: completed sessions split by game outcome; others by state. */
export function playtestReviewOutcomeKey(
  state: PlaytestAssignmentTerminalState,
  outcome: PlaytestGameOutcomeKind
): string {
  return state === "completed" ? "completed:" + outcome : state;
}

/** One reviewable session (assignment with a persisted episode). */
export interface PlaytestReviewCandidate {
  readonly assignmentId: string;
  readonly episodeId: string;
  readonly policyId: string;
  readonly scenarioId: string;
  readonly outcomeKey: string;
  readonly metrics: readonly PlaytestNumericResult[];
}

export interface PlaytestReviewSelectionInput {
  readonly inventoryHash: string;
  readonly maxReviewedSessions: number;
  readonly critiqueBudget: number;
  readonly surveillanceSessions: number;
  readonly discoverySessions: number;
  readonly discoverySignal: PlaytestDiscoverySignal | null;
  readonly candidates: readonly PlaytestReviewCandidate[];
  readonly unreviewableAssignments: number;
  readonly selectedAt: string;
}

function stratumKey(candidate: PlaytestReviewCandidate): string {
  return canonicalPlaytestJson([
    candidate.policyId,
    candidate.scenarioId,
    candidate.outcomeKey
  ]);
}

function signalValue(
  candidate: PlaytestReviewCandidate,
  signal: PlaytestDiscoverySignal
): number | null {
  const metric = candidate.metrics.find(
    (result) =>
      result.metricId === signal.metricId &&
      String(result.metricVersion) === String(signal.version)
  );
  return metric?.estimate !== null &&
    metric?.estimate !== undefined &&
    Number.isFinite(metric.estimate)
    ? metric.estimate
    : null;
}

function surveillanceSelection(
  candidates: readonly PlaytestReviewCandidate[],
  budget: number,
  seed: string
): PlaytestSurveillanceSelection {
  if (budget === 0) return { status: "disabled", budget: 0 };
  const members = candidates.map((candidate) => ({
    id: candidate.assignmentId,
    stratumKey: stratumKey(candidate)
  }));
  const nonEmptyStrata = groupByStratum(members).length;
  if (nonEmptyStrata > budget) {
    return {
      status: "rejected",
      reason: "over-stratified",
      budget,
      nonEmptyStrata
    };
  }
  return {
    status: "selected",
    sample: samplePlaytestSurveillance(members, budget, seed)
  };
}

function discoverySelection(input: {
  readonly remaining: readonly PlaytestReviewCandidate[];
  readonly budget: number;
  readonly signal: PlaytestDiscoverySignal | null;
  readonly seed: string;
}): {
  readonly selection: PlaytestDiscoverySelection;
  readonly values: ReadonlyMap<string, number>;
} {
  const { remaining, budget, signal, seed } = input;
  const values = new Map<string, number>();
  if (budget === 0) {
    return { selection: { status: "disabled", budget: 0 }, values };
  }
  if (signal === null) {
    return {
      selection: {
        status: "unavailable",
        reason: "no-approved-signal",
        budget,
        signal: null
      },
      values
    };
  }
  if (remaining.length === 0) {
    return {
      selection: {
        status: "unavailable",
        reason: "no-remaining-sessions",
        budget,
        signal
      },
      values
    };
  }
  for (const candidate of remaining) {
    const value = signalValue(candidate, signal);
    if (value !== null) values.set(candidate.assignmentId, value);
  }
  if (values.size === 0) {
    return {
      selection: {
        status: "unavailable",
        reason: "signal-not-observed",
        budget,
        signal
      },
      values
    };
  }
  const sample = samplePlaytestDiscovery(
    Array.from(values, ([id, value]) => ({
      id,
      anomalyScore: signal.direction === "higher-first" ? value : -value
    })),
    budget,
    seed + ":discovery",
    signal.metricId + "@v" + String(signal.version) + ":" + signal.direction
  );
  return {
    selection: {
      status: "selected",
      signal,
      sample,
      rankedCandidates: values.size,
      unobservedCandidates: remaining.length - values.size
    },
    values
  };
}

/**
 * Freeze the per-batch critique selection: seeded surveillance within policy x
 * scenario x outcome strata (with inclusion probabilities), then discovery
 * ranked only by the named, versioned evaluator signal over the remaining
 * sessions. Surveillance IDs are excluded before discovery.
 */
export function selectPlaytestBatchReviews(
  input: PlaytestReviewSelectionInput
): PlaytestReviewSelection {
  const reviewCap = Math.min(input.maxReviewedSessions, input.critiqueBudget);
  if (
    ![
      input.maxReviewedSessions,
      input.critiqueBudget,
      input.surveillanceSessions,
      input.discoverySessions,
      input.unreviewableAssignments
    ].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    input.surveillanceSessions + input.discoverySessions >
      input.maxReviewedSessions ||
    input.maxReviewedSessions > input.critiqueBudget
  ) {
    throw new RangeError(
      "Review budgets must satisfy surveillance + discovery <= maxReviewedSessions <= approved critique budget."
    );
  }
  if (reviewCap > PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS) {
    throw new RangeError(
      "A playtest batch may select at most " +
        String(PLAYTESTS_MAX_BATCH_REVIEW_SESSIONS) +
        " complete-session critiques."
    );
  }
  if (Number.isNaN(Date.parse(input.selectedAt))) {
    throw new TypeError("Review selection requires a valid timestamp.");
  }
  const ids = new Set<string>();
  const episodes = new Set<string>();
  for (const candidate of input.candidates) {
    if (
      !PLAYTESTS_ASSIGNMENT_ID_PATTERN.test(candidate.assignmentId) ||
      !isText(candidate.episodeId) ||
      ids.has(candidate.assignmentId) ||
      episodes.has(candidate.episodeId)
    ) {
      throw new TypeError(
        "Review candidates must be unique frozen assignments with episodes."
      );
    }
    ids.add(candidate.assignmentId);
    episodes.add(candidate.episodeId);
  }
  const seed = playtestReviewSelectionSeed(input.inventoryHash);
  const surveillance = surveillanceSelection(
    input.candidates,
    input.surveillanceSessions,
    seed
  );
  const surveillanceIds = new Set(
    surveillance.status === "selected" ? surveillance.sample.selected : []
  );
  const remaining = input.candidates.filter(
    (candidate) => !surveillanceIds.has(candidate.assignmentId)
  );
  const discovery = discoverySelection({
    remaining,
    budget: input.discoverySessions,
    signal: input.discoverySignal,
    seed
  });
  const byId = new Map(
    input.candidates.map((candidate) => [candidate.assignmentId, candidate])
  );
  const probabilities = new Map(
    surveillance.status === "selected"
      ? surveillance.sample.allocations.map((allocation) => [
          allocation.stratumKey,
          allocation.inclusionProbability
        ])
      : []
  );
  const selected: PlaytestSelectedReviewSession[] = [];
  for (const assignmentId of surveillanceIds) {
    const candidate = byId.get(assignmentId)!;
    const key = stratumKey(candidate);
    selected.push({
      assignmentId,
      episodeId: candidate.episodeId,
      stream: "surveillance",
      stratumKey: key,
      inclusionProbability: probabilities.get(key) ?? null,
      discoveryRank: null,
      signalValue: null
    });
  }
  if (discovery.selection.status === "selected") {
    discovery.selection.sample.selected.forEach((assignmentId, index) => {
      const candidate = byId.get(assignmentId)!;
      selected.push({
        assignmentId,
        episodeId: candidate.episodeId,
        stream: "discovery",
        stratumKey: stratumKey(candidate),
        inclusionProbability: null,
        discoveryRank: index + 1,
        signalValue: discovery.values.get(assignmentId) ?? null
      });
    });
  }
  return {
    schema: PLAYTESTS_REVIEW_SELECTION_SCHEMA,
    status: "selected",
    inventoryHash: input.inventoryHash,
    seed,
    stratification: PLAYTESTS_REVIEW_STRATIFICATION,
    maxReviewedSessions: input.maxReviewedSessions,
    critiqueBudget: input.critiqueBudget,
    reviewCap,
    reviewablePopulation: input.candidates.length,
    unreviewableAssignments: input.unreviewableAssignments,
    surveillance,
    discovery: discovery.selection,
    selected,
    selectedAt: input.selectedAt
  };
}

/** Distinct policy x scenario cells known before execution (outcome unknown). */
export function playtestAssignmentStrataLowerBound(
  assignments: readonly PlaytestBatchAssignment[]
): number {
  return new Set(
    assignments.map((assignment) =>
      canonicalPlaytestJson([assignment.policyId, assignment.scenarioId])
    )
  ).size;
}
