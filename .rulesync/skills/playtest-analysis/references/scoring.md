# Scoring dimensions and anchors

Full contract: docs/playtesting-measurement-contract.md section 2 ("Quality anchors and evidence sufficiency").

## Categories

Scores are ordinal categories 0-4: 0 unmet, 1 mostly unmet, 2 mixed, 3 mostly met, 4 met. Uncertainty is never category 2 -- insufficient evidence is null, not a mid-scale guess.

## Dimensions

- Agency -- meaningful choice and consequence, not just available action count.
- Depth/strategy -- viable alternative strategies at the observed skill level.
- Pacing/repetition -- rhythm and variety appropriate to the game's own genre and intent.
- Tension/recovery -- risk/reward and whether failure states offer a feasible, previously-signaled escape.
- Clarity/fairness -- whether consequences were actually communicated in the UI/rules the cohort could see.

## Evidence requirements per score

Every non-null score cites: the metric/source, the sampled coverage, the uncertainty, the critic's rationale, and whether the dimension is even applicable to the sampled window. A score with no cited episode/event/step is invalid, not weak.

## Null vs 0

- null = no evidence either way (not observed, or evidence was requested but unavailable).
- 0 (unmet) = evidence was gathered and shows the goal was not met.
Never collapse these into the same reported value, and never default a missing dimension to 0 or to the opposite extreme.

## Cohort display

Report category distributions across a cohort, not an arithmetic average or a 0-100 composite. A single hypothetical mean hides whether most sessions clustered at the extremes.

