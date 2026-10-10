# Generic Autonomous Game Playtesting — Target-State Proposal

> **Status:** Proposal only; this document does not implement the system or change existing runtime/Console behavior.
>
> **Ownership:** A focused design for AutoDev's reusable playtesting capability. [AutoDev Console Target State](autodev-console-target-state.md) remains authoritative for Console navigation, RuleSync configuration ownership, workspace architecture, evaluation semantics, OpenLIT integration, and UI requirements. Implementation PRs must update that canonical document when they alter those contracts.
>
> **Goal:** Repeatedly play games through inexpensive, interchangeable agents; find and reproduce bugs, strategy exploits, balance regressions, usability problems, and candidates for gameplay improvement; produce auditable evaluations and actionable GitHub findings. Keep all generic orchestration and analysis in AutoDev; keep mechanics in game-owned adapters/configuration.

## 1. Outcomes and boundaries

- Support high-volume, seeded **headless gameplay** and lower-volume **rendered/visual gameplay** through a common episode/evidence contract.
- Exercise multiple player skill levels and strategies, including intentionally imperfect behavior; retain random and deterministic heuristic controls.
- Use local decision models when beneficial, but **never require Jev** or a GPU to operate. Do not call a large LLM for every move.
- Assess legality, invariants, runtime stability, balance, progression, pacing, strategic agency, and candidate user-experience/fun signals separately.
- Reproduce failures before reporting them as bugs, compare matched scenarios against a baseline, and distinguish proven defects from design hypotheses.
- Preserve exact game revision, scenario, seed/RNG state, policy/model version, input observations, action IDs, and environmental dependencies sufficient to replay or identify nondeterminism.
- Surface categorized findings through existing AutoDev evaluation, workspace, telemetry, and GitHub capabilities; optionally create/update issues under explicit permission and evidence gates.

**Non-goals:** General-purpose game engines; rewriting game rules inside AutoDev; treating a model-generated fun score as human enjoyment; granting playtesters authority to edit, merge, or deploy gameplay changes; inventing a new AutoDev control plane, second user-facing application, or competing orchestration policy.

## 2. Reference-project reuse

These are reference implementations, **not** a requirement to vendor six repositories. Prefer narrow reuse or ports with pinned versions, verified APIs, tests, and license review.

| Reference | Adopt/adapt | Integration decision and caution |
| --- | --- | --- |
| [Jev Playtest Lab](https://github.com/gbesse/jev-playtest-lab) | Game-neutral observation, legal action, revision and goal contract; shadow/assist/autopilot modes; replay audit; stale-action rejection | **Primary protocol inspiration**. Reimplement the small boundary in native TypeScript, retain engine execution authority. MIT. |
| [jev-arcade](https://github.com/CankatSarac/jev-arcade) | Seeded episodes, deterministic replay, random/heuristic comparisons, calibration and confidence-gated fallback | **Primary benchmarking inspiration**. Reuse patterns or small MIT-licensed pieces, not the whole service. Its reported tiny samples are demonstrations, not balance proof. |
| [JevHarness](https://github.com/TianyuCodings/JevHarness) | Separate LLM-authored strategy/harness development from cheap runtime decisions; full trajectories; optional reward-driven policy refinement | **Adapt architecture**. Keep scorer and hidden task state outside the authored policy; validate on held-out seeds. Do not copy code until licensing is verified. |
| [NanoJev](https://github.com/TianyuCodings/NanoJev) | Small open-weight structured state-to-choice scoring model and reproducible training/evaluation workflow | **Preferred initial local model candidate**; use behind provider-neutral inference contract and benchmark against heuristics. MIT repository license; verify model-weight terms independently. |
| [PlayJev](https://github.com/OmniJev/PlayJev) | Screenshot-to-action decisions, browser-game adapters, Playwright harness, teacher imitation and DAgger-style improvement | **Optional visual backend** for UI-facing gameplay. Apache-2.0. More resource intensive and less precise than structured-state simulation. Verify checkpoint terms. |
| [jev-plays-balatro](https://github.com/IgorWarzocha/jev-plays-balatro) | Long-horizon run planner coordinating with tactical hand/turn decisions; visible-state card-game controller | **Strategy pattern** for roguelites and resource games, not a portable runtime dependency. Verify code-reuse rights first. |

The first four are sufficient for a useful headless milestone. PlayJev enables later visual testing; the Balatro design helps turn-by-turn decisions in games such as RacingGame. Hosted TypeSafe Jev can be an optional inference provider, never the system's required backend.

## 3. Architecture and ownership

~~~
AutoDev orchestrator (existing lifecycle and delegation authority)
  -> Playtest job (workspace, revision, scenarios, policies, budget)
     -> Game adapter boundary [target game owns rules/execution]
        -> observe + legalActions -> Decision policy -> validated step
           policies: random | heuristic | local System-One | hosted Jev | LLM | learned
        -> episode/event/replay artifacts
     -> independent evaluators + matched-seed comparisons
     -> replay/triage -> deduplicated, evidence-backed findings
     -> AutoDev Evaluations + OTel/OpenLIT + GitHub issue workflow
~~~

- **Core** owns versioned, engine-neutral contracts and pure validity/scoring aggregation rules.
- **Runtime** owns bounded job execution, worker scheduling, adapter transport, legal-action checks, policies, inference routing, replay verification, experiment orchestration, and evaluator invocation.
- **Data** owns storage/query adapters for episode summaries, metrics, artifacts, and issue-link provenance. Reuse existing evaluation/data plumbing where feasible.
- **Agents / RuleSync** own the concise playtester role and reusable investigation/triage skill; existing orchestration is the sole authority for delegation and lifecycle gates.
- **Console** should expose playtest evaluations within the existing **Evaluations** resource, linked to Workspaces, Usage/traces, and GitHub findings. No new top-level navigation or parallel dashboard by default.
- **Target game** owns the adapter executable, allowed observations, action semantics, deterministic simulation (if available), game invariants, score/reward meaning, human-relevant signals, and scenario definitions.

Potential layout when implemented (not part of this documentation-only PR):

~~~
core/src/playtesting/
runtime/src/playtesting/
data/src/playtesting/
agents/roles/playtester.toml
agents/prompts/roles/playtester.md
.rulesync/skills/playtesting/SKILL.md
console/src/features/evaluations/   # integrate with existing resource
~~~

Follow existing package boundaries and the single active implementation path; do not create a package or backend per role, game, model, or Console tab.

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
  "reporting": {
    "githubIssues": "review"
  }
}
~~~

AutoDev owns schema validation, worker budgets, inference backend selection, artifacts and issue policy. Game configuration chooses scenarios, policies, and scoring/invariant hooks **without embedding game logic in AutoDev**. Adapter commands require an explicit approved workspace/runner boundary; repository-supplied commands must not silently acquire broader host privileges or credentials. Support non-Node engines via the same protocol.

For RacingGame, example scenarios are Heat-heavy decisions, qualifying vs. skipping, double DNF, pit strategy and team coordination. These are illustrative *game-owned* definitions, not generic AutoDev concepts.

## 6. Agent/policy population and training

Keep **agent role**, **player policy**, and **inference backend** distinct:

- **Playtester (AutoDev role):** Runs assigned sessions, captures evidence, compares outcomes and returns bounded findings. Read-only for source code; isolated test-output/artifact writes only. Cannot fix issues, commit, push, or open issues without a separate authorized reporting step.
- **Policies (per episode):** Random/fuzz, simple beginner, conservative, aggressive, economy-oriented, team-focused, adaptive expert and deliberately fallible/stress policies. A persona can use heuristics, NanoJev, PlayJev or another backend.
- **Inference:** Pluggable scored-choice interface taking observation, legal option IDs and goal. Record full probability/confidence information when available, selected action, fallback and latency. Never assume provider confidence is calibrated.
- **Strategy author/refiner:** Optional stronger LLM periodically creates candidate feature extractors, policy prompts or strategies using training traces (JevHarness pattern); freeze accepted versions and compare on held-out seeds. It cannot rewrite evaluation rules, look at privileged state, or cherry-pick the final test set.
- **Visual policy:** Optional screenshot-based PlayJev/Playwright driver; run selected episodes against the actual rendered game to catch affordance, feedback, controls, browser errors and visual problems.

Begin with random and deterministic heuristic baselines **before** adding local neural inference. Benchmark NanoJev on RTX 3090 separately; use CPU workers for cheap high-volume simulation and GPU inference only where it improves action quality or coverage. Visual model weights are optional downloads, not AutoDev installation requirements.

For sequential card games, separate long-horizon progression planning from short-horizon tactical decisions (Balatro-inspired). For other genres, the adapter and policy should determine whether such planning is meaningful.

## 7. Observability, evaluation and experience scoring

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

1. Detect anomalies via deterministic checks and statistical evaluators before requesting expensive LLM interpretation.
2. Re-run suspicious traces; shrink action sequences when possible; compare against current baseline and check whether equivalent findings or GitHub issues already exist.
3. Have an independent validator examine consequential findings and artifacts. Keep policy/model speculation separate from authoritative engine facts.
4. Create/update an issue only under explicit workspace reporting policy and evidence thresholds. Default: **review required for subjective/balance findings**; deterministic, reproducible critical bugs may be eligible for automated publication if configured.
5. After a fix, replay exact scenarios and record resolved/persistent/regressed status; do not mark an issue fixed from policy assertions alone.

Rate-limit, deduplicate, and batch issue creation. Do not create one issue per failing episode or treat policy mistakes as engine defects.

## 9. AutoDev lifecycle, Console and integration

- **Role:** register `playtester` as a capability; use existing orchestration skill for root delegation, parallel workers, validation, retries and final gates. Do not clone JevHarness's agent orchestrator into AutoDev.
- **Evaluation ownership:** map playtest runs and explicit evaluator verdicts into existing Evaluations history and trace linkage, preserving the current null/unknown semantics.
- **Console:** propose a Playtests grouping/tab within existing Evaluations with run history, strategy/seed filters, baseline comparison, finding detail, replay artifact links, confidence and issue state. Any actual UI/navigation/control changes must update the canonical Console target-state doc in the implementation PR.
- **Workspaces:** enablement, allowed adapter/runner, model capabilities, resource budget, retention and GitHub publication authority are scoped to the target workspace through canonical AutoDev configuration.
- **OpenLIT:** standard OTLP traces, metrics, GenAI inference cost/latency and worker health; do not create a second observability backend or overload traces with gameplay video.
- **Security:** allowlisted sandboxed game runners; no secrets sent to game/model logs; rate/time/memory/GPU budgets; explicit permissions for issue writes; preserve readable/replayable evidence and failure transparency.
- **No source changes:** playtest runners and analyst agents should produce artifacts/findings, not secretly patch gameplay, change rewards or merge PRs. A separate authorized development task may use reported evidence.

## 10. Delivery slices and acceptance gates

| Phase | Concrete delivery | Acceptance evidence |
| --- | --- | --- |
| **1. Headless foundation** | Protocol/schema, isolated runner, random/heuristic policies, seeded batches, action legality and replay artifacts | Real target game completes batches; repeated runs reproduce identical outcomes where claimed; malformed/stale actions fail closed |
| **2. Local decision model** | Pluggable NanoJev backend, confidence/fallback tracing, benchmark harness | Same-scenario comparisons against random/heuristic; measured throughput, VRAM, latency, accuracy, legal-action adherence |
| **3. Evaluators/reporting** | Game invariant hooks, aggregate metrics, regression statistics, deduplication, verified finding format | A seeded defect becomes one reproducible candidate; false positive/policy mistake remains distinct; no invented pass verdict |
| **4. Adaptive strategies/experience** | Player cohorts, JevHarness-inspired offline strategy refinement, pacing/agency indicators, optional human calibration | Held-out comparison; objective function immutable to policy author; score components and uncertainty inspectable |
| **5. Visual testing/Console** | Optional PlayJev/Playwright adapter, screenshots/trace evidence, Evaluations integration and reviewed GitHub publication | End-to-end UI fault evidence; bounded artifacts; one complete issue lifecycle |
| **6. Portability validation** | Second game with mechanics unlike RacingGame using only its adapter/config | No game-specific logic added to AutoDev core; cross-game protocol remains unchanged or is versioned deliberately |

**First milestone:** Target at least 1,000 complete headless episodes (later 10,000) with two independent policy implementations, valid timestamps/provenance, reliable replay, baseline comparisons and at least one meaningful automatically generated report. Throughput must be measured on actual hardware, not promised in advance. A second unrelated game is required before claiming the abstraction is generic.

## 11. Decisions to resolve during implementation

- Which adapter transports and engines to support in v1 beyond stdio JSONL, and where the game runner sandbox lives.
- Which local NanoJev checkpoint, inference server/API and model-weight license pass quality and operational testing; whether a non-model heuristic wins on cost/performance.
- Artifact storage and retention quotas for locally launched runs vs CI; handling intentional game nondeterminism and performance-test noise.
- Which evaluators get normative thresholds per game, which merely surface continuous metrics, and how human fun ratings calibrate subjective measures.
- What minimum evidence permits automatic publication of a deterministic bug, versus always requiring review for design/balance findings.

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
