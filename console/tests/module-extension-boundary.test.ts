import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A module that Node loads may not carry JSX.
 *
 * The Console's unit tests load the module graph directly: `node --test`
 * imports the module under test, and the module imports what it needs. Node's
 * type stripping reads `.ts` and gives the types back, but it does not carry
 * JSX, so a `.tsx` module is a file Node cannot load at all --
 * `ERR_UNKNOWN_FILE_EXTENSION`.
 *
 * The failure is not where it looks. The `.tsx` module is fine, because the
 * build compiles it, and so is the module that imports it. What breaks is
 * every test that imports the *importer*: nine test files went down with
 * `ERR_UNKNOWN_FILE_EXTENSION` when the shell's header began to render the
 * command palette, and the error named the palette rather than the shell that
 * imported it.
 *
 * So the rule is at the import. A `.ts` module may not import a `.tsx` one.
 * A `.tsx` module may: the build reads it, and the module graph the tests
 * load never has to reach it.
 */

/** The source roots the Console's own code lives in. */
const SOURCE_ROOTS = ["src", "app", "tests"];

/**
 * An import of a module that carries JSX.
 *
 * Read from the source rather than from the resolver, because the resolver
 * is the thing that fails -- and the file it fails on is not the file that
 * made the mistake.
 */
const TSX_IMPORT =
  /from\s+["'][^"']*\.tsx["']|import\s*\(?["'][^"']*\.tsx["']/u;

/**
 * The source without its comments.
 *
 * A comment that names a `.tsx` import is a comment, and a guard that reads
 * one as an import reports a file that has done nothing.
 */
function withoutComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/(^|[^:])\/\/.*$/gmu, "$1");
}

function consoleSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...consoleSources(path));
      continue;
    }
    if (extname(entry.name) === ".ts") {
      found.push(path);
    }
  }
  return found;
}

test("a module Node loads may not import a module that carries JSX", () => {
  const consoleRoot = fileURLToPath(new URL("../", import.meta.url));
  const offenders: string[] = [];
  for (const root of SOURCE_ROOTS) {
    for (const path of consoleSources(join(consoleRoot, root))) {
      const relativePath = relative(consoleRoot, path).split("\\").join("/");
      const source = withoutComments(readFileSync(path, "utf8"));
      if (!TSX_IMPORT.test(source)) continue;
      offenders.push(relativePath);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a .ts module may not import a .tsx module: Node cannot load JSX, so every " +
      "test that imports the .ts module fails with ERR_UNKNOWN_FILE_EXTENSION"
  );
});
