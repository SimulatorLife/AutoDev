# Tool naming convention

Read this when adding, renaming, or validating an AutoDev tool name, not for
ordinary delegation.

Every canonical AutoDev tool name follows `<namespace>__<tool>` with
snake_case segments and a double-underscore separator (or a single bare
snake_case segment, e.g. `exec`). The single owner of these names is
`@simulatorlife/autodev-runtime/shared/tool-names`; bridges, hooks, the orchestrator prompt, and
tests all import from there so a rename moves the whole surface together.

| Family                                | Form                     | Examples                                                                                                                                                 |
| ------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex code-mode meta-tool             | bare                     | `exec`                                                                                                                                                   |
| Multi-agent delegation                | `multi_agent_v1__<tool>` | `multi_agent_v1__spawn_agent`, `multi_agent_v1__wait_agent`, `multi_agent_v1__close_agent`, `multi_agent_v1__resume_agent`, `multi_agent_v1__send_input` |
| MCP tools                             | `mcp__<server>__<tool>`  | `mcp__lsp__lsp_goto_definition`, `mcp__cocoindex-code__search`                                                     |
| Codex-native web research             | bare                     | `web_search`, `web_fetch`                                                                                                                                |
| Codex App plugin (request_user_input) | bare                     | `request_user_input`                                                                                                                                     |

The `<server>` segment of an MCP name is snake_case; the one historical
exception is `openaiDeveloperDocs`, which is allowed in the canonical regex
because it already ships in `.rulesync/mcp.jsonc`. A new server name must be
snake_case unless it is a port of an existing third-party tool that already
ships under its camelCase identity.

CLI-required exceptions (PascalCase `WebSearch`/`WebFetch`/`Agent` from the
Claude CLI, lowercase `bash`/`search_web`/`read_file`/`glob`/`grep` from the
Antigravity CLI, lowercase `bash`/`shell`/`execute` from the Copilot CLI,
`invoke_subagent` from Antigravity) live in `@simulatorlife/autodev-runtime/shared/tool-names` under
`CLAUDE_NATIVE_TOOL_EXCEPTIONS`, `ANTIGRAVITY_NATIVE_TOOL_EXCEPTIONS`, and
`COPILOT_NATIVE_TOOL_EXCEPTIONS`. The bridges translate them into the
canonical surface; do not adopt their style for a new AutoDev tool.

A guard rail in `tests/shared/tool-names.test.ts` fails the suite if anyone
hard-codes a `multi_agent_v1__*` literal anywhere in `src/` outside
`@simulatorlife/autodev-runtime/shared/tool-names`. The audit helper `auditToolNames(names)` classifies
every string into `canonical`, `exception` (with provider), or `unrecognised`,
and is the recommended surface for any new tool-name validation.
