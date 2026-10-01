import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("OpenLIT bootstrap provisions separate strong Usage service credentials outside the repo", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-openlit-secrets-"));
  const secretFile = join(directory, "openlit-secrets.env");
  try {
    const result = spawnSync(
      "bash",
      [
        join(repositoryRoot, "scripts/openlit/bootstrap-secrets.sh"),
        "--secret-file",
        secretFile
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(secretFile, "utf8");
    const values = Object.fromEntries(
      content
        .split("\n")
        .filter((line) => /^[A-Z0-9_]+=/.test(line))
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
    const secretNames = [
      "OPENLIT_DB_PASSWORD",
      "AUTODEV_CONTROL_API_TOKEN",
      "OPENLIT_OTLP_API_KEY",
      "AUTODEV_OPENLIT_USAGE_TOKEN"
    ];
    const secrets = secretNames.map((name) => values[name]);
    assert.ok(
      secrets.every(
        (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
      )
    );
    assert.equal(new Set(secrets).size, secretNames.length);
    assert.ok(secrets.every((secret) => !result.stdout.includes(secret)));
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
