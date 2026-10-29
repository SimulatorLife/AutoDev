import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
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
/**
 * The same coupling written as a relative path.
 *
 * The package form is only one of the two ways a module inside the Runtime
 * can name a platform implementation file, and the guard that watched only
 * the package form let the other one through: the CLI named four platform
 * modules relatively, and the Control API named a fifth.
 */
const relativePlatformImport = /from\s+["'](?:\.\.\/)+platform\/[^"']+["']/u;
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
    .filter(
      (file) =>
        deepPlatformImport.test(source(file)) ||
        relativePlatformImport.test(source(file))
    );

  assert.deepEqual(offenders, []);
});

test("the CLI and the Control API reach the platform through its entry", () => {
  // `hooks/` already consumed the facade (lifecycle, session-start,
  // subagent-start); the CLI named platform internals relatively, and the
  // Control API named the materializer that way too.
  for (const file of [
    "runtime/src/cli/dev.ts",
    "runtime/src/cli/install.ts",
    "runtime/src/cli/provider-agent.ts",
    "runtime/src/control-api/index.ts"
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

// Core is transpiled into the Console's browser bundle, so a Node built-in
// reached from Core fails `next build` with an unhandled `node:` scheme that
// names the scheme but not the module that asked for it. That is how the
// Playtesting hash chain left Core for
// `runtime/src/playtesting/hash-chain.ts`: every consumer was already there,
// and Core is the package the client imports.
//
// Only static import/export specifiers are read. They are the form a barrel
// graph resolves, which is the graph that broke; matching whole lines also keeps
// this scan free of the prose and regex literals a comment-blind lexer would
// have to understand.
const staticSpecifier = [
  /^(?:import|export)\b[^\n]*?\bfrom\s+["']([^"']+)["']/gmu,
  /^import\s+["']([^"']+)["']/gmu
];

function builtinImports(fileSource: string): {
  readonly line: number;
  readonly specifier: string;
}[] {
  const builtins = new Set(
    builtinModules.map((name) => name.replace(/^node:/u, ""))
  );
  const found: { line: number; specifier: string }[] = [];
  for (const pattern of staticSpecifier) {
    pattern.lastIndex = 0;
    for (const match of fileSource.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const bare = specifier.startsWith("node:")
        ? specifier.slice("node:".length)
        : specifier;
      // A relative path is never a built-in, and a scoped package is never one
      // either, so only bare specifiers can match.
      if (!builtins.has(bare) || specifier.includes("/")) continue;
      const line = fileSource.slice(0, match.index).split("\n").length;
      found.push({ line, specifier });
    }
  }
  return found.sort((left, right) => left.line - right.line);
}

test("Core reaches no Node built-in", () => {
  const offenders = typescriptFiles(path.join(repositoryRoot, "core", "src"))
    .flatMap((file) =>
      builtinImports(source(file)).map(
        (hit) => `${file}:${hit.line} imports ${hit.specifier}`
      )
    )
    .sort();

  assert.deepEqual(offenders, []);
});

test("the Core built-in scan reads imports rather than prose", () => {
  // The control a clean tree cannot provide: with every Core module already
  // free of built-ins, only a known violation shows the scan still bites. The
  // commented lines are here because a guard that explains this rule in a
  // docstring must not report its own explanation as an offender.
  assert.deepEqual(
    builtinImports(
      [
        'import { createHash } from "node:crypto";',
        '// import { readFileSync } from "node:fs";',
        " * import { tmpdir } from 'node:os';",
        'import { canonicalNavGroupOf } from "./navigation.ts";',
        'import { createHash } from "@simulatorlife/autodev-core";'
      ].join("\n")
    ),
    [{ line: 1, specifier: "node:crypto" }]
  );
});
