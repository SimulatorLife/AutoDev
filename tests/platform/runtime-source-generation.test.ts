import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkRuntimeSourceGeneration } from "@simulatorlife/autodev-runtime/platform/install-check";
import {
  currentRuntimeSourceGeneration,
  GENERATION_RETENTION_MS,
  materializeRuntimeSourceGeneration,
  runtimeSourceGenerationName,
  type RuntimeSourceTree
} from "@simulatorlife/autodev-runtime/platform/runtime-source-generation";

const DAY_MS = 24 * 60 * 60 * 1000;

function codexHome(): string {
  return mkdtempSync(path.join(tmpdir(), "autodev-generation-"));
}

function tree(
  files: Record<string, string>,
  nodeModules = "/nonexistent/node_modules"
): RuntimeSourceTree {
  return { files: new Map(Object.entries(files)), nodeModules };
}

function generations(home: string): string[] {
  return readdirSync(home)
    .filter((name) => name.startsWith(".src-"))
    .sort();
}

test("an install publishes the tree as a generation and points src at it", () => {
  const home = codexHome();
  const result = materializeRuntimeSourceGeneration(
    home,
    tree({ "router/server.ts": "export const v = 1;\n", "package.json": "{}\n" }),
    1000
  );

  assert.equal(result.swapped, true);
  assert.equal(readlinkSync(path.join(home, "src")), result.generation);
  assert.equal(currentRuntimeSourceGeneration(home), result.generation);
  assert.equal(
    readFileSync(path.join(home, "src", "router", "server.ts"), "utf8"),
    "export const v = 1;\n"
  );
  assert.equal(
    readlinkSync(path.join(home, "src", "node_modules")),
    "/nonexistent/node_modules"
  );
  assert.equal(lstatSync(path.join(home, "src", "package.json")).mode & 0o777, 0o644);
  assert.deepEqual(generations(home), [result.generation]);
});

test("an install of the tree that is already current changes nothing", () => {
  const home = codexHome();
  const files = { "a.ts": "export const a = 1;\n" };
  const first = materializeRuntimeSourceGeneration(home, tree(files), 1000);
  const linkBefore = lstatSync(path.join(home, "src"));

  const second = materializeRuntimeSourceGeneration(home, tree(files), 2000);

  assert.equal(second.generation, first.generation);
  assert.equal(second.swapped, false);
  assert.equal(lstatSync(path.join(home, "src")).ino, linkBefore.ino);
  assert.deepEqual(generations(home), [first.generation]);
});

test("the generation name covers file paths, contents and the node_modules link", () => {
  const base = runtimeSourceGenerationName(tree({ "a.ts": "1" }));
  assert.notEqual(runtimeSourceGenerationName(tree({ "a.ts": "2" })), base);
  assert.notEqual(runtimeSourceGenerationName(tree({ "b.ts": "1" })), base);
  assert.notEqual(
    runtimeSourceGenerationName(tree({ "a.ts": "1" }, "/other/node_modules")),
    base
  );
  assert.equal(runtimeSourceGenerationName(tree({ "a.ts": "1" })), base);
});

test("changed content swaps src to a new generation and keeps the replaced one", () => {
  const home = codexHome();
  const first = materializeRuntimeSourceGeneration(
    home,
    tree({ "a.ts": "export const v = 1;\n" }),
    1000
  );
  const second = materializeRuntimeSourceGeneration(
    home,
    tree({ "a.ts": "export const v = 2;\n" }),
    2000
  );

  assert.notEqual(second.generation, first.generation);
  assert.equal(second.swapped, true);
  assert.equal(readlinkSync(path.join(home, "src")), second.generation);
  assert.deepEqual(generations(home), [first.generation, second.generation].sort());
  // The replaced generation's mtime is when it stopped being current.
  assert.equal(lstatSync(path.join(home, first.generation)).mtimeMs, 2000);
});

test("a plain src directory from an earlier install is moved aside as a generation", () => {
  const home = codexHome();
  mkdirSync(path.join(home, "src", "router"), { recursive: true });
  writeFileSync(path.join(home, "src", "router", "old.ts"), "old\n");

  const result = materializeRuntimeSourceGeneration(
    home,
    tree({ "router/new.ts": "new\n" }),
    5000
  );

  assert.equal(lstatSync(path.join(home, "src")).isSymbolicLink(), true);
  assert.equal(readlinkSync(path.join(home, "src")), result.generation);
  const retired = generations(home).filter((name) => name !== result.generation);
  assert.deepEqual(retired, [".src-directory-5000"]);
  assert.equal(
    readFileSync(path.join(home, retired[0]!, "router", "old.ts"), "utf8"),
    "old\n"
  );
});

test("generations past their retention, and abandoned builds, are collected", () => {
  const home = codexHome();
  const old = materializeRuntimeSourceGeneration(home, tree({ "a.ts": "1" }), 0);
  const recent = materializeRuntimeSourceGeneration(
    home,
    tree({ "a.ts": "2" }),
    10 * DAY_MS
  );
  // Abandoned by a process that no longer exists.
  const deadPid = 2_147_483_646;
  mkdirSync(path.join(home, `.src-feedface.tmp-${deadPid}`));
  writeFileSync(path.join(home, `src.swap-${deadPid}`), "");
  // In progress in a live process.
  mkdirSync(path.join(home, `.src-cafef00d.tmp-${process.pid}`));

  const now = 10 * DAY_MS + GENERATION_RETENTION_MS - 1;
  const current = materializeRuntimeSourceGeneration(
    home,
    tree({ "a.ts": "3" }),
    now
  );

  // `old` was replaced on day 10, within the retention; nothing replaced is
  // old enough yet.
  assert.deepEqual([...current.collected].sort(), [
    `.src-feedface.tmp-${deadPid}`,
    `src.swap-${deadPid}`
  ]);
  assert.ok(generations(home).includes(old.generation));
  assert.ok(generations(home).includes(recent.generation));
  assert.ok(generations(home).includes(`.src-cafef00d.tmp-${process.pid}`));

  const later = materializeRuntimeSourceGeneration(
    home,
    tree({ "a.ts": "3" }),
    10 * DAY_MS + GENERATION_RETENTION_MS + 1
  );
  assert.deepEqual(later.collected, [old.generation]);
  assert.ok(generations(home).includes(current.generation));
  assert.ok(generations(home).includes(recent.generation));
});

test("the current generation is never collected, however old", () => {
  const home = codexHome();
  const only = materializeRuntimeSourceGeneration(home, tree({ "a.ts": "1" }), 0);
  utimesSync(path.join(home, only.generation), new Date(0), new Date(0));

  const result = materializeRuntimeSourceGeneration(
    home,
    tree({ "a.ts": "1" }),
    100 * DAY_MS
  );

  assert.deepEqual(result.collected, []);
  assert.deepEqual(generations(home), [only.generation]);
});

/**
 * The failure this guards: an install rewrote the installed tree file by file,
 * and a bridge that started mid-install loaded an updated module beside an old
 * one -- `ERR_PACKAGE_PATH_NOT_EXPORTED` or a missing export. A process started
 * through `src` must keep importing from the generation it started on, even
 * when an install swaps `src` before its next import.
 */
test("a process started before a swap keeps importing from its own generation", async () => {
  const home = codexHome();
  const entry = [
    String.raw`process.stdout.write('ready\n');`,
    "process.stdin.once('data', async () => {",
    "  const { version } = await import('./lazy.ts');",
    "  process.stdout.write(`${version}\\n`);",
    "});"
  ].join("\n");
  materializeRuntimeSourceGeneration(
    home,
    tree({ "main.ts": entry, "lazy.ts": "export const version = 'one';\n" }),
    1000
  );

  const child = spawn(process.execPath, [path.join(home, "src", "main.ts")], {
    stdio: ["pipe", "pipe", "inherit"]
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  while (!output.includes("ready")) await once(child.stdout, "data");

  materializeRuntimeSourceGeneration(
    home,
    tree({
      "main.ts": entry,
      "lazy.ts": "export const version = 'two';\n"
    }),
    2000
  );
  child.stdin.end("go\n");
  await once(child, "exit");

  assert.equal(output, "ready\none\n");
  // A process started after the swap gets the new generation.
  const fresh = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(path.join(home, "src", "lazy.ts"))}); process.stdout.write(m.version);`
    ],
    { encoding: "utf8" }
  );
  assert.equal(fresh, "two");
});

test("install-check verifies the generation symlink, package.json and node_modules link", () => {
  const home = codexHome();
  const expected = tree(
    { "router/server.ts": "export const v = 1;\n", "package.json": '{\n  "name": "x"\n}\n' },
    "/expected/node_modules"
  );
  materializeRuntimeSourceGeneration(home, expected, 1000);

  assert.deepEqual(checkRuntimeSourceGeneration(home, expected), {
    generation: true,
    manifest: true,
    nodeModules: true
  });

  // Drifted package.json inside the current generation fails the manifest check.
  writeFileSync(path.join(home, "src", "package.json"), "{}\n");
  assert.deepEqual(checkRuntimeSourceGeneration(home, expected), {
    generation: true,
    manifest: false,
    nodeModules: true
  });

  // Drifted node_modules link inside the current generation fails the link check.
  writeFileSync(
    path.join(home, "src", "package.json"),
    '{\n  "name": "x"\n}\n'
  );
  unlinkSync(path.join(home, "src", "node_modules"));
  symlinkSync("/wrong/node_modules", path.join(home, "src", "node_modules"));
  assert.deepEqual(checkRuntimeSourceGeneration(home, expected), {
    generation: true,
    manifest: true,
    nodeModules: false
  });

  // Pointing src at a different generation fails the generation check.
  unlinkSync(path.join(home, "src"));
  symlinkSync(".src-deadbeefcafef00d", path.join(home, "src"));
  assert.deepEqual(checkRuntimeSourceGeneration(home, expected), {
    generation: false,
    manifest: false,
    nodeModules: false
  });
});
