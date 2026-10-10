# Generic Autonomous Game Playtesting — Target-State Proposal

> **Status:** Proposal only; this document does not implement the system or change existing runtime/Console behavior.
>
> **Ownership:** A focused design for AutoDev's reusable playtesting capability. [AutoDev Console Target State](autodev-console-target-state.md) remains authoritative for Console navigation, RuleSync configuration ownership, workspace architecture, evaluation semantics, OpenLIT integration, and UI requirements. Implementation PRs must update that canonical document when they alter those contracts.
>
> **Goal:** Run inexpensive AI gameplay sessions, **analyze what happened and why**, and turn reproducible defects or evidence-backed design hypotheses into actionable findings. The end-to-end pipeline is **play → record → objectively measure → LLM gameplay critique → aggregate → counterfactual verification → report**. Reuse tested upstream components first; build only missing game-quality analysis and AutoDev integration. Keep game rules and design goals in game-owned adapters/configuration.

## 1. Outcomes and boundaries

- Support high-volume, seeded **headless gameplay** and lower-volume **rendered/visual gameplay** through a common episode/evidence contract.
- Exercise multiple player skill levels and strategies, including intentionally imperfect behavior; retain random and deterministic heuristic controls.
- Use local decision models when beneficial, but **never require Jev** or a GPU to operate. Do not call a large LLM for every move.
- Assess legality, invariants, runtime stability, balance, progression, pacing, strategic agency, and candidate user-experience/fun signals separately. Never equate a decision model playing well with an enjoyable or bug-free game.
- Reproduce failures before reporting them as bugs, compare matched scenarios against a baseline, and distinguish proven defects from design hypotheses.
- Preserve exact game revision, scenario, seed/RNG state, policy/model version, input observations, action IDs, and environmental dependencies sufficient to replay or identify nondeterminism.
- Surface categorized findings through existing AutoDev evaluation, workspace, telemetry, and GitHub capabilities; optionally create/update issues under explicit permission and evidence gates.

**Non-goals:** General-purpose game engines; rewriting game rules inside AutoDev; treating a model-generated fun score as human enjoyment; granting playtesters authority to edit, merge, or deploy gameplay changes; inventing a new AutoDev control plane, second user-facing application, or competing orchestration policy.

## 2. Reference-project reuse and implementation decision

**Prioritize direct dependency/sidecar integration or small attributed ports of existing tested code.** Implement only what the projects demonstrably do not provide; do not reimplement their runners, decision validators, trace stores, or inference servers merely to give them AutoDev names. Pin upstream commits/versions and retain license notices and compatible tests. License the checkpoint independently from the repository.

| Existing project / concrete source | Reuse in AutoDev | What still needs work |
| --- | --- | --- |
| **[Jev Playtest Lab](https://github.com/gbesse/jev-playtest-lab)** — [`src/core.js`](https://github.com/gbesse/jev-playtest-lab/blob/main/src/core.js), [`src/lab.js`](https://github.com/gbesse/jev-playtest-lab/blob/main/src/lab.js) (MIT) | **Direct reuse/minimal TypeScript port** of observation/action validation, state/revision checks, confidence gating, repeated-action loop guard, and JSONL decisions. Engine retains execution authority. | Glue to AutoDev's versioned game adapter and event schema; no separate lab service. |
| **[jev-arcade](https://github.com/CankatSarac/jev-arcade)** — [runner](https://github.com/CankatSarac/jev-arcade/blob/main/src/jev_arcade/harness/runner.py), [recorder](https://github.com/CankatSarac/jev-arcade/blob/main/src/jev_arcade/harness/recorder.py), [analysis](https://github.com/CankatSarac/jev-arcade/blob/main/src/jev_arcade/analysis.py), [bench](https://github.com/CankatSarac/jev-arcade/blob/main/src/jev_arcade/bench.py) (MIT) | **Reuse algorithms/tests or call Python sidecar** for seeded runs, recorded episodes, replay calibration, per-move consequences, random/heuristic comparisons and confidence buckets. | Game-neutral evidence schema/cohort summaries. Existing heuristic agreement is not an authoritative quality judgment. |
| **[JevHarness](https://github.com/TianyuCodings/JevHarness)** — [`auto_jev/reflection.py`](https://github.com/TianyuCodings/JevHarness/blob/main/auto_jev/reflection.py), [`evolution.py`](https://github.com/TianyuCodings/JevHarness/blob/main/auto_jev/evolution.py), [evaluation guidance](https://github.com/TianyuCodings/JevHarness/blob/main/skills/jev-harness/references/evaluation.md) | **External integration if license/API permit; otherwise adapt concepts only:** complete-trajectory feedback, lossless archived evidence, policy improvement/freeze and holdout discipline. | Its LLM reflection **optimizes decision policies**, not gameplay fun/design. AutoDev needs a distinct gameplay-quality critic. No direct code copying before license confirmation. |
| **[NanoJev](https://github.com/TianyuCodings/NanoJev)** — [replay verifier](https://github.com/TianyuCodings/NanoJev/blob/main/scripts/replay_unified_episodes.py) (MIT repository) | **Run checkpoint/inference as optional local Python process**, reuse strict replay-comparison approach and provenance checks. | Adapter between chosen model's decisions and legal action IDs; benchmark against heuristics; verify model weights/compute constraints. |
| **[PlayJev](https://github.com/OmniJev/PlayJev)** — [`playjev/env.py`](https://github.com/OmniJev/PlayJev/blob/main/playjev/env.py), [`play.py`](https://github.com/OmniJev/PlayJev/blob/main/playjev/play.py), [`bench.py`](https://github.com/OmniJev/PlayJev/blob/main/playjev/bench.py) (Apache-2.0) | **Optional existing Python/Playwright backend**: parallel browser pages, synchronized screenshots/actions, local/remote visual policies, episode outcome capture. | Target game provides hooks; existing demos cannot automatically play arbitrary games or critically evaluate visuals. |
| **[jev-plays-balatro](https://github.com/IgorWarzocha/jev-plays-balatro)** — [decision controller](https://github.com/IgorWarzocha/jev-plays-balatro/blob/main/jev_balatro/decisions.py), [knowledge evaluations](https://github.com/IgorWarzocha/jev-plays-balatro/tree/main/evaluation) | **Strategy design reference until licensing verified:** long-horizon planner vs short-horizon tactical decisions, explicit rule descriptions. | Generic adapter/policy needs to implement only the game's actual planning horizon. Explicitly test model misconceptions rather than assuming it knows the rules. |

**Implementation rule:** Before writing any feature, document which upstream file/API already implements it, whether to consume it unchanged, run it as an optional sidecar, make a small tested attributed extraction/port, or write a genuinely missing capability. Avoid installing full game demos, GPU training stacks or Python runtimes into AutoDev's TypeScript core. Maintain one canonical AutoDev coordinator, not a copy of every reference framework.

**Known custom gaps:** A game-quality **session critic** (distinct from JevHarness policy reflection), model-ready evidence selection and grounded structured hypotheses, cross-session pattern synthesis, generic counterfactual experiment orchestration and GitHub triage. Reuse AutoDev's existing LLM/provider routing, orchestration skill, evaluation repository, OpenLIT telemetry and GitHub workflows for these rather than creating another platform.

## 3. Architecture and ownership

~~~
Existing AutoDev orchestrator
  -> target-owned game adapter + decision policy (Jev/NanoJev/heuristic/PlayJev)
  -> recorded structured state/action/event timeline + optional synchronized frames
  -> deterministic per-turn/session evaluator (facts and anomaly flags)
  -> bounded session evidence packet -> independent reasoning-LLM gameplay critic
  -> matched-seed aggregate statistics + cross-session LLM synthesis
  -> targeted replay / counterfactual alternatives / independent validation
  -> evidence-backed Evaluations findings + permission-gated GitHub issues
~~~

**Do not let the player evaluate itself.** A Jev-style model selects actions. Engine-owned evaluators measure outcomes and invariants. A stronger reasoning LLM separately critiques agency, tension, pacing, fairness, clarity and possible player friction; it proposes testable hypotheses. Independent replay and statistical checks establish which claims hold. The root makes the final issue/validation decision.

- **Core:** versioned game-independent observation/decision, event, evidence packet, rubric, critic result and finding contracts.
- **Runtime:** bounded runner, upstream adapters, policy selection, event capture, evidence selector, critic invocation using existing model routing, cohorts and counterfactual verification.
- **Data:** existing evaluation history plus indexed episode summaries, immutable bounded raw traces, clips/screenshots and provenance links.
- **Agents/RuleSync:** read-only `playtester` role for gameplay; reusable playtesting skill for the **separate analyst/critic** delegation (existing `smart` capability is sufficient initially) and independent `validator`. Keep existing orchestration authoritative.
- **Console:** show runs, critique, dimension scoring, evidence windows and comparisons under existing **Evaluations**; link Usage/OpenLIT, Workspaces and GitHub without adding a new top-level resource.
- **Target game:** actual engine, legal actions, player-visible state, event labels, authoritative rules/outcomes/invariants, scenarios and game-quality rubric.

Likely implementation boundaries, not created in this documentation-only PR:

~~~
core/src/playtesting/
runtime/src/playtesting/
data/src/playtesting/
agents/roles/playtester.toml
agents/prompts/roles/playtester.md
.rulesync/skills/playtesting/SKILL.md
console/src/features/evaluations/  # current resource
~~~

Never implement a separate backend, evaluator framework, LLM router or dashboard when the existing AutoDev module can own the behavior.

## 4. Versioned game adapter contract

AutoDev must not know what a card, car, enemy, lap, hand, inventory, or level means. A target-owned adapter provides a narrow process boundary (initially **stdio JSONL**; authenticated HTTP is optional for remote engines):

| Operation | Contract |
| --- | --- |
| **capabilities** | Protocol version, headless/visual support, scenarios, observation/action schemas, replay support, engine build and deterministic guarantees |
| **reset(seed, scenario)** | Start a fresh isolated episode; return session ID, initial state revision, and RNG provenance |
| **observe()** | Return the currently **player-visible** structured observation, optional frame, turn context, and revision |
| **legalActions()** | Return stable action IDs and optional descriptions/features for the observation revision |
| **step(actionId, expectedRevision)** | Atomically validate and execute an allowed move in the real engine; reject stale/illegal actions; return event(s), next revision and terminal status |
| **outcome()** | Return authoritative game result and explicitly defined metrics/rewards |
| **snapshot()/replay(trace)** | Export or reconstruct game state and verify transition hashes; declare unavailable capabilities rather than manufacturing reproducibility |
| **fork(snapshot, alternativeAction, rngPolicy)** *(optional)* | Execute legal counterfactual continuations with declared RNG/hidden-information constraints |
| **captureEvents()/captureFrame()** *(optional)* | Timestamp/index significant events, screenshots or clips against exact steps; absence means no visual conclusions |
| **invariants()** | Declare game-specific machine-checkable properties and their witness/diagnostic output, where supported |

All operations need timeouts, clear error categories, bounded payload sizes, and strict schema/version validation. Policy input is restricted to player-visible state; privileged debug state may be retained separately for root-cause evidence but **must not leak into gameplay policy observations**. Policies propose actions; only the adapter executes them. Autopilot never bypasses a legality/revision check. No uncontrolled execution of arbitrary commands obtained from model responses or untrusted game data.

**Episode identity:** workspace/repository, git SHA, game build, scenario/config hash, initial seed, deterministic RNG state/version, policy/model/checkpoint version, tool/runtime versions, and protocol version. For nondeterministic engines, label episodes as trace-replayable or non-reproducible instead of claiming exact seed replay.

## 5. Target-owned configuration example

A game can opt in with a checked-in `playtest.config.json`. This illustrates a **proposed schema**, not an existing command/API:

~~~json
{
  "schemaVersion": 1,
  "adapter": {
    "transport": "stdio-jsonl",
    "command": ["pnpm", "run", "playtest:adapter"]
  },
  "modes": ["headless", "browser"],
  "scenarios": ["default", "high-heat", "progression"],
  "policies": ["random", "heuristic", "nanojev", "aggressive", "conservative", "economist"],
  "budget": {
    "episodes": 1000,
    "maxStepsPerEpisode": 500,
    "workers": 8,
    "wallTimeMinutes": 60
  },
  "analysis": {
    "rubric": "playtest.rubric.json",
    "critic": "auto",
    "maxReviewedSessions": 40,
    "visualCapture": "on-anomaly",
    "counterfactuals": "targeted"
  },
  "reporting": {
    "githubIssues": "review"
  }
}
~~~

AutoDev owns schema validation, worker/critic budgets, inference routing, artifacts and issue policy. Game configuration chooses scenarios, policies, metric hooks and an optional **game-specific critic rubric** (design intentions, target player, what counts as a meaningful decision, pacing goals) **without embedding game logic in AutoDev**. The example `auto` critic is resolved through current AutoDev model routing, not a new provider. Adapter commands require an explicit approved workspace/runner boundary; repository-supplied commands must not silently acquire broader host privileges or credentials. Support non-Node engines via the same protocol.

For RacingGame, example scenarios are Heat-heavy decisions, qualifying vs. skipping, double DNF, pit strategy and team coordination. These are illustrative *game-owned* definitions, not generic AutoDev concepts.

## 6. Agent/policy population and training

Keep **agent role**, **player policy**, and **inference backend** distinct:

- **Playtester (AutoDev role):** Runs assigned gameplay sessions and records their results. A **separate, reasoning-capable gameplay critic** reviews selected completed sessions and an independent validator checks consequential findings. Read-only for source code; isolated artifact writes only. Cannot fix issues, commit, push or open issues without a separately authorized reporting step.
- **Policies (per episode):** Random/fuzz, simple beginner, conservative, aggressive, economy-oriented, team-focused, adaptive expert and deliberately fallible/stress policies. A persona can use heuristics, NanoJev, PlayJev or another backend.
- **Inference:** Pluggable scored-choice interface taking observation, legal option IDs and goal. Record full probability/confidence information when available, selected action, fallback and latency. Never assume provider confidence is calibrated.
- **Strategy author/refiner:** Optional stronger LLM periodically creates candidate feature extractors, policy prompts or strategies using training traces (JevHarness pattern); freeze accepted versions and compare on held-out seeds. It cannot rewrite evaluation rules, look at privileged state, or cherry-pick the final test set.
- **Visual policy:** Optional screenshot-based PlayJev/Playwright driver; run selected episodes against the actual rendered game to catch affordance, feedback, controls, browser errors and visual problems.

Begin with random and deterministic heuristic baselines **before** adding local neural inference. Benchmark NanoJev on RTX 3090 separately; use CPU workers for cheap high-volume simulation and GPU inference only where it improves action quality or coverage. Visual model weights are optional downloads, not AutoDev installation requirements.

For sequential card games, separate long-horizon progression planning from short-horizon tactical decisions (Balatro-inspired). For other genres, the adapter and policy should determine whether such planning is meaningful.

## 7. Observability, evaluation and experience scoring

### Session analysis and AI gameplay critic — required pipeline

The original deterministic evaluations below are necessary but **not sufficient** for the requested playtesting system. Implement this explicit analysis stage on top of them, using the referenced projects' tested recording/replay/feedback components rather than creating competing frameworks.

**1. Record the complete player-visible experience.** For each decision, save step/revision, player-visible pre-state, legal actions and meaningful alternatives, policy intent/choice/confidence/fallback, authoritative after-state, event IDs, outcome, timing, and run/seed/game/policy version. **Jev Playtest Lab** already supplies decision validation, loop detection and audit JSONL; **jev-arcade** supplies replayable episodes and per-move state comparison; **NanoJev** supplies strict replay verification. Use their tested primitives and adapters. Keep privileged game/debug state outside the decision policy. If visual testing is enabled, reuse **PlayJev**'s frame/step/browser capture for event-triggered screenshots or clips aligned to game events. Preserve full raw traces under bounded retention, not just AI summaries.

**2. Compute facts and detect interesting moments.** Before spending LLM tokens, run cheap engine-invariant checks, crash/stall/loop detectors, resource-delta and phase-timing measurements, outcome statistics and strategy comparisons. For each episode, index exceptional windows (e.g. failure, major reversal, near-miss, repeated action, sudden resource loss) **plus representative ordinary segments**. jev-arcade's [`analysis.py`](https://github.com/CankatSarac/jev-arcade/blob/main/src/jev_arcade/analysis.py) already reconstructs decisions to compare their consequences against heuristics; extend only the general result schema and game-specific metrics. A heuristic is a reference, not ground truth; model confidence does not measure fun.

**3. Build an evidence packet for a reasoning LLM.** Provide game-authored rules and intended audience/goals; player policy/skill; exact episode outcome and measured metrics; a chronological phase summary; selected decision windows with legal alternatives, explicit event/replay IDs and optional screenshots/clips. Store the **unabridged** trace separately with indexed read-on-demand. Record precisely which segments were supplied and omitted; never silently truncate away failures or normal context. **JevHarness**'s [complete-trajectory reflection and archiving](https://github.com/TianyuCodings/JevHarness/blob/main/auto_jev/reflection.py) establishes the right evidence discipline and train/holdout boundary, but reflects on **how to improve the agent's policy**, not how good the game is. The gameplay critic and its structured output contract are the small **new AutoDev-specific extension**. Use upstream trace/feedback infrastructure externally if permissions allow; do not copy unlicensed source.

**4. Ask for a session critique, not an unsupported fun verdict.** Delegate to AutoDev's existing capable LLM role **after gameplay**, at a capped frequency. Require an anchored, structured response for meaningful agency, pacing/repetition, tension/recovery, fairness/telegraphing, strategy diversity and UI feedback **only where visual evidence exists**. Every finding needs an observed fact, episode/step/event IDs, hypothesis, competing explanations, uncertainty, missing evidence, and a proposed verification experiment. Reject nonexistent citations, imagined game rules or visual judgments made from logs alone.

~~~json
{
  "category": "agency",
  "observation": "No cooling option appeared among legal actions at step 23",
  "evidence": [{"episodeId": "example-17", "step": 23, "eventId": "example-event-23"}],
  "hypothesis": "High-Heat recovery might be excessively constrained",
  "alternativeExplanations": ["Earlier safer actions may have been available"],
  "confidence": "low",
  "missingEvidence": ["Outcomes with alternative earlier decisions"],
  "proposedVerification": "Branch from an earlier snapshot and compare continuations"
}
~~~

*Illustrative schema only, not actual RacingGame results.* Source observations and LLM opinions must remain separate. LLM scores do **not** become authoritative Evaluations pass/fail results.

**5. Synthesize across sessions.** The deterministic aggregator first compares matched seeds/scenarios, player personas and skill levels, commits and metrics with sample counts/uncertainty. A **cross-session LLM analyst** then reviews *aggregates plus cited representative episodes* to identify repeated patterns, alternative causes and suggested targeted tests. Avoid drawing broad conclusions from one DNF or a bot that makes poor choices. This is new synthesis glue built on **jev-arcade's** benchmarks, **PlayJev's** episode results, and **JevHarness's** disciplined evaluation split, not another reimplementation of their trainers/runners.

**6. Verify with replay and counterfactual branches.** For high-value hypotheses, rewind via optional game-owned `fork`/snapshot, enumerate a bounded set of **legal** alternative actions, and run controlled continuations (multiple policies/seeds as needed). Ask whether plausible alternatives would have avoided the issue, differentiating player mistakes from poor affordances, unavoidable failure, or engine defects. Reuse seeded/replay primitives from **jev-arcade** and **NanoJev**. Generic branching orchestration is **custom AutoDev glue**, as none of those projects supplies general counterfactual game-quality testing. Track RNG policy, hidden-information limits and nondeterminism; if branching cannot be replayed, report **not verifiable**, not a fabricated causal result.

**7. Convert validated analysis into findings.** Independent validation checks evidence links, reproduction and statistical claims. Publish verified bugs or reviewable design hypotheses only through existing AutoDev GitHub issue gates. Never publish hundreds of near-duplicate critic opinions, and never let the critic autonomously change rewards, game rules, or source code.

**LLM cost controls:** Always-on deterministic evaluators are cheap; select only representative, novel and problematic sessions for full critique; use periodic cohort synthesis instead of critiquing every ordinary run; request visual evidence/branches only where relevant. Cache on game+trace+rubric+critic version, with explicit evaluation-budget limits and observable token/GPU costs.

**Fun/experience score:** Treat each subdimension (meaningful choices, strategic depth, tension/recovery, pacing and perceived fairness/clarity) as a separate **experimental proxy**, combining objective metrics with *cited* critic judgments. Preserve coverage/missing-data and uncertainty; an optional configurable weighted composite must be marked unvalidated until calibrated against actual human ratings. A state-only trace cannot justify visual-clarity scores, and an AI cannot directly experience a human player's enjoyment.

### Episode data

Store a compact, indexed episode summary (outcome, turns, duration, strategy, scenario, failure classifications, cost and metrics) plus content-addressed bounded artifacts (event/action JSONL, snapshots, screenshots/video/traces where appropriate). Replay artifacts must identify exact game and model revisions; cap retention and redact credentials/private data. Link OpenTelemetry spans to run, policy, workspace and issue IDs, while keeping large gameplay traces outside OTLP.

### Independent evaluation

| Finding class | Signals | Evidence/interpretation |
| --- | --- | --- |
| **Correctness/stability** | Crashes, state invariants, missing transitions, stuck turns, divergent deterministic replays | Replay, specific state/action witness and failure location; independent validator for consequential findings |
| **Balance/difficulty** | Win/survival rates, outcome distributions by archetype/track/starting state, economy curves, DNF rates | Paired seeds, agent-skill controls, sample counts, uncertainty intervals and comparison against prior version |
| **Exploits/dominant strategy** | Unexpected loops, infinite gains, one-sided actions, consistently overpowering combinations | Reproduce deliberately under multiple conditions, investigate whether policy quality explains outcome |
| **Pacing/agency** | Choice entropy, repeated action patterns, counterfactual sensitivity, event density, comeback opportunities | Interpret as gameplay **signals**, not intrinsic enjoyment |
| **UI/feedback/accessibility** | Failed navigation, repeated mistaken actions, unresolved feedback, console errors, screenshots/video | Browser trace plus reproducible steps; verify rendered experience separately |

**Experience score:** Provide a configurable experimental 0–100 composite over meaningful choices/agency, strategic diversity, tension/comeback potential, pacing/repetition and perceived fairness/control. A suggested starting weight profile is 30/20/20/15/15 respectively, but no universal weighting or pass threshold should be canonized. Retain raw component values, confidence/missing-data flags and game-specific definitions; explain score changes. Learn/recalibrate from **human ratings** when available. An LLM critique can generate actionable hypotheses, **not certify that a game is fun**.

Use common-random-number/matched-seed comparisons when feasible; include confidence intervals and adequate samples, avoid significance claims from tiny batches, monitor multiple-comparison effects and show whether agent capability itself changed. Define explicit pass/fail only when an authoritative evaluator supplies a verdict; absent metrics/verdicts remain **Not observed** per existing Evaluations policy.

## 8. Findings, replay, and GitHub issue gate

Each candidate finding includes:

- **Identity:** stable fingerprint; workspace, commit, build, scenario, adapter/policy/model versions, run IDs and first/last observed.
- **Classification:** correctness, stability, balance, exploit, design/experience, accessibility/UI or performance; severity, likelihood, scope and confidence with explicit basis.
- **Evidence:** deterministic seed/RNG provenance, minimal action trace, replay status, invariant witness or statistical comparison (sample size, baseline, intervals), linked artifacts/traces.
- **Actionability:** observed vs expected result, reproduction commands/steps, affected behavior, hypothesis and suggested next investigation (not an unverified forced fix).
- **Lifecycle:** new -> triage -> reproduced/corroborated -> issue candidate -> published/suppressed/resolved; link existing GitHub issue and verification-after-fix runs.

Reporting pipeline:

1. Run deterministic checks and select a diverse, bounded set of session traces for **LLM gameplay critique** with cited event IDs.
2. Compare hypotheses across matched cohorts, then replay/shrink actionable failures or run targeted legal-action counterfactuals where supported.
3. Have an independent validator verify game facts, critic evidence, alternative explanations and uncertainty; separate poor AI decisions from game defects.
4. Deduplicate findings against GitHub; create/update only under explicit workspace reporting policy. **Design/fun/balance suggestions require review by default**; critical reproducible bugs may be auto-published only if configured.
5. After a fix, replay original seeds and relevant controls, then record resolved/persistent/regressed results; never rely on model assertions.

Rate-limit, deduplicate, and batch issue creation. Do not create one issue per failing episode or treat policy mistakes as engine defects.

## 9. AutoDev lifecycle, Console and integration

- **Role:** register `playtester` as a capability; use existing orchestration skill for root delegation, parallel workers, validation, retries and final gates. Do not clone JevHarness's agent orchestrator into AutoDev.
- **Evaluation ownership:** map runs, objective metrics, critic reports with cited moments, cross-session comparisons, counterfactuals and explicit evaluator verdicts into existing Evaluations history and trace linkage, preserving null/unknown semantics.
- **Console:** propose a Playtests grouping/tab within existing Evaluations with run history, timeline and selected evidence windows, critic rubric scores/uncertainty, cohort comparisons, counterfactual outcomes, replay artifacts and linked issue status. Any actual UI/navigation/control changes must update the canonical Console target-state doc in the implementation PR.
- **Workspaces:** enablement, allowed adapter/runner, model capabilities, resource budget, retention and GitHub publication authority are scoped to the target workspace through canonical AutoDev configuration.
- **OpenLIT:** standard OTLP traces, metrics, GenAI inference cost/latency and worker health; do not create a second observability backend or overload traces with gameplay video.
- **Security:** allowlisted sandboxed game runners; no secrets sent to game/model logs; rate/time/memory/GPU budgets; explicit permissions for issue writes; preserve readable/replayable evidence and failure transparency.
- **No source changes:** playtest runners and analyst agents should produce artifacts/findings, not secretly patch gameplay, change rewards or merge PRs. A separate authorized development task may use reported evidence.

## 10. Reuse-first delivery slices and acceptance gates

| Phase | Concrete reuse and limited customization | Acceptance evidence |
| --- | --- | --- |
| **1. Recorder and runner** | Reuse Jev Playtest Lab action/revision guards and jev-arcade seeded runner/replay/baselines; implement only generic game adapter bridge | Real episodes, legal actions, full indexed traces, reproducible result/seed where guaranteed |
| **2. Analyzer and critic MVP** | Reuse jev-arcade consequence analysis and JevHarness full-trajectory/evaluation discipline; add **AutoDev-specific gameplay critic prompt/schema + evidence packet** | Full run -> deterministic facts -> event-cited reasoning critique -> verifiable hypothesis; malformed citations rejected |
| **3. Local AI/player policies** | Integrate NanoJev via optional sidecar; use JevHarness evolution externally if allowed, and existing policies as controls | Measured skill, action validity, latency, throughput, fallback; held-out seed comparison |
| **4. Systemic findings and proof** | Reuse existing Evaluations/GitHub pipelines, benchmarks and replay; add cohort critic, branching coordinator and deduplication | Paired runs support a repeated problem; alternative action testing distinguishes avoidable loss; one verified actionable issue |
| **5. Visual critique and calibration** | Integrate PlayJev's Playwright/frame capture as optional backend; connect captured clips to multimodal critic; collect human scores | UI findings cite actual frames; unobserved visuals omitted; fun proxies clearly labeled and eventually calibrated |
| **6. Portability** | Run a second, mechanically different game with same AutoDev infrastructure | Only game adapter/scenarios/rubric change; no gameplay logic leaks into AutoDev |

**First milestone:** at least 1,000 headless episodes (later 10,000), two independent player policies, deterministic objective metrics, **selected complete-session AI critiques with evidence IDs**, matched-cohort summary, and one reproduced or explicitly unverified hypothesis. Measure performance and critic costs empirically; no assumptions of instant throughput.

## 11. Decisions to resolve during implementation

- Which adapter transports and engines to support in v1 beyond stdio JSONL, and where the game runner sandbox lives.
- Which local NanoJev checkpoint, inference server/API and model-weight license pass quality and operational testing; whether a non-model heuristic wins on cost/performance.
- Artifact storage and retention quotas for locally launched runs vs CI; handling intentional game nondeterminism and performance-test noise.
- Which evaluators have game-owned pass/fail thresholds, which offer only proxy scores, how critic evidence is sampled without selection bias, and how human ratings can calibrate fun measures.
- How each engine supports checkpoints, alternate legal actions, RNG continuity and hidden-information limits for counterfactual claims.
- Exactly which upstream code is bundled, used externally, extracted with attribution or not copied due to licensing/API limitations; how to avoid competing frameworks.
- What evidence permits deterministic bug publication versus required review for balance/design/fun findings.

## 12. References

- [Jev Playtest Lab](https://github.com/gbesse/jev-playtest-lab)
- [jev-arcade](https://github.com/CankatSarac/jev-arcade)
- [JevHarness](https://github.com/TianyuCodings/JevHarness)
- [NanoJev](https://github.com/TianyuCodings/NanoJev)
- [PlayJev](https://github.com/OmniJev/PlayJev)
- [jev-plays-balatro](https://github.com/IgorWarzocha/jev-plays-balatro)
- [AutoDev orchestration skill](../.rulesync/skills/orchestration/SKILL.md)
- [AutoDev Console Target State](autodev-console-target-state.md)

**Scope of this proposal PR:** exactly this one Markdown document. Implementation, configuration, skills, runner, UI and canonical-target updates require subsequent independently validated PRs.
