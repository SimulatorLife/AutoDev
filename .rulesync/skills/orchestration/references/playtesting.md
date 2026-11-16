# Playtesting handoffs

Read this when a task asks to run, review, or verify a game playtest.

Keep execution, interpretation, verification and publication separate:

- Delegate an explicitly requested, operator-authorized run to `playtester`;
  require the exact workspace/build approval and bounded budget first.
  Workspace enablement alone is not run approval. If there is no exact
  approval, do not run a game or substitute a fixture; report the missing gate.
- Delegate review of completed, workspace-scoped evidence to
  `playtest-analyst`. Give it immutable episode/window references and the
  game-owned rubric; it is read-only and cannot run, branch, modify code, or
  publish issues.
- Ask the existing `validator` to independently inspect consequential claims
  from the cited evidence before treating them as verified; do not prime it
  with the analyst's conclusion.
- Use `browser-tester` only for an explicitly relevant rendered-UI check,
  against an authorized target and real captured interface. It does not replace
  the game adapter or infer human outcomes.
- The root retains workspace approval, experiment authorization, issue publication, and owner-promotion decisions. Preserve incomplete, negative,
  contradictory and unavailable evidence.

Playtest requires Runtime-bound authorization, an approved target, and exact
budgets; never pass credentials or invent run context. Use Console Play/Watch
for the supported end-to-end workflow.

## MCP boundary

Codex-native `multi_agent_v1` children inherit the parent's host MCP set;
per-agent `mcp_servers` in a custom role file do not override that host-level
set ([Codex subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents)).
AutoDev intentionally disables `playtest` and `playwright` in the root session.
A native child using `autodev/<role>` is still served through AutoDev's Model
Router: for roles with `roleScopedMcp`, the router filters provider candidates
to bridges that inject the role contract's MCP into that provider invocation
(`roleMcpInjection`). The provider-native MCP tools may therefore be available
even when absent from the parent/child host `ALL_TOOLS`; use the role's
supported provider-mediated path rather than generic parent-session MCP tools.
Verify a real provider tool call, not just the role TOML or `mcpExposed`
telemetry. Never enable the servers globally. Playtester MCP additionally
requires the trusted workspace/session identity and dedicated runner credential
supplied by Runtime; an arbitrary MCP launch or shell invocation without that
binding must stop. For provider-internal delegation, `autodev_spawn` still asks
Codex to create the native child thread, which is then routed through the same
role-aware Router path.

These handoffs reuse the existing orchestrator and roles; they do not create
another scheduler or grant a role capabilities it does not already have.
