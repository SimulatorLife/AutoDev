import json
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
AUTODEV_CONFIG = REPO_ROOT / "scripts/codex/config.autodev.toml"
CLAUDE_BRIDGE = REPO_ROOT / "src/providers/claude.ts"
INSTALLER = REPO_ROOT / "scripts/codex/install-codex-integration.sh"
RULESYNC_CONFIG = REPO_ROOT / "rulesync.jsonc"
RULESYNC_MCP_SOURCE = REPO_ROOT / ".rulesync/mcp.jsonc"
RULESYNC_PERMISSION_SOURCE = REPO_ROOT / ".rulesync/permissions.jsonc"


class RulesyncPermissionsInventoryTests(unittest.TestCase):
    def test_codex_portable_permission_surface_is_explicit(self):
        config = tomllib.loads(AUTODEV_CONFIG.read_text())
        self.assertEqual(config["approval_policy"], "never")
        self.assertEqual(config["sandbox_mode"], "workspace-write")
        self.assertEqual(config["approvals_reviewer"], "user")
        self.assertTrue(config["sandbox_workspace_write"]["network_access"])
        self.assertTrue(config["tools"]["web_search"])
        self.assertTrue(config["features"]["hooks"])
        self.assertNotIn("permissions", config["features"])
        for provider in config["model_providers"].values():
            self.assertEqual(provider["wire_api"], "responses")
        self.assertNotIn("mcp_servers", config)
        codex_servers = json.loads(RULESYNC_MCP_SOURCE.read_text())["codexcli"]["mcpServers"]
        for name, server in codex_servers.items():
            if "command" in server:
                with self.subTest(server=name):
                    self.assertEqual(server["default_tools_approval_mode"], "approve")

    def test_claude_bridge_permission_policy_is_role_aware(self):
        source = CLAUDE_BRIDGE.read_text()
        # The bridge is now TypeScript, so the role-aware permission policy is
        # encoded as exported arrays and a typed rule lookup rather than Python
        # module constants. The contract assertions below check the values
        # the router still depends on.
        for marker in (
            'DISALLOWED_CLAUDE_TOOLS = [ "Agent", "Task" ]',
            'DISALLOWED_CLI_COMMANDS = [ "Bash(ccc *)" ]',
            'CROSS_SESSION_CLAUDE_TOOLS = [ "SendMessage", "ListAgents" ]',
            'CLAUDE_RESEARCH_ALLOWED_TOOLS = [ "WebSearch", "WebFetch" ]',
            'PLAYWRIGHT_AGENT_ROLES',
            'PLAYWRIGHT_DISALLOWED_TOOLS',
            'RESEARCH_CAPABLE_ROLES',
            '"Bash", "Write"',
            '"--allowed-tools"',
            '"--permission-mode"',
            'CLAUDE_CODE_PERMISSION_MODE ?? "bypassPermissions"',
        ):
            self.assertIn(marker, source)

    def test_antigravity_permissions_are_dynamic_and_machine_local(self):
        source = INSTALLER.read_text()
        for marker in (
            "check_agy_code_mcp_permissions()",
            "grant_agy_code_mcp_permissions()",
            'permissions.setdefault("allow", [])',
            'os.path.abspath(os.path.expanduser(root))',
            'f"read_file({normalized})"',
            'f"read_file({normalized}/**)"',
            'os.path.expanduser("~/.agents")',
            'os.path.expanduser("~/.codex")',
            'mcp(cocoindex-code)',
            'mcp(lsp)',
            'read_url(*)',
            'unsandboxed(pwd)',
            'unsandboxed(pnpm test)',
            "unsandboxed(python3 -m unittest discover -s tests -p 'test_*.py')",
            'mcp(playwright)',
        ):
            self.assertIn(marker, source)
        self.assertIn('tempfile.mkstemp', source)
        self.assertIn('os.replace(temporary, path)', source)

    def test_rulesync_permissions_generation_remains_deferred(self):
        self.assertFalse(RULESYNC_PERMISSION_SOURCE.exists())
        config = json.loads(RULESYNC_CONFIG.read_text())
        self.assertNotIn("permissions", config["features"])

    def test_inventory_is_read_only(self):
        paths = (
            AUTODEV_CONFIG,
            CLAUDE_BRIDGE,
            INSTALLER,
            RULESYNC_CONFIG,
            RULESYNC_MCP_SOURCE,
        )
        before = {path: path.read_bytes() for path in paths}
        # The inventory intentionally performs no generation, subprocess calls,
        # or configuration writes. Reading the sources is the operation under test.
        for path in paths:
            self.assertTrue(path.is_file())
            self.assertGreater(len(path.read_bytes()), 0)
        self.assertEqual(before, {path: path.read_bytes() for path in paths})


if __name__ == "__main__":
    unittest.main()
