import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  OPENCLI_PACKAGE,
  OPENCLI_VERSION,
  opencliPatchFileName,
  opencliPatchKey,
  opencliVersionDrift,
  parseLockfilePatchedDependencies,
  parsePatchedDependencies,
  withOpencliPatchEntry
} from "@simulatorlife/autodev-runtime/shared/opencli-version";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "runtime", "package.json");
const workspacePath = path.join(root, "pnpm-workspace.yaml");
const lockfilePath = path.join(root, "pnpm-lock.yaml");

function readManifest(): string {
  return readFileSync(manifestPath, "utf8");
}

function readWorkspace(): string {
  return readFileSync(workspacePath, "utf8");
}

describe("the pinned opencli version", () => {
  test("the manifest, the workspace patch key and the patch file name agree", () => {
    const drift = opencliVersionDrift({
      manifest: readManifest(),
      workspace: readWorkspace()
    });
    assert.deepEqual(
      drift,
      [],
      `the repository pins ${OPENCLI_VERSION} in ${opencliPatchKey()}, but the files disagree`
    );
  });

  test("the patch for the pinned version is in the repository", () => {
    const patch = path.join(root, opencliPatchFileName());
    assert.ok(
      existsSync(patch),
      `${opencliPatchFileName()} is missing: the pinned version has no patch`
    );
  });

  test("the lockfile installs the patch the repository holds", () => {
    // The lockfile records the sha256 of the patch it installed, so the two
    // together say whether the code the bridge runs is the patch in this
    // repository. An edited patch that was not installed leaves the
    // repository describing code the site never serves.
    if (!existsSync(lockfilePath)) return;
    const patch = path.join(root, opencliPatchFileName());
    const hash = createHash("sha256").update(readFileSync(patch)).digest("hex");
    const drift = opencliVersionDrift({
      manifest: readManifest(),
      workspace: readWorkspace(),
      lockfile: readFileSync(lockfilePath, "utf8"),
      patchHash: hash
    });
    assert.deepEqual(
      drift,
      [],
      "the lockfile installs a different patch than the repository holds"
    );
  });

  test("a lockfile that installs another patch is drift", () => {
    const lockfile = [
      "lockfileVersion: '9.0'",
      "patchedDependencies:",
      `  '${opencliPatchKey()}':`,
      "    hash: 0000000000000000000000000000000000000000000000000000000000000000",
      `    path: ${opencliPatchFileName()}`,
      "importers:",
      ""
    ].join("\n");
    const drift = opencliVersionDrift({
      manifest: readManifest(),
      workspace: readWorkspace(),
      lockfile,
      patchHash: "a".repeat(64)
    });
    assert.equal(drift.length, 1);
    assert.equal(drift[0]?.file, "pnpm-lock.yaml");
    assert.match(drift[0]?.reason ?? "", /different patch/u);
  });

  test("the lockfile's patched dependencies are read", () => {
    const entries = parseLockfilePatchedDependencies(
      [
        "lockfileVersion: '9.0'",
        "patchedDependencies:",
        `  '${opencliPatchKey()}':`,
        "    hash: abc123",
        `    path: ${opencliPatchFileName()}`,
        "importers:",
        ""
      ].join("\n")
    );
    assert.equal(entries.size, 1);
    assert.deepEqual(entries.get(opencliPatchKey()), {
      hash: "abc123",
      path: opencliPatchFileName()
    });
  });

  test("the installed opencli is the pinned version", () => {
    const installed = path.join(
      root,
      "runtime",
      "node_modules",
      ...OPENCLI_PACKAGE.split("/"),
      "package.json"
    );
    if (!existsSync(installed)) return;
    const parsed = JSON.parse(readFileSync(installed, "utf8")) as {
      version?: unknown;
    };
    assert.equal(
      parsed.version,
      OPENCLI_VERSION,
      "the installed opencli is not the pinned version: the bridge runs it"
    );
  });

  test("every file the patch touches is one the installed package has", () => {
    const patch = readFileSync(path.join(root, opencliPatchFileName()), "utf8");
    const targets = Array.from(
      patch.matchAll(/^\+\+\+ b\/(.+)$/gmu),
      (match) => match[1]!
    );
    assert.ok(targets.length > 0, "the patch names no files");
    const packageRoot = path.join(
      root,
      "runtime",
      "node_modules",
      ...OPENCLI_PACKAGE.split("/")
    );
    if (!existsSync(packageRoot)) return;
    for (const target of targets)
      assert.ok(
        existsSync(path.join(packageRoot, target)),
        `the patch touches ${target}, which the installed package does not have`
      );
  });
});

describe("the drift check", () => {
  test("a manifest on another version is drift", () => {
    const manifest = JSON.parse(readManifest()) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies[OPENCLI_PACKAGE] = "0.0.1";
    const drift = opencliVersionDrift({
      manifest: JSON.stringify(manifest),
      workspace: readWorkspace()
    });
    assert.equal(drift.length, 1);
    assert.equal(drift[0]!.file, "runtime/package.json");
    assert.equal(drift[0]!.found, "0.0.1");
  });

  test("a workspace that patches another version is drift", () => {
    const drift = opencliVersionDrift({
      manifest: readManifest(),
      workspace: readWorkspace().replace(
        opencliPatchKey(),
        `${OPENCLI_PACKAGE}@0.0.1`
      )
    });
    assert.equal(drift.length, 1);
    assert.equal(drift[0]!.file, "pnpm-workspace.yaml");
  });

  test("a workspace that patches no version at all is drift", () => {
    const workspace = readWorkspace()
      .split("\n")
      .filter((line) => !line.startsWith("  '@jackwener/opencli@"))
      .join("\n");
    const drift = opencliVersionDrift({
      manifest: readManifest(),
      workspace
    });
    assert.equal(drift.length, 1);
    assert.match(drift[0]!.reason, /patches no version/u);
  });

  test("writing the entry puts the pinned version back", () => {
    const workspace = withOpencliPatchEntry(
      readWorkspace(),
      opencliPatchKey(),
      opencliPatchFileName()
    );
    const patched = parsePatchedDependencies(workspace);
    assert.equal(patched.get(opencliPatchKey()), opencliPatchFileName());
    assert.deepEqual(
      [...patched.keys()].filter((key) => key.startsWith(OPENCLI_PACKAGE)),
      [opencliPatchKey()]
    );
  });
});
