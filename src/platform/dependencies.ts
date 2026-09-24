import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  statSync
} from "node:fs";
import path from "node:path";

import { writeErrorLine, writeLine } from "../shared/output.ts";

export interface DependencyOptions {
  readonly cocoindexPackage: string;
  readonly codegraphcontextPackage: string;
  readonly pythonLanguageServerPackage: string;
  readonly skipCocoIndex: boolean;
  readonly skipCodeGraphContext: boolean;
  readonly skipLanguageServer: boolean;
  readonly codegraphcontextBin?: string | undefined;
  readonly skipPipx: boolean;
}

export interface DependencyDeps {
  readonly commandPath: (command: string) => string | null;
  readonly capture: (command: string, args: readonly string[]) => string | null;
  readonly run: (
    command: string,
    args: readonly string[],
    env?: NodeJS.ProcessEnv
  ) => number;
  readonly fileExists: (filePath: string) => boolean;
  readonly platform: NodeJS.Platform;
}

const DEFAULT_COCOINDEX_PACKAGE = "cocoindex-code[full]==0.2.41";
const DEFAULT_CODEGRAPHCONTEXT_PACKAGE = "codegraphcontext==0.6.13";
const DEFAULT_PYTHON_LANGUAGE_SERVER_PACKAGE = "python-lsp-server==1.15.0";

function defaultDeps(): DependencyDeps {
  return {
    commandPath: (command) => {
      try {
        return (
          execFileSync("which", [command], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"]
          }).trim() || null
        );
      } catch {
        return null;
      }
    },
    capture: (command, args) => {
      try {
        return execFileSync(command, [...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        }).trim();
      } catch {
        return null;
      }
    },
    run: (command, args, env) =>
      spawnSync(command, [...args], {
        env: { ...process.env, ...env },
        stdio: "inherit"
      }).status ?? 1,
    fileExists: (filePath) => {
      try {
        accessSync(filePath, fsConstants.X_OK);
        return statSync(filePath).isFile();
      } catch {
        return false;
      }
    },
    platform: process.platform
  };
}

export function resolveDependencyOptions(
  env: NodeJS.ProcessEnv = process.env
): DependencyOptions {
  return {
    cocoindexPackage: DEFAULT_COCOINDEX_PACKAGE,
    codegraphcontextPackage: DEFAULT_CODEGRAPHCONTEXT_PACKAGE,
    pythonLanguageServerPackage: DEFAULT_PYTHON_LANGUAGE_SERVER_PACKAGE,
    skipCocoIndex: env.AUTODEV_SKIP_COCOINDEX_INSTALL === "1",
    skipCodeGraphContext: env.AUTODEV_SKIP_CODEGRAPHCONTEXT_INSTALL === "1",
    skipLanguageServer: env.AUTODEV_SKIP_LSP_INSTALL === "1",
    codegraphcontextBin: env.AUTODEV_CODEGRAPHCONTEXT_BIN,
    skipPipx: env.AUTODEV_SKIP_PIPX_INSTALL === "1"
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function ensurePipx(options: DependencyOptions, deps: DependencyDeps): string {
  const existing = deps.commandPath("pipx");
  if (existing) {
    writeErrorLine(`ok pipx (${existing})`);
    return existing;
  }
  if (options.skipPipx)
    fail("pipx installation is disabled (AUTODEV_SKIP_PIPX_INSTALL=1)");

  const brew = deps.commandPath("brew");
  let userPipx: string | null = null;
  if (brew) {
    const translated =
      deps.platform === "darwin" &&
      deps.capture("sysctl", ["-n", "sysctl.proc_translated"]) === "1" &&
      deps.capture("sysctl", ["-n", "hw.optional.arm64"]) === "1";
    const command = translated ? "arch" : brew;
    const args = translated
      ? ["-arm64", "brew", "install", "pipx"]
      : ["install", "pipx"];
    if (translated)
      writeErrorLine(
        "running Homebrew natively (this process is translated under Rosetta)"
      );
    writeErrorLine("installing pipx with Homebrew");
    deps.run(command, args);
  } else {
    const python = deps.commandPath("python3");
    if (!python)
      fail("cannot install pipx automatically: python3 is unavailable");
    writeErrorLine("installing pipx with pip --user");
    if (deps.run(python, ["-m", "pip", "install", "--user", "pipx"]) !== 0) {
      fail(
        "could not install pipx with pip --user; the Python environment may be externally managed (PEP 668)"
      );
    }
    const userBase = deps.capture(python, ["-m", "site", "--user-base"]);
    userPipx = userBase ? path.join(userBase, "bin", "pipx") : null;
  }

  const refreshed =
    deps.commandPath("pipx") ??
    (userPipx && deps.fileExists(userPipx) ? userPipx : null) ??
    ["/opt/homebrew/bin/pipx", "/usr/local/bin/pipx"].find((filePath) =>
      deps.fileExists(filePath)
    );
  if (!refreshed) fail("pipx installation did not put pipx on PATH");
  deps.run(refreshed, ["ensurepath"]);
  writeErrorLine(`ok pipx installed (${refreshed})`);
  return refreshed;
}

function nativeBuildEnvironment(deps: DependencyDeps): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (!process.env.SDKROOT && deps.platform === "darwin") {
    const sdk = deps.capture("xcrun", ["--show-sdk-path"]);
    if (sdk && existsSync(path.join(sdk, "usr", "include"))) {
      writeErrorLine(`using macOS SDK at ${sdk} for native dependency builds`);
      env.SDKROOT = sdk;
    }
  }
  if (
    !process.env.CC &&
    deps.platform === "darwin" &&
    deps.fileExists("/usr/bin/clang")
  ) {
    const clangOnPath = deps.commandPath("clang");
    const clangOnPathVersion = clangOnPath
      ? (deps.capture(clangOnPath, ["--version"]) ?? "")
      : "";
    if (!clangOnPathVersion.includes("Apple clang")) {
      writeErrorLine(
        "using /usr/bin/clang for native builds (the clang on PATH is not Apple clang)"
      );
      env.CC = "/usr/bin/clang";
      env.CXX = "/usr/bin/clang++";
    }
  }
  return env;
}

export function installCocoIndex(
  options = resolveDependencyOptions(),
  deps = defaultDeps()
): number {
  if (options.skipCocoIndex) {
    writeErrorLine(
      "skipping CocoIndex Code installation (AUTODEV_SKIP_COCOINDEX_INSTALL=1)"
    );
    return 0;
  }
  const existing = deps.commandPath("ccc");
  if (existing) {
    writeErrorLine(`ok CocoIndex Code executable (${existing})`);
    return 0;
  }
  const pipx = ensurePipx(options, deps);
  writeErrorLine(
    `installing CocoIndex Code with pipx (${options.cocoindexPackage})`
  );
  return deps.run(
    pipx,
    ["install", options.cocoindexPackage],
    nativeBuildEnvironment(deps)
  );
}

export function installCodeGraphContext(
  options = resolveDependencyOptions(),
  deps = defaultDeps()
): number {
  if (options.skipCodeGraphContext) {
    writeErrorLine(
      "skipping CodeGraphContext installation (AUTODEV_SKIP_CODEGRAPHCONTEXT_INSTALL=1)"
    );
    return 0;
  }
  const configured = options.codegraphcontextBin;
  if (configured) {
    if (deps.fileExists(configured)) {
      writeErrorLine(`ok CodeGraphContext executable (${configured})`);
      return 0;
    }
    fail(
      `CodeGraphContext executable is missing or not executable at AUTODEV_CODEGRAPHCONTEXT_BIN (${configured})`
    );
  }
  const existing = deps.commandPath("codegraphcontext");
  if (existing) {
    writeErrorLine(`ok CodeGraphContext executable (${existing})`);
    return 0;
  }
  const pipx = ensurePipx(options, deps);
  writeErrorLine(
    `installing CodeGraphContext with pipx (${options.codegraphcontextPackage})`
  );
  return deps.run(
    pipx,
    ["install", options.codegraphcontextPackage],
    nativeBuildEnvironment(deps)
  );
}

export function installPythonLanguageServer(
  options = resolveDependencyOptions(),
  deps = defaultDeps()
): number {
  if (options.skipLanguageServer) {
    writeErrorLine(
      "skipping Python language-server installation (AUTODEV_SKIP_LSP_INSTALL=1)"
    );
    return 0;
  }
  const existing = deps.commandPath("pylsp");
  if (existing) {
    writeErrorLine(`ok Python language server (${existing})`);
    return 0;
  }
  const pipx = ensurePipx(options, deps);
  writeErrorLine(
    `installing Python language server with pipx (${options.pythonLanguageServerPackage})`
  );
  return deps.run(pipx, ["install", options.pythonLanguageServerPackage]);
}

export function checkCocoIndex(
  options = resolveDependencyOptions(),
  deps = defaultDeps()
): number {
  if (options.skipCocoIndex) {
    writeLine(
      "skipping CocoIndex Code executable check (AUTODEV_SKIP_COCOINDEX_INSTALL=1)"
    );
    return 0;
  }
  const existing = deps.commandPath("ccc");
  if (existing) {
    writeLine(`ok CocoIndex Code executable (${existing})`);
    return 0;
  }
  writeLine(
    "missing CocoIndex Code executable ccc (run the installer without AUTODEV_SKIP_COCOINDEX_INSTALL)"
  );
  return 1;
}

export function checkCodeGraphContext(
  options = resolveDependencyOptions(),
  deps = defaultDeps()
): number {
  if (options.skipCodeGraphContext) {
    writeLine(
      "skipping CodeGraphContext executable check (AUTODEV_SKIP_CODEGRAPHCONTEXT_INSTALL=1)"
    );
    return 0;
  }
  const configured = options.codegraphcontextBin;
  if (configured) {
    if (deps.fileExists(configured)) {
      writeLine(`ok CodeGraphContext executable (${configured})`);
      return 0;
    }
    writeLine(
      `missing CodeGraphContext executable at AUTODEV_CODEGRAPHCONTEXT_BIN (${configured})`
    );
    return 1;
  }
  const existing = deps.commandPath("codegraphcontext");
  if (existing) {
    writeLine(`ok CodeGraphContext executable (${existing})`);
    return 0;
  }
  writeLine(
    "missing CodeGraphContext executable codegraphcontext (run the installer without AUTODEV_SKIP_CODEGRAPHCONTEXT_INSTALL)"
  );
  return 1;
}

export function checkPythonLanguageServer(
  options = resolveDependencyOptions(),
  deps = defaultDeps()
): number {
  if (options.skipLanguageServer) {
    writeLine(
      "skipping Python language-server check (AUTODEV_SKIP_LSP_INSTALL=1)"
    );
    return 0;
  }
  const existing = deps.commandPath("pylsp");
  if (existing) {
    writeLine(`ok Python language server (${existing})`);
    return 0;
  }
  writeLine(
    "missing Python language server pylsp (run the installer without AUTODEV_SKIP_LSP_INSTALL)"
  );
  return 1;
}

function cli(argv: string[]): number {
  const options = resolveDependencyOptions();
  if (argv[0] === "install-cocoindex" && argv.length === 1)
    return installCocoIndex(options);
  if (argv[0] === "install-codegraphcontext" && argv.length === 1)
    return installCodeGraphContext(options);
  if (argv[0] === "install-pylsp" && argv.length === 1)
    return installPythonLanguageServer(options);
  if (argv[0] === "check-cocoindex" && argv.length === 1)
    return checkCocoIndex(options);
  if (argv[0] === "check-codegraphcontext" && argv.length === 1)
    return checkCodeGraphContext(options);
  if (argv[0] === "check-pylsp" && argv.length === 1)
    return checkPythonLanguageServer(options);
  throw new Error(
    "usage: dependencies install-cocoindex|install-codegraphcontext|install-pylsp|check-cocoindex|check-codegraphcontext|check-pylsp"
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    writeErrorLine(
      `dependencies: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
