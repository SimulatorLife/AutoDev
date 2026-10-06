import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.join(import.meta.dirname, "..", "..");

function source(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

// Walk the tree rather than reading `git ls-files`, so a module that has been
// added but not yet committed is still policed.
function typescriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...typescriptFiles(child));
    else if (entry.name.endsWith(".ts")) {
      found.push(path.relative(repositoryRoot, child));
    }
  }
  return found.sort();
}

test("no router module re-exports a symbol owned by another module", () => {
  // `http.ts` used to hand out `proxy.ts`'s response helpers with no consumer
  // at all, and `subagents.ts`/`server.ts` passed through a concurrency and a
  // routing constant, so every consumer had two documented import paths for
  // one value. A single-symbol `export { X } from "..."` is the shape that
  // creates that: it advertises a second home for a value without saying which
  // module owns it.
  //
  // Deliberately narrower than "no re-exports". `index.ts` and `server.ts`
  // are aggregators -- `cli/router.ts` imports the server surface through the
  // latter -- so wholesale re-export blocks in those two are the pattern, not
  // the problem.
  //
  // This scans the whole subtree rather than a fixed list of files: an earlier
  // version checked three specific (file, pattern) pairs and reported clean
  // while a pass-through sat reintroduced in a fourth file.
  const oneOffAlias = /^export \{[^}]*\} from "(?:\.\.?\/|@simulatorlife\/)/mu;
  const aggregators = [
    path.join("router", "index.ts"),
    path.join("router", "server.ts")
  ];

  const offenders = typescriptFiles(
    path.join(repositoryRoot, "runtime/src/router")
  )
    .filter((file) => !aggregators.some((name) => file.endsWith(name)))
    .filter((file) => oneOffAlias.test(source(file)));

  assert.deepEqual(offenders, []);
});

test("the owning module is still where each narrowed symbol is declared", () => {
  // Narrowing the export is only safe while the owning path keeps working.
  assert.match(
    source("runtime/src/router/concurrency/index.ts"),
    /export const PROCESS_FALLBACK_SESSION_KEY = "process-scope";/u
  );
  assert.match(
    source("runtime/src/router/routing.ts"),
    /export const ORCHESTRATOR_ALIAS = /u
  );
  assert.match(
    source("runtime/src/router/subagents.ts"),
    /import \{[^}]*\} from "@simulatorlife\/autodev-runtime\/router\/concurrency";/su
  );
  assert.match(source("runtime/src/router/http.ts"), /from "\.\/proxy\.ts";/su);
});

test("tests import pass-throughed constants from the module that owns them", () => {
  // A constant reachable from two modules is two places to look and two
  // places to change. Tests are the consumers that made these look public.
  assert.match(
    source("tests/router/subagents.test.ts"),
    /PROCESS_FALLBACK_SESSION_KEY[^}]*\} from "@simulatorlife\/autodev-runtime\/router\/concurrency";/su
  );
  assert.match(
    source("tests/router/model-router.test.ts"),
    /ORCHESTRATOR_ALIAS[^}]*\} from "@simulatorlife\/autodev-runtime\/router\/routing";/su
  );
});
