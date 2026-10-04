import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function parseEnv(content: string): Record<string, string> {
  return Object.fromEntries(
    content
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

/**
 * Build a throwaway "repository root" with an empty `console/` directory so
 * the bootstrap script's REPO_ROOT probe succeeds in the tests directory while
 * never touching the real AutoDev checkout. REPO_ROOT is honored as an
 * environment variable by the script; SECRET_FILE only via --secret-file.
 */
function ephemeralRepoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "autodev-bootstrap-secrets-"));
  mkdirSync(join(root, "console"), { recursive: true });
  return root;
}

function runBootstrap(
  repoRoot: string,
  secretFile: string
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    "bash",
    [
      join(repositoryRoot, "scripts/openlit/bootstrap-secrets.sh"),
      "--secret-file",
      secretFile
    ],
    {
      encoding: "utf8",
      env: { ...process.env, REPO_ROOT: repoRoot },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

test("OpenLIT bootstrap provisions separate strong Usage service credentials outside the repo", () => {
  const directory = mkdtempSync(join(tmpdir(), "autodev-openlit-secrets-"));
  const secretFile = join(directory, "openlit-secrets.env");
  const repoRoot = ephemeralRepoRoot();
  try {
    const result = runBootstrap(repoRoot, secretFile);
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(secretFile, "utf8");
    const values = parseEnv(content);
    const secretNames = [
      "OPENLIT_DB_PASSWORD",
      "AUTODEV_CONTROL_API_TOKEN",
      "OPENLIT_OTLP_API_KEY",
      "AUTODEV_OPENLIT_USAGE_TOKEN"
    ];
    const secrets = secretNames.map((name) => values[name]);
    assert.ok(
      secrets.every(
        (value): value is string =>
          typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
      )
    );
    assert.equal(new Set(secrets).size, secretNames.length);
    assert.ok(secrets.every((secret) => !result.stdout.includes(secret)));
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("OpenLIT bootstrap materializes server-only Console tokens into console/.env.local for Next.js", () => {
  const secretDirectory = mkdtempSync(
    join(tmpdir(), "autodev-openlit-secrets-env-")
  );
  const repoRoot = ephemeralRepoRoot();
  const secretFile = join(secretDirectory, "openlit-secrets.env");
  const consoleEnvLocal = join(repoRoot, "console", ".env.local");
  try {
    const result = runBootstrap(repoRoot, secretFile);
    assert.equal(result.status, 0, result.stderr);
    const consoleContent = readFileSync(consoleEnvLocal, "utf8");
    const consoleValues = parseEnv(consoleContent);
    assert.equal(
      statSync(consoleEnvLocal).mode & 0o777,
      0o600,
      "console/.env.local must be owner-readable only"
    );
    const secretContent = readFileSync(secretFile, "utf8");
    const secretValues = parseEnv(secretContent);
    assert.equal(
      consoleValues.AUTODEV_CONTROL_API_TOKEN,
      secretValues.AUTODEV_CONTROL_API_TOKEN,
      "console/.env.local CONTROL token must mirror the CODEX_HOME secret file"
    );
    assert.equal(
      consoleValues.AUTODEV_OPENLIT_USAGE_TOKEN,
      secretValues.AUTODEV_OPENLIT_USAGE_TOKEN,
      "console/.env.local USAGE token must mirror the CODEX_HOME secret file"
    );
    assert.equal(
      consoleValues.AUTODEV_CONTROL_API_BASE_URL,
      "${AUTODEV_CONTROL_API_BASE_URL:-http://127.0.0.1:4101}",
      "console/.env.local must defer CONTROL base URL to Next.js env expansion"
    );
    assert.equal(
      consoleValues.AUTODEV_OPENLIT_USAGE_URL,
      "${AUTODEV_OPENLIT_USAGE_URL:-http://127.0.0.1:3000}",
      "console/.env.local must defer USAGE base URL to Next.js env expansion"
    );
    assert.equal(
      consoleContent.includes("OPENLIT_DB_PASSWORD"),
      false,
      "console/.env.local must not carry the database password (server-only DB credential)"
    );
    assert.equal(
      consoleContent.includes("OPENLIT_OTLP_API_KEY"),
      false,
      "console/.env.local must not carry the OTLP receiver token (proxy-only credential)"
    );
    assert.ok(
      !result.stdout.includes(secretValues.AUTODEV_CONTROL_API_TOKEN ?? ""),
      "stdout must never echo the CONTROL token"
    );
    assert.ok(
      !result.stdout.includes(secretValues.AUTODEV_OPENLIT_USAGE_TOKEN ?? ""),
      "stdout must never echo the USAGE token"
    );
  } finally {
    rmSync(secretDirectory, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("OpenLIT bootstrap overwrites stale console/.env.local and enforces mode 0600", () => {
  const secretDirectory = mkdtempSync(
    join(tmpdir(), "autodev-openlit-secrets-overwrite-")
  );
  const repoRoot = ephemeralRepoRoot();
  const secretFile = join(secretDirectory, "openlit-secrets.env");
  const consoleEnvLocal = join(repoRoot, "console", ".env.local");
  try {
    writeFileSync(
      consoleEnvLocal,
      [
        "AUTODEV_CONTROL_API_TOKEN=stale-previous-value",
        "AUTODEV_OPENLIT_USAGE_TOKEN=stale-previous-usage",
        "AUTODEV_CUSTOM_NOTE=this should not survive an overwrite"
      ].join("\n") + "\n",
      { mode: 0o644 }
    );
    assert.equal(statSync(consoleEnvLocal).mode & 0o777, 0o644);

    const result = runBootstrap(repoRoot, secretFile);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      statSync(consoleEnvLocal).mode & 0o777,
      0o600,
      "console/.env.local must end up mode 0600 even when overwriting a more permissive file"
    );
    const consoleContent = readFileSync(consoleEnvLocal, "utf8");
    assert.equal(
      consoleContent.includes("stale-previous-value"),
      false,
      "stale CONTROL token value must be replaced"
    );
    assert.equal(
      consoleContent.includes("AUTODEV_CUSTOM_NOTE"),
      false,
      "manual entries are not preserved: console/.env.local is the canonical Console environment file"
    );
    assert.equal(consoleContent.includes("AUTODEV_CONTROL_API_TOKEN"), true);
  } finally {
    rmSync(secretDirectory, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("OpenLIT bootstrap with non-canonical secret-file does not touch repository console/.env.local without explicit REPO_ROOT", () => {
  const secretDirectory = mkdtempSync(
    join(tmpdir(), "autodev-openlit-secrets-custom-")
  );
  const secretFile = join(secretDirectory, "isolated-secrets.env");
  const repoConsoleEnv = join(repositoryRoot, "console", ".env.local");
  const previousContent = readFileSync(repoConsoleEnv, "utf8");
  try {
    const result = spawnSync(
      "bash",
      [
        join(repositoryRoot, "scripts/openlit/bootstrap-secrets.sh"),
        "--secret-file",
        secretFile
      ],
      {
        encoding: "utf8",
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(repoConsoleEnv, "utf8"), previousContent);
  } finally {
    rmSync(secretDirectory, { recursive: true, force: true });
  }
});
