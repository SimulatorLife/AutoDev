# Validation

Read this when you plan or run a validation gate: choosing validators, pinning
the state they inspect, or verifying browser behavior.

Validators must be independent of the scope they validate. Pin validation to an
identified repository state (commit/head plus any relevant uncommitted diff),
and provide acceptance criteria, constraints, and expected evidence without
priming validators with the implementer's conclusions unless investigating a
specific finding. Validators for the same gate should inspect the same state.

Prefer complementary evidence, such as:

- architecture/code review + runtime validation
- tests/static analysis + browser behavior
- migration/call-path review + regression testing

Treat agent reports as provisional evidence, not authority. The root resolves
disagreements and determines whether lifecycle gates pass.

## Proportionate validation

Match validation depth to blast radius, regression risk, and failure signals
rather than running full suites reflexively for isolated edits or skipping
broader checks for cross-cutting changes:

- **Focused:** targeted unit/contract tests, typecheck, or lint scoped directly
  to the changed files or symbols. Use during iterative edits and for
  trivial/bounded changes with strictly local impact.
- **Subsystem:** package or module test suites, integration tests, or build
  checks covering the affected subsystem and its immediate callers or
  contracts. Use for standard changes, interface/boundary edits, or after
  focused checks pass on non-trivial work.
- **Full:** repository-wide build, test, lint/typecheck, or multi-perspective
  validation gates. Use for cross-cutting, shared-infrastructure,
  config/schema, or high-risk changes, or when subsystem checks reveal wider
  regressions.

### Repository-state evidence

Pin every validation run to an identified repository state
(`git rev-parse --short HEAD` plus `git status --short` or the uncommitted diff
scope). Record the exact commands run, their exit status and pass/fail counts,
and the repository state they validated. Material edits after a run invalidate
affected evidence and require re-running the affected tier. Explicitly report
any skipped or unavailable tiers rather than implying full coverage.

## Browser verification

Delegate browser verification to the authorized browser-testing role when available. Verify actual UI/runtime behavior through the scoped browser capability; if unavailable, report the limitation and use authorized server/DOM/unit assertions where meaningful. Do not describe substitute evidence as browser verification.

For role-scoped browser or game-playtesting capabilities, verify actual exposure and a real call through the selected role. Do not infer availability from the root's inventory or telemetry, and do not enable or invoke role-restricted servers at the root.
