import json
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync"
PORTABLE_CONFIG = REPO_ROOT / "scripts/codex/config.autodev.toml"
EXPECTED_ARGS = {
    "lsp": ["-lc", 'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" lsp'],
    "cocoindex-code": ["-lc", 'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" cocoindex-code'],
}


class RulesyncMcpShadowTests(unittest.TestCase):
    targets = ("codexcli", "claudecode", "copilot", "antigravity-cli")

    def _generate(self, target: str, output_root: Path) -> None:
        result = subprocess.run(
            [
                "pnpm",
                "exec",
                "rulesync",
                "generate",
                "--input-roots",
                str(SOURCE_ROOT),
                "--targets",
                target,
                "--features",
                "mcp",
                "--output-roots",
                str(output_root),
                "--delete",
                "--silent",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(
            result.returncode,
            0,
            msg=f"Rulesync {target} generation failed:\nSTDOUT={result.stdout}\nSTDERR={result.stderr}",
        )

    @staticmethod
    def _read_servers(target: str, output_root: Path) -> dict:
        if target == "codexcli":
            return tomllib.loads((output_root / ".codex/config.toml").read_text())["mcp_servers"]
        if target == "antigravity-cli":
            return json.loads((output_root / ".agents/mcp_config.json").read_text())["mcpServers"]
        if target == "copilot":
            return json.loads((output_root / ".vscode/mcp.json").read_text())["servers"]
        return json.loads((output_root / ".mcp.json").read_text())["mcpServers"]

    def test_pinned_rulesync_generates_isolated_provider_outputs(self):
        before = PORTABLE_CONFIG.read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for target in self.targets:
                with self.subTest(target=target):
                    self._generate(target, root / target)
                    servers = self._read_servers(target, root / target)
                    self.assertIn("lsp", servers)
                    self.assertIn("cocoindex-code", servers)
                    for name, args in EXPECTED_ARGS.items():
                        self.assertEqual(servers[name]["command"], "bash")
                        self.assertEqual(servers[name]["args"], args)
                    self.assertNotIn("node_repl", servers)
                    self.assertNotIn("cua_repl", servers)
                    self.assertNotIn("autodev_spawn", servers)

            codex = self._read_servers("codexcli", root / "codexcli")
            self.assertNotIn("openaiDeveloperDocs", codex)
            self.assertFalse(codex["playwright"]["enabled"])

            claude = self._read_servers("claudecode", root / "claudecode")
            self.assertEqual(claude["openaiDeveloperDocs"]["url"], "https://developers.openai.com/mcp")

            copilot = self._read_servers("copilot", root / "copilot")
            self.assertNotIn("openaiDeveloperDocs", copilot)
            self.assertNotIn("playwright", copilot)

            antigravity = self._read_servers("antigravity-cli", root / "antigravity-cli")
            self.assertEqual(antigravity["openaiDeveloperDocs"]["serverUrl"], "https://developers.openai.com/mcp")
            self.assertNotIn("playwright", antigravity)

        self.assertEqual(PORTABLE_CONFIG.read_bytes(), before)

    def test_rulesync_config_is_mcp_only_and_non_global(self):
        config_text = (REPO_ROOT / "rulesync.jsonc").read_text()
        self.assertIn('"features": ["mcp"]', config_text)
        self.assertIn('"delete": false', config_text)
        self.assertIn('"global": false', config_text)
        source = json.loads((SOURCE_ROOT / "mcp.jsonc").read_text())
        self.assertNotIn("autodev_spawn", source)
        self.assertEqual(set(source), {"$schema", "mcpServers", "codexcli", "copilot", "antigravity-cli"})


if __name__ == "__main__":
    unittest.main()
