---
targets: ["*"]
description: Fix all outstanding lint errors and warnings properly, without disabling rules or weakening quality bars.
---
Fix any/all outstanding lint error(s) and warning(s) in the codebase properly and fully; don't suppress them, weaken the rule(s), or disable any rule(s).

Don't remove unfinished/in-progress functionality if it is needed for the future/target-state of the project.

Don't just do the minimal change needed to silence/hide the lint violation(s); fix them such that the code actually, properly adheres to the spirit of the rule.

After applying the fixes, re-run `pnpm run lint` to confirm that the specific 
issues are resolved and that the total number of warnings/errors has decreased. If the changes affect logic, include a short explanation of why behavior is preserved. Provide a concise sumary message describing the rules fixed and files/functions updated. Never disable a lint rule, and never make stylistic changes beyond the targeted fixes.

## Additional guidance

The following guidance augments the AutoDev-specific rulesync command above with the AutoDev generic scheduler equivalent formerly published at `.agents/prompts/lint-fix.md`. It applies the same principle through the AutoDev catalog boundary: discover the target repository's documented conventions and validation commands before editing, do not assume a particular language, package manager, framework, fixture format, or directory layout, and keep the work to one bounded change without compatibility shims.

# Fix one focused lint problem

Discover and run the target repository's documented lint or static-analysis command. Select one focused class of deterministic findings in one related area and fix the underlying code rather than suppressing the rule. Do not assume any particular language or analysis tool. Keep configuration unchanged unless the selected finding genuinely requires it, then rerun the relevant check and focused tests.
