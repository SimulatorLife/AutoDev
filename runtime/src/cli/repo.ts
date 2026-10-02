import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { ConfigError } from "@simulatorlife/autodev-runtime/config";

export interface RepoCommandBackend {
  bootstrap(args?: readonly string[]): number;
}

const repoRoot = path.resolve(resolveRuntimeSourceRoot(import.meta.dirname));

export const defaultRepoBackend: RepoCommandBackend = {
  bootstrap: (args = []) => {
    const script = path.join(
      repoRoot,
      "scripts",
      "bootstrap-repo-exclusions.sh"
    );
    try {
      execFileSync(script, args, { stdio: "inherit" });
      return 0;
    } catch (error: unknown) {
      if (
        error &&
        typeof error === "object" &&
        "status" in error &&
        typeof (error as { status: unknown }).status === "number"
      ) {
        return (error as { status: number }).status;
      }
      return 1;
    }
  }
};

export function dispatchRepoCommand(
  subcommand: string,
  args: readonly string[] = [],
  backend: RepoCommandBackend = defaultRepoBackend
): number {
  if (subcommand === "bootstrap") {
    return backend.bootstrap(args);
  }
  throw new ConfigError(
    `unsupported repo subcommand: ${subcommand || "(missing)"}`
  );
}
