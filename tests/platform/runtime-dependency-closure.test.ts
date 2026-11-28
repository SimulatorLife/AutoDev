import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectRuntimeDependencyClosures,
  deployWithPnpm,
  materializeRuntimeDependencyClosure,
  referencedRuntimeDependencyClosure,
  runtimeDependencyClosure,
  runtimeDependencyClosureName
} from "@simulatorlife/autodev-runtime/platform/runtime-dependency-closure";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function temporary(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
The files the closure name is computed from, in a disposable checkout.
*/
function fixtureCheckout(): string {
  const root = temporary("autodev-closure-checkout-");
  writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(path.join(root, "runtime"));
  writeFileSync(path.join(root, "runtime", "package.json"), "{}\n");
  for (const name of ["core", "data"]) {
    mkdirSync(path.join(root, name, "src"), { recursive: true });
    writeFileSync(path.join(root, name, "src", "index.ts"), "export {};\n");
  }
  return root;
}

function fakeDeploy(calls: string[]) {
  return (_root: string, target: string): void => {
    calls.push(target);
    mkdirSync(path.join(target, "node_modules", ".pnpm"), { recursive: true });
    mkdirSync(path.join(target, "node_modules", "zod"), { recursive: true });
    writeFileSync(
      path.join(target, "node_modules", "zod", "package.json"),
      "{}\n"
    );
    mkdirSync(path.join(target, "src"));
    writeFileSync(path.join(target, "package.json"), "{}\n");
  };
}

test("the closure name follows the deploy inputs, including injected workspace sources", () => {
  const root = fixtureCheckout();
  try {
    const initial = runtimeDependencyClosureName(root);
    assert.match(initial, /^\.deps-[0-9a-f]{16}$/u);
    // Dependency and build output inside a workspace package is not input.
    mkdirSync(path.join(root, "core", "node_modules", "x"), {
      recursive: true
    });
    writeFileSync(path.join(root, "core", "tsconfig.tsbuildinfo"), "{}");
    assert.equal(runtimeDependencyClosureName(root), initial);
    // Any change to code the closure carries names a different closure, so an
    // edited workspace package is never served from a closure built before it.
    writeFileSync(
      path.join(root, "core", "src", "index.ts"),
      "export const x = 1;\n"
    );
    assert.notEqual(runtimeDependencyClosureName(root), initial);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a closure is deployed once, keeps only node_modules, and lives under the Runtime home", () => {
  const root = fixtureCheckout();
  const home = temporary("autodev-closure-home-");
  try {
    const calls: string[] = [];
    const first = materializeRuntimeDependencyClosure(
      root,
      home,
      fakeDeploy(calls)
    );
    assert.equal(first.deployed, true);
    assert.equal(first.nodeModules, runtimeDependencyClosure(root, home));
    assert.equal(path.dirname(path.dirname(first.nodeModules)), home);
    assert.deepEqual(readdirSync(path.dirname(first.nodeModules)), [
      "node_modules"
    ]);
    const second = materializeRuntimeDependencyClosure(
      root,
      home,
      fakeDeploy(calls)
    );
    assert.equal(second.deployed, false);
    assert.equal(calls.length, 1);
    // The deploy ran beside its final name; nothing of the build is left over.
    assert.deepEqual(
      readdirSync(home).filter((name) => name.includes(".tmp-")),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed deploy leaves no closure behind", () => {
  const root = fixtureCheckout();
  const home = temporary("autodev-closure-home-");
  try {
    assert.throws(
      () =>
        materializeRuntimeDependencyClosure(root, home, (_root, target) => {
          mkdirSync(target);
          throw new Error("registry unreachable");
        }),
      /registry unreachable/u
    );
    assert.deepEqual(readdirSync(home), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("closures are collected once no retained generation links them", () => {
  const home = temporary("autodev-closure-home-");
  try {
    for (const name of [".deps-aaaaaaaaaaaaaaaa", ".deps-bbbbbbbbbbbbbbbb"])
      mkdirSync(path.join(home, name, "node_modules"), { recursive: true });
    mkdirSync(path.join(home, ".deps-cccccccccccccccc.tmp-999999999"));
    mkdirSync(path.join(home, ".src-1111111111111111"));
    const link = path.join(home, ".src-1111111111111111", "node_modules");
    symlinkSync(
      path.join(home, ".deps-aaaaaaaaaaaaaaaa", "node_modules"),
      link
    );
    const referenced = referencedRuntimeDependencyClosure(home, link);
    assert.equal(referenced, ".deps-aaaaaaaaaaaaaaaa");
    const collected = collectRuntimeDependencyClosures(
      home,
      new Set([referenced!])
    );
    assert.deepEqual(collected.toSorted(new Intl.Collator("en").compare), [
      ".deps-bbbbbbbbbbbbbbbb",
      ".deps-cccccccccccccccc.tmp-999999999"
    ]);
    // A link into a checkout is not a closure, whatever it is called.
    const outside = path.join(home, "outside-node_modules");
    symlinkSync("/Users/someone/AutoDev/runtime/node_modules", outside);
    assert.equal(referencedRuntimeDependencyClosure(home, outside), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
Adversarial: the deployed closure must share no file with the editable
checkout. A symlink into the checkout, or a hard link to a file the
checkout's `node_modules` also links, would let an edit in the workspace
change what the installed services run.
*/
test("the deployed closure shares no file or link with the editable checkout", () => {
  const home = temporary("autodev-closure-home-");
  try {
    const { nodeModules } = materializeRuntimeDependencyClosure(
      repositoryRoot,
      home,
      deployWithPnpm
    );
    const closureRoot = realpathSync(path.dirname(nodeModules));
    const checkoutRoot = realpathSync(repositoryRoot);
    const escapes: string[] = [];
    const walk = (directory: string): void => {
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          const target = path.resolve(directory, readlinkSync(entryPath));
          if (!target.startsWith(`${closureRoot}${path.sep}`))
            escapes.push(`${entryPath} -> ${target}`);
        } else if (entry.isDirectory()) walk(entryPath);
      }
    };
    walk(closureRoot);
    assert.deepEqual(escapes, [], "closure links resolve outside the closure");

    // Workspace packages are injected copies, not links to the checkout.
    for (const name of ["autodev-core", "autodev-data"]) {
      const injected = realpathSync(
        path.join(nodeModules, "@simulatorlife", name, "package.json")
      );
      assert.ok(injected.startsWith(closureRoot), injected);
      assert.ok(!injected.startsWith(`${checkoutRoot}${path.sep}`), injected);
    }
    // Node refuses to strip types under node_modules, so the workspace
    // packages' TypeScript must load from a real path outside it -- and must
    // actually load, with their own dependencies, from the closure alone.
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'await import("@simulatorlife/autodev-core"); await import("@simulatorlife/autodev-data/files");'
      ],
      { cwd: path.dirname(nodeModules), encoding: "utf8" }
    );
    assert.equal(imported.status, 0, imported.stderr);
    for (const name of ["autodev-core", "autodev-data"]) {
      const real = realpathSync(path.join(nodeModules, "@simulatorlife", name));
      assert.ok(!real.split(path.sep).includes("node_modules"), real);
    }
    // Third-party files are not hard links shared with the checkout's tree.
    for (const relative of ["zod/package.json", "supergateway/package.json"]) {
      const installed = statSync(path.join(nodeModules, relative));
      const checkout = statSync(
        path.join(repositoryRoot, "runtime", "node_modules", relative)
      );
      assert.notEqual(installed.ino, checkout.ino, relative);
    }
    // The MCP backends the launcher runs are part of the closure.
    for (const name of [
      "@modelcontextprotocol/server-filesystem",
      "@modelcontextprotocol/server-github",
      "@playwright/mcp",
      "lsp-mcp-server",
      "typescript-language-server",
      "@ganglion/xacpx",
      "supergateway"
    ])
      assert.ok(lstatSync(path.join(nodeModules, name)), name);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a checkout edit after install does not change the closure it was installed from", () => {
  // The installed name is fixed at install time; a later edit to a workspace
  // package names a new closure the operator must install, it never rewrites
  // the one the services already resolve through.
  const root = fixtureCheckout();
  const home = temporary("autodev-closure-home-");
  try {
    const installed = materializeRuntimeDependencyClosure(
      root,
      home,
      fakeDeploy([])
    );
    const snapshot = path.join(home, "snapshot");
    cpSync(installed.nodeModules, snapshot, { recursive: true });
    writeFileSync(
      path.join(root, "core", "src", "index.ts"),
      "export const pwned = true;\n"
    );
    assert.notEqual(
      runtimeDependencyClosure(root, home),
      installed.nodeModules
    );
    assert.deepEqual(readdirSync(installed.nodeModules), readdirSync(snapshot));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  "a second Runtime home clones an already-materialized closure with distinct inodes",
  { skip: process.platform !== "darwin" },
  () => {
    const root = fixtureCheckout();
    const seedHome = temporary("autodev-closure-seed-");
    const targetHome = temporary("autodev-closure-target-");
    try {
      const seeded = materializeRuntimeDependencyClosure(
        root,
        seedHome,
        fakeDeploy([])
      );
      const cloned = materializeRuntimeDependencyClosure(
        root,
        targetHome,
        deployWithPnpm,
        seedHome
      );
      assert.equal(cloned.deployed, true);
      assert.equal(
        cloned.nodeModules,
        runtimeDependencyClosure(root, targetHome)
      );
      const seedStat = statSync(
        path.join(seeded.nodeModules, "zod", "package.json")
      );
      const clonedStat = statSync(
        path.join(cloned.nodeModules, "zod", "package.json")
      );
      assert.notEqual(
        clonedStat.ino,
        seedStat.ino,
        "cloned closure must not share hard-linked inodes with the seed home"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(seedHome, { recursive: true, force: true });
      rmSync(targetHome, { recursive: true, force: true });
    }
  }
);
