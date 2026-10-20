# Session review submission

Full contract: docs/playtesting-measurement-contract.md section 6 ("Evidence validation, policy validity, and judge drift") and docs/playtesting-target-state.md section 6 (versioned artifacts).

For a selected session, retrieve its frozen critic input with `playtest.prepareReview` before analysis. The returned packet and packet artifact reference define the allowed citation boundary. Pass its exact packet ID, artifact ID and SHA-256 to the submission tool your Runtime dispatch names: `playtest.submitReview` for a scored confirmatory analysis, `playtest.submitDiscoveryReview` for a P1.5 visual discovery analysis. A source fact that is not present in the packet cannot be cited in that review. Packet omissions and unavailable artifacts stay explicit, and a missing packet is not a reason to expand the evidence window. Runtime copies `authoritativeMetrics` from the packet and derives anchor categories from exact registered metrics and game-owned score bands; provide dimension rationale/citations through `dimensionEvidence`, alternatives through `alternativeExplanations`, and falsifiable proposals through `experiments`. Every submit also requires `reportCompleteness`: mark cross-session context `available` only by citing packet-supplied sibling episode IDs, or `unavailable` with the packet-specific reason; mark alternatives `provided` or `none-identified` with a reason for none; mark experiments `proposed` or `none-recommended` with a reason for none; and provide a concrete `followUp` or explain why none is recommended. Each status must agree with the corresponding array. Missing or inapplicable categories remain null rather than model-invented scores. This records section accounting, not independent validation of the reasoning.

A discovery analysis has no rubric and no metric contract: its prepared packet carries the visible step evidence, and `playtest.submitDiscoveryReview` accepts `episodeId`, `packetId`, `packetArtifactId`, `packetSha256`, `chronologicalSummary`, non-empty `observations` and `interpretations` (each exactly `{hypothesisId, status, text, evidenceRefs}` with `status` `hypothesis` or `not-observed`), `alternativeExplanations` in the same shape, and `experiments` (each with `hypothesis`, `falsifier`, `controls`, `budget`, and `evidenceRefs`). It carries no `rubricHash`, no `dimensionEvidence`, and no `reportCompleteness`: those belong to the scored confirmatory contract, and the two tools are not interchangeable.

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

A review without evidence locators is invalid, not a successful empty report. New submissions also reject placeholder/label-only narrative: the summary, each observation and interpretation, every supplied alternative, experiment hypothesis/falsifier/budget, and each `reportCompleteness` explanation must contain at least three words and sixteen characters. Compact experiment control labels remain valid. State packet-specific missingness in complete prose; this structural minimum is not a quality score and does not establish that the reasoning is correct.

## What submission actually records

Current `playtest.submitReview` validates the review schema, stored locator identity, exact packet boundary, role, and packet provenance. A successful submission means stored, not proven. It does not yet persist independent deterministic fact-support, blind semantic-support, or hypothesis-corroboration verdicts; the independent validator workflow is not integrated. Submit only `hypothesis` or `not observed`, and never describe an analyst interpretation as verified or corroborated.

## Rejected citation patterns

Never present a nonexistent/irrelevant locator, a contradicted absence claim, a wrong-rule match, an anchor-inconsistent rating, or an omitted counterexample as verified. Runtime currently rejects malformed, unknown, wrong-episode, and out-of-packet citations; it does not yet perform every semantic contradiction check listed here. Keep those claims at hypothesis status until independent validation exists.

## No GitHub issue creation

`submitReview` never files a GitHub issue. Issue creation is a separately authorized root step using AutoDev's existing GitHub integration, and requires independent validation first. The independent-validator workflow is not yet integrated, so no review from this path currently qualifies for issue publication.
