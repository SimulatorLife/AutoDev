/**
 * Runtime-side lock-manifest for the Playtesting statistical analysis
 * (measurement contract §4-5).
 *
 * The Runtime refuses to spawn the Python analysis worker unless the
 * resolved-environment manifest printed at the top of every analysis run
 * matches the constant `EXPECTED_LOCK_TAG`. Drift between
 * `pyproject.toml` and `uv.lock` (or worse, a stray upgrade that bypasses
 * uv entirely) makes this tag diverge, and the Runtime short-circuits
 * with an explicit `StatisticLockDriftError` rather than silently
 * producing intervals the contract forbids.
 *
 * The exact values come from `runtime/src/playtesting/statistics/uv.lock`
 * (transitively pinned to the package pin order in `pyproject.toml`).
 *
 * `library_version_token` is the value Core emits into
 * `PlaytestNumericInterval.libraryVersion`; tests assert the structural
 * shape (`{scipy,numpy,statsmodels}` present and pinned) rather than
 * requiring an exact-pinned string of the resolved lock.
 */

export const EXPECTED_SCIENTIFIC_LOCK = Object.freeze({
  python: ">=3.12,<3.14",
  numpy: "2.3.5",
  scipy: "1.17.0",
  statsmodels: "0.14.6"
});

export const EXPECTED_LOCK_TAG = Object.freeze(
  `scipy-${EXPECTED_SCIENTIFIC_LOCK.scipy}/numpy-${EXPECTED_SCIENTIFIC_LOCK.numpy}/statsmodels-${EXPECTED_SCIENTIFIC_LOCK.statsmodels}`
);

/** Library-version tokens the Runtime is willing to honour. */
export const ACCEPTED_LIBRARY_TOKENS = Object.freeze([
  "scipy",
  "numpy",
  "statsmodels"
]);

/**
 * Runtime-callable representation of the §4 worked A/B fixture. The
 * ordering of the paired-difference array matters: the contract documents
 * the orientation (positive == candidate wins) the same way for both the
 * completion primary and the clarity guardrail.
 */
export interface PlaytestStatisticFixture {
  readonly schema: "autodev-playtest-statistic-fixture-v1";
  readonly description: string;
  readonly expectedLibraryVersion: string;
  readonly expectedResamples: number;
  readonly expectedConfidenceLevel: number;
  readonly expectedSeed: number;
  readonly expectedMethods: readonly string[];
  readonly primary: PlaytestStatisticFixtureArm;
  readonly guardrail: PlaytestStatisticFixtureArm;
}

export interface PlaytestStatisticFixtureArm {
  readonly metricId: string;
  readonly pairedDifferences: readonly number[];
  readonly expectedInterval: {
    readonly lower: number;
    readonly upper: number;
  };
}
