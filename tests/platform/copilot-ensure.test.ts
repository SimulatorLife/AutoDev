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
import { join, resolve as resolvePath } from "node:path";
import test from "node:test";

import {
  type CopilotEnsureDeps,
  type CopilotEnsureOptions,
  ensureCopilotProxy,
  resolveCopilotEnsureOptions
} from "@simulatorlife/autodev-runtime/platform/copilot-ensure";

function options(
  overrides: Partial<CopilotEnsureOptions> = {}
): CopilotEnsureOptions {
  return {
    host: "127.0.0.1",
    port: 4003,
    label: "com.codex.copilot-proxy",
    domain: "gui/501",
    plist: "/tmp/copilot.plist",
    launcher: "/tmp/copilot.sh",
    copilotBin: "copilot",
    readyTimeoutMs: 20,
    logPath: "/tmp/copilot.log",
    ...overrides
  };
}

function deps(overrides: Partial<CopilotEnsureDeps> = {}): CopilotEnsureDeps {
  let loaded = false;
  return {
    launchd: {
      isLoaded: () => loaded,
      kickstart: () => {
        loaded = true;
      },
      bootstrap: () => {
        loaded = true;
      }
    },
    probe: async () => false,
    sleep: async () => {},
    commandAvailable: () => true,
    startFallback: () => {},
    ...overrides
  };
}

test("resolver derives the Copilot launchd and typed-runtime paths", () => {
  const result = resolveCopilotEnsureOptions({
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    COPILOT_BIN: "/bin/copilot",
    TMPDIR: "/tmp"
  });
  assert.equal(
    result.launcher,
    "/home/test/.codex/hooks/run-codex-copilot-cli-responses-proxy.sh"
  );
  assert.equal(
    result.plist,
    "/home/test/Library/LaunchAgents/com.codex.copilot-proxy.plist"
  );
  assert.equal(result.copilotBin, "/bin/copilot");
});

test("Copilot launcher loads the Router bridge key from the private CODEX_HOME env file", () => {
  const root = mkdtempSync(join(tmpdir(), "autodev-copilot-launcher-"));
  const codexHome = join(root, ".codex");
  const installedProxy = join(codexHome, "src", "providers", "copilot.ts");
  const fakeNode = join(root, "fake-node");
  const capture = join(root, "captured-key");
  const token = "a".repeat(64);
  const launcher = resolvePath(
    import.meta.dirname,
    "../../scripts/run-codex-copilot-cli-responses-proxy.sh"
  );
  try {
    mkdirSync(join(codexHome, "src", "providers"), { recursive: true });
    writeFileSync(installedProxy, "// fixture\n");
    writeFileSync(
      join(codexHome, ".env"),
      `CODEX_ROUTER_COPILOT_API_KEY=${token}\n`,
      { mode: 0o600 }
    );
    writeFileSync(
      fakeNode,
      '#!/bin/sh\nprintf "%s" "${CODEX_ROUTER_COPILOT_API_KEY:-}" > "$COPILOT_BRIDGE_AUTH_CAPTURE"\n',
      { mode: 0o700 }
    );
    chmodSync(fakeNode, 0o700);
    const result = spawnSync("/bin/bash", [launcher], {
      cwd: root,
      encoding: "utf8",
      env: {
        CODEX_HOME: codexHome,
        HOME: root,
        AUTODEV_NODE_BIN: fakeNode,
        COPILOT_BRIDGE_AUTH_CAPTURE: capture,
        PATH: "/usr/bin:/bin"
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(capture, "utf8"), token);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(token));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("healthy Copilot proxy is left untouched", async () => {
  let started = false;
  const result = await ensureCopilotProxy(
    options(),
    deps({
      probe: async () => true,
      startFallback: () => {
        started = true;
      }
    })
  );
  assert.equal(result, true);
  assert.equal(started, false);
});

test("missing Copilot CLI is an optional no-op", async () => {
  const result = await ensureCopilotProxy(
    options(),
    deps({ commandAvailable: () => false })
  );
  assert.equal(result, true);
});

test("loaded launchd service is restarted and awaited", async () => {
  const calls: string[] = [];
  const result = await ensureCopilotProxy(
    options(),
    deps({
      launchd: {
        isLoaded: () => true,
        kickstart: () => {
          calls.push("kickstart");
        },
        bootstrap: () => {
          calls.push("bootstrap");
        }
      },
      probe: (() => {
        let count = 0;
        return async () => ++count > 1;
      })(),
      sleep: async () => {}
    })
  );
  assert.equal(result, true);
  assert.deepEqual(calls, ["kickstart"]);
});

test("existing plist is bootstrapped before fallback", async () => {
  const calls: string[] = [];
  const result = await ensureCopilotProxy(
    { ...options(), plist: "/tmp/does-not-exist" },
    deps({
      launchd: {
        isLoaded: () => false,
        kickstart: () => {
          calls.push("kickstart");
        },
        bootstrap: () => {
          calls.push("bootstrap");
        }
      },
      probe: async () => true
    })
  );
  assert.equal(result, true);
  assert.deepEqual(calls, []);
});

test("fallback launcher is used when launchd cannot serve the proxy", async () => {
  const calls: string[] = [];
  const result = await ensureCopilotProxy(
    options({ plist: "/tmp/missing", launcher: "/tmp/missing" }),
    deps({
      probe: async () => false,
      startFallback: (launcher, logPath) => {
        calls.push(`${launcher}:${logPath}`);
      }
    })
  );
  assert.equal(result, false);
  assert.deepEqual(calls, []);
});
