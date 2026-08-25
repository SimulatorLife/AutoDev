# Harden one nullability boundary

Locate a concrete instance where unchecked property access, missing optional chaining, or implicit assumptions about non-null values can throw `TypeError: Cannot read properties of undefined/null`. Implement a focused fix, such as early returns, guard clauses, or optional chaining, together with regression coverage demonstrating the failure before and the guarded behaviour after. Keep the update minimal — address just one high-impact nullability hazard while preserving the existing API surface.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
