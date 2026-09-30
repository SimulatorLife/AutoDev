import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OBSOLETE_DASHBOARD,
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

test("router dashboard and chart.js are decommissioned from runtime modules", () => {
  assert.equal(RUNTIME_MODULES.includes("src/router/dashboard.html"), false);
  assert.equal(
    RUNTIME_MODULES.includes("node_modules/chart.js/dist/chart.umd.min.js"),
    false
  );
  assert.equal(
    RUNTIME_MODULES.includes("src/router/lookback-aggregator.ts"),
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
