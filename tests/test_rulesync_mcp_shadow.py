import re
import json
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync"
PORTABLE_CONFIG = REPO_ROOT / "scripts/codex/config.autodev.toml"
SHADOW_ROOT = REPO_ROOT / "tests/fixtures/rulesync-shadow"
EXPECTED_ARGS = {
    "lsp": ["-lc", 'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" lsp'],
    "cocoindex-code": ["-lc", 'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" cocoindex-code'],
}
EXPECTED_RULE_PATH = {
    "codexcli": "AGENTS.md",
    "claudecode": "CLAUDE.md",
    "copilot": ".github/copilot-instructions.md",
    "antigravity-cli": "AGENTS.md",
}


def _rule_source_bytes() -> bytes:
    return (SOURCE_ROOT / "rules" / "overview.md").read_bytes()


class RulesyncMcpShadowTests(unittest.TestCase):
    targets = ("codexcli", "claudecode", "copilot", "antigravity-cli")

    def _generate(self, target: str, output_root: Path, features: str = "mcp") -> None:
        with tempfile.TemporaryDirectory() as temp:
            input_root = SOURCE_ROOT
            if features == "rules":
                input_root = Path(temp)
                rule_path = input_root / "rules" / "overview.md"
                rule_path.parent.mkdir(parents=True)
                rule_path.write_bytes(
                    b"---\n"
                    b"root: true\n"
                    b"targets: [\"*\"]\n"
                    b"description: \"AutoDev shared workspace instructions for all AI tooling\"\n"
                    b"globs: [\"**/*\"]\n"
                    b"---\n"
                    + _rule_source_bytes()
                )

            result = subprocess.run(
                [
                    "pnpm",
                    "exec",
                    "rulesync",
                    "generate",
                    "--input-roots",
                    str(input_root),
                    "--targets",
                    target,
                    "--features",
                    features,
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

    @staticmethod
    def _read_rule(target: str, output_root: Path) -> bytes:
        rule_rel = EXPECTED_RULE_PATH[target]
        return (output_root / rule_rel).read_bytes()

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

    def test_pinned_rulesync_generates_root_rule_per_target(self):
        expected = (REPO_ROOT / "AGENTS.md").read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for target in self.targets:
                with self.subTest(target=target):
                    self._generate(target, root / target, features="rules")
                    rule_path = root / target / EXPECTED_RULE_PATH[target]
                    self.assertTrue(
                        rule_path.is_file(),
                        msg=f"Rulesync {target} missing rule output at {rule_path}",
                    )
                    self.assertEqual(self._read_rule(target, root / target), expected + b"\n")

    def test_tracked_shadow_rule_fixtures_match_agents_md(self):
        expected = (REPO_ROOT / "AGENTS.md").read_bytes()
        self.assertTrue(
            (SHADOW_ROOT / "AGENTS.md").is_file(),
            msg="Shadow AGENTS.md must exist for codexcli/antigravity-cli rule parity",
        )
        self.assertEqual((SHADOW_ROOT / "AGENTS.md").read_bytes(), expected + b"\n")
        self.assertTrue(
            (SHADOW_ROOT / "CLAUDE.md").is_file(),
            msg="Shadow CLAUDE.md must exist for claudecode rule parity",
        )
        self.assertEqual((SHADOW_ROOT / "CLAUDE.md").read_bytes(), expected + b"\n")
        copilot_path = SHADOW_ROOT / ".github" / "copilot-instructions.md"
        self.assertTrue(
            copilot_path.is_file(),
            msg="Shadow .github/copilot-instructions.md must exist for copilot rule parity",
        )
        self.assertEqual(copilot_path.read_bytes(), expected + b"\n")

    def test_rulesync_rule_source_matches_repo_agents_md_bytes(self):
        self.assertEqual(_rule_source_bytes(), (REPO_ROOT / "AGENTS.md").read_bytes())

    def test_rulesync_config_is_mcp_and_rules_non_global(self):
        config_text = (REPO_ROOT / "rulesync.jsonc").read_text()
        features_match = re.search(
            r'"features"\s*:\s*\[([^\]]*)\]', config_text
        )
        self.assertIsNotNone(
            features_match,
            msg=f'rulesync.jsonc must declare a features array: {config_text!r}',
        )
        features = [
            item.strip().strip('"')
            for item in features_match.group(1).split(",")
            if item.strip()
        ]
        self.assertIn("mcp", features)
        self.assertIn("rules", features)
        self.assertIn("delete", config_text)
        self.assertIn("false", config_text.split("delete", 1)[1].split(",", 1)[0])
        self.assertIn('"global": false', config_text)
        source = json.loads((SOURCE_ROOT / "mcp.jsonc").read_text())
        self.assertNotIn("autodev_spawn", source)
        self.assertEqual(set(source), {"$schema", "mcpServers", "codexcli", "copilot", "antigravity-cli"})


if __name__ == "__main__":
    unittest.main()
