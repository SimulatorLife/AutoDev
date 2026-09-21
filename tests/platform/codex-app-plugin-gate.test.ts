import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse } from "smol-toml";

import { ensureCodexAppMcpServerEnabled } from "../../src/platform/install-materializer.ts";

const PLUGIN_VERSION = "0.1.4";
const SENTINEL = path.join("autodev", "codex-app-tools-state.json");

function cachePath(codexHome: string, version = PLUGIN_VERSION): string {
  return path.join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "codex-app-tools",
    version,
    ".mcp.json"
  );
}

function seedCache(
  codexHome: string,
  server: Record<string, unknown>,
  version = PLUGIN_VERSION
): string {
  const target = cachePath(codexHome, version);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    JSON.stringify({ mcpServers: { codex_app: server } }, null, 2) + "\n",
    "utf8"
  );
  return target;
}

function readCacheServer(
  codexHome: string,
  version = PLUGIN_VERSION
): Record<string, unknown> {
  const parsed = JSON.parse(
    readFileSync(cachePath(codexHome, version), "utf8")
  );
  return parsed.mcpServers.codex_app as Record<string, unknown>;
}

function readSentinel(codexHome: string): any {
  return JSON.parse(readFileSync(path.join(codexHome, SENTINEL), "utf8"));
}

function withCodexHome(run: (codexHome: string) => void): void {
  const codexHome = mkdtempSync(path.join(tmpdir(), "autodev-codex-app-"));
  try {
    run(codexHome);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

test("a disabled plugin cache is repaired and recorded in the sentinel", () => {
  withCodexHome((codexHome) => {
    seedCache(codexHome, { command: "launch", enabled: false });

    ensureCodexAppMcpServerEnabled(codexHome);

    const server = readCacheServer(codexHome);
    assert.equal(server.enabled, true);
    assert.deepEqual(server.enabled_tools, ["request_user_input"]);
    // Unrelated keys the plugin owns are preserved, not rewritten wholesale.
    assert.equal(server.command, "launch");

    const sentinel = readSentinel(codexHome);
    assert.equal(sentinel.sentinel, "autodev-codex-app-tools-v1");
    assert.equal(sentinel.lastInstallRepairedDrift, true);
    assert.equal(sentinel.versions[PLUGIN_VERSION].observedEnabled, false);
    assert.equal(sentinel.versions[PLUGIN_VERSION].observedTools, null);
    assert.equal(sentinel.versions[PLUGIN_VERSION].rewrotePluginCache, true);
  });
});

test("thread tools left in the cache are narrowed back to request_user_input", () => {
  withCodexHome((codexHome) => {
    seedCache(codexHome, {
      enabled: true,
      enabled_tools: ["request_user_input", "create_thread", "fork_thread"]
    });

    ensureCodexAppMcpServerEnabled(codexHome);

    assert.deepEqual(readCacheServer(codexHome).enabled_tools, [
      "request_user_input"
    ]);
    const sentinel = readSentinel(codexHome);
    assert.equal(sentinel.lastInstallRepairedDrift, true);
    assert.deepEqual(sentinel.versions[PLUGIN_VERSION].observedTools, [
      "request_user_input",
      "create_thread",
      "fork_thread"
    ]);
  });
});

test("a second install is idempotent and still refreshes the sentinel", () => {
  withCodexHome((codexHome) => {
    seedCache(codexHome, { enabled: false });
    ensureCodexAppMcpServerEnabled(codexHome);
    const afterFirst = readFileSync(cachePath(codexHome), "utf8");

    ensureCodexAppMcpServerEnabled(codexHome);

    assert.equal(readFileSync(cachePath(codexHome), "utf8"), afterFirst);
    const sentinel = readSentinel(codexHome);
    assert.equal(sentinel.lastInstallRepairedDrift, false);
    assert.equal(sentinel.versions[PLUGIN_VERSION].observedEnabled, true);
    assert.equal(sentinel.versions[PLUGIN_VERSION].rewrotePluginCache, false);
  });
});

test("drift reintroduced after an install is repaired by the next install", () => {
  withCodexHome((codexHome) => {
    seedCache(codexHome, { enabled: false });
    ensureCodexAppMcpServerEnabled(codexHome);

    // Codex Desktop regenerates the plugin cache on startup, dropping both
    // gates. A sentinel recording "already asserted" must not suppress the
    // next install's repair.
    seedCache(codexHome, { enabled: false });
    ensureCodexAppMcpServerEnabled(codexHome);

    const server = readCacheServer(codexHome);
    assert.equal(server.enabled, true);
    assert.deepEqual(server.enabled_tools, ["request_user_input"]);
    assert.equal(readSentinel(codexHome).lastInstallRepairedDrift, true);
  });
});

test("every cached plugin version is asserted", () => {
  withCodexHome((codexHome) => {
    seedCache(codexHome, { enabled: false }, "0.1.4");
    seedCache(codexHome, { enabled: false }, "0.2.0");

    ensureCodexAppMcpServerEnabled(codexHome);

    for (const version of ["0.1.4", "0.2.0"]) {
      assert.equal(readCacheServer(codexHome, version).enabled, true);
      assert.equal(
        readSentinel(codexHome).versions[version].rewrotePluginCache,
        true
      );
    }
  });
});

test("an absent plugin cache is a no-op rather than an error", () => {
  withCodexHome((codexHome) => {
    assert.doesNotThrow(() => ensureCodexAppMcpServerEnabled(codexHome));
    assert.throws(() => readSentinel(codexHome), /ENOENT/);
  });
});

test("the portable config declares both user-level codex_app gates", () => {
  const portable = parse(
    readFileSync(
      new URL("../../config/config.autodev.toml", import.meta.url).pathname,
      "utf8"
    )
  ) as any;
  const plugin = portable.plugins["codex-app-tools@openai-bundled"];
  assert.equal(
    plugin.enabled,
    true,
    "the bundled Codex App tools plugin must be enabled for request_user_input"
  );
  assert.equal(plugin.mcp_servers.codex_app.enabled, true);
  assert.deepEqual(plugin.mcp_servers.codex_app.enabled_tools, [
    "request_user_input"
  ]);
});
