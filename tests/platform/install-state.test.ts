import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureRouterAuth,
  readOtelIngressMode,
  writeOtelIngressMode
} from "@simulatorlife/autodev-runtime/platform/install-state";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-install-state-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("OTLP ingress state persists direct/OpenLIT modes and migrates the obsolete Collector selection", () =>
  withTempDir((directory) => {
    const path = join(directory, "otel-ingress.mode");
    assert.equal(readOtelIngressMode(path), "direct");
    writeFileSync(path, "collector\n", { mode: 0o600 });
    assert.equal(readOtelIngressMode(path), "direct");
    assert.equal(readFileSync(path, "utf8"), "direct\n");
    writeOtelIngressMode(path, "openlit");
    assert.equal(readOtelIngressMode(path), "openlit");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const link = join(directory, "link");
    symlinkSync(path, link);
    assert.throws(() => readOtelIngressMode(link), /symlinked/);
  }));

test("router auth creates a private token, preserves existing env content, and is idempotent", () =>
  withTempDir((directory) => {
    const path = join(directory, ".env");
    writeFileSync(path, "OTHER=value\n");
    const env = { AUTODEV_SKIP_LAUNCHCTL: "1" };
    const token = ensureRouterAuth(path, env);
    assert.match(token, /^[0-9a-f]{64}$/u);
    assert.equal(
      readFileSync(path, "utf8"),
      `OTHER=value\nCODEX_ROUTER_AUTH_TOKEN=${token}\n`
    );
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.equal(ensureRouterAuth(path, env), token);
    assert.equal(
      readFileSync(path, "utf8"),
      `OTHER=value\nCODEX_ROUTER_AUTH_TOKEN=${token}\n`
    );
  }));

test("router auth replaces an empty token entry rather than treating it as configured", () =>
  withTempDir((directory) => {
    const path = join(directory, ".env");
    writeFileSync(path, "CODEX_ROUTER_AUTH_TOKEN=\n");
    const token = ensureRouterAuth(path, { AUTODEV_SKIP_LAUNCHCTL: "1" });
    assert.match(
      readFileSync(path, "utf8"),
      new RegExp(`CODEX_ROUTER_AUTH_TOKEN=${token}`)
    );
  }));
