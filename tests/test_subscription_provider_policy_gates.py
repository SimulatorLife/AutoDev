"""Phase 4 policy-gate guards for the subscription-backed providers.

Subscription/OAuth-based usage and billing is a hard requirement for Claude,
GitHub Copilot, and Antigravity (docs/AUTODEV_PLATFORM_MIGRATION.md,
Requirements). Each provider's OAuth-native pilot was evaluated against its
vendor's terms (Phase 4), and in every case the only permitted
subscription-billed path is the vendor's own client:

- Claude: Anthropic permits Free/Pro/Max OAuth only for Claude Code and native
  Anthropic apps; developers may not route requests through subscription
  credentials (https://code.claude.com/docs/en/legal-and-compliance).
- GitHub Copilot: the LiteLLM route impersonates a Copilot editor OAuth client
  against the undocumented `copilot_internal` token endpoint. GitHub's supported
  subscription-billed programmatic interfaces (Copilot SDK, `copilot --acp`)
  run the Copilot CLI.
- Antigravity: "Using third party software, tools, or services to access the
  Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this
  Agreement" (https://antigravity.google/terms). Google's non-CLI programmatic
  paths (Antigravity SDK, Gemini API Antigravity agent) are API-key billed.

These checks keep those results from regressing silently: a new consumer of a
subscription credential, an unsupported internal transport, or a model route
that bypasses the vendor client must be reviewed against the gate before this
test is changed.
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
CLAUDE_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN"

# Every tracked runtime/CI file allowed to reference the Claude subscription
# token, and why. Documentation and tests are excluded from the scan.
REVIEWED_CLAUDE_TOKEN_CONSUMERS = {
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

# Transports that reach a subscription backend without the vendor's own client.
UNSUPPORTED_SUBSCRIPTION_TRANSPORTS = {
    # LiteLLM's GitHub Copilot route: undocumented token exchange, editor OAuth
    # client id, Copilot model host, and LiteLLM's provider prefix.
    "copilot_internal": "undocumented GitHub Copilot token endpoint",
    "Iv1.b507a08c87ecfe98": "Copilot editor OAuth client id reused by LiteLLM",
    "api.githubcopilot.com": "Copilot model endpoint reached without the Copilot CLI",
    "github_copilot/": "LiteLLM GitHub Copilot provider route",
    # Gemini Code Assist backend used by the Gemini/Antigravity CLI OAuth flow.
    "cloudcode-pa.googleapis.com": "Antigravity/Gemini CLI OAuth backend reached without agy",
}


def tracked_runtime_texts() -> dict[str, str]:
    listed = subprocess.run(["git", "ls-files"], cwd=REPO_ROOT, check=True, capture_output=True, text=True)
    texts = {}
    for relative in listed.stdout.splitlines():
        if relative.startswith(("docs/", "tests/")) or relative.endswith(".md"):
            continue
        path = REPO_ROOT / relative
        if not path.is_file():
            continue
        try:
            texts[relative] = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
    return texts


class SubscriptionProviderPolicyGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.texts = tracked_runtime_texts()
        cls.router = (REPO_ROOT / "scripts/codex-model-router.mjs").read_text(encoding="utf-8")
        cls.routing = (REPO_ROOT / "src/router/routing.ts").read_text(encoding="utf-8")

    def route(self, provider: str) -> str:
        match = re.search(rf"\{{ provider: ['\"]{provider}['\"],[^\n]*\}}", self.routing)
        self.assertIsNotNone(match, f"router route for {provider}")
        return match.group(0)

    def test_no_runtime_file_uses_an_unsupported_subscription_transport(self):
        for needle, reason in UNSUPPORTED_SUBSCRIPTION_TRANSPORTS.items():
            with self.subTest(transport=reason):
                self.assertEqual(sorted(path for path, text in self.texts.items() if needle in text), [])

    def test_every_codex_model_provider_targets_a_local_adapter(self):
        config = tomllib.loads((REPO_ROOT / "scripts/codex/config.autodev.toml").read_text(encoding="utf-8"))
        for name, provider in config.get("model_providers", {}).items():
            with self.subTest(provider=name):
                self.assertRegex(provider.get("base_url", ""), r"^http://127\.0\.0\.1:\d+/v1$")

    def test_only_reviewed_runtime_files_reference_the_claude_subscription_token(self):
        consumers = {path for path, text in self.texts.items() if CLAUDE_TOKEN in text}
        self.assertEqual(consumers, REVIEWED_CLAUDE_TOKEN_CONSUMERS)

    def test_claude_bridge_hands_the_token_only_to_the_claude_code_binary(self):
        spec = importlib.util.spec_from_file_location("claude_bridge_policy", REPO_ROOT / "scripts/codex-claude-cli-responses-proxy.py")
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        self.assertEqual(Path(bridge.CLI).name, "claude")
        self.assertNotIn("anthropic.com", self.texts["scripts/codex-claude-cli-responses-proxy.py"])
        self.assertIn("baseUrl: 'http://127.0.0.1:4000/v1'", self.route("claude"))
        self.assertNotIn("anthropic.com", self.router)

    def test_ci_runs_the_pinned_official_claude_code_package(self):
        manifest = json.loads((REPO_ROOT / ".github/ci/provider-tools.json").read_text(encoding="utf-8"))
        self.assertRegex(manifest["tools"]["claude"]["package"], r"^@anthropic-ai/claude-code@\d+\.\d+\.\d+$")
        claude_branch = self.texts["scripts/codex/run-ci-provider.sh"].split("  claude)", 1)[1].split(";;", 1)[0]
        self.assertIn('pnpm --silent dlx "$AUTODEV_CLAUDE_PACKAGE"', claude_branch)

    def test_copilot_proxy_runs_the_official_copilot_cli(self):
        source = self.texts["scripts/codex-copilot-cli-responses-proxy.mjs"]
        self.assertIn('spawn(process.env.COPILOT_BIN ?? "copilot", args', source)
        self.assertIn("baseUrl: 'http://127.0.0.1:4003/v1'", self.route("copilot"))

    def test_antigravity_proxy_runs_the_official_agy_cli(self):
        source = self.texts["scripts/codex-antigravity-cli-responses-proxy.mjs"]
        self.assertIn("const CLI = process.env.AGY_CLI_PATH ?? `${process.env.HOME ?? process.cwd()}/.local/bin/agy`;", source)
        self.assertIn("spawn(CLI, agyArgs(", source)
        self.assertIn("baseUrl: 'http://127.0.0.1:4002/v1'", self.route("antigravity"))


if __name__ == "__main__":
    unittest.main()
