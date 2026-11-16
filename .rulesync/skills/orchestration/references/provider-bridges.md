# Delegating through a provider CLI bridge

Read this when your instructions have a "Delegation on this provider" section:
the Claude, Antigravity (`agy` CLI), and Copilot bridges.

## The spawn surface

The bridge's spawn server is the delegation surface. The "Delegation on this
provider" section states the exact call; it is the one call this provider can
serve. The bridge collects the children and asks Codex to create them, so each
child is a real Codex session that the app shows and the router counts, and the
bridge, not you, writes the spawn script. One call may carry a batch of
children; park and reuse a completed child by passing its `target` instead of
`agent_type`.

`autodev_spawn` is a provider-bridge shim, not a Codex MCP server. Use it only
when the bridge's instructions say it injected the shim; on direct Codex use
`multi_agent_v1__spawn_agent` (see `references/codex-code-mode.md`).

Provider CLIs keep some native tool names (PascalCase `WebSearch`/`WebFetch`
on Claude, lowercase `bash`/`read_file` on Antigravity and Copilot). Follow the
role contract and the provider's instructions instead of inventing names.

## Bridge-specific behavior

Bridges implement the common runtime contract differently but must preserve
parent-owned child identity, bounded scope, explicit terminal-result handling,
safe capacity recovery, and no global child cleanup.

- Bridge-dispatched spawn batches carry an injected current-parent recovery
  preflight: when this parent's open child handles plus the new children exceed
  the session limit, it closes errored or shut-down handles and evicts the
  oldest completed ones, never a running child, and reports each as a
  `recovery_status` line.
- Antigravity's `invoke_subagent`/`manage_subagents` children are agy-owned
  subprocesses rather than router `autodev/<role>` children, so router
  per-session concurrency does not cover them. When the parent stream
  disappears mid-delegation, the bridge reports
  `INCOMPLETE_REASON_CLIENT_DISCONNECTED` rather than
  `INCOMPLETE_REASON_INTERRUPTED`.
- The router keeps a parent with active router-owned children in
  `subagent_wait` on its original provider so live-load routing can prefer idle
  providers. Child progress refreshes the parent's liveness.

Report rate limits, stalls, provider failures, skipped roles, partial child
results, and unavailable recovery surfaces explicitly.
