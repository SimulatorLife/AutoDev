/**
 * PlaytestExperiment contract and state lifecycle (measurement-contract §5).
 *
 * An experiment manifest freezes an approved baseline/treatment pair,
 * allocation, inventories, analysis plan and budget before any outcome
 * exists. This module owns two things only: strict runtime validation of
 * that frozen shape, and the explicit state machine that governs how an
 * experiment's state may change over time. It never computes metrics,
 * comparisons or owner decisions -- those stay in comparison.ts; an
 * owner-decided experiment is only as trustworthy as the comparison it
 * references, which this module requires but does not produce.
 *
 * Every transition is a pure function: given a frozen experiment and a
 * requested next state, it either throws (illegal transition, unknown
 * state, missing required field, duplicate attempt/comparison/decision) or
 * returns a brand-new, version-incremented experiment object. Nothing is
 * mutated in place and nothing is ever deleted; a denied, cancelled,
 * execution-failed or inconclusive attempt remains a permanently visible
 * record, not a silently retried draft. A game failure moves an experiment
 * to the terminal execution-failed state as an observation; it is never
 * automatically re-queued into running.
 */

import type { PlaytestExperiment } from "./artifacts.ts";
import { isPlaytestFindingId } from "./finding-identity.ts";
import {
  PLAYTESTS_EXPERIMENT_SCHEMA,
  PLAYTESTS_EXPERIMENT_STATES,
  type PlaytestExperimentState,
  type PlaytestVersionedRef
} from "./types.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";

const EXPOSURE_UNITS = [
  "episode",
  "learner",
  "participant",
  "cluster"
] as const;
const SHA256_PATTERN = /^[a-f\d]{64}$/iu;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectWithKeys(
  value: unknown,
  keys: readonly string[],
  field: string
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(field + " must be an object.");
  const allowed = new Set(keys);
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !allowed.has(key))
  ) {
    throw new TypeError(field + " must have exactly its specified fields.");
  }
  return value;
}

function nonEmptyString(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(field + " must be a non-empty string.");
  }
}

/**
 * Canonical hash input for the immutable experiment design. Lifecycle state,
 * revision, attempts, comparison and owner decision are excluded: they are
 * append-only revisions of one frozen assignment/analysis plan.
 */
export function playtestExperimentHashInput(
  experiment: PlaytestExperiment
): string {
  return canonicalPlaytestJson({
    schema: experiment.schema,
    experimentId: experiment.experimentId,
    workspaceId: experiment.workspaceId,
    findingIds: experiment.findingIds,
    hypothesis: experiment.hypothesis,
    falsifier: experiment.falsifier,
    alternativeExplanations: experiment.alternativeExplanations,
    benchmarkId: experiment.benchmarkId,
    baseline: experiment.baseline,
    treatment: experiment.treatment,
    approvalId: experiment.approvalId,
    exposureUnit: experiment.exposureUnit,
    allocationSeed: experiment.allocationSeed,
    allocationMethod: experiment.allocationMethod,
    cohort: experiment.cohort,
    memoryInitialization: experiment.memoryInitialization,
    pairMap: experiment.pairMap,
    assignmentMap: experiment.assignmentMap,
    discoveryInventory: experiment.discoveryInventory,
    confirmationInventory: experiment.confirmationInventory,
    primaryMetricId: experiment.primaryMetricId,
    guardrailMetricIds: experiment.guardrailMetricIds,
    analysisPlan: experiment.analysisPlan,
    missingnessPlan: experiment.missingnessPlan,
    multiplicityPlan: experiment.multiplicityPlan,
    budget: experiment.budget,
    stoppingRule: experiment.stoppingRule,
    createdAt: experiment.createdAt
  });
}

function nullableNonEmptyString(
  value: unknown,
  field: string
): asserts value is string | null {
  if (value === null) return;
  nonEmptyString(value, field);
}

function positiveInteger(
  value: unknown,
  field: string
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(field + " must be a positive integer.");
  }
}

function uniqueStringArray(
  value: unknown,
  field: string,
  options?: { readonly allowEmpty?: boolean }
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0
    )
  ) {
    throw new TypeError(field + " must be an array of non-empty strings.");
  }
  if (!(options?.allowEmpty ?? false) && value.length === 0) {
    throw new TypeError(field + " must not be empty.");
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(field + " entries must be unique.");
  }
}

function stringRecord(
  value: unknown,
  field: string
): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new TypeError(field + " must be an object.");
  for (const [key, entry] of Object.entries(value)) {
    if (key.trim().length === 0) {
      throw new TypeError(field + " keys must be non-empty.");
    }
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(field + "." + key + " must be a non-empty string.");
    }
  }
  return value as Readonly<Record<string, string>>;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function assertVersionedRef(
  value: unknown,
  field: string
): asserts value is PlaytestVersionedRef {
  if (!isRecord(value)) throw new TypeError(field + " must be an object.");
  const allowed = new Set(["id", "version", "contentHash"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(field + " contains an unsupported field.");
  }
  nonEmptyString(value.id, field + ".id");
  if (typeof value.version !== "number" && typeof value.version !== "string") {
    throw new TypeError(field + ".version must be a number or string.");
  }
  if (value.contentHash !== undefined) {
    nonEmptyString(value.contentHash, field + ".contentHash");
  }
}

const EXPERIMENT_FIELDS = [
  "schema",
  "experimentId",
  "version",
  "workspaceId",
  "findingIds",
  "hypothesis",
  "falsifier",
  "alternativeExplanations",
  "benchmarkId",
  "baseline",
  "treatment",
  "approvalId",
  "exposureUnit",
  "allocationSeed",
  "allocationMethod",
  "cohort",
  "memoryInitialization",
  "pairMap",
  "assignmentMap",
  "discoveryInventory",
  "confirmationInventory",
  "primaryMetricId",
  "guardrailMetricIds",
  "analysisPlan",
  "missingnessPlan",
  "multiplicityPlan",
  "budget",
  "stoppingRule",
  "state",
  "attemptIds",
  "comparisonId",
  "ownerDecision",
  "rollbackRefs",
  "createdAt",
  "contentHash"
] as const;

const BUDGET_FIELDS = [
  "maxAssignments",
  "maxCritiques",
  "maxWallTimeMs"
] as const;

/**
 * Strictly validate the full, frozen PlaytestExperiment manifest shape:
 * immutable identity, baseline/treatment artifact identity, allocation
 * (pair map and per-unit arm assignment), discovery/confirmation
 * inventories, analysis plan and budget. This is the only gate between an
 * untrusted record and a trusted PlaytestExperiment; every field is
 * checked, not just the ones a particular caller happens to read.
 */
export function assertPlaytestExperiment(
  value: unknown
): asserts value is PlaytestExperiment {
  const experiment = objectWithKeys(
    value,
    EXPERIMENT_FIELDS,
    "PlaytestExperiment"
  );

  if (experiment.schema !== PLAYTESTS_EXPERIMENT_SCHEMA) {
    throw new TypeError(
      `PlaytestExperiment.schema must be "${PLAYTESTS_EXPERIMENT_SCHEMA}".`
    );
  }
  nonEmptyString(experiment.experimentId, "PlaytestExperiment.experimentId");
  positiveInteger(experiment.version, "PlaytestExperiment.version");
  nonEmptyString(experiment.workspaceId, "PlaytestExperiment.workspaceId");
  uniqueStringArray(experiment.findingIds, "PlaytestExperiment.findingIds");
  if (!experiment.findingIds.every(isPlaytestFindingId)) {
    throw new TypeError(
      "PlaytestExperiment.findingIds must contain canonical stable finding IDs."
    );
  }
  nonEmptyString(experiment.hypothesis, "PlaytestExperiment.hypothesis");
  nonEmptyString(experiment.falsifier, "PlaytestExperiment.falsifier");
  uniqueStringArray(
    experiment.alternativeExplanations,
    "PlaytestExperiment.alternativeExplanations"
  );
  nonEmptyString(experiment.benchmarkId, "PlaytestExperiment.benchmarkId");

  assertVersionedRef(experiment.baseline, "PlaytestExperiment.baseline");
  assertVersionedRef(experiment.treatment, "PlaytestExperiment.treatment");
  if (experiment.baseline.id === experiment.treatment.id) {
    throw new TypeError(
      "PlaytestExperiment baseline and treatment must be distinct approved artifacts."
    );
  }

  nullableNonEmptyString(
    experiment.approvalId,
    "PlaytestExperiment.approvalId"
  );
  if (!EXPOSURE_UNITS.includes(experiment.exposureUnit as never)) {
    throw new TypeError(
      "PlaytestExperiment.exposureUnit has an unsupported value."
    );
  }
  nonEmptyString(
    experiment.allocationSeed,
    "PlaytestExperiment.allocationSeed"
  );
  nonEmptyString(
    experiment.allocationMethod,
    "PlaytestExperiment.allocationMethod"
  );
  nonEmptyString(experiment.cohort, "PlaytestExperiment.cohort");
  nonEmptyString(
    experiment.memoryInitialization,
    "PlaytestExperiment.memoryInitialization"
  );

  const pairMap = stringRecord(
    experiment.pairMap,
    "PlaytestExperiment.pairMap"
  );
  const assignmentMap = stringRecord(
    experiment.assignmentMap,
    "PlaytestExperiment.assignmentMap"
  );
  const assignmentArmOf = new Map(Object.entries(assignmentMap));

  uniqueStringArray(
    experiment.discoveryInventory,
    "PlaytestExperiment.discoveryInventory",
    { allowEmpty: true }
  );
  uniqueStringArray(
    experiment.confirmationInventory,
    "PlaytestExperiment.confirmationInventory"
  );
  const discoverySet = new Set(experiment.discoveryInventory);
  if (experiment.confirmationInventory.some((id) => discoverySet.has(id))) {
    throw new TypeError(
      "PlaytestExperiment discovery and confirmation inventories must be disjoint."
    );
  }
  const inventoryUnion = new Set([
    ...experiment.discoveryInventory,
    ...experiment.confirmationInventory
  ]);
  const assignmentIds = Object.keys(assignmentMap);
  if (
    assignmentIds.length !== inventoryUnion.size ||
    assignmentIds.some((id) => !inventoryUnion.has(id))
  ) {
    throw new TypeError(
      "PlaytestExperiment.assignmentMap must assign exactly the frozen discovery/confirmation inventory, nothing more and nothing fewer."
    );
  }
  if (
    Object.values(assignmentMap).some(
      (arm) => arm !== "baseline" && arm !== "treatment"
    )
  ) {
    throw new TypeError(
      'PlaytestExperiment.assignmentMap values must be "baseline" or "treatment".'
    );
  }
  for (const [unitId, pairedId] of Object.entries(pairMap)) {
    const unitArm = assignmentArmOf.get(unitId);
    const pairedArm = assignmentArmOf.get(pairedId);
    if (unitArm === undefined || pairedArm === undefined) {
      throw new TypeError(
        "PlaytestExperiment.pairMap entries must reference assigned units."
      );
    }
    if (unitArm === pairedArm) {
      throw new TypeError(
        "PlaytestExperiment.pairMap must pair units across different arms."
      );
    }
    if (pairMap[pairedId] !== unitId) {
      throw new TypeError("PlaytestExperiment.pairMap must be symmetric.");
    }
  }

  nonEmptyString(
    experiment.primaryMetricId,
    "PlaytestExperiment.primaryMetricId"
  );
  uniqueStringArray(
    experiment.guardrailMetricIds,
    "PlaytestExperiment.guardrailMetricIds",
    { allowEmpty: true }
  );
  if (experiment.guardrailMetricIds.includes(experiment.primaryMetricId)) {
    throw new TypeError(
      "PlaytestExperiment.primaryMetricId must not also be a guardrail metric."
    );
  }

  nonEmptyString(experiment.analysisPlan, "PlaytestExperiment.analysisPlan");
  nonEmptyString(
    experiment.missingnessPlan,
    "PlaytestExperiment.missingnessPlan"
  );
  nonEmptyString(
    experiment.multiplicityPlan,
    "PlaytestExperiment.multiplicityPlan"
  );

  const budget = objectWithKeys(
    experiment.budget,
    BUDGET_FIELDS,
    "PlaytestExperiment.budget"
  );
  positiveInteger(
    budget.maxAssignments,
    "PlaytestExperiment.budget.maxAssignments"
  );
  positiveInteger(
    budget.maxCritiques,
    "PlaytestExperiment.budget.maxCritiques"
  );
  positiveInteger(
    budget.maxWallTimeMs,
    "PlaytestExperiment.budget.maxWallTimeMs"
  );
  if (budget.maxAssignments !== assignmentIds.length) {
    throw new TypeError(
      "PlaytestExperiment.budget.maxAssignments must equal the frozen assignment count exactly."
    );
  }

  nonEmptyString(experiment.stoppingRule, "PlaytestExperiment.stoppingRule");

  if (!PLAYTESTS_EXPERIMENT_STATES.includes(experiment.state as never)) {
    throw new TypeError("PlaytestExperiment.state has an unsupported value.");
  }
  uniqueStringArray(experiment.attemptIds, "PlaytestExperiment.attemptIds", {
    allowEmpty: true
  });
  nullableNonEmptyString(
    experiment.comparisonId,
    "PlaytestExperiment.comparisonId"
  );
  nullableNonEmptyString(
    experiment.ownerDecision,
    "PlaytestExperiment.ownerDecision"
  );
  uniqueStringArray(
    experiment.rollbackRefs,
    "PlaytestExperiment.rollbackRefs",
    { allowEmpty: true }
  );

  if (!isIsoTimestamp(experiment.createdAt)) {
    throw new TypeError(
      "PlaytestExperiment.createdAt must be an ISO-8601 timestamp."
    );
  }
  if (
    typeof experiment.contentHash !== "string" ||
    !SHA256_PATTERN.test(experiment.contentHash)
  ) {
    throw new TypeError(
      "PlaytestExperiment.contentHash must be a SHA-256 hexadecimal digest."
    );
  }
}

/**
 * Explicit allowed-transition table (measurement-contract §5). The main
 * path is draft -> approved -> running -> completed -> analyzed ->
 * owner-decided. denied, cancelled, execution-failed and inconclusive are
 * terminal attempt results reachable from the step where the
 * corresponding failure/ambiguity is discovered; none of them lead
 * anywhere else. running may transition to itself: an infrastructure
 * retry creates a new attempt under the same assignment without erasing
 * the previous one.
 */
export const PLAYTESTS_EXPERIMENT_TRANSITIONS: Readonly<
  Record<PlaytestExperimentState, readonly PlaytestExperimentState[]>
> = {
  draft: ["approved", "denied", "cancelled"],
  approved: ["running", "cancelled"],
  running: ["running", "completed", "execution-failed", "cancelled"],
  completed: ["analyzed", "inconclusive"],
  analyzed: ["owner-decided", "inconclusive"],
  "owner-decided": [],
  denied: [],
  cancelled: [],
  "execution-failed": [],
  inconclusive: []
};

/** Is 'to' a permitted next state from 'from' per the table above? */
export function isPlaytestExperimentTransitionAllowed(
  from: PlaytestExperimentState,
  to: PlaytestExperimentState
): boolean {
  return PLAYTESTS_EXPERIMENT_TRANSITIONS[from].includes(to);
}

/** Inputs accompanying a requested state transition. */
export interface PlaytestExperimentTransitionInput {
  readonly to: PlaytestExperimentState;
  /** Required and must be previously-unseen when (re-)entering 'running'. */
  readonly attemptId?: string;
  /** Required exactly once, when entering 'analyzed'; immutable afterward. */
  readonly comparisonId?: string;
  /** Required exactly once, when entering 'owner-decided'; immutable afterward. */
  readonly ownerDecision?: string;
}

/**
 * Apply one state transition to a frozen experiment. Throws on an unknown
 * target state, an illegal transition per the table above, a duplicate
 * attempt id, or a missing/duplicate comparisonId/ownerDecision. On
 * success, returns a brand-new experiment object with version incremented
 * by exactly one; every other immutable field (identity, inventories,
 * allocation, analysis plan, budget) is carried over unchanged. Never
 * mutates its input.
 */
export function transitionPlaytestExperiment(
  experiment: PlaytestExperiment,
  input: PlaytestExperimentTransitionInput
): PlaytestExperiment {
  assertPlaytestExperiment(experiment);
  if (!PLAYTESTS_EXPERIMENT_STATES.includes(input.to)) {
    throw new TypeError(
      `Unknown PlaytestExperiment state "${String(input.to)}".`
    );
  }
  if (!isPlaytestExperimentTransitionAllowed(experiment.state, input.to)) {
    throw new RangeError(
      `Illegal PlaytestExperiment transition from "${experiment.state}" to "${input.to}".`
    );
  }

  let attemptIds = experiment.attemptIds;
  if (input.to === "running") {
    if (
      typeof input.attemptId !== "string" ||
      input.attemptId.trim().length === 0
    ) {
      throw new TypeError('Entering "running" requires a non-empty attemptId.');
    }
    if (experiment.attemptIds.includes(input.attemptId)) {
      throw new TypeError(
        `Attempt id "${input.attemptId}" has already been recorded; infrastructure retries require a fresh attempt id.`
      );
    }
    attemptIds = [...experiment.attemptIds, input.attemptId];
  }

  let comparisonId = experiment.comparisonId;
  if (input.to === "analyzed") {
    if (experiment.comparisonId !== null) {
      throw new TypeError(
        "PlaytestExperiment.comparisonId is already recorded and immutable."
      );
    }
    if (
      typeof input.comparisonId !== "string" ||
      input.comparisonId.trim().length === 0
    ) {
      throw new TypeError(
        'A final result requires a stored comparisonId before entering "analyzed".'
      );
    }
    comparisonId = input.comparisonId;
  }

  let ownerDecision = experiment.ownerDecision;
  if (input.to === "owner-decided") {
    if (experiment.comparisonId === null) {
      throw new TypeError(
        '"owner-decided" requires a previously stored comparisonId; analyze the experiment first.'
      );
    }
    if (experiment.ownerDecision !== null) {
      throw new TypeError(
        "PlaytestExperiment.ownerDecision is already recorded and immutable."
      );
    }
    if (
      typeof input.ownerDecision !== "string" ||
      input.ownerDecision.trim().length === 0
    ) {
      throw new TypeError(
        'Entering "owner-decided" requires a non-empty ownerDecision.'
      );
    }
    ownerDecision = input.ownerDecision;
  }

  const next: PlaytestExperiment = {
    ...experiment,
    state: input.to,
    version: experiment.version + 1,
    attemptIds,
    comparisonId,
    ownerDecision
  };
  assertPlaytestExperiment(next);
  return next;
}
