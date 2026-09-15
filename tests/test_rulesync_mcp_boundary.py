import json
import subprocess
import tempfile
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = REPO_ROOT / "tests/fixtures/contracts/rulesync-mcp-boundary.json"
SOURCE_ROOT = REPO_ROOT / ".rulesync"
EXPECTED_TARGETS = ("codexcli", "claudecode", "copilot", "antigravity-cli")


class RulesyncMcpBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture_bytes = FIXTURE_PATH.read_bytes()
        cls.contract = json.loads(cls.fixture_bytes)

    def test_contract_identity_and_target_set_are_frozen(self):
        self.assertEqual(self.contract["schema"], "autodev-rulesync-mcp-boundary-v1")
        self.assertEqual(self.contract["rulesyncVersion"], "16.30.2")
        self.assertEqual(tuple(self.contract["targets"]), EXPECTED_TARGETS)
        self.assertEqual(
            self.contract["forbiddenServers"],
            ["node_repl", "cua_repl", "autodev_spawn"],
        )

    def _generate(self, target: str, output_root: Path) -> None:
        result = subprocess.run(
            [
                "pnpm",
                "exec",
                "rulesync",
                "generate",
                "--input-roots",
                str(SOURCE_ROOT),
                "--targets",
                target,
                "--features",
                "mcp",
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
            msg=f"Rulesync {target} generation failed:\nSTDOUT={result.stdout}\nSTDERR={result.stderr}",
        )

    @staticmethod
    def _read_servers(target: str, output_root: Path, file: str, key: str) -> dict:
        path = output_root / file
        if target == "codexcli":
            document = tomllib.loads(path.read_text())
        else:
            document = json.loads(path.read_text())
        return document[key]

    def test_fixture_freezes_pinned_target_projections_in_temporary_roots(self):
        targets = self.contract["targets"]
        forbidden = set(self.contract["forbiddenServers"])

        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for target, projection in targets.items():
                with self.subTest(target=target):
                    output_root = root / target
                    self._generate(target, output_root)
                    self.assertEqual(
                        sorted(path.relative_to(output_root).as_posix() for path in output_root.rglob("*") if path.is_file()),
                        [projection["file"]],
                    )
                    servers = self._read_servers(
                        target, output_root, projection["file"], projection["serversKey"]
                    )
                    self.assertEqual(servers, projection["servers"])
                    self.assertTrue(forbidden.isdisjoint(servers))

        self.assertEqual(FIXTURE_PATH.read_bytes(), self.fixture_bytes)

    def test_live_config_owns_only_the_three_shared_mcp_servers(self):
        ownership = self.contract["liveOwnership"]
        live_path = REPO_ROOT / ownership["file"]
        before = live_path.read_bytes()
        live = tomllib.loads(before.decode())

        self.assertEqual(live["mcp_servers"], ownership["servers"])
        self.assertEqual(set(live["mcp_servers"]), {"lsp", "cocoindex-code", "playwright"})
        self.assertEqual(live_path.read_bytes(), before)
        self.assertEqual(FIXTURE_PATH.read_bytes(), self.fixture_bytes)


if __name__ == "__main__":
    unittest.main()
