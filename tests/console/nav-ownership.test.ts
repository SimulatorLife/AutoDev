import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.join(import.meta.dirname, "..", "..");

function source(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

/**
 * A file's code with its comments removed.
 *
 * Comments are stripped before asking whether a file *uses* the symbol, so a
 * module that merely documents the convention is not reported as a consumer
 * that bypassed the owner. `tests/console-internal-links.test.ts` is exactly
 * that: it explains what `canonicalNavPath` builds without importing it.
 * A guard that reports its own documentation is a guard people turn off.
 * `//` is only treated as a comment when it is not preceded by `:` so a URL in
 * a string literal does not truncate the line.
 */
function code(relativePath: string): string {
  return source(relativePath)
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// Walk the tree rather than reading `git ls-files`, so a module that has been
// added but not yet committed is still policed.
function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(child));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      found.push(path.relative(repositoryRoot, child));
    }
  }
  return found.sort();
}

test("no Console module re-exports a symbol owned by another module", () => {
  // `AppNav.ts` used to re-export `canonicalNavPath`, which is declared in
  // `lib/routes.ts`. Nothing consumed it through that path -- the tests import
  // it from `lib/routes.ts` directly -- but `console/src/index.ts` does
  // `export * from "./components/navigation/AppNav.ts"`, so the pass-through
  // silently widened the public barrel with a second documented home for a
  // value whose owner is a different module. A one-symbol `export { X } from
  // "..."` is the shape that creates that.
  //
  // Deliberately narrower than "no re-exports": `src/index.ts` is the
  // aggregator -- its whole job is the public surface -- so wholesale
  // `export *` blocks are the pattern, not the problem.
  //
  // Matches both quote styles: a single-style regex silently misses a
  // violation written the other way, and the point of the guard is that the
  // next person cannot reintroduce this.
  const oneOffAlias =
    /^export \{[^}]*\} from ["'](?:\.\.?\/|@simulatorlife\/)/mu;
  const aggregator = path.join("console", "src", "index.ts");

  const offenders = sourceFiles(path.join(repositoryRoot, "console", "src"))
    .filter((file) => !file.endsWith(aggregator))
    .filter((file) => oneOffAlias.test(source(file)));

  assert.deepEqual(offenders, []);
});

test("canonicalNavPath stays owned by lib/routes.ts and AppNav imports it", () => {
  // Removing the pass-through is only safe while the owning path keeps working:
  // AppNav still needs the value to build nav hrefs, and it must get it from
  // the module that declares it.
  assert.match(
    source("console/src/lib/routes.ts"),
    /export function canonicalNavPath\(section: CanonicalNavSection\): string \{/u
  );
  assert.match(
    source("console/src/components/navigation/AppNav.ts"),
    /import \{ canonicalNavPath \} from "\.\.\/\.\.\/lib\/routes\.ts";/u
  );
  assert.match(
    source("console/src/components/navigation/AppNav.ts"),
    /const href = canonicalNavPath\(section\);/u
  );
});

test("the public barrel no longer reaches canonicalNavPath through AppNav", () => {
  // `src/index.ts` still aggregates AppNav for its component exports -- that is
  // the aggregator doing its job. What must not come back is the component
  // exporting the route helper, which would put a second home for
  // `canonicalNavPath` straight back on the public surface.
  const barrel = source("console/src/index.ts");
  assert.match(
    barrel,
    /export \* from "\.\/components\/navigation\/AppNav\.ts";/u
  );

  const appNav = source("console/src/components/navigation/AppNav.ts");
  // Both quote styles, and the multi-line `export {\n  x\n} from "..."` form:
  // `[^}]*` spans newlines, so a reformatted pass-through still trips this.
  assert.doesNotMatch(
    appNav,
    /export\s*\{[^}]*canonicalNavPath[^}]*\}\s*from\s*["']/u
  );
});

test("every canonicalNavPath consumer imports it from the owning module", () => {
  // This is the "callers import from the true owner" half of the migration,
  // written as an invariant over the tree instead of a pin on one test file's
  // exact import layout: whichever module names `canonicalNavPath`, the one
  // place it may be imported from is `lib/routes.ts`. That also stops the
  // pass-through from quietly becoming real again by attracting a consumer.
  const owner = path.join("console", "src", "lib", "routes.ts");
  const fromOwner =
    /canonicalNavPath[^;]*from\s*["'][^"']*lib\/routes\.ts["']/su;

  const consumers = [
    ...sourceFiles(path.join(repositoryRoot, "console")),
    ...sourceFiles(path.join(repositoryRoot, "tests"))
  ]
    .filter((file) => !file.endsWith(owner))
    // This file matches the symbol in its own regex patterns, which is
    // executable code rather than documentation, so stripping comments does not
    // remove it and it would otherwise report itself as a consumer that
    // skipped the owner.
    .filter(
      (file) =>
        !file.endsWith(path.join("tests", "console", "nav-ownership.test.ts"))
    )
    .filter((file) => code(file).includes("canonicalNavPath"));

  assert.ok(consumers.length > 0, "expected at least one real consumer");
  for (const file of consumers) {
    assert.match(
      code(file),
      fromOwner,
      `${file} must import it from lib/routes.ts`
    );
  }
});
