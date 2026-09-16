import json
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync"
HOOK_SOURCE = SOURCE_ROOT / "hooks.jsonc"
PORTABLE_CONFIG = REPO_ROOT / "scripts/codex/config.autodev.toml"
INSTALLER = REPO_ROOT / "scripts/codex/install-codex-integration.sh"
TARGETS = ("codexcli", "claudecode", "copilot", "antigravity-cli")
HOOK_PATHS = {
    "codexcli": ".codex/hooks.json",
    "claudecode": ".claude/settings.json",
    "copilot": ".github/hooks/copilot-hooks.json",
    "antigravity-cli": ".agents/hooks.json",
}
SOURCE_COMMANDS = [
    "node ~/.codex/src/hooks/session-start.ts",
    "node ~/.codex/src/hooks/subagent-start.ts",
    "node ~/.codex/src/hooks/root-delegation.ts",
    "node ~/.codex/src/hooks/skill-read-telemetry.ts",
]


def _generate(target: str, output_root: Path) -> None:
    result = subprocess.run(
        [
            "pnpm", "exec", "rulesync", "generate",
            "--input-roots", str(SOURCE_ROOT),
            "--targets", target,
            "--features", "hooks",
            "--output-roots", str(output_root),
            "--delete", "--silent",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode != 0:
        raise AssertionError(
            f"Rulesync {target} hook generation failed:\n"
            f"STDOUT={result.stdout}\nSTDERR={result.stderr}"
        )


def _commands(config: dict) -> list[str]:
    return [
        hook["command"]
        for entries in config["hooks"].values()
        for hook in entries
        if hook.get("type") == "command"
    ]


def _grouped_commands(events: dict) -> list[str]:
    return [
        hook["command"]
        for groups in events.values()
        for group in groups
        for hook in group["hooks"]
        if hook.get("type") == "command"
    ]


class RulesyncHooksGenerationTests(unittest.TestCase):
    """Rulesync owns hook declarations and produces each provider projection."""

    @classmethod
    def setUpClass(cls):
        cls._temp = tempfile.TemporaryDirectory()
        before = PORTABLE_CONFIG.read_bytes()
        cls.output = {target: Path(cls._temp.name) / target for target in TARGETS}
        for target, output_root in cls.output.items():
            _generate(target, output_root)
        cls.portable_config_unchanged = PORTABLE_CONFIG.read_bytes() == before

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    def _document(self, target: str) -> dict:
        return json.loads((self.output[target] / HOOK_PATHS[target]).read_text())

    def test_hook_source_is_the_six_command_portable_subset(self):
        source = json.loads(HOOK_SOURCE.read_text())
        self.assertEqual(
            set(source),
            {"hooks"},
            msg="hook source must contain only the canonical Rulesync hooks object",
        )
        self.assertEqual(
            set(source["hooks"]),
            {"sessionStart", "subagentStart", "beforeSubmitPrompt", "preToolUse"},
        )
        self.assertNotIn("prevent_idle_sleep", HOOK_SOURCE.read_text())
        self.assertEqual(_commands(source), SOURCE_COMMANDS)

    def test_portable_config_has_no_hook_arrays_and_codex_limit_is_documented(self):
        portable = tomllib.loads(PORTABLE_CONFIG.read_text())
        self.assertNotIn("hooks", portable)
        self.assertNotIn("prevent_idle_sleep", HOOK_SOURCE.read_text())
        self.assertIn('"hooks"', (REPO_ROOT / "rulesync.jsonc").read_text())
        self.assertIn("config.autodev.toml", INSTALLER.read_text())
        self.assertIn("src/config/compose-user-config.ts", INSTALLER.read_text())

    def test_target_projections_freeze_the_known_command_losses(self):
        projected = {
            target: set(
                _commands(self._document(target))
                if target == "copilot"
                else _grouped_commands(self._document(target)["hooks"])
                if target == "claudecode"
                else _grouped_commands(self._document(target)["rulesync"])
                if target == "antigravity-cli"
                else _grouped_commands(self._document(target)["hooks"])
            )
            for target in TARGETS
        }
        expected_losses = {
            "codexcli": set(),
            "claudecode": set(),
            "copilot": set(SOURCE_COMMANDS)
            - {"node ~/.codex/src/hooks/root-delegation.ts"},
            "antigravity-cli": set(SOURCE_COMMANDS)
            - {"node ~/.codex/src/hooks/skill-read-telemetry.ts"},
        }
        for target in TARGETS:
            with self.subTest(target=target):
                self.assertEqual(set(SOURCE_COMMANDS) - projected[target], expected_losses[target])

    def test_generation_writes_one_hook_file_per_target_and_nothing_live(self):
        self.assertTrue(self.portable_config_unchanged)
        for target in TARGETS:
            with self.subTest(target=target):
                output_root = self.output[target]
                self.assertEqual(
                    sorted(path.relative_to(output_root).as_posix() for path in output_root.rglob("*") if path.is_file()),
                    [HOOK_PATHS[target]],
                )

    def test_rulesync_config_run_generates_hooks_alongside_skills(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run(
                ["pnpm", "exec", "rulesync", "generate", "--config", "rulesync.jsonc",
                 "--output-roots", temp, "--delete", "--silent"],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            for target, path in HOOK_PATHS.items():
                self.assertTrue((Path(temp) / path).is_file(), target)

    def test_codex_and_claude_carry_every_hook_with_its_matcher_and_status(self):
        source = json.loads(HOOK_SOURCE.read_text())["hooks"]
        for target in ("codexcli", "claudecode"):
            with self.subTest(target=target):
                hooks = self._document(target)["hooks"]
                self.assertEqual(set(hooks), {"SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse"})
                self.assertEqual(_grouped_commands(hooks), SOURCE_COMMANDS)
                self.assertEqual(
                    hooks["UserPromptSubmit"][0]["hooks"][0]["statusMessage"],
                    source["beforeSubmitPrompt"][0]["statusMessage"],
                )
                self.assertEqual(hooks["PreToolUse"][0]["matcher"], source["preToolUse"][0]["matcher"])

    def test_copilot_and_antigravity_parity_limits_are_frozen(self):
        copilot = self._document("copilot")
        self.assertEqual(set(copilot["hooks"]), {"userPromptSubmitted"})
        self.assertEqual(_commands(copilot), ["node ~/.codex/src/hooks/root-delegation.ts"])
        antigravity = self._document("antigravity-cli")
        self.assertEqual(set(antigravity), {"rulesync"})
        self.assertEqual(set(antigravity["rulesync"]), {"PreToolUse"})
        self.assertEqual(
            _grouped_commands(antigravity["rulesync"]),
            ["node ~/.codex/src/hooks/skill-read-telemetry.ts"],
        )


if __name__ == "__main__":
    unittest.main()
