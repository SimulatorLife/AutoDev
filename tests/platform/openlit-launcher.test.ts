import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

test("OpenLIT ingress launcher supplies protected OTLP and control-only listener settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-openlit-launcher-"));
  try {
    const codexHome = join(directory, "codex-home");
    const fakeNode = join(directory, "node");
    mkdirSync(codexHome, { recursive: true });
    const otlpToken = "a".repeat(64);
    const controlToken = "b".repeat(64);
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      [
        `OPENLIT_OTLP_API_KEY=${otlpToken}`,
        `AUTODEV_CONTROL_API_TOKEN=${controlToken}`,
        `AUTODEV_PLAYTEST_CONTROL_API_TOKEN=${"d".repeat(64)}`,
        `OPENLIT_DB_PASSWORD=${"c".repeat(64)}`
      ].join("\n") + "\n",
      { mode: 0o600 }
    );
    writeFileSync(
      fakeNode,
      [
        "#!/usr/bin/env bash",
        String.raw`printf "%s\n" "$OTEL_EXPORTER_OTLP_ENDPOINT" "$OTEL_EXPORTER_OTLP_HEADERS" "$AUTODEV_CONTROL_API_LISTEN_HOST" "$AUTODEV_CONTROL_API_LISTEN_PORT" "$AUTODEV_CONTROL_API_TOKEN" "$AUTODEV_PLAYTEST_CONTROL_API_TOKEN" "$AUTODEV_PLAYTEST_CONTROL_API_ACTOR" "$AUTODEV_PLAYTEST_CONTROL_API_ROLE"`,
        ""
      ].join("\n"),
      { mode: 0o700 }
    );
    chmodSync(fakeNode, 0o700);
    const result = spawnSync(
      "bash",
      [join(repositoryRoot, "scripts/run-codex-model-router.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: directory,
          CODEX_HOME: codexHome,
          AUTODEV_REPO_ROOT: repositoryRoot,
          AUTODEV_NODE_BIN: fakeNode,
          AUTODEV_SKIP_LAUNCHCTL: "1"
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "http://127.0.0.1:4318",
      `Authorization=Bearer%20${otlpToken}`,
      "0.0.0.0",
      "4101",
      controlToken,
      "d".repeat(64),
      "autodev-playtester-runtime",
      "playtester"
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
