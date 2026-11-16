# Replace custom subagent spawning with xacpx MCP

> **Proposal — not implemented.** [AutoDev target state](autodev-console-target-state.md#cross-provider-agent-delegation-contract) remains authoritative; follow its [ACP equivalence gate](autodev-console-target-state.md#agent-execution-transport-contract-acp-mcp-and-responses) before cutover.

## Findings

- **Current:** Codex orchestrators call `multi_agent_v1__spawn_agent`/`send_input`/`wait_agent`/`close_agent`; Claude, Antigravity and Copilot bridges use AutoDev's `autodev_spawn.spawn_subagent` shim, then reconstruct Codex spawn calls. See `runtime/src/mcp/spawn-shim.ts`, `runtime/src/agents/{bridge-delegation,bridge-spawn-session,spawn-tools}.ts` and [provider bridges](../.rulesync/skills/orchestration/references/provider-bridges.md). This is Codex-coupled, duplicated lifecycle plumbing.
- **[xacpx](https://github.com/gadzan/xacpx)** already provides an external `mcp-stdio` server backed by [acpx](https://github.com/openclaw/acpx): `delegate_request`/`delegate_batch`, `task_get`/`task_list`/`task_watch`/`task_cancel`, and `agent_list`/`agent_send`. Any MCP-compatible orchestrator can request workers on supported ACP agent backends; unlike plain acpx, xacpx owns task coordination.
- **Session modes:** `parallel: false` reuses the selected target's session and serializes tasks; `parallel: true` creates an isolated, concurrent session that auto-closes after terminal completion and reviews. `agent_send` queues/sends to authorized reachable agents but returns delivery acceptance, not a synchronous response. `task_watch` waits on *tasks*, not arbitrary session turns. No generic MCP `close_agent` is exposed; external MCP coordinators cannot receive unsolicited agent messages.
- **Alternative:** [claude-code-teams-mcp](https://github.com/cs50victor/claude-code-teams-mcp) offers team inboxes and explicit shutdown but only Claude Code/OpenCode workers via Python/tmux, not acpx. It is not the provider-agnostic choice.

## Recommendation

**Use xacpx's existing MCP server as AutoDev's single cross-provider subagent delegation interface, then remove AutoDev's custom spawn MCP/shims and Codex-specific bridge-spawn translation after parity is proven.** Do not build a second acpx MCP wrapper by default.

AutoDev must remain the **sole policy authority** for role-to-provider/model allocation, eligibility, priorities, cooldowns, concurrency admission, workspace/tool/MCP/skill grants, approvals, parent-child ownership, telemetry and Console state. Map its selected role/provider to an explicit xacpx `targetAgent`; do not allow a hidden xacpx fallback or a second permission policy. xacpx owns worker transport/task execution, not AutoDev routing. Preserve direct execution for `mmx`, `opencli`, or other unsupported/non-ACP backends.

## Migration / acceptance gate

1. **Integrate:** Pin and install xacpx; configure one Rulesync-projected `xacpx mcp-stdio` server and managed daemon lifecycle. Verify available agent profiles, model/effort selection, authentication and workspace-scoped MCP/permissions. Keep the current delegation path during evaluation.
2. **Prove parity:** Exercise Codex-to-Claude and Claude-to-Codex (plus other enabled ACP agents), serial reuse, independent parallel workers, batched dispatch, follow-up messages/results, nonterminal watch timeouts, cancellation, idle-session release, crashed/restarted sessions, concurrency pressure, approvals and denied capabilities. Require equivalent host-visible child lineage, results, status/Console telemetry and no duplicate mutations or unauthorized tool grants.
3. **Resolve gaps before replacement:** Establish whether `agent_send`/task reuse satisfies AutoDev's parked-worker `send_input` contract and how explicit `close_agent`/capacity eviction will work. Validate xacpx's internal queue/approvals against AutoDev's single-authority rules; its same-user daemon socket is not an authorization boundary. If critical semantics fail, retain the incumbent path or add only a minimal tested adapter—not another orchestration stack.
4. **Cut over and delete:** After the target-state gate passes, remove `autodev_spawn` and bridge-generated Codex spawning/recovery scripts and their superseded constants, prompts, tests and glue (`runtime/src/mcp/spawn-shim.ts`, relevant `runtime/src/agents/*`). Update orchestration Rulesync references, provider-routing docs and telemetry mapping. Retain Codex-native lifecycle only where the stronger root/host-visibility gate still requires it; do not silently lose Codex UI child sessions.

**References:** [xacpx external MCP contract](https://github.com/gadzan/xacpx/blob/main/docs/external-mcp.md) · [xacpx MCP tool registry](https://github.com/gadzan/xacpx/blob/main/src/mcp/xacpx-mcp-tools.ts) · [AutoDev existing lifecycle](../.rulesync/skills/orchestration/references/runtime-contract.md) · [AutoDev target state](autodev-console-target-state.md#agent-execution-transport-contract-acp-mcp-and-responses)
