# Replace one bespoke helper with the authoritative utility

Identify code that reimplements behaviour already provided by a shared helper or well-supported platform API (serialization, cloning, range checks, deep merges, randomization, etc.). Refactor the chosen spot to use the established helper or a modern built-in, removing the bespoke implementation while preserving behaviour and performance expectations. Adjust imports/exports as needed, add concise tests if the helper path is under-covered, and explain the before/after in the commit message so the rationale is obvious.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
