## Shared codebase navigation

Choose the narrowest authorized capability for the information needed, not a fixed ordering:

- Unknown implementation, identifier, or behavior: semantic code discovery.
- Callers, callees, dependencies, inheritance, or blast radius: structural analysis, such as a code context graph.
- Exact definitions, references, types, diagnostics, or refactoring: language-aware analysis.
- Literal strings, identifiers, logs, configuration, or documentation: text search and direct reads.
- Implementation verification: targeted source inspection.

Use typed tools exposed to the active role. Check index coverage and freshness when relying on indexed results; successful empty results do not prove absence. Index lifecycle belongs to the configured runtime or tool, not the agent, unless a setup/diagnostic task explicitly requires it. Consult the owning tool's skill or reference for implementation-specific operation details.

If an optional capability is unavailable, choose an authorized alternative (including targeted source inspection, text search, or language-aware queries). If necessary evidence cannot be established, report the limitation. Never bypass permissions or reconstruct an entire repository when a bounded investigation is sufficient.

A supplied repository briefing is optional orientation, not authoritative implementation evidence. Confirm relevant details from the current source.

Avoid redundant queries, repeated reads, and broad exploratory passes when the evidence already establishes the relevant seam. Move to implementation once remaining uncertainty no longer blocks the change.
