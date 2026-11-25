# Codex-agnostic ACP orchestration (`@agentclientprotocol/sdk` + `xacpx` + RuleSync)

> **Phase 2 cutover implemented.** AutoDev orchestrates every interactive agent provider natively over ACP (`@agentclientprotocol/sdk`, `@ganglion/xacpx`, `acpx`) with RuleSync-projected MCPs, skills, prompts, permissions, and provider-neutral hooks. All legacy `/v1/responses` provider bridges, `codex-tools-shim`, custom compaction/continuation/item-id/transcript shims, Codex SQLite state polling (`codex-state-collector`), mid-session provider hopping (`provider-hops`), and the custom PostgreSQL/pgvector memory stack have been removed.

> **Canonical delegation target:** The existing `xacpx` MCP declaration launches `@ganglion/xacpx` using its native `mcp-stdio` entry point, connected via Unix-socket orchestration IPC (`runtime/src/xacpx/orchestration-ipc.ts`) to `XacpxSessionManager`. All orchestrators — including ChatGPT, Codex, Claude, Antigravity, Copilot, and mcode — use this one MCP for child delegation and lifecycle, via the [mandatory shared MCP gateway](autodev-console-target-state.md#mandatory-shared-mcp-gateway). ACP/acpx remains the execution transport; AutoDev remains the allocation, role/workspace authorization, concurrency, and child-ownership authority. Delegated child agents receive their exact contracted role permissions, canonical role prompts, and workspace confinement regardless of which provider initiated the delegation. No Codex-native `multi_agent_v1__*`, custom spawn shim or provider-specific fallback survives cutover. Native host UI must display the XACPX-owned child lifecycle, not create a competing child.

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
   - `session/request_permission` enforces AutoDev's canonical role contract fail-closed: unknown roles are denied, provider-native file tools are blocked in favor of `filesystem` MCP, shell tools are denied when `contract.shell === false`, MCP calls are restricted to `contract.mcp` and `contract.mcpTools`, and `contract.readOnly === true` enforces `evaluateReadOnlyToolCall`.
   - `connectLiveAcpSession` passes native ACP `McpServer[]` declarations (`mcpServers`, targeting the shared Supergateway HTTP endpoint when configured or role-authorized servers otherwise) directly into `session/new`, and prepends the canonical role system prompt (composed by the single owner `runtime/src/shared/role-prompts.ts`) on the initial turn for provider CLIs lacking a `--system-prompt` flag.
   - `runtime/src/xacpx/orchestration-ipc.ts` hosts the canonical Unix-socket orchestration IPC (`$CODEX_HOME/run/xacpx-orchestration.sock`) spoken by `@ganglion/xacpx`'s `xacpx mcp-stdio`, enforcing role validation, orchestrator-escalation denial, workspace confinement, concurrency limits, and per-coordinator child ownership isolation.
   - `runtime/src/xacpx/http.ts` exposes `/v1/acp/sessions` (`GET`, `POST`, `/:sessionId/prompt`, `/:sessionId/cancel`, `DELETE /:sessionId`) directly on the AutoDev Router (`runtime/src/router/http.ts`).
3. **Truthful Isolation Profiles (`provider-profiles.ts`) & RuleSync Surface:**
   - `runtime/src/acp/provider-profiles.ts` derives MCP servers, shell enablement, hooks, read-only state, and skills strictly from the canonical execution contract (`config/execution-contract.json`, which fails closed on unknown roles). Rather than claiming uniform CLI-level isolation where provider binaries lack flags (`codex-acp`, `mcode acp`, `agy acp`, partial `copilot --excluded-tools`), each launch spec publishes an explicit `isolation` surface (`enforced`, `runtime_permission_guard`, or `unverified_gap`) plus concrete provider gaps while enforcing role parity at AutoDev's ACP permission and gateway boundaries.
   - Canonical MCP catalogue rendering (`runtime/src/config/render-bridge-mcp-catalogue.ts`) and execution-contract generation (`runtime/src/config/render-execution-contract.ts`) read `.rulesync/mcp.jsonc` directly via `jsonc-parser` (`@simulatorlife/autodev-data/files`), without routing through a temporary Codex `config.toml` projection.
   - `runtime/src/platform/mcode-projection.ts` projects and validates `AGENTS.md`, `mcp.json`, `hooks.json`, and `permissions.json` for `mcode` using `jsonc-parser` (upstream `rulesync` 43.11.0 includes `mimocode` but not MiniMax `mcode`).
4. **Autonomous `github-worker` Web Execution (`opencli`):**
   - `github-worker` (`agents/roles/github-worker.toml`, all skills disabled) routes exclusively to `opencli-chatgpt` / `opencli-gemini` via direct `opencli` site execution without `/v1/responses` translation.
   - `runtime/src/providers/opencli-browser.ts` and `runtime/src/control-api/opencli-browser.ts` continue to govern AutoDev's dedicated Chrome vs extension browser mode setting.
5. **Memory Status:**
   - Custom AutoDev PostgreSQL/pgvector memory storage, HTTP endpoints, Console UI, and capture hooks have been removed; hosted Mem0 setup remains postponed for future work.
