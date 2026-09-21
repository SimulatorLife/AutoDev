# Development lifecycle

Use these phases for repository changes. Trivial work may collapse phases, but
applicable gates still apply. Orchestration mechanics and validation depth are
defined in the parent skill.

## Invariants

- Keep one canonical active implementation path
- An unused or parallel implementation does not satisfy the requested change
- Preserve intentional behavior unless the target state changes it
- For replacements or migrations, move callers to the target path and remove obsolete paths unless staged coexistence is explicitly required
- Keep scope to the requested change plus dependency work required for correctness
- Fix failures at the phase or source that owns them rather than masking them downstream
- Validation evidence is state-specific; material changes invalidate affected evidence

## 1. Understand

Establish acceptance criteria, constraints, non-goals, behavior that must remain
unchanged, affected surfaces, and evidence required for completion.

**Gate:** the target outcome and boundaries are clear enough to investigate and
implement without guessing

## 2. Discover

Identify the canonical implementation and entry points, relevant callers and
consumers, ownership boundaries, control/data flow, reusable implementations,
tests, configuration, documentation, and active versus generated/dead/
transitional paths.

**Gate:** the current state and affected path are understood well enough to
design the target state

## 3. Plan

Define the canonical target implementation and ownership, required file/caller
changes or removals, meaningful implementation slices, and evidence needed to
prove the target state.

For staged migrations, define the authoritative path and removal condition for
the old one.

**Gate:** there is a coherent path from current state to the requested target
state

## 4. Implement

Change the active path end to end. Update required callers, tests, configuration,
and documentation. Remove superseded paths and edit generated artifacts through
their canonical source. Avoid unrelated cleanup.

**Gate:** the repository actually uses the intended implementation

## 5. Validate

Apply the parent skill's validation policy and the strongest relevant repository
checks. Validate acceptance criteria, the active path, regressions, and affected
boundaries. Record unavailable evidence explicitly.

**Gate:** available evidence supports the target state with no known blocking
findings

## 6. Repair

For a blocking finding:

1. identify the phase or source that owns the defect
2. return there and correct it
3. rerun affected downstream work and validation

Do not advance while a blocking finding remains unresolved.

## 7. Integrate

Confirm the acceptance criteria, canonical active path, caller migration/removal,
supporting tests/configuration/documentation, and final diff are consistent with
the target state.

Report completed validation, unavailable evidence, and remaining known risk.

## 8. Commit

Commit the completed change to `main` with a concise message and push it to the
remote repository.

**Gate:** the completed repository state is committed and pushed
