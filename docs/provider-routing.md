# AutoDev provider routing

This is the focused current routing guide. The [canonical target](autodev-console-target-state.md#role-oriented-execution-and-provider-routing) owns routing, permissions, transport and product requirements. [XACPX subagent delegation](xacpx-subagent-delegation.md) describes the native ACP architecture. The former Codex Responses proxy/bridge architecture is superseded; its detailed implementation and historical experiments remain in Git history, not active setup instructions.

## Available roles and configuration

Select a named capability role, not a provider/model, when requesting routed execution. `agents/roles/*.toml` and the generated `config/execution-contract.json` define the current role capabilities and restrictions. The canonical target governs their eventual lossless Rulesync ownership.

- `config/model-routing.json` owns configured providers, model assignments, tier priority/fallback groups, enabled state, limits and provider links. Do not reproduce model names, priorities or quotas in documentation or a second registry.
- The Console **Providers** resource is the operator edit surface; changes go through the authenticated Control API. **Agents** shows effective role assignments, and **MCPs** owns the MCP configuration/exposure controls.
- Default, Smart, Orchestrator and Subagent are provider assignment scopes, not a second named-agent catalogue. The effective role/tier mapping is validated by Runtime. Transport is selected independently of role authorization; the current bounded OpenCLI worker path is a transitional implementation.

## Execution transports and routing

| Role / caller | Execution path |
| --- | --- |
| Interactive coding roles, including root orchestrator and named leaves | Native ACP for CLI providers (`codex-acp`, `claude-agent-acp`, `agy acp`, `copilot --acp`, `mcode acp`); native site MCP integration for OpenCLI-backed providers is the required parity target. |
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

The current OpenCLI implementation supports bounded `github-worker` site execution and health/model/browser facilities. This is an implementation gap, not a target role restriction: OpenCLI-backed ChatGPT and Gemini must support orchestrator and other authorized roles through native site MCP access to the shared Supergateway, including XACPX delegation. Until authenticated conversation-specific role/workspace/coordinator binding and live tool invocation are proven, unsupported assignments must fail closed with a specific parity diagnostic. Do not infer tool availability from a browser login or an installed account-level plugin, and do not restore custom Responses bridges or text tool-call protocols. The dedicated browser mode and current operator controls are described in [opencli-separate-browser.md](opencli-separate-browser.md). Its current opt-in mode is a gap against the target's dedicated-browser-only isolation contract. Browser authentication is an explicit operator action; no shared profile or cookie exposure is an acceptable target fallback.

The current `github-worker` runner explicitly starts a fresh conversation and then pins the returned native conversation ID to the AutoDev session. Follow-up turns use OpenCLI's `--conversation` argument, preserve the original repository and workspace, reject missing or mismatched conversation IDs, and refuse concurrent turns or automatic replay after an uncertain result. Cancellation aborts the local CLI invocation; it does not prove that a remote browser action has stopped. The session association is in memory, not a restart-durable accepted-turn ledger. The ChatGPT model selection and dedicated-browser execution path still require live verification.

Native MCP integration investigation (2026-11-25): [OpenAI plugin metadata](https://developers.openai.com/plugins/reference) documents `openai/session` (anonymized conversation correlation), `openai/subject` and `openai/organization`. The existing gateway forwards tool-call metadata, but the XACPX stdio backend currently receives a fixed coordinator identity. Verify actual host-provided metadata and its provenance through the authenticated tunnel; do not trust a model argument, assume the anonymized identifier equals the OpenCLI browser UUID, or use correlation metadata alone as an authorization grant. Bind the authenticated principal, role, workspace and coordinator to an independently established Runtime session before admitting role-scoped calls, and verify that another conversation cannot reuse the binding. [Gemini Connected Apps](https://developers.google.com/connected-apps/mcp/) provides native remote MCP connectivity; verify its supported authenticated context and endpoint reachability separately. Do not make the existing private gateway public merely to enable Gemini.

Worker allocation diagnostics now distinguish an unavailable OpenCLI execution transport from disabled assignments, missing model routes and cooling candidates. An all-cooling candidate set is refused rather than dispatched, and a pinned session checks cooldown against its own pinned model. The live worker task `task-8510bc16-579` failed before provider launch; the running Runtime's effective assignments and the new diagnostics still require verification after reconciliation.

## Observability and troubleshooting

Use the Console Providers, MCPs, Agents and Usage resources and the existing Runtime/OpenLIT diagnostics:

- Check the source-owned provider/model enablement, health, credential presence, actual version, request-outcome cooldown and separate quota report. Do not probe deleted provider bridge services or assume that an old health URL proves ACP session readiness.
- For a failed child, distinguish XACPX admission, provider selection, ACP startup, permission/MCP discovery, child execution, cancellation and final outcome. Preserve the parent/child IDs and failed-before-start reason.
- For missing tools, compare the effective role/workspace grant with actual provider/gateway discovery. Do not enable a server on the root or switch transports to bypass authorization.
- For a failed pinned session, inspect the source-confirmed error and reconcile potential side effects. Start a separate authorized session only if necessary; do not hop or replay automatically.
- Historical pre-ACP diagnostic events remain readable as historical evidence; no new provider-hop events should be produced by a pinned session.

See [local setup](local-setup.md), [session diagnostics](unified-session-diagnostics-plan.md), and the canonical [telemetry contract](autodev-console-target-state.md#10-usage-and-telemetry-contract). Run the existing repository validation suites using the pinned pnpm/Node toolchain; live authenticated acceptance remains separate from source-level checks.
