import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "scripts/codex-claude-cli-responses-proxy.py"

spec = importlib.util.spec_from_file_location("claude_bridge", BRIDGE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Unable to load {BRIDGE_PATH}")
claude_bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(claude_bridge)


class LocalSetupTests(unittest.TestCase):
    def test_claude_cli_disables_subagent_tools(self):
        args = claude_bridge.claude_cli_args("prompt", "sonnet", "medium")
        deny_index = args.index("--disallowed-tools")
        self.assertEqual(args[deny_index + 1], "Agent,Task")

    def test_root_delegation_hook_skips_claude_leaf_models(self):
        hook = REPO_ROOT / "scripts/enforce-root-delegation.sh"
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / ".codex/hooks").mkdir(parents=True)
            environment = os.environ.copy()
            environment["HOME"] = home
            result = subprocess.run(
                ["bash", str(hook)],
                input=json.dumps({"model": "sonnet"}),
                text=True,
                capture_output=True,
                check=True,
                env=environment,
            )
        self.assertEqual(result.stdout, "")

    def test_root_delegation_hook_injects_for_parent_models(self):
        hook = REPO_ROOT / "scripts/enforce-root-delegation.sh"
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / ".codex/hooks").mkdir(parents=True)
            environment = os.environ.copy()
            environment["HOME"] = home
            result = subprocess.run(
                ["bash", str(hook)],
                input=json.dumps({"model": "gpt-5.6-luna"}),
                text=True,
                capture_output=True,
                check=True,
                env=environment,
            )
        self.assertIn("ROOT DELEGATION REQUIREMENT", result.stdout)


if __name__ == "__main__":
    unittest.main()
