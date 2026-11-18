import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const CONSOLE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const ACTIVE_RUNS_DIR = path.join(
  CONSOLE_ROOT,
  "src",
  "features",
  "playtesting",
  "active-runs"
);
const ACTIVE_RUNS_INDEX = path.join(ACTIVE_RUNS_DIR, "index.ts");

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

const SPECIFIER_PATTERN =
  /(?:from|import\s*\()\s*["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gmu;

test("external console/src and console/app callers only import active-runs via index.ts", () => {
  const sourceFiles = [
    ...collectSourceFiles(path.join(CONSOLE_ROOT, "src")),
    ...collectSourceFiles(path.join(CONSOLE_ROOT, "app"))
  ].filter(
    (filePath) =>
      filePath !== ACTIVE_RUNS_DIR &&
      !filePath.startsWith(`${ACTIVE_RUNS_DIR}${path.sep}`)
  );

  const violations: string[] = [];
  for (const filePath of sourceFiles) {
    const source = readFileSync(filePath, "utf8");
    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (!specifier || !specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(filePath), specifier);
      if (
        (resolved === ACTIVE_RUNS_DIR ||
          resolved.startsWith(`${ACTIVE_RUNS_DIR}${path.sep}`)) &&
        resolved !== ACTIVE_RUNS_INDEX
      ) {
        violations.push(
          `${path.relative(CONSOLE_ROOT, filePath)} imports ${specifier}`
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    "files outside active-runs/ must import from active-runs/index.ts only"
  );
});
