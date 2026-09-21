# Development lifecycle

Use this lifecycle for repository changes. It defines the phases and gates; the
orchestration skill defines role selection, delegation, concurrency, and child
lifecycle.

## Contract

- Prefer one canonical live path; do not satisfy a change with an unused or parallel implementation
- Preserve intentional behavior unless the target state changes it
- For replacements or migrations, move callers to the target path and remove obsolete paths unless staged coexistence is explicitly required
- Never weaken requirements, tests, validation criteria, or performance thresholds to make a change pass
- Report missing tools, checks, runtime evidence, and unresolved uncertainty

## 1. Understand

Before editing, establish:

- acceptance criteria, constraints, and non-goals
- behavior that must remain unchanged
- affected behavior, structure, interfaces, data, configuration, or documentation
- evidence needed to prove completion

Keep scope to the request plus dependency work required for correctness.

## 2. Discover

Identify:

- the canonical implementation, entry points, tests, configuration, and documentation
- important callers, consumers, ownership boundaries, and control/data flow
- existing implementations that can be reused
- active paths versus generated, dead, transitional, or compatibility-only paths

Inspect the relevant call graph or ownership boundary rather than inferring it
from filenames or isolated snippets.

## 3. Plan

Define the smallest coherent target state:

- canonical implementation and ownership
- files and callers to change, migrate, or remove
- independent scopes worth delegating
- validation needed for each meaningful slice

A replacement or migration is not complete if it only adds a parallel path.
If staged coexistence is required, define which path is authoritative and when
the old path is removed.

## 4. Implement

Implement through the active canonical path:

- update required callers, tests, configuration, and documentation
- keep ownership cohesive and dependencies directional
- reuse or simplify existing abstractions before adding new ones where practical
- remove superseded code, wrappers, shims, flags, helpers, and documentation
- edit generated artifacts through their canonical source
- avoid unrelated cleanup

A vertical slice is complete only when the repository actually uses it.

## 5. Validate and review

Apply the orchestration skill's complexity-scaled validation policy. Use the
strongest relevant evidence available, such as:

- targeted tests and regression checks
- type, lint, schema, format, or static checks
- integration, runtime, browser, CLI, API, or end-to-end checks

Independent reviewers validate acceptance criteria, the actual diff and active
paths, regression risk, ownership/complexity, stale or duplicate paths, and
evidence quality. They must not validate scopes they implemented.

Treat passing checks as evidence, not proof. Confirm they exercise the intended
active path and report anything that could not be validated.

## 6. Repair

For a blocking finding:

1. fix the source cause
2. rerun the failed and nearby relevant checks
3. repeat independent review when the repair materially changes the reviewed behavior or architecture

Do not advance with unresolved blocking findings.

## 7. Integrate

Before completion, verify that:

- acceptance criteria are satisfied
- the intended implementation is the active canonical path
- required callers are migrated and obsolete paths removed
- tests, documentation, configuration, and generated outputs match the final state
- the final diff has no accidental scope, temporary code, stale comments, or introduced unresolved TODOs

Report validation performed, unavailable evidence, and remaining known risk.
