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

Delegate through the canonical xacpx MCP and the configured execution contract. Playtest and browser operations must be exposed only to authorized roles through their scoped execution interface. The parent or root tool inventory is not proof of child exposure; verify an actual role-scoped invocation rather than relying on configuration or telemetry alone. Never enable the servers globally or use a parent or unrelated tool interface to compensate for missing access.

Playtester MCP requires the trusted workspace/session identity and dedicated runner credential supplied by Runtime. An arbitrary tool launch or shell invocation without that binding must stop. Report missing required capabilities or authorization without substituting another role's tools.

These handoffs reuse the existing orchestrator and roles; they do not create another scheduler or grant a role capabilities it does not already have.
