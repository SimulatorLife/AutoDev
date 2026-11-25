# AutoDev provider routing

This is the focused current routing guide. The [canonical target](autodev-console-target-state.md#role-oriented-execution-and-provider-routing) owns routing, permissions, transport and product requirements. [XACPX subagent delegation](xacpx-subagent-delegation.md) describes the native ACP architecture. The former Codex Responses proxy/bridge architecture is superseded; its detailed implementation and historical experiments remain in Git history, not active setup instructions.

## Available roles and configuration

Select a named capability role, not a provider/model, when requesting routed execution. `agents/roles/*.toml` and the generated `config/execution-contract.json` define the current role capabilities and restrictions. The canonical target governs their eventual lossless Rulesync ownership.

- `config/model-routing.json` owns configured providers, model assignments, tier priority/fallback groups, enabled state, limits and provider links. Do not reproduce model names, priorities or quotas in documentation or a second registry.
- The Console **Providers** resource is the operator edit surface; changes go through the authenticated Control API. **Agents** shows effective role assignments, and **MCPs** owns the MCP configuration/exposure controls.
- Default, Smart, Orchestrator and Subagent are provider assignment scopes, not a second named-agent catalogue. The effective role/tier mapping is validated by Runtime. Transport is selected independently of role authorization; an OpenCLI-backed provider is admitted to a role exactly when the execution contract says its transport can deliver that role's contract.

## Execution transports and routing

| Role / caller | Execution path |
| --- | --- |
| Interactive coding roles, including root orchestrator and named leaves | Native ACP for CLI providers (`codex-acp`, `claude-agent-acp`, `agy acp`, `copilot --acp`, `mcode acp`); OpenCLI-backed providers drive the site's own native MCP app, so the same shared Supergateway surfaces serve both transports. |
| `github-worker` | Direct bounded opencli site execution through the Runtime's opencli integration; never fall back to ACP. |
| All orchestrators | The canonical `xacpx` MCP over Supergateway for all child operations, independent of which provider executes the parent. |

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

OpenCLI is an execution transport, not a capability or permission boundary. A provider is eligible for a role when the canonical execution contract says so: `providers[].delegation` states whether the provider may drive orchestrator delegation, and `providers[].mcpIngress` states how the provider's transport reaches role-scoped MCP surfaces (`gateway`, `local`, `site-native` or `none`). No code path may special-case a provider name to decide role eligibility; a provider that cannot deliver a role's grants is refused at dispatch with a named reason instead of being routed around.

### Conversation-specific role binding

A browser-backed conversation must be bound to one role, one workspace and one coordinator. The site's native MCP integration is the binding mechanism, not a translated tool-call protocol:

- ChatGPT exposes installed apps in the composer's own "+" menu. `opencli chatgpt ask --app <app>` selects that app in the conversation before the prompt is sent, so only the selected app's tools reach the model. ChatGPT stores the app reference with the submitted turn, and the reply is matched against the app-attached turn.
- AutoDev names the app per role (`AUTODEV_CHATGPT_MCP_APP`, or `AUTODEV_CHATGPT_MCP_APP_BASE` plus the role), and the Runtime passes that name with every role turn. The operator connects the matching app in ChatGPT.
- The shared Supergateway publishes one named surface per published role at its own path, each carrying that role's tool allowlist and a role-scoped backend environment (the role identity, that role's own coordinator, and read-only confinement for read-only roles). The secure tunnel publishes one channel per role so each surface is independently addressable: the primary role on tunnel-client's required `main` channel, every additional role on a channel named after it.

No Responses translation bridge, custom tool-call text protocol, Codex-native delegation or parallel execution infrastructure is part of this path.

### Verified behaviour

The path was exercised against a live ChatGPT workspace: a conversation issued `xacpx__delegate_request` through the connected AutoDev app, the tunnel and the shared gateway, and the Runtime created the delegated task with the expected role, workspace and coordinator. `opencli chatgpt ask --app AutoDev` was verified to attach the app, submit the turn and return the reply.

`opencli-gemini` is kept at `delegation: "none"` and `mcpIngress: "site-native"`: Gemini's native MCP connectivity requires a publicly reachable remote MCP server registered in the Connected Console, and AutoDev's gateway is loopback-only with no Google private-tunnel client. That is a genuine upstream reachability gap, not an AutoDev restriction, and it must not be worked around by making the private gateway public.

Worker allocation diagnostics distinguish an unavailable OpenCLI execution transport from disabled assignments, missing model routes and cooling candidates. An all-cooling candidate set is refused rather than dispatched, and a pinned session checks cooldown against its own pinned model. The `github-worker` runner starts a fresh conversation and pins the returned native conversation ID to the AutoDev session; follow-up turns use OpenCLI's `--conversation` argument, preserve the original repository and workspace, reject missing or mismatched conversation IDs, and refuse concurrent turns or automatic replay after an uncertain result. Cancellation aborts the local CLI invocation; it does not prove that a remote browser action has stopped.

Native MCP integration investigation (2026-11-25): [OpenAI plugin metadata](https://developers.openai.com/plugins/reference) documents `openai/session` (anonymized conversation correlation), `openai/subject` and `openai/organization`. The existing gateway forwards tool-call metadata, but the XACPX stdio backend currently receives a fixed coordinator identity. Verify actual host-provided metadata and its provenance through the authenticated tunnel; do not trust a model argument, assume the anonymized identifier equals the OpenCLI browser UUID, or use correlation metadata alone as an authorization grant. Bind the authenticated principal, role, workspace and coordinator to an independently established Runtime session before admitting role-scoped calls, and verify that another conversation cannot reuse the binding. [Gemini Connected Apps](https://developers.google.com/connected-apps/mcp/) provides native remote MCP connectivity; verify its supported authenticated context and endpoint reachability separately. Do not make the existing private gateway public merely to enable Gemini.

### OpenCLI startup diagnostics

XACPX role execution resolves the CLI with the same `resolveOpencliCommand()` used by the managed browser service: an explicit validated `OPENCLI_BIN` override or the lockfile-pinned package entry point invoked with Runtime's Node executable. Do not depend on a global `opencli` being on launchd's PATH. Spawn failures (for example ENOENT), signal termination and cancellation are not fabricated child exit codes; native JSON error codes and hints are retained when available. A request that reaches XACPX but fails before the native conversation starts is a provider execution failure, not an MCP discovery failure.

The source fix has regression coverage in `runtime/tests/opencli-role.test.ts`. Reconcile the installed Runtime and retry a real delegated turn before declaring live acceptance. If allocation names only OpenCLI, inspect effective Console subagent assignments (which override source default ranking), not the requested agent label. Do not silently change operator assignments or clear cooldowns. Browser readiness, the configured dedicated-browser transport and the installed role-specific ChatGPT apps also require live verification; CLI resolution alone does not establish them.

## Observability and troubleshooting

Use the Console Providers, MCPs, Agents and Usage resources and the existing Runtime/OpenLIT diagnostics:

- Check the source-owned provider/model enablement, health, credential presence, actual version, request-outcome cooldown and separate quota report. Do not probe deleted provider bridge services or assume that an old health URL proves ACP session readiness.
- For a failed child, distinguish XACPX admission, provider selection, ACP startup, permission/MCP discovery, child execution, cancellation and final outcome. Preserve the parent/child IDs and failed-before-start reason.
- For missing tools, compare the effective role/workspace grant with actual provider/gateway discovery. Do not enable a server on the root or switch transports to bypass authorization.
- For a failed pinned session, inspect the source-confirmed error and reconcile potential side effects. Start a separate authorized session only if necessary; do not hop or replay automatically.
- Historical pre-ACP diagnostic events remain readable as historical evidence; no new provider-hop events should be produced by a pinned session.

See [local setup](local-setup.md), [session diagnostics](unified-session-diagnostics-plan.md), and the canonical [telemetry contract](autodev-console-target-state.md#10-usage-and-telemetry-contract). Run the existing repository validation suites using the pinned pnpm/Node toolchain; live authenticated acceptance remains separate from source-level checks.
