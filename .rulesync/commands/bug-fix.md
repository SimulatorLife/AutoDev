---
targets: ["*"]
description: Fix the next major or outstanding issue or bug that most meaningfully advances the project.
---

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
3. **Reproduce the defect** concretely in the target repository
4. **Plan the fix** based on the confirmed cause, affected paths, and regression risk. Ensure that the plan does not invent a feature, weaken tests, or add compatibility code
5. **Fix it at the source** — do not guess, apply speculative band-aids, or hide symptoms downstream. Preserve related behavior and avoid introducing regressions elsewhere. Use TDD where practical. Fix the *cause* rather than masking downstream symptoms
6. **Validate thoroughly** that the root issue is fixed and remains fixed using the appropriate combination of unit, integration, browser/runtime, end-to-end, regression, and other applicable tests to both validate the fix and to prevent regressions in the future
7. **Perform a retrospective** to ensure that the fix implemented actually addresses the underlying issue(s)/root-cause and not just the symptoms, and that the fix is a single proper fix rather than series of patches. If not, go back to step 1 and repeat the process
8. **Document the fix** in the code, commit message, and any relevant project  documentation or issue-facing explanation to ensure that future maintainers understand the change and its rationale