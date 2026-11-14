import { homedir } from "node:os";
import path from "node:path";

import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

export function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
}

export function repositoryRoot(): string {
  return resolveRuntimeSourceRoot(
    import.meta.dirname,
    process.env.AUTODEV_REPO_ROOT
  );
}
