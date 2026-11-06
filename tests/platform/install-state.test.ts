import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureBridgeRouterAuth,
  ensureRouterAuth
} from "@simulatorlife/autodev-runtime/platform/install-state";

function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "autodev-install-state-"));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

test("bridge auth tokens are separate, private, and stable across installs", () =>
  withTempDir((directory) => {
    const path = join(directory, ".env");
    writeFileSync(path, "OTHER=value\nCODEX_ROUTER_AUTH_TOKEN=router-token\n");
    const tokens = ensureBridgeRouterAuth(path);
    assert.match(tokens.Copilot, /^[0-9a-f]{64}$/u);
    assert.match(tokens.opencli, /^[0-9a-f]{64}$/u);
    assert.notEqual(tokens.Copilot, tokens.opencli);
    const contents =
      `OTHER=value\nCODEX_ROUTER_AUTH_TOKEN=router-token\n` +
      `CODEX_ROUTER_COPILOT_API_KEY=${tokens.Copilot}\n` +
      `CODEX_ROUTER_OPENCLI_API_KEY=${tokens.opencli}\n`;
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(ensureBridgeRouterAuth(path), tokens);
    assert.equal(readFileSync(path, "utf8"), contents);
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
