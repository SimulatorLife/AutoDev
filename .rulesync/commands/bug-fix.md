Fix the next major/outstanding issue or bug that most meaningfully advances the project.

Start by checking the project's canonical backlog, TODO items, issue tracker, or equivalent source of outstanding bugs.

If no explicit open bugs exist, identify and select the highest-value issue in this priority order:

1. **Visual glitches** — clipping, flickering, misalignment, overflow, broken rendering, etc.
2. **UI/UX consistency issues** — inconsistent styling, typography, spacing, interaction behavior, component presentation, etc.
3. **Core domain-behavior issues** — incorrect, inconsistent, or degraded behavior in the project's primary domain/system; follow any applicable repo-local requirements or skills
4. **Broken core workflow** — failures or regressions in the project's primary end-to-end user flow

## Procedure

1. **Confirm and reproduce** the issue before changing code; investigate deeply enough to understand the behavior and evidence
2. **Root-cause it** by tracing the failure to its authoritative owner/origin rather than stopping at downstream symptoms
3. **Plan the fix** based on the confirmed cause, affected paths, and regression risk
4. **Fix it at the source** — do not guess, apply speculative band-aids, or hide symptoms downstream. Preserve related behavior and avoid introducing regressions elsewhere. Use TDD where practical
5. **Validate thoroughly** that the root issue is fixed and remains fixed using the appropriate combination of unit, integration, browser/runtime, end-to-end, regression, and other applicable tests

Prefer one correct, root-cause fix over multiple compensating patches.
