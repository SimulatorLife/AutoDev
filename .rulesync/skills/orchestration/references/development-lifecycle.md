# Development lifecycle

Use these phases for repository changes. Trivial work may collapse phases, but
applicable gates still apply. Orchestration mechanics, including delegation and
validation depth, are defined in the parent skill.

## Invariants

- Keep one canonical active path; an unused or parallel implementation does not satisfy the change
- Preserve intentional behavior unless the target state changes it
- For replacements or migrations, move callers to the target path and remove obsolete paths unless staged coexistence is explicitly required
- Keep scope to the request plus dependency work required for correctness
- Report unavailable evidence and unresolved uncertainty

## 1. Understand

Establish acceptance criteria, constraints, non-goals, behavior that must remain
unchanged, affected surfaces, and evidence needed for completion.

## 2. Discover

Identify the canonical implementation, entry points, tests, configuration,
documentation, callers, ownership boundaries, and control/data flow. Distinguish
active paths from generated, dead, transitional, or compatibility-only paths.

## 3. Plan

Define the target implementation and ownership, required caller/file migrations
or removals, and validation needed for each meaningful slice. For staged
migration, define the authoritative path and removal condition for the old one.

## 4. Implement

Change the active path end to end. Update required callers, tests, configuration,
and documentation; remove superseded paths; edit generated artifacts through
their source; avoid unrelated cleanup.

## 5. Validate

Apply the parent skill's validation policy and the strongest relevant repository
checks. Verify the intended active path is exercised, regressions are covered,
and unavailable evidence is reported.

## 6. Repair

Resolve blocking findings at their source, rerun failed and nearby relevant
checks, and repeat review when a repair materially changes the reviewed behavior
or architecture.

## 7. Integrate

Before completion, confirm the acceptance criteria, canonical active path,
caller migration/removal, supporting tests/configuration/documentation, and final
diff are consistent with the target state. Report remaining known risk.
