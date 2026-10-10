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
- Assess legality, invariants, runtime stability, balance, progression, pacing, strategic agency, **player understanding and learnability**, and candidate user-experience/fun signals separately. Never equate model skill, confidence or a win with clarity or enjoyment.
- **Actively test hypotheses**, not merely review recordings: probe what a limited-information tester expects before a decision, compare predictions with game-authoritative consequences, run matched cohorts, and investigate suspected friction with controlled follow-up experiments.
- Reproduce failures before reporting them as bugs, compare matched scenarios against a baseline, and distinguish proven defects from design hypotheses.
- Preserve exact game revision, scenario, seed/RNG state, policy/model version, input observations, action IDs, and environmental dependencies sufficient to replay or identify nondeterminism.
- Surface categorized findings through existing AutoDev evaluation, workspace, telemetry, and GitHub capabilities; optionally create/update issues under explicit permission and evidence gates.

**Non-goals:** General-purpose game engines; rewriting game rules inside AutoDev; treating a model-generated fun score as human enjoyment; granting playtesters authority to edit, merge, or deploy gameplay changes; inventing a new AutoDev control plane, second user-facing application, or competing orchestration policy.

## 2. Reference-project reuse and implementation decision

**Execute existing upstream implementations wherever compatible and useful**, rather than writing new equivalents. **The project owner has confirmed permission to use, copy and adapt JevHarness code for AutoDev.** This removes its previous licensing blocker; record the applicable license/permission conditions and preserve any required notices or attribution rather than assuming a specific license identifier. Prioritize pinned package/API integration, then the original server/CLI, then intact licensed files with upstream tests; write thin adapters only for demonstrated incompatibilities. Each selected integration must execute the actual upstream code in an end-to-end test, not merely run a detached demo. Optional or unlicensed projects must not be included to meet a reuse quota.

The six sources are [Jev Playtest Lab](https://github.com/gbesse/jev-playtest-lab), [jev-arcade](https://github.com/CankatSarac/jev-arcade), [NanoJev](https://github.com/TianyuCodings/NanoJev), [PlayJev](https://github.com/OmniJev/PlayJev), [JevHarness](https://github.com/TianyuCodings/JevHarness) and [jev-plays-balatro](https://github.com/IgorWarzocha/jev-plays-balatro). None supplies a complete AutoDev gameplay-quality critic, arbitrary-engine counterfactual runner, or human-validated fun score; implement those missing connections within the existing AutoDev runtime/evaluation architecture.


### Concrete integration manifest — dependency or entire-file reuse by default

The table above is a survey; **this table is the implementation commitment**. Every **selected integration** must have a pinned execution path, an upstream test or behavior-equivalence check, and a documented reason for any deviation; a project's example test alone is not evidence of production reuse. The SHAs are **audited starting points**, not claims of permanent compatibility. Review upstream licensing and security on upgrades. Prefer (1) install/import an existing package, (2) execute its maintained server/CLI in a pinned isolated checkout, (3) vendor **whole relevant files with their license and tests** where there is no stable public API, and only then (4) write a small isolated adapter/port if direct use demonstrably fails. Avoid vendoring huge demos, model weights or unrelated code.

| Upstream baseline and exact code/API | Default incorporation and what *actually executes* | Verified constraint / allowed customization |
| --- | --- | --- |
| **Jev Playtest Lab** [`7ca4c5f`](https://github.com/gbesse/jev-playtest-lab/tree/7ca4c5f660d3870f38c828ab7dc8168adc39f1ad): [`src/core.js`](https://github.com/gbesse/jev-playtest-lab/blob/7ca4c5f660d3870f38c828ab7dc8168adc39f1ad/src/core.js), [`src/lab.js`](https://github.com/gbesse/jev-playtest-lab/blob/7ca4c5f660d3870f38c828ab7dc8168adc39f1ad/src/lab.js), [`test/core.test.js`](https://github.com/gbesse/jev-playtest-lab/blob/7ca4c5f660d3870f38c828ab7dc8168adc39f1ad/test/core.test.js) | **Reuse intact MIT-licensed `src/core.js` and `test/core.test.js` via a verified pinned import or vendoring**. Use `observationHash` and `LoopGuard` when compatible. Reuse intact `src/lab.js` / `PlaytestLab.observe` **only in hosted-Jev-compatible policy modes**; translate its audit JSONL through an AutoDev artifact adapter rather than imposing its Jev protocol globally. | No declared npm `exports` or `main`; `buildDecisionRequest` pins `jev-1.13.0`, its 255-choice limit is provider-specific, and `parseDecision` requires a `noul` safety response. **Do not treat this hosted-Jev contract as universal**: keep unchanged logic behind the compatible provider adapter; normalize other backends separately. |
| **jev-arcade** [`e165513`](https://github.com/CankatSarac/jev-arcade/tree/e1655135b038c2d5d7f56b2854f22d5b112cb382): `jev_arcade.harness.runner.run_episode`, [recorder](https://github.com/CankatSarac/jev-arcade/blob/e1655135b038c2d5d7f56b2854f22d5b112cb382/src/jev_arcade/harness/recorder.py), [`analysis.py`](https://github.com/CankatSarac/jev-arcade/blob/e1655135b038c2d5d7f56b2854f22d5b112cb382/src/jev_arcade/analysis.py), `bench` | **Install the pinned Python package and execute its original runner/bench on compatible Python `Game` environments as a labeled reference fixture**. Use its intact MIT files/tests in production only if a target really implements that protocol without duplicate stepping; otherwise port the smallest generic algorithms with test parity. Its independent demonstration is **not** a RacingGame integration. | `run_episode` expects a Python `Game` protocol; `analysis.collect_moves` explicitly calls its own `available_games()/make_game()` registry and game-specific Tetris fields. It **cannot directly analyze an arbitrary RacingGame JSONL**. For native TypeScript games use the single AutoDev runner/adapter rather than building a second Python↔Node loop; selectively port generic replay/consequence algorithms with test parity. |
| **NanoJev** [`76fdfc9`](https://github.com/TianyuCodings/NanoJev/tree/76fdfc9ecdca45a9bcef17991a07d3041a87685a): [`scripts/serve_decisions.py`](https://github.com/TianyuCodings/NanoJev/blob/76fdfc9ecdca45a9bcef17991a07d3041a87685a/scripts/serve_decisions.py), [replay validator](https://github.com/TianyuCodings/NanoJev/blob/76fdfc9ecdca45a9bcef17991a07d3041a87685a/scripts/replay_unified_episodes.py), [published checkpoint](https://huggingface.co/C-Tianyu/NanoJev) | **Run the project's actual Python inference server**, not custom model-serving code: `python scripts/serve_decisions.py --checkpoint-dir <local> --web-root web --port 8765 --disable-native-triton`. AutoDev calls `POST /api/evaluate`; pin [checkpoint revision `unified-games-v1`](https://huggingface.co/C-Tianyu/NanoJev/tree/unified-games-v1), verify its published hashes, and include required demo `web/index.html` for this upstream server. | Current [server implementation](https://github.com/TianyuCodings/NanoJev/blob/76fdfc9ecdca45a9bcef17991a07d3041a87685a/scripts/serve_decisions.py) accepts at most 32 states, 96 questions and 256 candidate paths and runs a **single-threaded `HTTPServer`**; measure effective throughput and batching. The [replay verifier](https://github.com/TianyuCodings/NanoJev/blob/76fdfc9ecdca45a9bcef17991a07d3041a87685a/scripts/replay_unified_episodes.py) uses `unified_game_pipeline.factory`: **it replays its own simulators, not arbitrary games**. Reuse the comparison semantics but use the target-game adapter to replay other engines. Check upstream Qwen model licensing and RTX 3090 compatibility. |
| **PlayJev** [`ea3a514`](https://github.com/OmniJev/PlayJev/tree/ea3a514d2fcbc0756c36eabe052439db54544542): [`playjev/serve.py`](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/playjev/serve.py), [`env.py`](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/playjev/env.py), [`play.py`](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/playjev/play.py) | **Run the actual pinned checkout/isolated Python environment**, using `python -m playjev.serve --ckpt OmniJev/PlayJev-0.8B --port 18732` with `POST /v1/systemone` and [published checkpoint](https://huggingface.co/OmniJev/PlayJev-0.8B); pin its revision. Reuse existing `GamePage`/`VecGame` and `playjev.play` for compatible hooked browser games. | The [inference server](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/playjev/serve.py) supports image-state **`choice`**, not text-state scoring. The [browser runner](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/playjev/env.py) needs `pj.json`, `pj_hook.js` and a [virtual-clock shim](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/games/_shared/pj_shim.js); it also **mutes/blocks audio, disables GPU rendering and may resize screenshots**. This can test gameplay control, **not faithfully assess real-time audiovisual quality or small-text readability**. Use existing `browser-tester` for unmodified visual evidence. Benchmark sequential serving and isolate demo CORS on localhost. |
| **JevHarness** [`34d5c96`](https://github.com/TianyuCodings/JevHarness/tree/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5): [`runtime.py`](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/runtime.py), [`evolution.py`](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/evolution.py), [`reflection.py`](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/reflection.py), [`trace_codec.py`](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/trace_codec.py), [`storage.py`](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/storage.py), [`frozen.py`](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/frozen.py), [integration guide](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/skills/jev-harness/references/integration.md) | **Permission confirmed for direct use/copy/adaptation. Prefer importing/running the original `auto-jev` Python package in a pinned isolated environment** with a game-owned evaluator callback. If no compatible public API exists, **copy entire relevant source files and tests** rather than recreate the pipeline engine, full-trajectory reflection, lossless trace packing/storage, frozen evaluation or GEPA evolution. | Its [package manifest](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/pyproject.toml) already depends on `gepa==0.1.4`; **prefer GEPA via JevHarness** instead of parallel optimization. Build only the AutoDev game adapter/quality critic not provided upstream. Preserve the verified license/permission obligations in the upstream-use ledger without inventing a license identifier. |
| **jev-plays-balatro** [`1653680`](https://github.com/IgorWarzocha/jev-plays-balatro/tree/1653680f4be20a13a1390eeac67dc2539214c1b3): `jev_balatro/decisions.py`, `rules.py`, `runner.py` | **Blocked for direct reuse pending license/author permission** (no repository license was present at audit). Once authorized, consider importing its whole two-timescale controller only for compatible card-game policies, not as AutoDev's universal agent runtime. | A Balatro-specific mod/controller is not a game-neutral playtester. Until rights/API are resolved, the small long-horizon/tactical separation belongs in the per-game policy design without copying implementation. |

**Concrete evidence of reuse:** Each implementation PR must include an **upstream-use ledger**: upstream URL + commit/tag, specific consumed files/API/command, distribution and model-weight license, pinned install/checkout mechanism, copied-file attribution if any, adapter location, upstream tests run, AutoDev integration tests run, expected upgrade path, and exact reason for any custom implementation of overlapping capability. Require **a runtime smoke test proving the upstream component itself executed** (not merely an imported type or documentation link). Maintain compatible upstream tests verbatim where files are vendored; changes to those files are reviewable, narrowly scoped deltas. Never count “inspired by,” a copied algorithm description, or an unused dependency as implementation.

**Pragmatic minimum:** use original Jev Playtest Lab code **where the Jev-specific contract fits**, keep the jev-arcade benchmark labeled as a **reference fixture** rather than production integration, then execute the real NanoJev sidecar for structured-state play and PlayJev sidecar for supported visual play. Never impose irrelevant dependency installation to meet a reuse count. JevHarness evolution is optional until useful, but its **authorized implementation and existing GEPA dependency** should be reused directly when enabled; avoid recreating its functionality. Other sources without permission remain gated. The first vertical slice must exercise game-owned adapter → reused recorder/validator → stored episode → evaluator → analyst report; subsequent slices demonstrate model and visual sidecars end-to-end.

### Other unresolved implementation gaps and failure modes

- **Provider contract mismatch:** Jev Playtest Lab expects `choice + noul`, NanoJev has its own batched schema/limits, and PlayJev accepts images plus `choice`. Define one **capability-negotiated backend adapter** and preserve each provider's native request/response and source; never coerce unknown scores to confidence 1, silently fall back to a different player, or exceed the backend's action limit.
- **Reproducible installation and supply-chain policy:** Choose one allowlisted, hash-pinned third-party acquisition mechanism for vendored JS, Python source checkouts and model files; isolate Python/CUDA environments; keep downloaded weights/artifacts outside Git; scan dependencies; lock interpreter/CUDA versions separately from AutoDev's pnpm lock; collect SPDX/NOTICE and maintain an upgrade/test workflow.
- **Actual game instrumentation quality:** A player-visible observation must agree with what the human-facing UI revealed at that moment. Accelerated/headless PlayJev captures are not substitutes for original-resolution, real-time animation/audio/legibility evidence. Time-align frame capture, legal choices, game events and pre-action understanding probes. A simulator log alone cannot establish visual confusion; a model mismatch alone cannot establish human confusion.
- **Ground truth vs narrative:** Declare engine-owned invariants, baselines and decision thresholds per game before generating LLM critiques; freeze train/validation/test splits for learned policies. Track reviewer inter-run consistency, synthetic known-good/known-bad episodes, unsupported visual assertions, and false-positive rates, not just the number of findings.
- **Counterfactual validity and test contamination:** Snapshots must restore engine RNG and relevant hidden state; compare equivalent continuations and explicitly report when seeds diverge. Critic-generated hypotheses must not rewrite scoring criteria, train on the final holdout set, or quietly select favorable reruns.
- **Performance and budget gates:** Measure episode throughput on headless CPU, HTTP decision latency, GPU load and total critique cost. The optional local models may underperform heuristics or be incompatible with the target CUDA setup; define a tested deterministic fallback and record its use, not a claimed model success.
- **Adoption and finding usefulness:** Ship a working sample adapter, canonical game-rubric example, repeatable end-to-end fixture with a *known defect and an intentionally bad bot*, and issue-quality review criteria. Measure reproduced-bug precision, false positive rate and useful human-reviewed suggestions before scaling to 10,000 runs.

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
- **Agents/RuleSync:** two bounded, **read-only specialized roles**—`playtester` (execute and observe) and `playtest-analyst` (interpret and compare)—and two distinct conditional skills described in Section 6. The analyst can route to the existing `autodev/smart` *model tier*, but must not inherit the existing `smart` role's full-access sandbox. Reuse `validator`, `browser-tester` and the root orchestration skill; keep final gates with the root.
- **Console:** show runs, critique, dimension scoring, evidence windows and comparisons under existing **Evaluations**; link Usage/OpenLIT, Workspaces and GitHub without adding a new top-level resource.
- **Target game:** actual engine, legal actions, player-visible state, event labels, authoritative rules/outcomes/invariants, scenarios and game-quality rubric.

Likely implementation boundaries, not created in this documentation-only PR:

~~~
core/src/playtesting/
runtime/src/playtesting/
data/src/playtesting/
agents/roles/playtester.toml
agents/prompts/roles/playtester.md
agents/roles/playtest-analyst.toml
agents/prompts/roles/playtest-analyst.md
.rulesync/skills/game-playtesting/SKILL.md
.rulesync/skills/playtest-analysis/SKILL.md
.rulesync/skills/playtest-analysis/references/  # only when useful
.rulesync/mcp.jsonc              # one shared playtest tool surface
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
    "counterfactuals": "targeted",
    "understandingProbes": "sampled",
    "learningCohorts": "tracked",
    "humanCalibration": "optional"
  },
  "reporting": {
    "githubIssues": "review"
  }
}
~~~

AutoDev owns schema validation, worker/critic/probe budgets, inference routing, artifacts and issue policy. Game configuration chooses scenarios, policies, metric hooks and an optional **game-specific critic rubric** (intended player experience, audience, teaching/feedback goals, pacing, meaningful choices and deliberately punishing tradeoffs) **without embedding game logic in AutoDev**. The example `auto` critic is resolved through current AutoDev model routing, not a new provider. The optional analysis settings shown are **proposed**, subject to schema design; they do not imply existing runtime support. Human calibration requires separately provided, consented human ratings, not fabricated model responses. Adapter commands require an explicit approved workspace/runner boundary; repository-supplied commands must not silently acquire broader host privileges or credentials. Support non-Node engines via the same protocol.

For RacingGame, example scenarios are Heat-heavy decisions, qualifying vs. skipping, double DNF, pit strategy and team coordination. These are illustrative *game-owned* definitions, not generic AutoDev concepts.

## 6. Agent/policy population and training

Keep **agent role**, **player policy**, and **inference backend** distinct:

- **Playtester (AutoDev role):** Runs assigned gameplay sessions and records their results. A **separate, reasoning-capable `playtest-analyst`** reviews selected completed sessions and an independent `validator` checks consequential findings. Both specialized roles are read-only for source code and use bounded runner-generated artifacts; neither can fix issues, commit, push or open issues without a separately authorized reporting step.
- **Policies (per episode):** Random/fuzz, simple beginner, conservative, aggressive, economy-oriented, team-focused, adaptive expert and deliberately fallible/stress policies. A persona can use heuristics, NanoJev, PlayJev or another backend. **Separate player skill/knowledge from strategic preference**: aggressive is an objective, while novice/learning/expert describes information, experience and competence.
- **Inference:** Pluggable scored-choice interface taking observation, legal option IDs and goal. Record full probability/confidence information when available, selected action, fallback and latency. Never assume provider confidence is calibrated.
- **Strategy author/refiner:** Use **authorized JevHarness pipeline/evolution and full-trajectory reflection** for optional strategy generation/refinement; freeze chosen versions and compare on held-out seeds. It cannot rewrite evaluation rules, look at privileged state, or cherry-pick the final test set.
- **Visual policy:** Optional screenshot-based PlayJev/Playwright driver; run selected episodes against the actual rendered game to catch affordance, feedback, controls, browser errors and visual problems.

### Player cohorts for understanding, learning and design feedback

Do not simulate novices by merely instructing an expert model to “act dumb.” Define genuine **information/skill boundaries**, reproducible policy variants and measured competence. Test that each cohort behaves as specified before interpreting its results as evidence about players.

| Cohort | Allowed information / behavior | Primary question |
| --- | --- | --- |
| **First-time / novice** | No hidden state, no memorized walkthrough; only normal UI/tutorial and current player-visible rules, limited planning | Are the controls, available actions and consequences understandable? |
| **Learning / repeated sessions** | Same agent identity and bounded, explicit experience memory carried across multiple games; no future outcomes or evaluation answers leaked | Does the player adapt after consequences and feedback, or repeatedly misread the same mechanic? |
| **Intermediate / plausible imperfect** | Some rules understood, limited planning and bounded mistakes, calibrated to human decisions if data exists | Are varied strategies viable without expert optimization? |
| **Expert / strategic optimizer** | Strong but legal planning, access only to information real expert players could know | What exploits, dominated choices or imbalance emerge at high skill? |
| **Exploratory / stress** | Coverage-driven unusual legal actions, targeted state exploration and fuzzing | Which edges, softlocks or unexpected interactions fail? |
| **Visual-only / UI-first** | Screenshot/accessible UI actions, not engine internals or invisible labels | Can a player discover controls, warnings and feedback from presentation? |

Use **jev-arcade's** random/heuristic baselines and confidence analysis, **the actual authorized JevHarness refinement/reflection/frozen evaluation code** and its train/test discipline, **PlayJev's** visual policy environment, and the explicit rule-grounding lesson from **jev-plays-balatro**. AutoDev adds the generic cohort and memory/visibility controls, not a second policy trainer. Do not assign a human-like label or report a human-proxy difficulty result unless policy competence has been checked and its limitations stated. For a fair novice-vs-expert comparison, control scenario distributions and record what each policy actually saw.

Begin with random and deterministic heuristic baselines **before** adding local neural inference. Benchmark NanoJev on RTX 3090 separately; use CPU workers for cheap high-volume simulation and GPU inference only where it improves action quality or coverage. Visual model weights are optional downloads, not AutoDev installation requirements.

For sequential card games, separate long-horizon progression planning from short-horizon tactical decisions (Balatro-inspired). For other genres, the adapter and policy should determine whether such planning is meaningful.

### Exact AutoDev additions: agents, skills, tools and configuration

**Implement these named components—not just a generic instruction to 'analyze a playtest'.** The roles execute procedures and interpret evidence; deterministic tools enforce schemas, scoring calculations, comparisons, isolation and issue gates. Keep the existing orchestrator as the only scheduler/delegator and do not create a separate mini-agent framework.

| Proposed addition | Canonical source / integration | Required responsibility |
| --- | --- | --- |
| **New agent: `playtester`** | `agents/roles/playtester.toml` + `agents/prompts/roles/playtester.md`; register through the existing role/config projection | Run bounded, isolated sessions; choose a configured player policy; verify adapter capabilities; capture exact decisions/events/frames; return run IDs and observed failures. Never invent game outcomes or critique its own play. |
| **New agent: `playtest-analyst`** | `agents/roles/playtest-analyst.toml` + `agents/prompts/roles/playtest-analyst.md`; may use existing `autodev/smart` model routing with a **read-only sandbox** | Retrieve recorded evidence, inspect experience against the game-authored rubric, score supported dimensions, compare sessions, identify confounders and produce actionable, falsifiable hypotheses. Cannot modify gameplay, rewrite metrics, run unapproved experiments or publish issues. |
| **New skill: `game-playtesting`** | `.rulesync/skills/game-playtesting/SKILL.md` | Trigger when asked to **execute/play/simulate a game**. Brief workflow: preflight adapter, establish seed/cohort/policy/limits, run, preserve authoritative trace/replay, report completeness/failures and hand off evidence IDs. It does **not** contain analysis or GitHub publication policy. |
| **New skill: `playtest-analysis`** | `.rulesync/skills/playtest-analysis/SKILL.md` with optional `references/session-review.md`, `references/scoring.md`, `references/comparisons.md` | Trigger on **reviewing, interpreting, scoring, comparing, diagnosing or verifying a recorded gameplay session**. Own the precise procedure and output/evidence standards below, including session critique, learning/clarity, fun proxies, cohort comparison and experiment design. No duplicate orchestration rules. |
| **Extend existing orchestration** | `.rulesync/skills/orchestration/SKILL.md` | Document when the root delegates gameplay to `playtester`, criticism to `playtest-analyst`, independent evidence verification to existing `validator`, and optional real-UI checks to `browser-tester`. Root owns publish/approval decisions. |
| **One shared playtesting tool surface** | Runtime handlers exposed via RuleSync-owned `.rulesync/mcp.jsonc` and existing MCP launcher/tool filters; optional `pnpm autodev -- playtest ...` CLI projection | Narrow, authorized structured access to run jobs, read episode windows, retrieve evidence, compute aggregates, compare cohorts, branch/replay scenarios, and write validated review artifacts; **not** raw shell access to games from a critic. |
| **Core/data and Console integration** | `core/src/playtesting/`, `runtime/src/playtesting/`, `data/src/playtesting/`, existing `console/src/features/evaluations/` | Versioned episode/rubric/review/experiment schemas; bounded artifact storage and replay provenance; measurable comparisons and optional human feedback. Avoid second dashboard, scorer, inference router or data backend. |
| **Target-owned inputs** | Game adapter + `playtest.config.json` + optional `playtest.rubric.json` in each target repo | Explain controls, mechanics, intended experience, warnings, observable consequences, expected difficulty curves, authoritative invariants, measured metrics and optional human rating questions. No RacingGame-specific assumptions in generic AutoDev skills. |

**Agent access:** `playtester` gets only the approved playtest runner and constrained artifact/result tools, not code-write/GitHub issue privileges. `playtest-analyst` gets evidence **read** and review **submit** functions plus model inference, not game-step/code-edit/issue-write operations. Use a separate read-only analyst role because the current `smart` role is configured with broad workspace access. The existing `validator` receives source-independent evidence to check (not a preconceived critic verdict); `browser-tester` keeps its existing Playwright-only policy for UI validation. Role configuration must follow AutoDev's canonical RuleSync/model-role ownership and regenerate provider projections, not introduce a fifth fixed provider-model tier. All tool permissions and sandbox limitations need executable tests, not just prompt assertions.

**Skill design:** Follow the existing [writing-agent-skills](../.rulesync/skills/writing-agent-skills/SKILL.md) guidance: each skill has a specific trigger, required inputs/outputs, safety boundaries, concise steps and behavior tests. Keep detailed criteria in shallow references only where they improve discoverability. Test positive and negative triggers (e.g. “play ten episodes” should load execution, “analyze this existing trace” should load analysis, “fix this code” should load neither by default) and baseline/with-skill performance; avoid a third overlapping `gameplay-critic` skill.

### Required `playtest-analysis` skill: how to read and interpret a session

This **normative procedure** must be translated into the actual skill and tested when implemented. It is not enough to ask a model “Was it fun?” or to summarize the episode's ending.

1. **Verify and read the source:** Check game/adapter/policy/rubric hashes, run completeness, timeline revisions, replay validation, visible-vs-privileged state, event/frame index and coverage. Retrieve a chronological overview of phase changes, decisions, resources and result. If state or frames are unavailable, name the missing evidence instead of filling it in.
2. **Reconstruct decisions in context:** For each sampled key moment, inspect **before-state, player-visible rules/alerts, legal alternatives, chosen action, stated intention or pre-action prediction (if actually collected), and authoritative after-state**. Trace how prior choices constrain later ones; do not infer confusion solely from a bad result.
3. **Separate observations from interpretations:** Deterministic evaluators establish *what happened*. The critic suggests *why it may be a problem*. Compare predicted-vs-actual outcomes, repeated ineffective actions, limited viable alternatives, warning visibility, teachability and learnability against the **target game's goals**, not universal norms.
4. **Evaluate both interesting and routine play:** Sample abnormal moments **and** representative ordinary phases to avoid selection bias. Distinguish novice learning failure, strong-policy strategic dominance, bad AI calibration, intended difficulty and actual usability defects. Ask for additional windows/frames through bounded tools if evidence is insufficient.
5. **Score dimensions only where supported:** Produce separately evidenced scores or `null` for agency, depth/strategy, pacing/repetition, tension/recovery and clarity/fairness. Record score anchors, metric/source, coverage, uncertainty, critic rationale and applicability; never substitute model confidence or win rate for fun.
6. **Compare when necessary:** Use code-computed aggregates (matched seeds, comparable policy skill, sample counts and uncertainty) before explaining group patterns. Distinguish change in player skill from change in game design. Single sessions cannot establish a systemic trend.
7. **Propose discriminating experiments:** For each high-value concern list competing causes, a minimal test (pre-action comprehension probe, same-state alternative, counterfactual branch, repeated learner, game-owned UI A/B), metric, controls, budget and what would *refute* the theory. Request execution via the root, not the analyst's own permissions.
8. **Publish an evidence-linked review artifact:** Separate verified bug vs statistically supported regression vs *unverified game-design hypothesis*; include event/frame/replay locators and observations, uncertainty, reproducibility, priority and proposed next investigation. Do not produce a GitHub issue directly.

**Required report sections:** provenance/coverage, chronological episode summary, authoritative metrics, scored experience dimensions, evidence-linked observations, alternative explanations, cross-session context (if available), testable hypotheses/experiments, decision on evidence status (`verified`/`corroborated`/`hypothesis`/`not observed`), and suggested follow-up. A review without evidence locators is **invalid**, not a successful empty report.

### Scoring rubric and interpretation rules

The game provides *what good gameplay means* and which mechanics are intentionally risky/repetitive. AutoDev supplies general **score semantics** and evidence validation, not RacingGame-specific weights. For a provisional rubric, use **0–4 ordinal anchors**, per dimension:

| Score | Required evidence-based interpretation |
| --- | --- |
| `0` | Strong repeated evidence the dimension fails its game-authored intent under measured conditions |
| `1` | Multiple material problems with limited counterevidence |
| `2` | Mixed/uncertain experience: both supportive and adverse observations |
| `3` | Mostly meets the stated intent with some localized concerns |
| `4` | Strong, replicated evidence the intent is met under tested conditions |
| `null` | **Not observed / insufficient or inapplicable evidence**; must include a reason |

Anchors express **ordinal quality of evidence against intended goals**, not a measurement of human enjoyment. Require named metrics and events underpinning each judgment; use uncertainty/coverage separately, not as an arbitrary substitute for evidence. For example, `agency=1` requires verified limited *competitive* options, not just a low legal-action count; `clarity=1` needs player-visible UI or comprehension evidence, not a structured state log; `tension=4` cannot follow solely from a large lead change. Evaluators compute quantitative signals (e.g. decision diversity, regret proxies when alternatives can be simulated, repeat frequency, transition/warning observability, learning curves) with named denominator/scenario and known baseline. The critic explains possible design significance; it does **not** silently modify those metrics. Prefer retaining separate sub-scores and time/phase segmentation. A weighted 0–100 *experimental enjoyment proxy* is optional only when configured weights, calibration/coverage status, and human-rating limitations are displayed; never convert missing dimensions to zero or silently renormalize.

**Example of interpretation (hypothetical):** At step 14, an aggressive RacingGame policy chooses an action at high Heat, predicts that both cars survive, then sees double DNF. This establishes only a forecast mismatch for that model; it could reflect ambiguous warning, weak knowledge, or intentional danger. Check what the player could see, look at the prior safer choices, compare independently initialized novice/visual observers, and branch the earlier state under controlled RNG. Report clarity or unfairness concerns only when the corroborating evidence actually exists.

### Comparing sessions and deciding what matters

`playtest-analysis` must support **single-session critique**, **matched cohort comparison**, and **before/after regression review** with the same evidence schema.

| Comparison | Controlled dimensions | What to compute and report |
| --- | --- | --- |
| Same state, different legal choice | State/revision, known information, replayable RNG and continuation policy | Changes in immediate consequences, feasible escape routes and eventual outcome; label causal limits |
| Novice vs expert/learning policy | Scenario/seed distribution, visibility, model/checkpoint and player skill definition | Misunderstanding rate, repeat mistakes, survival/completion, learner improvement across attempts; avoid blaming game for weaker policy |
| Aggressive vs conservative/economic | Matched scenario/seed, games played, equal skill/compute where possible | Outcome differences and confidence intervals, risk/reward, policy selection/fallback frequency; avoid treating a poor strategy as broken mechanics |
| Previous vs current build | Comparable config, action/rubric contracts, policy versions, environment, matched seeds | Changes in bug frequency, choice diversity, phase durations, calibrated sub-scores, uncertainty and detected regressions |

Require **cohort sizes/denominators, sampling method, policy identity, missing/invalid runs, measured effect and uncertainty** in every comparison. Use paired differences/intervals when seeds match; when they do not, label comparison observational and expose confounders. Do not claim significance from a single replay or from repeated correlated episodes; avoid metric fishing and post-hoc thresholds. The LLM must cite the deterministic comparison output and representative trace windows rather than perform arithmetic from a wall of logs.

### Structured inputs/outputs and MCP/CLI tool contracts

**Versioned artifacts** (proposed, not implemented):

- `PlaytestEpisode`: revision, scenario/seed and RNG provenance, policy identity, action/observation/event timeline, phase index, outcomes, replay/visual links and completeness.
- `PlaytestEvidencePacket`: rubric/version, audience and intent, metrics/baselines, selected windows and coverage, visible evidence refs, critic input provenance; full trace remains fetchable.
- `PlaytestSessionReview`: version, episode/rubric/critic identity, observed-vs-inferred separation, scored dimensions with `null` support, evidence references, hypotheses, alternatives, falsifiers, proposed experiments and status.
- `PlaytestComparison`: policies/builds/scenarios, matched seed pairs, valid/invalid denominators, metrics, uncertainty intervals, differences, confounders and linked sessions.
- `PlaytestFinding`: one deduplicated problem hypothesis/verified failure with trace witnesses, severity, calibration/evidence status, cross-session impact, test/replay history, issue link and follow-up.

**One tool gateway** exposes narrowly scoped commands, name/version finalized in implementation: `playtest.capabilities`, `playtest.run`, `playtest.listEpisodes`, `playtest.readEpisode`, `playtest.readWindow`, `playtest.metrics`, `playtest.compare`, `playtest.branch`, `playtest.submitReview` and `playtest.findings`. The read methods offer deterministic pagination/time ranges and return explicit `not observed`/missing artifacts rather than fabricated empty success. `metrics`/`compare` do code-owned numeric calculations; `submitReview` validates all cited IDs and schema before accepting a model's prose. `run` and `branch` require runner authorization and bounded budgets. Issue creation uses **existing AutoDev GitHub integration by the authorized root**, never an unreviewed model write tool. Expose only the minimum role-permitted commands through the RuleSync MCP tool allowlist (player: `run` and result reads; analyst: evidence/metrics/compare and review submit; root: conditional experiment and issue approval; independent validator: read-only evidence and replay-verification results). Add CLI equivalents only when a real operator workflow needs them, and do not create redundant CLI/MCP implementations.

**Required implementation validation:** Unit/contract tests for schemas, revisions, hidden-state isolation, episode completeness, evidence pagination, nonexistent citation rejection, false “success” on missing media, `null` scoring, metric denominators, paired comparisons and policy/model drift; read-only permission/blocked-write tests for both new roles; behavioral tests for both skill triggering **and** analysis quality with/without skill; adversarial examples covering a bad bot mistaken for a bad game, a correct engine with misleading visual feedback, an unreplayable RNG run, empty cohorts, a high but uncalibrated “fun” score and an LLM hallucinating an event. Acceptance is an evidence-supported analysis with appropriately qualified scores and an executable verification suggestion—not a long persuasive review.

## 7. Observability, evaluation and experience scoring

### Session analysis and AI gameplay critic — required pipeline

The original deterministic evaluations below are necessary but **not sufficient** for the requested playtesting system. Implement this explicit analysis stage on top of them, using the referenced projects' tested recording/replay/feedback components rather than creating competing frameworks.

**1. Record the complete player-visible experience.** For each decision, save step/revision, player-visible pre-state, legal actions and meaningful alternatives, policy intent/choice/confidence/fallback, authoritative after-state, event IDs, outcome, timing, and run/seed/game/policy version. **Jev Playtest Lab** already supplies decision validation, loop detection and audit JSONL; **jev-arcade** supplies replayable episodes and per-move state comparison; **NanoJev** supplies strict replay verification. Use their tested primitives and adapters. Keep privileged game/debug state outside the decision policy. If visual testing is enabled, reuse **PlayJev**'s frame/step/browser capture for event-triggered screenshots or clips aligned to game events. Preserve full raw traces under bounded retention, not just AI summaries.

**2. Compute facts and detect interesting moments.** Before spending LLM tokens, run cheap engine-invariant checks, crash/stall/loop detectors, resource-delta and phase-timing measurements, outcome statistics, player-understanding probes and strategy comparisons. For each episode, index exceptional windows (e.g. failure, major reversal, near-miss, repeated action, sudden resource loss) **plus representative ordinary segments**. jev-arcade's [`analysis.py`](https://github.com/CankatSarac/jev-arcade/blob/main/src/jev_arcade/analysis.py) already reconstructs decisions to compare their consequences against heuristics; extend only the general result schema and game-specific metrics. A heuristic is a reference, not ground truth; model confidence does not measure fun.

**3. Build an evidence packet for a reasoning LLM.** Provide game-authored rules and intended audience/goals; player policy/skill; exact episode outcome and measured metrics; a chronological phase summary; selected decision windows with legal alternatives, explicit event/replay IDs and optional screenshots/clips. Store the **unabridged** trace separately with indexed read-on-demand. Record precisely which segments were supplied and omitted; never silently truncate away failures or normal context. **Directly reuse JevHarness's** [full-trajectory reflection](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/reflection.py), [lossless trace codec](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/trace_codec.py) and [run storage](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/storage.py) where compatible; copy whole files if necessary under the confirmed permission. This tooling improves the **player policy**, not game quality; AutoDev still adds a separate evidence-grounded gameplay critic and result schema. **Directly reuse JevHarness trace/feedback infrastructure or copy entire relevant files under the confirmed permission**, retaining required notices and writing only the missing AutoDev-specific critic/bridge.

**4. Ask for a session critique against the intended design, not an unsupported fun verdict.** Delegate to AutoDev's existing capable LLM role **after gameplay**, at a capped frequency. Supply the game-owned rubric with desired player emotions/experience, intended risk and recovery, onboarding expectations, pacing, strategic depth and audience. Require an anchored, structured response identifying **where observed behavior diverges from those goals**: meaningful agency, pacing/repetition, tension/recovery, fairness/telegraphing, strategy diversity and UI feedback **only where visual evidence exists**. Every finding needs an observed fact, episode/step/event IDs, hypothesis, competing explanations, uncertainty, missing evidence, and a proposed verification experiment. Reject nonexistent citations, imagined game rules or visual judgments made from logs alone.

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

**Critic interpretation example (hypothetical):** If a race's 12 of 15 sampled decisions favor maximum immediate movement, the critic should hypothesize **insufficient strategic variety relative to the game's stated tactical-tradeoff goal**, cite the relevant actions, and propose comparing Heat-management and positional strategies on matched seeds. It must also acknowledge that the AI might be weak at long-term planning or the sampled track might favor immediate Pace. Never claim the game is boring just from one policy's repetition.

**5. Synthesize across sessions.** The deterministic aggregator first compares matched seeds/scenarios, player personas and skill levels, commits and metrics with sample counts/uncertainty. A **cross-session LLM analyst** then reviews *aggregates plus cited representative episodes* to identify repeated patterns, alternative causes and suggested targeted tests. Avoid drawing broad conclusions from one DNF or a bot that makes poor choices. This is new synthesis glue built on **jev-arcade's** benchmarks, **PlayJev's** episode results, and **JevHarness's** disciplined evaluation split, not another reimplementation of their trainers/runners.

**6. Verify with replay and counterfactual branches.** For high-value hypotheses, rewind via optional game-owned `fork`/snapshot, enumerate a bounded set of **legal** alternative actions, and run controlled continuations (multiple policies/seeds as needed). Ask whether plausible alternatives would have avoided the issue, differentiating player mistakes from poor affordances, unavoidable failure, or engine defects. Reuse seeded/replay primitives from **jev-arcade** and **NanoJev**. Generic branching orchestration is **custom AutoDev glue**, as none of those projects supplies general counterfactual game-quality testing. Track RNG policy, hidden-information limits and nondeterminism; if branching cannot be replayed, report **not verifiable**, not a fabricated causal result.

**7. Convert validated analysis into findings.** Independent validation checks evidence links, reproduction and statistical claims. Publish verified bugs or reviewable design hypotheses only through existing AutoDev GitHub issue gates. Never publish hundreds of near-duplicate critic opinions, and never let the critic autonomously change rewards, game rules, or source code.

**LLM cost controls:** Always-on deterministic evaluators are cheap; select only representative, novel and problematic sessions for full critique; use periodic cohort synthesis instead of critiquing every ordinary run; request visual evidence/branches only where relevant. Cache on game+trace+rubric+critic version, with explicit evaluation-budget limits and observable token/GPU costs.

**Experience score boundaries:** The scoring contract and calibration procedure are specified under **Human-calibrated quality scoring** below. The critic must not return an authoritative single-number 'fun' verdict from a session; all scores are provisional dimensions with cited evidence, uncertainty and applicable observation modality.

### Understanding and confusion probes — expectation versus outcome

**A decision log alone cannot tell us whether a player misunderstood something.** For a small, stratified sample of meaningful decisions, run a **pre-action comprehension probe**. Give a player/observer model *only* the same visual or player-visible information it would legitimately have at that time. Before applying the action, ask it to forecast an explicit, game-owned set of consequence variables (e.g. which resource changes, whether a unit will be destroyed, which screen/control will react), an uncertainty/probability estimate, and optionally a short explanation. Freeze the prediction **before** executing the action; compare with engine-authoritative post-action state and observed UI feedback. Store the predicted and actual outcomes as linked evidence, with a declared answer key, observability category and model/version.

~~~json
{
  "episodeId": "illustrative-17",
  "step": 14,
  "observationMode": "visual-only",
  "expected": {"doubleDNF": false, "confidence": 0.85},
  "actual": {"doubleDNF": true},
  "probeRevision": "before-action-revision",
  "interpretation": "possible misunderstanding; not yet a UI finding"
}
~~~

*Illustrative probe result only.* A model's probabilistic forecast is neither an authoritative expectation of a human player nor an objective measure of what the interface communicates. Also probe with **separate** observer policies, not just the decision-maker itself, to reduce the risk that a single weak policy appears to establish a design flaw. Run probes in shadow mode or on a cloned state to avoid modifying the acting policy's choice, introducing hindsight, or making costly LLM calls every turn. If a visual-only observer cannot reliably read the scene, distinguish perception failure from rule misunderstanding.

**Confusion validation:** Compare independently initialized novice/visual-only and informed/expert cohorts on the **same visible state**, record repeated discrepancies by mechanic and uncertainty, and verify that the predicted outcome was actually communicated in the UI/rules accessible to that cohort. Run opt-in controlled interventions—e.g. alternate warning text, a tutorial explanation, or a changed UI affordance **provided by the game**—and re-measure prediction accuracy and actual play behavior. A meaningful difference suggests an information/feedback problem; failure by *all* models can equally reflect inadequate model competence or an unclear probe. Human comprehension tests are required to generalize to human confusion.

**Learnability:** Give the same bounded learning cohort multiple independent episodes with retained player-available experience (but without hidden correct answers). Measure prediction error, repeated mistake types, recovery, completion and performance over episodes; compare with stateless controls on matched scenarios. Improvement suggests that feedback teaches the mechanic. Persistent failure warrants examination of explanatory feedback, player competence and available affordances—not an automatic UX bug. Use JevHarness-style held-out evaluations and frozen policies so reflection doesn't overfit the sessions used for a final learning claim.

### Behavioral hypotheses of uninteresting/frustrating play

| Recorded signal | Plausible design concern | Required alternative explanation / follow-up |
| --- | --- | --- |
| Many repeated no-op or ineffectual actions | Misleading controls or weak feedback | First rule out policy bug, lag, action-legality errors and deliberate stalling |
| Long stretches of only one *competitive* action | Limited agency/decision depth | Compare counterfactual outcomes, not mere count of legal actions; tension or simplicity may be intentional |
| A single policy wins nearly every matched scenario | Dominant strategy / ineffective alternatives | Test independent, comparably skilled policies; control track/scenario and training leakage |
| Frequent losses with little apparent recovery | Punishing or unfair outcome | Fork earlier states to test feasible escapes and whether risk was previously signaled |
| Low event/action variety or repeated phases | Repetitive pacing | Ask whether rhythm suits the game's desired genre and compare with human engagement ratings |
| Abrupt failure after an understated warning | Potentially confusing consequence | Use synchronized UI evidence and pre-action forecasts; state-only data cannot establish warning clarity |
| Cards/items rarely used | Weak or redundant content | Check whether niche situations are underserved or the player policy undervalues them |

These signals are **triage triggers**. The critic connects them to game-authored design intentions, cites concrete examples and requests counterfactual/cohort checks. A repetitive loop can be satisfying in some genres; a high-risk catastrophe can be an intended reward/punishment tradeoff. Do not equate surprise with confusion, loss with frustration, or predictability with boredom.

### Active hypothesis experiments

A critique should generate a **test plan AutoDev can execute**, not just a suggested fix:

1. State the observed behavior, intended design goal, candidate mechanism and competing causes (game mechanic, UI communication, policy weakness, scenario bias, randomness).
2. Choose the smallest discriminating test: pre-action understanding probe, same-state policy comparison, branch-and-replay of legal alternatives, seeded cohort experiment, learning-curve trial, or opt-in UI/content A/B variant.
3. Specify controlled conditions (engine SHA, scenario, seeds/RNG, prior player information, skill mix, design variant), independent evaluation metric, baseline, sample/budget bound and stopping criterion *before* running the experiment.
4. Run it through the existing sandboxed game adapter and available replay infrastructure; keep training/selection/test splits separate and preserve unexpected or negative outcomes.
5. Compare measured effects and uncertainty; update hypothesis confidence or mark it unsupported/untestable. Report only conclusions warranted by the evidence.

**Example, hypothetical:** A Heat-related double DNF may reflect an aggressive mistake, a poorly telegraphed threshold, or a lack of recovery. Test action alternatives under controlled future randomness **and** compare novice prediction accuracy with and without the game's actual Heat warning. A branch demonstrating escape options addresses agency, while only visual/comprehension testing informs warning clarity. Neither alone establishes human frustration.

**Reuse boundary:** Jev Playtest Lab supplies constrained choices, observation hashing, shadow mode and loop detection; jev-arcade supplies comparable episodes, action consequence analysis and baselines; JevHarness supplies reflection, frozen policies and evaluation rigor; NanoJev supplies structured local decisions and strict trajectory replay; PlayJev supplies visual observation and controlled browser stepping. **Comprehension probe schema, critic-guided experiment scheduler, A/B analysis, human calibration and systemic design-quality inference are AutoDev extensions**, not already-implemented upstream capabilities.

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

### Human-calibrated quality scoring

The **gameplay-quality profile** comprises independent dimensions: (1) meaningful decisions/agency, (2) strategy diversity and depth, (3) tension, comeback and risk/reward, (4) pacing, repetition and flow, (5) fairness/clarity/learnability. A suggested **illustrative** initial composite uses 30/20/20/15/15 weights, but no universal weights or quality threshold are valid. The game's design rubric controls intended tradeoffs and target audience. For every dimension retain measured proxies, applicable modality, sampled-episode coverage, agent skill/control group, uncertainty, cited critic rationale, missing-data reason, and previous-commit comparison. Only compute a composite when configured evidence requirements are met; otherwise show dimensions and **Not observed** rather than inventing a number. A screenshot-free run cannot score visual clarity.

**Three inputs stay visibly distinct:** (a) objective game telemetry and matched-run comparisons, (b) reasoning-model qualitative critique of evidence and design goals, (c) **consented human player feedback** on enjoyment, friction, clarity, fairness, pacing and difficulty, preferably tied to recorded moments. The first two generate **experimental proxies**, not subjective experience measurements. As human ratings become available, evaluate inter-rater variation, measure how each proxy correlates with human-reported experiences on **held-out players/sessions**, and adjust thresholds/weights only through documented calibration. Surface disagreement instead of training a critic to rationalize the proxy. Without such validation, label the overall measure **unvalidated enjoyment proxy**, never "fun confirmed."

Use common-random-number/matched-seed comparisons when feasible; include confidence intervals and adequate samples, avoid significance claims from tiny batches, monitor multiple-comparison effects and show whether agent capability itself changed. Define explicit pass/fail only when an authoritative evaluator supplies a verdict; absent metrics/verdicts remain **Not observed** per existing Evaluations policy.

## 8. Findings, replay, and GitHub issue gate

Each candidate finding includes:

- **Identity:** stable fingerprint; workspace, commit, build, scenario, adapter/policy/model versions, run IDs and first/last observed.
- **Classification:** correctness, stability, balance, exploit, design/experience, understanding/learnability, accessibility/UI or performance; severity, likelihood, scope and confidence with explicit basis.
- **Evidence:** deterministic seed/RNG provenance, minimal action trace, cited critic moments, **pre-action prediction vs actual consequence** when probed, cohort/learning curves, replay/fork results, invariant witness or statistical comparison (sample size, baseline, intervals), linked artifacts/traces.
- **Actionability:** observed result, game-design intention, competing interpretations (policy flaw vs game flaw), reproduction commands/steps, controlled verification attempted, remaining uncertainty and suggested next investigation (not an unverified forced fix).
- **Lifecycle:** new -> triage -> reproduced/corroborated -> issue candidate -> published/suppressed/resolved; link existing GitHub issue and verification-after-fix runs.

Reporting pipeline:

1. Run deterministic checks and select a diverse, bounded set of session traces for **LLM gameplay critique** with cited event IDs.
2. Compare hypotheses across matched skill/knowledge cohorts; inspect pre-action prediction gaps and learning curves; then replay/shrink failures or run targeted legal-action counterfactuals and opt-in design/feedback variants where supported.
3. Have an independent validator verify game facts, critic evidence, alternative explanations and uncertainty; separate poor AI decisions from game defects.
4. Deduplicate findings against GitHub; create/update only under explicit workspace reporting policy. **Design/fun/balance suggestions require review by default**; critical reproducible bugs may be auto-published only if configured.
5. After a fix, replay original seeds and relevant controls, then record resolved/persistent/regressed results; never rely on model assertions.

Rate-limit, deduplicate, and batch issue creation. Do not create one issue per failing episode or treat policy mistakes as engine defects.

## 9. AutoDev lifecycle, Console and integration

- **Role:** register `playtester` as a capability; use existing orchestration skill for root delegation, parallel workers, validation, retries and final gates. Do not clone JevHarness's agent orchestrator into AutoDev.
- **Evaluation ownership:** map runs, objective metrics, comprehension forecasts vs actual results, learning curves, cited critic reports, cross-session comparisons, counterfactual/variant experiments, human-calibration provenance and explicit evaluator verdicts into existing Evaluations history and trace linkage, preserving null/unknown semantics.
- **Console:** propose a Playtests grouping/tab within existing Evaluations with run history, timeline/evidence windows, expectation-vs-actual probe results, cohort learning curves, critic rubric scores/uncertainty, tested hypotheses and interventions, counterfactual outcomes, replay artifacts, human-calibration status and linked issue state. Any actual UI/navigation/control changes must update the canonical Console target-state doc in the implementation PR.
- **Workspaces:** enablement, allowed adapter/runner, model capabilities, resource budget, retention and GitHub publication authority are scoped to the target workspace through canonical AutoDev configuration.
- **OpenLIT:** standard OTLP traces, metrics, GenAI inference cost/latency and worker health; do not create a second observability backend or overload traces with gameplay video.
- **Security:** allowlisted sandboxed game runners; no secrets sent to game/model logs; rate/time/memory/GPU budgets; explicit permissions for issue writes; preserve readable/replayable evidence and failure transparency.
- **No source changes:** playtest runners and analyst agents should produce artifacts/findings, not secretly patch gameplay, change rewards or merge PRs. A separate authorized development task may use reported evidence.

## 10. Reuse-first delivery slices and acceptance gates

| Phase | Concrete reuse and limited customization | Acceptance evidence |
| --- | --- | --- |
| **1. Recorder and runner** | Add `playtester` role and `game-playtesting` skill; execute pinned Jev Playtest Lab modules/tests within a compatible adapter and jev-arcade as an independent Python fixture; build one game-owned adapter | Demonstrate **real game** episode/replay and separate labeled upstream fixture, provenance, legality, permission checks and actual upstream calls when applicable |
| **2. Analyzer and critic MVP** | Add read-only `playtest-analyst` role, `playtest-analysis` skill, indexed evidence-reading tools, and **directly reuse authorized JevHarness reflection/trace/storage modules** with jev-arcade analysis where compatible | Full run -> source-verified timeline -> null-safe anchored scoring -> event-cited reasoning critique -> testable hypothesis; malformed citations and missing evidence rejected |
| **3. Local AI and comprehension cohorts** | Run **upstream NanoJev `/api/evaluate` server** as a pinned optional sidecar, incorporate Jev Playtest Lab shadow probes, and **use JevHarness's authorized GEPA-based evolution/reflection/frozen-policy modules directly** for optional strategy optimization | Evidence of real model invocation and capability negotiation; skill-calibrated cohorts, forecasts, learning trajectories, inference/error attribution and cost measured |
| **4. Hypothesis experiments and issues** | Reuse existing Evaluations/GitHub pipelines, benchmarks and replay; add critic-proposed controlled tests, branching/optional A/B coordination and deduplication | Tested explanation distinguishes avoidable loss, insufficient warning, poor model comprehension and intended difficulty; one verified actionable finding |
| **5. Visual critique and human calibration** | Run **upstream PlayJev image server and `VecGame` harness** using a target-owned hook; also collect **unmodified real-time browser evidence**; compare with human ratings | Prove PlayJev frame-to-action and browser step; audiovisual/legibility claims rely on authentic captures, missing evidence stays unobserved, human calibration is explicit |
| **6. Portability** | Run a second, mechanically different game with same AutoDev infrastructure | Only game adapter/scenarios/rubric change; no gameplay logic leaks into AutoDev |

**First milestone:** at least 1,000 headless episodes (later 10,000), two independent player policies, deterministic objective metrics, **complete-session AI critiques that follow the `playtest-analysis` skill and cite exact evidence IDs**, a bounded sample of pre-action expectation-vs-outcome probes, matched-cohort comparisons, null-safe calibrated/provisional sub-scores, and one reproduced or explicitly unverified hypothesis. Both specialized roles and both skills must pass access-control, trigger and behavioral tests. Measure performance and critic costs empirically; no assumptions of instant throughput.

## 11. Decisions to resolve during implementation

- Which adapter transports and engines to support in v1 beyond stdio JSONL, and where the game runner sandbox lives.
- Which local NanoJev checkpoint, inference server/API and model-weight license pass quality and operational testing; whether a non-model heuristic wins on cost/performance.
- Artifact storage and retention quotas for locally launched runs vs CI; handling intentional game nondeterminism and performance-test noise.
- Which evaluators have game-owned pass/fail thresholds, which offer only proxy scores, how critic/probe evidence is sampled without selection bias, and what consenting human ratings support held-out calibration of fun and clarity measures.
- How each engine supports checkpoints, alternate legal actions, RNG continuity and hidden-information limits for counterfactual claims.
- Enforce the Section 2 upstream-use ledger and smoke-test **actual upstream code paths**, including compatible license notices and pinned file/model hashes, before accepting replacement implementations. **JevHarness code copying and adaptation are authorized**; preserve the applicable license/permission obligations. **jev-plays-balatro remains permission-gated.**
- What evidence permits deterministic bug publication versus required review for balance/design/fun findings.

## 12. References

- [Jev Playtest Lab](https://github.com/gbesse/jev-playtest-lab)
- [jev-arcade](https://github.com/CankatSarac/jev-arcade)
- [JevHarness](https://github.com/TianyuCodings/JevHarness)
- [NanoJev](https://github.com/TianyuCodings/NanoJev)
- [PlayJev](https://github.com/OmniJev/PlayJev)
- [jev-plays-balatro](https://github.com/IgorWarzocha/jev-plays-balatro)
- [GEPA — MIT-licensed reflective optimizer](https://github.com/gepa-ai/gepa)
- [NanoJev published checkpoint and provenance](https://huggingface.co/C-Tianyu/NanoJev)
- [PlayJev published model, code/weight license](https://huggingface.co/OmniJev/PlayJev-0.8B)
- [AutoDev orchestration skill](../.rulesync/skills/orchestration/SKILL.md)
- [AutoDev Console Target State](autodev-console-target-state.md)

**Scope of this proposal PR:** exactly this one Markdown document. Implementation, configuration, skills, runner, UI and canonical-target updates require subsequent independently validated PRs.
