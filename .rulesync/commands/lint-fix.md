Fix any/all outstanding lint error(s) and warning(s) in the codebase properly and fully; don't suppress them, weaken the rule(s), or disable any rule(s).

Don't remove unfinished/in-progress functionality if it is needed for the future/target-state of the project.

Don't just do the minimal change needed to silence/hide the lint violation(s); fix them such that the code actually, properly adheres to the spirit of the rule.

After applying the fixes, re-run `pnpm run lint` to confirm that the specific 
issues are resolved and that the total number of warnings/errors has decreased. If the changes affect logic, include a short explanation of why behavior is preserved. Provide a concise sumary message describing the rules fixed and files/functions updated. Never disable a lint rule, and never make stylistic changes beyond the targeted fixes.