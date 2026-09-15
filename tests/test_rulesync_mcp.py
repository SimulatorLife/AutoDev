import json
import os
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / ".rulesync"
MCP_SOURCE = SOURCE_ROOT / "mcp.jsonc"
RULESYNC = REPO_ROOT / "node_modules/.bin/rulesync"
PORTABLE_CONFIG = REPO_ROOT / "scripts/codex/config.autodev.toml"
PACKAGE_JSON = REPO_ROOT / "package.json"
LAUNCHER = 'exec "${CODEX_HOME:-$HOME/.codex}/hooks/run-autodev-mcp.sh" '
# The user-level MCP file Rulesync's `--global` generation writes for each CLI
# the installer finds. Codex is generated in project mode instead: Rulesync
# ignores CODEX_HOME, so the installer merges that projection into
# $CODEX_HOME/config.toml.
USER_LEVEL_FILES = {
    "claudecode": ".claude.json",
    "copilotcli": ".copilot/mcp-config.json",
    "antigravity-cli": ".gemini/config/mcp_config.json",
}
# Antigravity's format names a remote server's address `serverUrl`.
URL_KEYS = {"antigravity-cli": "serverUrl"}
# Codex's own in-process tools are never declared as AutoDev MCP servers.
FORBIDDEN_SERVERS = {"node_repl", "cua_repl"}


def _source() -> dict:
    return json.loads(MCP_SOURCE.read_text())


def _declared(target: str) -> dict:
    """The servers `.rulesync/mcp.jsonc` declares for a target: the shared set,
    with that target's section replacing entries whole, adding servers, or
    removing them with null."""
    source = _source()
    servers = dict(source["mcpServers"])
    for name, override in source.get(target, {}).get("mcpServers", {}).items():
        if override is None:
            servers.pop(name, None)
        else:
            servers[name] = override
    return servers


def _rulesync(*args: str, home: Path | None = None) -> subprocess.CompletedProcess:
    environment = {**os.environ, "HOME": str(home)} if home else None
    return subprocess.run(
        [str(RULESYNC), "generate", "--input-roots", str(SOURCE_ROOT), "--features", "mcp", *args, "--silent"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
        env=environment,
    )


def _generate_user_level(home: Path, *extra: str) -> subprocess.CompletedProcess:
    return _rulesync("--global", "--targets", ",".join(USER_LEVEL_FILES), *extra, home=home)


class RulesyncMcpTests(unittest.TestCase):
    """`.rulesync/mcp.jsonc` is the only MCP source. These tests generate every
    projection the installer uses into temporary roots and check it against that
    source."""

    @classmethod
    def setUpClass(cls):
        cls._temp = tempfile.TemporaryDirectory()
        root = Path(cls._temp.name).resolve()
        cls.codex_root = root / "codex"
        cls.home = root / "home"
        cls.home.mkdir()
        (cls.home / ".claude.json").write_text(
            json.dumps({"numStartups": 3, "mcpServers": {"stale": {"command": "stale"}}})
        )
        cls.portable_before = PORTABLE_CONFIG.read_bytes()
        for result in (
            _rulesync("--targets", "codexcli", "--output-roots", str(cls.codex_root)),
            _generate_user_level(cls.home),
        ):
            if result.returncode != 0:
                raise AssertionError(f"Rulesync MCP generation failed:\n{result.stdout}\n{result.stderr}")

    @classmethod
    def tearDownClass(cls):
        cls._temp.cleanup()

    def test_rulesync_is_pinned_to_an_exact_version(self):
        version = json.loads(PACKAGE_JSON.read_text())["devDependencies"]["rulesync"]
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")

    def test_portable_codex_config_declares_no_mcp_servers(self):
        self.assertNotIn("mcp_servers", tomllib.loads(PORTABLE_CONFIG.read_text()))

    def test_source_declares_each_launch_definition_consistently(self):
        source = _source()
        shared = source["mcpServers"]
        self.assertEqual(set(source), {"$schema", "mcpServers", "codexcli", "copilotcli", "antigravity-cli"})
        self.assertEqual(set(shared), {"lsp", "cocoindex-code", "openaiDeveloperDocs"})
        for target in ("codexcli", "claudecode", "copilotcli", "antigravity-cli"):
            declared = _declared(target)
            with self.subTest(target=target):
                self.assertFalse(FORBIDDEN_SERVERS & set(declared))
                # agy has only a global registry, so the delegation shim is
                # declared there; the Claude bridge builds it per turn.
                self.assertEqual("autodev_spawn" in declared, target == "antigravity-cli")
            for name, server in declared.items():
                with self.subTest(target=target, server=name):
                    if name == "autodev_spawn":
                        self.assertEqual(server["command"], "bash")
                        self.assertTrue(server["args"][1].endswith('/hooks/codex/lib/spawn-shim-mcp.mjs"'))
                    elif "command" in server:
                        self.assertEqual(server["command"], "bash")
                        self.assertEqual(server["args"], ["-lc", LAUNCHER + name])
                    # A target section replaces a shared entry whole, so a Codex
                    # entry that adds settings repeats the launch keys: keep equal.
                    if name in shared:
                        for key in ("command", "args", "url"):
                            self.assertEqual(server.get(key), shared[name].get(key))

    def test_codex_projection_matches_the_codex_declaration(self):
        self.assertEqual(
            sorted(path.relative_to(self.codex_root).as_posix() for path in self.codex_root.rglob("*") if path.is_file()),
            [".codex/config.toml"],
        )
        generated = tomllib.loads((self.codex_root / ".codex/config.toml").read_text())["mcp_servers"]
        declared = _declared("codexcli")
        self.assertEqual(set(generated), set(declared))
        for name, server in declared.items():
            with self.subTest(server=name):
                expected = {
                    key: server[key]
                    for key in ("command", "args", "url", "default_tools_approval_mode")
                    if key in server
                }
                if server.get("disabled"):
                    expected["enabled"] = False
                self.assertEqual(generated[name], expected)
        self.assertEqual(PORTABLE_CONFIG.read_bytes(), self.portable_before)

    def test_user_level_files_list_exactly_each_tools_declared_servers(self):
        for target, relative in USER_LEVEL_FILES.items():
            servers = json.loads((self.home / relative).read_text())["mcpServers"]
            declared = _declared(target)
            url_key = URL_KEYS.get(target, "url")
            with self.subTest(target=target):
                self.assertEqual(set(servers), set(declared))
            for name, server in declared.items():
                with self.subTest(target=target, server=name):
                    projected = servers[name]
                    self.assertEqual(projected.get("command"), server.get("command"))
                    self.assertEqual(projected.get("args"), server.get("args"))
                    self.assertEqual(projected.get(url_key), server.get("url"))
                    self.assertNotIn("default_tools_approval_mode", projected)
        claude = json.loads((self.home / ".claude.json").read_text())
        self.assertEqual(claude["numStartups"], 3, "Rulesync keeps every non-MCP key")
        self.assertNotIn("stale", claude["mcpServers"], "Rulesync owns the server list")

    def test_check_catches_edited_and_extra_user_level_servers(self):
        self.assertEqual(_generate_user_level(self.home, "--check").returncode, 0)

        def edit_antigravity(home: Path) -> None:
            path = home / USER_LEVEL_FILES["antigravity-cli"]
            document = json.loads(path.read_text())
            document["mcpServers"]["lsp"]["args"] = ["-lc", "drifted"]
            path.write_text(json.dumps(document))

        def add_copilot_server(home: Path) -> None:
            path = home / USER_LEVEL_FILES["copilotcli"]
            document = json.loads(path.read_text())
            document["mcpServers"]["mine"] = {"type": "stdio", "command": "mine"}
            path.write_text(json.dumps(document))

        with tempfile.TemporaryDirectory() as temp:
            for label, damage in (("edited", edit_antigravity), ("extra", add_copilot_server)):
                with self.subTest(damage=label):
                    home = Path(temp).resolve() / label
                    home.mkdir()
                    self.assertEqual(_generate_user_level(home).returncode, 0)
                    damage(home)
                    self.assertNotEqual(_generate_user_level(home, "--check").returncode, 0)


if __name__ == "__main__":
    unittest.main()
