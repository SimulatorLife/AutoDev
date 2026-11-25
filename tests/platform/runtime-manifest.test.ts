import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LAUNCH_LABELS,
  nodeModuleLinks,
  OBSOLETE_DASHBOARD,
  OBSOLETE_LAUNCH,
  OBSOLETE_RUNTIME_DATA_FILES,
  RUNTIME_MODULES,
  runtimeSourceTree
} from "@simulatorlife/autodev-runtime/platform/install-materializer";
import { runtimeTarget } from "@simulatorlife/autodev-runtime/platform/runtime-files";
import * as ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function relativeImportsFromSource(
  modulePath: string,
  source: string
): string[] {
  const file = ts.createSourceFile(
    modulePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const directory = dirname(modulePath);
  const imports: string[] = [];
  const addRelativeSpecifier = (specifier: ts.Expression | undefined): void => {
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      specifier.text.startsWith(".")
    ) {
      imports.push(normalize(join(directory, specifier.text)));
    }
  };

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly)
        addRelativeSpecifier(statement.moduleSpecifier);
      continue;
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      addRelativeSpecifier(statement.moduleSpecifier);
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      addRelativeSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

function relativeImports(modulePath: string): string[] {
  return relativeImportsFromSource(
    modulePath,
    readFileSync(join(repositoryRoot, modulePath), "utf8")
  );
}

function runtimeSourceFiles(): string[] {
  const root = join(repositoryRoot, "runtime/src");
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith(".ts"))
        files.push(normalize(join("runtime/src", relative(root, absolute))));
    }
  };
  visit(root);
  return files.sort();
}

const BARE_PACKAGE_IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\b[\s\S]*?\bfrom\s+["']([^."'\n\r][^"'\n\r]*)["']/gu;

function packageImports(source: string): Set<string> {
  const packages = new Set<string>();
  const normalized = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*/gu, "");
  for (const match of normalized.matchAll(BARE_PACKAGE_IMPORT_PATTERN)) {
    const specifier = match[1]!;
    if (specifier.startsWith("node:")) continue;
    const parts = specifier.split("/");
    packages.add(
      specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
    );
  }
  return packages;
}

function assertInstalledSourceDependencies(
  modulePath: string,
  rootDependencies: ReadonlySet<string>,
  runtimeDependencies: ReadonlySet<string>,
  runtimePackageName: string
): void {
  if (!modulePath.endsWith(".ts")) return;
  const runtimeSource = modulePath.startsWith("runtime/");
  const dependencies = runtimeSource ? runtimeDependencies : rootDependencies;
  const modulesRoot = runtimeSource ? "runtime/node_modules" : "node_modules";
  for (const packageName of packageImports(
    readFileSync(join(repositoryRoot, modulePath), "utf8")
  )) {
    const selfImport = runtimeSource && packageName === runtimePackageName;
    if (!selfImport) {
      assert.ok(
        dependencies.has(packageName),
        `${modulePath} imports "${packageName}" without declaring it in its owning package`
      );
    }
    assert.ok(
      existsSync(join(repositoryRoot, modulesRoot, packageName)) ||
        (selfImport &&
          existsSync(join(repositoryRoot, "node_modules", packageName))),
      `workspace dependency "${packageName}" is missing from its package resolution path`
    );
  }
}

test("every manifest entry exists in the repository", () => {
  const absent = [...RUNTIME_MODULES].filter(
    (modulePath) => !existsSync(join(repositoryRoot, modulePath))
  );
  assert.deepEqual(
    absent,
    [],
    `manifest lists files that do not exist:\n${absent.join("\n")}`
  );
});

/**
 * The installed tree is rebuilt whole on every install and swapped in, so it
 * holds exactly the manifest's `runtime/src` modules and its package manifest:
 * a module removed from the manifest has no stale copy left to clean up.
 */
test("the installed source tree is exactly the manifest's runtime/src modules", () => {
  const tree = runtimeSourceTree(repositoryRoot, "/codex-home");
  const expected = (RUNTIME_MODULES as readonly string[])
    .filter((modulePath) => modulePath.startsWith("runtime/src/"))
    .map((modulePath) => modulePath.slice("runtime/src/".length));
  assert.deepEqual(
    [...tree.files.keys()].sort(),
    [...expected, "package.json"].sort()
  );
  assert.equal(
    tree.nodeModules,
    join(repositoryRoot, "runtime", "node_modules")
  );
});

test("runtime manifest closure follows runtime imports but ignores erased type-only imports", () => {
  const source = [
    'import type { AgentActivityTracker } from "./concurrency/index.ts";',
    'export type { UsageBucket } from "./usage.ts";'
  ].join("\n");
  assert.deepEqual(
    relativeImportsFromSource("runtime/src/router/usage.ts", source),
    []
  );

  const mixedTypeReexport = 'export { type UsageBucket } from "./usage.ts";';
  assert.deepEqual(
    relativeImportsFromSource("runtime/src/router/index.ts", mixedTypeReexport),
    ["runtime/src/router/usage.ts"]
  );

  const mixedImport =
    'import { createAgentActivityTracker, type AgentActivityTracker } from "./concurrency/index.ts";';
  assert.deepEqual(
    relativeImportsFromSource("runtime/src/router/usage.ts", mixedImport),
    ["runtime/src/router/concurrency/index.ts"]
  );
});

test("runtime manifest is closed under relative imports", () => {
  const listed = new Set<string>(RUNTIME_MODULES);
  const pending: string[] = RUNTIME_MODULES.filter((entry) =>
    entry.endsWith(".ts")
  );
  const visited = new Set<string>();
  const gaps: string[] = [];
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (modulePath === undefined || visited.has(modulePath)) continue;
    visited.add(modulePath);
    for (const target of relativeImports(modulePath)) {
      if (!listed.has(target))
        gaps.push(`${target} (imported by ${modulePath})`);
      if (target.endsWith(".ts")) pending.push(target);
    }
  }
  assert.deepEqual(
    gaps.sort(),
    [],
    `RUNTIME_MODULES is not self-contained; add these entries to runtime/src/platform/install-materializer.ts:\n${gaps.join("\n")}`
  );
});

/**
 * The Runtime imports its own modules through the workspace package name as
 * well as by path. The installed tree resolves those imports through its own
 * manifest, so a package import whose target is not materialized loads a
 * second copy of the module from the repository checkout -- and module-scoped
 * state splits across the two copies.
 */
function packageSelfImports(modulePath: string): string[] {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { name: string; exports: Record<string, string> };
  const file = ts.createSourceFile(
    modulePath,
    readFileSync(join(repositoryRoot, modulePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const specifiers: string[] = [];
  const add = (specifier: ts.Expression | undefined): void => {
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      specifier.text.startsWith(`${runtimePackage.name}/`)
    ) {
      specifiers.push(specifier.text);
    }
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly) add(statement.moduleSpecifier);
      continue;
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      add(statement.moduleSpecifier);
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers.map((specifier) => {
    const subpath = `./${specifier.slice(`${runtimePackage.name}/`.length)}`;
    const target = runtimePackage.exports[subpath];
    assert.ok(
      target !== undefined,
      `${modulePath} imports "${specifier}", which the Runtime package does not export`
    );
    return normalize(join("runtime", target.slice(2)));
  });
}

test("runtime manifest is closed under package imports", () => {
  const listed = new Set<string>(RUNTIME_MODULES);
  const pending: string[] = RUNTIME_MODULES.filter((entry) =>
    entry.endsWith(".ts")
  );
  const visited = new Set<string>();
  const gaps: string[] = [];
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (modulePath === undefined || visited.has(modulePath)) continue;
    visited.add(modulePath);
    for (const target of packageSelfImports(modulePath)) {
      if (!listed.has(target))
        gaps.push(`${target} (imported by ${modulePath})`);
      if (target.endsWith(".ts")) pending.push(target);
    }
  }
  assert.deepEqual(
    gaps.sort(),
    [],
    `RUNTIME_MODULES does not own every module the installed tree imports by package name; add these entries to runtime/src/platform/install-materializer.ts:\n${gaps.join("\n")}`
  );
});

/**
 * The installed tree resolves some Runtime modules by path instead of by
 * package import. Those modules are spawned as child processes, so a missing
 * manifest entry is a runtime failure with no static symptom: the child exits
 * before it can report anything.
 */
function pathResolvedModules(modulePath: string): string[] {
  const file = ts.createSourceFile(
    modulePath,
    readFileSync(join(repositoryRoot, modulePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const resolved: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "resolveRuntimeSourcePath"
    ) {
      const moduleArgument = node.arguments[1];
      if (
        moduleArgument !== undefined &&
        ts.isStringLiteralLike(moduleArgument)
      )
        resolved.push(moduleArgument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return resolved;
}

test("every Runtime module resolved by path is materialized into CODEX_HOME", () => {
  const listed = new Set<string>(RUNTIME_MODULES);
  const gaps: string[] = [];
  for (const modulePath of runtimeSourceFiles()) {
    for (const resolved of pathResolvedModules(modulePath)) {
      const runtimePath = normalize(join("runtime", "src", resolved));
      if (!listed.has(runtimePath))
        gaps.push(`${runtimePath} (resolved by path from ${modulePath})`);
    }
  }
  assert.deepEqual(
    gaps.sort(),
    [],
    `modules resolved by path must be materialized into CODEX_HOME/src; add these entries to runtime/src/platform/install-materializer.ts:\n${gaps.join("\n")}`
  );
});

test("the playtest analyst dispatch is fully materialized into the installed tree", () => {
  const listed = new Set<string>(RUNTIME_MODULES);
  // The analyst child process is spawned by path, and its Codex overrides
  // register the playtest MCP entry point by path.
  const pending = [
    "runtime/src/cli/provider-agent.ts",
    "runtime/src/playtesting/mcp-main.ts"
  ];
  const visited = new Set<string>();
  const gaps: string[] = [];
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (modulePath === undefined || visited.has(modulePath)) continue;
    visited.add(modulePath);
    if (!listed.has(modulePath))
      gaps.push(`${modulePath} (needed by the playtest analyst dispatch)`);
    for (const target of relativeImports(modulePath))
      if (target.endsWith(".ts")) pending.push(target);
  }
  assert.deepEqual(
    gaps.sort(),
    [],
    `the playtest analyst dispatch must be materialized in full; add these entries to runtime/src/platform/install-materializer.ts:\n${gaps.join("\n")}`
  );
});

test("configuration tools are Runtime-owned behind a workspace export", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(runtimePackage.exports["./config"], "./src/config/index.ts");
  const sourceFiles = [
    "cli-args.ts",
    "compose-user-config.ts",
    "config-files.ts",
    "render-agent-configs.ts",
    "render-bridge-mcp-catalogue.ts",
    "render-execution-contract.ts",
    "render-model-catalog.ts"
  ];
  const runtimeModules = RUNTIME_MODULES as readonly string[];
  for (const filename of sourceFiles) {
    const runtimePath = `runtime/src/config/${filename}`;
    const legacyPath = `src/config/${filename}`;
    assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
    assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
    assert.equal(runtimeModules.includes(runtimePath), true);
    assert.equal(runtimeModules.includes(legacyPath), false);
  }
  assert.equal(existsSync(join(repositoryRoot, "src/config")), false);
  assert.doesNotMatch(
    readFileSync(join(repositoryRoot, "runtime/src/config/index.ts"), "utf8"),
    /\.\.\/\.\.\/\.\.\/src\/config/
  );
});

test("Runtime shared contracts are Runtime-owned and loaded through workspace exports", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };

  const migratedContracts = [
    {
      exportPath: "./shared/provider-limits",
      exportTarget: "./src/shared/provider-limits.ts",
      runtimeFile: "runtime/src/shared/provider-limits.ts",
      legacyFile: "src/shared/provider-limits.ts"
    },
    {
      exportPath: "./shared/tool-names",
      exportTarget: "./src/shared/tool-names.ts",
      runtimeFile: "runtime/src/shared/tool-names.ts",
      legacyFile: "src/shared/tool-names.ts"
    },
    {
      exportPath: "./shared/env",
      exportTarget: "./src/shared/env.ts",
      runtimeFile: "runtime/src/shared/env.ts",
      legacyFile: "src/shared/env.ts"
    },
    {
      exportPath: "./shared/output",
      exportTarget: "./src/shared/output.ts",
      runtimeFile: "runtime/src/shared/output.ts",
      legacyFile: "src/shared/output.ts"
    },
    {
      exportPath: "./shared/executables",
      exportTarget: "./src/shared/executables.ts",
      runtimeFile: "runtime/src/shared/executables.ts",
      legacyFile: "src/shared/executables.ts"
    },
    {
      exportPath: "./shared/resolve-workspace",
      exportTarget: "./src/shared/resolve-workspace.ts",
      runtimeFile: "runtime/src/shared/resolve-workspace.ts",
      legacyFile: "src/shared/resolve-workspace.ts"
    },
    {
      exportPath: "./shared/execution-contract",
      exportTarget: "./src/shared/execution-contract.ts",
      runtimeFile: "runtime/src/shared/execution-contract.ts",
      legacyFile: "src/shared/execution-contract.ts"
    },
    {
      exportPath: "./shared/runtime-source-root",
      exportTarget: "./src/shared/runtime-source-root.ts",
      runtimeFile: "runtime/src/shared/runtime-source-root.ts",
      legacyFile: "src/shared/runtime-source-root.ts"
    },
    {
      exportPath: "./telemetry/resource-context",
      exportTarget: "./src/telemetry/resource-context/index.ts",
      runtimeFile: "runtime/src/telemetry/resource-context/index.ts",
      legacyFile: "src/shared/otel-resource-context.ts"
    },
    {
      exportPath: "./router/cooldown",
      exportTarget: "./src/router/cooldown/index.ts",
      runtimeFile: "runtime/src/router/cooldown/index.ts",
      legacyFile: "src/router/cooldown.ts"
    }
  ];
  for (const contract of migratedContracts) {
    assert.equal(
      runtimePackage.exports[contract.exportPath],
      contract.exportTarget,
      `${contract.exportPath} must expose its Runtime-owned source`
    );
    assert.equal(
      existsSync(join(repositoryRoot, contract.runtimeFile)),
      true,
      `${contract.runtimeFile} must exist`
    );
    assert.equal(
      existsSync(join(repositoryRoot, contract.legacyFile)),
      false,
      `${contract.legacyFile} must be deleted after callers migrate`
    );
    assert.equal(
      (RUNTIME_MODULES as readonly string[]).includes(contract.legacyFile),
      false,
      `${contract.legacyFile} must not be recopied from the legacy install manifest`
    );
  }
  assert.equal(
    existsSync(join(repositoryRoot, "src/shared")),
    false,
    "the legacy root shared layer must be removed once its owners migrate"
  );
});

test("all hooks are Runtime-owned and installed at canonical RuleSync paths", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(runtimePackage.exports["./hooks"], "./src/hooks/index.ts");

  const hookSources = [
    "block-ccc-cli.ts",
    "hook-log.ts",
    "hook-roots.ts",
    "lifecycle.ts",
    "session-start.ts",
    "skill-read-telemetry.ts"
  ];
  const materializedHookSources = new Set([
    "block-ccc-cli.ts",
    "hook-log.ts",
    "hook-roots.ts",
    "session-start.ts",
    "skill-read-telemetry.ts"
  ]);
  const runtimeModules = RUNTIME_MODULES as readonly string[];
  const hookExports = readFileSync(
    join(repositoryRoot, "runtime/src/hooks/index.ts"),
    "utf8"
  );
  for (const name of hookSources) {
    const runtimePath = `runtime/src/hooks/${name}`;
    const legacyPath = `src/hooks/${name}`;
    assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
    assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
    assert.equal(
      runtimeModules.includes(runtimePath),
      materializedHookSources.has(name)
    );
    assert.equal(runtimeModules.includes(legacyPath), false);
    if (name === "skill-read-telemetry.ts") continue;
    assert.ok(hookExports.includes(`from "./${name}"`));
  }
  assert.equal(existsSync(join(repositoryRoot, "src/hooks")), false);
  assert.doesNotMatch(hookExports, /src\/hooks/);
});

test("MCP implementations are Runtime-owned and installed at canonical paths", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(runtimePackage.exports["./mcp"], "./src/mcp/index.ts");

  const mcpModules = [
    "mcp-telemetry.ts",
    "launcher.ts",
    "tool-filter.ts"
  ];
  const runtimeModules = RUNTIME_MODULES as readonly string[];
  const mcpExports = readFileSync(
    join(repositoryRoot, "runtime/src/mcp/index.ts"),
    "utf8"
  );
  for (const name of mcpModules) {
    const runtimePath = `runtime/src/mcp/${name}`;
    const legacyPath = `src/mcp/${name}`;
    assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
    assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
    assert.ok(runtimeModules.includes(runtimePath));
    assert.equal(runtimeModules.includes(legacyPath), false);
    assert.ok(mcpExports.includes(`from "./${name}"`));
  }
  assert.equal(existsSync(join(repositoryRoot, "src/mcp")), false);
  assert.doesNotMatch(mcpExports, /src\/mcp/);
});

test("router events and live feed are Runtime-owned behind workspace subpaths", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const migrations = [
    {
      name: "events",
      exportTarget: "./src/router/events.ts",
      runtimePath: "runtime/src/router/events.ts",
      legacyPath: "src/router/events.ts"
    },
    {
      name: "live-feed",
      exportTarget: "./src/router/live-feed.ts",
      runtimePath: "runtime/src/router/live-feed.ts",
      legacyPath: "src/router/live-feed.ts"
    }
  ];
  const modules = RUNTIME_MODULES as readonly string[];
  for (const migration of migrations) {
    assert.equal(
      runtimePackage.exports[`./router/${migration.name}`],
      migration.exportTarget
    );
    assert.equal(existsSync(join(repositoryRoot, migration.runtimePath)), true);
    assert.equal(existsSync(join(repositoryRoot, migration.legacyPath)), false);
    assert.equal(modules.includes(migration.runtimePath), true);
    assert.equal(modules.includes(migration.legacyPath), false);
  }
});

test("remaining router implementations are Runtime-owned and installed from Runtime sources", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const moduleNames = [
    "http",
    "correlation",
    "proxy",
    "server",
    "subagents",
    "telemetry",
    "usage"
  ];
  const packageExports = new Set([
    "http",
    "correlation",
    "proxy",
    "server",
    "subagents",
    "telemetry",
    "usage"
  ]);
  const modules = RUNTIME_MODULES as readonly string[];
  for (const name of moduleNames) {
    const runtimePath = `runtime/src/router/${name}.ts`;
    const legacyPath = `src/router/${name}.ts`;
    assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
    assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
    assert.ok(modules.includes(runtimePath));
    assert.equal(modules.includes(legacyPath), false);
    if (packageExports.has(name))
      assert.equal(
        runtimePackage.exports[`./router/${name}`],
        `./src/router/${name}.ts`
      );
  }
  assert.equal(existsSync(join(repositoryRoot, "src/router")), false);
  assert.doesNotMatch(
    readFileSync(join(repositoryRoot, "runtime/src/router/index.ts"), "utf8"),
    /\.\.\/\.\.\/\.\.\/src\/router/
  );
});

test("Control API implementation is Runtime-owned outside the model router", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(
    runtimePackage.exports["./control-api"],
    "./src/control-api/request-handler.ts"
  );
  for (const name of [
    "request-handler.ts",
    "body.ts",
    "github.ts"
  ]) {
    const runtimePath = `runtime/src/control-api/${name}`;
    assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
    assert.ok((RUNTIME_MODULES as readonly string[]).includes(runtimePath));
  }
  assert.equal(
    existsSync(join(repositoryRoot, "runtime/src/control-api/index.ts")),
    false,
    "the request handler must have a responsibility-specific filename"
  );
  for (const name of [
    "control-api.ts",
    "control-api-body.ts",
    "memory-control-api.ts"
  ])
    assert.equal(existsSync(join(repositoryRoot, `src/router/${name}`)), false);
  assert.equal(
    "./router/control-api" in runtimePackage.exports,
    false,
    "the control transport must not remain a model-router subpath"
  );
});

test("router routing policy is Runtime-owned behind its workspace subpath", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const runtimePath = "runtime/src/router/routing.ts";
  const legacyPath = "src/router/routing.ts";
  assert.equal(
    runtimePackage.exports["./router/routing"],
    "./src/router/routing.ts"
  );
  assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
  assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(runtimePath),
    true
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(legacyPath),
    false
  );
});

test("router persistence is Runtime-owned behind its workspace subpath", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const runtimePath = "runtime/src/router/persistence/index.ts";
  const legacyPath = "src/router/persistence.ts";
  assert.equal(
    runtimePackage.exports["./router/persistence"],
    "./src/router/persistence/index.ts"
  );
  assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
  assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(runtimePath),
    true
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(legacyPath),
    false
  );
});

test("router authorization is Runtime-owned behind its workspace subpath", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const runtimePath = "runtime/src/router/auth.ts";
  const legacyPath = "src/router/auth.ts";
  assert.equal(runtimePackage.exports["./router/auth"], "./src/router/auth.ts");
  assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
  assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(runtimePath),
    true
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(legacyPath),
    false
  );
});

test("router status projection is Runtime-owned behind its workspace subpath", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const runtimePath = "runtime/src/router/status.ts";
  const legacyPath = "src/router/status.ts";
  assert.equal(
    runtimePackage.exports["./router/status"],
    "./src/router/status.ts"
  );
  assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
  assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(runtimePath),
    true
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(legacyPath),
    false
  );
});

test("router concurrency policy is Runtime-owned behind its workspace subpath", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const runtimePath = "runtime/src/router/concurrency/index.ts";
  const legacyPath = "src/router/concurrency.ts";
  assert.equal(
    runtimePackage.exports["./router/concurrency"],
    "./src/router/concurrency/index.ts"
  );
  assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
  assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(runtimePath),
    true
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(legacyPath),
    false
  );
});

test("dead MCP process-registry module is removed", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const modules = RUNTIME_MODULES as readonly string[];
  assert.equal("./mcp/process-registry" in runtimePackage.exports, false);
  assert.equal(
    existsSync(join(repositoryRoot, "runtime/src/mcp/process-registry.ts")),
    false
  );
  assert.equal(
    existsSync(join(repositoryRoot, "src/router/mcp-process-registry.ts")),
    false
  );
  assert.equal(modules.includes("runtime/src/mcp/process-registry.ts"), false);
  assert.equal(modules.includes("runtime/src/shared/role-prompts.ts"), true);
});

test("CLI implementations are Runtime-owned behind workspace subpaths", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const cliFiles = [
    "autodev.ts",
    "hook.ts",
    "index.ts",
    "install.ts",
    "provider-agent.ts",
    "provider.ts",
    "repo.ts",
    "router-status-client.ts",
    "router-status.ts",
    "router.ts",
    "runtime.ts"
  ];
  for (const filename of cliFiles) {
    assert.equal(
      existsSync(join(repositoryRoot, "runtime/src/cli", filename)),
      true
    );
    assert.equal(existsSync(join(repositoryRoot, "src/cli", filename)), false);
  }
  assert.equal(runtimePackage.exports["./cli"], "./src/cli/index.ts");
  assert.equal(
    runtimePackage.exports["./cli/provider-agent"],
    "./src/cli/provider-agent.ts"
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(
      "runtime/src/cli/router-status.ts"
    ),
    true
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(
      "runtime/src/cli/router-status-client.ts"
    ),
    true
  );
  assert.equal(existsSync(join(repositoryRoot, "src")), false);
});

test("platform host and installation primitives are Runtime-owned behind package subpaths", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const migrations = [
    {
      name: "host-arch",
      runtimePath: "runtime/src/platform/host-arch.ts",
      legacyPath: "src/platform/host-arch.ts",
      exportTarget: "./src/platform/host-arch.ts"
    },
    {
      name: "launchagent",
      runtimePath: "runtime/src/platform/macos/launchagent.ts",
      legacyPath: "src/platform/macos/launchagent.ts",
      exportTarget: "./src/platform/macos/launchagent.ts"
    },
    {
      name: "launchd",
      runtimePath: "runtime/src/platform/macos/launchd.ts",
      legacyPath: "src/platform/macos/launchd.ts",
      exportTarget: "./src/platform/macos/launchd.ts"
    },
    {
      name: "runtime-files",
      runtimePath: "runtime/src/platform/runtime-files.ts",
      legacyPath: "src/platform/runtime-files.ts",
      exportTarget: "./src/platform/runtime-files.ts"
    },
    {
      name: "runtime-reconciliation",
      runtimePath: "runtime/src/platform/runtime-reconciliation.ts",
      legacyPath: "src/platform/runtime-reconciliation.ts",
      exportTarget: "./src/platform/runtime-reconciliation.ts"
    },
    {
      name: "code-graph-ensure",
      runtimePath: "runtime/src/platform/code-graph-ensure.ts",
      legacyPath: "src/platform/code-graph-ensure.ts",
      exportTarget: "./src/platform/code-graph-ensure.ts"
    },
    {
      name: "router-ensure",
      runtimePath: "runtime/src/platform/router-ensure.ts",
      legacyPath: "src/platform/router-ensure.ts",
      exportTarget: "./src/platform/router-ensure.ts"
    },
    {
      name: "install-state",
      runtimePath: "runtime/src/platform/install-state.ts",
      legacyPath: "src/platform/install-state.ts",
      exportTarget: "./src/platform/install-state.ts"
    },
    {
      name: "service-restart",
      runtimePath: "runtime/src/platform/service-restart.ts",
      legacyPath: "src/platform/service-restart.ts",
      exportTarget: "./src/platform/service-restart.ts"
    },
    {
      name: "antigravity-settings",
      runtimePath: "runtime/src/platform/antigravity-settings.ts",
      legacyPath: "src/platform/antigravity-settings.ts",
      exportTarget: "./src/platform/antigravity-settings.ts"
    },
    {
      name: "dependencies",
      runtimePath: "runtime/src/platform/dependencies.ts",
      legacyPath: "src/platform/dependencies.ts",
      exportTarget: "./src/platform/dependencies.ts"
    },
    {
      name: "install-check",
      runtimePath: "runtime/src/platform/install-check.ts",
      legacyPath: "src/platform/install-check.ts",
      exportTarget: "./src/platform/install-check.ts"
    },
    {
      name: "install-command",
      runtimePath: "runtime/src/platform/install-command.ts",
      legacyPath: "src/platform/install-command.ts",
      exportTarget: "./src/platform/install-command.ts"
    },
    {
      name: "install-materializer",
      runtimePath: "runtime/src/platform/install-materializer.ts",
      legacyPath: "src/platform/install-materializer.ts",
      exportTarget: "./src/platform/install-materializer.ts"
    }
  ];
  const modules = RUNTIME_MODULES as readonly string[];
  for (const migration of migrations) {
    assert.equal(
      runtimePackage.exports[`./platform/${migration.name}`],
      migration.exportTarget
    );
    assert.equal(existsSync(join(repositoryRoot, migration.runtimePath)), true);
    assert.equal(existsSync(join(repositoryRoot, migration.legacyPath)), false);
    assert.ok(modules.includes(migration.runtimePath));
    assert.equal(modules.includes(migration.legacyPath), false);
  }
  assert.doesNotMatch(
    readFileSync(join(repositoryRoot, "runtime/src/platform/index.ts"), "utf8"),
    /\.\.\/\.\.\/\.\.\/src\/platform/
  );
});

test("Agents implementations are Runtime-owned behind the workspace package", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(runtimePackage.exports["./agents"], "./src/agents/index.ts");

  const agentFiles = [
    "agent-activity.ts",
    "role-mcp-environment.ts"
  ];
  const runtimeModules = RUNTIME_MODULES as readonly string[];
  const agentsIndex = readFileSync(
    join(repositoryRoot, "runtime/src/agents/index.ts"),
    "utf8"
  );
  for (const filename of agentFiles) {
    const runtimePath = `runtime/src/agents/${filename}`;
    const legacyPath = `src/agents/${filename}`;
    assert.equal(existsSync(join(repositoryRoot, runtimePath)), true);
    assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
    assert.equal(runtimeModules.includes(runtimePath), true);
    assert.equal(runtimeModules.includes(legacyPath), false);
    assert.ok(agentsIndex.includes(`from "./${filename}"`));
  }
  assert.equal(existsSync(join(repositoryRoot, "src/agents")), false);
  assert.doesNotMatch(agentsIndex, /src\/agents/);
});

test("opencli provider implementation is Runtime-owned behind workspace exports", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const runtimeProviders = readFileSync(
    join(repositoryRoot, "runtime/src/providers/index.ts"),
    "utf8"
  );

  const runtimeProviderPath = "runtime/src/providers/opencli.ts";
  const legacyProviderPath = "src/providers/opencli.ts";
  assert.equal(
    runtimePackage.exports["./providers/opencli"],
    "./src/providers/opencli.ts"
  );
  assert.equal(existsSync(join(repositoryRoot, runtimeProviderPath)), true);
  assert.equal(existsSync(join(repositoryRoot, legacyProviderPath)), false);
  assert.ok(
    (RUNTIME_MODULES as readonly string[]).includes(runtimeProviderPath)
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(legacyProviderPath),
    false
  );
  assert.ok(runtimeProviders.includes('export * as opencli from "./opencli.ts";'));
  assert.equal(existsSync(join(repositoryRoot, "src/providers")), false);
});

test("telemetry helpers are Runtime-owned behind the telemetry workspace export", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(
    runtimePackage.exports["./telemetry"],
    "./src/telemetry/index.ts"
  );
  assert.equal(
    existsSync(join(repositoryRoot, "runtime/src/telemetry/agent-events.ts")),
    true
  );
  assert.equal(
    existsSync(join(repositoryRoot, "runtime/src/telemetry/github-metrics.ts")),
    true
  );
  assert.equal(existsSync(join(repositoryRoot, "src/telemetry")), false);
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).some((entry) =>
      entry.startsWith("src/telemetry/")
    ),
    false,
    "Runtime telemetry must resolve through CODEX_HOME/node_modules, not copied legacy source"
  );
  assert.match(
    readFileSync(
      join(repositoryRoot, "runtime/src/telemetry/index.ts"),
      "utf8"
    ),
    /from "\.\/agent-events\.ts"/
  );
});

test("retired router memory, bridge, and tool-call-ownership paths are decommissioned", () => {
  const runtimeModules = RUNTIME_MODULES as readonly string[];
  for (const retiredPath of [
    "runtime/src/router/memory/index.ts",
    "runtime/src/router/tool-call-ownership/index.ts",
    "runtime/src/memory/index.ts",
    "runtime/src/providers/claude.ts",
    "runtime/src/providers/antigravity.ts",
    "runtime/src/providers/copilot.ts",
    "runtime/src/providers/minimax.ts"
  ]) {
    assert.equal(existsSync(join(repositoryRoot, retiredPath)), false);
    assert.equal(runtimeModules.includes(retiredPath), false);
  }
});

test("router lifecycle is Runtime-owned and loaded through its workspace export", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(
    runtimePackage.exports["./router/lifecycle"],
    "./src/router/lifecycle/index.ts"
  );
  assert.ok(
    existsSync(join(repositoryRoot, "runtime/src/router/lifecycle/index.ts"))
  );
  assert.equal(
    existsSync(join(repositoryRoot, "src/router/lifecycle.ts")),
    false
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes("src/router/lifecycle.ts"),
    false
  );
});

test("router dashboard and chart.js are decommissioned from runtime modules", () => {
  const runtimeModules = RUNTIME_MODULES as readonly string[];
  assert.equal(runtimeModules.includes("src/router/dashboard.html"), false);
  assert.equal(
    runtimeModules.includes("node_modules/chart.js/dist/chart.umd.min.js"),
    false
  );
  assert.equal(
    runtimeModules.includes("src/router/lookback-aggregator.ts"),
    false
  );
  assert.equal(
    existsSync(
      join(repositoryRoot, "scripts/codex-model-router-dashboard.html")
    ),
    false
  );
  assert.equal(OBSOLETE_DASHBOARD, "codex-model-router-dashboard.html");
});

test("unused chart.js is absent from root application dependencies", () => {
  const rootPackage = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8")
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  assert.equal(rootPackage.dependencies?.["chart.js"], undefined);
  assert.equal(rootPackage.devDependencies?.["chart.js"], undefined);
});

test("obsolete Claude quota snapshots are removed from CODEX_HOME", () => {
  assert.deepEqual(OBSOLETE_RUNTIME_DATA_FILES, [
    join("run", "claude-rate-limit.json")
  ]);
  const materializer = readFileSync(
    join(repositoryRoot, "runtime/src/platform/install-materializer.ts"),
    "utf8"
  );
  assert.match(
    materializer,
    /OBSOLETE_RUNTIME_DATA_FILES\.map\(\(filePath\) =>[\s\S]*path\.join\(codexHome, filePath\)/
  );
});

test("AutoDev standalone OTel Collector is decommissioned with no replacement sidecar", () => {
  const runtimeModules = RUNTIME_MODULES as readonly string[];

  // Repository no longer contains any AutoDev-owned standalone Collector
  // implementation, provisioning, configuration, scripts, or LaunchAgent.
  const removedAutoDevFiles = [
    "runtime/src/platform/otel-collector.ts",
    "runtime/src/platform/otel-provision.ts",
    "config/otel/collector.yaml",
    "config/otel/collector.version",
    "config/otel/collector-artifacts.json",
    "scripts/otel/ensure-autodev-otel-collector.sh",
    "scripts/otel/provision-autodev-otel-collector.sh",
    "scripts/otel/run-autodev-otel-collector.sh",
    "config/launchagents/com.codex.otel-collector.plist"
  ];
  for (const filePath of removedAutoDevFiles) {
    assert.equal(
      existsSync(join(repositoryRoot, filePath)),
      false,
      `${filePath} must not be reintroduced as a replacement sidecar`
    );
    assert.equal(
      runtimeModules.includes(filePath),
      false,
      `${filePath} must not be reinstalled from a Runtime manifest entry`
    );
  }

  const collectorLabel = "com.codex.otel-collector" as const;
  assert.equal(
    (LAUNCH_LABELS as readonly string[]).includes(collectorLabel),
    false,
    "the deleted Collector LaunchAgent must not be rendered"
  );
  assert.ok(
    OBSOLETE_LAUNCH.includes(collectorLabel),
    "old Collector launchd state must still be unloaded once during migration"
  );
  const materializer = readFileSync(
    join(repositoryRoot, "runtime/src/platform/install-materializer.ts"),
    "utf8"
  );
  assert.match(
    materializer,
    /OBSOLETE_LAUNCH\.map\(\(label\) =>[\s\S]*?path\.join\(home, "Library", "LaunchAgents", `\$\{label\}\.plist`\)/,
    "stale Collector plist files under LaunchAgents must be removed"
  );
  assert.match(materializer, /OBSOLETE_COLLECTOR_HOOKS\.map/);
  assert.match(materializer, /autodev-otel-collector\.pid/);
  // The installer must not reintroduce the sidecar Collector sources in any
  // install manifest.
  assert.doesNotMatch(
    materializer,
    /"scripts\/otel\//,
    "Install manifest must not reintroduce any scripts/otel/ Collector source"
  );
  assert.doesNotMatch(
    materializer,
    /"runtime\/src\/platform\/otel-(?:collector|provision)\.ts"/,
    "Install manifest must not reintroduce otel-collector or otel-provision sources"
  );

  assert.match(materializer, /bootoutObsoleteLaunchLabels\(launchd\)/);
});

test("installed sources use dependencies from their owning workspace", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { name: string; dependencies?: Record<string, string> };
  const rootPackage = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };
  const rootDependencies = new Set(Object.keys(rootPackage.dependencies ?? {}));
  const runtimeDependencies = new Set(
    Object.keys(runtimePackage.dependencies ?? {})
  );

  for (const modulePath of RUNTIME_MODULES)
    assertInstalledSourceDependencies(
      modulePath,
      rootDependencies,
      runtimeDependencies,
      runtimePackage.name
    );
});

test("the CODEX_HOME copy resolves every bare import through a linked node_modules", () => {
  // `$CODEX_HOME` is not the repository, so a copied module resolves packages
  // only by walking up from its installed directory through node_modules trees
  // that actually exist there. Model that walk: a node_modules directory
  // inside CODEX_HOME exists only where the installer links one, and it
  // resolves to its link source. Driven by nodeModuleLinks() so that dropping
  // or misplacing a link fails here rather than crash-looping a supervised
  // service -- the router ran for a day on ERR_MODULE_NOT_FOUND for `zod`,
  // which resolves in the repository and not in the mirror.
  const codexHome = join(repositoryRoot, "codex-home");
  const links = new Map(
    nodeModuleLinks({ repositoryRoot, codexHome }).map(({ source, target }) => [
      target,
      source
    ])
  );
  const resolvesFromInstalledPath = (
    installedPath: string,
    packageName: string
  ): boolean => {
    let directory = dirname(installedPath);
    while (
      directory === codexHome ||
      directory.startsWith(`${codexHome}${sep}`)
    ) {
      const linkSource = links.get(join(directory, "node_modules"));
      if (linkSource && existsSync(join(linkSource, packageName))) return true;
      directory = dirname(directory);
    }
    return false;
  };

  const unresolvable: string[] = [];
  for (const modulePath of RUNTIME_MODULES) {
    if (!modulePath.endsWith(".ts")) continue;
    const installedPath = runtimeTarget(modulePath, codexHome);
    for (const packageName of packageImports(
      readFileSync(join(repositoryRoot, modulePath), "utf8")
    ))
      if (!resolvesFromInstalledPath(installedPath, packageName))
        unresolvable.push(
          `${modulePath} -> ${installedPath} imports "${packageName}"`
        );
  }
  assert.deepEqual(
    unresolvable.sort(),
    [],
    `installed sources cannot resolve these packages from CODEX_HOME; link each owning package's node_modules where the mirror will walk through it:\n${unresolvable.join("\n")}`
  );
});
