import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findStaleCodexPids } from "@simulatorlife/autodev-runtime/platform/install-check";
import { runInstallCommand } from "@simulatorlife/autodev-runtime/platform/install-command";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const installerScriptPath = path.join(repositoryRoot, "scripts", "install.sh");

test("typed install command rejects check mode until diagnostic ownership migrates", () => {
  assert.throws(
    () => runInstallCommand(["--check"]),
    /installer check boundary/
  );
});

test("typed install command rejects the removed Collector mode and the removed OpenLIT ingress flags", () => {
  assert.throws(
    () => runInstallCommand(["--enable-otel-collector"]),
    /unsupported install option/
  );
  assert.throws(
    () => runInstallCommand(["--disable-otel-collector"]),
    /unsupported install option/
  );
  // The ingress mode is gone: the agents export to OpenLIT and the portable
  // configuration says so, so there is nothing left to select.
  assert.throws(
    () => runInstallCommand(["--enable-openlit-ingress"]),
    /unsupported install option/
  );
  assert.throws(
    () => runInstallCommand(["--disable-openlit-ingress"]),
    /unsupported install option/
  );
});

test("typed install command rejects unknown options", () => {
  assert.throws(
    () => runInstallCommand(["--unknown"]),
    /unsupported install option/
  );
});

test("findStaleCodexPids ignores sandboxed child codex helpers under an authenticated root codex process", () => {
  const token = "current-token-123";
  const commands = new Map<string, string>([
    ["7487", `codex app-server CODEX_ROUTER_AUTH_TOKEN=${token} PATH=/usr/bin`],
    [
      "59372",
      "codex app-server --listen stdio:// CODEX_HOME=/Users/test/.codex PATH=/usr/bin"
    ]
  ]);
  const parents = new Map<string, string>([
    ["59372", "8181"],
    ["8181", "7487"],
    ["7487", "6395"],
    ["6395", "1"]
  ]);
  assert.deepEqual(
    findStaleCodexPids(token, {
      listCodexPids: () => ["7487", "59372"],
      readProcessCommandWithEnv: (pid) => commands.get(pid) ?? null,
      readParentPid: (pid) => parents.get(pid) ?? null,
      processExists: () => true
    }),
    []
  );
});

test("findStaleCodexPids reports root codex processes with a stale or missing token and ignores exited processes", () => {
  const token = "current-token-123";
  const commands = new Map<string, string>([
    ["1000", "codex app-server CODEX_ROUTER_AUTH_TOKEN=old-token PATH=/usr/bin"]
  ]);
  const parents = new Map<string, string>([["1000", "1"]]);
  assert.deepEqual(
    findStaleCodexPids(token, {
      listCodexPids: () => ["1000", "2000"],
      readProcessCommandWithEnv: (pid) => commands.get(pid) ?? null,
      readParentPid: (pid) => parents.get(pid) ?? null,
      processExists: (pid) => pid !== "2000"
    }),
    ["1000"]
  );
});

test("tunnel install flags cannot be combined with materialize-only or each other", () => {
  assert.throws(
    () => runInstallCommand(["--materialize-only", "--enable-chatgpt-tunnel"]),
    /requires a normal install/
  );
  assert.throws(
    () => runInstallCommand(["--materialize-only", "--disable-chatgpt-tunnel"]),
    /requires a normal install/
  );
  assert.throws(
    () =>
      runInstallCommand([
        "--enable-chatgpt-tunnel",
        "--disable-chatgpt-tunnel"
      ]),
    /Choose only one/
  );
});

function withInstallerFixture(
  run: (fixture: {
    repoRoot: string;
    envOutputFile: string;
    execInstall: (
      args?: readonly string[],
      extraEnv?: NodeJS.ProcessEnv
    ) => SpawnSyncReturns<string>;
  }) => void
): void {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "autodev-install-env-"))
  );
  const repoRoot = path.join(root, "repo");
  const scriptsDir = path.join(repoRoot, "scripts");
  const cliDir = path.join(repoRoot, "runtime", "src", "cli");
  const envOutputFile = path.join(root, "captured-env.json");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  copyFileSync(installerScriptPath, path.join(scriptsDir, "install.sh"));
  writeFileSync(
    path.join(cliDir, "install.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      "const keys = [",
      '  "AUTODEV_REPO_ROOT",',
      '  "CODEX_HOME",',
      '  "AUTODEV_CHATGPT_ORGANIZATION_ID",',
      '  "AUTODEV_CHATGPT_WORKSPACE_ID",',
      '  "CONTROL_PLANE_TUNNEL_ID",',
      '  "AUTODEV_CHATGPT_TUNNEL_API_KEY",',
      '  "OPENAI_ADMIN_KEY",',
      '  "AUTODEV_TEST_EMPTY_OVERRIDE"',
      "];",
      "const snapshot = Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]));",
      "writeFileSync(",
      `  ${JSON.stringify(envOutputFile)},`,
      "  JSON.stringify({ args: process.argv.slice(2), env: snapshot })",
      ");"
    ].join("\n")
  );
  try {
    const execInstall = (
      args: readonly string[] = [],
      extraEnv: NodeJS.ProcessEnv = {}
    ) => {
      const baseEnv: NodeJS.ProcessEnv = {
        HOME: root,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        ...extraEnv
      };
      return spawnSync("bash", [path.join(scriptsDir, "install.sh"), ...args], {
        cwd: root,
        env: baseEnv,
        encoding: "utf8"
      });
    };
    run({ repoRoot, envOutputFile, execInstall });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("scripts/install.sh loads repository-root .env via --env-file-if-exists and preserves explicit env precedence", () => {
  const installerScript = readFileSync(installerScriptPath, "utf8");
  assert.match(installerScript, /--env-file-if-exists="\$repo_root\/\.env"/);

  withInstallerFixture(({ repoRoot, envOutputFile, execInstall }) => {
    const envFile = path.join(repoRoot, ".env");
    writeFileSync(
      envFile,
      [
        `CODEX_HOME=${path.join(repoRoot, "dotenv-codex")}`,
        "AUTODEV_CHATGPT_ORGANIZATION_ID=org_from_dotenv",
        "AUTODEV_CHATGPT_WORKSPACE_ID=ws_from_dotenv",
        "CONTROL_PLANE_TUNNEL_ID=tunnel_from_dotenv",
        "AUTODEV_CHATGPT_TUNNEL_API_KEY=runtime_from_dotenv",
        "OPENAI_ADMIN_KEY=admin_from_dotenv",
        "AUTODEV_TEST_EMPTY_OVERRIDE=from_dotenv"
      ].join("\n") + "\n",
      { mode: 0o600 }
    );

    const fromDotenv = execInstall(["--enable-chatgpt-tunnel"]);
    assert.equal(fromDotenv.status, 0, fromDotenv.stderr);
    const loaded = JSON.parse(readFileSync(envOutputFile, "utf8")) as {
      args: string[];
      env: Record<string, string | null>;
    };
    assert.deepEqual(loaded.args, ["--enable-chatgpt-tunnel"]);
    assert.deepEqual(loaded.env, {
      AUTODEV_REPO_ROOT: repoRoot,
      CODEX_HOME: path.join(repoRoot, "dotenv-codex"),
      AUTODEV_CHATGPT_ORGANIZATION_ID: "org_from_dotenv",
      AUTODEV_CHATGPT_WORKSPACE_ID: "ws_from_dotenv",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_from_dotenv",
      AUTODEV_CHATGPT_TUNNEL_API_KEY: "runtime_from_dotenv",
      OPENAI_ADMIN_KEY: "admin_from_dotenv",
      AUTODEV_TEST_EMPTY_OVERRIDE: "from_dotenv"
    });

    const explicitCodexHome = path.join(repoRoot, "explicit-codex");
    const overridden = execInstall(["--check"], {
      CODEX_HOME: explicitCodexHome,
      AUTODEV_CHATGPT_ORGANIZATION_ID: "org_explicit",
      AUTODEV_CHATGPT_TUNNEL_API_KEY: "runtime_explicit",
      AUTODEV_TEST_EMPTY_OVERRIDE: ""
    });
    assert.equal(overridden.status, 0, overridden.stderr);
    const loadedOverride = JSON.parse(readFileSync(envOutputFile, "utf8")) as {
      args: string[];
      env: Record<string, string | null>;
    };
    assert.deepEqual(loadedOverride.args, ["--check"]);
    assert.deepEqual(loadedOverride.env, {
      AUTODEV_REPO_ROOT: repoRoot,
      CODEX_HOME: explicitCodexHome,
      AUTODEV_CHATGPT_ORGANIZATION_ID: "org_explicit",
      AUTODEV_CHATGPT_WORKSPACE_ID: "ws_from_dotenv",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_from_dotenv",
      AUTODEV_CHATGPT_TUNNEL_API_KEY: "runtime_explicit",
      OPENAI_ADMIN_KEY: "admin_from_dotenv",
      AUTODEV_TEST_EMPTY_OVERRIDE: ""
    });
  });
});

test("normal install checks required Keychain API keys without migrating or overwriting Keychain", () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "autodev-install-keychain-check-"))
  );
  const previousDisable = process.env.AUTODEV_DISABLE_KEYCHAIN;
  const previousMinimax = process.env.MINIMAX_API_KEY;
  const previousContext7 = process.env.CONTEXT7_API_KEY;
  const codexHome = path.join(root, ".codex");
  const envFile = path.join(codexHome, ".env");
  try {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      envFile,
      [
        "MINIMAX_API_KEY=minimax-from-dotenv",
        "CONTEXT7_API_KEY=context7-from-dotenv"
      ].join("\n") + "\n",
      { mode: 0o600 }
    );
    process.env.AUTODEV_DISABLE_KEYCHAIN = "0";
    process.env.MINIMAX_API_KEY = "minimax-from-env";
    process.env.CONTEXT7_API_KEY = "context7-from-env";
    const calls: string[][] = [];
    const keychainDeps = {
      platform: "darwin" as const,
      runSecurity: (args: readonly string[]) => {
        calls.push([...args]);
        if (args[0] !== "find-generic-password") {
          throw new Error(`Unexpected Keychain mutation: ${args.join(" ")}`);
        }
        const service = args[args.indexOf("-s") + 1];
        if (service === "MINIMAX_API_KEY") return "kc-minimax\n";
        throw new Error("not found");
      }
    };
    assert.throws(
      () =>
        runInstallCommand([], {
          repositoryRoot: path.resolve(path.dirname(installerScriptPath), ".."),
          home: root,
          codexHome,
          keychainDeps
        }),
      /Missing required API key\(s\) in macOS Keychain: CONTEXT7_API_KEY/
    );
    assert.ok(
      calls.every((args) => args[0] === "find-generic-password"),
      "install must only check Keychain presence, never write or update items"
    );
    assert.match(readFileSync(envFile, "utf8"), /MINIMAX_API_KEY=/);
    assert.match(readFileSync(envFile, "utf8"), /CONTEXT7_API_KEY=/);
  } finally {
    if (previousDisable === undefined)
      delete process.env.AUTODEV_DISABLE_KEYCHAIN;
    else process.env.AUTODEV_DISABLE_KEYCHAIN = previousDisable;
    if (previousMinimax === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = previousMinimax;
    if (previousContext7 === undefined) delete process.env.CONTEXT7_API_KEY;
    else process.env.CONTEXT7_API_KEY = previousContext7;
    rmSync(root, { recursive: true, force: true });
  }
});

test("scripts/install.sh continues cleanly when repository-root .env is absent", () => {
  withInstallerFixture(({ repoRoot, envOutputFile, execInstall }) => {
    const result = execInstall(["--materialize-only"]);
    assert.equal(result.status, 0, result.stderr);
    const loaded = JSON.parse(readFileSync(envOutputFile, "utf8")) as {
      args: string[];
      env: Record<string, string | null>;
    };
    assert.deepEqual(loaded.args, ["--materialize-only"]);
    assert.equal(loaded.env.AUTODEV_REPO_ROOT, repoRoot);
    assert.equal(loaded.env.CODEX_HOME, null);
  });
});
