import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
The Runtime workspace package name, used to recognize a source checkout.
*/
const RUNTIME_PACKAGE_NAME = "@simulatorlife/autodev-runtime";
/**
The manifest file name a package root is recognized by.
*/
const PACKAGE_MANIFEST_FILE = "package.json";

/**
Whether a package manifest declares the Runtime package. The name is what
distinguishes a checkout's `runtime/` package from an unrelated directory
that happens to sit at the same depth. A missing or unreadable manifest
declares nothing.
*/
function declaresRuntimePackage(manifestPath: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: unknown;
    };
    return manifest.name === RUNTIME_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
Resolve the repository root from either a Runtime source module in a checkout
or its materialized CODEX_HOME/src copy. A checkout is recognized by the
Runtime package manifest at `<root>/runtime/package.json` three levels above
the module; every other tree is the installed layout, whose root sits two
levels above the module.
*/
export function resolveRuntimeSourceRoot(
  moduleDirectory: string,
  configuredRoot?: string
): string {
  const configured = configuredRoot?.trim();
  if (configured) return path.resolve(configured);

  const workspaceRoot = path.resolve(moduleDirectory, "../../..");
  if (
    declaresRuntimePackage(
      path.join(workspaceRoot, "runtime", PACKAGE_MANIFEST_FILE)
    )
  )
    return workspaceRoot;

  return path.resolve(moduleDirectory, "../..");
}

/**
Resolve the Runtime package manifest of the tree the caller runs in: the
checkout's `runtime/package.json`, or the installed tree's own manifest.
The installed tree keeps the manifest at the root of its source copy, so a
path relative to the source checkout does not reach it.
*/
export function resolveRuntimePackageManifest(moduleDirectory: string): string {
  const sourceRoot = resolveRuntimeSourceRoot(moduleDirectory);
  const checkoutManifest = path.join(
    sourceRoot,
    "runtime",
    PACKAGE_MANIFEST_FILE
  );
  if (existsSync(checkoutManifest)) return checkoutManifest;
  return path.join(sourceRoot, "src", PACKAGE_MANIFEST_FILE);
}

/**
Resolve a Runtime-owned module from its source checkout or its stable
CODEX_HOME/src materialization. The root package marker distinguishes the
workspace tree from CODEX_HOME; it never falls back to root repository src.
*/
export function resolveRuntimeSourcePath(
  sourceRoot: string,
  modulePath: string
): string {
  const runtimePackageRoot = path.join(sourceRoot, "runtime");
  const sourceDirectory = existsSync(
    path.join(runtimePackageRoot, PACKAGE_MANIFEST_FILE)
  )
    ? path.join(runtimePackageRoot, "src")
    : path.join(sourceRoot, "src");
  return path.resolve(sourceDirectory, modulePath);
}
