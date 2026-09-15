"""Phase 4 Claude OAuth pilot: policy-gate guard.

Anthropic permits Claude Free/Pro/Max OAuth authentication only for ordinary use
of Claude Code and other native Anthropic applications; developers may not route
requests through subscription credentials or intermediate Claude.ai credentials
(https://code.claude.com/docs/en/legal-and-compliance, "Authentication and
credential use"). The OAuth-native Codex model-provider candidate therefore fails
the provider migration gate's policy requirement, and the incumbent path -- the
unmodified Claude Code binary signed in with the user's own subscription -- stays
authoritative. See docs/AUTODEV_PLATFORM_MIGRATION.md, Phase 4 "Claude OAuth pilot".

These checks keep that result from regressing silently: any new consumer of the
subscription token, or any model route that talks to Anthropic directly, must be
reviewed against the gate before this test is changed.
"""
from __future__ import annotations

import importlib.util
import json
import re
import subprocess
import tomllib
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TOKEN = "CLAUDE_CODE_OAUTH_TOKEN"

# Every tracked runtime/CI file allowed to reference the subscription token, and
# why. Documentation and tests are excluded from the scan.
REVIEWED_TOKEN_CONSUMERS = {
    # Incumbent bridge: requires the token and hands it only to the Claude Code CLI.
    "scripts/codex-claude-cli-responses-proxy.py",
    # Bridge launch/ensure lifecycle: reads the token from the user's Keychain.
    "scripts/run-codex-claude-bridge.sh",
    "scripts/ensure-codex-claude-bridge.sh",
    # CI: passes the repository secret to the pinned official Claude Code package.
    ".github/workflows/claude-invoke.yml",
    "scripts/codex/run-ci-provider.sh",
    # CI log redaction pattern only.
    ".github/workflows/agent-invoke.yml",
}


def tracked_files() -> list[str]:
    result = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, check=True, capture_output=True, text=True)
    return result.stdout.splitlines()


class ClaudeOAuthPolicyGateTests(unittest.TestCase):
    def test_only_reviewed_runtime_files_reference_the_subscription_token(self):
        consumers = set()
        for relative in tracked_files():
            if relative.startswith(("docs/", "tests/")) or relative.endswith(".md"):
                continue
            path = REPO_ROOT / relative
            if not path.is_file():
                continue
            try:
                if TOKEN in path.read_text(encoding="utf-8"):
                    consumers.add(relative)
            except UnicodeDecodeError:
                continue
        self.assertEqual(consumers, REVIEWED_TOKEN_CONSUMERS)

    def test_bridge_hands_the_token_only_to_the_claude_code_binary(self):
        spec = importlib.util.spec_from_file_location("claude_bridge_policy", REPO_ROOT / "scripts/codex-claude-cli-responses-proxy.py")
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        self.assertEqual(Path(bridge.CLI).name, "claude")
        source = (REPO_ROOT / "scripts/codex-claude-cli-responses-proxy.py").read_text(encoding="utf-8")
        self.assertNotIn("anthropic.com", source)

    def test_ci_runs_the_pinned_official_claude_code_package(self):
        manifest = json.loads((REPO_ROOT / ".github/ci/provider-tools.json").read_text(encoding="utf-8"))
        self.assertRegex(manifest["tools"]["claude"]["package"], r"^@anthropic-ai/claude-code@\d+\.\d+\.\d+$")
        runner = (REPO_ROOT / "scripts/codex/run-ci-provider.sh").read_text(encoding="utf-8")
        claude_branch = runner.split("  claude)", 1)[1].split(";;", 1)[0]
        self.assertIn('pnpm --silent dlx "$AUTODEV_CLAUDE_PACKAGE"', claude_branch)

    def test_no_codex_model_provider_or_router_route_talks_to_anthropic_directly(self):
        config = tomllib.loads((REPO_ROOT / "scripts/codex/config.autodev.toml").read_text(encoding="utf-8"))
        for name, provider in config.get("model_providers", {}).items():
            with self.subTest(provider=name):
                self.assertRegex(provider.get("base_url", ""), r"^http://127\.0\.0\.1:\d+/v1$")
        router = (REPO_ROOT / "scripts/codex-model-router.mjs").read_text(encoding="utf-8")
        claude_route = re.search(r'\{ provider: "claude",[^\n]*\}', router)
        self.assertIsNotNone(claude_route)
        self.assertIn('baseUrl: "http://127.0.0.1:4000/v1"', claude_route.group(0))
        self.assertNotIn("anthropic.com", router)


if __name__ == "__main__":
    unittest.main()
