# Comparing sessions

Full contract: docs/playtesting-measurement-contract.md section 4 ("Benchmark, pairing, and comparison decision") and docs/playtesting-target-state.md section 6 ("Comparing sessions and deciding what matters").

## Supported comparison types

Use the same evidence schema for all three, via playtest.compare:

1. Single-session critique -- no comparison, just one session's evidence-linked review.
2. Matched cohort comparison -- same scenario/seed distribution, known-compared player skill, equal/comparable compute.
3. Before/after regression review -- comparable config, action/rubric contracts, policy versions, matched seeds.

## What to control before computing

| Comparison | Controlled dimensions |
| --- | --- |
| Same state, different legal choice | State/revision, known information, replayable RNG, continuation policy |
| Novice vs expert/learning policy | Scenario/seed distribution, visibility, model/checkpoint, player skill definition |
| Aggressive vs conservative/economic | Matched scenario/seed, games played, equal skill/compute where possible |
| Previous vs current build | Comparable config, action/rubric contracts, policy versions, environment, matched seeds |

## Rules

- Equal seeds alone never establish equal future RNG draws; a coupled counterfactual still needs its own replay/branch verification.
- A single session cannot establish a systemic trend -- require matched sample counts and uncertainty from playtest.compare, not arithmetic read off raw logs.
- Distinguish a change in player-policy skill from a change in game design before attributing a regression to the build.
- Report intervals/classifications per metric from the code-computed comparison; the LLM cites these results, it does not recompute them from raw traces.

