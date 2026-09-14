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


def _strip_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text.strip()
    end = text.find("\n---", 3)
    if end == -1:
        return text.strip()
    return text[end + 4 :].lstrip("\n").rstrip()


def _rule_source_body() -> str:
    rule_path = SOURCE_ROOT / "rules" / "overview.md"
    text = rule_path.read_text()
    if not text.startswith("---\n"):
        raise AssertionError(
            f"Rulesync rule source must start with YAML frontmatter: {rule_path}"
        )
    end = text.find("\n---\n", 3)
    if end == -1:
        raise AssertionError(
            f"Rulesync rule source missing closing frontmatter delimiter: {rule_path}"
        )
    frontmatter = text[4:end]
    if "root: true" not in frontmatter:
        raise AssertionError(
            f"Rulesync rule source must declare root: true: {rule_path}"
        )
    if "targets:" not in frontmatter:
        raise AssertionError(
            f"Rulesync rule source must declare targets: {rule_path}"
        )
    return text[end + 5 :].strip()


class RulesyncMcpShadowTests(unittest.TestCase):
    targets = ("codexcli", "claudecode", "copilot", "antigravity-cli")

    def _generate(self, target: str, output_root: Path, features: str = "mcp") -> None:
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
    def _read_rule(target: str, output_root: Path) -> str:
        rule_rel = EXPECTED_RULE_PATH[target]
        return _strip_frontmatter((output_root / rule_rel).read_text())

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
        expected = _rule_source_body()
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
                    self.assertEqual(self._read_rule(target, root / target), expected)

    def test_tracked_shadow_rule_fixtures_match_agents_md(self):
        expected = _rule_source_body()
        self.assertTrue(
            (SHADOW_ROOT / "AGENTS.md").is_file(),
            msg="Shadow AGENTS.md must exist for codexcli/antigravity-cli rule parity",
        )
        self.assertEqual(_strip_frontmatter((SHADOW_ROOT / "AGENTS.md").read_text()), expected)
        self.assertTrue(
            (SHADOW_ROOT / "CLAUDE.md").is_file(),
            msg="Shadow CLAUDE.md must exist for claudecode rule parity",
        )
        self.assertEqual(_strip_frontmatter((SHADOW_ROOT / "CLAUDE.md").read_text()), expected)
        copilot_path = SHADOW_ROOT / ".github" / "copilot-instructions.md"
        self.assertTrue(
            copilot_path.is_file(),
            msg="Shadow .github/copilot-instructions.md must exist for copilot rule parity",
        )
        self.assertEqual(_strip_frontmatter(copilot_path.read_text()), expected)

    def test_rulesync_rule_source_matches_repo_agents_md_body(self):
        expected = (REPO_ROOT / "AGENTS.md").read_text().strip()
        self.assertEqual(_rule_source_body(), expected)

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
