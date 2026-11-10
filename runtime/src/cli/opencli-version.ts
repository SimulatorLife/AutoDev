#!/usr/bin/env node

/**
 * Keep every statement about the pinned opencli version in step.
 *
 * opencli is patched, so the version appears in four places that can drift
 * apart: the Runtime manifest, the `patchedDependencies` key in the pnpm
 * workspace, the patch file's name, and the lockfile that installs it. This
 * command is the one that writes them: `--write` puts them all on the
 * version this repository pins, and `--check` refuses to leave them apart.
 *
 * The check is what keeps them together afterwards: a version bump that
 * updates the manifest and forgets the patch key installs a package the
 * patch no longer applies to, and the bridge then runs code AutoDev never
 * patched.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import {
  OPENCLI_PACKAGE,
  OPENCLI_VERSION,
  opencliPatchFileName,
  opencliPatchKey,
  opencliVersionDrift,
  withOpencliPatchEntry
} from "@simulatorlife/autodev-runtime/shared/opencli-version";
import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

const root = resolveRuntimeSourceRoot(import.meta.dirname);
const manifestPath = path.join(root, "runtime", "package.json");
const workspacePath = path.join(root, "pnpm-workspace.yaml");
const lockfilePath = path.join(root, "pnpm-lock.yaml");

function readManifest(): string {
  return readFileSync(manifestPath, "utf8");
}

function readWorkspace(): string {
  return readFileSync(workspacePath, "utf8");
}

function readLockfile(): string | undefined {
  return existsSync(lockfilePath)
    ? readFileSync(lockfilePath, "utf8")
    : undefined;
}

/**
 * The hash of the patch the repository holds.
 *
 * It is the sha256 of the patch file's bytes, which is what pnpm records in
 * the lockfile: the two together say whether the code the bridge runs is the
 * patch in this repository. A repository without the patch file has no hash.
 */
function patchHash(): string {
  const file = path.join(root, opencliPatchFileName());
  if (!existsSync(file)) return "";
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The version of the opencli package that is installed, when one is.
 *
 * The installed package is what the bridge runs, so a tree whose installed
 * version is not the pinned one serves turns from code the repository does
 * not describe. The check reports it; it cannot repair it, because only an
 * install can.
 */
function installedVersion(): string | null {
  const manifest = path.join(
    root,
    "runtime",
    "node_modules",
    ...OPENCLI_PACKAGE.split("/"),
    "package.json"
  );
  if (!existsSync(manifest)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function write(): void {
  const manifest = readManifest();
  const parsed = JSON.parse(manifest) as {
    dependencies?: Record<string, string>;
  };
  parsed.dependencies = parsed.dependencies ?? {};
  parsed.dependencies[OPENCLI_PACKAGE] = OPENCLI_VERSION;
  writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`);

  const workspace = withOpencliPatchEntry(
    readWorkspace(),
    opencliPatchKey(),
    opencliPatchFileName()
  );
  writeFileSync(workspacePath, workspace);

  // The patch file carries the version in its name, so a version bump moves
  // it: the patch's content is rebased by hand, its name by this command.
  const patches = path.join(root, "patches");
  const canonical = path.join(root, opencliPatchFileName());
  if (existsSync(patches))
    for (const entry of readdirSync(patches))
      if (
        entry.startsWith("@jackwener__opencli@") &&
        entry !== path.basename(canonical)
      )
        renameSync(path.join(patches, entry), canonical);
  writeLine(`opencli pinned at ${OPENCLI_VERSION}`);
}

function check(): boolean {
  const lockfile = readLockfile();
  const hash = patchHash();
  const drift = opencliVersionDrift({
    manifest: readManifest(),
    workspace: readWorkspace(),
    ...(lockfile === undefined ? {} : { lockfile }),
    ...(hash === "" ? {} : { patchHash: hash })
  });
  const patchFile = path.join(root, opencliPatchFileName());
  if (!existsSync(patchFile))
    drift.push({
      file: opencliPatchFileName(),
      expected: "present",
      found: "missing",
      reason: "the patch for the pinned version is not in the repository"
    });
  const installed = installedVersion();
  if (installed !== null && installed !== OPENCLI_VERSION)
    drift.push({
      file: `runtime/node_modules/${OPENCLI_PACKAGE}`,
      expected: OPENCLI_VERSION,
      found: installed,
      reason: "the installed package is not the pinned version"
    });
  if (drift.length === 0) {
    writeLine(
      `opencli ${OPENCLI_VERSION}: manifest, patch key, patch file and lockfile agree`
    );
    return true;
  }
  for (const entry of drift)
    writeErrorLine(
      `${entry.file}: ${entry.reason} (expected ${entry.expected}, found ${entry.found})`
    );
  writeErrorLine(
    `opencli ${OPENCLI_VERSION} is not consistent; run: node runtime/src/cli/opencli-version.ts --write`
  );
  return false;
}

if (process.argv.includes("--write")) write();
else if (!check()) process.exit(1);
