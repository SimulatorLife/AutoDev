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

/**
 * Resolve a Runtime-owned module from its source checkout or its stable
 * CODEX_HOME/src materialization. The root package marker distinguishes the
 * workspace tree from CODEX_HOME; it never falls back to root repository src.
 */
export function resolveRuntimeSourcePath(
  sourceRoot: string,
  modulePath: string
): string {
  const runtimePackageRoot = path.join(sourceRoot, "runtime");
  const sourceDirectory = existsSync(
    path.join(runtimePackageRoot, "package.json")
  )
    ? path.join(runtimePackageRoot, "src")
    : path.join(sourceRoot, "src");
  return path.resolve(sourceDirectory, modulePath);
}
