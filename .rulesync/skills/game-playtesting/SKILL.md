---
name: game-playtesting
description: Trigger only when asked to execute, play, run, or simulate a game. Covers mode-specific adapter/visual authorization, capability preflight, launch idempotency, bounded execution, and factual evidence handoff. Not for ordinary code changes or analyzing/scoring/comparing/publishing recorded sessions; use playtest-analysis for analysis.
targets: []
---

# Game Playtesting

Execute one explicitly authorized bounded gameplay workflow and hand off its evidence. This skill owns running play, not interpreting it.

## AutoDev tool invocation

Use the AutoDev Code Mode exec tool and only the exact tools.mcp__<server>__<tool> names advertised in ALL_TOOLS. Dotted playtest.* labels name operations; they are not top-level provider functions. Use only this role's enabled tools. Do not use shell, filesystem, arbitrary network access, or another role's capabilities. Do not print, copy, or broaden trusted session credentials.

## Trigger

Use this skill only for an explicit request to execute, play, run, or simulate a target game or scenario, including a bounded Smart-directed visual run against an approved browser target.

### Negative trigger examples

Do not use this skill for:
- Reviewing, scoring, interpreting, or comparing an existing session; that belongs to playtest-analysis.
- Fixing code, game logic, or configuration; use ordinary engineering skills.
- Filing or triaging a GitHub issue; that is a separately authorized root step.
- Asking the Console to analyze an existing result; that belongs to playtest-analysis.
- "fix this code so the build passes"
- "analyze this existing trace"
- "score the difficulty curve"
- "file a GitHub issue for this bug"

## Mode separation

Core defines three distinct execution modes — `autonomous-visual`, `adapter-accelerated`, and `scripted-regression` — with separate authorization, readiness, launch fields, and evidence. A run never falls back across modes.

- Adapter-accelerated runs use the approved committed checkout snapshot; Runtime resolves the build SHA at batch start. Uncommitted edits never run.
- Autonomous-visual runs use an active Workspaces-approved visual target with exact targetId/targetRevision/approvalId, origin, permitted inputs, and bounded per-episode limits; they never use a checkout build SHA. It does not require an adapter manifest or checkout build. URL-only targets stay Build unknown / Commit not applicable and never inherit this AutoDev checkout's HEAD or any other game's HEAD.
- Scripted-regression is a third separately gated mode. Use only when explicitly assigned, Runtime readiness is ready, and an exact supported recipe and limits were supplied.
- A refused/not-ready visual request is a typed refusal, never a fallback to adapter-accelerated or scripted-regression; adapter-accelerated never accepts a visual target.
- A code-implementation request does not authorize gameplay. Do not run merely because this task asked for code. Before playtest.run, require explicit exact operator authorization for the workspace and selected mode.

## Workspace and build authorization gate

Workspace enablement alone is not run approval. Verify exact workspace, selected mode, current capability revision, and authorization before execution.

- Adapter-accelerated runs: use only the approved committed checkout build SHA Runtime resolved at batch start; never execute uncommitted checkout changes.
- Autonomous-visual runs: use only the selected active visual target's exact approval, origin, permitted input capabilities, and budgets, never a build SHA. URL-only sources are Build unknown / Commit not applicable; never inherit this AutoDev checkout's HEAD or any other game's HEAD.
- Scripted-regression: use only its explicit workspace approval, ready recipe, and assigned resource limits.
- Never invent or relax build SHA, target approval, origin, sandbox, capture policy, request budget, scenario, seed, cohort, capabilityRevision, or trusted actor/session identity. Never fabricate scenario, seed, cohort, build SHA, target approval, origin, or request budget. The approved permissions/evidence contract is in docs/playtesting-target-state.md §3. The role receives only its trusted workspace-bound session context; the general Control API token, provider API keys, and analyst-only credentials are not available for forwarding.

## Workflow

1. Establish the assigned workspace, mode, exact operator approval, goal/focus, and budget. If authorization or the assigned payload is missing, do not run.
2. Call playtest.capabilities and copy capabilityRevision unchanged into the launch request. Confirm workspace authorization and the selected mode's readiness.
   - Adapter-accelerated: require modeReadiness["adapter-accelerated"].status = ready, adapter configuration validated, and assigned scenario/policy/cohort/seed and limits supported. Refuse a missing or unsupported adapter; do not substitute a fixture.
   - Autonomous-visual: require modeReadiness["autonomous-visual"].status = ready, targetStore = available, and selected target eligibility = supported. Verify target revision/approval/origin/input permissions and each limit against the approved target. Visual mode does not require an adapter, game manifest, scenario, seed, or cohort.
   - Scripted-regression: require modeReadiness["scripted-regression"].status = ready and an explicitly assigned supported recipe and limits.
   - If status is not ready, target unsupported/revoked, or capabilityRevision changed, report the typed blocker and stop. Never fall back across modes.
3. Build exactly one versioned PlaytestLaunchRequest (schema autodev-playtest-launch-v1) for one mode.
   - Adapter-accelerated: mode, workspaceId, requestId, capabilityRevision, and operation.kind=batch with the assigned ordered assignments.
   - Autonomous-visual: mode, workspaceId, requestId, capabilityRevision, targetId, policyId=`smart-direct`, verbatim areasOfFocus (or null), and limits: episodeCount, maxStepsPerEpisode, wallTimeMs, smartRequestsPerEpisode, smartTokensPerEpisode, screenshotCountPerEpisode, artifactBytesPerEpisode. Each limit must be within its approved ceiling.
   - Scripted-regression: use the assigned recipeId, maxSteps, and wallTimeMs only.
   - Never cross-contaminate DTOs. The visual DTO never carries scenario/seed/repository/build SHA; adapter requests contain no visual target ID/approval ID/origin/visual limits. A Runtime typed refusal identifies a blocker; never treat it as a reason to silently retry another mode.
4. Same-request idempotency applies. For a new request, generate one unique 1-128 character requestId from letters, digits, dot, underscore, colon, or hyphen. For recovery, preserve the exact original requestId and immutable payload; never create a replacement ID. Keep the exact launchRequest until acceptance is confirmed. If a POST outcome is uncertain, call playtest.lookupRequest using the same ID; retry only the identical payload after not-found. After a not-found receipt, re-submit the exact stored payload only. If the exact payload or authorized recovery action is unavailable, stop and ask the parent.
5. Call playtest.run with launchRequest. Use bounded playtest.wait calls for status. To stop, inspect playtest.activeRuns in the same trusted workspace and cancel only the server-generated batch ID; cancellation is partial evidence, never a game outcome.
6. Read playtest.listEpisodes/readEpisode/readWindow only to confirm completeness and report factual evidence/failures. Preserve all returned event/frame references. Do not analyze, score, or critique the play.
7. Hand off evidence IDs to the parent. Analysis stays separate: the operator triggers analysis in Console; `playtest-analyst` independently reviews completed evidence through its read-only role.

## Explicit evidence/report format

- Workspace & build authorization: workspace ID/mode; adapter build SHA/protocol, or visual target ID/revision/approval ID/origin/input permissions/readiness/ceilings. URL-only visual remains Build unknown / Commit not applicable.
- Run configuration: adapter scenario/seed/policy/cohort, or visual verbatim areasOfFocus/Runtime-resolved policy-model identity/limits/assignment inventory. Do not invent a policy revision.
- Execution: batch/run/episode IDs, recorded status/counts/duration, and completeness.
- Authoritative trace & evidence locators: actual trace/frame/step locators and integrity hashes returned by Runtime.
- Observed anomalies & failures: only recorded facts (crashes, timeouts, adapter/browser/screenshot failures, Smart-direct refusals, missing evidence).
- Handoff: evidence IDs to the parent; analysis is independently requested through Console, never by this role.

## Gotchas

- A gameplay loss, DNF, or crash is an observation, not automatically a bug.
- A screenshot is evidence only when the approved Runtime driver or adapter actually captured and linked it; never fake frames. Autonomous-visual requires its authorized browser-driver evidence; adapter-accelerated does not imply rendered UI observations.
- Do not critique the play inside this skill; that crosses into playtest-analysis.
- A code task alone never authorizes play. Require explicit exact operator approval.
- Do not relax or fall back across modes. Read docs/playtesting-target-state.md §3 for the Workspaces-owned authorization and evidence contract.
