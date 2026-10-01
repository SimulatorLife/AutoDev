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
    writeFileSync(join(codexHome, "otel-ingress.mode"), "openlit\n");
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      [
        `OPENLIT_OTLP_API_KEY=${otlpToken}`,
        `AUTODEV_CONTROL_API_TOKEN=${controlToken}`,
        `OPENLIT_DB_PASSWORD=${"c".repeat(64)}`
      ].join("\n") + "\n",
      { mode: 0o600 }
    );
    writeFileSync(
      fakeNode,
      [
        "#!/usr/bin/env bash",
        String.raw`printf "%s\n" "$OTEL_EXPORTER_OTLP_ENDPOINT" "$OTEL_EXPORTER_OTLP_HEADERS" "$AUTODEV_CONTROL_API_LISTEN_HOST" "$AUTODEV_CONTROL_API_LISTEN_PORT" "$AUTODEV_CONTROL_API_TOKEN"`,
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
          AUTODEV_OTEL_MODE: "openlit",
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
      controlToken
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("returning from OpenLIT ingress clears only the launcher's stale OTLP environment", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "autodev-openlit-ingress-reset-")
  );
  try {
    const codexHome = join(directory, "codex-home");
    const fakeNode = join(directory, "node");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "otel-ingress.mode"), "direct\n");
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      `OPENLIT_OTLP_API_KEY=${"a".repeat(64)}\nAUTODEV_CONTROL_API_TOKEN=${"b".repeat(64)}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      fakeNode,
      [
        "#!/usr/bin/env bash",
        String.raw`printf "%s\n" "$OTEL_EXPORTER_OTLP_ENDPOINT" "$OTEL_EXPORTER_OTLP_HEADERS"`,
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
          AUTODEV_SKIP_LAUNCHCTL: "1",
          AUTODEV_OPENLIT_OTLP_AUTH: "1",
          AUTODEV_CONTROL_API_LISTEN_HOST: "",
          AUTODEV_CONTROL_API_LISTEN_PORT: "",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
          OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20old-token"
        }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const [endpoint, headers] = result.stdout.split("\n");
    assert.equal(endpoint, "");
    assert.equal(headers, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
