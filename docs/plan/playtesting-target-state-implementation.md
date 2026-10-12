# Playtesting target-state implementation plan

Canonical execution plan for `docs/playtesting-measurement-contract.md` and
`docs/playtesting-target-state.md`. The target-state documents remain the
normative specification; this checklist tracks implementation and evidence.

## Boundaries and decisions

- Core owns game-neutral schemas, measurement, comparison, triage, validity,
  and evidence rules; Runtime owns approved execution, bounded evidence and
  analysis invocation; Data owns indexed workspace-scoped records; Console owns
  server-filtered browsing and operator actions; the game adapter owns engine
  semantics and player-visible observation.
- Preserve the in-progress worktree changes. Do not revert, overwrite, or
  duplicate uncommitted changes from other processes; coordinate by file scope.
- Synthetic fixtures validate protocol/mechanics only and are never production
  evidence. Never run a game or substitute a fixture for an explicitly approved
  target-game run. Workspace enablement is not approval.
- Human study, issue publication, model-weight/license, upstream reuse, and
  target-game claims retain their explicit authorization/evidence gates.

## Delivery slices

- [ ] 1. Recorder/runner: versioned adapter, validated player-visible schema,
      approved isolation, provenance, bounded episode recording, security and
      protocol validation.
- [ ] 2. Analyst: source-verified timeline, bounded evidence selection,
      null-safe anchored scoring, citation validation, deterministic/critic
      separation, testable hypotheses, read-only role and skills.
- [ ] 3. Policy/comprehension: policy provenance/drift, bounded pre-action
      expectation probes, stratified surveillance/discovery sampling, explicit
      deterministic-only coverage and costs.
- [ ] 4. Experiment/findings: preregistered comparisons, finding identity,
      exposure/evidence triage, counterexamples, reproduction/fix lineage, gated
      issue publication.
- [ ] 5. Visual/human validation: actual authorized UI evidence only, distinct
      human instruments and consented study data, privacy controls and held-out
      baseline/uncertainty; unsupported modalities remain explicit.
- [ ] 6. Human/statistical validity: locked numerical methods, real-data
      integration gates, sensitivity/coverage checks, no unsupported funness or
      calibration claims.
- [ ] 7. Data/Console: indexed and cursor-paginated workspace queries, top-level
      resource and addressable session replay, stable URL state, accessible
      responsive views, explicit partial/error states and server-authoritative
      actions; test 10k indexed episodes and navigation/query/replay performance.
- [ ] 8. Portability and first milestone: second mechanically different
      adapter, 1,000 authoritative episodes, two independent policies, at most 40
      complete-session critiques, deterministic-only coverage, and demonstrated
      finding → candidate → comparison → next-cycle path.

## Cross-cutting acceptance ledger

- [ ] Healthy/no-finding, absent adapter, malformed/interrupted/partial run,
      known reproducible defect, unverified hypothesis, missing frames, model drift,
      matched/unmatched cohorts, hidden-state exposure, no ratings/disagreement,
      invalid links, unauthorized actions, and 10k-record query cases.
- [ ] Measurement denominators, missingness, uncertainty, cohorts, sampling,
      event/trace provenance, distinct execution/gameplay/interpretive status, and
      protected human data are tested end to end.
- [ ] Keyboard/mobile navigation, stable filter → finding → session → back,
      no fabricated video, source-mapped upstream UI logic actually executing,
      and performance on indexed queries, view changes, and replay selection.
- [ ] Documentation, test coverage, package checks and independent validation
      match the final integrated diff.

## Current evidence and gates

Initial inspection found substantial in-progress playtesting changes in the
worktree (including Core human preference/comprehension/triage/cadence/native
timing, Data human response indexing, Runtime statistics, Console display and
tests). These are preserved and must be reviewed as existing changes, not
assumed complete. CodeGraphContext returned no playtesting symbols; targeted
CocoIndex searches were used to locate the active paths. No real target game,
workspace approval, run authorization, or human-study authorization was
provided, so those empirical acceptance gates cannot be represented as passed.

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
- Several implemented Core helpers are not consumed by persisted workflows,
  including diagnostic ladders, native timing, cohort standardization, finding
  triage, cadence, and calibration scheduling.
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
selects every game-reported event-bearing step plus the terminal step, then
adds evenly spaced ordinary context under fixed window/step/byte/token bounds.
If mandatory evidence alone exceeds the budget, packet creation fails rather
than trimming event or terminal evidence. Every unselected source range is
recorded with a reason. The builder rejects unverified visibility, hidden trace
fields, evaluator-provenance drift, cross-assignment identity, duplicate events,
and missing frame hashes. Packet selection labels events as event-bearing,
not as semantically verified taxonomy facts.

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

The packet blob and ClickHouse batch receipt are still separate durable
resources. A batch-store outage after a packet artifact write can leave a
content-addressed orphan until artifact retention cleanup; production hardening
still needs a cross-store recovery/reclamation design before claiming atomicity.

Remaining work is substantial: source/adapter provenance and trust-boundary
verification, model/prompt identity propagation, cited cross-session context and
a full report-completeness gate, actual analyst-inference and independent
claim-validator integration, the experiment/finding-to-owner-decision cycle,
remaining helper integrations, human validation, UI/upstream reuse audits, a
second mechanically different adapter, and the explicitly authorized empirical
first-milestone gates. This slice does not complete Delivery Slices 1, 2, 4, 5,
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
  still reports five unrelated in-progress files outside this slice:
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
