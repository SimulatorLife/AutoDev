import ast
import json
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
AUTODEV_CONFIG = REPO_ROOT / "scripts/codex/config.autodev.toml"
CLAUDE_BRIDGE = REPO_ROOT / "scripts/codex-claude-cli-responses-proxy.py"
INSTALLER = REPO_ROOT / "scripts/codex/install-codex-integration.sh"
RULESYNC_CONFIG = REPO_ROOT / "rulesync.jsonc"
RULESYNC_WORKFLOW = REPO_ROOT / ".github/workflows/rulesync-mcp-shadow-drift.yml"
RULESYNC_PERMISSION_SOURCE = REPO_ROOT / ".rulesync/permissions.jsonc"
SHADOW_ROOT = REPO_ROOT / "tests/fixtures/rulesync-shadow"


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
        for server in config["mcp_servers"].values():
            self.assertEqual(server["default_tools_approval_mode"], "approve")

    def test_claude_bridge_permission_policy_is_role_aware(self):
        tree = ast.parse(CLAUDE_BRIDGE.read_text())
        assignments = {
            node.targets[0].id: ast.literal_eval(node.value)
            for node in tree.body
            if isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id in {
                "DISALLOWED_CLAUDE_TOOLS",
                "DISALLOWED_CLI_COMMANDS",
                "CROSS_SESSION_CLAUDE_TOOLS",
                "CLAUDE_RESEARCH_ALLOWED_TOOLS",
            }
        }
        self.assertEqual(assignments["DISALLOWED_CLAUDE_TOOLS"], ("Agent", "Task"))
        self.assertEqual(assignments["DISALLOWED_CLI_COMMANDS"], ("Bash(ccc *)",))
        self.assertEqual(assignments["CROSS_SESSION_CLAUDE_TOOLS"], ("SendMessage", "ListAgents"))
        self.assertEqual(assignments["CLAUDE_RESEARCH_ALLOWED_TOOLS"], ("WebSearch", "WebFetch"))

        source = CLAUDE_BRIDGE.read_text()
        for marker in (
            'role_contract.get("readOnly")',
            'PLAYWRIGHT_AGENT_ROLES',
            'PLAYWRIGHT_DISALLOWED_TOOLS',
            'RESEARCH_CAPABLE_ROLES',
            'denied.extend(["Bash", "Edit", "Write", "NotebookEdit"])',
            'allowed_boundary = ["--allowed-tools", ",".join(CLAUDE_RESEARCH_ALLOWED_TOOLS)]',
            '"--permission-mode"',
            '"bypassPermissions"',
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
        workflow = RULESYNC_WORKFLOW.read_text()
        self.assertNotIn("--features mcp,rules,hooks,permissions", workflow)
        self.assertNotIn("--features permissions", workflow)
        shadow_permissions = [
            path for path in SHADOW_ROOT.rglob("*")
            if "permission" in path.name.lower()
        ]
        self.assertEqual(shadow_permissions, [])

    def test_inventory_is_read_only(self):
        paths = (
            AUTODEV_CONFIG,
            CLAUDE_BRIDGE,
            INSTALLER,
            RULESYNC_CONFIG,
            RULESYNC_WORKFLOW,
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
