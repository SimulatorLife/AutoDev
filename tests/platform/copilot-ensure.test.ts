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
  type CopilotEnsureOptions,
  ensureCopilotProxy,
  resolveCopilotEnsureOptions
} from "@simulatorlife/autodev-runtime/platform/copilot-ensure";
import type { OptionalBridgeDeps } from "@simulatorlife/autodev-runtime/platform/optional-bridge-ensure";
import { findCodexAppMcpServer } from "@simulatorlife/autodev-runtime/shared/executables";

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
    copilotBin: "/opt/homebrew/bin/copilot",
    readyTimeoutMs: 20,
    logPath: "/tmp/copilot.log",
    ...overrides
  };
}

function deps(overrides: Partial<OptionalBridgeDeps> = {}): OptionalBridgeDeps {
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
    startFallback: () => {},
    ...overrides
  };
}

test("resolver derives the Copilot launchd and typed-runtime paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "autodev-copilot-ensure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, "copilot");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(binary, 0o755);
  const result = resolveCopilotEnsureOptions({
    HOME: "/home/test",
    CODEX_HOME: "/home/test/.codex",
    COPILOT_BIN: binary,
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
  assert.equal(result.copilotBin, binary);
});

test("the Copilot CLI is found when only a version-managed install has it", (t) => {
  const home = mkdtempSync(join(tmpdir(), "autodev-copilot-nvm-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const binary = join(
    home,
    ".nvm",
    "versions",
    "node",
    "v25.0.0",
    "bin",
    "copilot"
  );
  mkdirSync(join(home, ".nvm", "versions", "node", "v25.0.0", "bin"), {
    recursive: true
  });
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(binary, 0o755);
  // The launchd PATH the router and the bridge run with: it names no version
  // manager's bin directory, so a PATH lookup alone finds nothing to start.
  const result = resolveCopilotEnsureOptions({
    HOME: home,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
  });
  assert.equal(result.copilotBin, binary);
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

test("resolver finds the newest installed Codex app MCP plugin", (t) => {
  const home = mkdtempSync(join(tmpdir(), "autodev-codex-app-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(
    home,
    ".codex",
    "plugins",
    "cache",
    "openai-bundled",
    "codex-app-tools"
  );
  const old = join(root, "0.1.4");
  const current = join(root, "26.1029.61003");
  for (const version of [old, current]) {
    mkdirSync(join(version, "scripts"), { recursive: true });
    writeFileSync(join(version, "server.mjs"), "", "utf8");
    const launcher = join(version, "scripts", "launch_codex_app_tools_mcp");
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    chmodSync(launcher, 0o755);
  }
  assert.deepEqual(findCodexAppMcpServer({ HOME: home }, home), {
    command: join(current, "scripts", "launch_codex_app_tools_mcp"),
    args: ["./server.mjs"],
    cwd: current
  });
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
    options({ copilotBin: null }),
    deps()
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
