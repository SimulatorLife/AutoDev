# Generic Autonomous Game Playtesting — Target State

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

**Execute existing upstream implementations wherever compatible and useful**, rather than writing new equivalents. **The project owner has confirmed permission to use, copy and adapt JevHarness code for AutoDev.** Prioritize pinned package/API integration, then the original server/CLI, then intact licensed files with upstream tests; write thin adapters only for demonstrated incompatibilities. Each selected integration must execute the actual upstream code in an end-to-end test, not merely run a detached demo. Optional or unlicensed projects must not be included to meet a reuse quota.

The six sources are [Jev Playtest Lab](https://github.com/gbesse/jev-playtest-lab), [jev-arcade](https://github.com/CankatSarac/jev-arcade), [NanoJev](https://github.com/TianyuCodings/NanoJev), [PlayJev](https://github.com/OmniJev/PlayJev), [JevHarness](https://github.com/TianyuCodings/JevHarness) and [jev-plays-balatro](https://github.com/IgorWarzocha/jev-plays-balatro). None supplies a complete AutoDev gameplay-quality critic, arbitrary-engine counterfactual runner, or human-validated fun score; implement those missing connections within the existing AutoDev runtime/evaluation architecture.


### Concrete integration manifest — dependency or entire-file reuse by default

**This manifest is the implementation commitment**; companion research references below are separately categorized by whether their code can execute on a target game. Every **selected integration** must have a pinned execution path, an upstream test or behavior-equivalence check, and a documented reason for any deviation; a project's example test alone is not evidence of production reuse. The SHAs are **audited starting points**, not claims of permanent compatibility. Review upstream licensing and security on upgrades. Prefer (1) install/import an existing package, (2) execute its maintained server/CLI in a pinned isolated checkout, (3) vendor **whole relevant files with their tests** where there is no stable public API, and only then (4) write a small isolated adapter/port if direct use demonstrably fails. Avoid vendoring huge demos, model weights or unrelated code.

| Upstream baseline and exact code/API | Default incorporation and what *actually executes* | Verified constraint / allowed customization |
| --- | --- | --- |
| **Jev Playtest Lab** [`7ca4c5f`](https://github.com/gbesse/jev-playtest-lab/tree/7ca4c5f660d3870f38c828ab7dc8168adc39f1ad): [`src/core.js`](https://github.com/gbesse/jev-playtest-lab/blob/7ca4c5f660d3870f38c828ab7dc8168adc39f1ad/src/core.js), [`src/lab.js`](https://github.com/gbesse/jev-playtest-lab/blob/7ca4c5f660d3870f38c828ab7dc8168adc39f1ad/src/lab.js), [`test/core.test.js`](https://github.com/gbesse/jev-playtest-lab/blob/7ca4c5f660d3870f38c828ab7dc8168adc39f1ad/test/core.test.js) | **Reuse intact MIT-licensed `src/core.js` and `test/core.test.js` via a verified pinned import or vendoring**. Use `observationHash` and `LoopGuard` when compatible. Reuse intact `src/lab.js` / `PlaytestLab.observe` **only in hosted-Jev-compatible policy modes**; translate its audit JSONL through an AutoDev artifact adapter rather than imposing its Jev protocol globally. | No declared npm `exports` or `main`; `buildDecisionRequest` pins `jev-1.13.0`, its 255-choice limit is provider-specific, and `parseDecision` requires a `noul` safety response. **Do not treat this hosted-Jev contract as universal**: keep unchanged logic behind the compatible provider adapter; normalize other backends separately. |
| **[jev-arcade](https://github.com/CankatSarac/jev-arcade/tree/e1655135b038c2d5d7f56b2854f22d5b112cb382)** — [runner](https://github.com/CankatSarac/jev-arcade/blob/e1655135b038c2d5d7f56b2854f22d5b112cb382/src/jev_arcade/harness/runner.py), [recorder](https://github.com/CankatSarac/jev-arcade/blob/e1655135b038c2d5d7f56b2854f22d5b112cb382/src/jev_arcade/harness/recorder.py), [analysis](https://github.com/CankatSarac/jev-arcade/blob/e1655135b038c2d5d7f56b2854f22d5b112cb382/src/jev_arcade/analysis.py) | **Optional reference fixture or production adapter only for target games actually implementing its Python `Game` protocol.** If compatible, execute upstream `run_episode` and recorder against the selected game with original tests. If not, keep fixture clearly optional; selectively port generic algorithms with parity tests only where valuable. | Its `analysis.collect_moves` uses the built-in game registry and Tetris-specific data. A detached Python fixture **does not count** as production AutoDev integration. Avoid a redundant Python ↔ Node step loop for TypeScript games. |
| **[NanoJev](https://github.com/TianyuCodings/NanoJev/tree/76fdfc9ecdca45a9bcef17991a07d3041a87685a)** — [real server](https://github.com/TianyuCodings/NanoJev/blob/76fdfc9ecdca45a9bcef17991a07d3041a87685a/scripts/serve_decisions.py), [checkpoint](https://huggingface.co/C-Tianyu/NanoJev/tree/unified-games-v1), [replay verifier](https://github.com/TianyuCodings/NanoJev/blob/76fdfc9ecdca45a9bcef17991a07d3041a87685a/scripts/replay_unified_episodes.py) | **Optional pinned upstream `POST /api/evaluate` inference server**, invoked with `python scripts/serve_decisions.py --checkpoint-dir <local> --web-root web --port 8765 --disable-native-triton`. Enable for the selected game **only after** target-state/action schema translation, valid-action checks and held-out decision-quality tests versus heuristic/random baseline; otherwise report unsupported or explicit named fallback. | Server has single-threaded `HTTPServer` and caps 32 states/96 questions/256 candidate paths. The replay verifier requires its bundled `unified_game_pipeline.factory`; it does not replay arbitrary games. Confirm model weights/license, hardware and throughput. API accessibility alone does not prove policy competence. |
| **[PlayJev](https://github.com/OmniJev/PlayJev/tree/ea3a514d2fcbc0756c36eabe052439db54544542)** — [server](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/playjev/serve.py), [GamePage/VecGame](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/playjev/env.py), [play](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/playjev/play.py) | **Optional** pinned `POST /v1/systemone` visual policy: `python -m playjev.serve --ckpt OmniJev/PlayJev-0.8B --port 18732`. Execute its real `GamePage`/`VecGame` only when the target game has verified `pj.json`, `pj_hook.js`, [virtual clock](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/games/_shared/pj_shim.js) compatibility and end-to-end action mappings. | Its modified browser runtime mutes audio, disables GPU and may resize frames, so it cannot validate native animation/audio/legibility. **Default visual fallback:** existing AutoDev `browser-tester`/Playwright on the real game UI, with original-resolution real-time captures. Missing model compatibility is explicitly reported, not fabricated. |
| **[JevHarness](https://github.com/TianyuCodings/JevHarness/tree/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5)** — [runtime](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/runtime.py), [reflection](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/reflection.py), [trace codec](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/trace_codec.py), [storage](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/storage.py), [evolution](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/evolution.py), [frozen policies](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/frozen.py) | **Direct use/copy/adaptation authorized.** Prefer actual pinned `auto-jev` package via [integration reference](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/skills/jev-harness/references/integration.md). Before import/vendor: map public API/callback signatures, transitive module/package deps, upstream candidate/run/trace ID to `PlaytestEpisode` and ownership of stored artifacts. If whole-file vendoring required, include transitive dependencies and original upstream tests, not isolated un-runnable files. | Reuse [runtime](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/tests/test_pipeline_v3.py), [reflection](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/tests/test_reflection.py), [trace](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/tests/test_trace_codec.py), [storage](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/tests/test_review_storage.py) tests; GEPA already used via `pyproject.toml`. Integrate with **one** AutoDev authoritative evidence store; JevHarness optimizes player policies, not gameplay fun. |
| **jev-plays-balatro** [`1653680`](https://github.com/IgorWarzocha/jev-plays-balatro/tree/1653680f4be20a13a1390eeac67dc2539214c1b3): `jev_balatro/decisions.py`, `rules.py`, `runner.py` | **Blocked for direct reuse pending license/author permission** (no repository license was present at audit). Once authorized, consider importing its whole two-timescale controller only for compatible card-game policies, not as AutoDev's universal agent runtime. | A Balatro-specific mod/controller is not a game-neutral playtester. Until rights/API are resolved, the small long-horizon/tactical separation belongs in the per-game policy design without copying implementation. |

**Concrete evidence of reuse:** Each implementation PR must include an **upstream-use ledger**: upstream URL + commit/tag, specific consumed files/API/command, pinned install/checkout mechanism, adapter location, upstream tests run, AutoDev integration tests run, expected upgrade path, and exact reason for any custom implementation of overlapping capability. Require **a runtime smoke test proving the upstream component itself executed** (not merely an imported type or documentation link). Maintain compatible upstream tests verbatim where files are vendored; changes to those files are reviewable, narrowly scoped deltas. Never count “inspired by,” a copied algorithm description, or an unused dependency as implementation.

**Pragmatic minimum:** One game-owned adapter + compatible directly reused Jev Playtest Lab validation/loop-detection → 1,000 authoritative real-game episode records → deterministic metrics → a budgeted, evidence-linked critic review. The jev-arcade Python fixture, NanoJev/PlayJev inference, JevHarness policy optimization and Intuitive Gamer R reproduction are **optional capability-gated extensions**. A detached demo or unneeded dependency does not count as production reuse; require actual selected-game execution when marking any integration complete.

### Additional research implementations — human-validity layer

Keep **human experience measurement** distinct from **AI policy competence** and **game-quality prediction**. The following are additional actual code/data reuse candidates, not merely papers to cite:

| Verified source / precise implementation | Reuse first | Boundary |
| --- | --- | --- |
| **[Intuitive Gamer / Nature 2026](https://www.nature.com/articles/s41586-026-10722-1)** — [MIT research repo](https://github.com/collinskatie/intuitive-game-reasoning), [helper/model](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/setup_helpers.R), [fit](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/main_funness_model.R), [generalization](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/generalization_test.R), [post-play](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/post_play.R), [human data](https://github.com/collinskatie/intuitive-game-reasoning/tree/main/human-data) | **Optional offline research reproduction** with original R scripts and released data; no mandatory R runtime or model archive for ordinary target-game playtesting. Reuse original helper/statistical functions directly, and transfer individual features/calculations only after parity and held-out *target-game* human tests. | Its R²/coefficients measure pre-play expectations in novel board games, not post-play ratings in arbitrary target games. Running its research benchmark does **not** validate AutoDev's human-fun predictions. |
| **[Mario Personas — Stack More Levels: General and Human-like Mario Playing (CoG 2026)](https://github.com/carrotoxic/mario-personas)** — [human-likeness evaluation](https://github.com/carrotoxic/mario-personas/blob/main/src/evaluation/aar.py), [action-distribution comparisons](https://github.com/carrotoxic/mario-personas/blob/main/src/evaluation/similarity.py), [competence test](https://github.com/carrotoxic/mario-personas/blob/main/src/evaluation/evaluate.py) | Reuse its **evaluation protocol**: action agreement rate (AAR) at human-observed states, **Jensen–Shannon divergence** across action distributions, independent held-out trajectories and competence testing. If approved for direct code reuse, run its original functions on Mario fixtures and port only generic comparator functions with parity tests. | Its PPO/DRAIL checkpoints, Java simulator and 32-action Mario environment are **not** drop-in RacingGame players. Confirm reuse rights before copying its source; AI/human action similarity does **not** measure human enjoyment. |
| **[OpenSpiel](https://github.com/google-deepmind/open_spiel)** — [game representation and algorithm overview](https://github.com/google-deepmind/open_spiel/blob/master/docs/intro.md) | **Optional actual library** for regret, exploitability, strategic equilibria or game-theoretic comparison **only** when an adapter can accurately encode a bounded game's decision problem. | Not a funness judge; don't translate the full game into OpenSpiel unless a validated, equivalent subgame exists. |
| **[Ludax](https://github.com/gdrtodd/ludax)** — [GPU-accelerated board-game DSL](https://arxiv.org/abs/2506.22609) | Optional fast research fixture for **board-game-like test environments** when its grammar precisely describes the mechanics; reuse existing JAX simulator rather than write a GPU evaluator. | Not a replacement for target game's authoritative engine, especially a native browser/real-time game. |
| **[LLM-based review classification using PXI/CORGIS](https://doi.org/10.1145/3772318.3790760)** (CHI 2026) | Optional **taxonomy/evidence-coding method** for free-text human comments; map comments to PXI/CORGIS constructs using a separate coded sample and human review. | Review-language categorization is not objective human enjoyment, and a classifier cannot substitute for validated questionnaire administration. |

**Research reuse proof:** Pin the original commit and input data snapshot, run the maintained analysis on its native benchmark first, preserve its outputs, and verify any extracted function on known upstream examples. If transferred to the user's selected game, report **domain shift** separately; call it a research baseline until target-game calibration demonstrates useful predictive power. No external game is automatically playtested: AutoDev runs only the explicitly selected workspace and adapter; research/demo games remain optional benchmark fixtures.

### Other unresolved implementation gaps and failure modes

- **Player-policy backend contracts:** Jev Playtest Lab is hosted-Jev `choice+noul`; NanoJev uses its own batching limits; PlayJev accepts images plus `choice`. Use **thin upstream-specific encode/decode adapters behind AutoDev's existing provider/model routing, permissions and OpenLIT cost/trace instrumentation**, not a second router, broker or model-serving framework. Preserve native fields and errors; reject unsupported actions and log a named heuristic fallback when explicitly chosen. Validate against source request/response fixtures.
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
  -> evidence-backed Playtesting findings + valid linked evaluation assertions + permission-gated GitHub issues
~~~

**Do not let the player evaluate itself.** A Jev-style model selects actions. Engine-owned evaluators measure outcomes and invariants. A stronger reasoning LLM separately critiques agency, tension, pacing, fairness, clarity and possible player friction; it proposes testable hypotheses. Independent replay and statistical checks establish which claims hold. The root makes the final issue/validation decision.

- **Core:** versioned game-independent observation/decision, event, evidence packet, rubric, critic result and finding contracts.
- **Runtime:** bounded runner, upstream adapters, policy selection, event capture, evidence selector, critic invocation using existing model routing, cohorts and counterfactual verification.
- **Data:** persist workspace-scoped batches, episodes, findings, comparisons, analyses and optional human studies as typed, indexed Playtesting records with immutable, bounded trace/media artifacts. Publish valid batch-level evaluation assertions to Evaluations with source links; retain OpenLIT for inference telemetry.
- **Agents/RuleSync:** two bounded, **read-only specialized roles**—`playtester` (execute and observe) and `playtest-analyst` (interpret and compare)—and two distinct conditional skills described in Section 6. The analyst can route to the existing `autodev/smart` *model tier*, but must not inherit the existing `smart` role's full-access sandbox. Reuse `validator`, `browser-tester` and the root orchestration skill; keep final gates with the root.
- **Console:** expose **Playtesting** as the top-level **Observe** resource at `/playtesting`, with feature-owned query state, indexed session history and addressable full-page replay. Use the shared Console shell and components; link Evaluations, Usage/OpenLIT, Workspaces and GitHub data through their owning resources.
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
console/src/features/evaluations/           # existing Results and Comparisons unchanged
console/app/playtesting/page.tsx   # top-level resource
console/app/playtesting/sessions/[id]/page.tsx  # full session viewer
console/src/features/playtesting/          # dedicated views and URL helper
console/src/lib/server/playtesting.ts       # typed server read/control client
core/src/navigation.ts                     # new canonical Observe item
console/app/evaluations/page.ts           # existing route unchanged
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

### Versioned game-adapter stdio contract

The game adapter exchanges **one UTF-8 JSON-RPC 2.0 envelope per stdout line**, with messages bounded in size. Reuse the JSON-line framing/validation conventions in [AutoDev's existing MCP tool filter](../runtime/src/mcp/tool-filter.ts) when they match, plus tested JSON-RPC schema helpers; the **game adapter is a separate operation protocol, not automatically an MCP server**. Publish and test the following minimum version-1 contract in `core/src/playtesting/`:

~~~json
{"jsonrpc":"2.0","id":"1","method":"game.capabilities","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":"1","result":{"protocolVersion":1,"engineBuild":"sha","modes":["headless"],"supportsSnapshot":false}}
{"jsonrpc":"2.0","id":"2","method":"game.reset","params":{"seed":"42","scenario":"default"}}
{"jsonrpc":"2.0","id":"2","error":{"code":-32001,"message":"unsupported_scenario","data":{"retryable":false}}}
~~~

**Behavior:** The first successful request negotiates version, engine build, observation/action schema hashes, engine-specific capabilities and execution limits. Request IDs are unique and correlate to exactly one response; game-state-changing calls are serialized per episode and reject stale revisions. Specify strict schemas for `game.observe`, `game.legalActions`, `game.step`, `game.outcome` and advertised optional snapshot/replay/fork/capture operations, stable episode IDs, legal actions, time/seed provenance and structured error codes. Progress/event notifications have no request ID and use a separate typed envelope. Stdout contains only protocol lines; stderr carries diagnostics. Enforce deadlines, per-line/payload limits, queue bounds, cancellation and child termination, EOF/process-crash handling, version negotiation, malformed/duplicate/late responses and explicit unsupported operations. Frames/audio/video are separately stored **bounded artifact references**, never inline base64. Run golden protocol fixtures against both a Node and a non-Node adapter, including invalid revision, partial JSONL, concurrency, cancellation, hidden-state leak, wrong version and unsupported media.

### Player-visible observation guarantees

Each game mode/cohort has a **game-authored, versioned allowlist** of observable fields, units, display rounding, revelation timing and mapping to real UI/accessible gameplay rules. Structured observations may contain only information available to the represented player; hidden engine/debug state is retained separately for authorized diagnoses. A target-owned conformance fixture compares screenshots/native accessibility state with structured observations across representative decisions and must reject extra precision, hidden future outcomes, omitted warnings, post-choice information and mismatched timestamps. Record observation schema hash and policy visibility mode (`structured` vs `visual-only`); label unsupported equivalence as `unverified` and avoid human-comprehension conclusions from it.

### Approved target-game execution

The game-owned `adapter.command` runs only after **Workspaces** approves the exact workspace/checkout/build, working directory and executable/argument allowlist. The authorized runner enforces path containment, symlink escape checks, no inherited credentials, process-tree isolation, filesystem/network permissions, memory/CPU/GPU/wall-time and log/artifact quotas, cancellation and approval revocation. Reuse [AutoDev's existing authenticated Control API](../runtime/src/control-api/index.ts), role permissions and sandbox context where proven effective, while adding an explicit **OS/process** isolation mechanism where missing; [agent bridge sandbox hints](../runtime/src/agents/bridge-sandbox.ts) are not a security boundary for executing arbitrary repository commands. Test command substitution, symlink escape, credential inheritance, repository mutation, changed SHA, unauthorized workspace and timeout. Console actions invoke typed approved run requests rather than raw shell commands.

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

AutoDev owns schema validation, worker/critic/probe budgets, inference routing, artifacts and issue policy. Game configuration chooses scenarios, policies, metric hooks and an optional **game-specific critic rubric** (intended player experience, audience, teaching/feedback goals, pacing, meaningful choices and deliberately punishing tradeoffs) **without embedding game logic in AutoDev**. The example `auto` critic is resolved through current AutoDev model routing, not a new provider. The optional analysis settings shown are **proposed**, subject to schema design; they do not imply existing runtime support. Human calibration requires separately provided, consented human ratings, not fabricated model responses. Adapter commands use the approved execution boundary in Section 4; repository-controlled commands never acquire ambient host privileges or credentials. Support non-Node engines via the same protocol.

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
| **Learning / repeated sessions** | Same policy identity and bounded learning memory across **multiple episodes of the same selected game/workspace**, resetting on workspace/game boundary and explicitly at configured cohort/build boundaries; never import privileged results or held-out answer keys | Can the player learn from visible consequences and feedback across attempts? |
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
| **One shared playtesting tool surface** | Implement a real Runtime-hosted MCP tool server using [the existing Memory MCP server pattern](../runtime/src/memory/mcp.ts), [stdio entry point](../runtime/src/memory/mcp-main.ts), [MCP role tool filter](../runtime/src/mcp/tool-filter.ts) and [Control API authorization](../runtime/src/control-api/index.ts). Then register the server in [`.rulesync/mcp.jsonc`](../.rulesync/mcp.jsonc); **that JSONC declares an MCP server but cannot itself implement commands**. | Expose validated `playtest.*` run/read/evidence/metrics/compare/review operations. Bind actor/workspace/role to trusted Runtime session as Memory does, enforce handler-level permissions and test discovery, blocked writes, cross-workspace denial, permitted run, cancellation and server unavailability. CLI reuse goes through this Runtime service, not a second implementation. |
| **Core/data and Console integration** | `core/src/playtesting/`, `runtime/src/playtesting/`, `data/src/playtesting/`, **top-level `console/app/playtesting/` and `console/src/features/playtesting/`** | Versioned batch/episode/rubric/finding/comparison schemas, indexed workspace-scoped reads and bounded replay. Only project actual batch-level evaluation assertions to existing Evaluations; retain one Console shell, model routing and telemetry foundation. |
| **Target-owned inputs** | Game adapter + `playtest.config.json` + optional `playtest.rubric.json` in each target repo | Explain controls, mechanics, intended experience, warnings, observable consequences, expected difficulty curves, authoritative invariants, measured metrics and optional human rating questions. No RacingGame-specific assumptions in generic AutoDev skills. |

**Agent access:** `playtester` gets only the approved playtest runner and constrained artifact/result tools, not code-write/GitHub issue privileges. `playtest-analyst` gets evidence **read** and review **submit** functions plus model inference, not game-step/code-edit/issue-write operations. Use a separate read-only analyst role because the current `smart` role is configured with broad workspace access. The existing `validator` receives source-independent evidence to check (not a preconceived critic verdict); `browser-tester` keeps its existing Playwright-only policy for UI validation. Role configuration must follow AutoDev's canonical RuleSync/model-role ownership and regenerate provider projections, not introduce a fifth fixed provider-model tier. All tool permissions and sandbox limitations need executable tests, not just prompt assertions.

**Skill design:** Keep human-judge validation in a conditional `playtest-analysis/references/human-validation.md` reference rather than inventing a third overlapping skill. Follow the existing [writing-agent-skills](../.rulesync/skills/writing-agent-skills/SKILL.md) guidance: each skill has a specific trigger, required inputs/outputs, safety boundaries, concise steps and behavior tests. Keep detailed criteria in shallow references only where they improve discoverability. Test positive and negative triggers (e.g. “play ten episodes” should load execution, “analyze this existing trace” should load analysis, “fix this code” should load neither by default) and baseline/with-skill performance; avoid a third overlapping `gameplay-critic` skill.

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
- **Optional human-validation artifacts:** `HumanPlaytestStudy`, `HumanExperienceResponse`, `PlayerPolicyValidity`, and `PlaytestJudgeValidation`, per Section 7; never store personal raw feedback in generic LLM evidence by default.

**One tool gateway** exposes narrowly scoped commands, name/version finalized in implementation: `playtest.capabilities`, `playtest.run`, `playtest.listEpisodes`, `playtest.readEpisode`, `playtest.readWindow`, `playtest.metrics`, `playtest.compare`, `playtest.branch`, `playtest.submitReview` and `playtest.findings`. The read methods offer deterministic pagination/time ranges and return explicit `not observed`/missing artifacts rather than fabricated empty success. `metrics`/`compare` do code-owned numeric calculations; `submitReview` validates all cited IDs and schema before accepting a model's prose. `run` and `branch` require runner authorization and bounded budgets. Issue creation uses **existing AutoDev GitHub integration by the authorized root**, never an unreviewed model write tool. Expose only the minimum role-permitted commands through the RuleSync MCP tool allowlist (player: `run` and result reads; analyst: evidence/metrics/compare and review submit; root: conditional experiment and issue approval; independent validator: read-only evidence and replay-verification results). Add CLI equivalents only when a real operator workflow needs them, and do not create redundant CLI/MCP implementations.

**Required implementation validation:** Unit/contract tests for schemas, revisions, hidden-state isolation, episode completeness, evidence pagination, nonexistent citation rejection, false “success” on missing media, `null` scoring, metric denominators, paired comparisons and policy/model drift; read-only permission/blocked-write tests for both new roles; behavioral tests for both skill triggering **and** analysis quality with/without skill; adversarial examples covering a bad bot mistaken for a bad game, a correct engine with misleading visual feedback, an unreplayable RNG run, empty cohorts, a high but uncalibrated “fun” score and an LLM hallucinating an event. Acceptance is an evidence-supported analysis with appropriately qualified scores and an executable verification suggestion—not a long persuasive review.

## 7. Observability, evaluation and experience scoring

### Session analysis and AI gameplay critic — required pipeline

**Evaluation pipeline:** Combine deterministic gameplay checks with an independent evidence-grounded LLM critic. Reuse the reference projects' tested recording, replay and feedback components, and keep objective measurements separate from interpretive analysis.

**1. Record the complete player-visible experience.** For each decision, save step/revision, player-visible pre-state, legal actions and meaningful alternatives, policy intent/choice/confidence/fallback, authoritative after-state, event IDs, outcome, timing, and run/seed/game/policy version. **Jev Playtest Lab** already supplies decision validation, loop detection and audit JSONL; **jev-arcade** supplies replayable episodes and per-move state comparison; **NanoJev** supplies strict replay verification. Use their tested primitives and adapters. Keep privileged game/debug state outside the decision policy. If visual testing is enabled, reuse **PlayJev**'s frame/step/browser capture for event-triggered screenshots or clips aligned to game events. Preserve full raw traces under bounded retention, not just AI summaries.

**2. Compute facts and detect interesting moments.** Before spending LLM tokens, run cheap engine-invariant checks, crash/stall/loop detectors, resource-delta and phase-timing measurements, outcome statistics, player-understanding probes and strategy comparisons. For each episode, index exceptional windows (e.g. failure, major reversal, near-miss, repeated action, sudden resource loss) **plus representative ordinary segments**. jev-arcade's [`analysis.py`](https://github.com/CankatSarac/jev-arcade/blob/main/src/jev_arcade/analysis.py) already reconstructs decisions to compare their consequences against heuristics; extend only the general result schema and game-specific metrics. A heuristic is a reference, not ground truth; model confidence does not measure fun.

**3. Build an evidence packet for a reasoning LLM.** Provide game-authored rules and intended audience/goals; player policy/skill; exact episode outcome and measured metrics; a chronological phase summary; selected decision windows with legal alternatives, explicit event/replay IDs and optional screenshots/clips. Store the **unabridged** trace separately with indexed read-on-demand. Record precisely which segments were supplied and omitted; never silently truncate away failures or normal context. **Directly reuse JevHarness's** [full-trajectory reflection](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/reflection.py), [lossless trace codec](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/trace_codec.py) and [run storage](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/storage.py) where compatible; copy whole files if necessary under the confirmed permission. This tooling improves the **player policy**, not game quality; AutoDev still adds a separate evidence-grounded gameplay critic and result schema. 

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

**Three inputs stay visibly distinct:** (a) objective game telemetry and matched-run comparisons, (b) reasoning-model qualitative critique of evidence and design goals, (c) **consented human player feedback**, preferably using **miniPXI/PXI** or another validated instrument and tied to recorded moments where permitted, on enjoyment, friction, clarity, fairness, pacing and difficulty. The first two generate **experimental proxies**, not subjective experience measurements. As human ratings become available, evaluate inter-rater variation, measure how each proxy correlates with human-reported experiences on **held-out players/sessions**, and adjust thresholds/weights only through documented calibration. Surface disagreement instead of training a critic to rationalize the proxy. Without such validation, label the overall measure **unvalidated enjoyment proxy**, never "fun confirmed."

Use common-random-number/matched-seed comparisons when feasible; include confidence intervals and adequate samples, avoid significance claims from tiny batches, monitor multiple-comparison effects and show whether agent capability itself changed. Define explicit pass/fail only when an authoritative evaluator supplies a verdict; absent metrics/verdicts remain **Not observed** per existing Evaluations policy.

### Validated human player-experience instruments (reference outcomes, not AI proxies)

**Primary**: [Player Experience Inventory (PXI)](https://playerexperienceinventory.org/instrument), its [full instrument](https://playerexperienceinventory.org/en_f), [miniPXI (11 items)](https://playerexperienceinventory.org/en_m), [official administration/scoring guidance](https://playerexperienceinventory.org/docs), [PXI Bench](https://playerexperienceinventory.org/bdata) and [validated scale publications](https://playerexperienceinventory.org/pub). Preserve the published items, instructions and scoring where using these instruments; do not treat custom rewrites as validated versions. PXI measures functional consequences (ease of control, goals/rules, challenge, progress feedback, audiovisual appeal) and psychosocial consequences (mastery, curiosity, immersion, autonomy, meaning). Use **miniPXI for short post-session surveys** and **full PXI for periodic deeper studies**, without interpreting ten different constructs as a single objective funness value.

**Complementary, not mandatory**: [GUESS-18 validation](https://research.google/pubs/validation-of-the-guess-18-a-short-version-of-the-game-user-experience-satisfaction-scale-guess/) is a concise alternative for overall game-user satisfaction; [CORGIS](https://doi.org/10.1016/j.ijhcs.2019.102383) (30 items, four subscales) supports focused **cognitive, decision-making, performative and emotional challenge** studies. Avoid administering every long scale to every participant. The [Player Experience of Need Satisfaction (PENS)](https://doi.org/10.1016/j.ijhcs.2018.05.003) is another possible focused measure of motivation/competence/autonomy when its constructs fit the study. The [GEQ](https://pure.tue.nl/ws/files/21666907/Game_Experience_Questionnaire_English.pdf) can be a historical reference, but is **not the default**: [published factor-structure validation concerns](https://figshare.le.ac.uk/articles/conference_contribution/Systematic_Review_and_Validation_of_the_Game_Experience_Questionnaire_GEQ_Implications_for_Citation_and_Reporting_Practice/10208981) warrant study-specific justification. For human confusion and UX friction, supplement validated scales with **specific post-decision questions, open-ended comments, observed corrective attempts and moderated interviews**. Treat those project-authored questions as additional qualitative/behavioral evidence, not part of a validated scale.

**Study context is essential:** Have actual consenting humans play the **target workspace game/build**, record which features and warnings they saw, skill/familiarity, scenario, exposure duration, device/accessibility conditions and player-ID pseudonym. Link ratings to consenting sessions and moments where permitted, and report selection/nonresponse bias and observer effects. Record **pre-play expected fun**, **post-play reported experience**, and **in-the-moment frustration/confusion** as distinct labels—never mix them in one accuracy statistic. Player ratings are noisy, context-dependent reference observations, not infallible ground truth. No human data -> no claimed human calibration.

### Published funness and AI-judge comparisons (evaluation baselines)

- **[Collins et al., Nature 2026 — People use fast and flat simulation to reason about new games](https://www.nature.com/articles/s41586-026-10722-1):** The Intuitive Gamer derives **balance, reward for thinking, and expected game length** from limited-depth novice-like simulations. Its regression explained **R² = 0.57** of variance in the paper's **pre-play** human funness judgments (reported split-half human benchmark **R² = 0.60**) for the studied novel board games. **Do not transfer that R² or those fitted coefficients to RacingGame**. Reproduce the [actual source analyses](https://github.com/collinskatie/intuitive-game-reasoning/tree/main/analysis/funness) before treating novice-vs-expert-vs-random and held-out modeling as a target-game benchmark. The [post-play re-fit](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/post_play.R) covers a smaller matched subset; this is not the same estimand as the main pre-play result.
- **[Collins et al. — Evaluating Language Models' Evaluations of Games](https://arxiv.org/abs/2510.10930) (ICLR 2026):** Compares model judgments of **fairness/payoff and funness** against over 450 human judgments on over 100 novel games. Reasoning models often align better, but optimizing toward game-theoretic optimality **does not monotonically increase agreement on funness**. Benchmark `playtest-analyst` against (a) simple metrics, (b) novice-like simulation-derived scores, and (c) independent human responses; log model/reasoning budget and variability. **Do not infer that a frontier model is automatically a reliable critic.**
- **[Pedersen, Togelius & Yannakakis — Modeling player experience in Super Mario Bros (2009)](https://doi.org/10.1109/CIG.2009.5286482):** Predicts **reported fun, frustration and challenge** using design/gameplay data from 480 sessions. Its published 69.18% fun, 77.77% challenge and 88.66% frustration classification results are **task/dataset-specific**, not AutoDev accuracy targets. Reuse the feature-to-human-label and **pairwise preference-learning design**, not its platformer-specific predictor weights.
- **[Mario Personas — human-like Mario playing](https://github.com/carrotoxic/mario-personas):** Its [`aar.py`](https://github.com/carrotoxic/mario-personas/blob/main/src/evaluation/aar.py) and [`similarity.py`](https://github.com/carrotoxic/mario-personas/blob/main/src/evaluation/similarity.py) show how to **validate behavioral realism independently of winning**. Measure action agreement/divergence and policy skill before making any human-proxy claim. A good action mimic is not necessarily a good model of player enjoyment.
- **[CHI 2026 — Mining Player Experience Trends From Game Reviews Using Large Language Models](https://doi.org/10.1145/3772318.3790760):** Potentially useful taxonomy for mapping *human* open-ended feedback to PXI/CORGIS constructs. Do not use review-mined themes as a substitute for instrument scores tied to the particular build/session.

### Human-calibration and gameplay-critic validation protocol

This is a **separate evaluation of the evaluator**, not more model self-scoring. All study data belongs to the explicitly targeted game/workspace; reference datasets from other repositories are external research baselines only.

1. **Define outcomes and enroll real players.** The game-owned study plan identifies intended audience, canonical instrument (miniPXI/PXI or justified GUESS-18), optional CORGIS subscale battery, explicit *reported enjoyment*, item scoring and timing, and the consenting session-to-episode linkage. Collect player/build/scenario familiarity and feedback with an approved privacy/retention protocol. Do not ask AI agents to fabricate human responses.
2. **Freeze predictions before labels.** Run the current `playtest-analyst` **without seeing the held-out human rating or excerpts revealing it**; archive rubric version, prompt, input evidence windows, model/settings, independent critic scores, hypotheses, and estimated probability of each predicted human outcome. A second pass may classify human-written comments but must be labeled separately to avoid tautological agreement.
3. **Compare genuinely independent alternatives.** Pre-register baseline predictions from *game telemetry alone* (e.g. success, retries, choice diversity, phase duration), human-like novice simulation features (Intuitive Gamer-style balance/reward-for-thinking/length), randomly selected or expert-policy cohorts, and the LLM critic. Run ablations (no critic, no visual evidence, no player personas, rule-aware vs rule-blind critic) and disclose inference/time costs.
4. **Separate three validation tasks.** **Rating prediction:** Spearman rank agreement, error on normalized instrument dimensions and out-of-sample explained variance with intervals; **pairwise preference:** accuracy on independently rated A/B build/scenario pairs, ties and uncertainty; **diagnostic findings:** human-confirmed problem precision/recall, false-positive rate, matched evidence IDs and replay reproducibility. Add Brier score/reliability diagrams **only if a probabilistic prediction was actually emitted**. Report human–human agreement and rating variability as context, not as a fictional ceiling.
5. **Avoid leakage, overfitting and spurious significance.** Use frozen critic/rubric and **held-out participants, game versions, scenarios and seeds**, grouped so repeated episodes from one player cannot straddle train/test. Stratify novice/experienced players and scenario difficulty; estimate interval uncertainty with clustering by player and scenario, correct for repeated hypothesis testing, and retain unsuccessful/ambiguous results. Match study modality (pre-play vs post-play vs moment) and condition (real-time vs accelerated/visual-only).
6. **Iterate without evaluating on the training set.** Only recalibrate model prompts, score anchors, regression weights or thresholds on training/validation folds; freeze for a new test study. Record whether improvement **exceeds simple telemetry and novice-simulation baselines**, whether score agreement survives a game update, and whether proposed fixes improve human ratings in a blinded/counterbalanced A/B test. Correlation is not causal proof of a mechanic's effect.
7. **Gate claims:** Without human feedback, emit `unvalidated proxy`. With inadequate or single-game/single-scenario samples, emit `pilot correlation`. Claim `human-calibrated on <cohort/build>` only after independent held-out evaluation and disclosed sample sizes, intervals and baseline comparisons. Never claim universally verified “fun”; scale thresholds must be predeclared for each study rather than inferred from optimistic results.

**Agent/skill ownership:** Reuse the existing `playtest-analyst` and `playtest-analysis` skill; add a concise conditional **`references/human-validation.md`** to that skill (what labels count, research source/reuse map, frozen evaluation, criteria for evidence, hypothesis vs validated predictions). Deterministic core/data functions do questionnaire scoring, player clustering, sampling, statistics and validation status; the LLM interprets already-computed results and cites exact episodes. **Do not add a separate survey agent, another critic model tier, another analytics service or a new mandatory Python/R runtime.** Human data collection/import is an **explicitly authorized operator/user workflow**; the critic stays read-only.

**New versioned optional data contracts:** `HumanPlaytestStudy` (workspace/build, recruitment/cohort, scale/version/administration, consent/retention policy, sampling, study design, evaluation split), `HumanExperienceResponse` (pseudonymous player/session link, observed vs anticipated rating timing, exact scale/subscale, responses or score, relevant episode events, missing items), `PlayerPolicyValidity` (competence + AAR/action divergence and matched-scenario provenance when human actions exist), and `PlaytestJudgeValidation` (frozen critic version, independent labels, grouped held-out split, baselines, dimension-level metrics, uncertainty, cost, limitations and calibration status). Reuse existing `PlaytestEvidencePacket`/`PlaytestComparison` concepts and shared AutoDev data/retention infrastructure; **persist detailed episodes, findings and study data through the dedicated playtest repository**, not the existing evaluation row store. Research-source datasets live in independent benchmark fixtures, not in the user's target-game run history. The optional data-import/analysis tools must reject cross-workspace access, unauthorized raw ratings and policy-to-critic answer leakage.

**Acceptance examples:** Known-good vs deliberately confusing UI with actual matched human feedback; a weak AI that loses despite an understandable game; randomized vs expert policies with different skills; a design variant that improves win rate **but worsens human autonomy ratings**; conflicting human raters; a high-confidence critic hallucinating a visual flaw; a pre-play judgment incorrectly compared with post-play enjoyment; a suspiciously high in-sample R² that fails the held-out cohort. The system passes by **finding and reporting these mismatches honestly**, not by manufacturing improved fun scores.

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
- **Data and evaluation ownership:** **Playtesting** owns batches, episode histories, gameplay metrics, critic reports, experiments, findings and human-calibration artifacts. **Evaluations** owns source-authored formal evaluation results, verdicts and history, with links to qualifying playtest batches. **Usage/OpenLIT** owns model/provider costs and OTLP traces. Gameplay outcomes, batch execution status, formal evaluation verdicts and experience-quality assessments are distinct.
- **Console:** implement the **`/playtesting`** Observe resource with Overview/Sessions/Findings/Compare, workspace-scoped indexed queries and full-page replay/analysis. Reuse AutoDev shared UI primitives and vetted JevHarness/NanoJev/PlayJev/jev-arcade interaction code. Navigation and ownership follow the [canonical Console target state](autodev-console-target-state.md).
- **Workspaces:** enablement, allowed adapter/runner, model capabilities, resource budget, retention and GitHub publication authority are scoped to the target workspace through canonical AutoDev configuration.
- **OpenLIT:** standard OTLP traces, metrics, GenAI inference cost/latency and worker health; do not create a second observability backend or overload traces with gameplay video.
- **Security:** allowlisted sandboxed game runners; no secrets sent to game/model logs; rate/time/memory/GPU budgets; explicit permissions for issue writes; preserve readable/replayable evidence and failure transparency.
- **No source changes:** playtest runners and analyst agents should produce artifacts/findings, not secretly patch gameplay, change rewards or merge PRs. A separate authorized development task may use reported evidence.

### Playtesting Console UX

**Resource design:** **Playtesting** is the top-level **Observe** resource at `/playtesting`, using AutoDev's shared dark Next.js shell and design system. It owns workspace-scoped test execution, evidence, analysis and developer investigation. Views use dedicated Playtesting data/URL contracts and the shared Console components. The [canonical Console target state](autodev-console-target-state.md) defines navigation and UI-wide conventions.

**Navigation and URLs:** Register **Observe → Usage | Evaluations | Playtesting | Memory** in [`core/src/navigation.ts`](../core/src/navigation.ts) and use [`canonicalSectionFromPath`](../console/src/lib/routes.ts) to highlight **Playtesting** for `/playtesting` and child routes. `/playtesting` opens **Overview**, with **Sessions | Findings | Compare** as compact view navigation and conditional **Human validation** within Compare. Filtered views use shareable URLs such as `/playtesting?view=findings&workspace=<id>&build=<sha>`. Episodes open at `/playtesting/sessions/[id]?step=<n>&workspace=<id>`, and findings support `/playtesting/findings/[id]` deep links or compact `DetailDrawer` previews. A Playtesting URL helper preserves workspace/build/filter/step state across refresh, Back and view changes; the session inspector uses sections and disclosure for advanced details.

**Ownership:** **Playtesting** owns execution request/status, batch/episode evidence, session inspector, outcome statistics, critique, scoring, comparisons, controlled replay, findings and human-validation aggregates. **Workspaces** owns permitted adapter/runner setup, workspace enablement and resource budgets; **Providers** owns model configuration; **Permissions** owns policies; **Evaluations** owns formal results/verdicts; **Usage/OpenLIT** owns model/agent telemetry; **GitHub** owns external issue state. Other resources offer read-only context and links, not cloned controls. Only the explicitly selected game/workspace is tested; reference/demo games remain separate fixtures.

**Keep four independent meanings visible:** batch execution (`queued/running/completed/failed/cancelled/truncated`), gameplay result (`win/loss/DNF/other`), formal evaluator verdict (`Passed/Failed/Not observed`), and experience/critic status (`hypothesis/unvalidated/pilot/calibrated`). An AI loss does not imply a failed runner or failed formal evaluation; AI funness estimates do not automatically acquire a pass/fail verdict.

| Surface | What the developer sees by default | Drill-down and action |
| --- | --- | --- |
| **Overview** | Selected game/workspace, build, batch state; compact completed/failed/truncated counts, game-incident count, replay integrity, coverage and verified findings with denominators and baseline comparisons. | **Inspect sessions** / **Review findings**. Authorized new-run request includes cohort/scenario/budget preview and server-confirmed state. No unsupported composite “fun score.” |
| **Sessions** | Indexed, **server-filtered/cursor-paginated** batches and episodes by build, seed, scenario, policy/cohort, duration, result, replay integrity and review status; invalid/partial samples remain countable. | Open **`/playtesting/sessions/[id]`** for a full-width, synchronized event/decision timeline and actual replay/frames: what player saw, chose, expected and experienced; lazy evidence windows, scrub/jump-to-event and explicit missing-media states. |
| **Findings** | Prioritized verified defects, corroborated concerns and unverified hypotheses, each with severity, affected runs/denominator, evidence level, concise implications and issue status. | Small preview drawer or `/playtesting/findings/[id]`; jump to the exact cited session+step/frame, alternative explanation, test outcome and authorized retest/reviewed GitHub issue. |
| **Compare** | Two or more builds, policies or matched cohorts with sample sizes, seed-matching/uncertainty, outcome deltas and optionally a focused heatmap/trend. | Open paired replay/experiment results; optional Human validation disclosure shows separately measured PXI/miniPXI labels, agreement, confidence intervals, baseline models and calibration status. |

**One developer investigation:** choose game workspace → scan the summary and high-impact findings → select a finding → open the referenced full-page replay at its exact cited event → compare model perception/action/forecast against observed result and controlled alternatives → validate or request a bounded rerun → optionally link a reviewed GitHub issue → return to the same filtered finding list. All facts must cite the authoritative episode/frame. Avoid walls of redundant cards or multi-level tabs.

**Example information architecture** (illustrative UI labels, not measured data):

~~~text
Observe        Usage | Evaluations | Playtesting | Memory
Playtesting    Workspace [target game]  Build [SHA]  Time [range]
               Overview | Sessions | Findings | Compare

/playtesting                         batch status, outcome metrics, top findings
/playtesting?view=findings            ranked findings, evidence links
/playtesting/sessions/[id]?step=<n>  full-page synchronized replay/decision evidence
/playtesting?view=compare             matched cohorts/builds and human validity

[Run outcomes] [Coverage] [Verified issues]    [Compared with baseline]
Top findings                                 Recent sessions
~~~

### Data contracts, storage and Console integration

**Playtesting persistence:** Use a typed playtest repository in AutoDev's `data/` workspace. `data/src/playtesting/` indexes `PlaytestBatch` (workspace, target build, config hash, policy cohort, budgets, progress/outcomes), `PlaytestEpisode` summary (batch, seed/scenario, policy version, result, replay health), `PlaytestFinding`, reviews, comparisons and optional human-study records. Raw replay JSONL, frames/video and evidence packets are immutable, bounded, content-addressed artifact references with retention and integrity validation, **not** embedded in evaluation scores or OTLP spans. Prefer existing AutoDev/OpenLIT/ClickHouse storage services when their contracts support indexed playtest queries, without forcing everything into `openlit_evaluation` or introducing another service. The implementation chooses and documents the indexed tables/artifact storage contract.

**Proposed typed read/control contract** in Core/Runtime/Data plus `console/src/lib/server/playtesting.ts`: `listBatches`, `getBatch`, `listEpisodes`, `getEpisode`, `readEpisodeWindow`, `listFindings`, `getFinding`, `compare`, `humanValidationSummary`, and separately authorized `requestPlaytest`/`requestReplay`. Route through existing authenticated Control API conventions and scoped permissions. Filter workspace/build/batch/scenario/cohort/policy/date/status **before** aggregating or paging; support stable cursor/keyset pagination, bounded limits, source-owned total/invalid/incomplete counts, and explicit data-source errors. Do not calculate global win/crash percentages from one loaded page or silently map unknowns to `0`. Detail/window requests fetch only the selected episode/steps and media references; never load all traces/frames to list the sessions.

**Evaluation and telemetry linkage:** A playtest batch may emit an `EvaluationResult` for an explicitly defined evaluator (e.g., a game invariant with an authoritative pass/fail threshold), linked by `workspaceId`, `batchId`, `evaluationId` and optional OTLP span IDs. Individual episodes, gameplay losses, critic ratings and uncalibrated enjoyment predictions belong in Playtesting. Formal verdicts remain source-authored evaluation assertions; Usage/OpenLIT spans provide linked inference telemetry.

**Next.js composition:** Implement `console/app/playtesting/page.tsx`, `console/app/playtesting/sessions/[id]/page.tsx`, optional `console/app/playtesting/findings/[id]/page.tsx`, `console/src/features/playtesting/` views/URL helpers and a typed server adapter. Reuse [`ConsolePageShell`](../console/app/_console.ts), [`core/src/navigation.ts`](../core/src/navigation.ts), shared dark tokens and table/filter/stat/drawer/chart components. Implement the replay scrubber as a bounded client island; render lists and aggregates from source-backed server queries.

**Acceptance:** **Playtesting** is an accessible top-level Observe item for all `/playtesting` routes; finding → cited full-page session/step → Back restores workspace, filtered state and focus; 10,000+ episodes support indexed source-filtered pagination with accurate counts and denominators; source errors and missing frames remain explicit; actions are authorized and server-confirmed, and human data remains private. Browser tests cover keyboard navigation, mobile layout, contrast, replay controls and fast view switching. Implementation status and rollout evidence belong in [the Console migration tracker](autodev-console-migration.md).

### Direct UI/component reuse — audited source map

**Use AutoDev's shared TSX primitives** inside `console/src/features/playtesting/`:

| Existing AutoDev source | Use unchanged or extend narrowly |
| --- | --- |
| [`ConsolePageShell`](../console/app/_console.ts), [`TraceStatus`](../console/src/components/traces/TraceStatus.ts), [canonical navigation](../core/src/navigation.ts) | Use the existing page shell, trace status presentation and canonical resource navigation directly; link sourced evaluation assertions and Usage spans through their owning resources. |
| [`TabNav`](../console/src/components/tabs/Tabs.ts), [`FilterBar`](../console/src/components/filters/FilterBar.ts), [`DataTable`](../console/src/components/tables/DataTable.ts), [`Pagination`](../console/src/components/navigation/Pagination.ts) | Resource/view navigation, filter controls, result lists and paging. Extend URL helpers instead of new client-only tabs/search state. |
| [`StatCard`](../console/src/components/cards/StatCard.ts), [`StatGrid`/`DetailGrid`](../console/src/components/panels/DetailGrid.ts), [`BarChart`](../console/src/components/charts/BarChart.ts) | High-signal summary metrics, score dimension breakdown, comparisons and available bar summaries; use their established **Not observed vs 0** treatment. |
| [`DetailDrawer`](../console/src/components/panels/DetailDrawer.ts), [`StatusBadge`](../console/src/components/status/StatusBadge.ts), [`EmptyState`](../console/src/components/status/EmptyState.ts), [`AppNav`](../console/src/components/navigation/AppNav.ts) | **Compact finding previews**, confidence/status, missing-data states and existing sidebar identity; the **full session inspector is a route**, not a drawer. Reuse existing accessible, dark tokenized styling. |

**Upstream visualization reuse:** Adapt suitable data formatting, visualization calculations and replay interactions from the referenced source files into typed TSX components. The source projects provide JavaScript/HTML interfaces; extraction should preserve tested behavior and use AutoDev's own shell, tokens and accessible controls. Record source commit, reused functions, destination component and behavioral tests in the reuse ledger.

| Upstream source and existing view/implementation | Reuse/adapt in AutoDev Playtests | Keep vs discard |
| --- | --- | --- |
| **[JevHarness Research Console](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/auto_jev/static/index.html)** — functions **`renderHeat`**, **`renderEpisodeCards`**, **`renderTimeline`**, **`renderDecision`**, **`renderLineage`**, **`renderReflection`** | **First choice for candidate × episode heatmap**, decision/node execution timeline, selected-run detail and policy-evolution/reflection inspection. Directly reuse relevant rendering/selection algorithms and evidence shape; port only the DOM/rendering glue into small typed TSX components in the **dedicated session inspector** or Compare view. Use `DetailDrawer` only for small previews and `DataTable` for source-visible comparison rows. | Do **not** import the original single-file console, its white/light theme, trading-specific candlestick/scatter views, investor metrics or its polling/page shell. The heatmap belongs in **Compare**, the execution trace belongs in **Session details**. Code-reuse permission for JevHarness already confirmed. |
| **[JevHarness battle highlights](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/examples/pokemon/static/highlight-demo.js)** + [verified replay binding](https://github.com/TianyuCodings/JevHarness/blob/34d5c9602f6f73792e2c625cc31dd9ed7b4f39b5/examples/pokemon/static/highlight-replay.js) | **Extract chapter/event navigation, pause/preview/step interaction, decision probabilities and replay hash/integrity checks** where engine-compatible; evidence selection keyed by stable replay/episode/step IDs. | Pokémon Showdown renderer/protocol and embedded `iframe` are **not game-neutral**. Use AutoDev frame/video evidence UI or a target-provided verified renderer, not a copied game-specific iframe. |
| **[NanoJev Decision Lab UI](https://github.com/TianyuCodings/NanoJev/blob/76fdfc9ecdca45a9bcef17991a07d3041a87685a/web/app.js)** + [view markup](https://github.com/TianyuCodings/NanoJev/blob/76fdfc9ecdca45a9bcef17991a07d3041a87685a/web/index.html) — **`renderProbabilities`**, **`renderStep`**, **`renderEpisodes`** | **Extract per-action probability bars, legal/selected alternatives and step-selection/readout logic** into Session inspector; reuse existing `BarChart` for bars where sufficient. Preserve the difference between *reported action probability* and *measured win probability*. | Game-board renderer and the standalone app tabs/HTTP live playground are examples, **not** generic widgets. No extra theme/layout or another model-control screen. |
| **[PlayJev replay and charts](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/demo/demo.js)** + [responsive chart styles](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/demo/demo.css) + [recorded-action bridge](https://github.com/OmniJev/PlayJev/blob/ea3a514d2fcbc0756c36eabe052439db54544542/demo/pj_bridge.js) | **Extract confidence-over-episode trace, synchronized action/step cursor, paired-replay progress, bar comparisons and SVG calibration-chart computations** where source data supports them; rebuild only a thin accessible TSX/SVG presentation with Console tokens. When applicable, reuse the existing vetted bridge/renderer **inside an isolated game adapter**, not the Console shell. | Do not embed PlayJev's demo website, copy its light palette or imply its **teacher-agreement calibration chart** predicts *human fun*. Run genuine game playback where a verified renderer exists; otherwise use recorded frames/clips, not reconstructed imagined graphics. |
| **[jev-arcade browser side-by-side demo](https://github.com/CankatSarac/jev-arcade/blob/e1655135b038c2d5d7f56b2854f22d5b112cb382/src/jev_arcade/web/static/index.html)** — **`drawMeta`**, **`drawBars`**, comparator presentation | Optional **paired policy/seed comparator** and confidence/progress readouts for Compare; reuse small comparison/formatting functions if generic, inside existing `DataTable`/`BarChart`. | Board drawings and DOM-bound streaming UI assume its own registered games; no generic automatic game renderer. |
| **[Intuitive Gamer model analyses](https://github.com/collinskatie/intuitive-game-reasoning/tree/main/analysis/funness)** — [held-out comparisons](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/generalization_test.R), [post-play calibration](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/post_play.R) | **Use its real statistics/output as data, not a second web dashboard**: Human validation may render agreement intervals, held-out-vs-in-sample bars and predicted-vs-human plots in the Console. | R output figures/notebooks are reproducible offline references; do **not** present their board-game model scores as target-game observations. |
| **[PXI / miniPXI / PXI Bench](https://playerexperienceinventory.org/docs)** | Use official instrument semantics, dimension labels and benchmark/scoring guidance; display **human dimension scores vs AI predictions** with coverage, cohort and uncertainty. | No reusable public React component/API has been confirmed; **do not claim component-level reuse**. Recreate only compact presentation in AutoDev's shared components after verifying actual reuse rights/source. |

**Reuse acceptance:** Each implemented UI feature must include a compact **source-to-component mapping** (file + upstream commit + specific function/interaction reused, direct import vs copied file vs narrow port, destination file, original behavior tests and integration tests). Provide a screen or component test demonstrating the reused logic **against a real AutoDev `PlaytestEpisode`/`PlaytestComparison`**, not merely a screenshot of the upstream demo. Prefer upstream code for **interactions and visualization math** and AutoDev shared primitives for **styling, navigation, status, data fetching and accessible semantics**. Do not copy five different chart/table implementations or embed remote dashboards/iframes.

### Visualizations, data provenance and interaction rules

- **Overview:** default to 3–5 compact `StatCard` facts and **one** focused trend or distribution when real data exists. Distinguish test **execution health** (crash rate, completed runs, coverage) from **gameplay outcomes** (loss, DNF, economy, policy success) and **interpretive quality** (critic hypothesis, provisional 0–4 dimension scores, calibrated human agreement). A gameplay loss is not a runner failure; a critic score isn't an engine verdict.
- **Sessions / replay:** synchronize event markers, decision cursor, probability bars, pre/post state, critic citations and **actual** recorded frames/clip timestamps; click a marker or cited step to update every synchronized pane and the URL. For headless sessions show a structured state/event view, **not fabricated video**. Visually distinguish screenshot, real-time capture and accelerated/headless model observation; absent or unreplayable media has an explanation. The game-specific renderer stays with its adapter; the generic Console only hosts verified evidence.
- **Findings:** prioritize **reproducible defects** and high-impact recurring issues ahead of isolated subjective critiques. Show **status, severity, frequency (with denominator), confidence/evidence, and a one-sentence explanation**, not a large ungrounded “AI insights” paragraph. A finding's hypothesis, measurements, counterexamples and suggested experiment are independently visible. Dismissed/duplicate findings stay traceable, not silently removed.
- **Compare:** a **matched-seed/cohort heatmap** (JevHarness-style) is optional when it actually clarifies a multidimensional comparison; always offer the underlying accessible table, explicit count/uncertainty, and row-to-session links. Only render line charts for meaningful sequences (learning across episodes, change over builds, position/Heat across decisions). Plot confidence calibration against the **same defined criterion** (e.g. correct consequence forecast vs actual, teacher-action agreement, or human enjoyment label); these are separate charts, never one mislabeled accuracy number.
- **Scoring:** show 0–4 quality dimension assessments **with their evidence IDs, coverage and rationale**, then human PXI/miniPXI scores **as a separate measure**. An optional combined score must state experimental status and human calibration. No red/green “pass” from inferred 0–100 fun score; default to neutral score display and explicit *Not observed* when evidence missing. Annotate correlations with held-out status, human respondent count, confidence intervals and baselines.
- **Time and performance:** use indexed, **server-filtered and cursor-paginated** summaries from `data/src/playtesting/`, not bounded in-memory pagination of evaluation-result rows; compute cohort comparisons, trends, confidence bins and aggregate status in **data/core** rather than in browser or LLM. Load trace frames, recordings and experiment detail only upon selecting a run/finding; avoid shipping thousands of complete episode traces to the client or rendering thousands of DOM rows/SVG points. Progressive loading should have explicit pending/error/partial coverage states and stable, shareable URLs; view/tab switches should use existing in-place navigation (no full document refresh), with a target of perceptually immediate transitions.
- **Operator trust, security and accessibility:** server-authoritative actions with explicit permission, bounded budgets and confirmation on issue writes; clear errors on failed reruns; no optimistic “verified” status. All controls keyboard-operable, persistent labels/visible focus, semantic lists/tables, text alternatives to visual charts, color plus text statuses, and responsive stacked session panels. Protected human data is represented by aggregate/cohort labels and anonymized counts; no raw participant IDs or identifiable survey text in default views. Charts must respect the Console's **dark-only semantic tokens** and WCAG contrast.
- **Operator acceptance tests:** test a healthy run with no findings, no configured game adapter, interrupted/malformed/partial runs, one reproducible defect, an unverified critic hypothesis, absent frames, player-policy/model drift, matched and unmatched comparisons, hidden-state exposure, no human ratings, genuine human rating disagreement, invalid trace/event links, unauthorized rerun/issue request, 10k indexed episodes, keyboard/mobile navigation, and stable filter→finding→session→back flow. Test which borrowed function actually executes in the built Console; benchmark tab changes, paginated queries and replay selection.


## 10. Reuse-first delivery slices and acceptance gates

| Phase | Concrete reuse and limited customization | Acceptance evidence |
| --- | --- | --- |
| **1. Recorder and runner** | Implement the game-owned adapter with versioned JSON-RPC/stdio, player-visible schema checks and approved execution sandbox; add `playtester` role and `game-playtesting` skill; execute compatible upstream Jev Playtest Lab validators/loop guards. **jev-arcade fixtures are optional and do not satisfy production integration.** | Demonstrate one real selected-game episode/replay, event legality, evidence provenance, protocol and security cases, and actual code reuse where compatible |
| **2. Analyzer and critic MVP** | Add read-only `playtest-analyst` role, `playtest-analysis` skill, indexed evidence-reading tools, and **directly reuse authorized JevHarness reflection/trace/storage modules** with jev-arcade analysis where compatible | Full run -> source-verified timeline -> null-safe anchored scoring -> event-cited reasoning critique -> testable hypothesis; malformed citations and missing evidence rejected |
| **3. Local AI and comprehension cohorts** | Optionally enable NanoJev via original `/api/evaluate` only after translated target-game state/action, legal-action and held-out competence/latency tests versus heuristics; selectively use JevHarness's actual reflection/evolution/frozen-policy code | Record eligibility, measured costs/accuracy and named fallback/unsupported states, plus genuinely executing upstream modules where useful |
| **4. Hypothesis experiments and issues** | Reuse existing batch-summary Evaluations links, GitHub pipelines, benchmarks and replay; add critic-proposed controlled tests, branching/optional A/B coordination and deduplication | Tested explanation distinguishes avoidable loss, insufficient warning, poor model comprehension and intended difficulty; one verified actionable finding |
| **5. Visual critique and human calibration** | Enable PlayJev `GamePage`/`VecGame` only for hook/virtual-clock compatible target games; for all other browser games **reuse AutoDev `browser-tester`/Playwright for real-UI input and original-resolution real-time capture**. Optional human feedback is separately consented. | Verify authoritative UI screenshots/steps and accessibly rendered warnings; no audiovisual/legibility conclusions from PlayJev's muted/accelerated frames, and report incompatible backends as unsupported |
| **6. Human-validation and baseline proof** | Run published [Intuitive Gamer R fitting/generalization](https://github.com/collinskatie/intuitive-game-reasoning/tree/main/analysis/funness) **only as an optional offline research reproduction**; separately import target-game miniPXI/PXI/human labels and validate the frozen critic against simple baselines on held-out target-game cohorts | Research fixture does not gate routine production playtesting; a human-calibrated claim requires actual target-game holdout data, intervals, baseline comparison and honest uncertainty |
| **7. Playtesting resource, Console UX and findings** | Implement **top-level `/playtesting` and `/playtesting/sessions/[id]`**, indexed Playtesting read model/feature, shared Console components and source-mapped **JevHarness/NanoJev/PlayJev/jev-arcade** UI logic | Distinct Playtesting sidebar identity; target workspace → finding → full-page step replay → compare → reviewed action; real upstream code reuse, accurate 10k+ pagination, truthful evidence/status, keyboard/mobile and fast navigation |
| **8. Portability** | Run a second, mechanically different game with same AutoDev infrastructure | Only game adapter/scenarios/rubric change; no gameplay logic leaks into AutoDev |

**First milestone:** **1,000 authoritative target-game headless episodes** (later 10,000) fully recorded and deterministically evaluated, with two independent policies. With `maxReviewedSessions: 40`, **at most 40 complete-session LLM critiques** are selected via declared representative sampling of normal + anomalous runs, cited by exact episode/event IDs. The remaining episodes are explicitly `deterministic-only` with review coverage, denominators and missing data reported. Include bounded pre-action expectation probes, matched-cohort comparisons, null-safe provisional dimension scores and a reproduced or clearly unverified hypothesis. Verify roles/skills, budget, true end-to-end evidence and measured costs.

## 11. Decisions to resolve during implementation

- Which adapter transports and engines to support in v1 beyond stdio JSONL, and where the game runner sandbox lives.
- Which local NanoJev checkpoint, inference server/API and model-weight license pass quality and operational testing; whether a non-model heuristic wins on cost/performance.
- Artifact storage and retention quotas for locally launched runs vs CI; handling intentional game nondeterminism and performance-test noise.
- Which evaluators have game-owned pass/fail thresholds, which offer only proxy scores, how critic/probe evidence is sampled without selection bias, and what consenting human ratings support held-out calibration. Prefer miniPXI/PXI; use CORGIS/GUESS-18 when their specific construct matches the research question. Pre-play estimates and post-play reports are different outcomes.
- How each engine supports checkpoints, alternate legal actions, RNG continuity and hidden-information limits for counterfactual claims.
- Enforce the Section 2 upstream-use ledger and smoke-test **actual upstream code paths**, including pinned file/model hashes, before accepting replacement implementations. **JevHarness code copying and adaptation are authorized**. **jev-plays-balatro remains permission-gated.**
- What evidence permits deterministic bug publication versus required review for balance/design/fun findings, and what independently held-out human evidence justifies advancing an AI critic from experimental proxy to calibrated estimate.
- Which verified game-specific visual replay renderer can be hosted without embedding a second dashboard/iframe; whether recorded frame/clip evidence is sufficient for the first Console implementation. Decide how to index the playtest read model and store replay artifacts using existing infrastructure, **without forcing detailed gameplay into flat OpenLIT evaluation rows**. Choose one tested interaction extraction per missing chart/control, not several redundant UI frameworks.

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

### Player-experience measurement

- [PXI theoretical model and constructs](https://playerexperienceinventory.org/instrument), [full PXI](https://playerexperienceinventory.org/en_f), [miniPXI](https://playerexperienceinventory.org/en_m), [scoring/administration guide](https://playerexperienceinventory.org/docs), [PXI Bench](https://playerexperienceinventory.org/bdata), [PXI and miniPXI validation papers](https://playerexperienceinventory.org/pub).
- [GUESS-18 — short validated game satisfaction measure](https://research.google/pubs/validation-of-the-guess-18-a-short-version-of-the-game-user-experience-satisfaction-scale-guess/).
- [CORGIS — perceived challenge subscales, IJHCS 2020](https://doi.org/10.1016/j.ijhcs.2019.102383).
- [PENS and GEQ factor-analytic validation](https://doi.org/10.1016/j.ijhcs.2018.05.003); [GEQ questionnaire](https://pure.tue.nl/ws/files/21666907/Game_Experience_Questionnaire_English.pdf) and [critical psychometric review](https://figshare.le.ac.uk/articles/conference_contribution/Systematic_Review_and_Validation_of_the_Game_Experience_Questionnaire_GEQ_Implications_for_Citation_and_Reporting_Practice/10208981).

### Empirical funness, human-behavior and critic validation

- [Collins et al. 2026, Nature — People use fast and flat simulation to reason about new games](https://www.nature.com/articles/s41586-026-10722-1); [MIT source, human data and model implementation](https://github.com/collinskatie/intuitive-game-reasoning); [funness models](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/main_funness_model.R), [helpers](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/setup_helpers.R), [generalization](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/generalization_test.R), [post-play ratings](https://github.com/collinskatie/intuitive-game-reasoning/blob/main/analysis/funness/post_play.R); [original model-run data](https://zenodo.org/records/21348139).
- [Collins et al., ICLR 2026 — Evaluating Language Models' Evaluations of Games](https://arxiv.org/abs/2510.10930).
- [Pedersen et al. 2009 — Modeling player experience in Super Mario Bros](https://doi.org/10.1109/CIG.2009.5286482).
- [Arimura et al., CoG 2026 — Mario Personas](https://github.com/carrotoxic/mario-personas); [action agreement/divergence evaluator](https://github.com/carrotoxic/mario-personas/blob/main/src/evaluation/aar.py), [comparators](https://github.com/carrotoxic/mario-personas/blob/main/src/evaluation/similarity.py).
- [CHI 2026 — Mining Player Experience Trends From Game Reviews Using LLMs](https://doi.org/10.1145/3772318.3790760).
- [OpenSpiel — game-theoretic analysis](https://github.com/google-deepmind/open_spiel); [Ludax — accelerated board-game simulators](https://github.com/gdrtodd/ludax), [paper](https://arxiv.org/abs/2506.22609).

- [AutoDev orchestration skill](../.rulesync/skills/orchestration/SKILL.md)
- [AutoDev Console Target State](autodev-console-target-state.md)

