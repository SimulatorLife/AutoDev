import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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

import { writeKeychainSecret } from "@simulatorlife/autodev-runtime/shared/runtime-secrets";

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
      [join(repositoryRoot, "scripts/run-autodev-model-router.sh")],
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

test("model router launcher preserves explicit MINIMAX_API_KEY over .env and falls back to macOS Keychain", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-router-minimax-"));
  try {
    const codexHome = join(directory, "codex-home");
    const fakeNode = join(directory, "node");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      `OPENLIT_OTLP_API_KEY=${"a".repeat(64)}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      join(codexHome, ".env"),
      "MINIMAX_API_KEY=minimax-from-dotenv\n",
      { mode: 0o600 }
    );
    writeFileSync(
      fakeNode,
      '#!/usr/bin/env bash\nprintf "%s" "${MINIMAX_API_KEY:-missing}"\n',
      { mode: 0o700 }
    );
    chmodSync(fakeNode, 0o700);
    const runLauncher = (extraEnvironment: NodeJS.ProcessEnv = {}) => {
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: directory,
        CODEX_HOME: codexHome,
        AUTODEV_REPO_ROOT: repositoryRoot,
        AUTODEV_NODE_BIN: fakeNode,
        AUTODEV_SKIP_LAUNCHCTL: "1",
        AUTODEV_DISABLE_KEYCHAIN: "1",
        ...extraEnvironment
      };
      if (!("MINIMAX_API_KEY" in extraEnvironment)) delete environment.MINIMAX_API_KEY;
      return spawnSync(
        "bash",
        [join(repositoryRoot, "scripts/run-autodev-model-router.sh")],
        { encoding: "utf8", env: environment }
      );
    };

    const fromDotenv = runLauncher();
    assert.equal(fromDotenv.status, 0, fromDotenv.stderr);
    assert.equal(fromDotenv.stdout, "minimax-from-dotenv");

    const fromOverride = runLauncher({ MINIMAX_API_KEY: "minimax-explicit" });
    assert.equal(fromOverride.status, 0, fromOverride.stderr);
    assert.equal(fromOverride.stdout, "minimax-explicit");

    if (process.platform === "darwin") {
      const keychain = join(directory, "router-test.keychain-db");
      execFileSync("/usr/bin/security", [
        "create-keychain",
        "-p",
        "test-pass",
        keychain
      ]);
      execFileSync("/usr/bin/security", [
        "unlock-keychain",
        "-p",
        "test-pass",
        keychain
      ]);
      writeFileSync(join(codexHome, ".env"), "", { mode: 0o600 });
      writeKeychainSecret("MINIMAX_API_KEY", "minimax-from-keychain", {
        USER: "router-tester",
        AUTODEV_DISABLE_KEYCHAIN: "0",
        AUTODEV_KEYCHAIN_FILE: keychain
      });
      const fromKeychain = runLauncher({
        USER: "router-tester",
        AUTODEV_DISABLE_KEYCHAIN: "0",
        AUTODEV_KEYCHAIN_FILE: keychain
      });
      assert.equal(fromKeychain.status, 0, fromKeychain.stderr);
      assert.equal(fromKeychain.stdout, "minimax-from-keychain");

      const keychainOverridden = runLauncher({
        USER: "router-tester",
        AUTODEV_DISABLE_KEYCHAIN: "0",
        AUTODEV_KEYCHAIN_FILE: keychain,
        MINIMAX_API_KEY: "minimax-explicit-over-keychain"
      });
      assert.equal(keychainOverridden.status, 0, keychainOverridden.stderr);
      assert.equal(keychainOverridden.stdout, "minimax-explicit-over-keychain");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
