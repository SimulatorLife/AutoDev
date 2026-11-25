# ChatGPT Secure MCP Tunnel

> **Target-state boundary:** This operational guide describes the current tunnel integration. Under the canonical [mandatory shared MCP gateway](autodev-console-target-state.md#mandatory-shared-mcp-gateway) and [unified execution entrypoints](autodev-console-target-state.md#unified-user-chat-and-cli-execution-entrypoints) target, ChatGPT is a first-class, provider-agnostic agent participant governed by the same canonical role and execution contracts as Codex, Claude, Antigravity, Copilot, and mcode. External authentication establishes trusted identity and authorization, not a separate read-only capability model. All AutoDev-managed provider MCP traffic converges on Supergateway, with OpenAI Secure MCP Tunnel as optional authenticated external ingress.

Under the [unified desktop, IDE, CLI and external agent integration target](autodev-console-target-state.md#unified-desktop-ide-cli-and-external-agent-integration), ChatGPT desktop and web are enrolled native interfaces, not separate configuration authorities. Share supported plugin skills, prompts and gateway connections from canonical sources; qualify native hooks/telemetry per host rather than assuming Codex capabilities exist in ChatGPT. Current tunnel connectivity alone does not prove per-conversation authorization or visibility of native model/token activity.

AutoDev publishes a private, role-bound MCP surface to ChatGPT through OpenAI Secure MCP Tunnel. The `com.codex.autodev-chatgpt-tunnel` LaunchAgent supervises [Supergateway](https://github.com/supercorp-ai/supergateway) in loopback-only stateful Streamable HTTP mode (`127.0.0.1:3312` by default, `stateful: true`, 60-second idle session timeout) alongside `tunnel-client` and AutoDev's in-process loopback pooled backend host (`runtime/src/mcp/chatgpt-backend-pool.ts`). Supergateway owns external Streamable HTTP transport, `Mcp-Session-Id` session isolation, tool prefixing, combining, and local Bearer authentication; the pooled backend host multiplexes repeated one-shot client sessions (such as ChatGPT opening a new MCP session per tool call without `DELETE`) onto at most one lazily started, idle-reaped, OS-confined backend process per MCP server (and one shared HTTP transport per remote server), keeping process count and memory bounded regardless of session volume. AutoDev owns role-contract rendering, workspace/OS confinement, loopback binding, XACPX orchestration IPC, and per-generation local Bearer authentication. No non-loopback listener, public IP, port forwarding, or external gateway service is required.

## Installation (macOS)

Enable explicitly on the first normal install. Subsequent normal installs reconcile and restart the existing tunnel automatically; materialize-only installs never start or restart it. The installer taps `openai/tools` and installs the official Homebrew tunnel-client (minimum v0.0.21) when absent or outdated; Supergateway is an exact runtime dependency in `runtime/package.json` and is installed by the ordinary workspace package installation. It creates a dedicated login LaunchAgent and private local configuration; the runtime key is stored in macOS Keychain, not a plaintext runtime key file. The default workspace is the AutoDev checkout and the default effective role is `orchestrator`. Set `AUTODEV_CHATGPT_MCP_WORKSPACE` to an absolute project directory and optionally `AUTODEV_CHATGPT_AGENT_ROLE` to any canonical role declared in `config/execution-contract.json` (e.g., `orchestrator`, `worker`, `default`, `smart`, `explorer`, `docs-researcher`, `validator`).

OpenAI requires organization-level tunnel authorization independently of ChatGPT subscription or plugin access. Obtain a restricted runtime key (Tunnels Read + Use) from [Platform organization API keys](https://platform.openai.com/settings/organization/api-keys). An existing tunnel must be associated with the intended ChatGPT workspace. If you already have an administrator key with Tunnels Read + Manage and explicit organization and workspace IDs, the installer can create the tunnel automatically:

```sh
# Supply these secrets securely through your shell, macOS Keychain, or a
# git-ignored .env file at the repository root (loaded automatically by
# scripts/install.sh via Node.js --env-file-if-exists; explicit shell exports
# take precedence). Never commit actual keys or put them in shell history.
# AUTODEV_CHATGPT_TUNNEL_API_KEY: restricted runtime key (required on first install)
# OPENAI_ADMIN_KEY: only for automatic tunnel creation
export AUTODEV_CHATGPT_ORGANIZATION_ID=org_...
export AUTODEV_CHATGPT_WORKSPACE_ID=ws_...
export AUTODEV_CHATGPT_MCP_WORKSPACE=/absolute/path/to/project
export AUTODEV_CHATGPT_AGENT_ROLE=orchestrator
./scripts/install.sh --enable-chatgpt-tunnel
```

Alternatively create a tunnel in [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), then provide its ID using `CONTROL_PLANE_TUNNEL_ID` instead of the admin key (in the environment or repository-root `.env`). Organization and workspace IDs are still required to verify scope. The installer isolates tunnel credentials (`OPENAI_ADMIN_KEY`, `AUTODEV_CHATGPT_TUNNEL_API_KEY`) from dependency installation, materialization, and service restarts, stores `AUTODEV_CHATGPT_TUNNEL_API_KEY` in macOS Keychain (under service/item name `AUTODEV_CHATGPT_TUNNEL_API_KEY`, trusted for `/usr/bin/security` so the unattended LaunchAgent retrieves it across service restarts and system reboots without interactive prompts), configures `tunnel-client` with `--control-plane-api-key-ref env:AUTODEV_CHATGPT_TUNNEL_API_KEY`, and preserves the returned ID, role, workspace, and policy file path for future installs. Existing plaintext `runtime.key` files are securely overwritten and removed automatically once migration to Keychain succeeds. It never stores or logs the administrator key. Do not supply an administrator key as the runtime key. The installer cannot grant account permissions or create a restricted runtime credential without prior OpenAI authorization.

## Role-driven MCP access policy and single source of truth

AutoDev renders the Supergateway configuration from the installed `provider-runtime/mcp-servers.json` catalogue (derived from `.rulesync/mcp.jsonc`) and derives effective MCP exposure and permissions directly from the assigned role's canonical execution contract (`agents/roles/*.toml` -> `config/execution-contract.json`) combined with portable denials/allowlists in `.rulesync/permissions.jsonc`. There is no separate ChatGPT-only capability model or read-only blanket restriction:

- **Writable roles** (`orchestrator`, `worker`, `default`, `smart`, `validator`, `github-worker`) receive full authorized tools for every MCP server enabled in their role contract, including workspace-confined `filesystem` mutations (`write_file`, `edit_file`, `create_directory`, `move_file`), writable `lsp` actions where contracted, and read-only access to AutoDev skill roots (`--read-only-dir`).
- **Orchestration roles** (`orchestrator`) also receive the canonical `xacpx` MCP interface (`@ganglion/xacpx`'s `xacpx mcp-stdio`), connected over AutoDev's canonical Unix-socket orchestration IPC (`XACPX_ORCHESTRATION_SOCKET`) to `XacpxSessionManager`. Delegated child agents receive their own contracted role permissions, canonical role prompts, provider pinning, workspace confinement, concurrency limits, and strict coordinator ownership isolation.
- **Read-only roles** (`explorer`, `docs-researcher`, `browser-tester`, `playtester`, `playtest-analyst`) remain strictly read-only at both the MCP tool layer (`--read-only` on `filesystem`, read-only tool filtering) and the OS Seatbelt layer, and never receive `xacpx` delegation tools.
- **Operator narrowing:** Operators may optionally narrow tool grants within the assigned role's authorized set via Console `/mcps` controls or a private override JSON via `AUTODEV_CHATGPT_MCP_POLICY_FILE`, and can never widen beyond the canonical role contract. When `config/execution-contract.json`, `.rulesync/permissions.jsonc`, `provider-runtime/mcp-servers.json`, or the assigned role changes, normal installs re-discover tool inventories and reconcile automatically.

Supergateway receives a clean explicit environment rather than the tunnel client's environment, setting `AUTODEV_AGENT_ROLE`, `AUTODEV_MCP_WORKSPACE`, `AUTODEV_XACPX_WORKSPACE`, `AUTODEV_XACPX_COORDINATOR_SESSION`, `XACPX_ORCHESTRATION_SOCKET`, and `AUTODEV_MCP_READ_ONLY=1` **only** when the assigned role has `readOnly: true`. Local backends run under role-aware confinement enforced by `externalMcpBackend`:

- `filesystem` runs inside macOS Seatbelt (`sandbox-exec`) with `--confine-roots`, read-only skill roots (`--read-only-dir`), blocked `.env*` secrets (except workspace `.env.example`), blocked host secrets (`.ssh`, `.aws`, `.gnupg`, `chatgpt-tunnel`), and blocked network; writes are strictly confined to `workspace` for writable roles and completely denied (`--read-only`) for read-only roles.
- `lsp`, `cocoindex-code`, `codegraphcontext`, and `xacpx` run under Seatbelt profiles enforcing role-scoped workspace write boundaries, blocking host secrets and non-local outbound network traffic, while permitting local Unix-socket IPC (`xacpx` orchestration socket, CocoIndex/CGC local daemons).
- Role-authorized `playwright`, `playtest`, and `github` servers launch through AutoDev's canonical `launcher.ts` and `tool-filter.ts` allowlists when enabled by the assigned role.
- Remote Streamable HTTP documentation servers (`openaiDeveloperDocs`, `context7`, and `googleDeveloperKnowledge` when credentialed) are bridged through `tool-filter.ts --remote`, resolving only the declaring server's credentials in memory without exposing secrets to Supergateway or sibling local servers.
- `tool-filter.ts` preserves truthful upstream tool annotations (never forging `readOnlyHint: true` on mutating or delegation tools) and exports native OpenTelemetry spans across all local and remote filtered backends.

The installer runs the pinned Supergateway binary's `--checkConfig` and a real Streamable HTTP SDK initialize/tools/list probe across independent client sessions, verifying unauthenticated `401` rejection, distinct `Mcp-Session-Id` isolation, the exact role-authorized tool inventory, and rejection of unapproved non-tool capabilities. It then generates the official `tunnel-client` Streamable HTTP profile (`sample_mcp_remote_no_auth`) pointing to one channel per published role (`http://127.0.0.1:<mcpPort>/<role>/mcp`), runs `doctor` against an ephemeral candidate Supergateway (with `MCP_OAUTH_DISCOVERY=disabled` and `file:`-referenced `Authorization` headers), checks tunnel metadata with the runtime key, and requires launchd-owned readiness listeners for both `tunnel-client` (`3311`) and `supergateway` (`3312`). The previous profile and keys are retained until replacement succeeds. Supergateway binds exclusively to `127.0.0.1` using Streamable HTTP (not SSE) and requires a per-generation 256-bit `apiKeyFile` Bearer token. Supergateway 4.2.2 has a reported stdio-to-SSE denial-of-service vulnerability (CVE-2026-131857); that transport is not used here. Reassess the pin when updating dependencies.

`tunnel-client` requires one MCP target on its `main` channel: it refuses to pass `doctor`, and the daemon refuses to start, without one. The primary role's surface is therefore published on `main`, and every additional published role gets a channel named after it (`orchestrator` -> `main`, `explorer` -> `explorer`). The profile's routing table and the arguments `doctor` validates are both generated from that one plan, so they cannot disagree about which channel carries which surface. When a stage fails, the installer reports that stage's own output -- `tunnel-client doctor` writes its check report to stdout -- instead of only naming the stage.

## Attach ChatGPT

Once installation prints the ready tunnel ID, open ChatGPT Plugins > Add custom MCP server > Tunnel. Choose the AutoDev ChatGPT tunnel (or use the printed ID), choose no MCP-level authentication for this private tunnel gateway (local loopback traffic is authenticated by `tunnel-client` with the per-generation Bearer token), and create/install the plugin. The OpenAI tunnel itself authenticates the runtime.

### Published roles

The gateway publishes one role-scoped surface per published role, each at its own path (`/<role>/mcp`) with that role's tool allowlist, that role's coordinator and that role's read-only confinement. The tunnel publishes one channel per role, so each surface is independently addressable: the primary role is published on tunnel-client's required `main` channel, and each additional role on a channel named after it. The primary role comes first and owns the gateway's delegation coordinator; additional roles are published through the Console's **Additional published roles** control or the `AUTODEV_CHATGPT_MCP_ROLES` environment variable.

AutoDev names each role's ChatGPT app: `AUTODEV_CHATGPT_MCP_APP` names one app for every role, and `AUTODEV_CHATGPT_MCP_APP_BASE` (default `AutoDev`) names the base the role name is appended to, so the orchestrator's app is `AutoDev` and the `explorer` role's app is `AutoDev explorer`. Name the connected app in ChatGPT to match, so the Runtime's `opencli chatgpt ask --app <app>` selects the right surface. The app is selected in ChatGPT's own composer menu before the prompt is sent, so only that role's tools reach the model.

The service uses the dedicated label `com.codex.autodev-chatgpt-tunnel` (configured with `ProcessType: Interactive` so launchd does not throttle multi-backend session startup) and local health port 3311. Check:

```sh
curl -fsS http://127.0.0.1:3311/readyz
open http://127.0.0.1:3311/ui
launchctl print "gui/$(id -u)/com.codex.autodev-chatgpt-tunnel"
```

Generated `supergateway.json`, per-generation mode-`0600` local gateway auth files (`supergateway.key` and `supergateway-auth.header`), persisted gateway settings and logs reside under `${CODEX_HOME:-$HOME/.codex}/chatgpt-tunnel`. The directory is private (`0700`) and the runtime credential (`AUTODEV_CHATGPT_TUNNEL_API_KEY`) is stored in macOS Keychain rather than in a plaintext file, injected only into `tunnel-client` at LaunchAgent startup (`env:AUTODEV_CHATGPT_TUNNEL_API_KEY`), and omitted from `supergateway` and MCP tools. Disable persistently with `./scripts/install.sh --disable-chatgpt-tunnel`; later normal installs honor that state. Re-enable explicitly with `--enable-chatgpt-tunnel`. Set `AUTODEV_CHATGPT_TUNNEL_PORT` to override 3311, `AUTODEV_CHATGPT_MCP_PORT` to override 3312, and `AUTODEV_CHATGPT_AGENT_ROLE` to change the assigned role. Run `./scripts/install.sh --check` to check configured tunnel readiness and confirm no plaintext `runtime.key` remains. An interrupted install may leave an `install.lock` directory; remove it only after confirming no installer is running. Revoke the tunnel/key in Platform when no longer needed.

References: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [official tunnel-client](https://github.com/openai/tunnel-client).

## Local protocol acceptance test

After the repository dependencies are installed, run `AUTODEV_TEST_SUPERGATEWAY=1 pnpm --filter @simulatorlife/autodev-runtime exec node --test tests/chatgpt-supergateway.integration.test.ts`. This exercises the workspace-installed Supergateway (and `tunnel-client dev proxy` when installed) over stateful Streamable HTTP, covering:

- concurrent client sessions, repeated initialization, reconnection, and Supergateway restarts;
- authorized filesystem mutations (`write_file`, `edit_file`, `create_directory`) under writable roles and strict write denial under read-only roles, with workspace/symlink/secret confinement and truthful tool annotations;
- end-to-end `xacpx` child delegation, task watching/listing/messaging/cancellation, delegated role isolation (read-only vs. writable child permissions), role-escalation denial, workspace-escape denial, and cross-session coordinator isolation;
- Seatbelt-confined LSP and CocoIndex semantic search plus authenticated remote documentation MCPs with credential isolation.

## Console controls

After initial credential provisioning, the `/mcps` Console page displays tunnel readiness, the active canonical role, the role's authorized tool inventory, and currently active grants. Operators can change the assigned role or workspace, optionally narrow grants within the role's contract, disconnect, re-enable, rotate the local restricted runtime key, or forget that key. All mutations use the authenticated Control API with a revision check; the browser never receives the stored key. Forgetting the local credential does not revoke it remotely: use OpenAI Platform to revoke the credential or delete the tunnel.

Developer dependency update: after changing dependencies, regenerate the root `pnpm-lock.yaml` with the repository-pinned pnpm (`pnpm install --lockfile-only`), then run `pnpm install --frozen-lockfile`. The lockfile must be committed before merging; no separate Supergateway installation or lockfile is maintained.
