import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE = REPO_ROOT / ".rulesync" / "rules" / "overview.md"
AGENTS = REPO_ROOT / "AGENTS.md"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "rulesync-mcp-shadow-drift.yml"
LIVE_RULES = ("AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md")
TARGETS = ("codexcli", "claudecode", "copilot", "antigravity-cli")


def _write_ephemeral_input(root: Path) -> Path:
    input_root = root / "input"
    rules = input_root / "rules"
    rules.mkdir(parents=True)
    rules.joinpath("overview.md").write_bytes(
        b'---\n'
        b'root: true\n'
        b'targets: ["*"]\n'
        b'description: "AutoDev shared workspace instructions for all AI tooling"\n'
        b'globs: ["**/*"]\n'
        b'---\n'
        + SOURCE.read_bytes()
    )
    return input_root


class RulesyncLiveRulesTests(unittest.TestCase):
    def _generate(self, target: str, input_root: Path, output_root: Path) -> None:
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
                "rules",
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
            msg=f"Rulesync {target} generation failed:\n{result.stderr}",
        )

    def test_canonical_source_and_live_rules_are_byte_identical_to_agents(self):
        expected = AGENTS.read_bytes()
        self.assertEqual(SOURCE.read_bytes(), expected)
        self.assertEqual((REPO_ROOT / "CLAUDE.md").read_bytes(), expected)
        self.assertEqual(
            (REPO_ROOT / ".github" / "copilot-instructions.md").read_bytes(), expected
        )

    def test_ephemeral_rulesync_generation_succeeds_for_all_targets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            input_root = _write_ephemeral_input(root)
            for target in TARGETS:
                with self.subTest(target=target):
                    output_root = root / target
                    self._generate(target, input_root, output_root)
                    relative = "CLAUDE.md" if target == "claudecode" else (
                        ".github/copilot-instructions.md"
                        if target == "copilot"
                        else "AGENTS.md"
                    )
                    generated = output_root / relative
                    self.assertTrue(generated.is_file())
                    self.assertEqual(generated.read_bytes(), AGENTS.read_bytes() + b"\n")

    def test_workflow_checks_live_rules_without_expanding_shadow_features(self):
        workflow = WORKFLOW.read_text()
        live_check = workflow.split("Check live rules from an ephemeral Rulesync input root", 1)[1]
        self.assertIn("--features rules", live_check)
        self.assertIn("--check", live_check)
        self.assertIn("CLAUDE.md", live_check)
        self.assertIn(".github/copilot-instructions.md", live_check)
        for feature in ("mcp", "skills", "hooks"):
            self.assertNotIn(f"--features {feature}", live_check)
        shadow = workflow.split("Detect Rulesync drift against tracked shadow fixtures", 1)[1]
        self.assertIn("--features mcp,rules,hooks", shadow)


if __name__ == "__main__":
    unittest.main()
