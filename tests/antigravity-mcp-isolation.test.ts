import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import test from "node:test";

import {
  agyArgs,
  agyEnvironment,
  buildInvocationMcpConfig,
  createIsolatedAntigravityHome
} from "@simulatorlife/autodev-runtime/providers/antigravity";
import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";

const REPO_ROOT = pathResolve(import.meta.dirname, "..");

function runSubprocess(
  code: string,
  extraEnv: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const fixture = createFixtureEnvironment();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...extraEnv,
        HOME: fixture.userHome,
        CODEX_HOME: fixture.codexHome
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (error) => {
      fixture.cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      fixture.cleanup();
      resolve({ stdout, stderr, exitCode });
    });
  });
}

function createFixtureEnvironment(): {
  root: string;
  codexHome: string;
  userHome: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "autodev-agy-mcp-test-"));
  const codexHome = join(root, "codex");
  const userHome = join(root, "user-home");

  // Create provider-runtime catalog
  const runtimeDir = join(codexHome, "provider-runtime");
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const catalog = {
    lsp: {
      command: "bash",
      args: ["-lc", "exec run-autodev-mcp.sh lsp"]
    },
    "cocoindex-code": {
      command: "bash",
      args: ["-lc", "exec run-autodev-mcp.sh cocoindex-code"]
    },
    codegraphcontext: {
      command: "bash",
      args: ["-lc", "exec run-autodev-mcp.sh codegraphcontext"]
    },
    openaiDeveloperDocs: {
      url: "https://developers.openai.com/mcp"
    },
    context7: {
      url: "https://mcp.context7.com/mcp",
      bearer_token_env_var: "CONTEXT7_API_KEY",
      http_headers: { "X-Test": "placeholder" }
    },
    codex_app: {
      command: "node",
      args: ["./server.mjs"]
    },
    playwright: {
      command: "bash",
      args: ["-lc", "exec run-autodev-mcp.sh playwright"]
    }
  };
  writeFileSync(
    join(runtimeDir, "mcp-servers.json"),
    JSON.stringify(catalog, null, 2),
    { mode: 0o600 }
  );

  // Create user's .gemini with stale/global MCP servers and custom settings
  const userGemini = join(userHome, ".gemini");
  const userConfigDir = join(userGemini, "config");
  const userCliDir = join(userGemini, "antigravity-cli");
  const userBrowserProfile = join(userGemini, "antigravity-browser-profile");
  mkdirSync(userConfigDir, { recursive: true, mode: 0o700 });
  mkdirSync(userCliDir, { recursive: true, mode: 0o700 });
  mkdirSync(userBrowserProfile, { recursive: true, mode: 0o700 });

  // Stale/user-global MCP config containing extra servers
  const staleGlobalMcp = {
    mcpServers: {
      stale_global_server: {
        command: "echo",
        args: ["stale"]
      },
      unauthorized_leaf_tool: {
        command: "echo",
        args: ["unauthorized"]
      }
    }
  };
  writeFileSync(
    join(userConfigDir, "mcp_config.json"),
    JSON.stringify(staleGlobalMcp, null, 2),
    { mode: 0o600 }
  );
  writeFileSync(
    join(userConfigDir, "config.json"),
    JSON.stringify({ auth: "user-token" }, null, 2),
    { mode: 0o600 }
  );

  // User settings with non-MCP permissions and deny rules
  const userSettings = {
    permissions: {
      allow: [
        "mcp(stale_global_server)",
        "mcp(stale_global_server/*)",
        "read_file(/Users/henrykirk/AutoDev/**)",
        "unsandboxed(pnpm test)",
        "read_url(*)"
      ],
      deny: ["run_command(ccc *)", "mcp(playwright/browser_drag)"]
    },
    theme: "dark"
  };
  writeFileSync(
    join(userCliDir, "settings.json"),
    JSON.stringify(userSettings, null, 2),
    { mode: 0o600 }
  );
  writeFileSync(
    join(userCliDir, "antigravity-oauth-token"),
    "mock-oauth-token",
    { mode: 0o600 }
  );
  writeFileSync(
    join(userBrowserProfile, "profile.dat"),
    "mock-browser-profile",
    { mode: 0o600 }
  );

  return {
    root,
    codexHome,
    userHome,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

test("browser-tester receives Playwright only, with exactly its declared browser tools allowed", () => {
  const env = createFixtureEnvironment();
  try {
    const { mcpConfig, settings, cleanup } = createIsolatedAntigravityHome(
      "browser-tester",
      null,
      {
        originalHome: env.userHome,
        codexHome: env.codexHome,
        cwd: REPO_ROOT
      }
    );
    try {
      // 1. mcp_config.json has Playwright only
      assert.deepEqual(Object.keys(mcpConfig.mcpServers), ["playwright"]);
      const playwrightServer = mcpConfig.mcpServers.playwright;
      assert.equal(playwrightServer.command, process.execPath);
      assert.equal(
        playwrightServer.args[0],
        pathResolve(REPO_ROOT, "runtime/src/mcp/tool-filter.ts")
      );
      assert.equal(playwrightServer.args[1], "bash");
      assert.deepEqual(
        JSON.parse(playwrightServer.args[3]),
        (roleContract("browser-tester").mcpTools as Record<string, string[]>)
          .playwright
      );

      // 2. Playwright cannot see autodev_spawn or global/stale servers
      assert.equal(mcpConfig.mcpServers.autodev_spawn, undefined);
      assert.equal(mcpConfig.mcpServers.stale_global_server, undefined);

      // 3. settings.json permissions.allow has exactly the declared playwright tools
      const contract = roleContract("browser-tester") as {
        mcpTools?: Record<string, string[]>;
      };
      const declaredTools = contract.mcpTools?.playwright ?? [];
      assert.ok(declaredTools.length > 0);

      const allowList = settings.permissions?.allow as string[];
      const playwrightAllows = allowList.filter((entry) =>
        entry.startsWith("mcp(playwright")
      );
      assert.equal(playwrightAllows.length, declaredTools.length);
      for (const tool of declaredTools) {
        assert.ok(
          playwrightAllows.includes(`mcp(playwright/${tool})`),
          `missing grant for mcp(playwright/${tool})`
        );
      }

      // No broad grants like mcp(playwright) or mcp(playwright/*)
      assert.ok(!allowList.includes("mcp(playwright)"));
      assert.ok(!allowList.includes("mcp(playwright/*)"));

      // Scoped permissions for read-only role: explicit workspace read_file, no unsandboxed commands
      assert.ok(allowList.includes("read_file(/Users/henrykirk/AutoDev)"));
      assert.ok(allowList.includes("read_file(/Users/henrykirk/AutoDev/**)"));
      assert.ok(!allowList.includes("unsandboxed(pnpm test)"));
      assert.ok(allowList.includes("read_url(*)"));

      // Old broad MCP permissions removed
      assert.ok(!allowList.includes("mcp(stale_global_server)"));
      assert.ok(!allowList.includes("mcp(stale_global_server/*)"));

      // Existing user deny rules still win
      const denyList = settings.permissions?.deny as string[];
      assert.ok(denyList.includes("run_command(ccc *)"));
      assert.ok(denyList.includes("mcp(playwright/browser_drag)"));
    } finally {
      cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("remote MCP authentication launch settings survive catalog conversion", () => {
  const env = createFixtureEnvironment();
  try {
    const config = buildInvocationMcpConfig("docs-researcher", null, {
      originalHome: env.userHome,
      codexHome: env.codexHome
    });
    assert.deepEqual(Object.keys(config.mcpServers).sort(), [
      "context7",
      "openaiDeveloperDocs"
    ]);
    assert.deepEqual(config.mcpServers.context7, {
      serverUrl: "https://mcp.context7.com/mcp",
      bearer_token_env_var: "CONTEXT7_API_KEY",
      headers: { "X-Test": "placeholder" }
    });
  } finally {
    env.cleanup();
  }
});

test("remote MCP config keeps environment-backed and custom HTTP authentication", () => {
  const env = createFixtureEnvironment();
  try {
    const config = buildInvocationMcpConfig("docs-researcher", null, {
      originalHome: env.userHome,
      codexHome: env.codexHome
    });
    assert.deepEqual(config.mcpServers.context7, {
      serverUrl: "https://mcp.context7.com/mcp",
      bearer_token_env_var: "CONTEXT7_API_KEY",
      headers: { "X-Test": "placeholder" }
    });
    assert.deepEqual(config.mcpServers.openaiDeveloperDocs, {
      serverUrl: "https://developers.openai.com/mcp"
    });
  } finally {
    env.cleanup();
  }
});

test("ordinary leaf roles cannot see or use Playwright or autodev_spawn", () => {
  const env = createFixtureEnvironment();
  try {
    for (const role of ["default", "explorer", "validator"]) {
      const { mcpConfig, settings, cleanup } = createIsolatedAntigravityHome(
        role,
        "some-spawn-session",
        {
          originalHome: env.userHome,
          codexHome: env.codexHome,
          cwd: REPO_ROOT
        }
      );
      try {
        const servers = Object.keys(mcpConfig.mcpServers);
        assert.ok(
          !servers.includes("playwright"),
          `${role} must not receive playwright`
        );
        assert.ok(
          !servers.includes("autodev_spawn"),
          `${role} must never receive autodev_spawn`
        );

        const allowList = settings.permissions?.allow as string[];
        assert.ok(
          !allowList.some((entry) => entry.startsWith("mcp(playwright")),
          `${role} must not receive playwright permission grants`
        );
        assert.ok(
          !allowList.some((entry) => entry.startsWith("mcp(autodev_spawn")),
          `${role} must not receive autodev_spawn permission grants`
        );
      } finally {
        cleanup();
      }
    }
  } finally {
    env.cleanup();
  }
});

test("orchestrator gets only its declared MCPs and authenticated spawn shim", () => {
  const env = createFixtureEnvironment();
  try {
    // With authorized spawn session
    const withSession = createIsolatedAntigravityHome(
      "orchestrator",
      "session-123",
      {
        originalHome: env.userHome,
        codexHome: env.codexHome,
        cwd: REPO_ROOT
      }
    );
    try {
      const servers = Object.keys(withSession.mcpConfig.mcpServers);
      assert.ok(servers.includes("autodev_spawn"));
      const spawnServer = withSession.mcpConfig.mcpServers.autodev_spawn;
      assert.equal(spawnServer.env, undefined);
      const inherited = agyEnvironment("session-123", withSession.isolatedHome);
      assert.equal(inherited.AUTODEV_SPAWN_SESSION, "session-123");
      assert.equal(
        inherited.AUTODEV_BRIDGE_TOKEN,
        process.env.LITELLM_API_KEY ?? ""
      );
      const serializedMcpConfig = JSON.stringify(withSession.mcpConfig);
      assert.equal(serializedMcpConfig.includes("session-123"), false);
      if (inherited.AUTODEV_BRIDGE_TOKEN)
        assert.equal(
          serializedMcpConfig.includes(inherited.AUTODEV_BRIDGE_TOKEN),
          false
        );
      assert.ok(servers.includes("lsp"));
      assert.ok(servers.includes("cocoindex-code"));
      assert.ok(servers.includes("codegraphcontext"));
      assert.ok(servers.includes("codex_app"));
      assert.ok(!servers.includes("playwright"));
      assert.ok(!servers.includes("stale_global_server"));

      const allowList = withSession.settings.permissions?.allow as string[];
      assert.ok(allowList.includes("mcp(autodev_spawn)"));
      assert.ok(allowList.includes("mcp(lsp)"));
      assert.ok(allowList.includes("mcp(cocoindex-code)"));
      // codegraphcontext has mcpTools in execution contract -> per-tool grants only
      assert.ok(!allowList.includes("mcp(codegraphcontext)"));
      assert.ok(
        allowList.includes("mcp(codegraphcontext/list_indexed_repositories)")
      );
    } finally {
      withSession.cleanup();
    }

    // Without spawn session: autodev_spawn is NOT included
    const withoutSession = createIsolatedAntigravityHome("orchestrator", null, {
      originalHome: env.userHome,
      codexHome: env.codexHome
    });
    try {
      const servers = Object.keys(withoutSession.mcpConfig.mcpServers);
      assert.ok(
        !servers.includes("autodev_spawn"),
        "orchestrator without spawn session must not receive autodev_spawn"
      );
      const allowList = withoutSession.settings.permissions?.allow as string[];
      assert.ok(!allowList.includes("mcp(autodev_spawn)"));
    } finally {
      withoutSession.cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("children cannot inherit stale or user-global MCP servers", () => {
  const env = createFixtureEnvironment();
  try {
    const { mcpConfig, cleanup } = createIsolatedAntigravityHome(
      "default",
      null,
      {
        originalHome: env.userHome,
        codexHome: env.codexHome
      }
    );
    try {
      const servers = Object.keys(mcpConfig.mcpServers);
      assert.ok(!servers.includes("stale_global_server"));
      assert.ok(!servers.includes("unauthorized_leaf_tool"));
    } finally {
      cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("preserves non-MCP data by symlinking and enforces restrictive permissions", () => {
  const env = createFixtureEnvironment();
  const sourceMcpPath = join(
    env.userHome,
    ".gemini",
    "config",
    "mcp_config.json"
  );
  const sourceSettingsPath = join(
    env.userHome,
    ".gemini",
    "antigravity-cli",
    "settings.json"
  );
  const originalMcpConfig = readFileSync(sourceMcpPath);
  const originalSettings = readFileSync(sourceSettingsPath);
  try {
    const { isolatedHome, cleanup } = createIsolatedAntigravityHome(
      "browser-tester",
      null,
      {
        originalHome: env.userHome,
        codexHome: env.codexHome,
        cwd: REPO_ROOT
      }
    );
    try {
      // Directory permissions: 0o700
      const dirStat = statSync(isolatedHome);
      assert.equal(dirStat.mode & 0o777, 0o700);

      // File permissions: 0o600
      const mcpStat = statSync(
        join(isolatedHome, ".gemini", "config", "mcp_config.json")
      );
      assert.equal(mcpStat.mode & 0o777, 0o600);
      const settingsStat = statSync(
        join(isolatedHome, ".gemini", "antigravity-cli", "settings.json")
      );
      assert.equal(settingsStat.mode & 0o777, 0o600);

      // Non-MCP files carried through via symlinks
      const oauthPath = join(
        isolatedHome,
        ".gemini",
        "antigravity-cli",
        "antigravity-oauth-token"
      );
      assert.ok(existsSync(oauthPath));
      assert.equal(readFileSync(oauthPath, "utf8"), "mock-oauth-token");

      const configPath = join(isolatedHome, ".gemini", "config", "config.json");
      assert.ok(existsSync(configPath));
      assert.equal(
        JSON.parse(readFileSync(configPath, "utf8")).auth,
        "user-token"
      );

      const browserProfilePath = join(
        isolatedHome,
        ".gemini",
        "antigravity-browser-profile",
        "profile.dat"
      );
      assert.ok(existsSync(browserProfilePath));
      assert.equal(
        readFileSync(browserProfilePath, "utf8"),
        "mock-browser-profile"
      );
    } finally {
      cleanup();
    }
    assert.deepEqual(readFileSync(sourceMcpPath), originalMcpConfig);
    assert.deepEqual(readFileSync(sourceSettingsPath), originalSettings);
  } finally {
    env.cleanup();
  }
});

test("fails closed when required role MCP is missing from catalog", () => {
  const env = createFixtureEnvironment();
  try {
    const catalogPath = join(
      env.codexHome,
      "provider-runtime",
      "mcp-servers.json"
    );
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    delete catalog.playwright;
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));

    assert.throws(
      () =>
        createIsolatedAntigravityHome("browser-tester", null, {
          originalHome: env.userHome,
          codexHome: env.codexHome
        }),
      /MCP server playwright granted to role browser-tester is not in the bridge MCP catalogue/
    );
  } finally {
    env.cleanup();
  }
});

test("fails closed when catalogue file is missing or invalid", () => {
  const env = createFixtureEnvironment();
  try {
    const catalogPath = join(
      env.codexHome,
      "provider-runtime",
      "mcp-servers.json"
    );
    writeFileSync(catalogPath, "not-json");

    assert.throws(
      () =>
        createIsolatedAntigravityHome("default", null, {
          originalHome: env.userHome,
          codexHome: env.codexHome
        }),
      /bridge MCP catalogue is missing or invalid/
    );
  } finally {
    env.cleanup();
  }
});

test("invalid user settings fail closed instead of dropping explicit permissions", () => {
  const env = createFixtureEnvironment();
  try {
    writeFileSync(
      join(env.userHome, ".gemini", "antigravity-cli", "settings.json"),
      "not-json"
    );
    assert.throws(
      () =>
        createIsolatedAntigravityHome("browser-tester", null, {
          originalHome: env.userHome,
          codexHome: env.codexHome
        }),
      /Antigravity settings are invalid.*refusing to drop user permissions/
    );
  } finally {
    env.cleanup();
  }
});

test("isolated HOME is cleaned after successful CLI completion", async () => {
  const temp = mkdtempSync(join(tmpdir(), "autodev-fake-agy-success-"));
  const fakeAgy = join(temp, "fake-agy.mjs");
  const sentinelFile = join(temp, "sentinel-home.txt");

  writeFileSync(
    fakeAgy,
    String.raw`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.SENTINEL_FILE) {
  writeFileSync(process.env.SENTINEL_FILE, process.env.HOME || "");
}
process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "hello" } }) + "\n");
process.exit(0);
`,
    { mode: 0o755 }
  );

  const runnerCode = `
import { runAgy } from "@simulatorlife/autodev-runtime/providers/antigravity";
import assert from "node:assert/strict";

const res = await runAgy("test prompt", "gemini-3.8-flash-medium", "medium", process.cwd(), null, null, "default");
assert.equal(res.text, "hello");
`;

  try {
    const { stdout, stderr, exitCode } = await runSubprocess(runnerCode, {
      AGY_CLI_PATH: fakeAgy,
      SENTINEL_FILE: sentinelFile
    });
    assert.equal(exitCode, 0, `runner failed:\n${stderr}\n${stdout}`);

    assert.ok(
      existsSync(sentinelFile),
      "fake CLI must have run and recorded HOME"
    );
    const capturedHome = readFileSync(sentinelFile, "utf8").trim();
    assert.ok(capturedHome.length > 0, "recorded HOME must not be empty");
    assert.ok(
      capturedHome.includes("autodev-agy-home-"),
      "recorded HOME must be isolated temp home"
    );
    assert.ok(
      !existsSync(capturedHome),
      "isolated temp home must be deleted after success"
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("isolated HOME is cleaned after CLI failure", async () => {
  const temp = mkdtempSync(join(tmpdir(), "autodev-fake-agy-fail-"));
  const fakeAgy = join(temp, "fake-agy.mjs");
  const sentinelFile = join(temp, "sentinel-home.txt");

  writeFileSync(
    fakeAgy,
    String.raw`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.env.SENTINEL_FILE) {
  writeFileSync(process.env.SENTINEL_FILE, process.env.HOME || "");
}
process.stderr.write("CLI simulated error\n");
process.exit(1);
`,
    { mode: 0o755 }
  );

  const runnerCode = `
import { runAgy } from "@simulatorlife/autodev-runtime/providers/antigravity";
import assert from "node:assert/strict";

try {
  await runAgy("test prompt", "gemini-3.8-flash-medium", "medium", process.cwd(), null, null, "default");
  process.exit(2);
} catch (err) {
  if (err.message.includes("CLI simulated error")) {
    process.exit(0);
  }
  console.error("Unexpected error:", err);
  process.exit(3);
}
`;

  try {
    const { stdout, stderr, exitCode } = await runSubprocess(runnerCode, {
      AGY_CLI_PATH: fakeAgy,
      SENTINEL_FILE: sentinelFile
    });
    assert.equal(exitCode, 0, `runner failed:\n${stderr}\n${stdout}`);

    assert.ok(
      existsSync(sentinelFile),
      "fake CLI must have run and recorded HOME"
    );
    const capturedHome = readFileSync(sentinelFile, "utf8").trim();
    assert.ok(capturedHome.length > 0, "recorded HOME must not be empty");
    assert.ok(
      capturedHome.includes("autodev-agy-home-"),
      "recorded HOME must be isolated temp home"
    );
    assert.ok(
      !existsSync(capturedHome),
      "isolated temp home must be deleted after CLI failure"
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("isolated HOME is cleaned after failed spawn", async () => {
  const temp = mkdtempSync(join(tmpdir(), "autodev-fake-agy-spawnfail-"));
  const nonExistentAgy = join(temp, "does-not-exist-agy");

  const runnerCode = `
import { runAgy } from "@simulatorlife/autodev-runtime/providers/antigravity";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const beforeHomes = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("autodev-agy-home-"));

try {
  await runAgy("test prompt", "gemini-3.8-flash-medium", "medium", process.cwd(), null, null, "default");
  process.exit(2);
} catch (err) {
  if (err.code === "ENOENT" || err.message.includes("ENOENT")) {
    const afterHomes = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("autodev-agy-home-"));
    const leaked = afterHomes.filter(h => !beforeHomes.includes(h));
    if (leaked.length > 0) {
      console.error("Leaked temp homes:", leaked);
      process.exit(4);
    }
    process.exit(0);
  }
  console.error("Unexpected error:", err);
  process.exit(3);
}
`;

  try {
    const { stdout, stderr, exitCode } = await runSubprocess(runnerCode, {
      AGY_CLI_PATH: nonExistentAgy,
      TMPDIR: temp
    });
    assert.equal(exitCode, 0, `runner failed:\n${stderr}\n${stdout}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("browser-tester role is accepted and receives Playwright-only isolated HOME in invocation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "autodev-fake-agy-bt-"));
  const fakeAgy = join(temp, "fake-agy.mjs");
  const sentinelFile = join(temp, "sentinel-home.txt");

  writeFileSync(
    fakeAgy,
    String.raw`#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";

if (process.env.SENTINEL_FILE) {
  writeFileSync(process.env.SENTINEL_FILE, process.env.HOME || "");
}

const home = process.env.HOME;
const mcpConfig = JSON.parse(readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8"));
const settings = JSON.parse(readFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
const workspace = process.cwd();
const readAllows = settings.permissions.allow.filter(entry => entry.startsWith("read_file("));
assert.ok(readAllows.includes("read_file(" + workspace + ")"));
assert.ok(readAllows.includes("read_file(" + workspace + "/**)"));
assert.ok(readAllows.some(entry => entry.includes(".agents")));
assert.ok(readAllows.some(entry => entry.includes("codex")));
assert.equal(readAllows.length, 6);

const servers = Object.keys(mcpConfig.mcpServers || {});
const playwrightAllows = (settings.permissions?.allow || []).filter(e => e.startsWith("mcp(playwright"));

const responsePayload = JSON.stringify({
  servers,
  playwrightAllowsCount: playwrightAllows.length,
  hasBroadPlaywright: (settings.permissions?.allow || []).includes("mcp(playwright)"),
  hasAutodevSpawn: servers.includes("autodev_spawn")
});

process.stdout.write(JSON.stringify({
  event: "result",
  result: {
    status: "SUCCESS",
    response: responsePayload
  }
}) + "\n");
process.exit(0);
`,
    { mode: 0o755 }
  );

  const runnerCode = `
import { runAgy } from "@simulatorlife/autodev-runtime/providers/antigravity";
import assert from "node:assert/strict";

const res = await runAgy(
  "test browser",
  "gemini-3.8-flash-medium",
  "medium",
  process.cwd(),
  null,
  null,
  "browser-tester"
);
const parsed = JSON.parse(res.text);
assert.deepEqual(parsed.servers, ["playwright"]);
assert.equal(parsed.hasAutodevSpawn, false);
assert.equal(parsed.hasBroadPlaywright, false);
assert.equal(parsed.playwrightAllowsCount, 18);
`;

  try {
    const { stdout, stderr, exitCode } = await runSubprocess(runnerCode, {
      AGY_CLI_PATH: fakeAgy,
      SENTINEL_FILE: sentinelFile
    });
    assert.equal(exitCode, 0, `runner failed:\n${stderr}\n${stdout}`);

    assert.ok(
      existsSync(sentinelFile),
      "fake CLI must have run and recorded HOME"
    );
    const capturedHome = readFileSync(sentinelFile, "utf8").trim();
    assert.ok(capturedHome.length > 0);
    assert.ok(
      !existsSync(capturedHome),
      "browser-tester isolated temp home must be cleaned up"
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("browser-tester enforces read-only sandbox mode without permission bypass", () => {
  const args = agyArgs(
    "test prompt",
    "gemini-3.8-flash-medium",
    "medium",
    "browser-tester"
  );
  assert.ok(
    args.includes("--sandbox"),
    "browser-tester must receive --sandbox"
  );
  assert.ok(
    !args.includes("--dangerously-skip-permissions"),
    "browser-tester must never receive --dangerously-skip-permissions"
  );
});

test("proxy server accepts browser-tester request and does not reject with 400", async () => {
  const temp = mkdtempSync(join(tmpdir(), "autodev-proxy-test-"));
  const fakeAgy = join(temp, "fake-agy.mjs");
  writeFileSync(
    fakeAgy,
    String.raw`#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  event: "result",
  result: { status: "SUCCESS", response: "browser-test-complete" }
}) + "\n");
process.exit(0);
`,
    { mode: 0o755 }
  );

  const runnerCode = `
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const proxyPort = 45991;
const proxy = spawn(process.execPath, ["runtime/src/providers/antigravity.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AGY_PROXY_PORT: String(proxyPort),
    AGY_CLI_PATH: process.env.FAKE_AGY,
    LITELLM_API_KEY: ""
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
proxy.stderr.on("data", d => { stderr += d; });

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Proxy start timeout: " + stderr)), 10000);
  proxy.stderr.on("data", d => {
    if (d.toString().includes("Antigravity Responses proxy listening")) {
      clearTimeout(timer);
      resolve();
    }
  });
});

try {
  const res = await fetch("http://127.0.0.1:" + proxyPort + "/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-autodev-agent-role": "browser-tester"
    },
    body: JSON.stringify({
      cwd: process.cwd(),
      input: "test browser task",
      model: "gemini-3.8-flash-medium",
      stream: false
    })
  });

  const body = await res.json();
  assert.equal(res.status, 200, "status should be 200, got: " + res.status + " body: " + JSON.stringify(body));
  assert.ok(body.output?.[0]?.content?.[0]?.text?.includes("browser-test-complete"));
} finally {
  proxy.kill("SIGTERM");
}
`;

  try {
    const { stdout, stderr, exitCode } = await runSubprocess(runnerCode, {
      FAKE_AGY: fakeAgy
    });
    assert.equal(exitCode, 0, `proxy runner failed:\n${stderr}\n${stdout}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("read-only Antigravity permission scope limits read_file to validated workspace and preserves explicit deny rules", () => {
  const env = createFixtureEnvironment();
  const targetWorkspace = join(env.root, "target-workspace");
  mkdirSync(targetWorkspace, { recursive: true, mode: 0o700 });

  // Update user settings to include broad access, commands, writes, unsandboxed, and explicit deny rules
  const userSettingsPath = join(
    env.userHome,
    ".gemini",
    "antigravity-cli",
    "settings.json"
  );
  const richUserSettings = {
    permissions: {
      allow: [
        "mcp(stale_global_server)",
        "mcp(stale_global_server/*)",
        "read_file(**)",
        "read_file(/Users/other/secret/**)",
        `read_file(${targetWorkspace}/**)`,
        "unsandboxed(pnpm test)",
        "unsandboxed(*)",
        "command(*)",
        "run_command(npm run build)",
        "write_file(/Users/other/secret/write.txt)",
        "edit_file(/Users/other/secret/edit.txt)",
        "read_url(*)"
      ],
      deny: [
        "run_command(ccc *)",
        "mcp(playwright/browser_drag)",
        `read_file(${join(targetWorkspace, "denied-secret.key")})`
      ]
    },
    theme: "dark"
  };
  writeFileSync(userSettingsPath, JSON.stringify(richUserSettings, null, 2), {
    mode: 0o600
  });
  const originalUserSettingsContent = readFileSync(userSettingsPath, "utf8");

  try {
    const { settings, cleanup } = createIsolatedAntigravityHome(
      "browser-tester",
      null,
      {
        originalHome: env.userHome,
        codexHome: env.codexHome,
        cwd: targetWorkspace
      }
    );
    try {
      const allowList = settings.permissions?.allow as string[];
      const denyList = settings.permissions?.deny as string[];

      // 1. Explicit read_file authorization limited to validated request workspace and shared agent/codex roots
      assert.ok(
        allowList.includes(`read_file(${targetWorkspace})`),
        "workspace root must be granted"
      );
      assert.ok(
        allowList.includes(`read_file(${targetWorkspace}/**)`),
        "workspace recursive files must be granted"
      );
      assert.ok(
        allowList.includes(`read_file(${join(env.userHome, ".agents")})`),
        "shared .agents root must be granted"
      );
      assert.ok(
        allowList.includes(`read_file(${join(env.userHome, ".agents")}/**)`),
        "shared .agents recursive files must be granted"
      );
      assert.ok(
        allowList.includes(`read_file(${env.codexHome})`),
        "shared .codex root must be granted"
      );
      assert.ok(
        allowList.includes(`read_file(${join(env.codexHome, "**")})`),
        "shared .codex recursive files must be granted"
      );

      // 2. Paths outside selected workspace and shared roots, plus broad access, are NOT granted
      assert.ok(
        !allowList.includes("read_file(**)"),
        "broad read_file(**) must not be granted"
      );
      assert.ok(
        !allowList.includes("read_file(/Users/other/secret/**)"),
        "paths outside workspace must not be granted"
      );
      assert.ok(
        !allowList.some(
          (entry) =>
            typeof entry === "string" &&
            entry.startsWith("read_file(") &&
            !entry.includes(targetWorkspace) &&
            !entry.includes(join(env.userHome, ".agents")) &&
            !entry.includes(env.codexHome)
        ),
        "no read_file grants outside selected workspace and shared agent roots"
      );

      // 3. Command, write, and unsandboxed permissions are NOT granted
      assert.ok(
        !allowList.includes("command(*)"),
        "command(*) must not be granted"
      );
      assert.ok(
        !allowList.includes("run_command(npm run build)"),
        "run_command must not be granted"
      );
      assert.ok(
        !allowList.includes("unsandboxed(pnpm test)"),
        "unsandboxed(pnpm test) must not be granted"
      );
      assert.ok(
        !allowList.includes("unsandboxed(*)"),
        "unsandboxed(*) must not be granted"
      );
      assert.ok(
        !allowList.some(
          (entry) =>
            typeof entry === "string" &&
            (entry.startsWith("write_") || entry.startsWith("edit_"))
        ),
        "write/edit permissions must not be granted"
      );

      // Safe non-command / non-file permission is preserved
      assert.ok(
        allowList.includes("read_url(*)"),
        "read_url(*) should be preserved"
      );

      // The only read_file rules are the exact and recursive selected-root and shared agent/codex grants.
      assert.deepEqual(
        allowList.filter((entry) => entry.startsWith("read_file(")),
        [
          `read_file(${targetWorkspace})`,
          `read_file(${targetWorkspace}/**)`,
          `read_file(${join(env.userHome, ".agents")})`,
          `read_file(${join(env.userHome, ".agents")}/**)`,
          `read_file(${env.codexHome})`,
          `read_file(${join(env.codexHome, "**")})`
        ]
      );

      // 5. Explicit denies remain intact and take precedence
      assert.ok(
        denyList.includes("run_command(ccc *)"),
        "run_command deny rule must remain"
      );
      assert.ok(
        denyList.includes("mcp(playwright/browser_drag)"),
        "mcp deny rule must remain"
      );
      assert.ok(
        denyList.includes(
          `read_file(${join(targetWorkspace, "denied-secret.key")})`
        ),
        "explicit read_file deny rule must remain"
      );
      assert.deepEqual(
        denyList.filter((entry) => entry.startsWith("read_file(")),
        [`read_file(${join(targetWorkspace, "denied-secret.key")})`]
      );

      // 6. User's global settings are NOT mutated
      assert.equal(
        readFileSync(userSettingsPath, "utf8"),
        originalUserSettingsContent,
        "user global settings must not be mutated"
      );

      // 7. Read-only arguments still include --sandbox without permission bypass
      const args = agyArgs(
        "test prompt",
        "gemini-3.8-flash-medium",
        "medium",
        "browser-tester"
      );
      assert.ok(
        args.includes("--sandbox"),
        "browser-tester must receive --sandbox"
      );
      assert.ok(
        !args.includes("--dangerously-skip-permissions"),
        "browser-tester must not receive --dangerously-skip-permissions"
      );

      const explicitReadOnlyArgs = agyArgs(
        "test prompt",
        "gemini-3.8-flash-medium",
        "medium",
        "default",
        "read-only"
      );
      assert.ok(
        explicitReadOnlyArgs.includes("--sandbox"),
        "explicit read-only sandbox mode must receive --sandbox"
      );
      assert.ok(
        !explicitReadOnlyArgs.includes("--dangerously-skip-permissions"),
        "explicit read-only sandbox mode must not receive --dangerously-skip-permissions"
      );
    } finally {
      cleanup();
    }
  } finally {
    env.cleanup();
  }
});

test("read-only Antigravity invocation fails closed without a validated workspace", () => {
  const env = createFixtureEnvironment();
  try {
    assert.throws(
      () =>
        createIsolatedAntigravityHome("browser-tester", null, {
          originalHome: env.userHome,
          codexHome: env.codexHome
        }),
      /requires a validated absolute workspace/
    );
  } finally {
    env.cleanup();
  }
});

test("write-capable roles preserve user non-MCP permissions and keep --dangerously-skip-permissions", () => {
  const env = createFixtureEnvironment();
  const targetWorkspace = join(env.root, "target-workspace");
  mkdirSync(targetWorkspace, { recursive: true, mode: 0o700 });

  const userSettingsPath = join(
    env.userHome,
    ".gemini",
    "antigravity-cli",
    "settings.json"
  );
  const richUserSettings = {
    permissions: {
      allow: [
        "mcp(stale_global_server)",
        "read_file(**)",
        "unsandboxed(pnpm test)",
        "command(*)",
        "run_command(npm run build)",
        "write_file(/Users/other/secret/write.txt)",
        "read_url(*)"
      ],
      deny: ["run_command(ccc *)"]
    },
    theme: "dark"
  };
  writeFileSync(userSettingsPath, JSON.stringify(richUserSettings, null, 2), {
    mode: 0o600
  });

  try {
    const { settings, cleanup } = createIsolatedAntigravityHome(
      "default",
      null,
      {
        originalHome: env.userHome,
        codexHome: env.codexHome,
        cwd: targetWorkspace
      }
    );
    try {
      const allowList = settings.permissions?.allow as string[];

      // Write-capable role keeps non-MCP permissions untouched
      assert.ok(allowList.includes("read_file(**)"));
      assert.ok(allowList.includes("unsandboxed(pnpm test)"));
      assert.ok(allowList.includes("command(*)"));
      assert.ok(allowList.includes("run_command(npm run build)"));
      assert.ok(
        allowList.includes("write_file(/Users/other/secret/write.txt)")
      );
      assert.ok(allowList.includes("read_url(*)"));

      // Stale global MCP removed and contract MCP added (granular per-tool grants)
      assert.ok(!allowList.includes("mcp(stale_global_server)"));
      assert.ok(allowList.includes("mcp(lsp/lsp_find_symbol)"));
      assert.ok(!allowList.includes("mcp(lsp)"));

      // Write-capable role CLI args: includes --dangerously-skip-permissions, no --sandbox
      const args = agyArgs(
        "test prompt",
        "gemini-3.8-flash-medium",
        "medium",
        "default"
      );
      assert.ok(
        !args.includes("--sandbox"),
        "write-capable default role must not receive --sandbox"
      );
      assert.ok(
        args.includes("--dangerously-skip-permissions"),
        "write-capable default role must receive --dangerously-skip-permissions"
      );
    } finally {
      cleanup();
    }
  } finally {
    env.cleanup();
  }
});
