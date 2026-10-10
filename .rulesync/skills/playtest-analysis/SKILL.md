---
name: playtest-analysis
description: Trigger only when asked to review, interpret, score, compare, diagnose, or verify an existing recorded gameplay session or trace (e.g. "analyze this playtest", "analyze this existing trace", "was this run confusing", "compare these two builds"). Owns the 8-step evidence-grounded review procedure, null-safe scoring, and experiment proposals. Not for executing/playing/simulating a game (use game-playtesting) or for ordinary code changes or GitHub issue creation.
targets: []
---

# Playtest Analysis

Turn a recorded gameplay session into an evidence-linked review, not an unsupported fun verdict. This skill owns interpreting play; it does not run episodes and does not publish issues.

## Trigger

Use this skill when the request is to review, interpret, score, compare, diagnose, or verify an existing recorded gameplay session or trace (e.g. "analyze this existing trace", "score the agency dimension for episode 17", "compare the aggressive and conservative cohorts on build X").

Do not use this skill for:

- Executing, playing, or simulating a game -- that is game-playtesting.
- Fixing code, game logic, metrics, or configuration -- ordinary coding skills apply instead; this skill never rewrites evaluation rules or source.
- Creating or publishing a GitHub issue -- publication goes through the root orchestrator's existing GitHub integration, never this skill directly.

## Non-goals

- No single-number 0-100 "fun" score, and no substituting model confidence or win rate for an experience score.
- No running, branching, or modifying gameplay; use only the evidence the runner already produced.
- No GitHub issue creation -- propose findings/hypotheses only.

## The 8-step review procedure

Full normative detail: docs/playtesting-target-state.md section 6 ("Required playtest-analysis skill: how to read and interpret a session").

1. Verify and read the source. Check game/adapter/policy/rubric hashes, run completeness, timeline revisions, replay validation, visible-vs-privileged state, and event/frame coverage. Name missing evidence instead of filling it in.
2. Reconstruct decisions in context. For each sampled key moment: before-state, player-visible rules/alerts, legal alternatives, chosen action, stated intention/prediction (if collected), and authoritative after-state.
3. Separate observations from interpretations. Deterministic evaluators establish what happened; you suggest why it may be a problem, against the target game's own goals, not universal norms.
4. Evaluate both interesting and routine play. Sample abnormal moments and representative ordinary phases; distinguish novice learning failure, strong-policy dominance, bad AI calibration, intended difficulty, and actual usability defects.
5. Score dimensions only where supported. Produce separately evidenced scores or null (never a placeholder "2") for agency, depth/strategy, pacing/repetition, tension/recovery, and clarity/fairness -- see references/scoring.md.
6. Compare when necessary. Use code-computed aggregates (playtest.compare: matched seeds, comparable policy skill, sample counts, uncertainty) before explaining group patterns -- see references/comparisons.md. A single session cannot establish a systemic trend.
7. Propose discriminating experiments. For each high-value concern: competing causes, a minimal test, metric, controls, budget, and what would refute the theory. Request execution via the root; you cannot run it yourself.
8. Publish an evidence-linked review artifact. Separate verified bug vs statistically supported regression vs unverified game-design hypothesis; submit with playtest.submitReview -- see references/session-review.md. Never produce a GitHub issue directly.

## Required report sections

Every submitted review has: provenance/coverage, chronological episode summary, authoritative metrics, scored experience dimensions, evidence-linked observations, alternative explanations, cross-session context (if available), testable hypotheses/experiments, an evidence-status decision (verified/corroborated/hypothesis/not observed), and suggested follow-up. A review without evidence locators is invalid, not a successful empty report.

## Null-safe evidence and scores

- Insufficient evidence is null, never a mid-scale category. Uncertainty is not category 2.
- Distinguish not observed (no evidence either way) from a scored category and from 0/unmet.
- Coverage, confidence, replication, and critic agreement are separate fields from the category score itself.

## Human validation (conditional)

Human judge/validation data is an optional input, not a separate skill. Read references/human-validation.md only when the task supplies or requests human PXI/miniPXI labels or preference data; otherwise label cohorts as unvalidated-synthetic and do not claim a human-proxy result.

## Gotchas

- Never cite an event/step/episode ID you did not actually retrieve; a nonexistent or irrelevant citation invalidates the claim, not just the score.
- A dominant-strategy win or a bot's poor play is not automatically a design flaw -- rule out policy competence first.
- Do not equate surprise with confusion, loss with frustration, or predictability with boredom.

