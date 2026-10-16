# Playtesting adapter-first delivery history (archived)

> **Archived evidence, not current requirements.** These dated audits, checkpoints and validation snapshots were moved verbatim from the [Playtesting implementation plan](playtesting-target-state-implementation.md) on 2026-10-15 when the visual-first target superseded the adapter-first delivery order. Checked boxes certify only that narrower adapter-first work; recommendations here (for example a default **Run** view or a universal 1,000-episode gate) are superseded wherever they differ from the [current P0–P5 plan](playtesting-target-state-implementation.md#ordered-delivery-plan--complete-these-gates-before-declaring-the-new-playtesting-target-done), the [Playtesting target state](../playtesting-target-state.md) or the [Console contract](../autodev-console-target-state.md#playtesting). Do not implement from this file; cite it only as provenance.

## Delivery slices

Audit (2026-10-13) against the code, not the section headings. Each item below
states what is implemented and, where applicable, what is still missing.

- [x] 1. Recorder/runner: versioned adapter, validated player-visible schema,
      approved isolation, provenance, bounded episode recording, security and
      protocol validation. Evidence: `adapter-client.ts` with protocol-version
      and digest rejection (`playtesting-adapter.test.ts`), the player-visible
      projection in `visible-observation.ts`, and the pinned networkless
      container with hard quotas in `docker-sandbox.ts`.
- [x] 2. Analyst: source-verified timeline, bounded evidence selection,
      null-safe anchored scoring, citation validation, deterministic/critic
      separation, testable hypotheses, read-only role and skills. Evidence:
      `mcp.ts` review preparation, the 64 KiB packet cap, citation resolution
      against the real stored index, and a read-only role asserted in
      `playtest-role-routing.test.ts`.
- [~] 3. Policy/comprehension: policy provenance, bounded pre-action
  expectation probes, and stratified surveillance/discovery sampling are
  implemented. **Cost accounting for the arm comparison is implemented**
  (`core/src/playtesting/analysis-cost.ts`, `90393bac`): cost is supplied as
  measured rather than derived from a price list, coverage is read from the
  same scored result the scores come from so the two cannot describe different
  runs, and an unmeasured arm reports `null` rather than `0`. Two runnable
  policies are now registered (`random`, `first-legal`).

  **The cost check is no longer reachable-only-in-theory.** `evaluateJudgeCalibration`
  was returning `passed` for a validation with _every_ metric null, and
  discarding the artifact's own recorded `insufficient`/`stale` status
  (`8d5721ac`) — absence of evidence rendered as a positive claim, which is
  what keeps novice/expert generalizations and human-proxy comparisons
  authorized on the strength of nothing. Nothing measured is now
  `insufficient`, an insufficient or stale result quarantines the same claims
  a failure does, and a recorded insufficient/stale record cannot be upgraded
  to passed. Partial measurement still draws a conclusion, and a measured
  judge that misses tolerances is still `failed` rather than `insufficient`.

  **Still missing: a producer.** `PlaytestJudgeValidation` itself is declared
  and consumed but constructed nowhere, so no run yet feeds these fields.
  `analysis-cost.ts` supplies the `costPerReviewedEpisode` arithmetic; wiring a
  producer is separate work and is not claimed here. Measured across arms, matched coverage holds by construction —
  the evaluator scores critic, deterministic and combined over one frozen
  coverage set — so `coverageMatched` is kept as an explicit guard rather than
  dropped as redundant.

- [~] 4. Experiment/findings: preregistered comparisons, finding identity,
  exposure/evidence triage, and reproduction/fix lineage are implemented.
  **Gated issue drafting is implemented** (`core/src/playtesting/issue-drafts.ts`,
  `playtest.issueDrafts`). Both gates now have readers: the game's checked-in
  `reporting.githubIssues` is carried on the capabilities view as
  `configuredIssueReporting`, and the operator's `issueReporting` alongside it,
  so an operator can tell a game that asked for review from one that asked for
  nothing. AutoDev drafts and never publishes — every draft carries
  `requiresOperatorAction`, the body states that nothing was filed, and the
  finding's `evidenceStatus`/`verificationStage` are rendered verbatim. A
  regression is drafted rather than treated as closed, per the measurement
  contract's rule that external reopening follows explicit authority.

  **Triage now runs over real findings, and it stopped fabricating a score.**
  §9's ordering (`core/src/playtesting/triage.ts`) was Core policy with no
  executor: nothing in Runtime or Console ran it over the findings the system
  stores. `playtest.triageFindings` does, and reading it surfaced a defect in
  the policy itself.

  `getExposureRate` returned `0` when a finding recorded neither opportunity nor
  episode denominators. Zero is a claim -- it says the finding was rarely
  exposed -- and it also leaked into `priorityScoreKey` as the fabricated
  worst-looking possible score, `1.0000`, for a finding whose exposure nobody
  had observed. No test asserted that key, which is how it survived. It now
  returns `null`, an unmeasured rate sorts behind a measured one rather than
  being read as a low one, `priorityScoreKey` reads `unmeasured`, and the
  explanation says "Exposure rate: not measured" instead of omitting the rate
  and implying there was none. Reintroducing the `0` turns two tests red.

  The tool itself: overrides are supplied per call, carried with their author
  and reason, and never persisted (`persisted: false`); an override naming a
  finding outside the examined page is reported in `overridesNotInPage` rather
  than applied silently or failing the call; and `examinedFindings` /
  `rankedFindings` / `nextCursor` state the window explicitly so a truncated
  page cannot read as "these are the findings worth working on". Five controls
  back this: ignoring overrides, swallowing out-of-page overrides, and the
  earlier fabricated-zero all turn the relevant test red.

  **The cohort mix-shift gate now runs over real runs, and building it corrected
  the shape twice.** `standardizePlaytestCohortRates` was Core policy with no
  executor. The first attempt took one batch and derived one build's
  observations — which is not merely inconvenient but impossible: the canonical
  validator rejects fewer than two builds with "builds must contain at least two
  builds for a changing cohort-mix gate". A single build has no mix to have
  shifted. The measurement contract agrees independently — §10 tabulates builds
  A/B/C against a pinned reference, and §11 names "three-build changing cohort
  mix" as a required fixture. So the executor takes runs and keys builds by
  `batch.buildSha`, merging runs of one build (the counts are additive, and two
  batches of the same build is ordinary operation, not a duplicate). The unit
  test reproduces §10's own A/B/C numbers rather than invented ones, which is
  what proves the weighting: B's raw rate rises to 85% while its fixed-weight
  rate falls to 65%, and §10's interpretation — "apparent raw gain hides worse
  hard-scenario outcome" — only holds if the two weights are kept apart.

  **It refuses instead of padding, in both directions.** The validator demands
  the observed cohort set be exactly the benchmark's weighted set, so the
  tempting fix is to fill an absent cohort with
  `{ numerator: 0, denominator: 0, missing: 0 }`. Zero is the report "we looked
  and observed nothing"; an absent cohort is "we never looked". The vocabulary
  already names the difference — `"unknown-no-observation"` sits in both state
  lists — but no code path emits it, because the validator makes it unreachable.
  The mirror case matters too: a cohort the run exercised that the benchmark
  does not weight is discarded by neither Core nor this module, and dropping it
  would silently lose real observations while the fixed weights described a mix
  the run never had. Both are named refusals, not thrown type errors, because a
  refusal a caller can report is the product and a `TypeError` from a deep
  assertion is not. Observations are returned even on refusal so a reader sees
  the basis, and `skippedRowsByBuild` distinguishes "the run recorded nothing for
  this metric" from "the run recorded rows and some did not apply".

  Evidence: Runtime unit `playtesting-cohort-standardization-run.test.ts` 9/9
  and seam `playtesting-cohort-mix-shift-mcp.test.ts` 5/5. The seam test drives
  the real MCP server against the approved benchmark **on disk**, whose fixture
  weights a single cohort (`onboarding`); that is deliberate, because a tool that
  stopped reading the benchmark's own weights could not standardize against it
  at all. `playtest.cohortMixShift` is readable by `playtest-analyst` (the
  target-state role that "interprets and compares") and refused to `playtester`.
  Five controls turn a test red each: zero-padding unobserved cohorts, dropping
  unweighted cohorts, removing the insufficient-builds refusal, collapsing the
  fixed-weight rate into the raw rate, and treating each run as its own build.
  Still not closed, and recorded rather than designed around: the gate is
  descriptive point estimates only, and §10 is explicit that intervals and
  independent-unit N must come from a statistics library attached to real rows,
  which this slice does not do. Separately, **the result is not yet citable**:
  `PLAYTESTS_LOCATOR_KINDS` has no `cohort-standardization` kind, so a
  `PlaytestComparison` — the artifact that would actually consume a mix shift —
  has no way to name the analysis behind its decision. That is the same missing
  link that was closed for policy-validity in `e3bb97db`, but it cannot be
  closed the same way: adding the locator kind is easy and additive, whereas a
  citation that points at nothing is worse than no citation, so it first needs a
  decision on whether a standardization result is _persisted_ like a comparison
  or remains a derived read. That persistence surface is the one recorded above
  as having no producer, so the two gaps share a single unresolved design
  question and are left named together.

  **Still missing: counterexamples as a lifecycle step.** They remain
  registry/scoring fields only, and implementing them would require inventing
  the competence thresholds ("passed"/"failed"/"insufficient") that decide when
  an omission is a defect — a domain judgement AutoDev has no authority to
  fabricate. Deliberately left unimplemented and recorded here as a gap, not
  downgraded to a footnote.

  **Newly recorded: nothing creates a comparison from a real run.** A whole-tree
  search for `buildPlaytestComparison` finds only `core/src/playtesting/comparison.ts`
  and test files, and the sole production `insertComparison` call
  (`runtime/src/playtesting/mcp.ts:4291`) persists an owner decision onto a
  comparison already fetched from storage. So `playtest.compare` lists an empty
  set, `playtest.decideComparison` refuses because there is nothing to decide,
  and `classifyPlaytestMetricComparison` -- reached only through that builder --
  never runs outside tests. The comparison _model_ is implemented; the producer
  is not. This was not previously recorded and is stated here rather than left
  implicit, because a `[~]` slice that reads as delivered is how a later reader
  assumes a live system can compare two builds when it cannot.

  Closing it needs the measurement contract's frozen pairing (matched baseline
  and candidate units across a preregistered experiment), which is a larger and
  design-sensitive surface than the artifact above; it is deliberately left for
  that work rather than approximated with an unparied comparison.

  **The same is true of the link above it, and this is what blocks a producer.**
  `insertExperiment` exists in Data and has no Runtime caller, and neither
  `insertExperiment` nor a getter appears on Runtime's
  `PlaytestingRepositoryOps`. So the chain is model-only end to end:
  preregistration, comparison and owner decision each lack a producer, and
  `playtest.decideComparison` can only ever re-decide a comparison that nothing
  creates.

  Writing a preregistration path is blocked by a missing binding, not by effort.
  `PlaytestExperiment` freezes `discoveryInventory` / `confirmationInventory` as
  independent-unit ids, while `PlaytestBenchmark` freezes `seedInventory` as
  seeds with a purpose (`discovery` / `confirmation` / `regression`) plus
  `scenarioInventory`. Nothing relates the two: there is no declared mapping from
  a seed or scenario to independent-unit identity. The only per-unit identity
  Runtime persists is the batch assignment's own `seed` and `scenarioId`, which
  come from the batch's allocation rather than from the approved benchmark. A
  producer would therefore have to invent the unit population it freezes -- the
  same fabricated judgement as the competence thresholds above, one level up.
  Resolving that is a project decision about how independent units are derived,
  and it is recorded here rather than guessed at.

  **The bridge to `competenceReportRefs` was unexpressible, and now is.** It is
  a `PlaytestEvidenceLocator[]`, whose kind is a closed vocabulary
  (`core/src/playtesting/types.ts`) that had no member for a validity record --
  so the field whose whole purpose is to attest that a policy may stand in for a
  player could only cite an `episode` or a `review`, neither of which is a
  competence report. The test fixtures showed the pressure this created:
  `competenceReportRefs: [{ kind: "episode", id: "policy-validity" }]` was an
  invented value -- an episode whose id was the words "policy-validity".

  `policy-validity` now joins the vocabulary, and the derived record carries a
  citable identity: Core exposes `playtestPolicyValidityHashInput` (canonical
  form only -- Core carries no hashing, because `node:crypto` cannot be bundled
  into the browser-reachable console), and `playtest.policyValidity` takes the
  SHA-256 and returns it as `validityId` plus the `{ kind, id }` locator a
  benchmark would write. The identity is content-addressed, so a citation cannot
  keep answering for a record whose verdict has since changed.

  Extending the vocabulary is additive and backward-compatible: persisted
  locators keep their existing kinds, and `assertPlaytestEvidenceLocator` still
  rejects anything outside the closed set. Two controls confirm the change is
  load-bearing -- a constant `validityId`, and removing the new kind, each turn
  the relevant test red.

- [~] 5. Visual/human validation: consented study data, privacy controls,
  distinct human instruments, and refusal of unauthorized UI evidence are
  implemented and tested. The `PlayerPolicyValidity` artifact that measurement
  contract §6 mandates now has a producer, a consumer and a runtime path; what
  remains open is named below rather than closed by deleting the type.

  The part that is implementable without inventing anything is the
  synthetic-cohort path the contract already specifies: "absent data means
  unvalidated-synthetic-cohort", with `heldOutHumanStateIds` empty ("when
  available") and `competence: "unvalidated-synthetic"`. That verdict is the
  contract's own answer, not a threshold this codebase gets to pick.

  The part that is **not** implementable here is the human-data path.
  `competence: "passed" | "failed"` requires "acceptance bounds
  preregistered against relevant human data" (§6), and no such human data or
  preregistered bounds exist in this repository. Inventing them would fabricate
  the exact judgement the contract reserves for the project, so the path stays
  unimplemented. The consumer §6 requires for that downgrade now exists:
  `evaluateDiagnosticLadder`'s stage 2 took
  `stage2ObserverCompetenceVerified: boolean`, so a caller could assert
  observer competence on the strength of nothing and proceed to
  human-confusion conclusions (`e278941a`). It now takes the independently
  initialized, competence-checked observers themselves — an empty list is
  unverified, never "verified, none needed" — which is also this artifact's
  first consumer.

  **The artifact now has a consumer and a producer**
  (`core/src/playtesting/policy-validity.ts`, `e278941a`, `23a081be`).
  `competence` is derived, never asserted, across three situations that are
  deliberately not collapsed: no human decision states or no preregistered
  bounds is `unvalidated-synthetic` (the contract's own word for absent data,
  and absent bounds are not a permissive default); bounds without a measured
  metric is `insufficient`, because a criterion never measured has not been
  met; everything measured is applied against the caller's preregistered
  bounds. The bounds are supplied by the caller because choosing those numbers
  is the judgement §6 reserves for the project.
  `playtestHumanProxyRefusal` carries §6's required downgrade — an
  unvalidated cohort may not support a human-player claim — as a sentence a
  caller must put in its own output.

  **A runtime path now produces these from a real run**
  (`runtime/src/playtesting/policy-validity-run.ts`, `playtest.policyValidity`).
  It reads the batch's own frozen coverage manifest rather than a page of the
  episode table: the manifest is the content-addressed record of what each policy
  and cohort was observed doing, and reading it avoids a truncated page
  undercounting a policy's coverage or making totals depend on which page
  answered. Policy versions come from the **approved benchmark on disk**, not
  from the derivation, because a validity record pinned to a guessed version would
  look checkable without being checkable -- the seam test
  (`runtime/tests/playtesting-policy-validity-mcp.test.ts`) fails if the tool ever
  stops reading that benchmark.

  Three rules keep the result from fabricating authority, each covered by a test
  and confirmed by a control:

  - coverage is measured or the cell is **named, never scored `0`** -- a cell with
    no eligible opportunities has no coverage figure, and `0` would assert the
    policy was observed and never behaved (`no-eligible-opportunities`);
  - the four competence metrics stay `null`, because each compares the policy
    with a person and this run measured no person;
  - human evidence arrives only as an operator preregistration block, never as a
    tool input, so a caller cannot assert that human data exists on the strength
    of a call. Nothing supplies that block yet, so every live record is
    `unvalidated-synthetic` and carries `playtestHumanProxyRefusal`'s sentence.

  **Still missing: the human-data path and its consumer.** The diagnostic ladder's
  observer list is still supplied by hand, so nothing yet feeds the derived record
  into `evaluateDiagnosticLadder`; and with no human data or preregistered bounds
  in this repository, `competence: "passed" | "failed"` remains unreachable in a
  live system rather than being asserted on synthetic evidence.

  The no-fabricated-frame guarantee _is_ structural rather than asserted:
  `game.observe.frame` is validated as an artifact reference carrying a SHA-256
  and a byte count (`assertArtifactReference`), staged bytes are verified
  against that content-addressed reference before acceptance
  (`docker-sandbox.ts`), and an absent frame becomes a named
  `omittedArtifacts` receipt with `reason: "missing"` rather than a substitute
  (`core/tests/playtesting-evidence-packet.test.ts`). A fabricated video would
  have to hash to bytes that exist.

- [~] 6. Human/statistical validity: the scientific lock is pinned and
  enforced (`statistics/lock-manifest.ts` raises on drift), and real SciPy
  intervals are recomputed in tests. **Missing: a real-data integration gate
  for playtesting specifically.** The 10k index test uses a synthetic
  fixture; the existing Postgres integration covers Memory, not playtesting.
- [x] 7. Data/Console: indexed and cursor-paginated queries, addressable replay,
      stable URL state, explicit partial/error states and server-authoritative
      actions are implemented, with a 10,000-row correctness test. Navigation
      and replay selection now have a calibrated timing assertion over the pure
      address-state helpers (`30293c49`), which covers the console half of the
      cross-cutting ledger's performance requirement. **Caveat:** the 10k test
      asserts correctness rather than latency, and the browser-side rendering
      path still has no timing assertion — that belongs with the browser
      acceptance, which has not run.
- [~] 8. Portability and first milestone: the second mechanically different game
  joins by configuration alone (`e0cca05a`), the 40-critique cap is enforced,
  and a synthetic 1,000-episode cycle records finding, comparison and a
  hold next-cycle state. **Missing: 1,000 authoritative episodes** — the
  existing cycle is synthetic, which this document's own boundary
  (`docs/playtesting-target-state.md`) excludes as production evidence — and
  there was **no second reachable policy** until the registry below.

## Cross-cutting acceptance ledger

- [~] Scenario coverage audited against named tests. Of the thirteen cases in
  the first bundle, twelve have a named test: no-finding (`many null/no-effect
outcomes remain visible`, `zero-denominator stratum: standardized rate is
null`); malformed/interrupted/partial run (`run status restores interrupted
batch progress from Data and durably closes unknown assignments`, `batch
assignment validation rejects duplicates, malformed and oversized
inventories`, `episode cancellation ... preserves partial evidence`);
  known reproducible defect (`checkpoint equality requires exact hidden-state
and reproducible RNG identity`); unverified hypothesis
  (`assertPlaytestFindingEvidenceStatusConsistent accepts a 'hypothesis'
finding`, `a hypothesis is never drafted as a confirmed defect`); missing
  frames (`packet records a missing frame explicitly without fabricating a
frame locator`); model drift (`evidence packet refuses ... assignment drift`,
  `a measured judge that drifts is failed, not insufficient`, `changed judge
invalidates critic measurements but not unchanged deterministic metrics`);
  matched/unmatched cohorts (`three-build mix-shift gate`, `missing benchmark
stratum: ... unknown-incomplete-source-coverage`); hidden-state exposure
  (`evidence packet refuses hidden/unverified trace data`); no
  ratings/disagreement (`small-cell human sample (<5) suppresses
human-confirmed claim`, `an entirely unmeasured judge is insufficient`);
  invalid links (`rejects a 'verified' finding citing a nonexistent locator`);
  unauthorized actions (`playtest.run enforces role permissions`, `workspace
agent-role allowlists govern status, wait, and cancellation`); and 10k-record
  queries (`data/tests/playtesting/playtest-repository.test.ts`, 10,000 rows).

  **The one gap is `absent adapter`.** An adapter that cannot start at all is
  covered at two edges only: the config layer refuses an adapter command that
  differs from the approval (`command-mismatch`), and the core terminal-state
  layer separates infrastructure loss from a game failure. The end-to-end path
  where the binary is missing lives in `docker-sandbox.ts`, and those are the
  tests this environment cannot run (`EPERM` teardown), so the case is named
  rather than claimed.

- [~] Measurement denominators, missingness, uncertainty, cohorts, sampling,
  event/trace provenance, distinct execution/gameplay/interpretive status, and
  protected human data each have a named test (`batch aggregates keep all nine
denominators with game and infrastructure apart`; `coverage preserves missing
assignments, missing metric rows, and unresolved historical cohorts`; `human
confusion requires uncertainty beyond the game-owned threshold`;
  `allocatePlaytestSurveillanceStrata ... by largest remainder`; `version-one
restricted state migrates atomically without losing consent or PXI data`;
  `batch terminal state separates cancellation, infrastructure loss and
truncation`). **Not checked, because "end to end" is not what these are.**
  They exercise the arithmetic and the validators directly, not a real
  authoritative playtesting run — which is Delivery Slice 6's gap, and checking
  this box would assert the thing that slice says is missing.
- [~] Keyboard/mobile navigation, stable filter → finding → session → back,
  no fabricated media, source-mapped UI logic, and performance on indexed
  queries, view changes, and replay selection. Production Playwright covers
  the navigation/mobile path against an explicitly synthetic fixture.

  **The view-changes/replay-selection timing assertion was measuring the test
  runner, not the Console.** It carried a 150ms wall-clock ceiling for 2,000
  navigation round-trips, calibrated when that path measured ~35ms unloaded.
  Inside the parallel suite the same healthy path measures anywhere from ~35ms
  to ~600ms on one machine, so the assertion failed on contention while the code
  it guarded was unchanged. Two attempts to optimise the implementation were
  measured and rejected: hand-rolling the `URLSearchParams` serializer (the
  largest isolated cost) was **2x slower** than the native one, and threading
  `step` through options instead of copying the scope was within noise. Neither
  was kept, so `playtesting-url.ts` is untouched.

  What changed is what the assertion measures. It now asserts **linearity** --
  the property the acceptance actually names -- as per-iteration growth: 2,000
  round-trips against 500, each total divided by its own iteration count. Linear
  reads ~1.0 and quadratic ~4.0, against a threshold of 2.5. Warm, and
  best-of-three per size. An injected quadratic turns it red (5.32x).

  Comparing _totals_ (4x work against 1x) was tried first and rejected on
  evidence: the larger sample runs four times longer, so it absorbs four times
  as much scheduler noise and the ratio inflated to a spurious 24.7x on a loaded
  runner. Dividing by each sample's own iteration count cancels that, because a
  fixed pause costs more per iteration in the shorter run and so biases the
  comparison downward rather than flaking it.

  **What this assertion no longer covers, stated plainly.** It no longer asserts
  a wall-clock ceiling, and a cost-relative-to-calibration guard was built and
  then removed: it also flaked (30.5x against a 25 threshold) because the
  navigation path allocates several times more than a tight calibration loop and
  absorbs memory pressure differently under load. Only the measurement that
  survived three consecutive parallel runs was kept. Detecting a uniformly
  slower path is therefore **not** covered here and needs the browser-side
  timing assertion. A guard that fails on contention trains people to ignore it,
  which is worse than a narrower one that holds.

  The synthetic browser suite now covers the navigation/mobile portion, but
  it does not establish timing on an indexed live Data set or actual RacingGame
  results. Those remain open; no wall-clock threshold was relaxed.

- [x] Console run/watch and analyst dispatch: the operator starts approved work,
      watches every nonterminal batch without manual refresh, and can dispatch
      bounded analyst reviews. Runtime remains the single owner of runs, task status,
      eligibility, critique budget, and receipts. Assignment outcomes are surfaced
      from the owner's `PlaytestCompletionCounts` (`e6c3fbd1`), not inferred from
      aggregate counters. The synthetic browser suite covers start→watch→cancel,
      stale reads, dispatch→running→persisted review links, and oversized-selection
      refusal; the target-game run gate is recorded separately below.
- [x] Declarative game onboarding: `init`/`check`/`conformance`, the hash chain,
      the binding contract and the generic adapter runtime all exist, a real episode
      runs through the adapter entrypoint (`b6fe554e`), and the acceptance below is
      met by a second, mechanically different game joining by configuration alone
      (`e0cca05a`), and both tiers onboard a game — declaratively or through
      `init --scaffold` (`6c0b6aea`).
- [~] Documentation, test coverage, package checks and independent validation
  match the final integrated diff. Documentation, focused tests, typechecks,
  and the synthetic Playwright acceptance have executed. Full end-to-end
  RacingGame evidence remains unverified: no active approval matches the current
  local build, and the target checkout is dirty. Delivery Slices 1, 2
  and 7 are `[x]`; the remaining slices keep their named empirical gaps.

## Current evidence and gates

The playtesting worktree contains substantial concurrent changes across Core,
Data, Runtime, Console, and tests. They are preserved and must be reviewed as
existing changes, not assumed complete. CodeGraphContext returned no
playtesting symbols; targeted CocoIndex searches were used to locate the active
paths. The earlier 2026-10-14 approval lookup and installed-API probe below are
historical and have since changed. A fresh 2026-10-15 capability read reports an active Workspace approval
revision 3 for build `beb03c21ec2faa1e5bc2a5bd9cd232f1dd70f031`. The local
RacingGame `HEAD` is now `a1f3a95360e879d8562ab223bd448f6e1dc4ed50`;
in-progress RacingGame UI/effects/test edits make the worktree dirty. The canonical ESM adapter
remains current and `playtest:game-manifests:check` passes because those files
are outside its bundle. The active approval covers only `beb03c21...`; it does not cover the current
local `HEAD`. The managed Console's one-assignment action still targets the old
approved build, and it was not submitted.

## Prior validation snapshot (2026-10-11)

This implementation remains **incomplete**; the target documents' empirical,
production, and full-cycle acceptance gates remain authoritative. This wave
added/fixed:

- Consent-version/scope validation on legacy migrations and current restricted
  human response reads, including persisted paired-preference rows. Mismatches
  fail closed before summaries can count them.
- Disjoint instrument-response vs paired-preference quarantine views, with
  explicit empty arrays for the other family.
- Installation manifest coverage for the pinned statistics worker's TypeScript,
  Python, lock and operator-documentation files.
- Per-review finding submissions are capped at 64; distinct fingerprints append
  with bounded concurrency and stable result ordering. Same-fingerprint writes
  remain serialized, and the over-cap request is rejected without truncation.
- Comprehension claims now use game-owned thresholds and externally supplied
  uncertainty intervals; threshold-overlapping/unavailable intervals do not
  become human-confirmed confusion. Controlled-warning effects require
  qualifying human evidence and an interval. The small-cell minimum is shared
  with the canonical human-study privacy threshold.
- A real-browser Playtesting Console E2E run against its labeled synthetic API
  fixture: overview facts, finding → exact replay step → filtered back link,
  mobile overflow/keyboard tabs, exact-build approval, and in-place approved
  run/status/cancel all passed. This is usability evidence for the Console only,
  not a game run or production playtest.

Validated evidence so far: root tests **1,456 passed / 5 skipped**; Core
**242/242 passed**; Data **355 passed / 9 skipped** (including persisted consent
mismatch cases); Runtime **812 passed / 5 skipped**; Console **551 passed**;
Playtesting browser E2E **5/5 passed**; locked statistics worker tests **28
passed / 2 intentionally gated**. Cross-workspace TypeScript typecheck passed.
A targeted ESLint sweep across Core/Data/Runtime/Console Playtesting source,
Control API endpoints, and tests now passes with no rule disables. This includes
Core measurement/validation refactors, bounded review finding inputs, and
ordered bounded finding appends.
The global `pnpm lint:ci` is still not a clean gate: it traversed generated
`.probe`/`.next` artifacts and reported 21k+ errors there. No lint rule or test
threshold was relaxed.

Independent review confirmed the consent, quarantine, and worker-install fixes.
The lock-tag remains a Runtime capability gate rather than a Core dependency:
Core validates a frozen non-empty plan; Runtime computes no interval and keeps
unsupported plans inconclusive unless the exact locked worker specification
matches. This preserves workspace ownership and the documented no-claim state.

## Batch assignment, progress and critique sampling

The canonical multi-assignment execution slice now has an implementation path:

- `playtest.run` accepts an ordered, bounded `assignments[]` inventory. Runtime
  validates every cell against the exact approval/configuration and benchmark,
  reserves cumulative episode and worker budgets before launch, freezes a
  content-hashed manifest (at most 1,000 assignments/256 KiB), and records
  assignment outcomes separately from game outcomes.
- Live run status reports outcomes as workers persist. A completed worker no
  longer disables cancellation for its still-running peers. Truncation remains a
  distinct terminal status; cancellation reason is durable, and stale recovery
  records `nonterminal-batch-recovered`. Partial/cancelled/truncated sessions
  are not eligible for complete-session critiques.
- Runtime requires `getBatch` from the Data repository. After restart, status
  and active-runs recovery verify the frozen manifest, read
  workspace/batch-filtered episode pages, reconstruct only evidenced episode
  outcomes, record missing assignments as infrastructure loss, and append an
  interrupted/failed batch revision with durable `nonterminal-batch-recovered`
  provenance. Cancellation cause is retained separately. It never fabricates an
  episode. Historical pre-manifest batches stay explicitly inventory-unavailable.
- Review IDs are idempotent across a persisted review whose receipt write failed;
  actual critique counts increment only with a durable receipt and the cap is
  enforced before a new analyst review. Surveillance/discovery selection excludes
  partial, cancelled, crashed, infrastructure-failed and truncated sessions;
  the first milestone's per-batch critique cap is 40; Data round-trips a full
  1,000-assignment incomplete batch within its bounded indexed-payload limit.
- Console now creates and validates multiple assignment rows, shows approved
  cell/step/batch limits, prevents duplicate scenario/policy/seed cells, exposes
  progress and partial outcomes, and links only persisted episodes. Browser
  testing uses an explicitly synthetic Control API fixture; it is not a game run.

This is **mechanics and usability coverage**, not completion of the first
milestone. The full target remains incomplete. No target-game workspace/build
approval, explicit bounded run authorization, human-study authorization, or
issue-publication approval was provided. Consequently, the following gates
remain unpassed: a capability-driven checkpoint/RNG-safe branch path
(`playtest.branch` currently reports unsupported); 1,000 authoritative episodes
with two independent policies and exact evidence; a second mechanically
different adapter/game; real held-out human data; verified upstream code paths
and Console source map; and a production finding → candidate → comparison →
next-cycle history. Synthetic fixtures are not substitutes for any of these
claims. Preserve unrelated concurrent worktree changes, including non-playtesting
timeout/router-test adjustments.

## Current validation snapshot (2026-10-12)

For the multi-assignment batch/recovery/Console slice:

- `pnpm typecheck`: passed across root, Core, Data, Console and Runtime.
- Full workspace suites: Core **254/254 passed**; Data **357 passed / 9 skipped**;
  Console **554/554 passed**; Runtime **817 passed / 5 skipped**.
- Playtesting browser build and usability suite: **6/6 passed**. The synthetic
  fixture exercised desktop/mobile behavior, duplicate-cell refusal, generation
  and submission of a 1,000-assignment batch, cancellation reason, terminal
  status, and assignment links. Separate route tests accept 1,000 entries without truncation
  and reject 1,001 before Runtime. No game executable was launched.
- Targeted ESLint (zero warnings/no rule disables) and Prettier checks passed for
  changed Playtesting source, tests, routes, fixtures, and docs.
- Root `pnpm test` remains not fully green in this environment: **1,455 passed,
  1 failed, 5 skipped**. The single unrelated failure is
  `tests/hooks/memory-session-end.test.ts` asserting empty child stderr while
  Node emits its `MODULE_TYPELESS_PACKAGE_JSON` warning before the hook runs.
  The root command stops before recursive workspace tests; the workspace suites
  above were run separately. Do not suppress or weaken this unrelated assertion
  as a playtesting workaround.

These checks prove code contracts and synthetic Console usability only. The
external target-game, empirical human, upstream source-reuse, second-adapter,
and full-cycle evidence gates remain open.

## Checkpoint-backed branch execution (active slice)

The branch path must use the existing Runtime run owner, approval checks,
assignment reservation, sandbox lifecycle, and persisted batch/episode records;
MCP is only the authenticated request facade. A branch is one frozen assignment
whose manifest records the parent episode/revision/trace hash, exact decision
step, legal alternative, same-stream RNG policy, and continuation policy. It
must reserve its one episode/worker plus a total step ceiling that includes the
replayed prefix. Before launching, Runtime resolves the parent only from the
trusted workspace Data repository and verifies exact approved build/config,
complete replayable source evidence, and the advertised legal alternative.

The adapter protocol will make the counterfactual proof explicit: ordinary runs
record a compact full-state and RNG checkpoint digest per decision; a branch
sandbox receives the verified trace through a read-only content-addressed input
mount, replays exactly to the pre-action state, materializes a bounded snapshot,
compares state/RNG digests with the original checkpoint, forks, then lets
Runtime validate and execute the alternate legal action before continuation.
Snapshots and input artifacts are bounded by the existing approval artifact
quota. A mismatch, unreplayable trace, unsupported operation, hidden-state
hash/RNG gap, invalid action, or unavailable persisted artifact is never
upgraded to a paired-counterfactual claim. Branch lineage and snapshot evidence
must be durable on the resulting episode. Synthetic adapter fixtures prove
Runtime mechanics only; the target game's actual support remains a separate
adapter/evidence gate.

- [x] Define and validate exact replay-through-decision, state/RNG checkpoint,
      snapshot, and fork semantics in Core; test malformed and divergent results.
- [x] Capture per-decision checkpoint digests only for adapters that advertise
      the complete deterministic branch capability; keep unsupported capability
      explicit without marking unrelated gameplay evidence fabricated.
- [x] Transfer source traces into the isolated adapter using a verified,
      read-only, SHA-addressed input artifact mount; enforce byte and path bounds.
- [x] Run replay → state/RNG equality check → snapshot → fork → legal alternate
      step → policy continuation under the shared approved Runtime run owner.
- [x] Persist and validate parent, trace, checkpoint, RNG, alternative, and
      snapshot artifact lineage; reject cross-workspace/build/revision links.
- [x] Adversarial synthetic branch coverage now includes hidden-state and
      extra-RNG divergence, a now-illegal alternate, corrupted snapshot bytes,
      over-budget continuation, branch cancellation, approval revocation,
      shared Control API ownership, SHA-mount bounds, and durable lineage Data
      round-trip. Do not claim target-game branch support absent its actual
      adapter evidence.

## Independent target-state acceptance audit (2026-10-12)

This section records the audit-time state. The code-gatable coverage path below
was subsequently implemented; the evidence packet, owner experiment/comparison
workflow, helper integrations, and external gates remain open.

A read-only source audit outside checkpoint/branch work identified additional
code-gatable gaps that synthetic coverage does not close:

- The registry/evaluator integration has since been implemented: approved
  metrics bind evaluator refs/hashes, game outcomes return typed sufficient
  statistics, Core validates and normalizes them, and Data persists them. The
  remaining gap is the target-owned critical-cell coverage plan and its
  runtime/Data/Console manifest path.
- At audit time, the `PlaytestEvidencePacket` was a Core contract only. The
  follow-up below adds a pure bounded Core builder, but Runtime has not yet
  persisted the packet, exposed it to the analyst role, or bound it to a stored
  review receipt/model invocation.
- Comparison builders and experiment transition helpers exist in Core/Data but
  are not called by an owner workflow. `playtest.compare` only reads stored
  comparisons; there is no integrated immutable experiment → comparison →
  owner-decision cycle.
- Several implemented Core helpers are not consumed by persisted workflows.
  Finding triage now has an executor (`playtest.triageFindings`) and the
  player-policy-validity derivation has one (`playtest.policyValidity`). The
  rest remain unconsumed, and each was checked against its own data source
  rather than assumed buildable -- they fail for four different reasons, so
  "wire them up" is not one task:

  - **Native timing** is blocked at the protocol. `nativeIntervals` is written
    as a literal `[]` by `runtime/src/playtesting/episode-runner.ts:461`, and a
    search of `protocol.ts` and `protocol-types.ts` finds no message an adapter
    could use to report one. `precedenceVersion` and the `precedence` order
    exist only inside `native-timing.ts` and the artifact type -- the
    observation contract does not declare them. Its own doc says the
    "game/browser instrumentation supplies the intervals and versioned
    precedence contract", so both are a protocol extension and a game-declared
    contract, not a Runtime wiring job.
  - **Cohort standardization** now has an executor
    (`runtime/src/playtesting/cohort-standardization-run.ts`,
    `playtest.cohortMixShift`). `PlaytestCohortObservation` is `{ numerator,
denominator, missing }` per cohort, derived by summing persisted episode
    metric rows grouped by `policyCohort`, and the weights come from the
    approved benchmark's frozen `cohortWeights`.
  - **The diagnostic ladder** needs human evidence that does not exist here, so
    `competence: "passed" | "failed"` stays unreachable rather than asserted on
    synthetic data.
  - **Cadence / judge calibration** consumes `PlaytestJudgeValidation`, which
    is named by only two Core files and one Core test -- it has no producer, so
    there is nothing for `evaluateJudgeCalibration` to score.

- External gates still require exact target-game approval and evaluator/event/UI
  contracts, an authorized 1,000-episode/two-policy run, a second mechanically
  different adapter, authorized/held-out human evidence, upstream reuse/license
  proof, and demonstrated production fix-lineage history. No synthetic test
  substitutes for these.

At audit time, the next independent code wave was the game-owned coverage matrix
and opportunity-count aggregation/persistence. That slice is now implemented
below. The remaining code waves are the bounded evidence-packet/analyst
consumer, owner-side frozen experiment analysis/decision persistence, and the
remaining helper integrations. Runtime does not import or evaluate arbitrary
target code: the approved adapter executes its own evaluator and returns
hash-bound sufficient statistics for Core to validate. No synthetic fixture
claims production evaluator or population coverage.
The audit did not run a game or modify files. `git grep`/source
inspection was used because the local CodeGraphContext service was unavailable.

A later independent diff review found one real Data migration defect: a frozen
batch whose manifest had a non-object value was mislabeled as pre-manifest
history instead of failing closed. The migration now distinguishes true absent
pre-manifest history from malformed frozen state, and a regression test proves
the malformed row is rejected. The review also highlighted the evaluator-hash
trust boundary. Runtime verifies the adapter-reported hash against the frozen
rubric, but this is provenance matching, not remote attestation of the code path
executed inside an approved adapter image. The operator-approved image/checkout
is the execution trust root; no target image or source was supplied here to
verify that it executes the declared evaluator. Do not elevate this hash field
to an independent validator or human-calibration claim.

### Checkpoint/branch implementation and synthetic validation (2026-10-12)

The generic Runtime branch path now runs only from a complete, workspace/build/
config-matched, replayable parent whose frozen trace records an exact legal
alternative and full-state/RNG checkpoint. It replays to the pre-action step,
compares state and stream hashes, materializes and verifies one snapshot, forks,
checks current legal actions, applies the intervention through `game.step`, and
continues under the chosen policy. The branch is a one-assignment run through
the same Runtime owner and existing approval/budget/cancel/recovery path. The
replay-prefix and continuation share the approved 4,096-step trace bound.

Runtime mounts input trace bytes read-only at a content-addressed SHA path and
checks input plus output evidence against one approved artifact-byte quota. The
branch episode stores its frozen parent/trace/checkpoint/action/RNG/snapshot/
continuation lineage. Core validates v2 branch lineage; Data performs one-way
episode-v1/v2 → v3 and assignment-manifest-v1/v2 → v3 migrations, including
explicitly unresolved cohorts for historical assignments, and rejects
inconsistent proof chains.

Synthetic acceptance: Core protocol/lineage **5/5**, Runtime branch/episode
runner and MCP/Control API owner flows pass, Data branch lineage and one-way
episode/assignment-manifest migrations pass, and Docker tests prove hash verification, read-only SHA mount,
quota and cleanup. The branch-run test separately exercises cancellation and
approval revocation. These are protocol/security/budget mechanics only. No
actual target adapter was supplied; a real game's snapshot/RNG semantics remain
unverified. Remaining code-gatable priorities from the audit are the bounded
evidence-packet/critic pipeline, owner-side experiment/comparison persistence,
and integration of implemented
timing/diagnostic/cohort/triage/cadence helpers.

## Game-owned evaluator dispatch and batch coverage (code path implemented)

- [x] Metric registry schema v2 and measurement version v2 bind each
      evaluatorRef to an exact evaluator SHA-256. Runtime passes the approved
      expanded registry into the runner.
- [x] The adapter outcome contract carries typed per-metric/phase sufficient
      statistics (metric ID/phase/reference/version/hash, numerator, denominator,
      opportunity count, missing count/reasons, independent units and unit).
      Whole-episode rows use `phaseId: null`. Unknown/duplicate metric-phase
      pairs, omitted required rows, source/hash/version/unit drift, and
      inconsistent counts fail closed.
- [x] Core normalizes only by the frozen definition: estimates/coverage are
      derived from returned counts, human-post-play rows remain in the consented
      study path, unsupported modalities are explicitly null, and no evaluator
      expression or target source is loaded/executed by Runtime.
- [x] PlaytestNumericResult persists phase, full opportunity count and
      build/evaluator/rubric provenance; Data validates and round-trips the
      canonical result. Historical episode-v1/v2 metrics migrate with
      `phaseId:null` where absent and v1 `opportunityCount:null` rather than a
      fabricated exposure denominator.
- [x] Synthetic Core/Runtime/Node/Python/Data tests cover valid normalization,
      stale hash/reference/version/unit, missing rows, duplicate/unknown rows,
      impossible denominators, null opportunity results, and durable readback.
- [x] Add rubric-owned mechanic × phase × scenario × cohort × policy ×
      modality coverage requirements; freeze policy cohort in assignment
      manifests; derive observed counts only from validated game-owned
      evaluator rows; content-address the per-batch coverage manifest; persist
      and validate it in Data; and display per-cell status/counts in the
      workspace-filtered Console Overview.
- [x] Keep non-episode independent-unit totals null until cross-episode
      identity deduplication is available. Whole-episode units are additive;
      missing assignments, missing result rows, unsupported cells and modality
      mismatch remain distinct, non-zero-imputed states.

This is code-contract coverage only. Runtime compares the adapter-reported SHA
to the frozen rubric but cannot independently attest which code path the adapter
executed. The exact target source/image must be inspected and approved before
treating evaluator provenance or coverage as production evidence. The
code-gatable coverage path is implemented; a production matrix, target-game
coverage claim, and empirical first-milestone run remain external gates.

### Validation snapshot before coverage completion (2026-10-12)

- `pnpm typecheck`: passed for root, Core, Data, Runtime, and Console.
- Full workspace test run: Core **266/266 passed**; Data **360 passed / 9 skipped**;
  Console **554/554 passed**; Runtime **825 passed / 5 skipped**.
- Playtesting Console build and synthetic-browser usability: **6/6 passed**.
  This is UI workflow evidence only; it is not game or human evidence.
- Targeted ESLint (zero warnings / no rule disables), Prettier checks, and
  `git diff --check`: passed for the inspected changed Playtesting files.
- Root `pnpm run test:root`: **1,460 passed / 1 failed / 5 skipped**. The lone
  unrelated failure remains `tests/hooks/memory-session-end.test.ts`: Node emits
  `MODULE_TYPELESS_PACKAGE_JSON` to child stderr, contrary to that test's empty-
  stderr assertion. No test threshold or stderr behavior was changed to mask it.
- Independent validator review found no branch/evaluator execution-path defects.
  It identified the frozen-manifest corruption fail-open; that is now fixed at
  the Data migration source with a regression test. Its hash trust-boundary
  observation is documented: Runtime compares the adapter-reported code SHA to
  the frozen registry, but this is not remote attestation of code execution.

No target game was launched, no target-game approval/run authorization was
available, and no human study was authorized. The code-gatable coverage
manifest, critic packet/analysis owner, experiment/comparison owner workflow,
remaining metric-helper integrations, and all external evidence gates remain
open; the overarching implementation goal is not complete.

### Coverage-manifest implementation and final validation (2026-10-12)

The code-owned path now has a single phase-aware metric/coverage contract:

- Whole-episode evaluator rows use `phaseId: null`; phase-window rows bind to
  each required non-null phase. Data rejects duplicate metric/phase rows.
- Rubric cells bind exact scenario-family/cohort/policy/modality profiles.
  Runtime rejects a phase-window assignment with no plan cell before launch.
- The v3 assignment manifest freezes cohort per assignment. Batch schema v2
  persists a coverage manifest with workspace/batch/build, rubric and assignment
  hashes, all plan cells, opportunity/missing/independent-unit counts and
  explicit partial/unsupported states. Runtime rebuilds it after an interrupted
  run; Data verifies the content hash and batch identity; Console validates and
  renders the latest per-cell summary.
- Non-episode independent-unit totals remain null until cross-episode
  deduplication is possible. Episode-v1/v2 measurement rows migrate to episode
  v3 with null phase where the historical row did not record one. Assignment
  manifest-v1/v2 histories migrate to v3 with unresolved cohort identity;
  batch-v1 histories have no fabricated coverage manifest.
- Added tests for exact phase normalization, whole-episode null phase, missing
  and duplicate results, 100 easy assignments failing to cover a missing hard
  cell, partial/missing assignments, unsupported modalities, unresolved legacy
  cohorts, non-additive learner identities, manifest hash corruption and the
  Console coverage display. The synthetic browser fixture remains explicitly
  synthetic and verifies a covered cell; it is not game evidence.

Final validation after this slice:

- `pnpm typecheck`: passed for root, Core, Data, Runtime and Console.
- Workspace tests: Core **272/272**; Data **361 passed / 9 skipped**;
  Console **555/555**; Runtime **825 passed / 5 skipped**.
- Playtesting browser build and usability: **6/6 passed**, including the
  server-filtered per-cell coverage display, 1,000-assignment form, and
  run/cancel flow. No target game was launched.
- Targeted ESLint (zero warnings, no rule disables), Prettier, and
  `git diff --check`: passed for the changed coverage slice.
- Root tests remain **1,460 passed / 1 failed / 5 skipped**. The unrelated
  failure is `tests/hooks/memory-session-end.test.ts`: Node emits a
  `MODULE_TYPELESS_PACKAGE_JSON` warning to child stderr, violating its empty-
  stderr assertion. No threshold or unrelated assertion was changed.

The coverage implementation closes only the mechanical path. No target-owned
production rubric/adapter was approved, no authorized 1,000-episode/two-policy
run or human study occurred, and the evidence-packet/analyst consumer,
experiment/comparison owner workflow, remaining metric-helper integrations,
second adapter, verified upstream reuse and production fix-lineage gates remain
incomplete. The goal is active and not complete.

### Bounded evidence packet builder (Core checkpoint)

The existing packet type was metadata-only and had no builder. Core now defines
strict projected per-step input records and a deterministic packet builder that
selects game-specific event-bearing steps and the terminal step, then adds evenly
spaced ordinary context under fixed window/step/byte/token bounds. Generic
`decision_applied` events repeat the action/revision already present in their
trace step; they remain eligible for ordinary sampling instead of making every
step mandatory. If specific-event or terminal evidence alone exceeds the budget,
packet creation fails rather than trimming it. Every unselected source range is
recorded with a reason, and the full source trace remains available separately.
The builder rejects unverified visibility, hidden trace fields, evaluator-
provenance drift, cross-assignment identity, duplicate events, and missing frame
hashes. Packet selection labels retained events as evidence anchors, not as
semantically verified taxonomy facts.

Core tests cover deterministic selection, ordinary omissions, exact trace
partitioning, mandatory-evidence overflow, byte/token budget omissions,
hidden/unverified records, assignment mismatch and packet shape validation.
At this Core-only checkpoint the Runtime/Data/analyst path was not yet wired; the
following active slice records that integration. Trusted model/prompt identity
propagation remains unavailable and is kept null, so no human-calibrated claim
is supported.

### Runtime/Data analyst-packet integration (active slice)

This wave connected the bounded Core packet builder to the real batch/review
path without claiming an analyst inference or target-game result:

- Terminal Runtime batches now create a deterministic packet receipt for every
  selected complete session. Trace/frame provenance is read only through the
  workspace-bound artifact store; malformed, unavailable, hidden, or oversized
  inputs produce explicit packet-unavailable receipts. Coverage is constructed
  once per batch and reused across its packet builders.
- Added analyst-only `playtest.prepareReview`; it returns only the durable
  selected packet and exact artifact reference. `playtest.submitReview` now
  requires the packet ID/artifact ID/SHA-256 and rejects every citation outside
  the exact selected packet. The playtester role cannot retrieve or submit
  reviews. Model and prompt provenance remains explicitly null until trusted
  invocation identity is available.
- Batch schema v3 persists packet receipts and a reserved/persisted critique
  ledger. Data validates one explicit prepared/unavailable receipt per selected
  session, packet reference metadata, and review-receipt linkage. Selected V1/V2
  sessions migrate to `recorded-before-evidence-packets` unavailable receipts;
  legacy review receipts migrate as persisted, with `packetId: null` where the
  older row did not bind a packet. Review schemas V1/V2/V3 migrate to V4; legacy
  observation/interpretation text is preserved with empty per-claim citations,
  and V1 packet provenance remains explicitly null. Pre-contract batches retain
  `coverageManifest: null` and cannot produce analyst packets. V3 records missing
  packet inventory fail closed.
- The analyst prompt/skill and session-review reference now require packet-first
  analysis and exact packet identity on submit. Core/Data/Runtime and role/skill
  tests cover selected-window locators, source-bound packet round-trip,
  unavailable packets, missing/forged packet references, unauthorized roles,
  citations outside the packet, receipt completeness, bounded packet-ID syntax,
  pending-vs-persisted critique reservations, per-claim review citations, and
  the V1/V2/V3-to-current review migration. Review-finding evidence status is preflighted across the full
  review before writes; an identical retry after a partial storage failure
  reuses existing evidence rather than creating a redundant revision.
- Runtime integration tests exercise a completed synthetic batch through
  packet generation, durable batch receipt and analyst retrieval. The MCP role
  gate is also enforced inside each exclusive read/analysis handler, not only
  through provider-side allowlists. `submitReview` stores the packet's numeric
  results verbatim, derives dimension categories from the exact rubric indicator
  and metric when available (otherwise null), and accepts cited dimension
  rationale, alternatives and falsifiable metric-bound experiments. Review
  findings are preflighted before any writes; durable reserved/persisted receipt
  states hold critique capacity across a review-row/batch-row write failure,
  and exact retries finalize the same reservation without taking a second
  slot. This proves mechanics/usability only; it is not a target-game run,
  model-quality study, or human calibration.

At the packet-integration checkpoint, packet blobs and ClickHouse batch
receipts were separate durable resources with no cross-store recovery. The
pending-marker/reconciliation slice below subsequently closed the orphan
reclamation gap without claiming a distributed transaction.

Remaining work is substantial: source/adapter provenance and trust-boundary
verification, model/prompt identity propagation, deterministic cross-session
aggregation, actual analyst-inference and independent claim-validator
integration, the
experiment/finding-to-owner-decision cycle, remaining helper integrations,
human validation, UI/upstream reuse audits, a second mechanically different
adapter, and the explicitly authorized empirical first-milestone gates. This slice does not complete Delivery Slices 1, 2, 4, 5,
6, or 8.

### Validation snapshot after packet, review-ledger and trust-boundary hardening (2026-10-12)

- `pnpm typecheck`: passed across root, Core, Data, Console and Runtime.
- `pnpm --recursive --if-present test`: passed. Core **279/279**; Data
  **363 passed / 9 skipped**; Console **555/555**; Runtime **825 passed / 5
  skipped**.
- Focused coverage: evidence packet Core **7/7**, Data playtest repository
  **23/23**, Runtime MCP **17/17**, Console review-claim rendering **8/8**,
  human-response repository **24/24**, and analyst/playtester role+skill tests
  **20/20**.
- Synthetic Console browser usability: production build succeeded and Playtesting
  E2E **6/6** passed (desktop overview/replay/back with a claim-level citation,
  mobile overflow/keyboard, exact-build approval, 1,000-assignment composer,
  run/status/cancel). This is Console mechanics only, not game or human evidence.
- Changed Playtesting files passed targeted Prettier and ESLint (zero warnings,
  no rule disables); `git diff --check` passed. Global `pnpm format:check`
  still reports four unrelated in-progress files outside this slice:
  `console/src/features/providers/ProvidersView.ts`,
  `console/src/features/skills/SkillRoleAssignment.ts`,
  `console/tests/console.test.ts` and
  `console/tests/skills-autosave.test.ts`. They were left untouched.
- `pnpm run test:root`: **1,460 passed / 1 failed / 5 skipped**. The sole failure
  remains the unrelated `tests/hooks/memory-session-end.test.ts` assertion that
  child stderr is empty while Node emits `MODULE_TYPELESS_PACKAGE_JSON`; its
  assertion/warning policy was not weakened.

The packet/receipt and human build-reference work remains code-contract evidence
only. No target game was launched, no workspace/build run was authorized, no
human study was authorized, and no target-game, human-calibration, or model
quality claim is made. The full target-state goal remains active.

### Review-v5 report-completeness contract (2026-10-12)

- [x] Added Core-owned report completeness for alternatives, experiments, follow-up,
      and cross-session-context availability. Explicit none/unavailable states
      require reasons and must agree with the corresponding review arrays; proposed
      experiments require a hypothesis, falsifier, metric, at least one control,
      and bounded budget.
- [x] Runtime requires this object on `playtest.submitReview`, rejects inconsistent
      section states before any review/finding write, and includes it in review
      identity. New submissions cannot claim cross-session synthesis because the
      only prepared packet remains single-session; they must state the context is
      unavailable.
- [x] Review schema v5 and Data migration preserve v4 and earlier history while
      marking missing completeness sections `not-recorded`. New writes reject that
      historical-only state rather than fabricating that the analyst considered a
      section.
- [x] Console now displays the completeness states, alternatives, experiment
      controls/falsifiers/metrics/budgets, and proposed/no-follow-up explanation.
      Role prompt and analysis skill explain the required shape and do not equate
      completion with independent validation.
- [x] Core/Data/Runtime/Console tests cover coherent and contradictory states,
      missing sections, legacy migration, and browser-visible completeness.

This closes the **mechanical report-completeness gate**, not the cross-session
analysis gate. Runtime still does not invoke the analyst itself or persist a
blind independent validator's fact/semantic/corroboration verdicts. Model and
prompt provenance remain null until supplied by a trusted invocation boundary.

Validation after the implementation:

- `pnpm typecheck`: passed across root, Core, Data, Console and Runtime.
- `pnpm --recursive --if-present test`: Core **281 passed**; Data **363 passed / 9
  skipped**; Console **555 passed**; Runtime **825 passed / 5 skipped**.
- Targeted Playtesting tests after strict-completeness refactoring: Core **72/72**,
  Data repository **23/23**, Runtime MCP **17/17**, Console renderer **8/8**.
- Playtesting Console production build and synthetic-browser usability: **6/6**
  passed, including claim citation navigation plus visible cross-session-unavailable,
  alternative and follow-up sections. This is UI mechanics only.
- Changed Playtesting source/tests passed targeted ESLint (zero warnings/no rule
  disables), Prettier, and `git diff --check`.
- Root tests: **1,470 passed / 1 failed / 5 skipped**. The sole failure remains
  unrelated `tests/hooks/memory-session-end.test.ts`: Node emits
  `MODULE_TYPELESS_PACKAGE_JSON` to child stderr. Its assertion/warning policy
  was not changed.

No target game, target-game build, or human study was authorized. Cross-session
synthesis, trusted model/prompt provenance, independent claim validation, the
owner experiment/comparison cycle, and all external empirical gates remain open.
The overarching goal remains active.

### Pending packet artifact commit and reclamation (2026-10-12)

- [x] Runtime writes packet references with a local `pendingCommitId` tied to the
      frozen batch. The marker is finalized only after the batch revision with
      the packet receipt is durably acknowledged; metadata updates are atomic.
      Older artifact metadata without the optional marker is read as committed.
- [x] Data exposes a workspace/batch-scoped read of all bounded batch revisions
      (maximum 128), returning the latest execution state and the union of
      persisted prepared-packet references. Conflicting hashes, malformed rows,
      history overflow, and source failures fail closed.
- [x] At MCP startup, Runtime reconciles only pending packet artifacts. It
      finalizes markers found in durable Data history; preserves packets for
      active batches, recent writes, mismatched references, and unavailable Data;
      and reclaims only expired packets or packets beyond the two-hour grace whose
      batch is terminal/missing with no receipt in its history. Inventory and
      per-pass batch work are bounded; deferred items are retried at a later MCP
      start.
- [x] Terminal batch writes with ambiguous acknowledgements are read back by
      exact canonical identity. A confirmed terminal commit is treated as success;
      otherwise Runtime avoids appending a potentially contradictory failure
      revision and lets normal status recovery resolve the batch.
- [x] Installed the reconciliation module through Runtime's source manifest.
      Tests cover marker finalization/idempotence, metadata migration, history
      references, terminal orphan removal, active/recent preservation, expiration,
      hash/workspace mismatch, Data outage/history overflow, and lost terminal
      write acknowledgement. A cross-workspace integration fixture composes the
      real Data repository with the Runtime artifact store.

This is an eventual recovery protocol, not a distributed transaction. If Data
remains unavailable, pending artifacts remain protected until a later successful
reconciliation or their configured artifact expiry.

Validation after this slice:

- `pnpm typecheck`: passed across root, Core, Data, Console, and Runtime.
- Full workspace tests: Core **281/281**; Data **365 passed / 9 skipped**;
  Console **555/555**; Runtime **832 passed / 5 skipped**.
- Focused tests: Data repository **25/25**; Runtime artifact store + packet
  reconciliation + MCP **39/39**; Runtime source-install manifest **30/30**.
- Targeted ESLint (no warnings/rule disables), Prettier, and `git diff --check`
  passed. Console files were unchanged; the existing synthetic-browser E2E
  remains **6/6 passed** from the previous validation.
- Root tests: **1,470 passed / 1 failed / 5 skipped**. The sole failure remains
  the unrelated `MODULE_TYPELESS_PACKAGE_JSON` warning on child stderr in
  `tests/hooks/memory-session-end.test.ts`; no assertion or threshold was relaxed.

No target game or human study was run. Source/adapter trust review, cross-session
synthesis, trusted model/prompt provenance, independent claim validation, the
finding-to-owner experiment/comparison cycle, remaining helper integrations,
upstream code execution verification, second-adapter portability, and empirical
first-milestone gates remain open. The overarching goal remains active.

### Bounded sibling context in analyst packets (2026-10-12)

- [x] Evidence packet schema v2 records a SHA-256 sibling inventory identity,
      deterministic selection seed, eligible inventory count, selected complete
      same-batch/build episode summaries, and the exact inclusion probability.
      The selected sample is capped at four and included in the packet ID and
      byte/token budget.
- [x] Runtime forms candidates only from persisted complete sibling episodes
      joined to their frozen assignment manifest. Partial/infrastructure outcomes
      are excluded; workspace, batch, build, rubric, policy, cohort and seed
      identity are checked before context enters the packet.
- [x] Reviews can mark context available only with citations to supplied whole
      sibling episode IDs. Core and Runtime reject arbitrary sibling IDs,
      unsupported step/event locators, missing citations, duplicates and forged
      context; the Console links those citations to the cited episode.
- [x] Packet v1 remains readable without upgrade. Review schemas v5 and older
      remain one-way readable with their historical unavailable/not-recorded
      state; new submissions use v6.
- [x] Core packet tests cover deterministic sampling, inventory/provenance,
      four-sibling bounds, citation scope and v1 reading. Runtime integration
      constructs and retrieves a real v2 artifact from a two-assignment synthetic
      batch and rejects a forged sibling citation. Console rendering covers the
      addressable sibling link. All are mechanics fixtures, not target-game
      evidence.

Validation for the integrated packet-v2 slice:

- `pnpm typecheck`: passed across root, Core, Data, Console and Runtime.
- `pnpm --recursive --if-present test`: Core **283/283**; Data **365 passed / 9
  skipped**; Console **555/555**; Runtime **832 passed / 5 skipped**.
- `pnpm run test:root`: **1,471 passed / 5 skipped**.
- Playtesting Console production build and usability E2E: **6/6 passed**;
  claim rendering and sibling-session links are covered by Console tests.
- Changed Playtesting TypeScript passed targeted ESLint with zero warnings/no
  rule disables, targeted Prettier and `git diff --check`.

Remaining cross-session work is the deterministic matched-seed/cohort aggregate,
an aggregate-grounded analyst workflow, and empirical review-quality validation.
The bounded sibling summaries are selected episode context only; they do not
close Delivery Slice 2/4/6 or any production/empirical gate.

### Experiment lifecycle and owner-decision invariants (2026-10-12)

- [x] Core now rejects persisted experiment states unsupported by their
      provenance: approved/execution states require the frozen approval ID,
      execution/result states require an attempt, analyzed/owner-decided require
      a comparison, and owner-decided requires a decision. Invalid historical
      records fail closed rather than being represented as valid lifecycle state.
- [x] The pure owner-decision helper now appends a new comparison revision,
      validates its timestamp/reason, and refuses to overwrite an existing
      owner decision. Its derived comparison eligibility remains code-owned and
      is not changed by operator text.
- [x] Core transition/state tests cover missing approvals, attempts, comparisons
      and decisions; Data repository fixtures now use valid approval-bound
      approved states and rejects lifecycle-invalid rows on both write and
      readback. Targeted Core **105/105** and Data repository **25/25** tests
      passed for this wave.
- [x] Final validation: `pnpm typecheck`; full workspace tests (Core **285/285**,
      Data **365 passed / 9 skipped**, Console **555/555**, Runtime **832 passed /
      5 skipped**); root tests (**1,471 passed / 5 skipped**); targeted ESLint,
      Prettier and `git diff --check` all passed.

This hardens the existing contracts; it does not yet provide the persisted
Runtime workflow that composes experiment execution with statistical
comparison. The separately persisted root/operator comparison decision path is
implemented in the follow-up below; experiment attempts are not yet bound to
comparison inputs.

### Persisted comparison owner disposition (2026-10-12)

- [x] Comparison schema v2 records `promote`/`hold`, the trusted actor, timestamp,
      and reason separately from the code-derived comparison eligibility. Core
      permits `promote` only for `eligible-for-owner-promotion`; it cannot alter
      the metric decision or invoke release/deployment.
- [x] Data migrates v1 comparisons one-way. Existing free-text owner decisions
      become `not-recorded` disposition with null author; absent decisions remain
      null. Current writes validate the owner-decision field relationships.
- [x] `playtest.decideComparison` is root/operator-only, requires the exact
      expected revision, appends a new revision through Data, serializes same-
      process writes per comparison, recognizes an exact retry after an
      ambiguous insert acknowledgement, and rejects stale or conflicting
      decisions. It does not open the game runner or write GitHub/releases.
- [x] Console comparison history distinguishes derived eligibility from the
      separately authored disposition, actor and reason. Authorized operators
      can submit an accessible same-origin promote/hold form with the current
      expected version; the row updates in place and explicitly states that no
      release/deployment occurred. Runtime tests cover Control API delegation,
      role denial, promotion gating, successful hold, exact retry, lost write
      acknowledgement, stale revision, and unchanged workspace approval.
- [x] `pnpm typecheck` passed. Focused Core **72/72**, Data **25/25**, Runtime
      owner/control/MCP **41/41**, Console route+render **10/10** passed. Browser
      production build and owner/run usability E2E passed **7/7**, including the
      owner form on a mobile viewport, keyboard traversal, cancellation of the
      confirmation step, and successful version-checked recording.
- [x] Full workspace suites: Core **285/285**, Data **365 passed / 9 skipped**,
      Console **557/557**, Runtime **834 passed / 5 skipped**; root tests
      **1,471 passed / 5 skipped**. Targeted ESLint, Prettier and
      `git diff --check` passed. The browser's owner-decision backend was the
      explicitly synthetic Control API fixture; no real game/release action ran.
- [x] Final broad validation: full workspace suites Core **285/285**, Data
      **365 passed / 9 skipped**, Console **557/557**, Runtime **834 passed / 5
      skipped**; root tests **1,471 passed / 5 skipped**. Targeted lint, format,
      and `git diff --check` pass for this slice.

This adds the durable owner-decision endpoint, not the full experiment cycle.
Comparison creation/analysis is still only a read of stored comparisons; fixed
experiment arm execution, approved variant mapping, input-derived statistical
analysis, and experiment lifecycle transitions remain unintegrated. The
comparison decision form is synthetic-API usability evidence, not a real game
experiment or release action. The
per-comparison lock is process-local; cross-process writers remain unsupported
until a durable coordinator is introduced.

### Console run/watch and multi-session analysis (partially implemented)

This slice records a target-state requirement added to
[`docs/playtesting-target-state.md`](../playtesting-target-state.md) §
"Playtesting Console UX".

**Delivered (2026-10-13):**

- [x] Live batch monitoring over the existing run-control owner: the
      workspace-scoped active-runs read now carries each batch's live owner
      record, so one request renders every nonterminal batch
      (`ControlApiPlaytestingActiveRunsResponse`, `PlaytestActiveRunSummary`).
      The Console polls with exponential backoff, stops once every batch is
      terminal, and never advances batch state itself.
- [x] A failed or unreachable read is an explicit `unavailable` state. Previously
      read frames stay on screen labelled "Last known" and flagged
      `data-stale`, rather than badging a frozen frame as current.
- [x] Progress updates announce politely without moving focus; the focused
      batch lives in bounded, shareable URL state (`liveBatch`) written through
      the History API, so refresh and Back restore it.
- [x] Cancellation is confirmed against a subsequent server-confirmed status
      read before mutating, rather than asserting a terminal disposition
      optimistically.
- [x] Core owns the canonical run-state set. Runtime and the Console validate
      against it, replacing two hand-maintained copies that had already diverged
      — the Console's guard rejected `truncated` while Runtime emitted it.
- [x] Bounded full-packet preparation: `playtest.prepareCrossSessionReview`
      takes 1..16 distinct sessions per response and returns every one exactly
      once, as its own packet or as a named receipt. It excludes
      partial, cancelled, crashed, infrastructure-failed and truncated sessions;
      checks the per-batch critique cap across the whole selection rather than
      per session; and never charges an ineligible session against the budget it
      could not have used.

**Delivered (2026-10-13, continued):**

- [x] A Console surface that selects several persisted sessions and requests
      analysis over them. Cross-session dispatch moved onto the run owner, so
      the MCP tool and `POST /control/playtesting/analyses` reach the same
      answer; the route authorizes and forwards and decides nothing. The
      Console holds the selection in bounded `sessions` URL state written
      through the History API, and refuses a response whose packets and
      receipts do not account for every selected session.
- [x] `PLAYTESTS_MAX_ANALYSIS_SESSIONS` lives in Core and equals the
      first-milestone 40-review ceiling. Console dispatch can select all 40 at
      once; direct full-packet preparation remains separately capped at 16, and
      its client rejects aggregate responses beyond the 1 MB transport bound.
- [x] Live status outcomes carry the game's own `gameOutcome` separately from
      assignment execution `state`; it is sourced from the persisted episode,
      while no-episode assignments carry null. This ephemeral Runtime projection
      does not alter the durable batch schema.
- [x] The Console validates every assignment result before rendering it and
      links only persisted episode IDs to their full session view. The detail
      keeps execution state, game outcome, start, and measurement eligibility
      separate. Focused Runtime/Console tests cover direct completion, restart
      recovery, no-episode outcomes, malformed/duplicate rows and navigation.

Current state, from source:

- `console/src/features/playtesting/PlaytestingRunControls.tsx` composes the
  bounded assignment inventory, starts an approved run through the typed Control
  API, renders one run record, and cancels it. The synthetic browser suite
  covers run start, manual status refresh and cancellation
  (`console/e2e/playtesting-usability.spec.ts`).
- `console/src/features/playtesting/PlaytestingLiveRuns.ts` is the client island
  that owns polling, the focused batch and the cancellation confirmation read;
  `PlaytestingActiveRunsPanel.ts` renders it; `playtesting-active-runs.ts` holds
  the pure read/terminal/backoff decisions so they are directly testable.

- Runtime now returns `PlaytestRunAssignmentOutcome` for every recorded
  assignment, with `gameOutcome` sourced from its persisted episode and kept
  distinct from the assignment's execution `state`. A missing episode has a
  null game outcome; an episode whose game cannot classify its result remains
  explicitly `unknown`. This status projection is not copied into Data's batch
  record, which continues to store only no-episode assignment dispositions.
- The Console validates the complete outcome list (including unique assignment
  and episode identities) before rendering it. Each row shows execution state,
  game outcome, start/eligibility, and a session-detail link only when the
  Runtime returned a persisted episode ID. The existing synthetic browser API
  fixture now emits the same typed result shape.
- Focused Runtime/Console coverage verifies completed game outcomes, absent
  episodes, restored outcomes after Runtime restart, malformed/duplicate rows,
  and the session link. No UI value is inferred from aggregate counts.

The Runtime dispatch, live read, confirmation read, and assignment-level
results are delivered. The remaining Console evidence is browser acceptance;
the remaining RacingGame evidence is a target-owned migration and an explicitly
approved run, recorded below.

The live view now renders the two independent outcomes per assignment: the
Runtime execution disposition and the game's classified `win/loss/DNF/other`
result. The tiles continue to read the owner's `PlaytestCompletionCounts`;
four previously read keys no producer emits and rendered "not observed"
permanently (`e6c3fbd1`). A row without a persisted episode has no game outcome,
and a game that cannot classify a persisted result reports `unknown`; neither is
reconstructed from execution state.

**RacingGame generic-binding migration (2026-10-13):** The local
`/Users/henrykirk/Desktop/RacingGame` branch advanced concurrently to
`6a8ca817b`, which includes the generic migration and concurrent UI/E2E changes.
The remaining modified precision-plan, presentation and E2E files were preserved; the
precision-plan edit in this tree records the review-cap assumptions. RacingGame now
uses AutoDev's generic adapter command and declares
`.autodev/playtest.binding.json`; its game-owned methods are isolated from
protocol transport. The TypeScript binding source is compiled by Vite into a
single dependency-free ESM entry in the approved checkout, so the Docker run
never depends on ignored `node_modules`. Arbitrary Console seeds map
reproducibly into RacingGame's nonzero uint32 RNG seed, and events use the
zero-based Runtime decision-step contract. The config enables at most one
surveillance review per batch; Workspace approval still controls the effective
critique ceiling.

Hash ownership is now split at the source: RacingGame generates only evaluator
hashes and engine-environment provenance; AutoDev owns the observation schema
link, action/event schema hashes, rubric/metric-registry links, and benchmark
content hash. I ran the game-owned manifest check and AutoDev's read-only
integration check; both pass, with only the expected warning for unsupported
optional replay/snapshot/frame capabilities. `autodev playtest check --write-hashes`
regenerated the AutoDev-owned links. The pure RacingGame binding/seed test is
**5/5**, and the generic ESM bundle is current. No adapter conformance or game
episode was run.

Validation refresh (2026-10-14): `pnpm run typecheck:src` and
`pnpm run typecheck:tests` now both pass. RacingGame's read-only
`playtest:game-manifests:check` also passes and confirms the generic ESM bundle
is current. `pnpm run build:prod` succeeds and verifies the production delivery
(34 hashed assets, 27 compressed resources); this is a build check, not a game
execution. The source-boundary test previously
wrote virtual ESLint fixtures under `src/ui`; two stale generated copies had
been left there and caused `typecheck:src` to compile their deliberately
missing import. The test now uses `ESLint.lintText` with virtual in-repository
paths, preserving all four boundary assertions without creating files in the
compiler include tree. The two confirmed stale test artifacts were moved out
of the checkout; no gameplay source was run. Earlier focused Runtime/CLI tests
covering binding/version validation, reset provenance, event capture, cleanup
and approved-config hashing passed **66/66** after the latest semantic fixes. A
broader loaded run had two generic-adapter process timeouts (**88/90**); those
exact cases and the full generic adapter process file passed separately
(**2/2** and **5/5**) with their original 10-second deadline. CLI init/check/
conformance tests passed **28/28**, and focused Console Playtesting
route/render/control tests passed **64/64**. No exact build authorization,
pinned-image approval, or bounded Workspace run authorization is present; the
RacingGame checkout currently has concurrent uncommitted changes, so its HEAD
alone is not an authorized build identity.

**Direct Console analyst invocation and browser acceptance (implemented, 2026-10-14).**

- `POST /control/playtesting/analyses` has an explicit dispatch operation while
  the analyst MCP's packet-preparation operation remains read-only. Runtime's
  existing `PlaytestRunOwner` serializes dispatch reservations through its shared
  lock, rejects duplicate/already-reviewed/already-running sessions, enforces the
  per-batch critique budget and global active-task bound, and owns task state.
  `GET /control/playtesting/analyses` returns workspace-filtered status and keeps
  every active task visible ahead of terminal history.
- Runtime launches the existing `run-provider-agent` role path, not a provider
  call or second scheduler. The child runs the current read-only
  `playtest-analyst` role in a private empty directory and isolated Codex home.
  It receives the trusted workspace/actor/task/run identity, workspace-bound
  Playtesting MCP data access, and local-router credential, but no Control API
  URL/token or run-control client. It reviews exactly the selected episode IDs
  using their frozen packets. Shell/web/delegation and all other MCPs are disabled;
  it cannot read the game checkout, run gameplay, or publish issues. The game
  adapter receives none of these credentials.
- The Console starts review only after an explicit operator action, polls the
  same owner with backoff, shows last-known tasks as stale on failures or a lost
  Runtime process, links each persisted review to its session inspector, and
  renders every ineligible/over-budget receipt. Dispatch accepts up to the
  first-milestone 40-session critique ceiling; full-packet preparation remains
  separately bounded at 16. A confirmed batch start now
  re-arms the adjacent live-run reader immediately rather than waiting for a
  manual refresh. Invalid shareable selections over 40 are explicitly rejected
  with zero selected and no truncation.
- Runtime process/role/auth/owner tests exercise the trusted dispatch and
  status lifecycle. The full labeled-synthetic browser usability spec
  (`console/e2e/playtesting-usability.spec.ts`) passes **12/12**, covering
  run-start→live status→cancellation, stale reads, analyst start→running→stored
  review link, mobile layout, and out-of-cap selection refusal. The added
  same-browser journey starts an approved synthetic run, confirms its completed
  persisted episode, selects it, dispatches analyst work, and opens the resulting
  stored-review detail.

**Analyst credential boundary (2026-10-14):** The analyst's allowlisted
`prepareReview`, `submitReview`, `metrics`, and `compare` tools use the
workspace-bound Playtesting repository/artifact store directly; none calls the
Control API run owner. Cross-session packet preparation remains restricted to
root/orchestrator/validator/operator roles; the analyst has no runner credential
and cannot use that run-control operation. The MCP therefore starts without a
run-control client for `playtest-analyst`, and the analyst receives no Control
API URL, token, actor, or role credentials. The Runtime-bound packet IDs are
passed through the provider-agent environment allowlist into the stdio MCP
session. Startup requires a nonempty list of at most 40 distinct, syntactically
valid IDs; `prepareReview` and `submitReview` refuse any episode outside that
exact list, so a prompt or tool call cannot widen the Console-selected scope.
Runtime removed the obsolete
`AUTODEV_PLAYTEST_ANALYST_CONTROL_API_TOKEN` authentication path for
`/control/playtesting/analyses`; Console dispatch remains operator-authorized by
the normal server-side Control API credential, while packet preparation and
review submission keep the analyst role check in the Playtesting MCP. Regression
tests prove the analyst's single-session packet/review path works with no run
owner and an analyst session is refused by the cross-session run-control tool.
**Verification refresh (2026-10-14):** Root **1,549 passed / 5 skipped**;
Core **331 passed**; Data **374 passed / 9 skipped**; Console **611 passed**;
Runtime **934 passed / 5 skipped**; all workspace/root typechecks passed. The
production Console build and labeled-synthetic Playtesting browser spec passed
**12/12** with alternate fixture ports, including one complete synthetic Console
run-to-review journey.
The directly changed dispatch/auth/UI files pass targeted ESLint and
Prettier checks. The repository-wide `pnpm lint:ci` still reports 219 findings
in other concurrently modified files; no lint rules or performance thresholds
were relaxed. `autodev playtest check --checkout-root
/Users/henrykirk/Desktop/RacingGame` passes, with only the expected warning that
optional invariants/snapshot/replay/fork/captureFrame capabilities are not bound. This
is a read-only check; no RacingGame conformance episode or real model call was
run. The earlier one-off saturated-filter timing failure did not recur in the
standalone Console suite or five consecutive URL-performance test runs; its
threshold was not changed.

**Verification refresh (2026-10-15):** The separate RacingGame-owned
`pnpm --dir /Users/henrykirk/Desktop/RacingGame run
playtest:game-manifests:check` first found a stale generated game bundle. The
canonical `playtest:game-adapter` generator then refreshed only
`.autodev/adapter/racinggame-playtest-game.mjs`; the manifest check passed and
reported evaluator/engine provenance verified. AutoDev's read-only
`pnpm run autodev -- playtest check --checkout-root
/Users/henrykirk/Desktop/RacingGame` also passed, with only the expected warning
that optional invariants/snapshot/replay/fork/captureFrame capabilities are
unbound. The target checkout still has in-progress edits, so this generated
artifact reflects a dirty tree and is not a clean, approved build identity.
No game module, conformance episode, playtest, approval, or provider/model call
was executed.

The nine focused Console Playtesting Node test files passed **61/61**, including the dispatch-receipt visibility regression. `pnpm exec tsc --noEmit` in `console/` also passed. A first
rendered-Console E2E attempt timed out at the configured 120-second production
build wait; a subsequent same-configuration run completed **13/13**. The run
included 12 Playtesting cases and one Providers case. Playwright exercised the
labeled synthetic Control API fixture, including the same-Console
start→watch→completed-result→explicit-analysis→persisted-review-link journey;
this is rendered UI evidence only, not RacingGame evidence. The timeout was not
raised. The delegated browser-tester lacked a Playwright MCP server, while the
independent source validator confirmed Console route wiring but could not finish
its Runtime-owner and analyst-citation audit after the Router error. No fresh
real-game or model evidence exists.

### Playtesting first-read schema initialization latency (source path updated; rollout open)

- [x] Runtime starts Data-owned `PlaytestRepository.ensureSchema()` as a
  best-effort startup warmup and tracks `idle/initializing/ready/unavailable`
  without exposing backend errors. Pending resource reads now return an explicit
  `503 autodev_control_playtesting_source_initializing` with `Retry-After: 1`
  instead of holding the Console request open for the DDL duration. The separate,
  workspace-scoped `GET /control/playtesting/readiness` is nonblocking and
  GET-only; only an operator can explicitly retry through
  `POST /control/playtesting/initialize`; a failed state remains typed and
  viewer/resource GETs do not silently reissue DDL. Unrelated Control API routes
  remain available.
- [x] Console preflights overview/list queries; a direct session detail uses its
  single episode read and maps a fast `initializing`/`unavailable` response to
  the same readiness panel, avoiding a redundant status round trip. An
  initializing page polls the same-origin readiness
  proxy with bounded backoff; ready triggers a server refresh, while an
  unavailable response stops and offers an operator retry. The 5-second Control
  API request deadline is unchanged. Console Playtesting server/route/selection
  tests pass **22/22**, Control API compatibility tests **2/2**, Runtime
  schema-warmup tests **3/3**, the Runtime Playtesting Control API suite **21/21**,
  and the focused MCP equivalence refusal test **1/1**. Core, Runtime, and Console
  typechecks and ESLint on changed source/tests pass.
- [~] The production Playwright readiness-flow specs for overview, direct
  session links, and operator retry are checked in against the labeled synthetic
  fixture. Two production webServer builds exceeded the existing 120-second
  deadline during Next compile, before the browser specs began; the threshold
  was not raised. Separately, a temporary source `next dev` server plus that
  labeled fixture passed headless Playwright probes for overview pending→ready,
  direct-session pending→ready, and operator retry unavailable→ready. This is
  source-UI plumbing evidence only, not RacingGame or production-build evidence.
  The temporary dev server and fixture were stopped. Managed Runtime/Console remain
  on contract v3; revision v4 requires a safe rollout before live first-page
  acceptance. No live Data tables were dropped or recreated.

**RacingGame stored-result audit (2026-10-15):** The live workspace-scoped Data
read contains one completed headless episode
`racinggame-episode-fa44132b238e67958fb1-championship-run` (2,190 steps) from
build `beb03c21ec2faa1e5bc2a5bd9cd232f1dd70f031`. Recorded facts are wager-hit
`3/4 = 0.75`, bankroll delta `51/3 = 17` gold/race, legal-action rejection
`0/2190`, and game outcome `unknown`. These are one episode's descriptive
metrics, not a population estimate or human/player-experience finding.

**Live Console evidence view (2026-10-15):** A read-only headless Playwright
browser opened the existing managed Console at port 3300 directly to the real
workspace-scoped episode. The response was HTTP 200 and rendered the episode ID,
`Deterministic metrics`, wager-hit `3 / 4`, bankroll delta `51 / 3`, legal-action
rejection `0 / 2190`, and the explicit message that no analyst review is
recorded. The trace displays `observationVisibility: unverified`. A separate
read-only overview probe saw the run form enabled for one assignment and showed
the approved `beb03c21...` build; it was not submitted. This is real persisted
RacingGame evidence in the current Console, not a synthetic fixture. It proves
deterministic result browsing and an available action for the old approved
build, not authorization for local `HEAD` `a1f3a953...`, a fresh run, UI
conformance, or analyst review.

The frozen assignment/episode cohort is `exploratory`; the original three
coverage cells used literal cohort `all`, so the immutable batch manifest
reports zero assigned and `not-assigned` despite metric rows. The game-owned
rubric now uses `exploratory`; AutoDev regenerated its benchmark hash links and
the focused binding test passed **6/6**. The previous batch manifest and old
rubric hash were not rewritten. A `playtest:game-manifests:check` first found
the ESM stale while RacingGame source edits were active. After the source was
committed and the target advanced to `a1f3a95360e879d8562ab223bd448f6e1dc4ed50`,
the canonical generator refreshed the ESM and the manifest check passed. Two
later UI/test edits leave the worktree dirty, but the adapter bundle remains
current because those paths are outside its input.

The batch's frozen one-session selection is eligible under critique budget 1,
but its persisted review-packet receipt is `unavailable` with
`packet-validation-failed`. A bounded read of the exact trace shows all 2,190
steps carry `observationVisibility: "unverified"`, consistent with the game's
`uiEquivalence: "unverified"` contract. Core deliberately accepts only
`structured`/`visual-only` steps in player-visible analyst packets, and the
analyst prompt rejects unverified traces; do not widen that boundary or dispatch
a model. No review was submitted. Runtime now classifies unverified observation/UI
equivalence as the typed `observation-equivalence-unverified` packet failure;
the Console renders dispatch receipts even when no analyst process starts. The
focused selection/results suite passes **7/7**. The old immutable batch retains
its original generic `packet-validation-failed` receipt and was not rewritten.
After the receipt UI change, the filtered production Playwright spec
`pnpm exec playwright test --config=playwright.config.ts
e2e/playtesting-usability.spec.ts` passed **12/12**, still against the labeled
synthetic Control API fixture. The analyst refusal remains in place.

The actual Console on port 3300 rendered the episode once and later returned
`autodev_control_api_timeout`; a source-current dev server on port 3311 rendered
the overview and metrics, but a first session-detail request returned
`autodev_control_api_timeout` while its route compiled. Direct workspace-scoped
Control API reads succeeded after initialization. Existing Next listeners were
left untouched, and the temporary 3311 dev server was stopped. The synthetic
Playwright run remains **13/13** but is not RacingGame evidence. An attempted
Vitest filter used the wrong argument form and launched the full unit suite
while another full suite was active; unrelated timing/performance tests failed
under contention and our run was interrupted. The correctly filtered binding
test passed **6/6**; no thresholds were changed.

**Batch-level cross-session synthesis (2026-10-14):** Multi-session dispatch now asks the existing read-only analyst process for one separate synthesis after its independent per-session reviews when at least two frozen packets were available. Core owns the versioned `PlaytestCrossSessionSynthesis` artifact, separately records the complete Runtime packet-eligible selection and the subset actually cited, and rejects fewer than two contributors, non-hypothesis verdicts, citations outside a contributor's exact `(episodeId, packetId)`, non-session locators, and payloads over 64 KiB. Runtime binds the MCP process to a trusted `analysisId` and the exact packet IDs chosen by the run owner. The analyst MCP retains only packets actually returned by `playtest.prepareReview` in that process and accepts synthesis citations only when they resolve inside the exact delivered packet; it writes the immutable artifact through Data. The analyst has no Control API token or run-control permission. Data persists a dedicated `playtest_cross_session_syntheses` read model and returns workspace-scoped pages, and the analyses status response carries durable synthesis summaries in addition to in-memory task rows. The Console displays the synthesis separately, labels it hypotheses-only, and renders links for every packet citation and contributor; after Runtime restarts, the persisted synthesis remains renderable even when its task row is gone. Core/Data/Runtime/Console tests and a synthetic browser run→two-session dispatch→citation-render flow exercise this path. This does not claim independent verification, model/prompt provenance, empirical RacingGame evidence, or synthesis quality.

Verification after this vertical slice: Core cross-synthesis contract **7/7**;
Data Playtesting repository **27/27**; Runtime/Control API/provider analyst
focused suite **97/97**; Console production build and synthetic Playtesting
browser flow **12/12**; root/Core/Data/Runtime/Console typechecks pass. Changed
files pass targeted ESLint, Prettier, and `git diff --check`.

**Installed service probe (2026-10-14):** The current server-side Control API
read for `/control/contracts` returns `404 autodev_control_api_unknown_path`
(expected contract version 3), and a real RacingGame episode-page read returns
`autodev_control_playtesting_source_unavailable` although ClickHouse `/ping`
returns 200; a direct read identified ClickHouse error 60 (`UNKNOWN_TABLE`).
The live Playtest tables are not initialized. The current source initializes
those tables on the first workspace-scoped read, but the installed Runtime lacks
that code as well as the contract route. The Console's supported startup gate
therefore cannot use this installed Runtime as-is. A fresh read-only
`node runtime/src/cli/verify-control-api.ts` check also exits 1 on the same 404
(expected `autodev-control-api-contract-v1` version 3)
and refuses to start Console. No manual schema DDL, compatibility fallback,
installation, or service restart was attempted; the canonical Runtime
deployment/restart is a separate required step before using the real Console.
The canonical workspace id is `SimulatorLife/RacingGame` (from the current
`config/workspaces.json`), and its approval lookup returns absent. The running
Console on port 3300 returns `autodev_control_playtesting_source_unavailable`
for that workspace; the earlier `owner/RacingGame` probe was not the canonical
workspace identity. At that time, the target checkout was dirty and approval was absent; these
observations are superseded by the following current-state read.

**Live Control API and Playtesting read refresh (2026-10-15):**
`node runtime/src/cli/verify-control-api.ts` now passes. The authenticated
`SimulatorLife/RacingGame` capabilities read reports workspace enabled,
operator actions available, `approved: true` at revision 3 for build SHA
`beb03c21ec2faa1e5bc2a5bd9cd232f1dd70f031`, configuration validated, and a
bounded approval of one worker, up to 10 assignments, 2,500 steps per episode,
120,000 ms wall time, and one critique. Local `RacingGame` `HEAD` is
`a1f3a95360e879d8562ab223bd448f6e1dc4ed50`; the worktree has uncommitted
UI/effects/test edits. The Workspace approval is still for the different `beb03c21...`
build, so the current checkout is not authorized. No image digest is exposed by
the safe capabilities response. No run or analyst dispatch was made.

A read-only canonical-workspace batch-page request first returned `unreachable`
at the Console's unchanged 5,000 ms deadline. The next request, with a bounded
30,000 ms diagnostic deadline, returned two batches; a subsequent request using
the normal 5,000 ms deadline returned in 105 ms. Runtime's default Playtesting
read path lazily awaits Data-owned schema creation/migrations on its first GET
(`runtime/src/control-api/playtesting.ts` →
`data/src/playtesting/playtest-repository.ts` →
`data/src/playtesting/schema.ts`). The sequence is consistent with cold schema
initialization exceeding the user-facing deadline; the exact DDL statement was
not isolated. This exposes a first-visit Console failure that remains to fix at
the Runtime/Data initialization boundary, without widening the Console timeout
or adding request retries.

Task status is held in Runtime process memory rather than a durable task ledger.
If Runtime restarts, a browser that knew the active task keeps it marked stale;
already-persisted per-session reviews and batch syntheses remain available from
Data. The browser fixture is
synthetic and never substitutes for a target-game result. Approval matching
the current RacingGame build/image and an operator-authorized bounded run are
still required.
No RacingGame episode, real provider/model call, or human study was performed
for these implementation tests.

**Later live UI and compatibility recheck (2026-10-15):** The source now
requires Control API contract v4. A fresh read-only
`node runtime/src/cli/verify-control-api.ts` against the active listener on
4101 exits with a stale-contract startup refusal; the listener belongs to the
shared `/Users/henrykirk/.codex/src/router/server.ts`, so it was not restarted.
A headless Playwright read against the already-running Console at 3300 opened the
real RacingGame session detail and asserted HTTP 200, episode identity, the
`3 / 4`, `51 / 3`, and `0 / 2190` deterministic metrics, and the explicit
“No analyst review” state; the trace also renders `observationVisibility:
"unverified"`. A separate read-only overview probe found the one-assignment
Run button enabled for approved build `beb03c21...`; it was not clicked. These
prove the old managed Console can browse persisted metrics and exposes its old
approved build, not that the current `a1f3a953...` checkout is authorized, that
a fresh episode can start, or that v4 readiness/browser behavior is deployed.

### Declarative game onboarding: one config, no adapter (delivered)

This slice records a target-state requirement added to
[`docs/playtesting-target-state.md`](../playtesting-target-state.md) §
"Declarative game onboarding". Both tiers are delivered; the items below carry
their own checkboxes, and only the ones marked `[x]` may be read as delivered.

Current state, from RacingGame's first integration:

- Onboarding required five hand-written scripts and four manifests, roughly
  1,000 lines of adapter, evaluator, schema and hash-binding code plus ~360
  lines of JSON, for a game that already had a clean deterministic `src/game`
  core and a seeded headless driver.
- The adapter implements the game-adapter protocol v1 itself: transport,
  capability negotiation, revision tracking, event emission, and per-phase
  decision enumeration. All of that is AutoDev-shaped, not game-shaped.
- The game hand-maintains `evaluatorHash`, `schemaHash`, `actionSchemaHash`,
  `eventSchemaHash` and `contentHash` through a custom generator script, so any
  evaluator or schema edit silently invalidates a run until regenerated.
- `playtest.config.json` was a hardcoded `CONFIG_FILENAME` resolved against the
  checkout root (`runtime/src/playtesting/approved-configuration.ts`), so the
  integration files could not share one conventional directory. **Resolved** in
  commit `7509b1c0`: the canonical location is
  `.autodev/playtest.config.json` and referenced manifests resolve relative to
  the config file, with an independent boundary refusing any manifest that
  escapes that directory.
- Approval ran `git status --porcelain=v1 --untracked-files=all
--ignored=matching` and rejected any output, so a game under active
  development could never run its committed build. **Superseded** (2026-10-15):
  the Runtime now runs a read-only snapshot of the checkout's latest commit, so
  working-tree state is irrelevant; a commit that does not track `.autodev/` is
  refused because its snapshot has no target configuration.

Required work:

- [x] Generic adapter runtime binding to a game from declarations
      (`core/src/playtesting/adapter-binding.ts`,
      `runtime/src/playtesting/generic-adapter.ts`): entry module and factory,
      a reference per protocol method, and a named reset `rngVersion` (with
      snapshot/replay/fork reserved for actual counterfactual state
      restoration). The capability advertisement's schema digests are computed
      from the game's own declared schemas rather than written into a file,
      which is what a hand-written adapter drifts on. An unbound method is
      refused by name instead of answered from a default.
- [x] The remaining host wiring: `createGenericAdapter` is served over the
      `stdio-jsonl` transport the config declares, and a complete **synthetic
      game** episode runs through it. `runtime/src/playtesting/generic-adapter-main.ts`
      is AutoDev's adapter entrypoint — it reads the binding from the approved
      integration directory, imports the game's entry module by URL, and serves
      the protocol on stdio. `runtime/tests/playtesting-generic-adapter-episode.test.ts`
      writes a test game to disk, invokes that entrypoint as a process, and
      drives `reset`/`observe`/`legalActions`/`step`/`captureEvents`/`outcome`
      through the production `PlaytestAdapterClient`. Docker is the only
      substitution; the protocol, the client state machine and binding are real.
      This is generic protocol evidence, not a RacingGame run.
      Driving it — rather than reading it — exposed three defects, each fixed at
      the source:
  - The entrypoint exported `main()` with no direct-execution block, so the
    adapter image's entrypoint would have imported the module and exited
    before opening stdout. The Runtime would have seen a timeout rather
    than an adapter failure.
  - `--integration-dir .autodev` resolved against the process working
    directory, which the sandbox sets to the _game's_ approved directory.
    A game with a subdirectory working directory could not find the binding
    in its own checkout. It now resolves against the read-only mount.
  - `capabilities` was in `PLAYTESTS_REQUIRED_BINDINGS` while AutoDev derives
    the advertisement and never dispatches it. Requiring it asked a game to
    write a function nothing calls, and rejecting a binding for its absence
    meant a correctly-scoped game could not onboard. Core now names
    `PLAYTESTS_ADAPTER_OWNED_METHODS` and excludes those from the unbound
    gap report, so a game is never sent to write a method AutoDev serves.
  - The sandbox previously omitted the approved `gameBuild` from the generic
    adapter environment, so its capabilities advertised `"unpinned"` and
    failed the Runtime's exact-build gate. `PreparedPlaytestSandbox` now carries
    the operator-approved build identity into the container.
  - A generic game could bind `captureEvents`, but the episode runner never
    called it; unlike a hand-written adapter, the generic host has no
    game-owned notification channel. Runtime now requests the exact zero-based
    decision-step range when the method is advertised, deduplicates returned
    events against `game.event` notifications, and preserves omissions as
    named missing evidence. Regression tests cover both the generic stdio
    binding and the runner's retrieval/omission behavior.
  - Independent lifecycle review caught that a factory-created engine could
    leak if its required binding failed before `createGenericAdapter` returned.
    The owner now awaits the game's `close()` hook on normal host shutdown and
    validation/capability-construction failure; a regression proves cleanup
    happens exactly once on the refusal path.
- [x] Tiered onboarding with an explicitly stated tier, not an assumed one:
      `PLAYTESTS_INTEGRATION_DIR` and `PLAYTESTS_ADAPTER_CONTAINER_WORKSPACE`
      are single-owner Core constants. Both tiers require AutoDev's generic
      adapter command; `declarative` means the game supplied its own entry
      module, while `generated-scaffold` means AutoDev generated throwing method
      bodies that the game must implement. A binding that omits a required
      method is rejected with every gap named at once; an optional method the
      game leaves unbound is named rather than assumed; and `check` rejects a
      game with no binding instead of retaining a handwritten protocol path.
      `init --scaffold` writes the generated module/binding but does not make it
      runnable: conformance reaches the throwing body and fails until the game
      implements it. The conformance test is `autodev playtest conformance`
      (`a2c7127d`), which exercises the declared entry through the production
      host and client.
- [x] A standard `.autodev/` home, with manifests resolved relative to the
      config file rather than the checkout root, plus an independent Runtime
      boundary refusing any manifest that escapes the config's own directory
      (commit `7509b1c0`).
- [x] `autodev playtest init` to lay out the standard tree and
      `autodev playtest check` to verify it end to end before approval. `check`
      reads and reports; `init` writes, so a checker that silently repaired a
      digest could not be mistaken for an integration that was already correct.
- [x] Hash chain: the observation contract's `schemaHash` is the Runtime-derived
      canonical digest of `binding.schemas.observation`, the same schema the
      generic adapter advertises. `check --write-hashes` regenerates that link;
      the approved checkout SHA pins the contract's remaining metadata.
      Generation, verification and approval all run in the Runtime, so the
      chain still has one owner; it cannot live in Core, which the Console
      compiles into a browser bundle and which
      `tests/cli/platform-import-boundary.test.ts` holds free of Node built-ins.
      The chain is now closed end to end: the rubric's raw-byte digest,
      observation/action/event schema digests, benchmark
      `rubricHash`/`metricRegistryHash` links and `contentHash` are derived by
      `check`/`--write-hashes` and verified, rather than read and trusted. A benchmark carrying stale digests is reported
      with all three fields named and the command that regenerates them.
      (An earlier defect had `derivedDigests` resolve the integration directory
      for one call site and the checkout root for another, so the benchmark
      checks silently never ran.)
- [x] Gitignoring `.autodev/` fails with a message naming that directory
      (commit `476e6aa6`).
      **Conformance execution bound (2026-10-14):** The declaration check now places
      one 15-second deadline across asynchronous game entry/factory loading and the
      protocol exercise, passing the remaining time to each client request. A failed
      `observe` stops before legal-action/step calls. Tests cover a never-resolving
      factory and reset, and an invalid observation proving that no action executes.
      Synchronous CPU-bound code still cannot be preempted while conformance executes
      the declared game module in-process; process-level isolation remains a separate
      security requirement for approved gameplay runs.

- [x] Measurement intent stays game-owned: scaffolding ships none. `init` writes
      an empty rubric and reports it as empty rather than filling it with
      plausible defaults, and a generated placeholder registry would be
      indistinguishable from one the game chose. Observation schemas are
      placeholders the game replaces, and the digests over all of them are
      derived rather than declared.

**Conformance deadline hardening (2026-10-14):** The 15-second deadline now spans asynchronous entry/factory loading and the protocol calls, and is passed as remaining time to each request. A failed `observe` stops before legal-action/step calls. Regression tests use never-resolving factories and `reset` methods; both fail at the conformance deadline instead of leaving the CLI waiting on the adapter. Because the conformance entry still runs in-process, a synchronous CPU-bound module cannot be preempted by this asynchronous deadline.

Acceptance requires a second, mechanically different game to join by adding one
config file and no code, with AutoDev infrastructure unchanged. That is
Delivery Slice 8's "only game adapter/scenarios/rubric change" restated as
"only the declarative config changes" — an adapter is a protocol
implementation, and treating that as an acceptable per-game cost is what this
slice removes.

**Met (`e0cca05a`).** `runtime/tests/playtesting-generic-adapter-episode.test.ts`
onboards a second game that differs from the first in every dimension the runtime
could have special-cased: CommonJS rather than ESM, code in its own source tree
rather than beside the binding, a nested namespace reached by dotted binding
paths, a different state machine, and a named RNG version. AutoDev's
infrastructure is unchanged. Meeting it required two fixes the first game's
fixture never reached — the entry module could only be declared beside the
binding file, and seeded runs needed a named RNG version independent of
optional in-episode state restoration.

### Selected-session deterministic metric aggregation (2026-10-14)

The earlier aggregate-grounded-analysis gap is partially closed for a Runtime-dispatched, bounded set of frozen analyst packets. This is deliberately separate from the remaining indexed cohort/population aggregates and the matched-seed comparison pipeline in measurement §§1 and 4.

- [x] Core now groups packet metrics only when build, game build, rubric/evaluator hash, measurement version, scenario/family, policy/version, cohort, modality, metric/version/phase, aggregation window, analysis unit, and unit all match. For registry-declared `ratio-of-sums-within-scenario`, it sums numerator, denominator, opportunity and missing counts and derives the pooled ratio/coverage; it never averages episode estimates. It records exact source packet references, sorted omitted-metric reasons, and a bounded unavailable state rather than dropping an oversized result.
- [x] Metric intent is frozen in evidence-packet schema v3. Packet v1/v2 remains readable for historical review, but Core refuses to pool it without the exact aggregation and analysis-unit semantics. Episode is the only independent unit counted from these packet summaries; learner/participant/cluster/decision/cohort counts remain null because cross-session identity deduplication is unavailable.
- [x] The existing Runtime run owner computes this descriptive aggregate from the final packet set before launching the analyst. It passes the trusted result to the isolated process and copies that Runtime-supplied value into synthesis schema v2; the model cannot supply or edit aggregate numbers. Data one-way migrates synthesis v1 with explicit `not-recorded` aggregation, without reconstructing history.
- [x] Console displays the deterministic rows, source-session links, missing/coverage counts and unavailable reasons separately from cited analyst hypotheses. It labels this as selected-session descriptive arithmetic, not a matched-seed effect, confidence interval, or population estimate.
- [x] Focused Core tests cover ratio-of-sums versus mean-of-ratios, exact cohort strata, non-episode independent units, legacy packets and selection/provenance validation. Runtime tests cover trusted aggregate handoff/persistence, analyst environment binding and synthesis submission; Data tests cover schema migration; Console tests cover numeric rendering and source links. Synthetic fixtures only; no RacingGame episode/provider call was run.
- [ ] Still open: Data-indexed aggregation over complete assignment inventories and the matched-seed/cohort comparison builder. This slice only summarizes the exact selected review packets and cannot establish population denominators, comparison intervals, or promotion status.
- [x] Real RacingGame start/watch from the Console (source build, side port): see "Latest-commit execution" below. Optional invariant/snapshot/replay/fork/frame methods remain unbound, and analyst review remains withheld until RacingGame verifies UI equivalence.

### Latest-commit execution and Console run watching (2026-10-15)

The operator asked that AutoDev run the latest commit without a per-commit
approval. A Workspaces approval now authorizes a **checkout**, not a commit.

- [x] Core approval schema v2 drops `buildSha`, `gameBuild` and `playtestConfigHash`.
      Data migrates a stored v1 record one way on read and rewrites it. The
      Control API approval body refuses a pinned commit with 400.
- [x] At every batch start, Runtime `preparePlaytestSandbox` resolves the checkout's
      `HEAD` commit and checks exactly that commit out through a temporary Git index
      into a Runtime-owned snapshot (`$CODEX_HOME/playtesting/snapshots/<workspace>/<sha>`).
      It loads that commit's own config and manifests, and mounts only the
      snapshot read-only. The resolved `WorkspacePlaytestBuild` (`buildSha`, `gameBuild` = SHA,
      `configHash`) flows into the frozen manifest, batch, episodes, environment hash
      and per-build episode budget. Uncommitted, untracked and ignored files
      never run, and the operator's index and working tree are untouched.
      Snapshots are reused per commit and pruned after two unused hours. The
      post-run "checkout changed" check is removed because the snapshot is
      immutable.
- [x] Capabilities report the latest committed build and the admissible seeds
      from that build's frozen benchmark. The Console run form offers only
      those seeds; it previously invented `seed-N` values that a benchmark-gated
      game always refused.
- [x] Persisted episode identity is Runtime-owned (`<batchId>.<assignmentId>`).
      RacingGame derives its episode handle from the seed, so a run on the new
      commit had shadowed the old build's episode under the same id. The two
      historical rows that share `racinggame-episode-fa44132b238e67958fb1-championship-run`
      (batches `1c238c12` and `970874e5`) were not rewritten.
- [x] The Console dashboard owns one live status reader. The Runtime lists only
      nonterminal batches, so a watched batch that leaves that list is resolved
      to its terminal status rather than dropped. The start card renders that
      shared record, and a terminal transition refreshes the server-rendered
      results. Before this fix the card stayed "Running" and the overview stayed
      stale.
- [x] Live evidence used a source Control API on 127.0.0.1:4191 and a source
      Console on :3391 against real Data, Docker and the real RacingGame
      checkout; the managed Router (4101) and Console (3300) were untouched.
      Through the UI, the operator revoked approval revision 3 (pinned to a
      detached `/private/tmp` worktree at `beb03c21`) and approved revision 5 for
      `/Users/henrykirk/Desktop/RacingGame`. Without re-approval, capabilities
      resolved the dirty checkout's `HEAD` `a1f3a95360e879d8562ab223bd448f6e1dc4ed50` and
      validated it. A one-assignment batch, `batch-fedc555b-6af8-44c8-886f-6b85c818a6d6`
      (seed `confirmation`), started from the run form. The start card and live
      panel reached Completed without a manual refresh (about 36 s), and the
      overview refreshed to the new episode `batch-fedc555b-….a-0001`: 2,202 steps,
      game outcome win, wager hit `3/5`, bankroll delta `338/3` gold per race,
      legal-action rejection `0/2202`, with an integrity-verified trace window.
      An earlier batch on the same commit (`batch-970874e5`, seed `discovery`)
      completed before the identity fix.
- [x] Analyst review via the Console returns a typed receipt and no model
      dispatch: "observation/UI equivalence is unverified". This is correct.
- [x] RacingGame's **dirty source worktree** now has a game-owned conformance
      fixture. Its target observation contract is `uiEquivalence: "verified"`
      and its `conformanceFixtureHash` is generated from
      `.autodev/playtest.conformance.json`. The new Playwright fixture compares
      all observation fields against player-visible DOM/accessibility across
      seven checkpoints: betting, selected bet, formation, settled cash-out,
      card reward, and the following race's betting board. It passes 1/1. Unit binding tests pass 7/7.
- [ ] The active Workspaces approval still resolves committed `HEAD`
      `a1f3a953...`, whose snapshot remains `uiEquivalence: "unverified"`.
      Changes in the dirty worktree are intentionally not executed. Once those
      game changes are committed, revision 5's checkout approval automatically
      resolves that new commit without re-approval; then verify a fresh real
      episode/analyst eligibility. Managed Control API v4 rollout still needs a
      safe window.
- Cost: the first capability read after a new commit materializes the
  snapshot (RacingGame: about 2.3 s for 423 MB, measured 2.9 s end to end);
  later reads reuse it.

### Final source-path verification (2026-10-15)

- The start acknowledgement now carries the Runtime's exact `createdAt`; the dashboard seeds that acknowledgement into the shared active-run reader before its first poll. This closes the fast-batch race where the active list could omit a run that completed before the first poll. A regression test covers start-ack → first-list-already-terminal.
- The synthetic browser fixture now models fast completion on an active-run read while preserving explicit `hold`/`hold-*` runs for cancellation/live-panel tests. Cancellation browser coverage asserts the 202 response and then the shared server-confirmed Cancelled state; the composer keeps running without manual refresh. The client-navigation test uses `performance.timeOrigin` to detect a full document replacement, not Playwright's same-document frame event.
- Source Playwright `e2e/playtesting-usability.spec.ts`: **15/15** passed against the labeled synthetic fixture through a source Next dev server. Isolated readiness cases against a previously built production bundle passed **3/3**. A fresh full `playwright.config.ts` run again stopped at its unchanged 120-second Next build deadline before tests; production E2E is still open.
- Full Console tests: **624/624**; full Runtime Playtesting tests: **271 total, 269 passed, 2 skipped, 0 failed**; Core tests touched by approval change **73/73**; Data approval tests **4/4**; repository-wide typecheck, changed-source ESLint and `git diff --check` pass.
- Final real-game UI run through source Console :3391/source Control API :4191 used current approved HEAD `a1f3a95360e879d8562ab223bd448f6e1dc4ed50` and seed `regression`; the timestamped `202` ack was followed automatically by Completed. Batch `batch-b8781463-8fbb-487a-b9c1-9b4d7f08a5e6`: 2,062 steps, LOSS, wager-hit `1/4`, bankroll delta `-23/3` gold/race, legal-action rejection `0/2062`. Its session page rendered an integrity-verified trace and deterministic metrics; `observationVisibility` remains `unverified`. The selected-session analysis action returned the typed `observation-equivalence-unverified` receipt, started no analyst process and made no provider/model call.
- Managed Runtime :4101 remains source-incompatible v3; managed Console :3300 was not changed. Source side services :3391/:4191 were retained loopback-only for continued UI inspection.


### RacingGame UI-observation conformance (committed source, 2026-10-15)

The prior probe found the first concrete equivalence defect: the adapter seeded
race one with the **race-three/four-team field**, while the actual UI and
`create_canonical_run(seed)` start race one with the four-car, two-team roster.
Thus offered tickets and running order could disagree before the first
decision. The adapter now starts with the canonical race-one roster, and lets
`initialize_next_race` advance the field at its real lifecycle boundary. A unit
regression compares the adapter's initial observation against `create_canonical_run`
for the exact normalized seed.

The observation also included two fields not exposed to the player: the raw
Runtime decision `step` and the internal `race_cycle_phase`. Those no longer
go to the policy; Runtime owns decision-step provenance separately, while the
UI conformance fixture checks only public phase and available controls. After a
ticket is committed, the adapter now preserves the bettor's own committed
ticket IDs in `selected_ticket_ids` instead of reporting the reset selection
controller's empty state.

`.autodev/playtest.conformance.json` is game-owned and hash-bound by
`build-playtest-manifests.mjs`. `tests/e2e/playtest-observation-conformance.spec.ts`
runs the actual browser against the same deterministic seed and checks the complete
structured-field allowlist against visible DOM/accessibility at betting,
selected-bet, formation, post-formation, cash-out, reward, and next-race betting
checkpoints. To test a real nonempty reward rather than a sample, the fixture
drives the adapter through a deterministic race and sends the equivalent
canonical game transitions to the AppShell renderer. The exact observation
field allowlist is compared to the fixture's field list. Current evidence:
the fixture Playwright test **1/1**, RacingGame unit binding **7/7**, and
`typecheck` pass; `playtest:game-manifests` and `autodev playtest check`
validate the generated bundle/hash chain.

**Current checkout and live evidence (2026-10-16):** RacingGame advanced to
HEAD b5450114f with the scalar pit-state observation contract. The checked-in
.autodev/playtest.observation.json declares uiEquivalence: verified, binds
conformance fixture hash
461abeae9b0d719ad99d36c5750643ee1f01a86a612a723da97c95df646f6fe5, and uses
schema hash 59ba278f7ae04f37fdd4af6acece78c60b16676de578245c44d3645119631855.
The source Console resolved each latest committed build automatically under
Workspaces approval revision 5; no per-commit approval was requested. The
unrelated visual/effects edits in RacingGame's worktree remain untouched and
excluded from Runtime snapshots.

The earlier discovery and confirmation runs on 80a315ae stopped at 11 and
15 decisions because the adapter observed only main-circuit positions. A later
Console run on bccc668e (batch
batch-4b2dd672-c920-448d-a9c6-926295532cd1, seed discovery) progressed to
1,200 executed decisions, then the loop guard stopped its unexecuted decision at
step 1200; status was budget-truncated and no game outcome or deterministic
metrics were recorded. Its trace at steps 1198–1200 repeats observation hash
5b0b499908d0cc4c with advance-segment as the sole legal action. Replaying the
same seed/action stream against game state showed why: circuit positions were
fixed while active cars continued moving through the pit lane and service
trajectory, which the adapter did not include. The guard was correct for the
incomplete observation; the game itself had not stopped progressing.

The committed b5450114f contract adds pit-lane phase, route progress, service
remaining time, and tire-service duration as aligned scalar arrays beside
circuit progress. The scalar shape is intentional: Runtime's privacy projector
admits allowlisted scalar arrays and nested paths, not an opaque object array.
The player UI's semantic car nodes publish the same renderer/service inputs, and
the browser conformance fixture compares the structured observation to those
values. A deterministic adapter regression replays discovery through steps
1198–1199: main-track progress stays identical while pit-lane state changes.
The earlier intermediate object-array attempt on 7605d030 failed closed after
four decisions with infrastructure-failed; Runtime rejected the unsupported
object-valued allowlist field, and no game outcome was inferred.

Through the reworked Console on b5450114, batch
batch-c0951227-429f-4f8b-b6d5-5cc5ea21764c completed one discovery assignment
in 1,985 decisions (28,294 ms simulation, 94 ms policy inference). The inspector
reported LOSS, complete evidence, and deterministic metrics: wager-hit-rate
1/5 (0.2), bankroll delta -5/3 gold per race, and legal-action rejection
0/1985. This is an observed game loss, not an execution failure.

The first UI Analyze this session request was eligible but returned
packet-unavailable: packet-budget-exceeded; no analyst process or provider/model
call occurred. Core had marked all 1,985 generic decision_applied events
mandatory, so their contextual windows exceeded the 32,768-unit token budget
and 64-KiB packet-byte cap. Core now treats that generic event as ordinary
sampleable context (the action/revision is already in each trace step), anchors
specific game events at their exact step, retains terminal evidence with local
context, and records every omitted range. Regressions cover 1,200 generic
decisions and a 1,985-step event mix matching RacingGame. The remaining gate is
to run the current Runtime build and use the UI to persist an eligible review
for the completed b5450114f session; no analyst conclusion is claimed until
that succeeds. The earlier truncated runs remain ineligible and unanalysed.

### Playtesting Console UX redesign (2026-10-15)

The current rendered RacingGame page was inspected at 1440×1000 and the session inspector at 1440×920. The run form sat below historical counts, coverage, and an episode table; a finished batch read as "No batches are running"; the same just-started batch had two status cards; tab navigation unmounted the watcher; and the inspector showed raw step JSON by default. A read-only independent UX/ownership review confirmed these paths and additionally found duplicated analysis selection, generic empty states, and form-submit-only workspace switching.

The Console owns presentation and operator flow, not gameplay, execution truth, result interpretation, or analysis claims. The rewrite keeps one typed Runtime status path and existing Data evidence, and must preserve their distinctions.

Target flow:

1. Make **Run** the default task view: a compact workspace picker and approved-checkout/latest-commit context, one clear primary action, a recommended single assignment, and optional batch tuning in a disclosure. Explain that checkout approval is reused and Runtime snapshots the latest committed HEAD at run start; no per-commit reapproval is implied. Clearly say uncommitted edits do not run.
2. Show one server-authoritative run status surface, not local acknowledgement plus server status. It reports only observed assignment counts and honestly labels stale data. Keep run controls/watch affordances available across Run/Sessions/Findings/Compare list routes. The full-page session inspector stays focused on outcome/evidence and links directly back to Sessions rather than mounting a second optional run-control client island. Completed work remains discoverable as a latest result/recent session with a direct evidence link.
3. Put session outcome/status summary and deterministic metrics before a readable timeline. Keep exact trace JSON and unavailable media/evidence accessible but collapsed by default. Do not conflate execution disposition, game outcome, replay integrity, evaluator verdict, and analyst hypothesis.
4. Make selecting sessions part of the session rows rather than a duplicate ID list; retain the URL-bound, explicit ≤40 selection, eligibility report, and bounded analyst dispatch. Evidence citations continue to open the exact session/step.
5. Keep archive filters in archive views, clarify empty states, preserve all scope/pagination and accessibility behavior, and keep findings/compare evidence honesty.

Implementation ownership: route/page server loading and workspace scope stay in `console/app/playtesting`; the typed run owner remains Runtime; the view hierarchy is in the existing Playtesting feature components; the sessions page continues to own bounded analysis selection. No new execution/scheduler/backend state is introduced. A backend/API change is justified only by an observed missing fact needed by the user journey.

Acceptance evidence: actual RacingGame screenshots at 1440×1000 and 390px (document width stayed 390px), focused render tests for default/collapsed evidence and blocked/running/completed states, and production browser journeys for start → watch → inspect → row selection → bounded analyst review, plus the recorded loop-guard stop step. Console tests pass 634/634, repository-wide typecheck and changed-surface ESLint pass, and the production browser suite passes 17/17. The suite covers collapsed trace detail, default focus on the loop-guard stop, and the explicit step link; browser data remains synthetic.

The URL-address performance regression guard briefly exceeded its existing 2.5× per-iteration limit under the full parallel suite. The source path now canonicalizes and visits only filter keys actually present rather than rescanning the complete key registry on every navigation; the threshold was not changed. The focused perf test passed **10/10** repeated runs and in the final Console test suite. A cancellation browser failure also exposed two same-origin contract mismatches (the browser status proxy rejects `waitMs`, and the cancel form rejects a redundant `batchId`); the Console now sends only fields accepted by those routes. Cancellation is still confirmed against a fresh Runtime read.

A readiness browser trace showed that Next's `router.refresh()` returned the updated session RSC payload but retained the old initialization fallback. After the readiness endpoint explicitly returns `ready`, the readiness surface now reloads the same URL so the server-rendered evidence replaces that fallback; this happens only during initialization, when there is no editable run form or analysis selection to discard. The readiness checks now assert the final rendered result/session state rather than the intermediate RSC transport event. The full-page session route deliberately does not mount the optional run dashboard: doing so kept the fallback active on direct-session readiness; active-run watching remains on the four list views, and the inspector links back to Sessions.

The configured `browser-tester` role could not independently inspect rendered state in this session because its Playwright MCP tools were not exposed (`~/.codex/config.toml` marks that server disabled; no config changes were made). The root captured and inspected the actual UI with Playwright and the production E2E suite passed, but a separate role-based visual critique remains unavailable.

Checklist:
- [x] Capture actual RacingGame Console and session pages; map owning route/components and status APIs.
- [x] Independent read-only UX/architecture review completed; its findings reconciled above.
- [x] Replace the overview with a focused Run-first hierarchy; keep archive filters and detailed measurement coverage out of the primary action path.
- [x] Consolidate the run status surface, remove the duplicate start-ack card, and keep server-confirmed run watching available across Run/Sessions/Findings/Compare lists. Keep the session detail outcome-first with a direct return to Sessions.
- [x] Put URL-bound bounded analysis selection on the session rows; preserve the 40-session ceiling, eligibility receipts, and analyst/data ownership.
- [x] Make the inspector outcome-first, derive event/action/phase summaries from actual RacingGame trace fields, collapse raw JSON by default, and preserve exact-step citations.
- [x] Update target UX docs and render/browser tests, including checkout-scoped approval and automatic latest-commit selection copy.
- [x] Validate current source UI screenshots at desktop and 390px; Console tests (**634/634**), repository-wide typecheck, changed-surface ESLint and diff check; production browser suite (**17/17**) including bounded composer, start/watch/cancel, 1,000-assignment disclosure, session-row analysis, readiness, collapsed step details and loop-guard stop-step focus. Browser data was explicitly synthetic.
- [x] Review/integrate without reverting RacingGame's dirty visual/effects edits or test-generated project configuration artifacts.
- [x] Run through the reworked source Console on the latest approved checkout build `80a315ae20cebca9c8f6884d4fc26c3376865672` (the active checkout approval resolved the new commit automatically; no per-commit approval). The Playtester MCP child could not initialize because its trusted session context was missing, so no run used that route. The user-requested real Console path was used instead: one `discovery` assignment (`championship-run` / `random`, 2,500 steps, 120-second cap) was accepted as batch `batch-9ce99693-da93-49a6-bb5e-0f5b3e1d85e8`, then ended `truncated`; episode `…a-0001` has 11 steps, 169 ms simulation, 4 ms policy inference, no deterministic metrics, `outcome: unknown`, and an integrity-verified trace (`ee4cbd6b…`). A second bounded `confirmation` assignment (`batch-75be8f51-b1cc-4aef-aa48-6d246e2f024e`) also ended `truncated` after 15 steps (127 ms simulation, 2 ms policy inference, no terminal game outcome/metrics; trace `78c188f8…`). Runtime used the approved limits; neither run requested a critique.
- [x] Use the Console's `Analyze this session` path on the first real partial episode. Runtime returned `excluded-ineligible-session` (“The session's batch is truncated, not completed”), with no packet, analyst process, or model call. This is an honest refusal; no analysis was fabricated.
- [x] Diagnose the bccc668e trace at its owner: the repeated state was caused by pit-lane/service progress missing from the game-owned structured observation, not a Runtime or physics step-budget cap. Add pit route/service state, prove it against the player render state, and preserve the Runtime loop guard unchanged.
- [x] Persist precise Runtime termination provenance in episode schema v4 and make the inspector open the unexecuted loop-guard step with an explicit explanation; previous v3 records migrate with termination marked unknown rather than a fabricated cause.
- [x] Run the latest committed RacingGame build b5450114f through the Console and obtain a completed episode with a game outcome and deterministic metrics; the UI distinguishes this LOSS from a runner failure.
- [x] Diagnose the eligible-session analysis refusal: generic per-step decision_applied events were all mandatory in Core and exceeded the bounded packet ceiling. Core now samples those generic duplicates, keeps game-specific/terminal evidence mandatory, and records omissions; the 1,200-step regression proves packet selection is bounded.
- [ ] After the latest Core packet-selection change is deployed to the active Runtime process, analyze the completed b5450114f session through the UI and verify the persisted review, citations, and analyst result. No model call or analysis is claimed yet.
- [x] Independent read-only code validation completed against the current diff; actionable findings were addressed: session detail no longer mounts an unavailable run setup, cancellation remains available when capabilities are unknown (known role restrictions are explained), human-visible status labels accompany state assertions, the 1,000-row disclosure is asserted closed before expansion, and readiness reload preserves route state.
- [ ] A separate browser-tester role could not access its Playwright MCP tools in this session (the configured server is disabled). Root rendered/screenshotted the live page and ran the production browser suite; a role-based visual review remains unavailable unless the MCP is exposed.
