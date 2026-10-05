---
targets: ["*"]
description: Fix the next major or outstanding issue or bug that most meaningfully advances the project.
---

Fix the next major/outstanding issue or bug that most meaningfully advances the project.

Start by checking the project's canonical backlog, TODO items, issue tracker, or equivalent source of outstanding bugs.

If no explicit open bugs exist, identify and select the highest-value issue in this priority order:

1. **Crashes, hangs, and catastrophic failures** — crashes, startup failures, deadlocks, infinite loops, unrecoverable states, or anything that makes the application unusable.
2. **Data, state, and persistence corruption** — lost or duplicated data, invalid state, broken save/load behavior, stale state, incorrect serialization, configuration persistence failures, or state leaking across sessions.
3. **Broken core workflows** — failures or regressions that block or materially break the project's primary end-to-end user flow, progression, navigation, or required actions.
4. **Core domain correctness** — incorrect calculations, rules, invariants, simulation behavior, state transitions, business logic, or other violations of the project's canonical behavior and requirements.
5. **Interaction and lifecycle bugs** — broken input, controls, focus, selection, navigation, initialization, reset, pause/resume, cleanup, retries, mode/phase transitions, or order-dependent behavior.
6. **Concurrency, timing, and synchronization bugs** — race conditions, duplicate execution, stale asynchronous results, event-ordering problems, timing defects, nondeterminism, or inconsistent state propagation.
7. **Visual, layout, and presentation defects** — clipping, overlap, flickering, misalignment, overflow, z-order issues, malformed layouts, broken animations/assets, scaling problems, or incorrect rendering.
8. **UI/UX and accessibility inconsistencies** — inconsistent styling, spacing, typography, affordances, feedback, loading/error states, interaction patterns, keyboard/focus behavior, semantics, or other accessibility regressions.
9. **Performance and resource defects** — severe slowdown, frame drops, excessive rendering/work, blocking operations, memory/resource leaks, runaway allocations, or degradation over time.
10. **Error handling, compatibility, and edge-case defects** — broken recovery/fallback behavior, swallowed or misleading errors, supported-browser/runtime/environment failures, boundary-condition bugs, and uncommon but valid workflows that behave incorrectly.

## Procedure

1. **Confirm and reproduce** the issue before changing code; investigate deeply enough to understand the behavior and evidence
2. **Root-cause it** by tracing the failure to its authoritative owner/origin rather than stopping at downstream symptoms
3. **Reproduce the defect** concretely in the target repository
4. **Plan the fix** based on the confirmed cause, affected paths, and regression risk. Ensure that the plan does not invent a feature, weaken tests, or add compatibility code
5. **Fix it at the source** — do not guess, apply speculative band-aids, or hide symptoms downstream. Preserve related behavior and avoid introducing regressions elsewhere. Use TDD where practical. Fix the *cause* rather than masking downstream symptoms
6. **Validate thoroughly** that the root issue is fixed and remains fixed using the appropriate combination of unit, integration, browser/runtime, end-to-end, regression, and other applicable tests to both validate the fix and to prevent regressions in the future
7. **Perform a retrospective** to ensure that the fix implemented actually addresses the underlying issue(s)/root-cause and not just the symptoms, and that the fix is a single proper fix rather than series of patches. If not, go back to step 1 and repeat the process
8. **Document the fix** in the code, commit message, and any relevant project  documentation or issue-facing explanation to ensure that future maintainers understand the change and its rationale