import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Resolve the repository root from either a Runtime source module in a checkout
 * or its materialized CODEX_HOME/src copy. Runtime modules stay at the legacy
 * installed depth while their authoritative source lives one level deeper.
 */
export function resolveRuntimeSourceRoot(
  moduleDirectory: string,
  configuredRoot?: string
): string {
  const configured = configuredRoot?.trim();
  if (configured) return path.resolve(configured);

  const workspaceRoot = path.resolve(moduleDirectory, "../../..");
  if (existsSync(path.join(workspaceRoot, "runtime", "package.json")))
    return workspaceRoot;

  return path.resolve(moduleDirectory, "../..");
}
