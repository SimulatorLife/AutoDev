# ChatGPT Secure MCP Tunnel

AutoDev can publish a single, private MCP tool catalogue to ChatGPT through OpenAI Secure MCP Tunnel. The tunnel client supervises [Supergateway](https://github.com/supercorp-ai/supergateway) in combined stdio mode. Supergateway owns server startup, tool discovery, namespacing, filtering and routing; AutoDev only renders its configuration. No inbound listener, public IP, port forwarding, or external gateway service is required.

## Installation (macOS)

Enable explicitly on the first normal install. Subsequent normal installs reconcile and restart the existing tunnel automatically; materialize-only installs never start or restart it. The installer installs the official Homebrew tunnel-client (minimum v0.0.21) when absent or outdated and pinned Supergateway 4.2.2 using pnpm in a private local installation and creates a dedicated login LaunchAgent, local config, and a private runtime key file. The default workspace is the AutoDev checkout. Set AUTODEV_CHATGPT_MCP_WORKSPACE to an absolute project directory to select another workspace.

OpenAI requires organization-level tunnel authorization independently of ChatGPT subscription or plugin access. Obtain a restricted runtime key (Tunnels Read + Use) from [Platform organization API keys](https://platform.openai.com/settings/organization/api-keys). An existing tunnel must be associated with the intended ChatGPT workspace. If you already have an administrator key with Tunnels Read + Manage and explicit organization and workspace IDs, the installer can create the tunnel automatically:

```sh
# Supply these secrets securely through your shell or secret manager;
# do not put actual keys in shell history or source control.
# CONTROL_PLANE_API_KEY: restricted runtime key (required on first install)
# OPENAI_ADMIN_KEY: only for automatic tunnel creation
export AUTODEV_CHATGPT_ORGANIZATION_ID=org_...
export AUTODEV_CHATGPT_WORKSPACE_ID=ws_...
export AUTODEV_CHATGPT_MCP_WORKSPACE=/absolute/path/to/project
./scripts/install.sh --enable-chatgpt-tunnel
```

Alternatively create a tunnel in [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), then provide its ID using CONTROL_PLANE_TUNNEL_ID instead of the admin key. Organization and workspace IDs are still required to verify scope. The installer preserves the returned ID, policy file path and runtime credential for future installs. It never stores the administrator key. Do not supply an administrator key as the runtime key. The installer cannot grant account permissions or create a restricted runtime credential without prior OpenAI authorization.

## MCP access policy and single source of truth

AutoDev renders the Supergateway configuration from the installed `provider-runtime/mcp-servers.json` catalogue, which already derives from `.rulesync/mcp.jsonc`. The gateway does not maintain its own server registry or tool inventory. The external-access grants live in `config/chatgpt-mcp-policy.json`; by default only the explicitly granted filesystem reads are exposed, with the existing filesystem launcher enforcing read-only access. This policy is a separate authorization decision, not a second MCP catalogue.

The checked-in policy is the reviewed upper bound. To narrow grants, provide a private JSON policy file using `AUTODEV_CHATGPT_MCP_POLICY_FILE`. The policy maps existing MCP declaration names to arrays of exact approved tool names. Wildcards and empty lists are rejected. A new compatible local MCP requires a reviewed change to the canonical catalogue and external-access policy (including its isolation and capability review); a local override cannot widen that policy. No gateway routing code changes are needed. The generated config preserves canonical commands and argument arrays, selects the workspace as cwd, and assigns a server-specific tool prefix. Credential-bearing/remote descriptors are rejected until an external transport policy is implemented.

Supergateway receives a clean explicit environment rather than the tunnel client's environment. The existing filesystem launcher enforces read-only access to the selected workspace only, with external skill roots excluded; Production additionally admits only the filesystem backend under a default-deny macOS Seatbelt profile, using the pinned installed filesystem package directly instead of a login shell. The sandbox allows reading the selected workspace and installed runtime dependencies, but denies network and writes. No additional MCP is admitted until it has its own reviewed confinement profile. Other servers remain unapproved until their workspace/network confinement, session isolation, and non-tool capabilities have been reviewed. Review their actual capabilities, prompts/resources, filesystem/network scope and session behavior before granting them; in particular Playwright can reach private services, and graph tools may access other indexed projects. Do not share the single stdio tunnel across mutually untrusted users. Native OpenTelemetry export is implemented; collector delivery and an end-to-end ChatGPT session isolation check remain acceptance requirements.

The installer runs the pinned Supergateway binary's `--checkConfig` and a real SDK initialize/tools/list probe, requiring the exact reviewed tool inventory and rejecting unreviewed non-tool capabilities. It then generates the official tunnel-client stdio profile with `init`, runs `doctor`, checks tunnel metadata with the runtime key, and requires the launchd-owned readiness listener. The previous profile and key are retained until replacement succeeds. Its combined stdio entry uses no network listener, including no SSE listener. Supergateway 4.2.2 has a reported stdio-to-SSE denial-of-service vulnerability (CVE-2026-131857); that transport is not used here. Reassess the pin when updating dependencies.

## Attach ChatGPT

Once installation prints the ready tunnel ID, open ChatGPT Plugins > Add custom MCP server > Tunnel. Choose the AutoDev ChatGPT tunnel (or use the printed ID), choose no MCP-level authentication for this private stdio gateway, and create/install the plugin. The OpenAI tunnel itself authenticates the runtime. Verify by asking ChatGPT to list the allowed directories and read a known file in the selected workspace.

The service uses the dedicated label com.codex.autodev-chatgpt-tunnel and local health port 3311. Check:

```sh
curl -fsS http://127.0.0.1:3311/readyz
open http://127.0.0.1:3311/ui
launchctl print "gui/$(id -u)/com.codex.autodev-chatgpt-tunnel"
```

Generated `supergateway.json`, persisted gateway settings, pinned dependency and lockfile, and logs reside under ${CODEX_HOME:-$HOME/.codex}/chatgpt-tunnel. The directory is private and the runtime key is stored in a mode-0600 file, referenced by path in the LaunchAgent. Disable persistently with `./scripts/install.sh --disable-chatgpt-tunnel`; later normal installs honor that state. Re-enable explicitly with `--enable-chatgpt-tunnel`. Set `AUTODEV_CHATGPT_TUNNEL_PORT` to override 3311. Run `./scripts/install.sh --check` to check configured tunnel readiness. An interrupted install may leave an install.lock directory; remove it only after confirming no installer is running. Revoke the tunnel/key in Platform when no longer needed.

References: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [official tunnel-client](https://github.com/openai/tunnel-client).

## Local protocol acceptance test

After the repository dependencies are installed, run `AUTODEV_TEST_SUPERGATEWAY=1 pnpm --filter @simulatorlife/autodev-runtime exec node --test tests/chatgpt-supergateway.integration.test.ts`. This installs the pinned gateway in a temporary directory and tests its real stdio protocol and the actual workspace-confined AutoDev filesystem MCP, including out-of-workspace and symlink reads and direct calls to hidden write tools. It requires no OpenAI credentials; a separate authorized ChatGPT round trip is still required.

The existing AutoDev MCP tool filter runs in its external read-only profile before each approved backend. It denies non-tool RPC capabilities, normalizes read-only annotations, and reuses AutoDev's MCP OpenTelemetry span implementation with the private OpenLIT receiver key. The filter forwards tool results unchanged and never exports arguments or content. External initialize/list requests have a 15-second deadline, calls 60 seconds, and uncooperative cancelled backends are terminated after a five-second grace. The combined gateway independently manages surviving backends and new sessions. Supergateway remains the sole aggregator; the reviewed policy is restricted to stateless, read-only tools until stronger per-server isolation is available.

## Console controls

After initial credential provisioning, the `/mcps` Console page displays tunnel readiness, the reviewed external policy and currently active grants. Operators can narrow grants, change the workspace, disconnect, re-enable, rotate the local restricted runtime key or forget that key. All mutations use the authenticated Control API with a revision check; the browser never receives the stored key. Forgetting the local credential does not revoke it remotely: use OpenAI Platform to revoke the credential or delete the tunnel.
