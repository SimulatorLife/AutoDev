---
name: ccc
description: Use CocoIndex Code for semantic code discovery when relevant implementations, identifiers, locations, or behaviors are unknown, or when explicitly requested. Complements structural code analysis, language-aware tooling, and direct source inspection.
targets: ["copilot"]
---

# ccc - Focused Semantic Discovery

CocoIndex Code (CCC) provides semantic search across a codebase. Use it to discover relevant implementations, concepts, and behaviors through natural-language queries, particularly when exact identifiers or file locations are unknown.

## When to Use

- Discover implementations of concepts or behaviors described in natural language.
- Locate relevant code when exact identifiers or file paths are unknown.
- Identify candidate implementations across unfamiliar codebases.
- Supplement other discovery methods when their results are insufficient.
- When the user explicitly requests CocoIndex Code.

## Rules

- Use the typed `cocoindex-code` MCP `search` tool; do not run `ccc search` or `ccc index` through a shell.
- Describe the target concept or behavior in natural language. Keep queries focused and use path filters when the likely subsystem is known.
- Do not repeat a semantic search when its results already identify a relevant implementation. Inspect the targeted source or use appropriate language-aware tools.
- Treat semantic search results as discovery evidence rather than authoritative proof of implementation details or relationships.
- Do not treat empty search results as proof of absence. Consider index coverage, freshness, query specificity, and alternative discovery methods.
- The MCP search refreshes the semantic index incrementally. Do not manually index before searching.
- Use `ccc init` only for setup if the repository is not initialized, and `ccc doctor` only for diagnostics.

## Complementary Capabilities

Different code exploration capabilities serve different purposes:

- **Semantic code search:** Discover relevant code based on concepts, intent, or behavior.
- **Structural code analysis:** Explore relationships such as callers, callees, dependencies, and inheritance through a code context graph or equivalent tooling, when available.
- **Language-aware analysis:** Resolve definitions, references, types, and other language-specific semantics through LSP or equivalent tooling, when available.
- **Direct source inspection:** Verify implementation details and establish relationships from source code.

Choose the appropriate available capability based on the information needed. No particular structural graph, language server, or external discovery dependency is required to use CCC.
