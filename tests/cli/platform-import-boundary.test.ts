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

const platformRoot = path.join("runtime", "src", "platform");
const deepPlatformImport =
  /from\s+["']@simulatorlife\/autodev-runtime\/platform\//u;
const platformEntry =
  /from\s+["']@simulatorlife\/autodev-runtime\/platform["']/u;

test("nothing outside platform imports a platform implementation file by path", () => {
  // `./platform` re-exports every platform module, so a consumer can depend on
  // the published surface without naming a file inside it. Naming
  // `platform/install-check` instead couples the consumer to platform's file
  // layout: rename or split that module and the consumer breaks even though
  // the platform entry still exports the same symbol. The exports map still
  // needs its per-module entries -- tests/platform/runtime-manifest.test.ts
  // asserts them for the materialized CODEX_HOME tree -- this is about who
  // imports them, not whether they exist.
  const offenders = typescriptFiles(path.join(repositoryRoot, "runtime", "src"))
    .filter((file) => !file.startsWith(platformRoot))
    .filter((file) => deepPlatformImport.test(source(file)));

  assert.deepEqual(offenders, []);
});

test("the CLI reaches install and router-ensure through the platform entry", () => {
  // `hooks/` already consumed the facade (lifecycle, session-start,
  // subagent-start); the CLI was the only layer naming platform internals.
  for (const file of [
    "runtime/src/cli/install.ts",
    "runtime/src/cli/provider-agent.ts"
  ]) {
    assert.match(
      source(file),
      platformEntry,
      `${file} must import platform through the entry`
    );
  }
  // The symbols themselves are still owned by the platform modules that
  // define them, and the facade still republishes them.
  assert.match(
    source("runtime/src/platform/index.ts"),
    /export \* from "\.\/install-check\.ts";/u
  );
  assert.match(
    source("runtime/src/platform/index.ts"),
    /export \* from "\.\/install-command\.ts";/u
  );
  assert.match(
    source("runtime/src/platform/index.ts"),
    /export \* from "\.\/router-ensure\.ts";/u
  );
});
