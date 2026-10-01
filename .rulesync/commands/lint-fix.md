---
targets: ["*"]
description: Fix lint errors without suppressing rules or weakening quality bars.
---

Fix outstanding lint errors and warnings in the codebase properly; do not suppress them, weaken rules, or disable rules.

Do not remove unfinished functionality needed for the project's target state.

Do not make the minimal change that only hides a violation. Follow the rule's intent and fix the underlying code.

Discover and use the target repository's documented lint or static-analysis command. Select one focused class of deterministic findings in one related area. Keep configuration unchanged unless the selected finding genuinely requires it, then rerun the relevant check and focused tests.

If changes affect behavior, explain why behavior is preserved. Summarize the rules fixed and the files/functions updated. Avoid unrelated stylistic changes.
