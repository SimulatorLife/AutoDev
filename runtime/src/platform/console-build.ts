import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ConsoleBuildOptions {
  readonly repositoryRoot: string;
  readonly nodeBin?: string;
}

export interface ConsoleBuildDeps {
  readonly fileExists: (filePath: string) => boolean;
  readonly run: (
    executable: string,
    args: readonly string[],
    cwd: string
  ) => void;
}

function defaultDeps(): ConsoleBuildDeps {
  return {
    fileExists: existsSync,
    run: (executable, args, cwd) => {
      execFileSync(executable, [...args], { cwd, stdio: "inherit" });
    }
  };
}

/** Build the production Console before the installer starts its LaunchAgent. */
export function buildConsole(
  options: ConsoleBuildOptions,
  deps: ConsoleBuildDeps = defaultDeps()
): void {
  const consoleRoot = path.join(options.repositoryRoot, "console");
  const nextCli = path.join(
    consoleRoot,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next"
  );
  if (!deps.fileExists(nextCli)) {
    throw new Error(
      `Console dependencies are missing at ${nextCli}; run pnpm install --frozen-lockfile first.`
    );
  }
  deps.run(options.nodeBin ?? process.execPath, [nextCli, "build"], consoleRoot);
}
