# Restore one abstraction-layer boundary

Audit the codebase for a function that orchestrates high-level behaviour (controllers, command handlers, or other entry points) yet still mutates raw arrays, indexes into collections, or performs other primitive bookkeeping inline. Extract that low-level work into focused helpers so the orchestrator reads as a sequence of delegation steps at a single abstraction layer. Preserve behaviour, keep the diff tight, and ensure any new helper contracts are documented or tested as appropriate.

Before editing, discover the target repository's documented conventions and validation commands. Do not assume a particular language, package manager, framework, directory layout, or fixture format. Keep the work to one bounded change, preserve unrelated work, and never weaken tests or add compatibility shims.
