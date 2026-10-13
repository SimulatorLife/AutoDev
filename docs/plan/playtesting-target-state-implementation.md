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
- [~] Console run/watch and multi-session analysis: an operator can start an
      approved run and watch every nonterminal batch progress without manual
      refresh; the Runtime can dispatch analysis over an explicit selection of
      sessions. The Console selection surface and its Control API route remain —
      see the active slice below.
- [~] Declarative game onboarding: `init`/`check` and a Core-owned hash chain
      exist, but the generic adapter runtime and tiered onboarding are still
      required before a second game joins by adding one config file — see the
      active slice below.
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

At the packet-integration checkpoint, packet blobs and ClickHouse batch
receipts were separate durable resources with no cross-store recovery. The
pending-marker/reconciliation slice below subsequently closed the orphan
reclamation gap without claiming a distributed transaction.

Remaining work is substantial: source/adapter provenance and trust-boundary
verification, model/prompt identity propagation, deterministic cross-session
aggregation and an aggregate-grounded synthesis workflow, actual
analyst-inference and independent claim-validator integration, the
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
- [x] Multi-session dispatch: `playtest.prepareCrossSessionReview` takes an
      explicit selection of 1..16 distinct sessions and returns every one of
      them exactly once, as its own packet or as a named receipt. It excludes
      partial, cancelled, crashed, infrastructure-failed and truncated sessions;
      checks the per-batch critique cap across the whole selection rather than
      per session; and never charges an ineligible session against the budget it
      could not have used.

**Still required:**

**Delivered (2026-10-13, continued):**

- [x] A Console surface that selects several persisted sessions and requests
      analysis over them. Cross-session dispatch moved onto the run owner, so
      the MCP tool and `POST /control/playtesting/analyses` reach the same
      answer; the route authorizes and forwards and decides nothing. The
      Console holds the selection in bounded `sessions` URL state written
      through the History API, and refuses a response whose packets and
      receipts do not account for every selected session.
- [x] `PLAYTESTS_MAX_ANALYSIS_SESSIONS` lives in Core, so the limit the
      operator sees and the one Runtime enforces cannot drift.

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

Required work:

Remaining work on this list is recorded under "Still required" above; the
Runtime dispatch, the live read and the confirmation read are delivered.

The live view currently renders assignment outcomes and persisted episodes
separately. It does not yet surface `win/loss/DNF/other` per assignment or the
`nonterminal-batch-recovered` closure distinctly from a real result; the batch
result carries the data and the panel does not yet distinguish it.

Acceptance requires real-browser coverage of both paths against a labeled
synthetic Control API fixture — live progress advancing without manual refresh,
an explicit stale state when the status read fails, and a multi-session
selection that reserves capacity and rejects an out-of-cap request without
truncation. That remains Console mechanics evidence, not a game run.

### Declarative game onboarding: one config, no adapter (partially implemented)

This slice records a target-state requirement added to
[`docs/playtesting-target-state.md`](../playtesting-target-state.md) §
"Declarative game onboarding". It is **unimplemented**; nothing below may be
read as delivered.

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
- Approval runs `git status --porcelain=v1 --untracked-files=all
--ignored=matching` and rejects any output
  (`runtime/src/playtesting/docker-sandbox.ts`), so a gitignored integration
  directory failed with a message that did not name it. **Resolved** in commit
  `476e6aa6`: the refusal names the offending paths and calls out `.autodev/`
  explicitly.

Required work:

- [ ] Generic adapter runtime that binds to a game from declarations: entry
      module and factory, observation projection, legal-action space, step
      function, terminal predicate, seeded-RNG entry points.
- [ ] Tiered onboarding with an explicitly stated tier, not an assumed one:
      convention-bound games onboard with the config alone; other games get an
      AutoDev-generated scaffold from the same config plus a conformance test
      that resolves every declared binding and drives a real episode.
- [x] A standard `.autodev/` home, with manifests resolved relative to the
      config file rather than the checkout root, plus an independent Runtime
      boundary refusing any manifest that escapes the config's own directory
      (commit `7509b1c0`).
- [x] `autodev playtest init` to lay out the standard tree and
      `autodev playtest check` to verify it end to end before approval. `check`
      reads and reports; `init` writes, so a checker that silently repaired a
      digest could not be mistaken for an integration that was already correct.
- [~] Hash chain: the observation contract's `schemaHash` is computed by Core
      (`core/src/playtesting/hash-chain.ts`) and regenerated by
      `check --write-hashes`, encoding through the `canonicalPlaytestJson` the
      rest of the pipeline already hashes with. The rubric hash and the
      benchmark's `rubricHash`/`metricRegistryHash`/`observationSchemaHash` are
      still read rather than generated, so the chain is not yet fully closed.
- [x] Gitignoring `.autodev/` fails with a message naming that directory
      (commit `476e6aa6`).
- [ ] Measurement intent stays game-owned: scaffolding must not ship invented
      metric defaults, intended-experience claims or difficulty curves.

Acceptance requires a second, mechanically different game to join by adding one
config file and no code, with AutoDev infrastructure unchanged. That is
Delivery Slice 8's "only game adapter/scenarios/rubric change" restated as
"only the declarative config changes" — an adapter is a protocol
implementation, and treating that as an acceptable per-game cost is what this
slice removes.
