import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
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

test("checkBackends checks telemetry and router status without uncaught rejection", async () => {
  const status = await checkBackends();
  assert.equal(typeof status.telemetryActive, "boolean");
  assert.equal(typeof status.routerActive, "boolean");
});
