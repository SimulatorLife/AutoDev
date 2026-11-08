---
targets: ["*"]
description: Restore one abstraction-layer boundary by extracting low-level bookkeeping into focused helpers.
---

# Restore one abstraction-layer boundary

Audit the codebase for a function or small set of functions that orchestrates high-level behaviour (controllers, command handlers, or other entry points) yet still mutates raw arrays, indexes into collections, or performs other primitive bookkeeping inline. Extract that low-level work into focused helpers so the orchestrator reads as a sequence of delegation steps at a single abstraction layer. Preserve behaviour, keep the diff tight, and ensure any new helper contracts are documented or tested as appropriate.