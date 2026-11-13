---
name: ccc
description: Use CocoIndex Code after CGC leaves an implementation location or concept unclear, or when the user specifically asks for ccc. It provides semantic discovery for unknown identifiers and behaviors; do not use it to reconstruct code relationships already available from the structural graph or LSP.
targets: ["copilot"]
---

# ccc - Focused Semantic Discovery

CodeGraphContext is the primary structural code map. Use this skill only when the graph does not identify the relevant implementation, identifier, or location, or when CocoIndex is explicitly requested. CGC find_code is identifier/keyword/content lookup, not natural-language concept search: query a known symbol or a few distinctive terms. Use CocoIndex Code (CCC) to discover an unknown concept or behavior, then use CGC for structural relationships.

## Rules

- Use the typed `cocoindex-code` MCP `search` tool; do not run `ccc search` or `ccc index` through a shell.
- Before treating an empty CGC result as evidence of absence, confirm list_indexed_repositories includes the exact workspace path; that call establishes presence, not freshness of the detached session-start refresh.
- Describe the unknown concept or behavior in natural language. Keep the query narrow and use path filters when the likely subsystem is known.
- Do not repeat a CocoIndex query when its result already identifies an implementation. Read that targeted file or use LSP for exact language semantics.
- The MCP search refreshes the semantic index incrementally. Do not manually index before searching.
- Use `ccc init` only for setup if the repository is not initialized, and `ccc doctor` only for diagnostics.

CocoIndex is not a substitute for CGC structural relationships or LSP compiler-aware answers.
