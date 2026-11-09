import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkCocoIndex,
  checkCodeGraphContext,
  type DependencyDeps,
  type DependencyOptions,
  installCocoIndex,
  installCodeGraphContext,
  installPythonLanguageServer,
  resolveDependencyOptions
} from "@simulatorlife/autodev-runtime/platform/dependencies";

function options(
  overrides: Partial<DependencyOptions> = {}
): DependencyOptions {
  return {
    cocoindexPackage: "cocoindex-code[full]==0.2.41",
    codegraphcontextPackage: "codegraphcontext==0.6.13",
    pythonLanguageServerPackage: "python-lsp-server==1.15.0",
    skipCocoIndex: false,
    skipCodeGraphContext: false,
    skipLanguageServer: false,
    skipPipx: false,
    ...overrides
  };
}

function deps(overrides: Partial<DependencyDeps> = {}): DependencyDeps {
  return {
    commandPath: () => null,
    capture: () => null,
    run: () => 0,
    fileExists: () => false,
    platform: "linux",
    ...overrides
  };
}

/**
 * An environment in which neither resolver finds anything.
 *
 * The checks resolve the tools the way the MCP launcher does -- through the
 * shared resolvers, which look in `~/.local/bin` as well as on PATH -- so a
 * check that meant to assert "missing" has to say where it is looking.
 */
function emptyEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "", HOME: "/nonexistent-home" };
}

test("dependency options read the installer skip switches", () => {
  assert.deepEqual(
    resolveDependencyOptions({
      AUTODEV_SKIP_COCOINDEX_INSTALL: "1",
      AUTODEV_SKIP_CODEGRAPHCONTEXT_INSTALL: "1",
      AUTODEV_SKIP_LSP_INSTALL: "1",
      AUTODEV_SKIP_PIPX_INSTALL: "1",
      AUTODEV_CODEGRAPHCONTEXT_BIN: "/custom/codegraphcontext"
    }),
    {
      cocoindexPackage: "cocoindex-code[full]==0.2.41",
      codegraphcontextPackage: "codegraphcontext==0.6.13",
      pythonLanguageServerPackage: "python-lsp-server==1.15.0",
      skipCocoIndex: true,
      skipCodeGraphContext: true,
      skipLanguageServer: true,
      codegraphcontextBin: "/custom/codegraphcontext",
      skipPipx: true
    }
  );
});

test("CocoIndex installation uses typed pipx and Homebrew boundaries", () => {
  let pipx = false;
  const calls: string[][] = [];
  const result = installCocoIndex(
    options(),
    deps({
      commandPath: (command) =>
        command === "brew"
          ? "/opt/homebrew/bin/brew"
          : command === "pipx" && pipx
            ? "/opt/homebrew/bin/pipx"
            : null,
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command.endsWith("/brew") || command === "brew") pipx = true;
        return 0;
      }
    })
  );
  assert.equal(result, 0);
  assert.deepEqual(calls, [
    ["/opt/homebrew/bin/brew", "install", "pipx"],
    ["/opt/homebrew/bin/pipx", "ensurepath"],
    ["/opt/homebrew/bin/pipx", "install", "cocoindex-code[full]==0.2.41"]
  ]);
});

test("CodeGraphContext installation uses typed pipx and respects skip and bin override", () => {
  assert.equal(
    installCodeGraphContext(options({ skipCodeGraphContext: true }), deps()),
    0
  );
  assert.equal(
    installCodeGraphContext(
      options({ codegraphcontextBin: "/opt/bin/codegraphcontext" }),
      deps({ fileExists: (f) => f === "/opt/bin/codegraphcontext" })
    ),
    0
  );
  assert.throws(
    () =>
      installCodeGraphContext(
        options({ codegraphcontextBin: "/missing/codegraphcontext" }),
        deps({ fileExists: () => false })
      ),
    /missing or not executable at AUTODEV_CODEGRAPHCONTEXT_BIN/
  );
  let pipx = false;
  const calls: string[][] = [];
  const result = installCodeGraphContext(
    options(),
    deps({
      commandPath: (command) =>
        command === "brew"
          ? "/opt/homebrew/bin/brew"
          : command === "pipx" && pipx
            ? "/opt/homebrew/bin/pipx"
            : null,
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command.endsWith("/brew") || command === "brew") pipx = true;
        return 0;
      }
    })
  );
  assert.equal(result, 0);
  assert.deepEqual(calls, [
    ["/opt/homebrew/bin/brew", "install", "pipx"],
    ["/opt/homebrew/bin/pipx", "ensurepath"],
    ["/opt/homebrew/bin/pipx", "install", "codegraphcontext==0.6.13"]
  ]);
});

test("macOS native installs replace a non-Apple clang from PATH", () => {
  let installEnvironment: NodeJS.ProcessEnv | undefined;
  const result = installCodeGraphContext(
    options(),
    deps({
      commandPath: (command) =>
        command === "pipx"
          ? "/opt/homebrew/bin/pipx"
          : command === "clang"
            ? "/opt/homebrew/opt/llvm/bin/clang"
            : null,
      capture: (command) =>
        command === "/opt/homebrew/opt/llvm/bin/clang"
          ? "Homebrew clang version 18"
          : null,
      run: (_command, _args, env) => {
        installEnvironment = env;
        return 0;
      },
      fileExists: (filePath) =>
        filePath === "/usr/bin/clang" || filePath === "/usr/bin/clang++",
      platform: "darwin"
    })
  );
  assert.equal(result, 0);
  assert.equal(installEnvironment?.CC, "/usr/bin/clang");
  assert.equal(installEnvironment?.CXX, "/usr/bin/clang++");
});

test("Python language-server installation falls back to python user installs when Homebrew is absent", () => {
  let pipx = false;
  const calls: string[][] = [];
  const result = installPythonLanguageServer(
    options(),
    deps({
      commandPath: (command) =>
        command === "python3"
          ? "/usr/bin/python3"
          : command === "pipx" && pipx
            ? "/home/test/.local/bin/pipx"
            : null,
      run: (command, args) => {
        calls.push([command, ...args]);
        if (args.join(" ") === "-m pip install --user pipx") pipx = true;
        return 0;
      }
    })
  );
  assert.equal(result, 0);
  assert.deepEqual(calls, [
    ["/usr/bin/python3", "-m", "pip", "install", "--user", "pipx"],
    ["/home/test/.local/bin/pipx", "ensurepath"],
    ["/home/test/.local/bin/pipx", "install", "python-lsp-server==1.15.0"]
  ]);
});

test("dependency checks honor explicit skips and fail closed when tools are missing", () => {
  assert.equal(
    checkCocoIndex(options({ skipCocoIndex: true }), emptyEnvironment()),
    0
  );
  assert.equal(checkCocoIndex(options(), emptyEnvironment()), 1);
  assert.equal(
    checkCodeGraphContext(options({ skipCodeGraphContext: true }), deps()),
    0
  );
  assert.equal(checkCodeGraphContext(options(), deps(), emptyEnvironment()), 1);
  assert.equal(
    checkCodeGraphContext(
      options({ codegraphcontextBin: "/custom/cgc" }),
      deps({ fileExists: (f) => f === "/custom/cgc" })
    ),
    0
  );
  assert.equal(
    checkCodeGraphContext(
      options({ codegraphcontextBin: "/missing/cgc" }),
      deps({ fileExists: () => false })
    ),
    1
  );
});

test("the dependency checks find the pipx installs the MCP launcher finds", () => {
  // pipx installs into `~/.local/bin`, which a shell profile puts on PATH and
  // a bare process does not. The checks used to look at PATH alone, so they
  // reported an installed tool as missing on a machine where the launcher
  // started it every day.
  const home = mkdtempSync(join(tmpdir(), "autodev-deps-home-"));
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  for (const command of ["codegraphcontext", "ccc"]) {
    writeFileSync(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const env: NodeJS.ProcessEnv = { PATH: "", HOME: home };
  assert.equal(checkCodeGraphContext(options(), deps(), env), 0);
  assert.equal(checkCocoIndex(options(), env), 0);
  rmSync(home, { recursive: true, force: true });
});
