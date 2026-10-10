# Session review submission

Full contract: docs/playtesting-measurement-contract.md section 6 ("Evidence validation, policy validity, and judge drift") and docs/playtesting-target-state.md section 6 (versioned artifacts).

## Required report sections

Every submitted PlaytestSessionReview includes:

1. Provenance/coverage -- game/adapter/policy/rubric hashes, run completeness, which windows were actually supplied vs omitted.
2. Chronological episode summary -- phase changes, decisions, resources, result.
3. Authoritative metrics -- the deterministic, code-computed facts, not an LLM paraphrase of them.
4. Scored experience dimensions -- see references/scoring.md; null where unsupported.
5. Evidence-linked observations -- each tied to an exact episode/event/step/window ID.
6. Alternative explanations -- competing causes for each hypothesis (policy bug, lag, action-legality error, intended difficulty).
7. Cross-session context -- only when actually available; do not infer context that was not retrieved.
8. Testable hypotheses/experiments -- each with a minimal test, controls, and a falsifier.
9. Evidence-status decision -- verified / corroborated / hypothesis / not observed, per claim.
10. Suggested follow-up -- next investigation, not a fix.

A review without evidence locators is invalid, not a successful empty report.

## What submission actually records

playtest.submitReview persists four independent checks, not one pass/fail: schema/locator validity, deterministic fact support, semantic support, and hypothesis corroboration. A successful submission means stored, not proven -- the independent validator later reads the cited windows without your conclusion and records its own observations first.

## Rejected citation patterns

Do not submit a review containing: a nonexistent event ID, an existing-but-irrelevant event cited as support, a cited list that actually contains the action you claimed was absent, a correct event matched to the wrong rule, an anchor-inconsistent rating, or an omitted counterexample. Each of these is a rejected claim, not a lower-confidence one.

## No GitHub issue creation

submitReview never files a GitHub issue. Issue creation is a separately authorized root step using AutoDev's existing GitHub integration, after independent validation -- never an unreviewed model write.

