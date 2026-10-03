import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkBackends,
  ensureConsoleSecrets,
  isPortListening,
  repoRoot
} from "@simulatorlife/autodev-runtime/cli/dev";

test("package.json declares dev and dev:console scripts", () => {
  const pkgPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  assert.equal(pkg.scripts.dev, "node runtime/src/cli/dev.ts");
  assert.equal(
    pkg.scripts["dev:console"],
    "pnpm --filter @simulatorlife/autodev-console dev"
  );
});

test("isPortListening resolves false on closed port and true on listening port", async () => {
  // Closed port test
  const closed = await isPortListening(59_981, "127.0.0.1", 100);
  assert.equal(closed, false);

  // Open port test with local server
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const openPort = address.port;

  const listening = await isPortListening(openPort, "127.0.0.1", 200);
  assert.equal(listening, true);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

test("ensureConsoleSecrets runs without throwing in repository root", () => {
  assert.doesNotThrow(() => {
    ensureConsoleSecrets(repoRoot);
  });
});

test("ensureConsoleSecrets synchronizes out-of-sync console/.env.local", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "autodev-dev-secrets-"));
  const consoleDir = join(tempDir, "console");
  const scriptsDir = join(tempDir, "scripts", "openlit");
  mkdirSync(consoleDir, { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = join(scriptsDir, "bootstrap-secrets.sh");
  const consoleEnv = join(consoleDir, ".env.local");
  writeFileSync(
    scriptPath,
    `#!/bin/sh\ncat > "${consoleEnv}" << 'EOF'\nAUTODEV_CONTROL_API_TOKEN=synced-token\nAUTODEV_OPENLIT_USAGE_TOKEN=synced-usage\nEOF\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    consoleEnv,
    "AUTODEV_CONTROL_API_TOKEN=stale-token\nAUTODEV_OPENLIT_USAGE_TOKEN=stale-usage\n"
  );
  const secretDir = mkdtempSync(join(tmpdir(), "autodev-dev-canon-"));
  const canonSecretFile = join(secretDir, "openlit-secrets.env");
  writeFileSync(
    canonSecretFile,
    "AUTODEV_CONTROL_API_TOKEN=synced-token\nAUTODEV_OPENLIT_USAGE_TOKEN=synced-usage\n"
  );
  const prevSecretFile = process.env.AUTODEV_OPENLIT_SECRET_FILE;
  process.env.AUTODEV_OPENLIT_SECRET_FILE = canonSecretFile;
  try {
    ensureConsoleSecrets(tempDir);
    const content = readFileSync(consoleEnv, "utf8");
    assert.match(content, /AUTODEV_CONTROL_API_TOKEN=synced-token/);
    assert.match(content, /AUTODEV_OPENLIT_USAGE_TOKEN=synced-usage/);
  } finally {
    if (prevSecretFile === undefined) {
      delete process.env.AUTODEV_OPENLIT_SECRET_FILE;
    } else {
      process.env.AUTODEV_OPENLIT_SECRET_FILE = prevSecretFile;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  }
});

test("checkBackends checks telemetry and router status without uncaught rejection", async () => {
  const status = await checkBackends();
  assert.equal(typeof status.telemetryActive, "boolean");
  assert.equal(typeof status.routerActive, "boolean");
});
