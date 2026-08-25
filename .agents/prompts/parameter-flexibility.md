# Improve parameter flexibility

Search for hardcoded constants or magic numbers that should be configurable. If there are enough to justify it, move them into a dedicated constants file. Refactor at least one meaningful value into a configurable parameter and integrate it cleanly with existing systems. The change must address a real extensibility or tuning limitation while avoiding unnecessary abstraction or added complexity.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
