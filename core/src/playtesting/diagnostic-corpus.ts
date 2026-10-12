/**
 * Deterministic, one-to-one scoring of critic/detector findings against a
 * blinded, independently adjudicated reference corpus (measurement §6).
 * This module scores labels supplied by the corpus owner; it does not create
 * labels, infer truth from model output, or turn incomplete coverage into a
 * recall claim.
 */

export type PlaytestDiagnosticLabel = "positive" | "negative" | "unresolved";
export type PlaytestDiagnosticPredictionSource = "critic" | "deterministic";
export type PlaytestDiagnosticScoredSource =
  PlaytestDiagnosticPredictionSource | "critic+deterministic";

interface DiagnosticWindow {
  readonly episodeId: string;
  readonly stratumId: string;
  readonly category: string;
  readonly mechanicKey: string;
  readonly startStep: number;
  readonly endStep: number;
}

export interface PlaytestDiagnosticCoverage {
  readonly stratumId: string;
  /** Frozen eligible inventory for this reference-corpus stratum. */
  readonly eligibleEpisodeIds: readonly string[];
  /** Episodes whose problem and ordinary-play evidence received adequate blind review. */
  readonly reviewedEpisodeIds: readonly string[];
}

export interface PlaytestDiagnosticReference extends DiagnosticWindow {
  readonly instanceId: string;
  readonly label: PlaytestDiagnosticLabel;
  readonly reviewerCount: number;
  readonly blindToPredictions: boolean;
  readonly adjudication: "agreement" | "adjudicated" | "unresolved";
}

export interface PlaytestDiagnosticPrediction extends DiagnosticWindow {
  readonly predictionId: string;
  readonly source: PlaytestDiagnosticPredictionSource;
}

export interface PlaytestDiagnosticCorpusInput {
  readonly referenceCorpusVersion: string;
  readonly labelProtocolHash: string;
  readonly coverage: readonly PlaytestDiagnosticCoverage[];
  readonly references: readonly PlaytestDiagnosticReference[];
  readonly predictions: readonly PlaytestDiagnosticPrediction[];
}

export interface PlaytestDiagnosticSourceScore {
  readonly source: PlaytestDiagnosticScoredSource;
  /** Predictions inside reviewed episode coverage and therefore scoreable. */
  readonly scoredPredictions: number;
  readonly outOfCoveragePredictions: number;
  readonly matchedInstances: number;
  /** Includes duplicate predictions after the first one-to-one match. */
  readonly falsePositiveInstances: number;
  readonly duplicatePredictions: number;
  readonly unresolvedExcludedPredictions: number;
  readonly positiveReferenceInstances: number;
  readonly negativeReferenceInstances: number;
  readonly unresolvedReferenceInstances: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly recallAvailable: boolean;
  readonly eligibleEpisodes: number;
  readonly adequatelyReviewedEpisodes: number;
  readonly coverageComplete: boolean;
  readonly matches: readonly {
    readonly predictionId: string;
    readonly referenceInstanceId: string;
  }[];
}

export interface PlaytestDiagnosticCorpusResult {
  readonly referenceCorpusVersion: string;
  readonly labelProtocolHash: string;
  readonly critic: PlaytestDiagnosticSourceScore;
  readonly deterministic: PlaytestDiagnosticSourceScore;
  readonly combined: PlaytestDiagnosticSourceScore;
  readonly byStratum: Readonly<
    Record<
      string,
      {
        readonly critic: PlaytestDiagnosticSourceScore;
        readonly deterministic: PlaytestDiagnosticSourceScore;
        readonly combined: PlaytestDiagnosticSourceScore;
      }
    >
  >;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const SHA256 = /^[a-f\d]{64}$/iu;
const MAX_COVERAGE_STRATA = 128;
const MAX_DIAGNOSTIC_INSTANCES = 2000;
/** Shared collator for deterministic identifier ordering; construction is not free. */
const ID_COLLATOR = new Intl.Collator();

function identifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new TypeError(`${field} must be a non-empty stable identifier.`);
  }
}

function uniqueIds(values: readonly string[], field: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    identifier(value, `${field} item`);
    if (result.has(value))
      throw new TypeError(`${field} contains duplicate "${value}".`);
    result.add(value);
  }
  return result;
}

function validateWindow(value: DiagnosticWindow, field: string): void {
  identifier(value.episodeId, `${field}.episodeId`);
  identifier(value.stratumId, `${field}.stratumId`);
  identifier(value.category, `${field}.category`);
  identifier(value.mechanicKey, `${field}.mechanicKey`);
  if (
    !Number.isSafeInteger(value.startStep) ||
    value.startStep < 0 ||
    !Number.isSafeInteger(value.endStep) ||
    value.endStep < value.startStep
  ) {
    throw new TypeError(
      `${field} must have an ordered, non-negative step window.`
    );
  }
}

function overlaps(a: DiagnosticWindow, b: DiagnosticWindow): boolean {
  return (
    a.episodeId === b.episodeId &&
    a.stratumId === b.stratumId &&
    a.category === b.category &&
    a.mechanicKey === b.mechanicKey &&
    a.startStep <= b.endStep &&
    b.startStep <= a.endStep
  );
}

function scoreSource(
  source: PlaytestDiagnosticScoredSource,
  coverage: readonly PlaytestDiagnosticCoverage[],
  references: readonly PlaytestDiagnosticReference[],
  predictions: readonly PlaytestDiagnosticPrediction[]
): PlaytestDiagnosticSourceScore {
  const sourcePredictions = predictions.filter(
    (prediction) =>
      source === "critic+deterministic" || prediction.source === source
  );
  const reviewedEpisodeIds = new Map(
    coverage.map((cell) => [cell.stratumId, new Set(cell.reviewedEpisodeIds)])
  );
  const outOfCoveragePredictions = sourcePredictions.filter(
    (prediction) =>
      !reviewedEpisodeIds.get(prediction.stratumId)!.has(prediction.episodeId)
  );
  const outOfCoveragePredictionIds = new Set(
    outOfCoveragePredictions.map((prediction) => prediction.predictionId)
  );
  const reviewedPredictions = sourcePredictions.filter(
    (prediction) => !outOfCoveragePredictionIds.has(prediction.predictionId)
  );
  const positiveReferences = references.filter(
    (reference) => reference.label === "positive"
  );
  const negativeReferences = references.filter(
    (reference) => reference.label === "negative"
  );
  const unresolvedReferences = references.filter(
    (reference) => reference.label === "unresolved"
  );
  const eligibleEpisodes = coverage.reduce(
    (total, cell) => total + cell.eligibleEpisodeIds.length,
    0
  );
  const adequatelyReviewedEpisodes = coverage.reduce(
    (total, cell) => total + cell.reviewedEpisodeIds.length,
    0
  );
  const coverageComplete = coverage.every((cell) =>
    cell.eligibleEpisodeIds.every((episodeId) =>
      cell.reviewedEpisodeIds.includes(episodeId)
    )
  );

  // Maximum-cardinality bipartite matching ensures a prediction cannot claim
  // multiple reference issues and a duplicate flood cannot inflate recall.
  const orderedPredictions = [...reviewedPredictions].sort((a, b) =>
    ID_COLLATOR.compare(a.predictionId, b.predictionId)
  );
  const orderedReferences = [...positiveReferences].sort((a, b) =>
    ID_COLLATOR.compare(a.instanceId, b.instanceId)
  );
  const referenceOwner = new Map<number, number>();
  const predictionReference = new Map<number, number>();
  const augment = (predictionIndex: number, visited: Set<number>): boolean => {
    const prediction = orderedPredictions[predictionIndex]!;
    for (const [
      referenceIndex,
      orderedReference
    ] of orderedReferences.entries()) {
      const reference = orderedReference!;
      if (!overlaps(prediction, reference) || visited.has(referenceIndex))
        continue;
      visited.add(referenceIndex);
      const currentOwner = referenceOwner.get(referenceIndex);
      if (currentOwner === undefined || augment(currentOwner, visited)) {
        referenceOwner.set(referenceIndex, predictionIndex);
        predictionReference.set(predictionIndex, referenceIndex);
        return true;
      }
    }
    return false;
  };
  for (
    let predictionIndex = 0;
    predictionIndex < orderedPredictions.length;
    predictionIndex += 1
  ) {
    augment(predictionIndex, new Set());
  }

  const matches = Array.from(
    predictionReference,
    ([predictionIndex, referenceIndex]) => ({
      predictionId: orderedPredictions[predictionIndex]!.predictionId,
      referenceInstanceId: orderedReferences[referenceIndex]!.instanceId
    })
  ).sort((a, b) => ID_COLLATOR.compare(a.predictionId, b.predictionId));
  const matchedPredictionIds = new Set(
    matches.map((match) => match.predictionId)
  );
  const unmatched = orderedPredictions.filter(
    (prediction) => !matchedPredictionIds.has(prediction.predictionId)
  );
  const unresolvedExcluded = unmatched.filter((prediction) =>
    unresolvedReferences.some((reference) => overlaps(prediction, reference))
  );
  const falsePositives = unmatched.filter(
    (prediction) => !unresolvedExcluded.includes(prediction)
  );
  const duplicatePredictions = falsePositives.filter((prediction) =>
    positiveReferences.some((reference) => overlaps(prediction, reference))
  );
  const scoredPredictions = matches.length + falsePositives.length;
  const recallAvailable = coverageComplete;
  const matchedInstances = matches.length;

  return {
    source,
    scoredPredictions,
    outOfCoveragePredictions: outOfCoveragePredictions.length,
    matchedInstances,
    falsePositiveInstances: falsePositives.length,
    duplicatePredictions: duplicatePredictions.length,
    unresolvedExcludedPredictions: unresolvedExcluded.length,
    positiveReferenceInstances: positiveReferences.length,
    negativeReferenceInstances: negativeReferences.length,
    unresolvedReferenceInstances: unresolvedReferences.length,
    precision:
      scoredPredictions === 0 ? null : matchedInstances / scoredPredictions,
    recall: recallAvailable
      ? positiveReferences.length === 0
        ? 0
        : matchedInstances / positiveReferences.length
      : null,
    recallAvailable,
    eligibleEpisodes,
    adequatelyReviewedEpisodes,
    coverageComplete,
    matches
  };
}

function validateCoverageEntry(
  cell: PlaytestDiagnosticCoverage,
  field: string,
  stratumIds: Set<string>,
  episodeStrata: Map<string, string>
): void {
  identifier(cell.stratumId, `${field}.stratumId`);
  if (stratumIds.has(cell.stratumId))
    throw new TypeError("Diagnostic coverage strata must be unique.");
  stratumIds.add(cell.stratumId);
  const eligible = uniqueIds(
    cell.eligibleEpisodeIds,
    `${field}.eligibleEpisodeIds`
  );
  const reviewed = uniqueIds(
    cell.reviewedEpisodeIds,
    `${field}.reviewedEpisodeIds`
  );
  if (eligible.size === 0)
    throw new TypeError(`${field} must declare eligible episodes.`);
  for (const episodeId of reviewed) {
    if (!eligible.has(episodeId))
      throw new TypeError(
        `${field} reviews an episode outside its eligible inventory.`
      );
  }
  for (const episodeId of eligible) {
    const priorStratum = episodeStrata.get(episodeId);
    if (priorStratum !== undefined && priorStratum !== cell.stratumId) {
      throw new TypeError(
        `Episode "${episodeId}" occurs in multiple diagnostic strata.`
      );
    }
    episodeStrata.set(episodeId, cell.stratumId);
  }
}

function validateCoverage(
  coverage: readonly PlaytestDiagnosticCoverage[]
): void {
  const stratumIds = new Set<string>();
  const episodeStrata = new Map<string, string>();
  for (const [index, cell] of coverage.entries()) {
    validateCoverageEntry(
      cell,
      `coverage[${index}]`,
      stratumIds,
      episodeStrata
    );
  }
}

function validateReferenceLabelState(
  reference: PlaytestDiagnosticReference,
  field: string
): void {
  if (
    !["positive", "negative", "unresolved"].includes(reference.label) ||
    !["agreement", "adjudicated", "unresolved"].includes(reference.adjudication)
  ) {
    throw new TypeError(`${field} label or adjudication is unsupported.`);
  }
  if (
    (reference.label === "unresolved" &&
      reference.adjudication !== "unresolved") ||
    (reference.label !== "unresolved" &&
      !["agreement", "adjudicated"].includes(reference.adjudication))
  ) {
    throw new TypeError(`${field} label and adjudication state disagree.`);
  }
}

function validateReferenceEntry(
  reference: PlaytestDiagnosticReference,
  field: string,
  coverage: readonly PlaytestDiagnosticCoverage[],
  referenceIds: Set<string>
): void {
  validateWindow(reference, field);
  identifier(reference.instanceId, `${field}.instanceId`);
  if (referenceIds.has(reference.instanceId))
    throw new TypeError("Diagnostic reference instance IDs must be unique.");
  referenceIds.add(reference.instanceId);
  const cell = coverage.find(
    (candidate) => candidate.stratumId === reference.stratumId
  );
  if (!cell?.reviewedEpisodeIds.includes(reference.episodeId)) {
    throw new TypeError(
      `${field} must belong to an adequately reviewed episode in its stratum.`
    );
  }
  if (
    !Number.isSafeInteger(reference.reviewerCount) ||
    reference.reviewerCount < 2
  ) {
    throw new TypeError(
      `${field}.reviewerCount must represent at least two reviewers.`
    );
  }
  if (reference.blindToPredictions !== true) {
    throw new TypeError(
      `${field} reviewers must be blind to critic predictions.`
    );
  }
  validateReferenceLabelState(reference, field);
}

function validateReferences(
  coverage: readonly PlaytestDiagnosticCoverage[],
  references: readonly PlaytestDiagnosticReference[]
): void {
  const referenceIds = new Set<string>();
  for (const [index, reference] of references.entries()) {
    validateReferenceEntry(
      reference,
      `references[${index}]`,
      coverage,
      referenceIds
    );
  }
}

function validatePredictionEntry(
  prediction: PlaytestDiagnosticPrediction,
  field: string,
  coverage: readonly PlaytestDiagnosticCoverage[],
  predictionIds: Set<string>
): void {
  validateWindow(prediction, field);
  identifier(prediction.predictionId, `${field}.predictionId`);
  if (predictionIds.has(prediction.predictionId))
    throw new TypeError("Diagnostic prediction IDs must be unique.");
  predictionIds.add(prediction.predictionId);
  const cell = coverage.find(
    (candidate) => candidate.stratumId === prediction.stratumId
  );
  if (!cell) {
    throw new TypeError(
      `${field}.stratumId is not present in the frozen corpus coverage.`
    );
  }
  if (!cell.eligibleEpisodeIds.includes(prediction.episodeId)) {
    throw new TypeError(
      `${field}.episodeId is outside the frozen reference inventory.`
    );
  }
  if (prediction.source !== "critic" && prediction.source !== "deterministic") {
    throw new TypeError(`${field}.source is unsupported.`);
  }
}

function validatePredictions(
  coverage: readonly PlaytestDiagnosticCoverage[],
  predictions: readonly PlaytestDiagnosticPrediction[]
): void {
  const predictionIds = new Set<string>();
  for (const [index, prediction] of predictions.entries()) {
    validatePredictionEntry(
      prediction,
      `predictions[${index}]`,
      coverage,
      predictionIds
    );
  }
}

function computeByStratum(input: PlaytestDiagnosticCorpusInput): Record<
  string,
  {
    critic: PlaytestDiagnosticSourceScore;
    deterministic: PlaytestDiagnosticSourceScore;
    combined: PlaytestDiagnosticSourceScore;
  }
> {
  const byStratum: Record<
    string,
    {
      critic: PlaytestDiagnosticSourceScore;
      deterministic: PlaytestDiagnosticSourceScore;
      combined: PlaytestDiagnosticSourceScore;
    }
  > = {};
  for (const cell of input.coverage) {
    const scopedCoverage = [cell];
    const scopedReferences = input.references.filter(
      (reference) => reference.stratumId === cell.stratumId
    );
    const scopedPredictions = input.predictions.filter(
      (prediction) => prediction.stratumId === cell.stratumId
    );
    byStratum[cell.stratumId] = {
      critic: scoreSource(
        "critic",
        scopedCoverage,
        scopedReferences,
        scopedPredictions
      ),
      deterministic: scoreSource(
        "deterministic",
        scopedCoverage,
        scopedReferences,
        scopedPredictions
      ),
      combined: scoreSource(
        "critic+deterministic",
        scopedCoverage,
        scopedReferences,
        scopedPredictions
      )
    };
  }
  return byStratum;
}

/** Validate and score diagnostic precision/recall without imputing incomplete truth. */
export function evaluatePlaytestDiagnosticCorpus(
  input: PlaytestDiagnosticCorpusInput
): PlaytestDiagnosticCorpusResult {
  identifier(input.referenceCorpusVersion, "referenceCorpusVersion");
  if (!SHA256.test(input.labelProtocolHash)) {
    throw new TypeError("labelProtocolHash must be a SHA-256 digest.");
  }
  if (!Array.isArray(input.coverage) || input.coverage.length === 0) {
    throw new TypeError("Diagnostic corpus coverage must not be empty.");
  }
  if (!Array.isArray(input.references) || !Array.isArray(input.predictions)) {
    throw new TypeError(
      "Diagnostic references and predictions must be arrays."
    );
  }
  if (input.coverage.length > MAX_COVERAGE_STRATA) {
    throw new TypeError(
      "Diagnostic corpus exceeds the supported stratum limit."
    );
  }
  if (
    input.references.length > MAX_DIAGNOSTIC_INSTANCES ||
    input.predictions.length > MAX_DIAGNOSTIC_INSTANCES
  ) {
    throw new TypeError(
      "Diagnostic corpus exceeds the bounded instance limit."
    );
  }
  validateCoverage(input.coverage);
  validateReferences(input.coverage, input.references);
  validatePredictions(input.coverage, input.predictions);

  return {
    referenceCorpusVersion: input.referenceCorpusVersion,
    labelProtocolHash: input.labelProtocolHash.toLowerCase(),
    critic: scoreSource(
      "critic",
      input.coverage,
      input.references,
      input.predictions
    ),
    deterministic: scoreSource(
      "deterministic",
      input.coverage,
      input.references,
      input.predictions
    ),
    combined: scoreSource(
      "critic+deterministic",
      input.coverage,
      input.references,
      input.predictions
    ),
    byStratum: computeByStratum(input)
  };
}
