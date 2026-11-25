# AutoDev provider routing

This is the focused current routing guide. The [canonical target](autodev-console-target-state.md#role-oriented-execution-and-provider-routing) owns routing, permissions, transport and product requirements. [XACPX subagent delegation](xacpx-subagent-delegation.md) describes the native ACP architecture. The former Codex Responses proxy/bridge architecture is superseded; its detailed implementation and historical experiments remain in Git history, not active setup instructions.

## Available roles and configuration

Select a named capability role, not a provider/model, when requesting routed execution. `agents/roles/*.toml` and the generated `config/execution-contract.json` define the current role capabilities and restrictions. The canonical target governs their eventual lossless Rulesync ownership.

- `config/model-routing.json` owns configured providers, model assignments, tier priority/fallback groups, enabled state, limits and provider links. Do not reproduce model names, priorities or quotas in documentation or a second registry.
- The Console **Providers** resource is the operator edit surface; changes go through the authenticated Control API. **Agents** shows effective role assignments, and **MCPs** owns the MCP configuration/exposure controls.
- Default, Smart, Orchestrator and Subagent are provider assignment scopes, not a second named-agent catalogue. The effective role/tier mapping is validated by Runtime. `github-worker` is the explicit transport exception below.

## Execution transports and routing

| Role / caller | Execution path |
| --- | --- |
| Interactive coding roles, including root orchestrator and named leaves | Native ACP via the selected provider CLI: `codex-acp`, `claude-agent-acp`, `agy acp`, `copilot --acp`, or `mcode acp`. |
| `github-worker` | Direct bounded opencli site execution through the Runtime's opencli integration; never fall back to ACP. |
| All orchestrators | Target: the canonical `xacpx` MCP over Supergateway for all child operations, independent of which provider executes the parent. |

`runtime/src/xacpx/manager.ts` owns session selection and pinning. It uses the existing Router policy and rejects a role change, a no-longer-eligible pinned provider or a cooling pinned provider. The Runtime exposes the ACP session lifecycle at `/v1/acp/sessions` (create/list, prompt, cancel, close). See `runtime/src/xacpx/http.ts` for the current typed request contracts and [local setup](local-setup.md) for installation. Native provider sessions own history and auto-compaction. The former per-provider Responses translation bridges, custom continuation/compaction adapters and Codex-specific tool mirroring are not prerequisites or fallback paths.

### Orchestrator routing and fallback

The Router selects an eligible provider/model for a new session using explicit selection or the configured role/tier priorities, provider enablement, authentication, capacity and observed cooldowns. Once admitted, the provider/model/role are pinned. Resume and follow-up operations stay on that session; a blocked pinned session reports its blocker. No orchestrator-only mid-session hopping or provider-native child execution is permitted. A new authorized linked session is a separate identity, with previous side effects and approvals reconciled before re-dispatch.

The [canonical delegation contract](autodev-console-target-state.md#cross-provider-agent-delegation-contract) requires XACPX-only spawn, messaging, wait/results, status, cancellation, close and reuse. Preserve parent/child ownership and in-host child visibility without creating native children as a separate execution mechanism. The current `xacpx` declaration exists; exclusive gateway access and provider parity remain acceptance gates, not claims of completed deployment.

### Cooldowns and provider selection

Use the canonical [selection order and cooldown policy](autodev-console-target-state.md#resilience-mechanics-and-provider-cooldown-policy). The Router owns scoped request-outcome cooldowns and concurrency; quota-axi reports observed subscription usage and reset windows for presentation, never establishes a Router cooldown or allocation policy. Disabled providers or models remain configured but ineligible for new allocation. Unavailable evidence is unknown, not healthy. Never replay a potentially mutating accepted turn without reconciling it.

## MCPs, roles, and security

`.rulesync/mcp.jsonc` is the single backend declaration authority (rendered directly via `jsonc-parser` without provider-specific MCP exclusions or a temporary Codex TOML detour) and `.rulesync/permissions.jsonc` owns portable supported permissions. `config/execution-contract.json` projects full role capabilities (`readOnly`, `shell`, `hooks`, `mcp`, `mcpTools`, `mcpApprovalMode`, `mcpEnvVars`, `skills`, `skillsPolicy`, `reasoning`) without legacy provider-specific `spawnTools`, `roleMcpInjection`, `roleScopedMcp`, or `allowProviderHop` exclusions, and unknown roles fail closed. ACP provider profiles (`runtime/src/acp/provider-profiles.ts`) pass native ACP `mcpServers` on `session/new`, publish truthful per-provider CLI isolation gaps, and enforce role boundaries uniformly at AutoDev's ACP permission boundary. Read-only, shell-disabled, and sealed roles receive only their contracted tools; a provider cannot widen those grants through native configuration.

The [mandatory shared MCP gateway](autodev-console-target-state.md#mandatory-shared-mcp-gateway) is the end state for **every** AutoDev-managed MCP client, including ChatGPT as a first-class agent participant. Current direct backend projections are migration inputs only. Permissions and MCP exposure follow the assigned canonical role contract (`agents/roles/*.toml` -> `config/execution-contract.json` + `.rulesync/permissions.jsonc`), never a separate external-only read-only policy; operators may optionally narrow grants within the role's contract. Do not treat discovery or a subscription as authorization. See [ChatGPT tunnel setup](chatgpt-secure-mcp-tunnel.md) for the currently shipped authenticated ChatGPT gateway ingress.

## OpenCLI execution

The opencli integration is restricted to `github-worker` site execution and its health/model/browser facilities, not a general-purpose interactive ACP provider. The dedicated browser mode and current operator controls are described in [opencli-separate-browser.md](opencli-separate-browser.md). Its current opt-in mode is a gap against the target's dedicated-browser-only isolation contract. Browser authentication is an explicit operator action; no shared profile or cookie exposure is an acceptable target fallback.

## Observability and troubleshooting

Use the Console Providers, MCPs, Agents and Usage resources and the existing Runtime/OpenLIT diagnostics:

- Check the source-owned provider/model enablement, health, credential presence, actual version, request-outcome cooldown and separate quota report. Do not probe deleted provider bridge services or assume that an old health URL proves ACP session readiness.
- For a failed child, distinguish XACPX admission, provider selection, ACP startup, permission/MCP discovery, child execution, cancellation and final outcome. Preserve the parent/child IDs and failed-before-start reason.
- For missing tools, compare the effective role/workspace grant with actual provider/gateway discovery. Do not enable a server on the root or switch transports to bypass authorization.
- For a failed pinned session, inspect the source-confirmed error and reconcile potential side effects. Start a separate authorized session only if necessary; do not hop or replay automatically.
- Historical pre-ACP diagnostic events remain readable as historical evidence; no new provider-hop events should be produced by a pinned session.

See [local setup](local-setup.md), [session diagnostics](unified-session-diagnostics-plan.md), and the canonical [telemetry contract](autodev-console-target-state.md#10-usage-and-telemetry-contract). Run the existing repository validation suites using the pinned pnpm/Node toolchain; live authenticated acceptance remains separate from source-level checks.
