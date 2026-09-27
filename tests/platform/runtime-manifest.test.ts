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

test("router dashboard ships beside the router and removes its former hooks copy", () => {
  assert.ok(RUNTIME_MODULES.includes("src/router/dashboard.html"));
  assert.ok(
    RUNTIME_MODULES.includes("node_modules/chart.js/dist/chart.umd.min.js")
  );
  assert.equal(
    existsSync(
      join(repositoryRoot, "scripts/codex-model-router-dashboard.html")
    ),
    false
  );
  assert.equal(OBSOLETE_DASHBOARD, "codex-model-router-dashboard.html");
});
