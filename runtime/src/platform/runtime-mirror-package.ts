/**
 * The package manifest for the materialized Runtime tree at `$CODEX_HOME/src`.
 *
 * The installed tree is a copy of `runtime/src`, and the Runtime imports its
 * own modules through the workspace package name. Node resolves that name
 * against the nearest package.json, so a copy that does not declare the
 * package it mirrors sends every self-import out of the installed tree: the
 * import resolves against the repository checkout instead, the Runtime loads
 * two copies of the same module, and module-scoped state (the routing policy,
 * provider discovery, cooldowns) splits across the two.
 *
 * The installed manifest is therefore derived from the workspace package
 * manifest: the same name, and an exports map whose targets are rewritten to
 * the installed tree's layout. Only subpaths whose source is materialized are
 * exported, so an import can never silently fall back to the checkout.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

/** The workspace manifest's export targets are relative to the package root. */
const RUNTIME_SOURCE_PREFIX = "./src/";

export interface RuntimeMirrorPackageInput {
  /** The parsed `runtime/package.json` manifest. */
  readonly runtimePackage: unknown;
  /** Repository-relative paths that are materialized into the installed tree. */
  readonly materialized: ReadonlySet<string>;
}

function runtimePackageManifest(runtimePackage: unknown): {
  readonly name: string;
  readonly version: string | null;
  readonly exports: Readonly<Record<string, string>>;
} {
  const manifest = runtimePackage as {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly exports?: unknown;
  } | null;
  if (manifest === null || typeof manifest !== "object")
    throw new Error("runtime-package-manifest-unreadable");
  if (typeof manifest.name !== "string" || manifest.name.length === 0)
    throw new Error("runtime-package-manifest-missing-name");
  if (
    typeof manifest.exports !== "object" ||
    manifest.exports === null ||
    Array.isArray(manifest.exports)
  )
    throw new Error("runtime-package-manifest-missing-exports");
  const exports: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(
    manifest.exports as Record<string, unknown>
  )) {
    if (typeof target !== "string")
      throw new Error(`runtime-package-export-unsupported ${subpath}`);
    exports[subpath] = target;
  }
  return {
    name: manifest.name,
    version: typeof manifest.version === "string" ? manifest.version : null,
    exports
  };
}

/**
 * Render the installed tree's package manifest.
 *
 * The installed root is `runtime/src`, so an export target such as
 * `./src/router/routing.ts` becomes `./router/routing.ts` there.
 */
export function renderRuntimeMirrorPackage(
  input: RuntimeMirrorPackageInput
): string {
  const manifest = runtimePackageManifest(input.runtimePackage);
  const exports: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    if (!target.startsWith(RUNTIME_SOURCE_PREFIX))
      throw new Error(`runtime-package-export-outside-source ${subpath}`);
    const repositoryPath = path.join("runtime", target.slice(2));
    if (!input.materialized.has(repositoryPath)) continue;
    exports[subpath] = `./${target.slice(RUNTIME_SOURCE_PREFIX.length)}`;
  }
  return `${JSON.stringify(
    {
      name: manifest.name,
      ...(manifest.version === null ? {} : { version: manifest.version }),
      type: "module",
      exports
    },
    null,
    2
  )}\n`;
}

/** Read the workspace package manifest that the installed tree mirrors. */
export function readRuntimePackageManifest(repositoryRoot: string): unknown {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, "runtime/package.json"), "utf8")
  );
}
