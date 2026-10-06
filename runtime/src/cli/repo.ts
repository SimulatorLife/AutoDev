import { execFileSync } from "node:child_process";
import path from "node:path";

import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

import { unsupportedChoice } from "./command-choice.ts";

/** The repo vocabulary, owned here and consumed by validation and errors. */
export const REPO_SUBCOMMANDS = ["bootstrap"] as const;

export type RepoSubcommand = (typeof REPO_SUBCOMMANDS)[number];

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
  // One arm, so a `switch` would only trip `sonarjs/no-small-switch`; the
  // rejection below is still the family's single place an unusable subcommand is
  // reported.
  if (subcommand === "bootstrap") return backend.bootstrap(args);
  throw unsupportedChoice("repo subcommand", subcommand, REPO_SUBCOMMANDS);
}
