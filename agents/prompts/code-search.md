## Shared codebase navigation

Use CodeGraphContext (CGC) as the default structural map before exploratory file reads, broad search, or repeated LSP navigation. Ask CGC for the relevant modules, symbols, callers/callees, imports, inheritance, dependency paths, and likely change impact instead of reconstructing those relationships manually.

AutoDev indexes the active repository's graph in the background at session start and refreshes it whenever the checkout changes; do not index repositories yourself. Call `list_indexed_repositories` once per task: if the workspace is missing, indexing is still running or has failed, so treat CGC as unavailable for this task and follow the fallback below. CGC answers queries about a repository it has not indexed with empty results, so never read an empty CGC answer as "no callers" or "no dependents" without that check. Use `analyze_code_relationships` for callers, callees, importers, hierarchy, and dependency paths; use `find_code` to locate candidate nodes. Query only to answer the task's concrete structural questions.

Use CocoIndex (ccc, cocoindex-code) only for semantic or conceptual discovery when the relevant implementation, identifier, or location is still unknown. Use LSP (lsp-mcp-server, lsp) only when exact language/compiler semantics are needed, such as precise definitions, references, inferred types, diagnostics, or compiler-aware navigation. Read source files directly only after the relevant implementation has been identified.

Repomix is optional high-level briefing only when an existing briefing is supplied or an explicit generation workflow is available; AutoDev does not expose a Repomix tool and it is not part of default code search. A briefing should include repository instructions, skills, architecture/docs, TODOs, manifests/configuration, and directory structure, omitting source code already represented by CGC. Do not use it as another source-code graph or search system.

Do not query multiple systems for the same fact merely to increase confidence. If CGC is unavailable or the graph cannot be queried, state that limitation and use CocoIndex or LSP only for their focused fallback purpose; do not silently rebuild the structural map through broad manual exploration.

When the role contract declares these MCP capabilities, use their typed tools directly. If a required tool is unavailable, report the capability failure.
