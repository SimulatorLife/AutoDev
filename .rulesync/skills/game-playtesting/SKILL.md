---
name: game-playtesting
description: Trigger only when asked to execute, play, run, or simulate a game (e.g. "play ten episodes", "run a playtest batch", "simulate this scenario"). Covers adapter/capability checks, seed/cohort/policy/budget setup, running the session, and preserving the authoritative trace with evidence IDs. Not for analyzing, scoring, comparing, or publishing a recorded session -- use playtest-analysis for that, and do not use this skill for ordinary code changes.
targets: []
---

# Game Playtesting

Execute a bounded, isolated gameplay session and hand off its evidence. This skill owns **running** play, not interpreting it.

## Trigger

Use this skill when the request is to **execute, play, run, or simulate** a target game or scenario (e.g. "play 10 episodes of RacingGame", "run a smoke playtest on this build", "simulate the aggressive cohort on seed 42").

Do **not** use this skill for:

- Reviewing, scoring, interpreting, or comparing an **existing** recorded session -- that is `playtest-analysis`.
- Fixing code, game logic, or configuration -- ordinary coding skills apply instead.
- Filing or triaging a GitHub issue -- that is a separately authorized root step, never part of running a session.

### Negative trigger examples

Do not trigger for requests such as:

- "fix this code so the build passes" (source code repair, use standard engineering skills)
- "analyze this existing trace" (session critique, use playtest-analysis)
- "score the difficulty curve" (qualitative evaluation, use playtest-analysis)
- "file a GitHub issue for this bug" (root issue publication)

## Non-goals

- No analysis, scoring, or critique of the recorded play (no "was it fun", no dimension scores).
- No GitHub issue creation or publication policy -- that belongs to `playtest-analysis` and the root orchestrator, not here.
- No invented outcomes: only report what the runner actually recorded.

## Workspace and build authorization gate

Verify the exact authorized workspace and build before execution: workspace enablement alone is not run approval. The game adapter runs only for an authorized workspace and approved checkout/build SHA; reject unauthorized workspaces, unapproved builds, or commands outside the approved allowlist.

## Workflow

1. **Preflight the adapter and authorize workspace.** Call `playtest.capabilities` for the target workspace/game. Confirm the authorized workspace and build, adapter compatibility, supported policies/cohorts, and budget limits. Report an unsupported or missing adapter instead of improvising a substitute runner or fixture.
2. **Establish seed, cohort, policy, and limits.** Use the assigned scenario/seed, player cohort/policy (random, novice, learning, intermediate, expert, exploratory/stress, or visual-only -- see `docs/playtesting-target-state.md` §6), and the authorized episode/time/resource budget. Never fabricate a seed, cohort, or budget the task or adapter did not provide.
3. **Run.** Execute `playtest.run` within the authorized budget and retain its server-generated batch ID. Use bounded `playtest.wait` calls for status/result. Do not exceed the approved budget or retry past the adapter's own retry policy. If cancellation is required, list `playtest.activeRuns` and cancel only the server-generated batch ID belonging to this trusted run; preserve partial evidence and never label it a game outcome.
4. **Preserve the authoritative trace.** Keep the full decision/event/frame timeline and replay/trace references; do not summarize, truncate, or silently drop failures or normal context. If coverage is incomplete, say so explicitly.
5. **Report completeness, failures, and hand off evidence IDs.** Return the run/episode IDs, exact completeness/coverage, and any observed failures (crash, timeout, replay-integrity break, adapter error). Hand these evidence IDs to the caller or `playtest-analyst`; do not interpret them yourself.

## Explicit evidence/report format

Every playtest execution report must follow this format:

- **Workspace & build authorization**: workspace ID, git SHA, engine build, adapter protocol version.
- **Run configuration**: scenario, seed / RNG provenance, player policy / cohort, authorized episode and step budgets.
- **Execution summary**: batch/run ID, episode IDs, step count, duration, completion status (completed, partial, truncated, failed, timeout).
- **Authoritative trace & evidence locators**: evidence IDs, frame index refs, trace hashes, and storage paths.
- **Observed anomalies & failures**: adapter errors, invariant violations, crashes, timeouts, replay integrity failures (stated factually without narrative critique).
- **Handoff**: evidence IDs handed off to `playtest-analyst` or parent orchestrator; no self-critique or issue publication.

## Gotchas

- A gameplay loss, DNF, or crash is not automatically a bug -- report it as an observed outcome, not a verdict.
- Do not critique your own gameplay inside this skill; that crosses into `playtest-analysis`'s ownership.
- Visual/screenshot capture (PlayJev-style) is optional and adapter-gated; report it unsupported rather than faking frames.
