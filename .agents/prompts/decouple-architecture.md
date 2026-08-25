# Decouple one architectural hotspot

Review the architecture and select ONE overly coupled area (a module cluster, package, or dependency cycle) that, if refactored, will materially improve modularity. Briefly justify the choice, then decouple that area by separating concerns, reducing circular dependencies, and introducing clearer boundaries (interfaces/facades) only where necessary—avoid over-engineering. Update imports/usages accordingly, keep the diff small and behavior-preserving, and run formatters/linters/tests to ensure no regressions. The goal for this run is a focused, maintainable restructuring that supports future growth while reducing technical debt.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
