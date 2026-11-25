# Tool naming convention

Read when adding, renaming, or validating an AutoDev tool name. Consult the owning runtime definitions in `runtime/src/shared/tool-names.ts`, the canonical MCP declaration in `.rulesync/mcp.jsonc`, and the active tool schemas instead of copying a second registry into this skill.

AutoDev uses named MCP servers and their advertised operations. A host may expose them in an MCP namespace such as `mcp__<server>__<tool>` or through a native dispatcher; use the actual callable names exposed in the current environment.

Canonical delegation is the `xacpx` MCP (for example `delegate_request`, `delegate_batch`, `task_watch`), not a provider-native child API. The architecture owner is `docs/xacpx-subagent-delegation.md`. Historical tool identifiers in audit data or runtime name constants do not establish current delegation availability or authorize a fallback.

Preserve upstream MCP server and operation identities. Runtime naming audits and provider-specific mappings belong in their owning code and tests. Validate changes against the actual exposed schemas and authorization boundary; do not assume a name pattern proves that a capability is available.
