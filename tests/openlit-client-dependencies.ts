/**
 * Dependency guard for the patched OpenLIT client.
 *
 * The fork's client is installed from a committed `package-lock.json`, so the
 * lockfile -- not the manifest -- decides which packages the image actually
 * gets. Two things can therefore go wrong without any test in the fork
 * noticing, because the fork's own suite runs against a tree installed from
 * that same lockfile:
 *
 * 1. A source file imports a package the lockfile does not install. The
 *    import cannot resolve at build or run time, and nothing in the fork can
 *    see it because the fork never installs a tree that differs from its lock.
 * 2. The manifest declares a package the lockfile does not install. `npm ci`
 *    refuses a tree whose manifest and lock disagree, so the image build
 *    breaks on a disagreement rather than on a missing import.
 *
 * Both are questions about a *tree*, not about a single file, so they live
 * here rather than in the patch-apply test body: the apply test owns the
 * patches, this module owns the dependency contract they have to satisfy.
 *
 * The import scan uses the TypeScript parser rather than a regular
 * expression. A regex that mistakes a string literal for an import produces
 * false positives, and a regex that misses `export ... from` or a dynamic
 * `import()` produces false negatives; both would make this guard lie.
 */

import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

import ts from "typescript";

/** The result of auditing one client tree against its own lockfile. */
export interface ClientDependencyAudit {
  /**
   * Import specifiers whose package the lockfile does not install, sorted.
   * Each entry is the specifier as written, so the report names the file's
   * own text rather than a normalised package name.
   */
  readonly unresolved: readonly string[];
  /** Manifest dependencies the lockfile does not install, sorted. */
  readonly uninstalled: readonly string[];
}

const SOURCE_FILE = /\.[cm]?[jt]sx?$/u;

/**
 * Directories that never hold the client's own source. `node_modules` is
 * absent from a freshly patched checkout but is excluded so the same scan
 * works against an installed tree.
 */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "node_modules",
  "out"
]);

/**
 * The fork's path alias. Every `paths` entry in the client's tsconfig and
 * every entry in its Jest `moduleNameMapper` starts with `@/`, so this one
 * prefix covers all of them.
 */
const PATH_ALIAS_PREFIX = "@/";

/** Node built-ins, with and without the `node:` scheme. */
const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/u, "")])
);

interface Lockfile {
  packages?: Record<string, unknown>;
}

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Every source file in the client, excluding build and install output. */
function clientSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      files.push(...clientSourceFiles(join(root, entry.name)));
      continue;
    }
    if (SOURCE_FILE.test(entry.name)) files.push(join(root, entry.name));
  }
  return files;
}

/** The module specifier of one import-like node, if it has one. */
function moduleSpecifierOf(node: ts.Node): string | null {
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  if (!ts.isCallExpression(node)) return null;
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire =
    ts.isIdentifier(node.expression) && node.expression.text === "require";
  if (!isDynamicImport && !isRequire) return null;
  const [argument] = node.arguments;
  return argument && ts.isStringLiteral(argument) ? argument.text : null;
}

/** Every module specifier one source file imports. */
function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    const specifier = moduleSpecifierOf(node);
    if (specifier) specifiers.push(specifier);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/**
 * The package a specifier resolves to, or null when it is not a package:
 * a relative path, the fork's own path alias, or a Node built-in.
 */
function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith(PATH_ALIAS_PREFIX)) return null;
  if (specifier.startsWith("node:")) return null;
  const segments = specifier.split("/");
  const name = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? "");
  if (!name || NODE_BUILTINS.has(name)) return null;
  return name;
}

/** The package names the lockfile installs. */
function installedPackages(lock: Lockfile): Set<string> {
  const installed = new Set<string>();
  for (const key of Object.keys(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/")) continue;
    installed.add(key.slice("node_modules/".length));
  }
  return installed;
}

/**
 * Audit one client tree against its own lockfile.
 *
 * @param clientRoot The client's root directory, holding `package.json` and
 * `package-lock.json`.
 */
export function auditClientDependencies(
  clientRoot: string
): ClientDependencyAudit {
  const manifest = JSON.parse(
    readFileSync(join(clientRoot, "package.json"), "utf8")
  ) as Manifest;
  const lock = JSON.parse(
    readFileSync(join(clientRoot, "package-lock.json"), "utf8")
  ) as Lockfile;
  const installed = installedPackages(lock);

  const unresolved = new Set<string>();
  for (const file of clientSourceFiles(clientRoot)) {
    for (const specifier of importSpecifiers(file)) {
      const name = packageNameOf(specifier);
      if (name && !installed.has(name)) unresolved.add(specifier);
    }
  }

  const declared = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {})
  ];
  const uninstalled = declared.filter((name) => !installed.has(name));

  return {
    unresolved: [...unresolved].sort(),
    uninstalled: uninstalled.sort()
  };
}
