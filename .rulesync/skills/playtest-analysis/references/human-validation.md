# Human judge/validation (conditional reference)

Full contract: docs/playtesting-measurement-contract.md section 7 ("Human labels and change sensitivity") and docs/playtesting-target-state.md section 6 (policy validity).

This is a conditional reference inside playtest-analysis, not a third skill. Read it only when the task actually supplies or requests human PXI/miniPXI labels, preference data, or a PlayerPolicyValidity check.

## Default: no human data means no human-proxy claim

Without held-out behavioral validity data, label cohorts "unvalidated synthetic cohorts." A failed or absent validity check downgrades novice/learner UX generalizations to model-specific observations -- state this explicitly rather than leaving an authoritative-sounding claim with a footnote.

## When human labels are supplied

- Preserve native instrument units (PXI -3..+3 per construct, miniPXI's single-item ENJ/AUT/GR/CH). Never map these onto the critic's 0-4 scale.
- A full-PXI construct is null if any constituent item is missing; miniPXI missing ENJ makes enjoyment null while other answered items stay usable.
- Display human-measured constructs and AI-predicted dimensions separately, with their own scale/source labels, and flag disagreement rather than claiming "PXI confirms fun."
- A preference claim requires a preregistered primary outcome and an interval lower bound above 0.5 plus the practical margin; otherwise report inconclusive. Ties are not wins.

## PlayerPolicyValidity

Before treating a novice/learner/expert cohort's behavior as evidence about real players, check its PlayerPolicyValidity: competence/legality, repeatability, action agreement and distribution divergence vs available human data, coverage, and failure modes. Preregister acceptance bounds; absent human data means the cohort stays unvalidated-synthetic.

## Never do

- Never relabel a model-confidence or teacher-action-agreement curve as human enjoyment or PXI calibration.
- Never splice scores from a changed judge/model into an apparent game-progress trend; a judge/model/rubric change needs a measurement-change annotation instead.
- Never store raw participant free text or direct identity in the generic LLM evidence store.

