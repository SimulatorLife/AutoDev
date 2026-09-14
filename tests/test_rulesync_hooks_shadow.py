import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync"
HOOK_SOURCE = SOURCE_ROOT / "hooks.jsonc"
SHADOW_ROOT = REPO_ROOT / "tests/fixtures/rulesync-shadow"
RULESYNC_CONFIG = REPO_ROOT / "rulesync.jsonc"
WORKFLOW = REPO_ROOT / ".github/workflows/rulesync-mcp-shadow-drift.yml"
PORTABLE_CONFIG = REPO_ROOT / "scripts/codex/config.autodev.toml"
TARGETS = ("codexcli", "claudecode", "copilot", "antigravity-cli")
HOOK_PATHS = {
    "codexcli": ".codex/hooks.json",
    "claudecode": ".claude/settings.json",
    "copilot": ".github/hooks/copilot-hooks.json",
    "antigravity-cli": ".agents/hooks.json",
}


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


class RulesyncHooksShadowTests(unittest.TestCase):
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
        commands = _commands(source)
        self.assertEqual(len(commands), 6)
        self.assertNotIn("prevent_idle_sleep", HOOK_SOURCE.read_text())
        self.assertEqual(
            commands,
            [
                "bash ~/.codex/hooks/ensure-codex-model-router.sh",
                "bash ~/.codex/hooks/ensure-codex-claude-bridge.sh",
                "bash ~/.codex/hooks/ensure-codex-minimax-proxy.sh",
                "bash ~/.codex/hooks/ensure-codex-antigravity-proxy.sh",
                "bash ~/.codex/hooks/enforce-root-delegation.sh",
                "node ~/.codex/hooks/codex/skill-read-telemetry.mjs",
            ],
        )

    def test_config_and_workflow_enable_hooks_without_global_generation(self):
        config = json.loads(RULESYNC_CONFIG.read_text())
        self.assertIn("hooks", config["features"])
        self.assertFalse(config["global"])
        workflow = WORKFLOW.read_text()
        match = re.search(r"--features\s+(\S+)", workflow)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), "mcp,rules,skills,hooks")

    def test_generation_isolated_and_tracked_fixtures_match(self):
        before = PORTABLE_CONFIG.read_bytes()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for target in TARGETS:
                with self.subTest(target=target):
                    _generate(target, root / target)
                    generated = root / target / HOOK_PATHS[target]
                    tracked = SHADOW_ROOT / HOOK_PATHS[target]
                    self.assertTrue(generated.is_file(), msg=f"missing generated hook file: {generated}")
                    self.assertTrue(tracked.is_file(), msg=f"missing tracked hook fixture: {tracked}")
                    self.assertEqual(generated.read_bytes(), tracked.read_bytes())
        self.assertEqual(PORTABLE_CONFIG.read_bytes(), before)

    def test_target_specific_parity_limits_are_frozen(self):
        codex = json.loads((SHADOW_ROOT / HOOK_PATHS["codexcli"]).read_text())
        claude = json.loads((SHADOW_ROOT / HOOK_PATHS["claudecode"]).read_text())
        copilot = json.loads((SHADOW_ROOT / HOOK_PATHS["copilot"]).read_text())
        antigravity = json.loads((SHADOW_ROOT / HOOK_PATHS["antigravity-cli"]).read_text())

        for document in (codex, claude):
            self.assertEqual(
                set(document["hooks"]),
                {"SessionStart", "SubagentStart", "UserPromptSubmit", "PreToolUse"},
            )
        self.assertEqual(set(copilot["hooks"]), {"userPromptSubmitted"})
        self.assertEqual(set(antigravity["rulesync"]), {"PreToolUse"})
        self.assertIn("bash ~/.codex/hooks/enforce-root-delegation.sh", json.dumps(copilot))
        self.assertIn("node ~/.codex/hooks/codex/skill-read-telemetry.mjs", json.dumps(antigravity))


if __name__ == "__main__":
    unittest.main()
