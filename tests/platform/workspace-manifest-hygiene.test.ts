import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The workspaces of the monorepo, and the source roots each one owns. */
const WORKSPACES: readonly {
  readonly directory: string;
  readonly roots: readonly string[];
}[] = [
  { directory: "console", roots: ["app", "src", "tests", "e2e"] },
  { directory: "runtime", roots: ["src", "tests"] },
  { directory: "core", roots: ["src", "tests"] },
  { directory: "data", roots: ["src", "tests"] },
  { directory: "", roots: ["tests"] }
];

/** Directories that are never a workspace's own source. */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".next-dev",
  "node_modules",
  "tmp"
]);

/** Paths the playtesting area owns; another session works on them. */
const PLAYTESTING = /(^|[\\/])playtesting([\\/]|-)/u;

/** One import, named the way the operator would name it. */
interface Import {
  /** The importing file, relative to the repository root. */
  readonly file: string;
  /** The module specifier the import names. */
  readonly specifier: string;
}

/** The workspace packages, so a cross-workspace import can be checked. */
interface WorkspaceManifest {
  readonly name: string;
  readonly declared: ReadonlySet<string>;
  readonly exports: Readonly<Record<string, unknown>> | undefined;
}

function readManifest(directory: string): WorkspaceManifest {
  const manifest = JSON.parse(
    readFileSync(path.join(repositoryRoot, directory, "package.json"), "utf8")
  ) as {
    readonly name: string;
    readonly dependencies?: Record<string, string>;
    readonly devDependencies?: Record<string, string>;
    readonly peerDependencies?: Record<string, string>;
    readonly optionalDependencies?: Record<string, string>;
    readonly exports?: Record<string, unknown>;
  };
  return {
    name: manifest.name,
    declared: new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {})
    ]),
    exports: manifest.exports
  };
}

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(child));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) found.push(child);
  }
  return found.sort();
}

/** The files a workspace owns, relative to the repository root. */
function workspaceFiles(workspace: {
  readonly directory: string;
  readonly roots: readonly string[];
}): string[] {
  const files: string[] = [];
  for (const root of workspace.roots) {
    for (const file of sourceFiles(
      path.join(repositoryRoot, workspace.directory, root)
    )) {
      const relative = path.relative(repositoryRoot, file);
      if (PLAYTESTING.test(relative)) continue;
      files.push(relative);
    }
  }
  return files.sort();
}

/**
 * The module specifiers a file really imports.
 *
 * The specifiers are read out of the syntax tree rather than out of the text,
 * because a `require` inside a template literal is not an import: the OpenLIT
 * workspace sync *builds* a script that requires `@prisma/client` inside the
 * OpenLIT container, where that package is a dependency of the container and
 * not of this workspace. A text scan would report that generated script as a
 * missing dependency of Data.
 */
function moduleSpecifiers(file: string): string[] {
  const source = readFileSync(path.join(repositoryRoot, file), "utf8");
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) {
        const callee = node.expression;
        const isRequire = ts.isIdentifier(callee) && callee.text === "require";
        const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        if (isRequire || isDynamicImport) specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
]);

/** The package a specifier names, and the subpath it reaches for. */
function packageOf(specifier: string): {
  readonly name: string;
  readonly subpath: string;
} {
  const segments = specifier.split("/");
  const name = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? specifier);
  return { name, subpath: specifier.slice(name.length) };
}

/** Every import a workspace makes that names a package rather than a path. */
function bareImports(workspace: {
  readonly directory: string;
  readonly roots: readonly string[];
}): Import[] {
  const imports: Import[] = [];
  for (const file of workspaceFiles(workspace)) {
    for (const specifier of moduleSpecifiers(file)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
      const { name } = packageOf(specifier);
      if (NODE_BUILTINS.has(name)) continue;
      imports.push({ file, specifier });
    }
  }
  return imports;
}

test("every import a workspace makes is a dependency its manifest declares", () => {
  // A workspace that imports a package it does not declare works in the
  // repository, where the package manager hoists everything into one tree, and
  // breaks when the workspace is installed on its own. A workspace that
  // imports *itself* by name is the one exception: the runtime's own modules
  // reach each other through the package's exports map, which is the contract
  // that map exists to state.
  const offenders: string[] = [];
  for (const workspace of WORKSPACES) {
    const manifest = readManifest(workspace.directory);
    for (const { file, specifier } of bareImports(workspace)) {
      const { name } = packageOf(specifier);
      if (manifest.declared.has(name)) continue;
      if (name === manifest.name) continue;
      offenders.push(`${file} imports ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("a cross-workspace import reaches for an export the target declares", () => {
  // The exports map is the workspace's declared contract. A caller that
  // reaches past it -- into `src/` -- is reading an implementation the target
  // has not published, and the target is free to move it.
  const targets = new Map(
    WORKSPACES.filter((workspace) => workspace.directory !== "").map(
      (workspace) => [
        readManifest(workspace.directory).name,
        readManifest(workspace.directory)
      ]
    )
  );
  const offenders: string[] = [];
  for (const workspace of WORKSPACES) {
    for (const { file, specifier } of bareImports(workspace)) {
      const { name, subpath } = packageOf(specifier);
      const target = targets.get(name);
      if (!target?.exports) continue;
      const key = `.${subpath}`;
      if (key in target.exports) continue;
      offenders.push(
        `${file} imports ${specifier}, which "${name}" does not export`
      );
    }
  }
  assert.deepEqual(offenders, []);
});
