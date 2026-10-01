import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OBSOLETE_DASHBOARD,
  OBSOLETE_RUNTIME_MODULES,
  OTEL_RUNTIME,
  RUNTIME_MODULES
} from "../../src/platform/install-materializer.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const STATIC_IMPORT_PATTERN =
  /(?:^|\n)\s*(?:import|export)\b[\s\S]*?\bfrom\s+["'](\.[^"']+)["']/gu;
const SIDE_EFFECT_IMPORT_PATTERN = /(?:^|\n)\s*import\s+["'](\.[^"']+)["']/gu;
const DYNAMIC_IMPORT_PATTERN = /import\(\s*["'](\.[^"']+)["']\s*\)/gu;

function relativeImports(modulePath: string): string[] {
  const source = readFileSync(join(repositoryRoot, modulePath), "utf8");
  const directory = dirname(modulePath);
  return [
    ...source.matchAll(STATIC_IMPORT_PATTERN),
    ...source.matchAll(SIDE_EFFECT_IMPORT_PATTERN),
    ...source.matchAll(DYNAMIC_IMPORT_PATTERN)
  ].map((match) => normalize(join(directory, match[1] ?? "")));
}

test("every manifest entry exists in the repository", () => {
  const absent = [...RUNTIME_MODULES, ...OTEL_RUNTIME].filter(
    (modulePath) => !existsSync(join(repositoryRoot, modulePath))
  );
  assert.deepEqual(
    absent,
    [],
    `manifest lists files that do not exist:\n${absent.join("\n")}`
  );
});

test("installer removes stale CODEX_HOME copies of Runtime-owned source", () => {
  const runtimeModules = RUNTIME_MODULES as readonly string[];
  const obsoleteModules = OBSOLETE_RUNTIME_MODULES as readonly string[];
  assert.equal(obsoleteModules.length, 14);
  for (const legacyPath of obsoleteModules) {
    assert.equal(existsSync(join(repositoryRoot, legacyPath)), false);
    assert.equal(runtimeModules.includes(legacyPath), false);
  }
  const materializer = readFileSync(
    join(repositoryRoot, "src/platform/install-materializer.ts"),
    "utf8"
  );
  assert.match(materializer, /OBSOLETE_RUNTIME_MODULES\.map/);
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
    `RUNTIME_MODULES is not self-contained; add these entries to src/platform/install-materializer.ts:\n${gaps.join("\n")}`
  );
});

test("config CLI parsing and config-file I/O have distinct runtime owners", () => {
  assert.ok(RUNTIME_MODULES.includes("src/config/cli-args.ts"));
  assert.ok(RUNTIME_MODULES.includes("src/config/config-files.ts"));
  assert.equal(existsSync(join(repositoryRoot, "src/config/toml.ts")), false);
});

test("Runtime shared contracts are Runtime-owned and loaded through workspace exports", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(
    runtimePackage.exports["./shared/agent-context-headers"],
    "./src/shared/agent-context-headers.ts"
  );
  assert.ok(
    existsSync(
      join(repositoryRoot, "runtime/src/shared/agent-context-headers.ts")
    )
  );

  const migratedContracts = [
    {
      exportPath: "./shared/responses-continuation",
      exportTarget: "./src/shared/responses-continuation.ts",
      runtimeFile: "runtime/src/shared/responses-continuation.ts",
      legacyFile: "src/shared/responses-continuation.ts"
    },
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
      exportPath: "./shared/agent-context-headers",
      exportTarget: "./src/shared/agent-context-headers.ts",
      runtimeFile: "runtime/src/shared/agent-context-headers.ts",
      legacyFile: "src/shared/agent-context-headers.ts"
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
      exportPath: "./shared/responses-item-ids",
      exportTarget: "./src/shared/responses-item-ids.ts",
      runtimeFile: "runtime/src/shared/responses-item-ids.ts",
      legacyFile: "src/shared/responses-item-ids.ts"
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
    "command-utils.ts",
    "lifecycle.ts",
    "memory-session-end.ts",
    "root-delegation.ts",
    "session-start.ts",
    "skill-read-telemetry.ts",
    "subagent-start.ts"
  ];
  const materializedHookSources = new Set([
    "block-ccc-cli.ts",
    "command-utils.ts",
    "memory-session-end.ts",
    "root-delegation.ts",
    "session-start.ts",
    "skill-read-telemetry.ts",
    "subagent-start.ts"
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

test("migrated provider implementations are Runtime-owned behind workspace exports", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  const runtimeProviders = readFileSync(
    join(repositoryRoot, "runtime/src/providers/index.ts"),
    "utf8"
  );

  for (const provider of ["copilot", "minimax"]) {
    const runtimeProviderPath = `runtime/src/providers/${provider}.ts`;
    const legacyProviderPath = `src/providers/${provider}.ts`;
    assert.equal(
      runtimePackage.exports[`./providers/${provider}`],
      `./src/providers/${provider}.ts`
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
    assert.ok(
      runtimeProviders.includes(
        `export * as ${provider} from "./${provider}.ts";`
      )
    );
  }
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

test("tool-call ownership is Runtime-owned and imported through its workspace subpath", () => {
  const runtimePackage = JSON.parse(
    readFileSync(join(repositoryRoot, "runtime/package.json"), "utf8")
  ) as { exports: Record<string, string> };
  assert.equal(
    runtimePackage.exports["./router/tool-call-ownership"],
    "./src/router/tool-call-ownership/index.ts"
  );
  assert.ok(
    existsSync(
      join(repositoryRoot, "runtime/src/router/tool-call-ownership/index.ts")
    )
  );
  assert.equal(
    existsSync(join(repositoryRoot, "src/router/tool-call-ownership.ts")),
    false
  );
  assert.equal(
    (RUNTIME_MODULES as readonly string[]).includes(
      "src/router/tool-call-ownership.ts"
    ),
    false
  );
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

test("runtime package dependencies imported by RUNTIME_MODULES exist in package dependencies and node_modules", () => {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8")
  );
  const declaredDependencies = new Set(
    Object.keys(packageJson.dependencies ?? {})
  );

  const BARE_IMPORT_PATTERN =
    /(?:^|\n)\s*(?:import|export)\b[\s\S]*?\bfrom\s+["']([^."'\n\r][^"'\n\r]*)["']/gu;

  const importedPackages = new Set<string>();
  for (const modulePath of RUNTIME_MODULES) {
    if (!modulePath.endsWith(".ts")) continue;
    const content = readFileSync(
      join(repositoryRoot, modulePath),
      "utf8"
    ).replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*/gu, "");
    for (const match of content.matchAll(BARE_IMPORT_PATTERN)) {
      const specifier = match[1]!;
      if (specifier.startsWith("node:")) continue;
      const parts = specifier.split("/");
      const packageName = specifier.startsWith("@")
        ? parts.slice(0, 2).join("/")
        : parts[0]!;
      importedPackages.add(packageName);
    }
  }

  for (const pkg of importedPackages) {
    assert.ok(
      declaredDependencies.has(pkg),
      `RUNTIME_MODULES imports "${pkg}" but it is not listed in package.json dependencies`
    );
    assert.ok(
      existsSync(join(repositoryRoot, "node_modules", pkg)),
      `runtime package "${pkg}" is missing from repository node_modules`
    );
  }
});
