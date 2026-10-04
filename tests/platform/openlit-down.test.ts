import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = new URL("../..", import.meta.url).pathname;

test("OpenLIT down stops the configured stack and preserves its volumes", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-openlit-down-"));
  try {
    const binDirectory = join(directory, "bin");
    const codexHome = join(directory, "codex-home");
    const capture = join(directory, "docker-args.txt");
    const composeFile = join(directory, "compose.yml");
    const envFile = join(directory, "openlit.env");
    const docker = join(binDirectory, "docker");
    const secret = join(codexHome, "openlit-secrets.env");
    const home = join(directory, "home");
    mkdirSync(binDirectory, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    const fakeDocker = [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "compose" && "$2" == "version" ]]; then exit 0; fi',
      String.raw`printf "%s\n" "$@" > "$OPENLIT_DOCKER_CAPTURE"`
    ].join("\n");

    writeFileSync(docker, fakeDocker, { mode: 0o700 });
    writeFileSync(composeFile, "services: {}\n");
    writeFileSync(envFile, "OPENLIT_IMAGE=example\n");
    writeFileSync(
      secret,
      [
        `OPENLIT_DB_PASSWORD=${"a".repeat(64)}`,
        `OPENLIT_OTLP_API_KEY=${"b".repeat(64)}`,
        `AUTODEV_CONTROL_API_TOKEN=${"c".repeat(64)}`,
        `AUTODEV_OPENLIT_USAGE_TOKEN=${"d".repeat(64)}`
      ].join("\n") + "\n",
      { mode: 0o600 }
    );
    chmodSync(docker, 0o700);
    const result = spawnSync(
      "bash",
      [join(repositoryRoot, "scripts/openlit/down.sh")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          CODEX_HOME: codexHome,
          REPO_ROOT: repositoryRoot,
          AUTODEV_OPENLIT_COMPOSE_FILE: composeFile,
          AUTODEV_OPENLIT_ENV_FILE: envFile,
          OPENLIT_DOCKER_CAPTURE: capture,
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`
        }
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(capture, "utf8").trim().split("\n");
    assert.deepEqual(args, [
      "compose",
      "--env-file",
      envFile,
      "-f",
      composeFile,
      "down"
    ]);
    assert.equal(args.includes("--volumes"), false);
    assert.doesNotMatch(result.stdout + result.stderr, /[a-d]{64}/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
