# Delegating through Codex code mode

Read this before your first spawn. It is the one delegation surface on every
provider -- Codex-native GPT, MiniMax, the opencli web-chat sites, and the
Claude and Antigravity CLI bridges, which mirror Codex's `exec` tool to their
model unchanged. No provider has a spawn tool of its own.

## The spawn surface

The surface is `multi_agent_v1__spawn_agent` with
`{ agent_type: "<role>", message: "<full task>" }`, reached through `exec`.

Every catalog in `config/catalogs/` and every model catalog in
`~/.codex/*-model-catalog.json` declares `"tool_mode": "code_mode_only"` and
`"multi_agent_version": "v1"`, so Codex delivers the entire tool surface as one
`exec` custom tool whose input is raw JavaScript evaluated against a `tools`
global. The spawn and lifecycle tools (`multi_agent_v1__spawn_agent`,
`multi_agent_v1__wait_agent`, `multi_agent_v1__close_agent`,
`multi_agent_v1__resume_agent`, `multi_agent_v1__send_input`) hang off that
global inside the `exec` cell and are not listed as top-level functions -- by
design, not a missing tool. Probe `typeof tools.multi_agent_v1__spawn_agent`
inside an `exec` script before reporting a delegation capability failure.

Batch independent spawns in one cell with `await Promise.allSettled(...)`, so
one rejected child does not hide its successful siblings. Each child is
accepted or refused on its own: when the session's child limit is reached,
Codex refuses the spawns that do not fit with `agent thread limit reached`, and
the children that did fit keep running. Close finished children with
`tools.multi_agent_v1__close_agent` to free their slots (see
`references/runtime-contract.md`).

## Writing the spawn message

Write `message` as a double-quoted JavaScript string with `"`, `\` and line
breaks escaped (`\"`, `\\`, `\n`), never as a template literal: task text
routinely contains Markdown backticks and `${`, which end or interpolate a
template literal and fail the whole `exec` cell before any child spawns.

The same rule applies when passing inline Python/Node scripts or shell commands
to `tools.exec_command`: never wrap them in a JS template literal when they
contain backticks or `${`.

Files are read and edited only through the `filesystem` MCP server
(`tools.mcp__filesystem__read_text_file`, `tools.mcp__filesystem__edit_file`,
`tools.mcp__filesystem__write_file`, …), on every provider. Codex's own
`apply_patch` and `view_image` are not offered, and a call to either is refused
by the `file-surface` hook with the `filesystem` tool to use instead.

## Waiting inside `exec`

Start the cell that waits on children with
`// @exec: {"yield_time_ms": <timeout_ms + 30000>}` on its first line. The cell
has no `setTimeout` or `setInterval`; wait through
`tools.multi_agent_v1__wait_agent` or `tools.write_stdin`.
