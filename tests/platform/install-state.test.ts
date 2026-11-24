import assert from "node:assert/strict";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  checkRequiredKeychainSecrets,
  ensureBridgeRouterAuth,
  ensureRouterAuth,
  findPlaintextKeychainSecrets,
  migrateEnvSecretsToKeychain
} from "@simulatorlife/autodev-runtime/platform/install-state";

import { withTempDir } from "../support/test-helpers.ts";

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

test("migrateEnvSecretsToKeychain moves Keychain-managed secrets out of .env while preserving other entries", () =>
  withTempDir((directory) => {
    const envPath = join(directory, ".env");
    writeFileSync(
      envPath,
      [
        "# Keep comments",
        "CODEX_ROUTER_AUTH_TOKEN=router-secret",
        "MINIMAX_API_KEY=minimax-plaintext",
        'export CONTEXT7_API_KEY="context7-plaintext"',
        "AUTODEV_CHATGPT_TUNNEL_API_KEY=tunnel-plaintext",
        "OPENCLI_GEMINI_ACCOUNT=me@example.com"
      ].join("\n") + "\n",
      { mode: 0o600 }
    );
    const store = new Map<string, string>();
    const deps = {
      platform: "darwin" as const,
      runSecurity: (args: readonly string[], input?: string) => {
        if (args[0] === "-i" && input) {
          const match =
            /-s "([^"]+)" -T "\/usr\/bin\/security" -w "((?:[^"\\]|\\.)*)"/u.exec(
              input
            );
          if (match) store.set(match[1]!, match[2]!);
          return "";
        }
        if (args[0] === "find-generic-password") {
          const service = args[args.indexOf("-s") + 1]!;
          const value = store.get(service);
          if (!value) throw new Error("missing");
          return `${value}\n`;
        }
        throw new Error("unexpected command");
      }
    };
    const env = { USER: "tester", AUTODEV_DISABLE_KEYCHAIN: "0" };
    assert.deepEqual(findPlaintextKeychainSecrets(envPath), [
      "MINIMAX_API_KEY",
      "CONTEXT7_API_KEY",
      "AUTODEV_CHATGPT_TUNNEL_API_KEY"
    ]);
    const migrated = migrateEnvSecretsToKeychain(envPath, env, { deps });
    assert.deepEqual(migrated, [
      "MINIMAX_API_KEY",
      "CONTEXT7_API_KEY",
      "AUTODEV_CHATGPT_TUNNEL_API_KEY"
    ]);
    assert.equal(store.get("MINIMAX_API_KEY"), "minimax-plaintext");
    assert.equal(store.get("CONTEXT7_API_KEY"), "context7-plaintext");
    assert.equal(
      store.get("AUTODEV_CHATGPT_TUNNEL_API_KEY"),
      "tunnel-plaintext"
    );
    assert.deepEqual(findPlaintextKeychainSecrets(envPath), []);
    assert.equal(
      readFileSync(envPath, "utf8"),
      [
        "# Keep comments",
        "CODEX_ROUTER_AUTH_TOKEN=router-secret",
        "OPENCLI_GEMINI_ACCOUNT=me@example.com"
      ].join("\n") + "\n"
    );
    assert.equal(lstatSync(envPath).mode & 0o777, 0o600);
    assert.deepEqual(checkRequiredKeychainSecrets(undefined, env, deps), []);
    store.delete("CONTEXT7_API_KEY");
    assert.deepEqual(checkRequiredKeychainSecrets(undefined, env, deps), [
      "CONTEXT7_API_KEY"
    ]);
  }));
