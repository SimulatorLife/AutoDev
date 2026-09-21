# Development lifecycle

Use this lifecycle for every repository change. It defines what must happen and
in what order; the orchestration skill defines who performs the work and how
roles coordinate.

## Governing contract

- The root orchestrator owns lifecycle progression and gate decisions
- Apply the lifecycle to features, fixes, refactors, migrations, documentation, configuration, tests, and infrastructure changes
- Prefer one canonical implementation path over competing live paths
- Do not claim completion from code that is merely added, staged, or isolated; the requested behavior must be integrated into the active repository path
- Preserve intentional existing behavior unless the requested target state changes it
- When the target state replaces an old path, migrate callers and remove obsolete paths rather than preserving compatibility layers by default
- Never weaken requirements, tests, validation criteria, or performance thresholds merely to make a change pass
- Report unavailable checks, tools, runtime evidence, or unresolved uncertainty explicitly

## 1. Understand the change

Before editing:

- Read repository instructions and applicable skills
- Restate the requested outcome as concrete acceptance criteria
- Identify explicit constraints, non-goals, compatibility requirements, and behavior that must remain unchanged
- Determine whether the request changes behavior, structure, ownership, interfaces, data, configuration, documentation, or some combination
- Identify the evidence needed to prove completion

Do not silently broaden the task. If adjacent work is necessary for correctness,
include only the minimum required dependency work and make that relationship
explicit.

## 2. Inspect the current state

Establish how the repository works today before designing the change:

- Locate the canonical implementation, configuration, documentation, tests, and entry points relevant to the request
- Trace important callers, consumers, ownership boundaries, and data or control flow
- Search for existing implementations before introducing new abstractions, files, helpers, or dependencies
- Distinguish active paths from dead, generated, transitional, or compatibility-only paths
- Identify concurrent or nearby changes that could conflict with the intended work

Do not infer architecture from filenames or isolated snippets when the relevant
call graph or ownership boundary can be inspected directly.

## 3. Plan the target state

Define the smallest coherent path from the current state to the requested state:

- Specify the canonical target implementation and ownership boundary
- Identify files and call sites that must change, move, migrate, or be removed
- Separate independent work where parallel execution is useful
- Define validation for each meaningful slice before implementation
- For migrations, define how the old path stops being authoritative and how remaining callers move to the new path

A plan must not satisfy a replacement or migration by adding a parallel system
that is not wired into the active path. Temporary parallelism is acceptable only
when the task explicitly requires a staged migration and the transition,
authority, and removal criteria are defined.

## 4. Implement through the canonical path

Implement the requested behavior or structure end to end:

- Modify the active path rather than creating an unused alternate path
- Keep ownership cohesive and dependencies directional
- Reuse or simplify existing abstractions where appropriate before adding new ones
- Update all required callers, configuration, documentation, and tests as part of the same change
- Remove superseded code, wrappers, shims, branches, flags, helpers, and documentation when they are no longer required
- Keep generated artifacts derived from their canonical source rather than editing generated copies directly
- Avoid unrelated cleanup unless it is required to complete the requested change safely

For a vertical slice, completion means the repository actually uses the changed
path and its acceptance criteria are observable.

## 5. Validate the implementation

Run the strongest relevant validation available for the changed surface:

- Targeted tests for the changed behavior
- Type, lint, schema, formatting, or static checks where applicable
- Integration, runtime, browser, CLI, API, or end-to-end evidence when behavior depends on execution
- Focused regression checks for behavior that must remain unchanged
- Repository-specific validation required by instructions or changed subsystems

Treat passing tests as evidence, not proof by themselves. Confirm that tests
exercise the intended active path and that failures are fixed at their source
rather than masked by relaxed expectations.

If a required check cannot run, record exactly what was not validated and why.

## 6. Independently review

For every significant coordinated change, use an independent validator that did
not implement the change.

Review against:

- The original acceptance criteria and non-goals
- The actual diff and active call paths
- Correctness and regression risk
- Cohesion, ownership, coupling, and unnecessary complexity
- Missing callers, stale paths, dead code, duplicate systems, or compatibility shims
- Tests and evidence quality
- Documentation and configuration consistency

Independent review is evidence. The root orchestrator resolves disagreements and
owns the decision to advance the lifecycle.

## 7. Repair and revalidate

When validation or review finds a defect:

1. Identify the source cause
2. Repair the implementation or plan at that source
3. Re-run the failed validation
4. Re-run nearby checks that could regress
5. Repeat independent review when the repair materially changes the reviewed behavior or architecture

Do not treat a known blocking finding as complete because unrelated checks pass.

## 8. Integrate and verify final state

Before declaring completion:

- Re-read the acceptance criteria and verify each against the final repository state
- Confirm the intended implementation is the active canonical path
- Confirm required callers were migrated and obsolete paths were removed
- Confirm tests, documentation, configuration, and generated outputs are consistent with the final state
- Check the final diff for accidental scope, temporary code, stale comments, debugging artifacts, or unresolved TODOs introduced by the change
- Report validation performed, validation unavailable, and any remaining known risk or follow-up

A change is complete only when the requested target state is integrated,
validated, independently checked when significant, and accurately reported.
