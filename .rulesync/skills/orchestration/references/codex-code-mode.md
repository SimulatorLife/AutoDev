# Delegating through Codex code mode

Read this before your first spawn when your instructions have no "Delegation on
this provider" section: Codex-native GPT, MiniMax, and the opencli web-chat
providers (`opencli-chatgpt`, `opencli-gemini`), including a Gemini model served
by opencli, which is not Antigravity.

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

`runtime/src/agents/spawn-tools.ts` builds the batched
`await Promise.allSettled(...)` script that fans out across children and is the
reference implementation: batch independent spawns in one cell, so one rejected
child does not hide its successful siblings.

## Writing the spawn message

Write `message` as a double-quoted JavaScript string with `"`, `\` and line
breaks escaped (`\"`, `\\`, `\n`), never as a template literal: task text
routinely contains Markdown backticks and `${`, which end or interpolate a
template literal and fail the whole `exec` cell before any child spawns.

The same rule applies when passing inline Python/Node scripts or shell commands
to `tools.exec_command`: never wrap them in a JS template literal when they
contain backticks or `${`, and check `ALL_TOOLS` (or
`typeof tools.apply_patch === "function"`) before calling `tools.apply_patch` —
Codex 0.169+ exposes file editing through `exec_command` rather than
`tools.apply_patch` on some providers.

## Waiting inside `exec`

Start the cell that waits on children with
`// @exec: {"yield_time_ms": <timeout_ms + 30000>}` on its first line. The cell
has no `setTimeout` or `setInterval`; wait through
`tools.multi_agent_v1__wait_agent` or `tools.write_stdin`.
