# Improve one polymorphic collaborator boundary

Search for explicit type discrimination against collaborators that are meant to be polymorphic—such as `instanceof` checks, constructor name comparisons, or hard-coded property assertions prior to dispatch. Replace those checks with contract-driven solutions: introduce adapters, interface shims, or capability probes that normalize collaborator inputs/outputs so any substitute behaves consistently. Update call sites to depend on the shared contract, add light tests or documentation as needed, and describe how the refactor improves substitution safety.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
