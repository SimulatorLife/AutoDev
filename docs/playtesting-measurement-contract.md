# Playtesting measurement and improvement contract

This is the normative measurement companion to [Playtesting Target State](playtesting-target-state.md). The target state owns architecture and integration; this file owns metric semantics, sampling, comparisons, human labels and the repeatable improvement loop. Its worked values and acceptance fixtures are synthetic, not measured game or human results; partial implementation of a contract is not evidence that its acceptance gate has passed. Shared Console requirements remain in [Console Target State](autodev-console-target-state.md).

All numeric examples below are **synthetic fixtures**. Their thresholds test behavior; they are not validated defaults for a real game. A production benchmark must replace them with game-owned goals and a prospectively justified sample/precision plan before confirmatory claims.

## 1. Metric registry, events and coverage

### Distinct discovery and scored evidence pathways

**Unconfigured visual discovery** is a first-class mode, not an exception to a mandatory adapter manifest. Its admission requires a workspace-authorized visual target, sandbox/tool/media budgets, immutable episode/assignment/run identity (even if source revision is unknown), actual player-visible time-aligned observation/action receipts, bounded record provenance and optional natural-language goal. It does **not** require `playtest.rubric.json`, `coverageManifest`, game-owner evaluators, legal-action IDs, matching seeds or a known Git commit. It can always produce a **discovery evidence receipt**; an independent, read-only analyst can critique **observable interaction, recoverability and limited-model comprehension as hypotheses**, provided actual source windows and exact citations exist. Discovery critic verdicts may label `observed-symptom` / `hypothesis` / `not-observed` only; they **cannot issue 0–4 dimension ratings, verify engine bugs, estimate population prevalence, claim UI/headless equivalence, issue formal evaluation passes or declare human enjoyment** without independently qualifying evidence.

**Confirmatory/scored analysis** retains all current `registry-v2`, evaluator hash, frozen assignment/coverage manifest, eligibility, benchmark, replay and precision rules. A visual session may later enter scored analysis **only** if the game owner approves a source-specific rubric and corresponding evidence/evaluator capability; do not retroactively manufacture a seed, engine observation or coverage opportunity. A review packet carries a frozen `analysisKind=discovery|confirmatory` and eligibility/refusal reasons. An interrupted visual session may receive a **partial discovery receipt** and a bounded observation-only investigation, flagged with missing terminal outcome and never counted as a complete-session population critic sample. Formal selected complete-session review caps/selection algorithms below apply to confirmatory critic ratings, not first-person checkpoints or unscored discovery notes. Switching analysis kind requires a *new linked immutable packet/review*, never editing an earlier claim in place.

**Provenance and failure tests:** accept a no-config URL game with two actual screenshot/input transitions for hypothesis-only review; reject a claimed engine invariant and a numeric fun/quality score on that packet; preserve missing frames/focus failures, source/build unknowns, and model-only interpretations; reject a mismatched workspace/media handle. Accept a verified scored game with exact registry/manifest/evaluator and fail its altered hash. Verify no historical session with missing `coverageManifest` becomes a scored review by attaching a synthetic manifest after play. Keep provisional discovery activity separately filterable from statistically sampled confirmatory reports in the Console; do not pool them.



**For approved adapter-accelerated, metric-scored runs**, the game owns playtest.rubric.json (registry schema v2). **A first-play visual session does not need this file or a registered engine metric**; it records bounded observed evidence and hypotheses instead, with metric scores null until an authorized metric/rubric exists. The sufficient-statistics and evaluator-hash contract is measurement version v2; Core validates its schema; the exact approved game adapter executes game-owned deterministic evaluators and emits sufficient statistics; Runtime validates and normalizes them; Data computes indexed aggregates. Neither prompts nor React implement metric calculations. Version/hash the rubric, evaluator code, event taxonomy and observation/action schemas; a semantic change creates a new version and comparison-compatibility decision, never silently rewrites history.

A registry has schemaVersion, workspaceId, audience, registryVersion, eventSchemaHash, metricDefinitions, `coverageRequirements`, and dimensionRubrics. Each metric definition must expand to the following fields before a **confirmatory scored run** is approved:

| Field                                                   | Required meaning                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| metricId/version, mechanicKey                           | Stable quantity identity and semantic version, with game-owned mechanic                                                            |
| audience, scenarioEligibility, exposurePredicate        | Who and what can contribute; deterministic named predicate/version                                                                 |
| eventFields, evaluatorRef, evaluatorHash                | Exact source events/fields and SHA-256 of the target-owned deterministic evaluator; no arbitrary expression executed from a critic |
| numerator, denominator, unit                            | Calculation, eligible exposure count, display units; counts and units travel together                                              |
| analysisUnit, aggregationWindow, aggregation            | Independent episode/player/cluster, phase or session window, stratification and aggregation                                        |
| polarity, targetBand, meaningfulMargin, guardrailMargin | Higher/lower/target-band goal and preregistered practical thresholds; null if descriptive                                          |
| modality, notObservable, missingPolicy                  | Headless/native visual/human requirements, explicit null reasons and handling                                                      |
| minExposure, minIndependentUnits, precisionPlanRef      | Minimum evidence and justified inference plan; a count alone is not sufficient                                                     |
| severityRule, priorityClass                             | Target-defined consequence categories with witnesses, not an LLM priority number                                                   |
| provenance, humanConstruct                              | Source IDs/hashes and exact instrument/outcome, or null; no automatic proxy-to-human mapping                                       |

Every coverage requirement freezes one `coverageMetricId`/mechanic/phase/scenario-family/cohort/policy/modality cell, required opportunity and independent-unit counts, and either `unsupportedReason: null` or a bounded game-owned explanation. A supported requirement references a phase-window metric with a non-null phase or a whole-episode metric with `phaseId: null`, and must match its mechanic and modality. Runtime rejects a **scored/confirmatory** batch assignment if any eligible phase-window metric lacks a matching frozen cell; whole-episode metrics can still emit an episode-level result without being a critical coverage cell. An adapter cannot add an unplanned cell during evaluation. Cells declared unsupported stay visible in the batch manifest and do not ask the adapter to invent a value.

`game.outcome` returns typed sufficient statistics per metric, with a non-null `phaseId` for a phase-window metric and `phaseId: null` for a whole-episode metric (`metricId`, `phaseId`, semantic version, exact `evaluatorRef` and declared evaluator SHA-256, numerator, denominator, opportunity count, missing count/reasons, independent units, and unit). Runtime accepts only registered metric/phase pairs and exact ref/version/hash/unit matches; it derives the ratio and coverage without re-running or evaluating adapter code. The evaluator SHA is an adapter-reported provenance claim matched to the rubric, not remote attestation of which code path the process executed. The trust root is the exact approved clean checkout and adapter image (bound into the episode environment hash); source-level evaluator reuse/behavior must be verified against that pinned artifact before production claims. Every eligible non-human metric emits its required result row, including zero-opportunity `estimate=null` rows; phase-window metrics require rows for every matching supported plan cell. Missing rows, duplicate/unknown metric/phase pairs, unplanned phase outputs, or mismatched outputs fail the evidence attempt instead of becoming zero. A mode mismatch is `null` with `unsupported-modality`; a metric outside the current scenario eligibility is omitted as inapplicable. Human-post-play measures are imported through the consented study path, not returned as game episode metrics. Data indexes the resulting per-episode measurements; it does not treat one episode result as a population aggregate.

The versioned assignment manifest freezes each assignment's policy cohort as well as scenario, policy/version and seed; Runtime does not infer cohort identity from a returned episode after an assignment disappears. The batch `coverageManifest` carries workspace/batch/build identity, the rubric and assignment hashes, every planned cell, assigned/persisted episode counts, observed/eligible/missing opportunities, independent-unit coverage and missing reasons. Cell states distinguish `covered`, `insufficient`, `partial`, `not-assigned`, `unsupported`, and `unsupported-modality`. Counts are aggregated only over assignments that match the exact cell. `observedIndependentUnits` is null for non-episode analysis units until the evaluator contract provides cross-episode identity deduplication; a per-episode count is not silently summed into a distinct-participant/learner count. Data verifies the manifest's content hash and batch/rubric/assignment identity. The server-filtered Console overview renders the latest batch's cell states and unmet counts. Historical batches that predate this manifest remain explicitly unrecorded; no coverage is reconstructed from seed text. A migrated historical batch may therefore retain `coverageManifest: null` as explicit unavailable **scored** coverage; it cannot be used to prepare a **confirmatory metric/scoring** analyst packet or make a metric coverage claim. Genuine existing player-visible artifacts, if verifiably retained, can form a separate **unscored discovery packet** under the distinct contract above, with all missingness exposed. New terminal Runtime batches carry the content-verified manifest.

**Complete compact fixture registry.** Resolve defaults by shallow field replacement into each metric; reject absent required fields after expansion. The four definitions cover an objective defect, strategy signal, learning measure and reported enjoyment. Identifiers refer to fixture evaluator functions whose specified input/output cases below must become implementation tests.

```json
{
  "schemaVersion": 2,
  "workspaceId": "fixture-game",
  "audience": "first-time-adult",
  "registryVersion": "fixture-v2",
  "eventSchemaHash": "fixture-events-v1",
  "defaults": {
    "audience": "first-time-adult",
    "scenarioEligibility": ["tutorial", "standard"],
    "analysisUnit": "episode",
    "aggregationWindow": "whole-episode",
    "aggregation": "ratio-of-sums-within-scenario",
    "modality": "headless",
    "minExposure": 1,
    "minIndependentUnits": 1,
    "precisionPlanRef": "fixture-descriptive-only",
    "missingPolicy": "null-with-reason-and-missing-count",
    "provenance": ["episodeId", "eventId", "buildSha", "evaluatorHash"],
    "humanConstruct": null,
    "meaningfulMargin": null,
    "guardrailMargin": null,
    "severityRule": "descriptive-until-verified",
    "priorityClass": "investigate"
  },
  "metricDefinitions": [
    {
      "metricId": "legal-action-rejection",
      "version": 1,
      "mechanicKey": "action-execution",
      "aggregationWindow": "phase",
      "exposurePredicate": "fresh-legal-request-v1",
      "eventFields": [
        "action.offeredIds",
        "action.expectedRevision",
        "action.currentRevision",
        "action.executedId",
        "action.rejected"
      ],
      "evaluatorRef": "fixture/legal-rejection-v1",
      "evaluatorHash": "1111111111111111111111111111111111111111111111111111111111111111",
      "numerator": "fresh advertised legal requests rejected by engine",
      "denominator": "all fresh advertised legal requests",
      "unit": "proportion",
      "polarity": "lower",
      "targetBand": [0, 0],
      "notObservable": ["missing-action-or-revision-events"],
      "severityRule": "verified-blocks-progress",
      "priorityClass": "major"
    },
    {
      "metricId": "competitive-choice-share",
      "version": 1,
      "mechanicKey": "strategic-choice",
      "aggregationWindow": "phase",
      "exposurePredicate": "decision-with-complete-approved-alternative-evaluation-v1",
      "eventFields": [
        "branch.decisionId",
        "branch.actionId",
        "branch.expectedReward",
        "branch.complete",
        "branch.continuationPolicyHash"
      ],
      "evaluatorRef": "fixture/competitive-options-v1",
      "evaluatorHash": "2222222222222222222222222222222222222222222222222222222222222222",
      "numerator": "eligible decisions with at least two actions within 0.05 of best expected reward",
      "denominator": "decisions with all legal alternatives evaluated under frozen continuation and RNG plan",
      "unit": "proportion",
      "polarity": "higher",
      "targetBand": [0.5, 1],
      "notObservable": [
        "fork-unsupported",
        "partial-alternatives",
        "reward-or-continuation-contract-mismatch",
        "unsupported-evaluator",
        "unsupported-modality"
      ]
    },
    {
      "metricId": "repeat-forecast-error",
      "version": 1,
      "mechanicKey": "learning",
      "aggregationWindow": "phase",
      "exposurePredicate": "revisited-visible-rule-after-feedback-v1",
      "eventFields": [
        "probe.ruleId",
        "probe.expected",
        "probe.actual",
        "probe.beforeAction",
        "cohort.memoryId",
        "feedback.visible"
      ],
      "evaluatorRef": "fixture/repeated-error-v1",
      "evaluatorHash": "3333333333333333333333333333333333333333333333333333333333333333",
      "numerator": "wrong preregistered deterministic consequence predictions after visible feedback",
      "denominator": "eligible revisits after visible feedback",
      "unit": "proportion",
      "polarity": "lower",
      "targetBand": [0, 0.2],
      "analysisUnit": "learner-identity",
      "notObservable": [
        "missing-before-action-probe",
        "stochastic-outcome-without-probability-target",
        "missing-feedback"
      ],
      "severityRule": "model-learning-signal-only"
    },
    {
      "metricId": "reported-enjoyment",
      "version": 1,
      "mechanicKey": "whole-experience",
      "exposurePredicate": "consented-post-play-enj-within-study-window-v1",
      "eventFields": [
        "response.ENJ",
        "response.timing",
        "response.consentVersion",
        "response.instrumentVersion"
      ],
      "evaluatorRef": "fixture/minipxi-enj-v1",
      "evaluatorHash": "4444444444444444444444444444444444444444444444444444444444444444",
      "numerator": "sum of valid ENJ responses",
      "denominator": "valid ENJ respondent-session responses",
      "unit": "native-Likert-minus3-plus3",
      "polarity": "higher",
      "targetBand": [1, 3],
      "aggregation": "native-item-mean-and-category-distribution",
      "analysisUnit": "participant",
      "modality": "human-post-play",
      "notObservable": [
        "no-consent",
        "withdrawn",
        "missing-ENJ",
        "wrong-instrument",
        "outside-window"
      ],
      "humanConstruct": "miniPXI.ENJ.post-play",
      "provenance": [
        "studyId",
        "responseId",
        "episodeId",
        "buildSha",
        "instrumentVersion"
      ],
      "severityRule": "reported-experience-only"
    }
  ],
  "coverageRequirements": [
    {
      "coverageMetricId": "legal-action-rejection",
      "mechanicKey": "action-execution",
      "phaseId": "tutorial",
      "scenarioFamily": "tutorial",
      "cohort": "novice",
      "policy": "heuristic",
      "modality": "headless",
      "requiredOpportunities": 10,
      "requiredIndependentUnits": 1,
      "unsupportedReason": null
    },
    {
      "coverageMetricId": "competitive-choice-share",
      "mechanicKey": "strategic-choice",
      "phaseId": "tutorial",
      "scenarioFamily": "tutorial",
      "cohort": "novice",
      "policy": "heuristic",
      "modality": "headless",
      "requiredOpportunities": 4,
      "requiredIndependentUnits": 1,
      "unsupportedReason": null
    },
    {
      "coverageMetricId": "repeat-forecast-error",
      "mechanicKey": "learning",
      "phaseId": "tutorial",
      "scenarioFamily": "tutorial",
      "cohort": "novice",
      "policy": "heuristic",
      "modality": "headless",
      "requiredOpportunities": 4,
      "requiredIndependentUnits": 1,
      "unsupportedReason": null
    }
  ],
  "dimensionRubrics": [
    {
      "dimensionId": "agency",
      "version": 1,
      "unit": "episode",
      "indicator": "competitive-choice-share@1",
      "modality": "headless-with-verified-branches",
      "minExposure": 4,
      "minIndependentUnits": 1,
      "scoreBands": [
        {
          "score": 0,
          "equals": 0
        },
        {
          "score": 1,
          "greaterThan": 0,
          "atMost": 0.25
        },
        {
          "score": 2,
          "greaterThan": 0.25,
          "atMost": 0.5
        },
        {
          "score": 3,
          "greaterThan": 0.5,
          "atMost": 0.75
        },
        {
          "score": 4,
          "greaterThan": 0.75,
          "atMost": 1
        }
      ],
      "counterexample": "second legal action is dominated",
      "evidenceChecklist": [
        "all legal alternatives evaluated",
        "frozen reward and continuation",
        "verified RNG plan"
      ],
      "insufficient": "null",
      "humanOutcomeMapping": null
    }
  ]
}
```

**Known inputs → outputs:** two rejected requests among ten fresh advertised requests = 2/10 = 0.20 legal-action rejection. Competitive-choice decisions with alternative reward vectors [0.80,0.78], [0.90,0.10], [0.40,0.38] yield 2/3; an unevaluated fourth decision is excluded as missing, so coverage is 3/4, not a fourth zero. This is reward-relative choice viability, not proven strategic depth. Revisited rules with one wrong prediction among four eligible revisits = 1/4; this measures the synthetic learner unless human validity is established. ENJ responses [2,1,-1,null] yield native mean 2/3, three respondents, one missing, and category counts; they do not yield a 0–4 critic score.

**RacingGame fixture:** avoidable-double-DNF numerator = at-risk decisions followed by double DNF for which a legal player-visible alternative avoids it under a verified branch plan; denominator = at-risk decisions with completed comparable alternative evaluation. Two witnesses among eight evaluated opportunities = 25%; with ten at-risk decisions total, coverage is 8/10 and two are unknown. It is not 2/all turns and not a population human-frustration estimate. The adapter owns at-risk predicates, horizon, alternative costs and outcome logic.

**Semantic events:** capabilities advertises a versioned taxonomy of eventId, type, phaseId, step/revision, actor, eligibility flags, authoritative emitter or detectorRef, thresholds, severity and expected occurrence range (if known). Use existing game event hooks; an absent near-miss/reversal/competitive-choice definition is unsupported, never inferred as fact by an LLM. In a synthetic trace, a game-emitted failure at step 23 selects [21,25]; a seeded sample from eligible ordinary decisions selects step 8 and [6,10]. Clamp windows to episode bounds, union overlaps, retain reasons and list omitted phases. Detector fixtures cover true, false and boundary cases.

**Coverage manifest:** enumerate game-owned critical mechanic × phase × scenario family × knowledge/skill × strategy × modality cells, with required opportunities, independent units, observed counts and unsupported reasons. The first delivery fixture must cover tutorial/standard/edge scenarios, novice/heuristic/expert-or-stress policies and each advertised phase; require ten opportunities in each fixture-critical cell and one native visual confusing-but-correct case. These are harness acceptance counts, not statistical sufficiency. Production counts come from the benchmark precision plan. One thousand repeated easy episodes cannot satisfy missing cells.

### Autonomous visual-first evidence semantics (extends the same registry; no second scoring authority)

The [autonomous gameplay operating model](playtesting-target-state.md#3-architecture-and-ownership) introduces three execution modes: `autonomous-visual`, `adapter-accelerated` and `scripted-regression`. These are **measurement strata, not interchangeable proof sources**. Every episode/decision/metric records the mode, observation provenance (native screenshot/DOM/a11y vs game-engine projection), presentation timing clock, visible-information boundary, policy/model/persona/version, actual input/action source, baseline/witness link and media availability. An optional combined session must label the mode and observation source of each transition. Historical rows with no provenance remain `legacy-unknown`; do not assert that they were UI-observed.

| Claim | Minimum supporting evidence | What is never inferred |
| --- | --- | --- |
| The AI discovered a control or progressed through actual UI | Approved visual tool input receipt, time-aligned before/after **native** frame or accessible state, observed progress or explicit unknown outcome | That the input was engine-legal without an engine witness; that every human would discover the control |
| The AI misunderstood a consequence | Frozen pre-action policy prediction and its visible inputs, recorded observed consequence and versioned comparison criterion; repeated calibrated probes for broader conclusions | A prediction entered retrospectively; an isolated stochastic surprise as a UI defect; an AI statement as human confusion |
| The rendered game is confusing/slow/unclear | Native real-time frame/clip/audio (only if captured), independently initialized competent observers, native interval provenance and game-specific warning criteria | Human-confirmed confusion or enjoyment without consented/qualified human evidence; accelerated animation timings as native UX |
| The game engine violates a rule | Authenticated engine evaluator/invariant evidence and replay/branch hashes where applicable | Engine facts from a screenshot-only policy's guess |
| Version B improved the experience | Frozen metric/eligibility/cell and policy versions, comparable conditions and independent units, pre-registered changed-build comparison; separately qualified human preference when claimed | Causation from cherry-picked exploratory sessions; a raw critic category increase as calibrated fun |
| A Smart/Jev policy plays better than controls | Same opportunity distribution, comparable policy information and compute where relevant, measured outcomes/intervals and recorded fallback/escalation costs | Human player representation, human intelligence or fun solely from AI win rate |

**Unconfigured visual exploration has a useful minimum without inventing metrics:** capture exact game target/build or URL identity, cohort instruction, bounded policy revision, real screen+action provenance, observed transitions, step notes and explicit unsupported fields. Discovery sessions can produce localized **hypotheses** even before a game owner supplies a rubric or engine metrics. Metric-based score dimensions, baseline comparisons and `verified` bug/invariant assertions remain `null` / `not observed` until corresponding registered evidence and independent checks exist. Optional author-provided mechanics/rubric/invariant definitions improve interpretation but do not block the first controlled visual session.

**Player memory and interpretation:** Preserve bounded per-player experience/history across a learning cohort, reset between game/workspace, locked policy/build and holdout arms as pre-registered. Record separately the policy's stated intent, predicted consequence, confidence (uncalibrated unless verified), observed action/result, Smart director intervention and later critic inference. A Smart intervention is a treatment variable and can confound learning/skill; stratify and report its frequency rather than attribute all actions to Jev. Several Jev agents or model calls are **not independent human subjects**; do not count votes or agents as human N.

**Sampling and missingness:** Specify frame/video/audio/DOM observation opportunity counts and dropped/unavailable captures, game-state-change detection, meaningful decision windows and normal sampled periods before reviewing outcomes. Report known failure/stuck/uncertain episodes, even when there is no terminal result, and use frozen discovery/surveillance selection to prevent showing only anomalies. The unit of independent variation may be an episode, seed, persona instance, human participant or game—never assume thousands of steps/frames from one session yield thousands of independent observations. Compare visual-vs-headless **within mode** until a representative UI-to-engine conformance study establishes shared semantics; mismatched modal clocks, action spaces, precise information and RNG paths make the cross-mode claim observational or not comparable, not zero impact. Exact seed equality without verified RNG/state coupling remains insufficient.

**Required new acceptance fixtures:** a first-play browser episode with no per-game JSON; canvas clicks grounded to viewport with verified before/after change; stale UI element and game navigation refusal; Smart escalation recorded separately from Jev tactical actions; genuine Jev decision with a pre-action forecast and an absent-forecast `null` control; generated-after-action "prediction" rejected; deliberately bad novice policy with clear UI; visually confusing but mechanically correct game; headless "high win rate" with missing native images; sampled anomaly review plus representative normal windows; changed build with different model revision labeled non-comparable; and AI-judge disagreement with real consented preference data. The report must distinguish fixture test results from real selected-game evidence and validated human studies.

## 2. Quality anchors and evidence sufficiency

Every dimension rubric declares unit (decision/episode/cohort), observable indicators and counterexamples, modality, minimum eligible opportunities/independent units, five ordered examples, evidence checklist and human-outcome mapping (null unless validated). Quality means degree of meeting the declared criterion. **Evidence quantity, coverage, confidence, rater disagreement and calibration are separate fields.**

General anchor meanings: 0 = criterion unmet; 1 = mostly unmet; 2 = substantively mixed; 3 = mostly met; 4 = met. Insufficient/inapplicable evidence = null with a reason, never 2. No universal numeric fun scale or weighted composite.

For the synthetic agency rubric, the episode unit requires at least four fully evaluated eligible decisions and competitive-choice-share bins: 0; (0,0.25]; (0.25,0.5]; (0.5,0.75]; (0.75,1] map respectively to 0–4. Four decisions with two competitive opportunities give 0.5 → category 2; a treatment with three gives 0.75 → category 3 under the same rubric. A dominated second action is a counterexample, not a competitive choice. Replicating the unchanged episode increases evidence and narrows justified uncertainty but leaves its category 2. Two opportunities produce null despite an attractive ratio.

Other dimensions must supply equally concrete game-owned examples before activation: pacing uses native timing against phase targets; clarity uses observed UI plus the diagnostic ladder in §8; tension/recovery uses bounded verified escape opportunities; depth uses varied competitive strategies under frozen competence controls. Missing dimension definitions disable that dimension rather than inherit the agency formula.

Persist raw indicators, category, rationale, checklist and evidence refs. For cohorts show category counts/proportions and null counts; do not average/subtract 0–4 labels as equally spaced numbers. Preregister an ordinal endpoint, such as share at/above a justified anchor, when testing a change. Equal category distributions with 10 versus 100 independent episodes remain the same descriptive quality; uncertainty differs. Freeze rubrics, run blinded repeat and second-critic scoring on adjudicated reference episodes, and require the preregistered agreement threshold. Disagreement is retained and adjudicated; unresolved cases stay provisional and out of confirmed trends.

## 3. Sampling, exposures and missingness

Freeze the episode inventory and sampling seed before critique. Within each build allocate the fixture review budget of 40 as 24 surveillance + up to 16 targeted discovery reviews. These are configurable example allocations, not production power claims.

Surveillance uses seeded sampling without replacement within preregistered policy × scenario × outcome strata. Allocate at least one per nonempty stratum, then proportional largest-remainder allocation by population count; if there are more strata than budget, reject this design and predeclare coarser strata or a larger budget. Record N_h, n_h and inclusion probability n_h/N_h. Keep every probability-sampled unit, including similar traces. Capture phase coverage within the selected episode separately. Select discovery from remaining episodes ranked by versioned anomaly/novelty signals, with seeded tie breaks; deduplicate similar discovery traces only, preserving occurrences and selection reasons.

Only surveillance contributes to population critic-category estimates, using stratum population weights N_h/N and a design-appropriate interval implementation. Targeted reviews are reported separately; a 12/40 discovery-enriched count cannot become 30% of 1,000 episodes. If valid design weights/intervals are unavailable, report reviewed-only counts and population prevalence unknown. A validated deterministic detector may run over all eligible exposures and report exact batch prevalence instead. Confirm discovered hypotheses on fresh, independently selected episodes. Fixture: discovery finds a rare failure in 12 selected reviews; full detector sees 12/1,000 episodes. Display both with distinct denominators, never equate them.

The **confirmatory** critique sampling population is persisted, complete episodes only. Separately, a bounded unscored visual-discovery investigator may inspect a verified partial observation prefix, as a **partial observation hypothesis** only; these records never enter the complete-session sampling denominator or critic quality distribution. Player-authored checkpoint notes are not analyst reviews. A cancelled, crashed, infrastructure-failed, budget-truncated, partial, or episode-less assignment remains in the assignment denominator and is counted as unreviewable; it cannot be selected to satisfy a complete-session critique budget. The first milestone selects no more than 40 complete sessions for critique. Persist the ordered, bounded assignment manifest (at most 1,000 assignments and 256 KiB) and its content hash before launching workers. Live Runtime status may expose partial outcome counts; the terminal batch revision retains every no-episode disposition, while episode rows remain the source for assignments with persisted episodes. If Runtime restarts before terminal persistence, reconcile against the frozen manifest and workspace-scoped episode rows, preserve observed episodes, close missing assignments as infrastructure loss, and mark the batch failed with durable `nonterminal-batch-recovered` provenance. Both run-status and active-runs reads reconcile orphaned nonterminal batches. Never synthesize an episode, successful retry, or game outcome during recovery. A batch recorded before manifests existed remains inventory-unavailable and is not reconstructed from seed text. The review cap counts persisted critique receipts, not planned selections; retrying the same review ID is idempotent. Before writing findings or a review row, Runtime durably reserves that exact review ID against the cap. Reservations do not inflate completed-review counts and cannot be consumed by another review; the same ID finalizes the reservation after persistence succeeds. Cancelled batches retain whether the operator cancelled, approval was revoked, or the workspace was disabled; pre-change records remain explicitly reason-unavailable.

For a **selected confirmatory/scored session**, before analyst inference Runtime prepares one immutable, bounded metric evidence packet and persists a packet receipt (prepared or explicitly unavailable) in the terminal batch. For **unconfigured visual discovery**, Runtime may prepare a separately typed **discovery evidence packet** from verified selected UI/action windows (including a truthful partial prefix), independent of rubric or coverage manifest, with result restricted to cited hypotheses and missing fields marked unsupported. The confirmatory packet binds the frozen episode, assignment, build, rubric, coverage manifest, source-trace hash and only player-visible selected windows; the discovery packet binds the approved target identity, assignment/episode, mode, real observation/capture/input provenance and observed-but-possibly-unverified build identity, with rubric/coverage references explicitly null; event-bearing and terminal evidence is retained ahead of deterministic ordinary context, with omitted windows/artifacts and byte/token limits explicit. A selected batch cannot silently omit a packet receipt. The analyst retrieves the exact artifact using `playtest.prepareReview`; `playtest.submitReview` must bind its packet ID, artifact ID and SHA-256, and every review-, observation-, interpretation-, dimension- and finding-level citation must resolve within that packet. A missing/unavailable/corrupt source or packet is an explicit review failure, not permission to reread arbitrary trace windows and enlarge the critic input. Unknown model/prompt identity stays null rather than being inferred.

Every finding records affected episodes/all eligible episodes **and** affected opportunities/all eligible opportunities, by build/scenario/policy/modality. A pit failure can be 12/15 pit entries and 12/1,000 runs simultaneously; affected-human share remains unknown without human exposure data. Repeated events within an episode are not independent sample units.

Keep assigned, started, completed, crashed, infrastructure-failed, cancelled, budget-truncated, reviewed and eligible counts. Game crashes count in the assigned-run stability outcome; a normal game loss is a completed outcome. Instrumentation failures are missing, not losses or zeros. Predeclared completion endpoints count game crashes as failure; outcomes genuinely unobserved because of infrastructure remain unknown and retain their original pair assignment. Optional completed-only rates are visibly conditional secondary metrics. Report missingness by arm/stratum and predeclared sensitivity bounds; do not silently delete pairs or replace failed episodes with successful retries. When missingness limits or precision requirements fail, comparison is inconclusive; semantic contract mismatch is not-comparable. No LLM score is imputed as zero.

Acceptance: candidate completes 80/100 assigned runs and wins 64; baseline completes 100/100 and wins 70. Show candidate 80% wins among completers **and** 64% assigned-run completion-success if the 20 are confirmed game crashes. The stability guardrail worsens; do not claim improvement. If the 20 are infrastructure failures, report 64 known wins plus 20 unknown, sensitivity range 64–84%, and an inconclusive outcome.

## 4. Benchmark, pairing and comparison decision

PlaytestBenchmark is an immutable manifest: id/version, workspace, reference build SHA, scenario inventory/distribution and weights, seed inventory with purpose, policy/checkpoint and competence report, memory reset rules, engine/environment, action/observation/event/metric/rubric hashes, capture mode, measurementVersion, primary outcomes, guardrails, practical margins, independent unit, sample/precision plan, missingness bounds and refresh policy. Exact file/content hashes are required in live manifests; fixture aliases below must resolve to immutable artifacts in tests.

Core rejects malformed benchmark inventories, non-normalized scenario weights, incomplete metric margins, unsupported capture/independent-unit values, and invalid hash/version fields. The canonical hash projection excludes only `contentHash`; Runtime recomputes SHA-256 before binding the manifest to an exact workspace config, rubric, observation schema and measurement version, and Data validates the manifest on persistence and readback.

Compatibility is metric-specific:

| Mode                     | Required evidence                                                                                                   | Claim permitted                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| paired-initial-condition | Explicit pair ID, comparable initial scenario and policy/information contract, recorded seed allocation             | Whole-episode outcome difference under matched initial conditions |
| paired-counterfactual    | Above plus verified snapshot/hidden-state equality, exogenous RNG coupling/stream semantics and continuation policy | Bounded same-state intervention effect under that coupling        |
| distribution-matched     | Comparable measurement and scenario/skill distributions, independent allocations                                    | Controlled group difference with declared limitations             |
| observational            | No controlled allocation, but interpretable common quantity                                                         | Association, with confounders                                     |
| not-comparable           | Changed quantity, missing required modality or unbridged schemas/competence                                         | No quality delta                                                  |

For a counterfactual branch, retain a full-state/RNG digest at the parent's exact pre-action decision. Runtime replays the frozen trace to that zero-based decision, requires `replayStatus=verified` and an exact reached-step match, materializes a snapshot, and compares the digest plus RNG algorithm/version/state hash with the parent checkpoint before forking. The fork must reproduce the same state/RNG digest; Runtime then verifies the alternate ID against current legal actions and executes it. A missing digest, hidden-state mismatch, extra random draw, nondeterministic stream, or replay/fork artifact failure means no paired-counterfactual evidence. The replay prefix and continuation share the approved per-episode step ceiling and the branch is a separately budgeted assignment with durable parent/trace/snapshot lineage. A synthetic adapter contract test does not establish target-game support.

Record pair map, RNG algorithm/stream versions, coupling diagnostics, exclusions and intended pair assignments. Identical seed strings do not prove identical future draws. An extra RNG call invalidates an identical-randomness branch claim; it need not invalidate a legitimate initial-condition block. Independently sampled continuations or stratified group analysis may be allowed if preregistered and scientifically appropriate; do not select the fallback after seeing which result is favorable.

The Core comparison builder consumes the frozen allocation-plan SHA-256 plus every assigned baseline/candidate episode pair and the per-metric quantity/source hashes. It checks that metric arm summaries retain exactly the assigned unit inventory (including assignments whose outcomes are missing); count-only pairing is insufficient. A counterfactual whose observed RNG sequence is missing or differs is downgraded to paired-initial-condition when the initial state and allocation still match, with diagnostics and no silently dropped pair. Each metric is compared only when its quantity, source, modality and independent unit match, and persists both source descriptors/hashes. A changed critic/rubric hash makes critic-derived metrics not-comparable while an unchanged deterministic evaluator remains comparable even if the overall measurement version changed. The builder also enforces the preregistered per-arm missingness maximum, requires passing sensitivity bounds whenever outcomes are missing, and applies minimum independent-unit and maximum interval-width precision gates before classifying a metric.

**One PlaytestComparison, not a second ComparisonReport schema.** It contains benchmark/experiment IDs, baseline/candidate SHA, freeze/compatibility status, measurement version, per-metric assigned/eligible/missing counts, independent N/pairs, exposure, estimate, raw delta, oriented benefit delta, interval/method/library version, meaningful/noninferiority margins, classification, guardrail status, human-preference result or not-collected, source finding/episode refs, and an owner-authored disposition/identity/reason. The root/operator-only `playtest.decideComparison` action requires the exact current revision, appends an immutable versioned decision, and records `promote` only when the code-derived result is `eligible-for-owner-promotion`; it never triggers deployment or release. Comparison schema v2 stores the disposition and trusted actor. V1 history migrates with explicit `not-recorded` owner disposition when an older free-text decision exists, and never fabricates its actor or action. Serialize writes in the single Runtime owner; horizontal writers require durable coordination before they are supported. Store immutable revisions when reanalysis is necessary.

For an oriented benefit delta d (positive is favorable), interval [L,U], meaningful margin m>0:

- improved if L>m; regressed if U<−m;
- no-material-change if [L,U] is wholly within [−m,m];
- otherwise inconclusive. Failure to reject zero is not equivalence.
- not-comparable overrides these rules when semantic eligibility fails. Missingness/precision failures yield inconclusive, retaining descriptive results.
- A guardrail with tolerated harm g≥0 passes noninferiority only when L>−g; U<−g is a breach; overlap is uncertain. Exact machine-checkable invariants can use source-authored deterministic criteria instead of statistical margins.

A comparison has per-metric conclusions and a **decision status**: eligible-for-owner-promotion only when the preregistered primary improves and all required guardrails pass with adequate coverage. A breach yields hold-regression; uncertain evidence yields hold-inconclusive; incompatibility yields hold-not-comparable. This is not an overall fun score or a new release authority. Actual promotion/rollback remains the developer/existing release workflow's decision.

**Worked A/B calculation fixture:** 100 paired synthetic episodes with binary completion outcomes: baseline succeeds for units 1–60, candidate succeeds for 1–70. Ordered paired benefit differences are ten +1 and ninety 0, mean +0.10. A frozen correct-forecast endpoint loses success for 30 units and is unchanged for 70, differences thirty −1 and seventy 0, mean −0.30. SciPy 1.17.0 / NumPy 2.3.5, bootstrap on each ordered difference array with numpy.random.default_rng(42), 100,000 resamples, percentile method, confidence_level=0.95 gives intervals [+0.05,+0.16] and [−0.39,−0.21]. The fixture has one primary and one noninferiority guardrail and claims eligibility only if both pass; no post-hoc selection of a favorable endpoint. With completion m=0.02 and clarity guardrail g=0.05, output completion improved, clarity breached, decision hold-regression, human preference not-collected. These calculations were checked during this documentation revision; they are synthetic comparison fixtures, not game results. A degenerate/NaN interval fixture must additionally prove honest failure or a preregistered compatible method. The UI displays this tradeoff, never “10% more fun.”

**Statistics reuse:** pin an isolated analysis task using [SciPy bootstrap](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html) for appropriate paired independent-unit arrays, [statsmodels multiplicity](https://www.statsmodels.org/stable/generated/statsmodels.stats.multitest.multipletests.html) for a predeclared family, and the existing §7 metrics libraries. Resample independent participant/episode clusters, not individual correlated events; multiway clustering needs an explicitly tested supported method. Reject NaN/degenerate intervals or use only a preregistered compatible method. AutoDev supplies quantity definitions and input grouping, not homegrown inference math.

**Dependency decision:** [GrowthBook](https://github.com/growthbook/growthbook) is a candidate for its statistical engine only if a pinned license/API test demonstrates our paired, clustered, missingness and multiplicity contract; do not deploy its dashboard, assignment service or remote feature flags for this v1. The simpler frozen allocation plus isolated statistical libraries is the v1 path. [Evidently Report](https://docs.evidentlyai.com/docs/library/report) can emit report snapshots, but its schema does not replace PlaytestComparison or source-owned verdicts. Prefer existing Evaluations/OpenLIT for monitoring; enable Evidently offline only for a demonstrated missing calculation, with parity and licensing checks. No second experiment, monitoring or survey platform.

## 5. Approved experiments and repeated testing

PlaytestExperiment is the canonical versioned experiment manifest (the term ExperimentManifest refers to this same record). Required fields: id/version/workspace, findingIds, hypothesis and falsifier/alternatives, benchmarkId, independently approved baseline/treatment SHA or game-owned flag-manifest hash, build artifact hashes, approval ID, exposure/allocation unit, allocation seed/method, cohort and memory initialization, pair map, discovery/confirmation inventories, primary metric/guardrails, analysis/missingness/multiplicity plan, budget/stopping rule, execution state, attempt IDs, result comparisonId, developer decision and rollback/replay refs.

The developer or separately authorized implementation workflow creates variants and obtains build artifacts through existing GitHub/CI. Playtesting selects only approved immutable artifacts; neither analyst nor runner edits the game. Flags must resolve to a hashed game-owned variant with exposure recorded before play. Approval of one artifact never approves a moving branch. Rollback stops future exposure and asks the existing owner to restore its selected build; it is not a deployment action performed by the critic.

Fixture: finding F-warning → approved A original-warning and B clearer-warning artifacts → experiment E-warning with 20 independent synthetic learners, ten per arm, allocated by a pinned random permutation of stable IDs, same scenario mix, frozen policy P1, no shared learning memory → at most one episode/person, 40 total critiques and 30 minutes → primary consequence-forecast accuracy (margin 0.10), crash guardrail (tolerated harm 0.02), fixed final analysis after 20 assignments. The fixture permits descriptive output only because N=20 is not a production precision justification. B improves this model's forecast accuracy; with no humans, conclusion is model-specific and human-confusion unverified. Replay selects artifact A/B and the saved allocation; variants are never patched mid-experiment.

States: draft → approved → running → completed → analyzed → owner-decided; denied, cancelled, execution-failed and inconclusive are retained terminal attempt results. Infrastructure retries create attempts under the same assignment; a game failure is an observation, not a retry-until-pass. Retain successful, negative and ambiguous experiments.

Core validates the entire frozen manifest, including disjoint discovery/confirmation inventories, complete per-unit assignment, symmetric paired allocation, exact fixed-N budget, preregistered metric/guardrail separation, and unique attempt IDs. Persisted state is cross-validated against its evidence: `approved` and later states require the non-null approval ID frozen into the design hash; execution/result states require at least one attempt; `analyzed` requires a comparison ID; and `owner-decided` requires both its comparison and owner decision. The state transition API is immutable/versioned: entering `running` requires a fresh attempt ID, `analyzed` requires the stored comparison ID, and `owner-decided` requires a recorded owner decision. Terminal outcomes cannot be rewritten into a successful result; a retry is a new infrastructure attempt under the same frozen assignment.

`PlaytestExperiment.contentHash` is the SHA-256 of a canonical, key-order-independent projection of the frozen design/allocation/analysis fields; state/version/attempt/comparison/owner-decision revisions are excluded intentionally. Core exposes that projection, and Data verifies it on persistence and readback. Transition revisions retain one stable design hash while the immutable payload revisions preserve every outcome.

**Adaptive-cycle rule:** discovery and fixed regression suites may guide fixes but are never called untouched confirmation. For each confirmatory hypothesis family, freeze candidate count, primary/guardrails, independent holdout inventory and fixed N before labels; v1 has one final analysis and no optional stopping for success. Use predeclared family correction or simultaneous intervals; an expanded family requires a fresh protocol. Once confirmation results inform design or prompt changes, mark that set spent and reserve a fresh independent set for the next claim. Repeated player/scenario identities remain grouped. Unplanned trials are exploratory, even if favorable. Sequential tests are unsupported until a maintained implementation and operating-characteristic fixtures are selected. Acceptance: many null variants with one lucky discovery result remain unconfirmed; all attempts are visible.

## 6. Evidence validation, policy validity and judge drift

The target review pipeline keeps four checks independent: schema/locator validity; deterministic fact support; independent semantic support; hypothesis corroboration. Current review-v6 stores each observation and interpretation as its own claim with citations, enforces the exact prepared-packet boundary, and requires a coherent report-completeness record for alternatives, experiment/no-experiment rationale, cross-session-context availability, and follow-up. A v2 evidence packet may include up to four sibling summaries selected by seeded uniform sampling from the complete, persisted episodes in the same frozen batch/build. The inventory hash and deterministic selection seed are bound into the packet ID; the packet records eligible count, selected summaries, and inclusion probability. These are episode summaries, not aggregate estimates or independent-human samples. A review may cite only the whole sibling episode IDs actually included in its packet as cross-session evidence; it cannot cite sibling steps/events or infer unprovided sessions. With no eligible sibling, the packet records an explicit unavailable reason and inventory hash. One-way legacy migrations preserve old text with empty per-claim citations and mark unrecorded completeness sections rather than inventing locators or conclusions. A successful submission means stored, not proven. Runtime's current evidence preflight verifies stored locator identity and selected-packet provenance; the independent blind validator workflow and persisted per-claim semantic/corroboration verdicts remain unimplemented. The target validator must read cited windows, applicable rules and rubric **without the critic conclusion**, record its observations first, then compare the proposed interpretation, storing supported/contradicted/insufficient with reasons per claim. Until that integration exists, all analyst interpretations remain hypotheses.

Required adversarial cases: nonexistent event; existing irrelevant event; cited list containing the supposedly absent action; correct event with wrong rule; anchor-inconsistent rating; omitted counterexample. Reject false factual assertions from verified summaries while preserving rejected review provenance. Use the existing validator/evidence tools, not another judge framework.

**PlayerPolicyValidity:** game/build/cohort, observation/action semantics, policy/checkpoint, held-out human decision-state IDs when available, competence/legality, repeatability, action agreement and distribution divergence, coverage and failure modes. Reuse cited Mario Personas comparator protocols/functions only when action semantics match. Preregister acceptance bounds against relevant human data; absent data means unvalidated-synthetic-cohort. Failure downgrades novice/learner UX generalizations to model-specific signals and disables human-proxy comparisons, rather than leaving an authoritative claim with a footnote.

**Diagnostic reference corpus:** independent reviewers blind to critic output label sampled positive and critic-negative ordinary/problematic episodes. Unit = a category/mechanic issue instance at an episode/event window; match by category, mechanic and overlapping witness window under a frozen rule, with one-to-one assignment. A second reviewer adjudicates disagreement; unresolved/unknown labels are excluded from scored truth with counts. Keep injected defects and natural problems in separate strata and preserve intended-difficulty negatives. Precision = matched supported instances/predicted instances; duplicate predictions after the first count as false positives. Recall = matched/reference-positive instances only within adequately reviewed reference coverage. Incomplete truth means recall unavailable, not 100%. Fixture: three known positives, two matched predictions plus one false alarm gives precision 2/3 and recall 2/3; an empty critic has recall 0 and precision undefined. A missing known issue tests false negatives; duplicate floods cannot boost recall. Compare critic+deterministic versus deterministic-only at matched cost/coverage. Core implements this arithmetic in `core/src/playtesting/diagnostic-corpus.ts` (`evaluatePlaytestDiagnosticCorpus`): it requires two blind reviewers plus explicit agreement/adjudication state, freezes eligible/reviewed episode coverage per stratum, performs deterministic maximum-cardinality one-to-one window matching, and reports critic and deterministic-only scores separately. It does not store/adjudicate the reference corpus, schedule repeated judge checks, or validate actionability/cost by itself; those remain separate acceptance work. The scorer intentionally bounds corpus size and reports predictions outside reviewed coverage separately.

**Measurement version and cache:** hash metric/evaluator code, rubric anchors, prompt/skill, actual model revision and settings, input modalities, evidence selector/version, exact supplied window/artifact hashes, calibration/instrument mapping and output schema. Review cache key additionally includes immutable episode/trace identity, benchmark/comparison context and measurement version. Alias-only endpoints have revision unknown; log returned provider metadata and never assume identity stability. Reviews are append-only revisions with supersedes links.

Maintain a versioned adjudicated reference corpus spanning known bugs, correct ordinary play, misleading UI, false positives and ambiguous evidence. On any relevant model/policy/rubric/extractor change, and weekly while active, the existing scheduler runs blinded repeat and second-judge checks; compare fact/citation errors, diagnostic precision/recall when known, ordinal agreement, human prediction error and cost to predeclared tolerances. Quarantine affected claim types on failure; show stale/unvalidated or not-comparable until remedied. No human labels means no human calibration, even if synthetic fixtures pass.

Calibration binds to exact game/build/cohort/outcome/modality, evaluator contract and instrument. Any change creates pending-transfer status; only a preregistered overlap/transfer study can carry a scoped claim forward. Rescore both historical/current corpora with one frozen judge where retained evidence and consent permit, or show a series break. Never splice scores from changed judges into apparent game progress. Fixture: game unchanged, critic changed, higher category → measurement-change annotation, no improvement claim.

## 7. Human labels and change sensitivity

Use existing survey tooling and official instrument templates; v1 implements **authorized CSV/JSON import**, not invitations, accounts or a survey platform. The operator supplies a study manifest, instrument version/hash and export. Validate an explicit export-to-item mapping; do not claim every survey export has one universal schema.

[PXI guidance](https://playerexperienceinventory.org/docs) defines ten constructs with native −3…+3 responses and published item grouping. Preserve wording, labels and administration; report each full-PXI construct using its published three-item average. Do not combine ten constructs into enjoyment. The [official miniPXI items](https://playerexperienceinventory.org/assets/docs/miniPXI_English.pdf) identify ENJ separately: “I had a good time playing this game.” Use ENJ for reportedEnjoyment.postPlay; AUT, GR and CH remain distinct single-item constructs. Retain native units; any display transform must disclose its reversible mapping and never map to the critic's 0–4 scale.

The study declares response timing/window, exposure requirements, counterbalanced AB/BA order, independent unit and missing-item rule. When a paired preference outcome is planned, the approved `HumanPlaytestStudy.preferencePlan` freezes the exact question version/content hash, A/B build identities, interval method/library/version/confidence/resampling seed, participant minimum, maximum exclusion rate, and practical margin. Preference data are not silently borrowed from a PXI item. V1 conservatively leaves a full-PXI construct null if any constituent item is missing; miniPXI missing ENJ makes enjoyment null while other answered items remain usable. This is a declared missing-data policy, not a claim that PXI mandates it. For preference collect a separate project-authored A/B/tie/unable-to-judge response after both exposures; it is not a PXI item.

Required response fields: studyId, responseId, pseudonymousParticipantId, consentVersion/scope, instrument/version/hash, immutable build/variant, episodeId, exposure start/end and order, submittedAt, itemId/nativeValue or missingReason, completion status and restricted optional free text. Study metadata carries invited/eligible/responded/withdrawn counts. Reject unapproved study, wrong workspace/build, bad item IDs/range, invalid episode links, wrong timing and consent mismatch. (studyId,responseId) is idempotent; amendments have revision/supersedes, and duplicate participant×episode×instrument submissions are quarantined for operator choice. Never silently count both.

Human-study approval precedes collection. The study links each pseudonym to consent and withdrawal handling outside the generic LLM store; no direct identity is required in playtest records. Withdrawal deletes restricted responses/links and affected caches, recomputes permitted aggregates, and marks superseded results withdrawn or stale; retention must respect the consent scope. Aggregate retention is permitted only when allowed and nonidentifying. Small-cell privacy controls apply even to Console counts. Raw feedback is not sent to player policies or critics by default.

**Five-player import fixture (synthetic, descriptive only):** each plays A/B in counterbalanced order; P1 ENJ=(1,2), P2=(0,1), P3=(−1,null), P4=(2,2), P5=(1,3) then withdraws. Ten invited exposures, eight retained exposure records, seven valid ENJ responses, four retained participants, three complete pairs. A mean=0.5 (4); B mean=5/3 (3); those unequal-sample means are not the paired change. Complete-pair differences [1,1,0] average 2/3 (3 participants). P3's missing B is visible; P5 is excluded from all recomputed values. Each retained response links its build and replay. A duplicate import changes no counts. This proves import/missingness/linkage mechanics, not calibration.

**Human-versus-AI fixture:** critic agency category improves 2→3 while a participant's ENJ changes +2→0. Display both with separate construct/scale/source; flag disagreement, not “PXI confirms fun.” Prediction targets are explicit (e.g. native ENJ category distribution, or probability of preferring B) and validated separately from rubric categories. An autonomy or challenge score is not automatically a proxy for enjoyment.

**Change sensitivity is a separate qualification.** Freeze predicted direction/size or category of each held-out build-pair effect before human labels. Counterbalance exposure and blind build labels where feasible; use independent target-player pairs and preregister tie handling, primary outcome, precision and guardrails. Report absolute-rating agreement and change-detection/preference accuracy separately, with clustered intervals, baseline comparisons and disagreement. For preference define p=Pr(B preferred | decisive response), report ties/unable/missing separately and a preregistered maximum such exclusion rate; a preference claim requires the interval lower bound above 0.5 plus the practical margin. Otherwise inconclusive; all ties cannot count as wins. Passing absolute-rating validation never authorizes a change-detection claim. Revalidate after meaningful audience, mechanics, modality or evaluator shifts under §6. Core `importHumanStudyPreferenceResponses` imports a dedicated project-authored preference export, verifies the exact plan-bound A/B builds, both completed episode links, counterbalanced exposure order, timing, consent and question hash, and quarantines duplicate participant-pair submissions. The instrument-response and paired-preference quarantine endpoints return disjoint lists; each view returns an empty array for the other response family. The export must include one roster row per eligible participant with a completed pair; a blank answer is missing, not a response or a tie. The v1 interval plan uses the pinned Runtime statistics worker’s SciPy exact binomial (`binomtest(...).proportion_ci(method="exact")`) on decisive participant-level B/A answers; ties, unable-to-judge and missing answers remain separate counts and are excluded from that conditional probability. It is never a bootstrap over aggregate means, a model-generated interval, or a browser calculation. Data persists preference rows separately from PXI items in the restricted human-study store, migrates existing restricted state atomically to the preference-capable format, removes preference data on withdrawal, and suppresses counts when the participant total or any nonzero answer category is below five. Both current and migrated response records must match the study's frozen consent version and scope; malformed persisted rows fail closed before they can contribute to exposure or response summaries. Core `aggregatePlaytestPreferenceResponses` accepts the restricted pseudonym-keyed roster (including a null answer for nonresponse), rejects duplicate participants, and returns only distinct B/A/tie/unable/missing counts. `classifyPlaytestPreferenceSensitivity` applies the preregistered participant minimum, maximum exclusion rate, practical margin and provenance-backed external interval to those counts; it never computes interval math or turns ties into wins. Runtime obtains the interval only from the hash-locked Python worker using SciPy `binomtest(...).proportion_ci(method="exact")`, passes that exact interval and its locked method/library/confidence metadata to Core, and leaves the preference result inconclusive if the plan or worker cannot meet the frozen interval specification. An absent or unqualified interval, insufficient independent participants, or excessive exclusions is inconclusive. This decision concerns relative preference only and does not promote a build or establish absolute enjoyment.

## 8. Confusion and timing

Use an ordered diagnostic ladder: (1) verify authoritative rules, UI-to-observation equivalence and visual reading capability; (2) check independently initialized observers' competence; (3) freeze repeated pre-action forecasts before outcomes; (4) obtain actual consented human comprehension and behavior evidence for human claims; (5) compare a developer-supplied changed warning against frozen controls. Separate model-misunderstood, UI-possibly-ambiguous and human-confirmed-confusing, with eligible exposures and uncertainty. Several LLMs are not several people.

The human comprehension protocol is project-authored, **not a validated questionnaire**: show the exact pre-action UI, ask what the selected action will do to the preregistered visible consequence variable and confidence, commit the answer before execution, then record actual consequence and corrective behavior. Keep instruction wording, answer key and visibility limits fixed; use a separate shadow/moderated cohort because asking can teach the player. Administer published miniPXI GR separately for reported goal clarity. Claim human-confirmed-confusing only for the directly tested mechanic/cohort with prospectively adequate evidence; changed-warning causal claims additionally require the controlled treatment. Stochastic forecasts are scored probabilistically over repeated outcomes, not called misunderstanding because one unlikely event occurred. Core exposes `evaluateDiagnosticLadder` to evaluate pre-action forecasts and human evidence across the ordered 5-stage diagnostic ladder. It requires game-owned model-ambiguity and human-confusion thresholds, never uses universal hard-coded classification thresholds, and only claims `human-confirmed-confusing` when consented human evidence meets the small-cell minimum and its source-provided error-interval lower bound clears the game threshold. A threshold-overlapping or unavailable interval remains `ui-possibly-ambiguous`; isolated model mistakes remain distinct. A changed-warning intervention advances only after qualifying human evidence and with an externally estimated risk-difference interval; a point estimate alone is insufficient.

Timing fields separate simulationWallMs, logicalTicks/turns, policyInferenceMs and native capture clocks. Native sessions record mutually exclusive state intervals (active interaction, required animation/wait, deliberation, idle) using versioned game/browser state precedence; unknown intervals stay unclassified, not zero. Deliberation = actionable UI available before player response, idle = explicit pause/background or declared inactivity rule; record overlap resolution. Report per-phase medians/distributions and exposure durations; do not subtract synthetic inference time from real human experience. Headless/accelerated traces support logical phase-length/repetition signals only. Native timing supports presentation measurements; human pacing/boredom claims still require human reports. Acceptance: a 5-second simulation and 35-minute native run are never plotted on one duration series. Core exposes `summarizePlaytestNativeTiming` to validate the capture bounds and precedence version, resolve overlaps with the adapter-declared state ordering, emit a gap-free mutually exclusive interval partition, and retain uncovered or explicitly unknown time as `unknown`. It returns native-state durations only; callers must keep simulation, logical-turn and policy-inference values in their own units and series. Its fixture tests cover overlap precedence, gaps, invalid bounds and version mismatch. This helper does not establish that an adapter’s UI-state detector is valid; the game must supply and version that evidence.

## 9. Finding priority and fix lineage

Finding records separate severity, eligible frequency/recurrence, discoverability, affected cohorts, evidence status, human impact (when measured), novelty, investigation state and grounded effort estimate or unknown. Stable identity hashes workspace/game, a game-owned mechanic key, normalized event/action/witness signature and reproducible scope; seed, build, batch, model and run IDs remain evidence, not identity. Runtime derives event types and workspace/scenario-family from cited persisted evidence and rejects caller-supplied scope/event identity; unverified phase/modality remain null. Same-review duplicates collapse and repeat sightings append revisions with unioned references, not fabricated frequency. A single submitted review is capped at 64 proposed findings; distinct findings persist through bounded concurrent appends while preserving input order, and an oversized review is rejected rather than partially truncated. Triage is explainable: catastrophic/data-loss/access-blocking harm first; then major progress/experience harm, then minor friction. Within a class sort corroborated impact/exposure, recurrence and breadth; uncertainty affects investigation urgency rather than converting severity to zero. Operator overrides store author/reason. Human-confirmed severe UX can outrank a deterministic cosmetic defect. No opaque weighted LLM priority score. Core exposes `comparePlaytestFindings` and `triagePlaytestFindings` to implement this explainable priority ordering, sorting by severity class, corroborated/verified evidence, opportunity/episode exposure rates, cohort breadth, and explicit operator overrides with audit trail.

| Synthetic finding            | Severity / evidence                      | Exposure and affected scope           | Priority reason                                                     |
| ---------------------------- | ---------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| Save lost after exit         | Catastrophic, reproducible               | 1/1,000 episodes; 1/12 eligible exits | Irrecoverable progress loss                                         |
| Unreadable mandatory control | Major, human-confirmed in studied cohort | 8/10 eligible human encounters        | Blocks play for measured cohort                                     |
| Pit-entry failure            | Major, reproducible                      | 12/15 pit entries; 12/1,000 episodes  | Frequent when exposed; do not call 80% of players affected          |
| Decorative clipping          | Minor, reproducible                      | 900/1,000 captured episodes           | Broad but low harm; not above blocking UX solely due to determinism |

Persist findingId/fingerprint → experimentId → authorized issue/PR → candidate/build SHA → retest batches → PlaytestComparison → owner decision → recurrence observations. Extend these existing records, not a second workflow database. Root orchestrates retests when a linked approved build becomes available; it cannot infer success from a merged PR or closed issue.

Verification stages are separate from GitHub status: not-yet-validated; fixed-on-reproduced-case; sustained-improvement; regressed-elsewhere; insufficient-evidence. Original witnesses, fixed unaffected controls and fresh confirmation scenarios are all required for a broad improvement claim. Human claims additionally require §7 evidence. Sustained-improvement means the registered effect/guardrails passed over the preregistered observation horizon and cohort coverage; no universal number of cycles. Record last verified build, effect/interval, exposure and next review date.

One reproduced recurrence of an exact previously fixed invariant reopens the **internal investigation**; statistical/design concerns reopen only on the registered recurrence rule and sufficient exposure, otherwise trigger a verification request. External issue reopening follows existing explicit reporting authority; no hidden GitHub mutation. Expired replay means evidence-unavailable, not verified; preserve limited historical result with expiry annotations.

Two-cycle fixture: B fixes A's original failing witness but worsens a clarity guardrail → fixed-on-reproduced-case + regressed-elsewhere, owner holds B and reference stays A. C passes the witness, fixed controls and fresh registered confirmation without guardrail breach → eligible for owner promotion; claim only the tested outcomes. If humans were not collected, human enjoyment is still unknown. Later matching invariant recurrence reopens investigation and links C's previous verification.

## 10. Cadence, progress and retention

Reuse [existing orchestration](../.rulesync/skills/orchestration/SKILL.md), GitHub/CI events and existing scheduled jobs. This proposal does not activate schedules. One workspace-owned cadence configuration selects triggers/tiers, approved builds, budgets, cancellation and human-study policy; no playtest scheduler service.

Illustrative bounded tiers: authorized PR build → 20 fixed smoke assignments, deterministic checks, four critiques, ten-minute cap; merged approved build → 200 benchmark/discovery assignments, sixteen critiques, thirty-minute cap; opted-in nightly → 1,000 assignments, forty critiques, sixty-minute cap. Budget numbers are defaults to fit-test, not effectiveness claims. Manual runs choose one tier. Deduplicate by workspace/build/benchmark/tier/event; prioritize reproducible regressions, then uncovered critical cells, then rotating discovery. Never expose secret confirmation inventories to change authors. Weekly active judge checks reuse §6; release/human studies require a separately approved study and actual participant availability.

Retry a transient infrastructure assignment at most twice under the same budget, preserving every attempt; no retries of game failures for favorable statistics. Unsupported adapters/policies are quarantined with visible skipped cells. Budget exhaustion yields partial coverage and no automatic promotion. Paused/revoked workspace approval cancels queued work. Study failure or unavailability leaves human outcomes not-collected; it does not stop basic deterministic playtesting. Core exposes `validatePlaytestCadenceConfig`, `deduplicateCadenceTriggers`, `prioritizeCadenceWork`, `evaluateCadenceRetry`, and `evaluateJudgeCalibration` to validate tier budgets, deduplicate trigger events by `(workspaceId, buildSha, benchmarkId, tier, event)`, prioritize reproducible regressions before uncovered cells before discovery, strictly disallow retrying game failures while bounding infrastructure retries, and quarantine affected claim types when periodic judge calibration drifts past tolerances.

**One complete cycle:** approved baseline → linked change artifact/event → budgeted fixed suite plus rotating discovery → immutable comparison → evidence-supported finding/experiment → authorized external implementation → witness/control/fresh retest → owner decision → explicit baseline promotion or hold → longitudinal observation. The existing release authority consumes optional source-authored Evaluations projections; Playtesting never merges/deploys.

**Progress view:** Overview shows both pinned-reference-to-current and previous-build deltas with baseline ID, sample/exposure counts, missingness, scenario weights, measurement version, uncertainty and claim scope. Compare's default table shows primary outcome and each guardrail/classification, decision/reason, human result or not-collected, and links to manifest, findings, changes and paired evidence. Ordinal dimensions use distributions; incompatible series have breaks. Findings show new/fixed/recurrent counts and last verification.

| Synthetic build                    | Fixed-weight completion (easy/hard weight 50/50) | Raw sampled completion | Interpretation                                                              |
| ---------------------------------- | ------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------- |
| A: rates 90%/50%, sample mix 50/50 | 70%                                              | 70%                    | Pinned reference                                                            |
| B: rates 90%/40%, sample mix 90/10 | 65%                                              | 85%                    | Apparent raw gain hides worse hard-scenario outcome; investigate regression |
| C: rates 90%/50%, sample mix 90/10 | 70%                                              | 86%                    | Descriptive recovery to A; not evidence of improvement beyond A             |

The Core `standardizePlaytestCohortRates` helper preserves raw observed and frozen-weight standardized rates separately, the per-cohort numerators/denominators/missing counts, and source coverage. Missing strata/zero denominators yield explicit unknown states; this is a descriptive point estimate only, not an interval or a promotion verdict. Attach independent-unit N and intervals from the selected external statistics library to real rows; fixture rates alone do not establish statistical significance. In this example a separate reproduced hard-scenario defect can establish the B regression while rate evidence remains descriptive. Promotion creates a new benchmark version with author/reason and bridge results, never overwrites A. Track both references for continuity.

Persist immutable aggregate/comparison snapshots, input identities, counts, exclusions, statistical method and content hashes under workspace retention. Raw media may expire sooner; mark evidence/replay unavailable and prohibit rescoring without inputs. Historical numeric observations can remain with expired-evidence labels, not false replay links. Human withdrawal/consent restrictions override ordinary aggregate retention; revise or tombstone impacted results.

## 11. Implementation acceptance ledger

The first milestone requires the coverage manifest, not volume alone. Required fixtures: injected deterministic regression; confusing-but-correct native UI; weak bot with good UI; additional RNG draw; unchanged game with changed judge; anomaly-enriched sample; missing hardest episodes; valid-but-contradictory citation; missed known issue and duplicate flood; many null experiments; five-player import/withdrawal; witness fixed but guardrail regressed; three-build changing cohort mix; stale replay. Compare diagnostic actionability/precision/known-corpus recall against deterministic-only analysis, including unsuccessful outcomes and cost.

Each implementation must attach actual outputs, frozen inputs and source hashes to these gates. Source inspection or this document's examples do not count as executed tests. The practical first slice ends only when a developer can follow a real finding to a candidate comparison, explain the result and limits, and see the next cycle's status in shared Console history.
