---
targets: ["*"]
description: Survey the codebase for outstanding gaps, inconsistencies, and tooling/telemetry misses, and prioritize the next high-value improvement.
---

What gaps, issues, inconsistencies, permission/tooling issues, telemetry issues/missing features are still outstanding for AutoDev? Organizational issues? Bugs? Gaps in the current state of the codebase from the goals/target-state?

Across all, and considering the goals/target-state of the project, what is the next single/scoped priority for the best/necessary advancement/improvement/consistency/DRY/hardening/feature for the codebase/project?

Once identified, implement the necessary changes to the codebase to achieve that next priority.

1. Single idempotent install script
2. Single, consistent user-chat-entrypoint (ChatGPT application) and CLI (codex) which all orchestrators, MCPs, permissions, agent-delegation, etc. routes.
3. Global/user-level MCPs, agents, and skills that can be pointed at a codebase and work on it end-to-end.
4. Pointing the orchestrator to a workspace also allows for loading/using any local skills/MCPs/config in that codebase without conflicts with the user-level ones
5. AutoDev has clean, organized, DRY, maintainable, well-named-file codebase organization.
6. Model router handles all model routing across providers seamlessly; distributes subagents across providers, handles/checks/switches/allocated/skips as/where needed based on upstream errors/throttling/usage limits/etc. Subagents get the proper leaf-agent prompt, get the MCP tools, skills, permissions they actually use/need consistently/properly across model providers
7. Telemetry dashboard is complete, accurate, updates live/on-timer and provides a clear view of active subagent counts, orchestrator counts, model provider usage, errors, throttling, skill usage, agent-type counts, tool usage, MCP servers enabled/in-use, successful/failed orchestrator-spawn attempts, and other relevant metrics.