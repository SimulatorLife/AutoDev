# Codex-agnostic ACP orchestration (`@agentclientprotocol/sdk` + `xacpx` + RuleSync)

> **Phase 2 cutover implemented.** AutoDev orchestrates every interactive agent provider natively over ACP (`@agentclientprotocol/sdk`, `@ganglion/xacpx`, `acpx`) with RuleSync-projected MCPs, skills, prompts, permissions, and provider-neutral hooks. All legacy `/v1/responses` provider bridges, `codex-tools-shim`, custom compaction/continuation/item-id/transcript shims, Codex SQLite state polling (`codex-state-collector`), mid-session provider hopping (`provider-hops`), and the custom PostgreSQL/pgvector memory stack have been removed.

> **Canonical delegation target:** The existing `xacpx` MCP declaration launches `@ganglion/xacpx` using its native `mcp-stdio` entry point. All orchestrators, including Codex, must use this one MCP for child delegation and lifecycle, via the [mandatory shared MCP gateway](autodev-console-target-state.md#mandatory-shared-mcp-gateway). ACP/acpx remains the execution transport; AutoDev remains the allocation, authorization and child-ownership authority. No Codex-native `multi_agent_v1__*`, custom spawn shim or provider-specific fallback survives cutover. Native host UI must display the XACPX-owned child lifecycle, not create a competing child. This is a target requirement, not a claim that the gateway/delegation parity gates are already complete.

## Architecture Overview

1. **Single Policy Authority (AutoDev Router):**
   - `runtime/src/router/routing.ts` (`ROUTING_POLICY`), `runtime/src/router/cooldown/`, `runtime/src/router/concurrency/`, `runtime/src/router/usage.ts`, `runtime/src/router/correlation.ts`, and `runtime/src/router/telemetry.ts` remain AutoDev's sole authority for role -> tier -> provider/model allocation, cooldowns, concurrency limits, usage attribution, and OTLP telemetry.
2. **Live ACP Execution & Session Pinning (`XacpxSessionManager` + `/v1/acp/sessions`):**
   - `runtime/src/xacpx/manager.ts` pins each session strictly to one provider/model on creation (no mid-session cross-provider hops) and manages native ACP connections (`ClientApp` + `ndJsonStream`) against:
     - `claude` -> `claude-agent-acp`
     - `antigravity` -> `agy acp`
     - `copilot` -> `copilot --acp`
     - `minimax` / `mcode` -> `mcode acp`
     - `codex` -> `codex-acp`
   - Each provider CLI manages its own session history, context window, and native auto-compaction without AutoDev interception.
   - `session/request_permission` enforces AutoDev's read-only contract (`evaluateReadOnlyToolCall` + `roleContract(role).readOnly`) fail-closed for read-only roles (`explorer`, `browser-tester`, `docs-researcher`, `playtest-analyst`).
   - `runtime/src/xacpx/http.ts` exposes `/v1/acp/sessions` (`GET`, `POST`, `/:sessionId/prompt`, `/:sessionId/cancel`, `DELETE /:sessionId`) directly on the AutoDev Router (`runtime/src/router/http.ts`).
3. **Isolation Profiles (`provider-profiles.ts`) & RuleSync Surface:**
   - `runtime/src/acp/provider-profiles.ts` disables native tools, built-in skills, default system prompts, and ungranted MCP servers for each ACP executor so AutoDev's RuleSync-projected MCP servers (`filesystem`, `github`, `codegraphcontext`, `context7`, `playwright`, `xacpx`, `playtest`), prompts, skills, permissions, and provider-neutral hooks (`file-surface`, `block-ccc-cli`, `role-sandbox`, `skill-read-telemetry`, `root-delegation`, `session-start`) are the sole execution surface under `$AUTODEV_HOME`.
   - `runtime/src/platform/mcode-projection.ts` projects and validates `AGENTS.md`, `mcp.json`, `hooks.json`, and `permissions.json` for `mcode`.
4. **Autonomous `github-worker` Web Execution (`opencli`):**
   - `github-worker` (`agents/roles/github-worker.toml`, all skills disabled) routes exclusively to `opencli-chatgpt` / `opencli-gemini` via direct `opencli` site execution without `/v1/responses` translation.
   - `runtime/src/providers/opencli-browser.ts` and `runtime/src/control-api/opencli-browser.ts` continue to govern AutoDev's dedicated Chrome vs extension browser mode setting.
5. **Memory Status:**
   - Custom AutoDev PostgreSQL/pgvector memory storage, HTTP endpoints, Console UI, and capture hooks have been removed; hosted Mem0 setup remains postponed for future work.
