# Delegating through xacpx MCP

Use the single authorized AutoDev delegation surface: xacpx MCP. The canonical architecture is documented in `docs/xacpx-subagent-delegation.md`. Discover actual callable names and schemas through the current role's active interface; do not assume a particular provider or Code Mode wrapper.

## Task operations

- `delegate_request`: delegate a bounded task to a configured `targetAgent`, with the full `task` and absolute `workingDirectory`. Set `role`, `groupId`, or `parallel` only when supported and appropriate.
- `delegate_batch`: dispatch multiple independent tasks together using `tasks`; each carries the same request fields. Inspect each admission result independently. For native MCP Tasks, use the single-request operation as advertised instead.
- `task_watch`: follow the returned opaque task ID; use `mode: "until_attention_or_terminal"` and a bounded timeout appropriate to the task. Continue from the returned `nextAfterSeq` when applicable; a terminal watch already includes the result.
- `task_get`: recover or inspect a known task when necessary; do not fetch again after a terminal watch already supplied the output.
- `task_cancel`: cancel only an owned task when cancellation is actually justified, not merely because a watch timed out.
- Respond to confirmation or worker questions using the applicable authorized coordinator operations and the returned task context. Never approve an action beyond the user's authorization.

When the client supports MCP Tasks, use its advertised task execution and lifecycle operations for native handles. Otherwise use the xacpx task operations above. Do not substitute provider-private delegation APIs, create competing children, or bypass missing authorization. If xacpx is not exposed to a role that requires it, report the capability blocker.

## Efficient execution

Batch independent delegations when supported. Keep tool output and reads bounded; prefer targeted discovery, avoid repeating evidence already in context, and choose semantic, structural, language-aware, or source inspection according to the question and available capabilities. Wait for meaningful task events rather than repeatedly polling; timeout does not mean failure.

Use the authorized workspace file and command interfaces. File access remains subject to the configured workspace and role boundaries; never use another interface to circumvent a denial.
