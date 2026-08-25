# Remove one unsafe loop mutation

Find a loop that modifies the iterable during traversal (e.g. push, splice, reusing references) or otherwise depends on mutation that risks skipping elements or sharing unintended state. Rewrite the logic to use a safer pattern — cloning, accumulation, or index-based iteration — and add tests that fail without the fix. Target a single representative bug and keep the refactor small/well-scoped while maintaining behaviour.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
