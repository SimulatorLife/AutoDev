---
name: playtest-analysis
description: Trigger only when asked to review, interpret, score, compare, diagnose, or verify an existing recorded gameplay session or trace (e.g. "analyze this playtest", "analyze this existing trace", "was this run confusing", "compare these two builds"). Owns the 8-step evidence-grounded review procedure, null-safe scoring, and experiment proposals. Not for executing/playing/simulating a game (use game-playtesting) or for ordinary code changes or GitHub issue creation.
targets: []
---

# Playtest Analysis

Turn a recorded gameplay session into an evidence-linked review, not an unsupported fun verdict. This skill owns interpreting play; it does not run episodes and does not publish issues.

## AutoDev tool invocation

Provider-agent roles run in AutoDev Code Mode. Use the `exec` JavaScript tool for MCP operations and call only exact `tools.mcp__<server>__<tool>` names advertised in `ALL_TOOLS`. The dotted names in this skill (for example `playtest.prepareReview`) describe MCP operations; they are not direct top-level provider functions. Resource listing does not enumerate available tools. Use only tools enabled for this role; do not invoke shell, filesystem, network, or another role's capabilities.

## Strict `submitReview` shape

`playtest.submitReview` rejects unknown keys. Required top-level inputs are `episodeId`, `packetId`, `packetArtifactId`, `packetSha256`, `chronologicalSummary`, `status`, `evidenceRefs`, `observations`, `interpretations`, `alternativeExplanations`, `reportCompleteness`, `experiments`, and `rubricHash`. Each observation and interpretation is exactly `{text, evidenceRefs}`. `dimensionEvidence` and `notes` are optional. Runtime derives authoritative metrics, anchor categories, provenance, author/version/timestamps; do not submit those fields. Use `hypothesis` or `not observed` for status.

`reportCompleteness` has **exactly** these four keys; it is not a second copy of the ten narrative report sections:

- `crossSessionContext`: `{status: "available", evidenceRefs: [{kind: "episode", id: "<packet-supplied sibling episode ID>"}]}` when sibling episode summaries were supplied, otherwise `{status: "unavailable", reason: "<packet-specific reason>"}`. This per-session field uses whole-episode locators only; cross-session synthesis triples `{episodeId, packetId, locator}` belong only to `playtest.submitCrossSessionSynthesis`.
- `alternatives`: `{status: "provided"}` exactly when the top-level `alternativeExplanations` array is non-empty; otherwise `{status: "none-identified", reason: "<why none can be identified from this packet>"}`.
- `experiments`: `{status: "proposed"}` exactly when the top-level `experiments` array is non-empty; otherwise `{status: "none-recommended", reason: "<why none is recommended>"}`.
- `followUp`: `{status: "proposed", text: "<next investigation>"}` or `{status: "none", reason: "<why no follow-up is needed>"}`.

For a new review, do not use historical `not-recorded` statuses. Do not add keys such as `text`, `summary`, `detail`, `available`, `count`, or section names to `reportCompleteness`. Per-session experiment entries have exactly `hypothesis`, `falsifier`, `metricId`, `controls` (a non-empty string array), and `budget`; citations belong in claims and top-level `evidenceRefs`, not in the experiment object. `dimensionEvidence` entries use `dimensionId`, `rationale`, `evidenceRefs`, and optional `counterexampleId`. `findings` is a separate strict structure with `identity.mechanicKey`, `identity.failureSignature`, and `identity.scope`; omit `findings` unless a packet-grounded candidate satisfies that contract. Put ordinary observations and hypotheses in `observations` and `interpretations` instead.

For a one-session packet with no supplied sibling summaries, no identifiable alternative, and no recommended experiment, a valid example is:

```json
{
  "crossSessionContext": {
    "status": "unavailable",
    "reason": "<packet-specific reason>"
  },
  "alternatives": {
    "status": "none-identified",
    "reason": "<evidence-grounded reason>"
  },
  "experiments": {
    "status": "none-recommended",
    "reason": "<evidence-grounded reason>"
  },
  "followUp": { "status": "proposed", "text": "<next investigation>" }
}
```

Replace every placeholder with packet-specific text; do not copy placeholder text. When arrays are non-empty, `alternatives` is exactly `{ "status": "provided" }` and `experiments` is exactly `{ "status": "proposed" }` (neither variant accepts a `reason`). When no follow-up is needed, use `{ "status": "none", "reason": "..." }`. For `crossSessionContext.available`, `evidenceRefs` are whole-episode locators `{ "kind": "episode", "id": "<packet-supplied sibling episode ID>" }`; do not use batch-synthesis `{episodeId, packetId, locator}` triples in a per-session review. `dimensionEvidence` entries use only `dimensionId`, `rationale`, `evidenceRefs`, and optional `counterexampleId`. `findings` is a separate strict structure with `identity.mechanicKey`, `identity.failureSignature`, and `identity.scope`; omit `findings` unless a packet-grounded candidate satisfies that contract. Put ordinary observations and hypotheses in `observations` and `interpretations` instead.

## Trigger

Use this skill when the request is to review, interpret, score, compare, diagnose, or verify an existing recorded gameplay session or trace (e.g. "analyze this existing trace", "score the agency dimension for episode 17", "compare the aggressive and conservative cohorts on build X").

Do not use this skill for:

- Executing, playing, or simulating a game -- that is game-playtesting.
- Fixing code, game logic, metrics, or configuration -- ordinary coding skills apply instead; this skill never rewrites evaluation rules or source.
- Creating or publishing a GitHub issue -- publication goes through the root orchestrator's existing GitHub integration, never this skill directly.

### Negative trigger examples

Do not trigger for requests such as:

- "play ten episodes of the target game" (execution/simulation task, use game-playtesting)
- "run a playtest batch" (execution/simulation task, use game-playtesting)
- "fix this code so the build passes" (source code repair, use standard engineering skills)
- "file a GitHub issue for this bug" (root issue publication)

## Non-goals

- No single-number 0-100 "fun" score, and no substituting model confidence or win rate for an experience score.
- No running, branching, or modifying gameplay; use only the evidence the runner already produced.
- No GitHub issue creation -- propose findings/hypotheses only.

## Workspace and build authorization gate

Enforce the authorized workspace and build gate: inspect only evidence originating from explicitly authorized workspaces and verified checkout/build SHAs. Reject cross-workspace data access, unapproved game builds, or unverified traces.

## The 8-step review procedure

Full normative detail: docs/playtesting-target-state.md section 6 ("Required playtest-analysis skill: how to read and interpret a session").

1. Obtain and verify the frozen critic input. For a selected session, call `playtest.prepareReview` first. Check its packet's workspace/build/policy/rubric identity, completeness, selected-window reasons, source-trace hash, visible-vs-privileged state, and omitted/missing artifacts. The packet is the citation boundary for `submitReview`; do not substitute ad hoc trace reads or cite evidence that is absent from it. Name missing evidence instead of filling it in.
2. Reconstruct decisions in context. For each sampled key moment: before-state, player-visible rules/alerts, legal alternatives, chosen action, stated intention/prediction (if collected), and authoritative after-state.
3. Separate observations from interpretations. Deterministic evaluators establish what happened; you suggest why it may be a problem, against the target game's own goals, not universal norms.
4. Evaluate both interesting and routine play. Sample abnormal moments and representative ordinary phases; distinguish novice learning failure, strong-policy dominance, bad AI calibration, intended difficulty, and actual usability defects.
5. Handle experience dimensions honestly. The current `submitReview` input accepts dimension-specific rationale and evidenceRefs, not a model-authored numeric score; Runtime derives any registered anchor category from deterministic metrics and the game-owned rubric. For P1.5 visual discovery reviews, do not score dimensions. If a dimension is unsupported, say so explicitly; never emit a placeholder category or add `score`/`value` fields to `dimensionEvidence`.
6. Compare when necessary. Use code-computed aggregates before explaining group patterns -- see references/comparisons.md. In a Runtime-dispatched multi-session review, use the Runtime-supplied selected-session metric aggregation as descriptive ratio-of-sums within its exact build/scenario/policy/cohort/metric strata. This descriptive statistic is not a matched-seed effect, confidence interval, or population estimate. Do not recompute it, average episode percentages, infer a matched-seed effect, or treat selected sessions as a population sample. `playtest.compare` is the separate stored comparison read; a single session or descriptive aggregate cannot establish a systemic trend.
7. Propose discriminating experiments. For each high-value concern: competing causes, a minimal test, metric, controls, budget, and what would refute the theory. Request execution via the root; you cannot run it yourself.
8. Publish an evidence-linked review artifact. Separate verified bug vs statistically supported regression vs unverified game-design hypothesis; submit with `playtest.submitReview`, carrying the exact packet ID, packet artifact ID, and SHA-256 from step 1 -- see references/session-review.md. Never produce a GitHub issue directly.

## Required report sections

Every submitted review has: provenance/coverage, chronological episode summary, authoritative metrics, scored experience dimensions, evidence-linked observations, alternative explanations, cross-session context (or an explicit unavailable reason), testable hypotheses/experiments (or a reason none is recommended), an evidence-status decision, and suggested follow-up (or a reason none is needed). For a Runtime-dispatched selection with at least two available packets, use the Runtime-computed aggregate attached to the task, then submit one separate batch-level synthesis after the independent session reviews. Aggregate claims still cite exact episode+packet+locator triples from the contributing frozen packets; the synthesis remains hypothesis-only and does not replace or upgrade any per-session review. Aggregation is unavailable for unsupported semantics, historical packets, or bounded-output overflow; report those states rather than dropping rows. Packet v3 freezes each metric's aggregation and independent-unit intent; packet v1/v2 history remains readable but is not silently pooled. Packet sibling context may include up to four seeded episodes from the same complete batch/build; this is not an aggregate or population estimate. Cite only supplied sibling episode IDs as whole-episode references; never invent sibling steps, events, or cohort claims. `playtest.submitReview` enforces coherent `reportCompleteness` states against its packet and the alternative/experiment lists. Current submission status must be `hypothesis` or `not observed`; independent verification/corroboration is not implemented. This prevents silent omission; it does not establish analysis quality or independent validation. A review without evidence locators is invalid, not a successful empty report.

## Null-safe evidence and scores

- Insufficient evidence is null, never a mid-scale category. Uncertainty is not category 2.
- P1.5 visual discovery reviews are hypothesis-only and accept no scored dimension field. A later rubric-calibrated comparison is a separate workflow; do not imply that this analyst review calibrated a dimension.
- Distinguish not observed (no evidence either way) from a scored category and from 0/unmet.
- Coverage, confidence, replication, and critic agreement are separate fields from the category score itself.

## Human validation (conditional)

Human judge/validation data is an optional input, not a separate skill. Read references/human-validation.md only when the task supplies or requests human PXI/miniPXI labels or preference data; otherwise label cohorts as unvalidated-synthetic and do not claim a human-proxy result.

## Gotchas

- Never cite an event/step/episode ID you did not actually retrieve; a nonexistent or irrelevant citation invalidates the claim, not just the score.
- A dominant-strategy win or a bot's poor play is not automatically a design flaw -- rule out policy competence first.
- Do not equate surprise with confusion, loss with frustration, or predictability with boredom.
