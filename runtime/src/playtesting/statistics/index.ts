/**
 * Public entry point for the Playtesting statistical analysis layer.
 *
 * Re-exports the narrow Runtime-owned API plus its expected error types
 * so callers can `import { RuntimePlaytestStatAnalysis } from
 * "@simulatorlife/autodev-runtime/playtesting/statistics"` (via the
 * playtesting barrel) without depending on the internal module shape.
 */

export {
  EXPECTED_LOCK_TAG,
  type PlaytestBootstrapInput,
  type PlaytestMultiplicityInput,
  type PlaytestMultiplicityResult,
  PlaytestStatisticInputError,
  PlaytestStatisticLockDriftError,
  PlaytestStatisticTransportError,
  RuntimePlaytestStatAnalysis,
  type RuntimePlaytestStatAnalysisOptions
} from "./analysis.ts";
export {
  assertDeclaredPinsMatchContract,
  PlaytestStatEnvironmentError,
  pyProjectTomlPath,
  pythonWorkerModule,
  type ResolvedPlaytestStatEnvironment,
  resolvePlaytestStatEnvironment,
  uvLockPath
} from "./environment.ts";
export type {
  PlaytestStatisticFixture,
  PlaytestStatisticFixtureArm
} from "./lock-manifest.ts";
export {
  ACCEPTED_LIBRARY_TOKENS,
  EXPECTED_SCIENTIFIC_LOCK
} from "./lock-manifest.ts";
