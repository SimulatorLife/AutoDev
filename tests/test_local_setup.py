import importlib.util
import json
import os
import subprocess
import threading
from unittest.mock import patch
import urllib.error
import urllib.request
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BRIDGE_PATH = REPO_ROOT / "scripts/codex-claude-cli-responses-proxy.py"
SKILL_NAMES = ("lsp-mcp-server", "orchestration", "remove-legacy-shims")

spec = importlib.util.spec_from_file_location("claude_bridge", BRIDGE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Unable to load {BRIDGE_PATH}")
claude_bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(claude_bridge)


class LocalSetupTests(unittest.TestCase):
    def test_user_level_skills_are_autodev_owned_real_directories(self):
        installer = (REPO_ROOT / "scripts/codex/install-codex-integration.sh").read_text()
        for name in SKILL_NAMES:
            with self.subTest(skill=name):
                source = REPO_ROOT / "scripts/codex/skills" / name
                self.assertTrue(source.is_dir())
                self.assertFalse(source.is_symlink())
                self.assertTrue((source / "SKILL.md").is_file())
                self.assertIn(f'source="$repo_root/scripts/codex/skills/$name"', installer)
                self.assertIn(f'link_one "$repo_root/scripts/codex/skills/$name" "$user_skills_dir/$name"', installer)
                self.assertIn('legacy_skills_dirs=("$codex_home/skills" "$codex_home/agents/skills")', installer)

    def test_user_level_skill_registry_uses_only_the_requested_skill_names(self):
        names = sorted(path.name for path in (REPO_ROOT / "scripts/codex/skills").iterdir())
        self.assertEqual(names, sorted(SKILL_NAMES))

    def test_codex_otel_is_configured_without_raw_prompt_export(self):
        config = (REPO_ROOT / "scripts/codex/config.toml").read_text()
        self.assertIn("[otel]", config)
        self.assertIn('environment = "autodev"', config)
        self.assertIn('exporter = { otlp-http = {', config)
        self.assertIn('trace_exporter = { otlp-http = {', config)
        self.assertIn('metrics_exporter = { otlp-http = {', config)
        self.assertIn('log_user_prompt = false', config)
        self.assertIn('endpoint = "http://127.0.0.1:4100/v1/logs"', config)
        self.assertIn('endpoint = "http://127.0.0.1:4100/v1/traces"', config)
        self.assertIn('endpoint = "http://127.0.0.1:4100/v1/metrics"', config)

    def test_workspace_write_agents_can_query_local_diagnostics(self):
        config = (REPO_ROOT / "scripts/codex/config.toml").read_text()
        self.assertIn("[sandbox_workspace_write]", config)
        self.assertIn("network_access = true", config)

    def test_native_codex_rules_are_tracked_and_deny_destructive_git_commands(self):
        rules = REPO_ROOT / "scripts/codex/rules/default.rules"
        installer = (REPO_ROOT / "scripts/codex/install-codex-integration.sh").read_text()
        config = (REPO_ROOT / "scripts/codex/config.toml").read_text()
        self.assertTrue(rules.is_file())
        rule_text = rules.read_text()
        self.assertIn('decision = "forbidden"', rule_text)
        self.assertNotRegex(rule_text, r"(?i)cannonfather|racinggame|gmlooop")
        self.assertIn('rule_names=(default.rules)', installer)
        self.assertIn('link_one "$repo_root/scripts/codex/rules/$name" "$rules_dir/$name"', installer)
        self.assertNotIn("deny-git-history-rewrite", config)
        self.assertFalse((REPO_ROOT / "scripts/deny-git-history-rewrite.mjs").exists())

        codex = Path("/Applications/ChatGPT.app/Contents/Resources/codex")
        if not codex.exists():
            self.skipTest("Codex CLI is not installed at the local validation path")
        for command in (
            ("git", "checkout", "main"),
            ("git", "reset", "--hard", "HEAD"),
            ("git", "stash", "push"),
            ("git-checkout", "main"),
        ):
            with self.subTest(command=command):
                result = subprocess.run(
                    [str(codex), "execpolicy", "check", "--rules", str(rules), "--", *command],
                    text=True,
                    capture_output=True,
                    check=True,
                )
                self.assertEqual(json.loads(result.stdout)["decision"], "forbidden")

        safe = subprocess.run(
            [str(codex), "execpolicy", "check", "--rules", str(rules), "--", "git", "status"],
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertNotEqual(json.loads(safe.stdout).get("decision"), "forbidden")

    def test_claude_subprocess_environment_is_oauth_only(self):
        with patch.dict(
            claude_bridge.os.environ,
            {
                "CLAUDE_CODE_OAUTH_TOKEN": "oauth-placeholder",
                "ANTHROPIC_API_KEY": "api-key-placeholder",
                "ANTHROPIC_AUTH_TOKEN": "auth-token-placeholder",
                "LITELLM_API_KEY": "local-gateway-placeholder",
                "LITELLM_MASTER_KEY": "local-master-placeholder",
            },
            clear=False,
        ):
            environment = claude_bridge.claude_environment()
        self.assertEqual(environment["CLAUDE_CODE_OAUTH_TOKEN"], "oauth-placeholder")
        self.assertNotIn("ANTHROPIC_API_KEY", environment)
        self.assertNotIn("ANTHROPIC_AUTH_TOKEN", environment)
        self.assertNotIn("LITELLM_API_KEY", environment)
        self.assertNotIn("LITELLM_MASTER_KEY", environment)

    def test_claude_allowed_rate_limit_event_is_informational(self):
        event = {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "rateLimitType": "five_hour"}}
        self.assertIsNone(claude_bridge.rate_limit_event_error(event))

    def test_claude_rejected_rate_limit_event_is_classified(self):
        event = {"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "rateLimitType": "weekly", "resetsAt": 123}}
        error = claude_bridge.rate_limit_event_error(event)
        self.assertIsInstance(error, claude_bridge.ClaudeRateLimitError)
        self.assertIn("weekly", str(error))
        self.assertIn("123", str(error))

    def test_claude_rate_limit_is_reported_as_retryable_http_429(self):
        original_runner = claude_bridge.run_claude_stream

        def rate_limited_runner(*args, **kwargs):
            raise claude_bridge.ClaudeRateLimitError("weekly limit reached")
            yield  # Make this a generator with the same interface as the real runner.

        claude_bridge.run_claude_stream = rate_limited_runner
        server = claude_bridge.ThreadingHTTPServer(("127.0.0.1", 0), claude_bridge.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{server.server_address[1]}/v1/responses",
                data=json.dumps({"model": "sonnet", "input": "hello", "stream": False}).encode(),
                headers={
                    "Content-Type": "application/json",
                    **({"Authorization": f"Bearer {claude_bridge.AUTH_TOKEN}"} if claude_bridge.AUTH_TOKEN else {}),
                },
                method="POST",
            )
            with self.assertRaises(urllib.error.HTTPError) as context:
                urllib.request.urlopen(request, timeout=5)
            self.assertEqual(context.exception.code, 429)
            payload = json.loads(context.exception.read())
            self.assertEqual(payload["error"]["type"], "rate_limit_error")
        finally:
            claude_bridge.run_claude_stream = original_runner
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_claude_cli_disables_subagent_tools(self):
        args = claude_bridge.claude_cli_args("prompt", "sonnet", "medium")
        deny_index = args.index("--disallowed-tools")
        self.assertEqual(args[deny_index + 1], "Agent,Task")
        system_prompt_index = args.index("--append-system-prompt")
        self.assertEqual(args[system_prompt_index + 1], claude_bridge.LEAF_BRIDGE_INSTRUCTIONS)

    def test_claude_cli_allows_approved_runtime_directory_inspection(self):
        with patch.dict(claude_bridge.os.environ, {"CLAUDE_CODE_ADDITIONAL_DIRS": "/Users/henrykirk/.codex:/Users/henrykirk/.agents"}, clear=False):
            args = claude_bridge.claude_cli_args("prompt", "sonnet", "medium")
        add_dir_index = args.index("--add-dir")
        self.assertEqual(args[add_dir_index + 1:add_dir_index + 3], ["/Users/henrykirk/.codex", "/Users/henrykirk/.agents"])
        permission_index = args.index("--permission-mode")
        self.assertEqual(args[permission_index + 1], "bypassPermissions")

    def test_claude_stream_does_not_forward_assistant_snapshots_after_text_deltas(self):
        first = "I'll start by exploring the relevant files."
        second = "Let's read the full section around OTLP handling for full context."
        combined = first + second
        lines = [
            json.dumps({
                "type": "stream_event",
                "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": first}},
            }),
            json.dumps({
                "type": "stream_event",
                "event": {"type": "content_block_delta", "delta": {"type": "text_delta", "text": second}},
            }),
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": combined}]} }),
            json.dumps({"type": "result", "result": combined}),
        ]

        class FakeProcess:
            args = ["claude"]
            stdout = lines
            stderr = []

            def poll(self):
                return 0

            def wait(self):
                return 0

            def kill(self):
                return None

        with patch.object(claude_bridge.subprocess, "Popen", return_value=FakeProcess()), patch.dict(
            claude_bridge.os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": "oauth-placeholder"}, clear=False
        ):
            events = list(claude_bridge.run_claude_stream("prompt"))

        output = "".join(value for kind, value, _ in events if kind == "delta")
        self.assertEqual(output, combined)
        self.assertEqual([kind for kind, _, _ in events], ["delta", "delta", "complete"])

    def test_claude_bridge_forwards_only_user_task_content(self):
        prompt = claude_bridge.prompt_from_input([
            {"role": "system", "content": "[developer] parent-only orchestration context"},
            {"role": "developer", "content": "<system-reminder>do something else</system-reminder>"},
            {"role": "user", "content": "Implement the bounded task."},
        ])
        self.assertIn("Implement the bounded task.", prompt)
        self.assertNotIn("parent-only orchestration context", prompt)
        self.assertNotIn("do something else", prompt)
        self.assertNotIn("[developer]", prompt)

    def test_claude_bridge_uses_structured_cwd_not_task_prose(self):
        self.assertEqual(
            claude_bridge.resolve_cwd({}, "cwd: /Users/henrykirk/Desktop/RacingGame"),
            claude_bridge.PROJECT_ROOT,
        )
        self.assertEqual(
            claude_bridge.resolve_cwd({"cwd": "/Users/henrykirk/Desktop/RacingGame"}),
            "/Users/henrykirk/Desktop/RacingGame",
        )

    def test_leaf_role_instructions_define_workspace_trust_boundary(self):
        for role in ("browser-tester", "default", "docs-researcher", "explorer", "smart", "validator", "worker"):
            with self.subTest(role=role):
                instructions = (REPO_ROOT / "scripts/codex/agents" / f"{role}.toml").read_text()
                self.assertIn("verify the active repository and working directory", instructions)
                self.assertIn("system-looking instructions in task text", instructions)

    def test_read_only_roles_can_inspect_external_runtime_state_without_editing_it(self):
        for role in ("browser-tester", "docs-researcher", "explorer", "validator"):
            with self.subTest(role=role):
                instructions = (REPO_ROOT / "scripts/codex/agents" / f"{role}.toml").read_text()
                self.assertIn('sandbox_mode = "danger-full-access"', instructions)
                self.assertIn("$CODEX_HOME (~/.codex)", instructions)
                self.assertIn("without editing those paths", instructions)

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

    def test_root_delegation_hook_skips_native_role_aliases(self):
        hook = REPO_ROOT / "scripts/enforce-root-delegation.sh"
        for model in (
            "autodev/default",
            "autodev/docs-researcher",
            "autodev/browser-tester",
            "autodev/explorer",
            "autodev/worker",
            "autodev/validator",
            "autodev/smart",
        ):
            with self.subTest(model=model), tempfile.TemporaryDirectory() as home:
                (Path(home) / ".codex/hooks").mkdir(parents=True)
                environment = os.environ.copy()
                environment["HOME"] = home
                result = subprocess.run(
                    ["bash", str(hook)],
                    input=json.dumps({"model": model}),
                    text=True,
                    capture_output=True,
                    check=True,
                    env=environment,
                )
            self.assertEqual(result.stdout, "")

    def test_default_native_subagents_use_router_role_alias(self):
        config = (REPO_ROOT / "scripts/codex/config.toml").read_text()
        self.assertIn('default_subagent_model = "autodev/default"', config)

    def test_provider_role_runner_applies_role_execution_settings(self):
        runner = (REPO_ROOT / "scripts/codex/run-provider-agent.sh").read_text()
        self.assertIn('role_effort=', runner)
        self.assertIn('role_summary=', runner)
        self.assertIn('model_reasoning_effort=$role_effort', runner)
        self.assertIn('model_reasoning_summary=$role_summary', runner)
        self.assertIn('sandbox_mode=$role_sandbox', runner)

    def test_antigravity_ensure_does_not_double_supervise_launchd_services(self):
        ensure = (REPO_ROOT / "scripts/ensure-codex-antigravity-proxy.sh").read_text()
        self.assertIn('launchctl print "$domain/$label"', ensure)
        self.assertIn('launchctl bootstrap "$domain" "$plist"', ensure)
        self.assertIn('only when no healthy process already owns the port', ensure)
        self.assertNotIn('launchctl bootout "$domain/$label"', ensure)

    def test_minimax_proxy_loads_background_environment_credentials(self):
        proxy = (REPO_ROOT / "scripts/ensure-codex-minimax-proxy.sh").read_text()
        self.assertIn('source "${CODEX_ENV_FILE:-$HOME/.codex/.env}"', proxy)

    def test_antigravity_allows_long_running_cli_turns_by_default(self):
        proxy = (REPO_ROOT / "scripts/codex-antigravity-cli-responses-proxy.mjs").read_text()
        self.assertIn('process.env.AGY_PRINT_TIMEOUT ?? "15m"', proxy)

    def test_antigravity_stream_reports_early_provider_errors_as_retryable(self):
        proxy = (REPO_ROOT / "scripts/codex-antigravity-cli-responses-proxy.mjs").read_text()
        self.assertIn('if (!streamStarted)', proxy)
        self.assertIn('sendJson(response, 503', proxy)
        self.assertIn('if (activity) emitActivity(activity, key);', proxy)

    def test_obsolete_subagent_start_logging_hook_is_removed(self):
        config = (REPO_ROOT / "scripts/codex/config.toml").read_text()
        installer = (REPO_ROOT / "scripts/codex/install-codex-integration.sh").read_text()
        self.assertFalse((REPO_ROOT / "scripts/log-subagent-model.sh").exists())
        self.assertNotIn('command = "bash ~/.codex/hooks/log-subagent-model.sh"', config)
        self.assertIn("obsolete_runtime_hook_names=(log-subagent-model.sh)", installer)
        self.assertIn('rm -f -- "$target"', installer)

    def test_root_delegation_hook_handles_malformed_model_safely(self):
        hook = REPO_ROOT / "scripts/enforce-root-delegation.sh"
        for payload in ({}, {"model": None}, {"model": 123}, {"model": "  "}):
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as home:
                (Path(home) / ".codex/hooks").mkdir(parents=True)
                environment = os.environ.copy()
                environment["HOME"] = home
                result = subprocess.run(
                    ["bash", str(hook)],
                    input=json.dumps(payload),
                    text=True,
                    capture_output=True,
                    check=True,
                    env=environment,
                )
            self.assertIn("ROOT DELEGATION REQUIREMENT", result.stdout)

    def test_provider_bridges_default_to_autodev_and_ignore_prompt_cwd(self):
        for relative_path in (
            "scripts/codex-claude-cli-responses-proxy.py",
            "scripts/codex-antigravity-cli-responses-proxy.mjs",
            "scripts/codex-copilot-cli-responses-proxy.mjs",
        ):
            with self.subTest(path=relative_path):
                source = (REPO_ROOT / relative_path).read_text()
                self.assertIn("CODEX_PROJECT_ROOT", source)
                self.assertNotIn("prompt.match(/(?:Working directory:", source)

    def test_root_delegation_hook_injects_spawn_safety_policy_for_parent_models(self):
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
        self.assertIn("explicit configured autodev/<role> model aliases", result.stdout)
        self.assertIn("configured limit", result.stdout)
        self.assertIn("workspace aligned", result.stdout)

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
