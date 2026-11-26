import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findCocoindexProjectRoot,
  resolveCocoindexInitRoot,
  resolveMcpCommand,
  resolveMcpWorkspace,
  runMcp
} from "@simulatorlife/autodev-runtime/mcp";
import { MCP_SERVER_CODEGRAPHCONTEXT } from "@simulatorlife/autodev-runtime/shared/tool-names";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const mcpLauncherHook = join(repositoryRoot, "scripts", "run-autodev-mcp.sh");

/** A `ccc` stand-in whose `init` writes the project marker the real one writes. */
const MOCK_CCC_INIT =
  'if [ "$1" = "init" ]; then mkdir -p .cocoindex_code && touch .cocoindex_code/settings.yml; fi\n';

function createIsolatedTempDir(prefix: string): string {
  const candidates = Array.from(new Set(["/var/tmp", tmpdir()]));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const base = realpathSync(candidate);
    let current = resolve(base);
    let containsProject = false;
    for (;;) {
      if (existsSync(join(current, ".cocoindex_code"))) {
        containsProject = true;
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (!containsProject) {
      try {
        return mkdtempSync(join(base, prefix));
      } catch {
        continue;
      }
    }
  }
  throw new Error(
    "MCP launcher tests need a temporary directory outside initialized cocoindex-code projects"
  );
}

const RUNTIME_SOURCE = join(import.meta.dirname, "..", "..", "runtime", "src");
/** pnpm's virtual store: every package the Runtime's node_modules links to. */
const DEPENDENCY_STORE = realpathSync(
  join(import.meta.dirname, "..", "..", "node_modules", ".pnpm")
);

function isRuntimeDependency(file: string): boolean {
  return realpathSync(file).startsWith(`${DEPENDENCY_STORE}/`);
}

test("MCP launcher runs Node servers from the Runtime's own dependency tree with the current Node", () => {
  const lsp = resolveMcpCommand("lsp");
  assert.equal(lsp.binary, process.execPath);
  assert.equal(isRuntimeDependency(lsp.args[0]!), true);
  assert.deepEqual(lsp.pathPrepend, [
    join(import.meta.dirname, "..", "..", "runtime", "node_modules", ".bin"),
    dirname(process.execPath)
  ]);
  const playwright = resolveMcpCommand("playwright", {});
  assert.equal(playwright.binary, process.execPath);
  assert.equal(isRuntimeDependency(playwright.args[0]!), true);
  assert.deepEqual(playwright.args.slice(1), [
    "--headless",
    "--no-sandbox",
    "--isolated"
  ]);
  assert.deepEqual(
    resolveMcpCommand("playwright", { AUTODEV_PLAYWRIGHT_HEADED: "1" }).args.slice(1),
    ["--no-sandbox", "--isolated"]
  );
  for (const server of ["filesystem", "github"]) {
    const command = resolveMcpCommand(server, {});
    assert.equal(command.binary, process.execPath);
    assert.equal(isRuntimeDependency(command.args[0]!), true, server);
  }
  assert.deepEqual(
    resolveMcpCommand("cocoindex-code", {
      AUTODEV_COCOINDEX_BIN: "/custom/ccc"
    }),
    { binary: "/custom/ccc", args: ["mcp"], pathPrepend: [] }
  );
  assert.deepEqual(
    resolveMcpCommand(MCP_SERVER_CODEGRAPHCONTEXT, {
      AUTODEV_CODEGRAPHCONTEXT_BIN: "/custom/codegraphcontext"
    }),
    {
      binary: "/custom/codegraphcontext",
      args: ["mcp", "start"],
      pathPrepend: []
    }
  );
});

test("Runtime-owned MCP servers run beside the launcher, whatever root the caller names", () => {
  // An inherited AUTODEV_REPO_ROOT used to choose which tree the Commands and
  // Playtest servers ran from, so a caller could point the installed launcher
  // at an editable checkout. The servers are the launcher's sibling modules.
  const env = { AUTODEV_REPO_ROOT: "/elsewhere" };
  assert.deepEqual(resolveMcpCommand("playtest", env).args, [
    join(RUNTIME_SOURCE, "playtesting", "mcp-main.ts")
  ]);
  assert.deepEqual(resolveMcpCommand("commands", env).args, [
    join(RUNTIME_SOURCE, "mcp", "commands-main.ts")
  ]);
});

/** A copy of the launcher hook at `<root>/<directory>/`, as the installer places it. */
function installHook(root: string, directory: string): string {
  const hook = join(root, directory, "run-autodev-mcp.sh");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, readFileSync(mcpLauncherHook));
  chmodSync(hook, 0o755);
  return hook;
}

test("the MCP launcher hook finds the launcher in both Runtime layouts", () => {
  // The hook is the OS boundary the installed Codex configuration calls, and it
  // is copied into CODEX_HOME/hooks, where its root is the materialized tree.
  // Resolving only the checkout layout made the playtest MCP server fail to
  // start, which the analyst reported as no reachable playtest tools.
  const checkout = createIsolatedTempDir("autodev-mcp-hook-checkout-");
  const materialized = createIsolatedTempDir("autodev-mcp-hook-materialized-");
  try {
    const checkoutLauncher = join(
      checkout,
      "runtime",
      "src",
      "mcp",
      "launcher.ts"
    );
    const materializedLauncher = join(
      materialized,
      "src",
      "mcp",
      "launcher.ts"
    );
    mkdirSync(dirname(checkoutLauncher), { recursive: true });
    mkdirSync(dirname(materializedLauncher), { recursive: true });
    writeFileSync(checkoutLauncher, "export {};\n");
    writeFileSync(materializedLauncher, "export {};\n");

    for (const [root, expected, hook] of [
      [checkout, checkoutLauncher, installHook(checkout, "scripts")],
      [materialized, materializedLauncher, installHook(materialized, "hooks")]
    ] as const) {
      const seen = join(root, "seen-args");
      const fakeNode = join(root, "fake-node");
      writeFileSync(
        fakeNode,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${seen}"\n`
      );
      chmodSync(fakeNode, 0o755);

      // An inherited root names some other tree; the hook ignores it and
      // runs the Runtime it was installed beside.
      const result = spawnSync("bash", [hook, "playtest"], {
        env: {
          ...process.env,
          AUTODEV_REPO_ROOT: repositoryRoot,
          AUTODEV_NODE_BIN: fakeNode
        },
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n"), [
        expected,
        "playtest"
      ]);
    }
  } finally {
    rmSync(checkout, { recursive: true, force: true });
    rmSync(materialized, { recursive: true, force: true });
  }
});

test("the MCP launcher hook finds pnpm Node with a minimal PATH", () => {
  const root = createIsolatedTempDir("autodev-mcp-hook-pnpm-node-");
  try {
    const launcher = join(root, "runtime", "src", "mcp", "launcher.ts");
    const pnpmBin = join(root, "pnpm", "bin");
    const seen = join(root, "seen-args");
    mkdirSync(dirname(launcher), { recursive: true });
    mkdirSync(pnpmBin, { recursive: true });
    writeFileSync(launcher, "export {};\n");
    const pnpmNode = join(pnpmBin, "node");
    writeFileSync(pnpmNode, `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}"\n`);
    chmodSync(pnpmNode, 0o755);

    const result = spawnSync("bash", [installHook(root, "scripts"), "playtest"], {
      env: {
        HOME: root,
        PATH: "/usr/bin:/bin",
        PNPM_HOME: join(root, "pnpm")
      },
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n"), [
      launcher,
      "playtest"
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the MCP launcher hook reports a root that holds no launcher", () => {
  const empty = createIsolatedTempDir("autodev-mcp-hook-empty-");
  try {
    const fakeNode = join(empty, "fake-node");
    writeFileSync(fakeNode, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeNode, 0o755);
    const result = spawnSync("bash", [installHook(empty, "hooks"), "playtest"], {
      env: {
        ...process.env,
        AUTODEV_NODE_BIN: fakeNode
      },
      encoding: "utf8"
    });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /launcher module not found/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("MCP launcher fails clearly when codegraphcontext is missing", () => {
  assert.throws(
    () =>
      resolveMcpCommand(MCP_SERVER_CODEGRAPHCONTEXT, {
        PATH: "",
        HOME: "/nonexistent"
      }),
    /AutoDev CodeGraphContext MCP binary is missing; install codegraphcontext or set AUTODEV_CODEGRAPHCONTEXT_BIN/
  );
});

test("the launcher resolves installed tools from the home the server runs with", () => {
  // Observed 2026-10-31: the Antigravity bridge runs its CLI under a temporary
  // HOME, so the launcher looked for `ccc` and `codegraphcontext` in a home
  // that holds neither and reported both as missing -- "AutoDev MCP binary is
  // missing or not executable: /var/folders/.../user/.local/bin/ccc" -- while
  // both were installed in the user's own home.
  const root = createIsolatedTempDir("autodev-mcp-tool-home-");
  try {
    const toolHome = join(root, "user");
    const bin = join(toolHome, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["ccc", "codegraphcontext"]) {
      writeFileSync(join(bin, name), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    const env = {
      HOME: toolHome,
      PATH: "/usr/bin:/bin"
    };
    assert.deepEqual(resolveMcpCommand("cocoindex-code", env), {
      binary: join(bin, "ccc"),
      args: ["mcp"],
      pathPrepend: []
    });
    assert.deepEqual(
      resolveMcpCommand(MCP_SERVER_CODEGRAPHCONTEXT, env),
      {
        binary: join(bin, "codegraphcontext"),
        args: ["mcp", "start"],
        pathPrepend: []
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a home with no install does not shadow the copy on PATH", () => {
  // The CocoIndex resolution answered with `$HOME/.local/bin/ccc` without
  // checking it, so under a home that holds no install it reported an
  // installed tool as missing while a working copy sat on PATH.
  const root = createIsolatedTempDir("autodev-mcp-ccc-path-");
  try {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ccc"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(bin, "ccc"), 0o755);
    assert.deepEqual(
      resolveMcpCommand("cocoindex-code", {
        HOME: join(root, "isolated"),
        PATH: bin
      }),
      { binary: join(bin, "ccc"), args: ["mcp"], pathPrepend: [] }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP launcher rejects unknown tools", () => {
  assert.throws(
    () => resolveMcpCommand("unknown"),
    /unsupported AutoDev MCP/
  );
});

test("runMcp auto-initializes cocoindex-code if .cocoindex_code is absent", () => {
  const tempDir = createIsolatedTempDir("autodev-mcp-launcher-");
  const prevCwd = process.cwd();
  try {
    const mockBin = join(tempDir, "mock-ccc");
    writeFileSync(mockBin, `#!/usr/bin/env bash\n${MOCK_CCC_INIT}exit 0\n`);
    chmodSync(mockBin, 0o755);

    process.chdir(tempDir);
    assert.equal(existsSync(join(tempDir, ".cocoindex_code")), false);

    const status = runMcp("cocoindex-code", tempDir, {
      ...process.env,
      AUTODEV_COCOINDEX_BIN: mockBin
    });
    assert.equal(status, 0);
    assert.equal(findCocoindexProjectRoot(tempDir), tempDir);
  } finally {
    process.chdir(prevCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("resolveMcpWorkspace keeps the caller's directory unless it declares a workspace", () => {
  assert.equal(resolveMcpWorkspace({}, "/callers/dir"), "/callers/dir");
  assert.equal(
    resolveMcpWorkspace({ AUTODEV_MCP_WORKSPACE: "  " }, "/callers/dir"),
    "/callers/dir"
  );
});

test("resolveMcpWorkspace reports why a declared workspace is unusable", () => {
  const tempDir = createIsolatedTempDir("autodev-mcp-workspace-");
  try {
    assert.equal(
      resolveMcpWorkspace({ AUTODEV_MCP_WORKSPACE: tempDir }, "/callers/dir"),
      tempDir
    );
    assert.throws(
      () =>
        resolveMcpWorkspace(
          { AUTODEV_MCP_WORKSPACE: "relative/dir" },
          "/callers/dir"
        ),
      /AUTODEV_MCP_WORKSPACE must be an absolute path/
    );
    assert.throws(
      () =>
        resolveMcpWorkspace(
          { AUTODEV_MCP_WORKSPACE: join(tempDir, "absent") },
          "/callers/dir"
        ),
      /AUTODEV_MCP_WORKSPACE does not exist/
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("findCocoindexProjectRoot agrees with the ancestor walk ccc performs", () => {
  const repo = createIsolatedTempDir("autodev-cocoindex-root-");
  try {
    const nested = join(repo, "runtime", "src", "mcp");
    mkdirSync(nested, { recursive: true });
    assert.equal(findCocoindexProjectRoot(nested), null);

    mkdirSync(join(repo, ".cocoindex_code"));
    // A bare settings directory is ccc's user-level home, not a project.
    writeFileSync(join(repo, ".cocoindex_code", "global_settings.yml"), "");
    assert.equal(findCocoindexProjectRoot(nested), null);

    writeFileSync(join(repo, ".cocoindex_code", "settings.yml"), "");
    assert.equal(findCocoindexProjectRoot(nested), repo);
    assert.equal(findCocoindexProjectRoot(repo), repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("resolveCocoindexInitRoot initializes where ccc init would, and never the home directory", () => {
  const home = realpathSync(createIsolatedTempDir("autodev-cocoindex-home-"));
  try {
    mkdirSync(join(home, ".cocoindex_code"));
    writeFileSync(join(home, ".cocoindex_code", "global_settings.yml"), "");
    const plain = join(home, "notes");
    const repo = join(home, "repo");
    const nested = join(repo, "packages", "app");
    mkdirSync(plain);
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    assert.equal(resolveCocoindexInitRoot(plain, home), plain);
    assert.equal(resolveCocoindexInitRoot(nested, home), repo);
    assert.equal(resolveCocoindexInitRoot(repo, home), repo);
    for (const covering of [home, dirname(home), "/"])
      assert.throws(
        () => resolveCocoindexInitRoot(covering, home),
        /will not index .*home directory, one of its ancestors or the filesystem root/
      );

    // ccc compares physical paths, so a symlinked spelling of the home or the
    // workspace still names the same directories.
    const alias = join(
      createIsolatedTempDir("autodev-cocoindex-alias-"),
      "home"
    );
    try {
      symlinkSync(home, alias);
      assert.equal(resolveCocoindexInitRoot(join(alias, "notes"), home), plain);
      assert.equal(resolveCocoindexInitRoot(nested, alias), repo);
      assert.throws(
        () => resolveCocoindexInitRoot(alias, home),
        /will not index/
      );
      assert.throws(
        () => resolveCocoindexInitRoot(home, alias),
        /will not index/
      );
    } finally {
      rmSync(dirname(alias), { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("runMcp initializes a repository under a home that holds ccc's user settings", () => {
  // ~/.cocoindex_code is ccc's user-level directory. Taking it for a project
  // skipped initialization for every workspace under the home directory, and
  // `ccc mcp` then exited with "Not in an initialized project directory".
  const home = realpathSync(createIsolatedTempDir("autodev-mcp-home-"));
  const prevCwd = process.cwd();
  try {
    mkdirSync(join(home, ".cocoindex_code"));
    writeFileSync(join(home, ".cocoindex_code", "global_settings.yml"), "");
    const repo = join(home, "repo");
    const workspace = join(repo, "packages", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const mockBin = join(home, "mock-ccc");
    const seenCwd = join(home, "seen-cwd");
    writeFileSync(
      mockBin,
      `#!/usr/bin/env bash\n${MOCK_CCC_INIT}pwd > "${seenCwd}"\nexit 0\n`
    );
    chmodSync(mockBin, 0o755);

    process.chdir(workspace);
    const status = runMcp("cocoindex-code", home, {
      ...process.env,
      HOME: home,
      AUTODEV_COCOINDEX_BIN: mockBin
    });
    assert.equal(status, 0);
    assert.equal(findCocoindexProjectRoot(workspace), repo);
    assert.equal(
      existsSync(join(home, ".cocoindex_code", "settings.yml")),
      false
    );
    assert.equal(readFileSync(seenCwd, "utf8").trim(), workspace);

    process.chdir(home);
    assert.throws(
      () =>
        runMcp("cocoindex-code", home, {
          ...process.env,
          HOME: home,
          AUTODEV_COCOINDEX_BIN: mockBin
        }),
      /will not index/
    );
    assert.equal(
      existsSync(join(home, ".cocoindex_code", "settings.yml")),
      false
    );
  } finally {
    process.chdir(prevCwd);
    rmSync(home, { recursive: true, force: true });
  }
});

test("runMcp serves cocoindex-code from the declared workspace, not the caller's directory", () => {
  // The desktop runtime starts MCP servers from its own process directory, so
  // inheriting cwd left `ccc mcp` with no project and it exited with
  // "Not in an initialized project directory".
  const root = createIsolatedTempDir("autodev-mcp-declared-");
  const elsewhere = createIsolatedTempDir("autodev-mcp-caller-");
  const prevCwd = process.cwd();
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const mockBin = join(root, "mock-ccc");
    const seenCwd = join(root, "seen-cwd");
    writeFileSync(
      mockBin,
      `#!/usr/bin/env bash\n${MOCK_CCC_INIT}pwd > "${seenCwd}"\nexit 0\n`
    );
    chmodSync(mockBin, 0o755);

    process.chdir(elsewhere);
    const status = runMcp("cocoindex-code", root, {
      ...process.env,
      AUTODEV_COCOINDEX_BIN: mockBin,
      AUTODEV_MCP_WORKSPACE: workspace
    });
    assert.equal(status, 0);
    // macOS may spell a temp workspace as /tmp or /private/tmp; the spawned
    // process reports the physical cwd, which must still be the declared workspace.
    assert.equal(readFileSync(seenCwd, "utf8").trim(), realpathSync(workspace));
    assert.equal(findCocoindexProjectRoot(workspace), workspace);
    assert.equal(existsSync(join(elsewhere, ".cocoindex_code")), false);
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("runMcp refuses a workspace it cannot initialize instead of serving the wrong project", () => {
  const root = createIsolatedTempDir("autodev-mcp-uninitializable-");
  const prevCwd = process.cwd();
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const mockBin = join(root, "mock-ccc");
    writeFileSync(mockBin, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(mockBin, 0o755);

    process.chdir(root);
    assert.throws(
      () =>
        runMcp("cocoindex-code", root, {
          ...process.env,
          AUTODEV_COCOINDEX_BIN: mockBin,
          AUTODEV_MCP_WORKSPACE: workspace
        }),
      /AutoDev cocoindex-code has no project under .*workspace/
    );
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the LSP server finds the language servers AutoDev pins, whatever PATH Codex starts it with", () => {
  // Observed 2026-09-18: under Codex's environment lsp-mcp-server could not
  // spawn `typescript-language-server` (ENOENT) and exited on its first
  // TypeScript request, which agents saw as "Transport closed". The launcher
  // puts the Runtime's own bin directory and Node ahead of Codex's PATH.
  const command = resolveMcpCommand("lsp", {});
  const result = spawnSync(
    "bash",
    ["-c", "command -v node; command -v typescript-language-server"],
    {
      env: {
        PATH: [...command.pathPrepend, "/usr/bin:/bin"].join(":")
      },
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const [node, languageServer] = result.stdout.trim().split("\n");
  assert.equal(realpathSync(node!), realpathSync(process.execPath));
  assert.equal(
    languageServer,
    join(dirname(command.pathPrepend[0]!), ".bin", "typescript-language-server")
  );
  assert.equal(
    languageServer,
    join(import.meta.dirname, "..", "..", "runtime", "node_modules", ".bin", "typescript-language-server")
  );
});

test("the launcher passes its caller's server arguments to the server", () => {
  // The ChatGPT gateway hands the Commands MCP its role and workspace as
  // launcher arguments. Dropping them leaves the server without a role scope;
  // forwarded, it reaches its catalogue admission check, which refuses the
  // checkout's own catalogue for the checkout workspace.
  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, "runtime/src/mcp/launcher.ts"),
      "commands",
      "--role",
      "validator",
      "--workspace",
      repositoryRoot
    ],
    {
      cwd: repositoryRoot,
      env: { HOME: tmpdir(), PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      input: "",
      timeout: 30_000
    }
  );
  assert.doesNotMatch(result.stderr, /requires AUTODEV_MCP_ROLE/u);
  assert.match(result.stderr, /resolves inside the authorized workspace/u);
  assert.notEqual(result.status, 0);
});
