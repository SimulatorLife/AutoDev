import json
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync"
HOOK_SOURCE = SOURCE_ROOT / "hooks.jsonc"
PORTABLE_CONFIG = REPO_ROOT / "scripts/codex/config.autodev.toml"
TARGETS = ("codexcli", "claudecode", "copilot", "antigravity-cli")
HOOK_PATHS = {
    "codexcli": ".codex/hooks.json",
    "claudecode": ".claude/settings.json",
    "copilot": ".github/hooks/copilot-hooks.json",
    "antigravity-cli": ".agents/hooks.json",
}
SOURCE_COMMANDS = [
    "bash ~/.codex/hooks/ensure-codex-model-router.sh",
    "bash ~/.codex/hooks/ensure-codex-claude-bridge.sh",
    "bash ~/.codex/hooks/ensure-codex-minimax-proxy.sh",
    "bash ~/.codex/hooks/ensure-codex-antigravity-proxy.sh",
    "bash ~/.codex/hooks/enforce-root-delegation.sh",
    "node ~/.codex/hooks/codex/skill-read-telemetry.mjs",
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


class RulesyncHooksShadowTests(unittest.TestCase):
    """Hooks stay a shadow translation: live hooks remain AutoDev-owned, and the
    projections are generated from `.rulesync/hooks.jsonc` into temporary roots."""

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

    def test_generation_writes_one_hook_file_per_target_and_nothing_live(self):
        self.assertTrue(self.portable_config_unchanged)
        for target in TARGETS:
            with self.subTest(target=target):
                output_root = self.output[target]
                self.assertEqual(
                    sorted(path.relative_to(output_root).as_posix() for path in output_root.rglob("*") if path.is_file()),
                    [HOOK_PATHS[target]],
                )

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
        self.assertEqual(_commands(copilot), ["bash ~/.codex/hooks/enforce-root-delegation.sh"])
        antigravity = self._document("antigravity-cli")
        self.assertEqual(set(antigravity), {"rulesync"})
        self.assertEqual(set(antigravity["rulesync"]), {"PreToolUse"})
        self.assertEqual(
            _grouped_commands(antigravity["rulesync"]),
            ["node ~/.codex/hooks/codex/skill-read-telemetry.mjs"],
        )


if __name__ == "__main__":
    unittest.main()
