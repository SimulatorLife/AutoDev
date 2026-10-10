/**
 * Null-safe dimension anchor scoring against a registry-declared rubric.
 *
 * Insufficient evidence is `null` with a reason -- never category 2. Scoring
 * requires both a minimum independent-unit count and a minimum eligible
 * opportunity count to be met; a ratio that would otherwise land in a high
 * band is still null when the underlying unit counts fall below the
 * rubric's declared minimums. No universal composite score is computed:
 * scoring resolves one dimension at a time against its own score bands.
 */

import type {
  PlaytestDimensionAnchor,
  PlaytestDimensionRubric,
  PlaytestEvidenceLocator,
  PlaytestScoreBand
} from "./types.ts";

function bandMatches(band: PlaytestScoreBand, ratio: number): boolean {
  const matches: boolean[] = [];
  if (band.equals !== undefined) matches.push(ratio === band.equals);
  if (band.greaterThan !== undefined) matches.push(ratio > band.greaterThan);
  if (band.atLeast !== undefined) matches.push(ratio >= band.atLeast);
  if (band.atMost !== undefined) matches.push(ratio <= band.atMost);
  if (band.lessThan !== undefined) matches.push(ratio < band.lessThan);
  if (matches.length === 0) {
    throw new TypeError("Score band declares no boundary condition.");
  }
  return matches.every(Boolean);
}

function resolveScoreBand(
  rubric: PlaytestDimensionRubric,
  ratio: number
): 0 | 1 | 2 | 3 | 4 {
  const matches = rubric.scoreBands.filter((band) => bandMatches(band, ratio));
  if (matches.length === 0) {
    throw new TypeError(
      `Ratio ${String(ratio)} did not match any score band for dimension "${rubric.dimensionId}".`
    );
  }
  if (matches.length > 1) {
    throw new TypeError(
      `Ratio ${String(ratio)} matched multiple score bands for dimension "${rubric.dimensionId}"; bands must be mutually exclusive.`
    );
  }
  return matches[0]!.score;
}

export interface PlaytestAnchorScoringInput {
  readonly dimensionId: string;
  readonly ratio: number | null;
  readonly independentUnits: number | null;
  readonly eligibleOpportunities: number | null;
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
  readonly counterexampleId?: string;
}

export function scorePlaytestDimensionAnchor(
  rubric: PlaytestDimensionRubric,
  input: PlaytestAnchorScoringInput
): PlaytestDimensionAnchor {
  if (input.dimensionId !== rubric.dimensionId) {
    throw new TypeError(
      `Dimension mismatch: input "${input.dimensionId}" does not match rubric "${rubric.dimensionId}".`
    );
  }
  const independentUnits = input.independentUnits;
  const eligibleOpportunities = input.eligibleOpportunities;
  const insufficient =
    input.ratio === null ||
    independentUnits === null ||
    eligibleOpportunities === null ||
    independentUnits < rubric.minIndependentUnits ||
    eligibleOpportunities < rubric.minExposure;

  if (insufficient) {
    return {
      dimensionId: rubric.dimensionId,
      version: rubric.version,
      unit: rubric.unit,
      score: null,
      rationale:
        input.ratio === null
          ? "No indicator ratio was computed for this dimension."
          : `Evidence below rubric minimums (independentUnits=${String(independentUnits)}, eligibleOpportunities=${String(eligibleOpportunities)}; requires >=${String(rubric.minIndependentUnits)} independent units and >=${String(rubric.minExposure)} eligible opportunities).`,
      evidenceChecklist: rubric.evidenceChecklist,
      evidenceRefs: input.evidenceRefs,
      independentUnits,
      eligibleOpportunities,
      insufficientReason: "unobserved",
      ...(input.counterexampleId === undefined
        ? {}
        : { counterexampleId: input.counterexampleId })
    };
  }

  const score = resolveScoreBand(rubric, input.ratio as number);
  return {
    dimensionId: rubric.dimensionId,
    version: rubric.version,
    unit: rubric.unit,
    score,
    rationale: `Ratio ${String(input.ratio)} over ${String(eligibleOpportunities)} eligible opportunities (${String(independentUnits)} independent units) maps to category ${String(score)}.`,
    evidenceChecklist: rubric.evidenceChecklist,
    evidenceRefs: input.evidenceRefs,
    independentUnits,
    eligibleOpportunities,
    ...(input.counterexampleId === undefined
      ? {}
      : { counterexampleId: input.counterexampleId })
  };
}

export function fixtureAgencyDimensionRubric(): PlaytestDimensionRubric {
  return {
    dimensionId: "agency",
    version: 1,
    unit: "episode",
    indicator: "competitive-choice-share@1",
    modality: "headless",
    minExposure: 4,
    minIndependentUnits: 1,
    scoreBands: [
      { score: 0, equals: 0 },
      { score: 1, greaterThan: 0, atMost: 0.25 },
      { score: 2, greaterThan: 0.25, atMost: 0.5 },
      { score: 3, greaterThan: 0.5, atMost: 0.75 },
      { score: 4, greaterThan: 0.75, atMost: 1 }
    ],
    counterexample: "second legal action is dominated",
    evidenceChecklist: [
      "all legal alternatives evaluated",
      "frozen reward and continuation",
      "verified RNG plan"
    ],
    insufficient: "null",
    humanOutcomeMapping: null
  };
}
