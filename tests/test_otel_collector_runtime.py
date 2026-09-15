"""Hermetic contract tests for the Phase 3 Collector runtime scripts."""
from __future__ import annotations

import os
import plistlib
import socket
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / "scripts/codex/otel/run-autodev-otel-collector.sh"
ENSURE = ROOT / "scripts/codex/otel/ensure-autodev-otel-collector.sh"
PLIST = ROOT / "scripts/codex/launchagents/com.codex.otel-collector.plist"


class CollectorRuntimeTests(unittest.TestCase):
    @staticmethod
    def free_port() -> int:
        # Never probe the live 4318 ingress: an enabled local Collector would
        # make the runner's duplicate-listener guard fire inside a hermetic test.
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def env(self, td: str, **extra: str) -> dict[str, str]:
        env = os.environ.copy()
        env.update(
            {
                "HOME": td,
                "CODEX_HOME": td,
                "AUTODEV_OTEL_REPO_ROOT": td,
                "AUTODEV_OTEL_CONFIG": f"{td}/collector.yaml",
                "AUTODEV_OTEL_VERSION_FILE": f"{td}/collector.version",
                "AUTODEV_OTEL_HOST": "127.0.0.1",
                "AUTODEV_OTEL_PORT": str(self.free_port()),
            }
        )
        env.update(extra)
        return env

    def fake_binary(self, td: str, version: str = "v0.160.0") -> Path:
        binary = Path(td) / "otelcol"
        binary.write_text(
            textwrap.dedent(
                f"""\
                #!/bin/sh
                if [ "$1" = "--version" ]; then echo 'otelcol version {version}'; exit 0; fi
                if [ "$1" = "validate" ]; then echo validated > "$FAKE_VALIDATED"; exit 0; fi
                echo "$@" > "$FAKE_ARGS"
                exit 0
                """
            )
        )
        binary.chmod(0o700)
        return binary

    def base_files(self, td: str) -> None:
        Path(td, "collector.yaml").write_text("receivers: {}\n")
        Path(td, "collector.version").write_text("v0.160.0\n")

    def test_run_uses_explicit_binary_and_exact_version_and_config(self):
        with tempfile.TemporaryDirectory() as td:
            self.base_files(td)
            binary = self.fake_binary(td)
            env = self.env(
                td,
                AUTODEV_OTELCOL_BIN=str(binary),
                FAKE_VALIDATED=f"{td}/validated",
                FAKE_ARGS=f"{td}/args",
                PATH="/usr/bin:/bin",
            )
            result = subprocess.run([str(RUN)], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(Path(td, "validated").exists())
            self.assertEqual(
                Path(td, "args").read_text().strip(),
                f"--config {td}/collector.yaml",
            )

    def test_run_rejects_version_mismatch_before_validation(self):
        with tempfile.TemporaryDirectory() as td:
            self.base_files(td)
            binary = self.fake_binary(td, version="v0.160.1")
            env = self.env(td, AUTODEV_OTELCOL_BIN=str(binary), FAKE_VALIDATED=f"{td}/validated")
            result = subprocess.run([str(RUN)], env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("version mismatch", result.stderr)
            self.assertFalse(Path(td, "validated").exists())

    def test_run_check_allows_existing_collector_listener(self):
        with tempfile.TemporaryDirectory() as td:
            self.base_files(td)
            binary = self.fake_binary(td)
            fakebin = Path(td, "bin")
            fakebin.mkdir()
            nc = fakebin / "nc"
            nc.write_text("#!/bin/sh\nexit 0\n")
            nc.chmod(0o700)
            env = self.env(
                td,
                AUTODEV_OTELCOL_BIN=str(binary),
                PATH=f"{fakebin}:/usr/bin:/bin",
            )
            result = subprocess.run([str(RUN), "--check"], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("validates", result.stdout)

    def test_run_refuses_existing_http_service_as_duplicate(self):
        with tempfile.TemporaryDirectory() as td:
            self.base_files(td)
            binary = self.fake_binary(td)
            fakebin = Path(td, "bin")
            fakebin.mkdir()
            (fakebin / "curl").write_text("#!/bin/sh\nprintf '200'\n")
            (fakebin / "curl").chmod(0o700)
            env = self.env(td, AUTODEV_OTELCOL_BIN=str(binary), PATH=f"{fakebin}:/usr/bin:/bin")
            result = subprocess.run([str(RUN)], env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("duplicate", result.stderr)

    def test_ensure_starts_once_and_keeps_state_private(self):
        with tempfile.TemporaryDirectory() as td:
            run_dir = Path(td, "run")
            runner = Path(td, "runner.sh")
            ready = Path(td, "ready")
            runner.write_text(f"#!/bin/sh\ntouch '{ready}'\nsleep 30\n")
            runner.chmod(0o700)
            fakebin = Path(td, "bin")
            fakebin.mkdir()
            curl = fakebin / "curl"
            curl.write_text(f"#!/bin/sh\ntest -f '{ready}' && printf '404' || printf '000'\n")
            curl.chmod(0o700)
            env = self.env(
                td,
                AUTODEV_OTEL_RUNNER=str(runner),
                AUTODEV_OTEL_RUN_DIR=str(run_dir),
                AUTODEV_OTEL_START_TIMEOUT="3",
                PATH=f"{fakebin}:/usr/bin:/bin",
            )
            result = subprocess.run([str(ENSURE)], env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(stat.S_IMODE(run_dir.stat().st_mode), 0o700)
            self.assertFalse(Path(run_dir, "autodev-otel-collector.pid").exists())
            # The test runner is the only process this test started; terminate it
            # through the marker-free shell process tree before the temp dir goes.
            subprocess.run(["pkill", "-f", str(runner)], check=False, capture_output=True)

    def test_launchagent_is_foreground_keepalive_and_private(self):
        plist = plistlib.loads(PLIST.read_bytes())
        self.assertEqual(plist["Label"], "com.codex.otel-collector")
        self.assertEqual(plist["KeepAlive"], True)
        self.assertEqual(plist["ProgramArguments"][0], "/bin/bash")
        self.assertIn("run-autodev-otel-collector.sh", plist["ProgramArguments"][1])
        self.assertIn("__CODEX_HOME__/run/", plist["StandardOutPath"])
        self.assertIn("__CODEX_HOME__/run/", plist["StandardErrorPath"])


if __name__ == "__main__":
    unittest.main()
