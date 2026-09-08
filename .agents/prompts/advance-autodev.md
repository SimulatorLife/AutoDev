What gaps, issues, inconsistencies, permission/tooling issues, telemetry issues/misses are still outstanding in the codebase? Organizational issues? Across all, what is the next priority for the best improvement/consistency/DRY/hardening for the codebase?

Consider the goals of the codebase:

1. Single idempotent install script
2. Single, consistent entrypoint (codex) which all orchestrators, MCPs, permissions, agent-delegation routes.
3. Global/user-level MCPs, agents, and skills that can be pointed at a codebase and work on it end-to-end.
4. Pointing the orchestrator to a workspace also allows for loading/using any local skills/MCPs/config in that codebase without conflicts with the user-level ones
5. AutoDev has clean, organized, DRY, maintainable, well-named-file codebase organization.
6. Model router handles all model routing across providers seamlessly; distributes subagents across providers, handles/checks/switches/allocated/skips as/where needed based on upstream errors/throttling/usage limits/etc. Subagents get the proper leaf-agent prompt, get the MCP tools, skills, permissions they actually use/need consistently/properly across model providers