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

## Non-goals

- No analysis, scoring, or critique of the recorded play (no "was it fun", no dimension scores).
- No GitHub issue creation or publication policy -- that belongs to `playtest-analysis` and the root orchestrator, not here.
- No invented outcomes: only report what the runner actually recorded.

## Workflow

1. **Preflight the adapter.** Call `playtest.capabilities` for the target workspace/game. Confirm the adapter, supported policies/cohorts, and budget limits. Report an unsupported or missing adapter instead of improvising a substitute runner or fixture.
2. **Establish seed, cohort, policy, and limits.** Use the assigned scenario/seed, player cohort/policy (random, novice, learning, intermediate, expert, exploratory/stress, or visual-only -- see `docs/playtesting-target-state.md` §6), and the authorized episode/time/resource budget. Never fabricate a seed, cohort, or budget the task or adapter did not provide.
3. **Run.** Execute `playtest.run` within the authorized budget. Do not exceed it or retry past the adapter's own retry policy.
4. **Preserve the authoritative trace.** Keep the full decision/event/frame timeline and replay/trace references; do not summarize, truncate, or silently drop failures or normal context. If coverage is incomplete, say so explicitly.
5. **Report completeness, failures, and hand off evidence IDs.** Return the run/episode IDs, exact completeness/coverage, and any observed failures (crash, timeout, replay-integrity break, adapter error). Hand these evidence IDs to the caller or `playtest-analyst`; do not interpret them yourself.

## Gotchas

- A gameplay loss, DNF, or crash is not automatically a bug -- report it as an observed outcome, not a verdict.
- Do not critique your own gameplay inside this skill; that crosses into `playtest-analysis`'s ownership.
- Visual/screenshot capture (PlayJev-style) is optional and adapter-gated; report it unsupported rather than faking frames.

