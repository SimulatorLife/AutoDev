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

Lifecycle argument shapes (do **not** pass `id` — use `target`/`targets`):
- `tools.multi_agent_v1__wait_agent({ targets: [agentId], timeout_ms: 120000 })`
- `tools.multi_agent_v1__send_input({ target: agentId, message: "..." })`
- `tools.multi_agent_v1__close_agent({ target: agentId })`

## Writing the spawn message

Write `message` as a double-quoted JavaScript string with `"`, `\` and line
breaks escaped (`\"`, `\\`, `\n`), never as a template literal: task text
routinely contains Markdown backticks and `${`, which end or interpolate a
template literal and fail the whole `exec` cell before any child spawns.

The same rule applies when passing inline Python/Node scripts or shell commands
to `tools.exec_command`: never wrap them in a JS template literal when they
contain backticks or `${`.

Files inside the active workspace are read and edited through the `filesystem` MCP server
(`tools.mcp__filesystem__read_text_file`, `tools.mcp__filesystem__edit_file`,
`tools.mcp__filesystem__write_file`, …), on every provider. Codex's own
`apply_patch` and `view_image` are not offered, and a call to either is refused
by the `file-surface` hook with the `filesystem` tool to use instead. Because
`filesystem` MCP is confined per-session to the active workspace (plus read-only
skill roots), use `tools.exec_command` for authorized reads of external paths
such as `/tmp/*` snapshots, and write scratch probes under gitignored `tmp/`
rather than tracked `tests/`.

## Bounded discovery and navigation

- **Default `max_output_tokens: 2000`:** Pass `max_output_tokens: 2000` (or
  less) on `tools.exec_command` for discovery commands—searches, file or
  directory listings, `git status`, `git diff`, and metadata checks. Narrow
  output before printing (`rg -l`, `--max-count`, path filters, `head`/`tail`,
  or explicit line ranges) and never print bundled, generated, or minified
  files.
- **Justified exceptions:** Raise `max_output_tokens` above `2000` only when
  the step genuinely requires reading larger output in full (such as failing
  test traces, compiler/typecheck diagnostic lists, or structured JSON that
  truncation would break), and keep the raised cap bounded to the expected
  output rather than omitting it.
- **Indexed CGC first:** Call
  `tools.mcp__codegraphcontext__list_indexed_repositories` once per task. When
  the active repository is indexed, query CGC (`find_code`,
  `analyze_code_relationships`) as the first structural map before broad `rg`
  searches or exploratory `filesystem` reads (following `Shared codebase
  navigation` for fallback rules when CGC is unindexed or unavailable).
- **No redundant reads:** Read source files through `tools.mcp__filesystem__*`
  only after identifying the target path or seam, preferring bounded
  `head`/`tail` or targeted reads. Do not re-read files, re-run identical
  searches, or repeat tool calls whose output is already in the current context
  window; re-read only after the file has changed or compaction dropped the
  earlier output.

## Waiting inside `exec`

Start the cell that waits on children with
`// @exec: {"yield_time_ms": <timeout_ms + 30000>}` on its first line. The cell
has no `setTimeout` or `setInterval`; wait through
`tools.multi_agent_v1__wait_agent` or `tools.write_stdin`.

### Long-running command sessions (`session_id` / `write_stdin`)

- Size `yield_time_ms` on `tools.exec_command` to the expected command
  duration, and set `// @exec: {"yield_time_ms": ...}` on the cell's first line
  when waiting so the cell does not yield every 30 seconds.
- When `tools.exec_command` returns a `session_id` without an `exit_code`, the
  command is still running. Do not re-run the command or treat the yield as a
  failure.
- Continue the same `session_id` with
  `tools.write_stdin({ session_id, yield_time_ms: 60000 })` (or up to `300000`
  to match the command, leaving `chars` empty to wait without writing) until
  `exit_code` is returned and completion output is observed. Never poll in
  tight 1–10 second loops.
- Pass non-empty `chars` only when the process is genuinely awaiting
  interactive stdin (or to interrupt a confirmed-stuck command), and keep
  `max_output_tokens` bounded on `write_stdin` polls as well.
