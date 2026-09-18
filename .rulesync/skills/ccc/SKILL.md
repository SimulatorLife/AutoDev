---
name: ccc
description: "This skill should be used when code search is needed (whether explicitly requested or as part of completing a task), when indexing the codebase after changes, or when the user asks about ccc, cocoindex-code, or the codebase index. Trigger phrases include 'search the codebase', 'find code related to', 'update the index', 'ccc', 'cocoindex-code'."
targets: ["copilot"]
---

# ccc - Semantic Code Search & Indexing

`ccc` is the CocoIndex Code backend, providing semantic search over the codebase.
The `cocoindex-code` MCP server exposes this capability directly as typed tools.

## Hard Rules

1. **Always use the MCP tool for search**: Never execute `ccc` CLI commands (`ccc index`, `ccc search`) via bash/exec/terminal when the `cocoindex-code` MCP server is available. The MCP server is the primary, authorized interface for agents.
2. **Do not run manual indexing before search**: The MCP `search` tool sets `refresh_index: true` by default. It automatically and incrementally updates the index prior to querying. Running `ccc index` via a subshell is redundant, slow, and forbidden.
3. **CLI is strictly for setup and diagnostics**: Manual CLI commands are reserved for project initialization (`ccc init`) if the project has not been initialized yet, or diagnostic health checks (`ccc doctor`).

## Calling the MCP Search Tool

### Tool Identifiers
- **Codex Code Mode**: `tools.mcp__cocoindex_code__search(params)`
- **Tool-Calling Environments**: `cocoindex-code/search` or `search` on the `cocoindex-code` server

### Parameters

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `query` | `string` | *(required)* | Natural language concept, functionality, or code snippet to find |
| `limit` | `integer` | `5` | Maximum number of results to return (1 to 100) |
| `offset` | `integer` | `0` | Result offset for pagination |
| `refresh_index` | `boolean` | `true` | Incrementally refreshes the index before searching |
| `languages` | `string[]` | `null` | Optional language filter, e.g. `["typescript", "python"]` |
| `paths` | `string[]` | `null` | Optional glob pattern filter, e.g. `["src/**"]` |

### Code Mode Example (Codex)

```javascript
const results = await tools.mcp__cocoindex_code__search({
  query: "racing line trajectory expected minimum-time",
  limit: 10
});
```

### Tool Call Example (Standard MCP)

```json
{
  "query": "racing line trajectory expected minimum-time",
  "limit": 10
}
```

### Query Best Practices
- The query should describe the concept, functionality, or behavior to find rather than exact syntax.
  - Good: `"vehicle dynamics tyre friction model"`
  - Good: `"database connection pool error retry"`
  - Poor: `"class CarPhysics {"` (use LSP tools like `lsp_find_symbol` for exact symbol definitions)
- Use `paths` to narrow search scope when focusing on a specific subsystem (e.g. `paths: ["src/ui/**"]`).
- Use `offset` to paginate if initial results are relevant and more matches are needed.

## Initialization & Troubleshooting

- **Not Initialized Error**: If the MCP tool reports that the project is not initialized (e.g. "Not in an initialized project directory"), run `ccc init` once in the project root directory, then retry the MCP tool call.
- **Diagnostics**: If the MCP server reports errors or fails to start, refer to [management.md](references/management.md) for troubleshooting steps and `ccc doctor`.
- **Settings**: To view or edit embedding models or file include/exclude patterns, refer to [settings.md](references/settings.md).
