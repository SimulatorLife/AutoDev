---
name: ccc
description: Use CocoIndex Code after CGC leaves an implementation location or concept unclear, or when the user specifically asks for ccc. It provides semantic discovery for unknown identifiers and behaviors; do not use it to reconstruct code relationships already available from the structural graph or LSP.
targets: ["copilot"]
---

# ccc - Focused Semantic Discovery

CodeGraphContext is the primary structural code map. Use this skill only when the graph does not identify the relevant implementation, identifier, or location, or when CocoIndex is explicitly requested.

## Rules

- Use the typed `cocoindex-code` MCP `search` tool; do not run `ccc search` or `ccc index` through a shell.
- Describe the unknown concept or behavior in natural language. Keep the query narrow and use path filters when the likely subsystem is known.
- Do not repeat a CocoIndex query when its result already identifies an implementation. Read that targeted file or use LSP for exact language semantics.
- The MCP search refreshes the semantic index incrementally. Do not manually index before searching.
- Use `ccc init` only for setup if the repository is not initialized, and `ccc doctor` only for diagnostics.

CocoIndex is not a substitute for CGC structural relationships or LSP compiler-aware answers.
