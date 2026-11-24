# ChatGPT Secure MCP Tunnel

AutoDev can publish a single, private MCP tool catalogue to ChatGPT through OpenAI Secure MCP Tunnel. The tunnel client supervises a local stdio gateway built with AutoDev's existing MCP SDK; the gateway launches the existing AutoDev MCP servers and namespaces their tools. No inbound listener, public IP, port forwarding, or external gateway service is required.

## Installation (macOS)

Enable explicitly on the first normal install. Subsequent normal installs reconcile and restart the existing tunnel automatically; materialize-only installs never start or restart it. The installer installs the official Homebrew tunnel-client when absent and creates a dedicated login LaunchAgent, local config, and a private runtime key file. The default workspace is the AutoDev checkout. Set AUTODEV_CHATGPT_MCP_WORKSPACE to an absolute project directory to select another workspace.

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

Alternatively create a tunnel in [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), then provide its ID using CONTROL_PLANE_TUNNEL_ID instead of the admin key and IDs. The installer preserves the returned ID, policy and runtime credential for future installs. It never stores the administrator key. Do not supply an administrator key as the runtime key. The installer cannot grant account permissions or create a restricted runtime credential without prior OpenAI authorization.

## MCP access policy

By default the gateway exposes only the read-only filesystem tools. Filesystem writes are always denied; AutoDev's existing launcher confines access to the selected workspace and configured read-only skill roots. Enable other servers and exact tools using an explicit JSON policy at install time. For example:

```sh
export AUTODEV_CHATGPT_MCP_POLICY='{"filesystem":["list_directory","read_text_file","search_files","list_allowed_directories"],"playwright":["browser_navigate","browser_snapshot","browser_take_screenshot"],"codegraphcontext":["*"]}'
./scripts/install.sh --enable-chatgpt-tunnel
```

Supported server keys: filesystem, playwright, codegraphcontext, cocoindex-code, lsp, playtest. Wildcards explicitly grant all tools on that server (except filesystem, which only accepts the safe read allowlist). Prefer exact tool names after reviewing upstream capabilities. Non-filesystem MCP servers are not confined by the filesystem MCP's sandbox; graph tools can access or mutate other indexes, and browser tools can reach local/private network services. Playwright uses AutoDev's isolated browser profile, but the persistent gateway shares its backend state across calls; do not share this tunnel across mutually untrusted users or workspaces. Never grant a workspace that contains secrets or broad filesystem roots. Tool names are prefixed with the originating server name. The gateway does not proxy provider or tunnel credentials to child MCP servers.

## Attach ChatGPT

Once installation prints the ready tunnel ID, open ChatGPT Plugins > Add custom MCP server > Tunnel. Choose the AutoDev ChatGPT tunnel (or use the printed ID), choose no MCP-level authentication for this private stdio gateway, and create/install the plugin. The OpenAI tunnel itself authenticates the runtime. Verify by asking ChatGPT to list the allowed directories and read a known file in the selected workspace.

The service uses the dedicated label com.codex.autodev-chatgpt-tunnel and local health port 3311. Check:

```sh
curl -fsS http://127.0.0.1:3311/readyz
open http://127.0.0.1:3311/ui
launchctl print "gui/$(id -u)/com.codex.autodev-chatgpt-tunnel"
```

Config and logs reside under ${CODEX_HOME:-$HOME/.codex}/chatgpt-tunnel. The directory is private and the runtime key is stored in a mode-0600 file, referenced by path in the LaunchAgent. Stop and disable the service with launchctl bootout and launchctl disable for the label; a later normal AutoDev install re-enables it if gateway.json is present. Remove gateway.json to opt out of future reconciliation after stopping the service. Revoke the tunnel/key in Platform when no longer needed.

References: [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [official tunnel-client](https://github.com/openai/tunnel-client).
