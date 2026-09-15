"""Opt-in integration coverage for the pinned Collector runtime.

Set AUTODEV_OTELCOL_BIN to a real v0.160.0 otelcol binary to run this test.
The default test suite remains offline and uses the hermetic runtime tests.
"""
from __future__ import annotations

import http.server
import json
import os
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = ROOT / "scripts/codex/otel/run-autodev-otel-collector.sh"
FIXTURE = ROOT / "tests/fixtures/otel/collector-forwarded-otlp.json"


class CollectorForwardingIntegrationTests(unittest.TestCase):
    @unittest.skipUnless(
        os.environ.get("AUTODEV_OTELCOL_BIN"),
        "set AUTODEV_OTELCOL_BIN to the pinned v0.160.0 binary for the live Collector smoke test",
    )
    def test_real_collector_forwards_all_signals_without_prompt_logging(self):
        binary = pathlib.Path(os.environ["AUTODEV_OTELCOL_BIN"])
        if not binary.is_file() or not os.access(binary, os.X_OK):
            self.skipTest(f"Collector binary is not executable: {binary}")

        with tempfile.TemporaryDirectory() as temp:
            temp_path = pathlib.Path(temp)
            receiver_port = self._free_port()
            collector_port = self._free_port()
            config = temp_path / "collector.yaml"
            config.write_text(
                (ROOT / "config/otel/collector.yaml")
                .read_text()
                .replace("127.0.0.1:4318", f"127.0.0.1:{collector_port}")
                .replace("127.0.0.1:4100", f"127.0.0.1:{receiver_port}"),
                encoding="utf-8",
            )
            forwarded: list[tuple[str, bytes]] = []

            class Receiver(http.server.BaseHTTPRequestHandler):
                def do_POST(self):  # noqa: N802 - stdlib handler API
                    size = int(self.headers.get("content-length", "0"))
                    forwarded.append((self.path, self.rfile.read(size)))
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")

                def log_message(self, *_args):
                    return

            receiver = http.server.ThreadingHTTPServer(("127.0.0.1", receiver_port), Receiver)
            receiver_thread = threading.Thread(target=receiver.serve_forever, daemon=True)
            receiver_thread.start()
            environment = os.environ.copy()
            environment.update(
                {
                    "AUTODEV_OTELCOL_BIN": str(binary),
                    "AUTODEV_OTEL_CONFIG": str(config),
                    "AUTODEV_OTEL_VERSION_FILE": str(ROOT / "config/otel/collector.version"),
                    "AUTODEV_OTEL_HOST": "127.0.0.1",
                    "AUTODEV_OTEL_PORT": str(collector_port),
                }
            )
            process = subprocess.Popen(
                [str(RUNNER)],
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self._wait_for_port("127.0.0.1", collector_port)
                fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
                fixture_text = json.dumps(fixture).replace("__OTEL_T0__", "1700000000000000000")
                fixture_text = fixture_text.replace("__OTEL_T500MS__", "1700000000500000000")
                fixture_text = fixture_text.replace("__OTEL_T900MS__", "1700000000900000000")
                fixture_text = fixture_text.replace("__OTEL_T1200MS__", "1700000001200000000")
                fixture_text = fixture_text.replace("__OTEL_T2S__", "1700000002000000000")
                fixture_text = fixture_text.replace("__OTEL_T6MS__", "1700000000006000000")
                fixture_text = fixture_text.replace("__OTEL_T13MS__", "1700000000013000000")
                fixture_text = fixture_text.replace("__OTEL_T20MS__", "1700000000020000000")
                fixture = json.loads(fixture_text)
                for path, key in (("/v1/logs", "logs"), ("/v1/traces", "traces"), ("/v1/metrics", "metrics")):
                    self._post(collector_port, path, fixture[key])
                # Cumulative metric exports are intentionally repeated; the
                # downstream AutoDev receiver owns semantic delta/dedup logic.
                self._post(collector_port, "/v1/metrics", fixture["metrics"])
                time.sleep(1)
                self.assertEqual(
                    sorted(path for path, _body in forwarded),
                    ["/v1/logs", "/v1/metrics", "/v1/metrics", "/v1/traces"],
                )
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                stderr = process.stderr.read() if process.stderr else ""
                self.assertNotIn("do-not-store-this-collector-forwarded-secret", stderr)
                if process.stdout:
                    process.stdout.close()
                if process.stderr:
                    process.stderr.close()
                receiver.shutdown()
                receiver.server_close()

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    @staticmethod
    def _wait_for_port(host: str, port: int) -> None:
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                with socket.create_connection((host, port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.1)
        raise AssertionError(f"Collector did not bind {host}:{port}")

    @staticmethod
    def _post(port: int, path: str, payload: dict) -> None:
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{path}",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status != 200:
                raise AssertionError(f"Collector returned HTTP {response.status} for {path}")


if __name__ == "__main__":
    unittest.main()
