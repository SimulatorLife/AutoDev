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

    def test_provider_role_runner_applies_role_execution_settings(self):
        runner = (REPO_ROOT / "scripts/codex/run-provider-agent.sh").read_text()
        self.assertIn('role_effort=', runner)
        self.assertIn('role_summary=', runner)
        self.assertIn('model_reasoning_effort=$role_effort', runner)
        self.assertIn('model_reasoning_summary=$role_summary', runner)
        self.assertIn('sandbox_mode=$role_sandbox', runner)

    def test_antigravity_stream_reports_early_provider_errors_as_retryable(self):
        proxy = (REPO_ROOT / "scripts/codex-antigravity-cli-responses-proxy.mjs").read_text()
        self.assertIn('if (!streamStarted)', proxy)
        self.assertIn('sendJson(response, 503', proxy)
        self.assertIn('if (activity) emitActivity(activity, key);', proxy)

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
