#!/usr/bin/env node

/**
 * The opencli version this repository pins, the files that have to carry it,
 * and the command that keeps them in step.
 *
 * opencli is not merely depended on: it is patched. `patches/` holds AutoDev's
 * changes to the package, and pnpm applies a patch to the exact version its
 * key names. The patch key, the patch file name, the manifest's dependency and
 * the package that is actually installed are therefore four statements about
 * one version, and they drifted apart before: the workspace patched 2.0.2, the
 * manifest asked for 2.0.3, the lockfile installed 2.0.2, and the bridge ran
 * the 2.0.2 -- so the patch AutoDev wrote was not the code that served turns,
 * and the CLI reported the daemon it found as a stale version of itself.
 *
 * The Runtime manifest is the one place the version is written down; this
 * module reads it from there and is the one place the repository is judged
 * against it. Run as a command, `--write` puts the workspace patch key and the
 * patch file name on the manifest's version, and `--check` refuses to leave
 * them, the lockfile or the installed package apart: a version bump that updates the manifest and forgets the
 * patch key installs a package the patch no longer applies to, and the bridge
 * then runs code AutoDev never patched. `opencliRepositoryDrift` is that check
 * as a function, which the test guarding the repository asserts is empty.
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
import { pathToFileURL } from "node:url";

import {
  writeErrorLine,
  writeLine
} from "@simulatorlife/autodev-runtime/shared/output";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

/** The package AutoDev patches and runs. */
export const OPENCLI_PACKAGE = "@jackwener/opencli";

/**
 * The opencli version a Runtime manifest pins, or null when it pins none.
 *
 * `runtime/package.json` is, and must remain, the single and only source of
 * truth for this version. Never copy it into a constant, a config file or
 * another module: every other statement of it (the workspace patch key, the
 * patch file name, the lockfile) is derived from the manifest and checked
 * against it, and code that needs the version reads it through this function.
 *
 * Bumping the version means: `runtime/package.json`, then the
 * `opencli-version --write` command for the `patchedDependencies` key in
 * `pnpm-workspace.yaml` and the patch file's name, then the lockfile and the
 * patch itself rebased onto the new release. A patch applies to one exact
 * release, so a range or tag is not a pin.
 */
export function pinnedOpencliVersion(manifest: string): string | null {
  let parsed: { dependencies?: Record<string, unknown> };
  try {
    parsed = JSON.parse(manifest) as typeof parsed;
  } catch {
    return null;
  }
  const declared = parsed.dependencies?.[OPENCLI_PACKAGE];
  return typeof declared === "string" && EXACT_VERSION.test(declared)
    ? declared
    : null;
}

/** An exact release: no range operator, tag or wildcard. */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

/** The key pnpm patches a package version under. */
export function opencliPatchKey(version: string): string {
  return `${OPENCLI_PACKAGE}@${version}`;
}

/**
 * The patch file that carries AutoDev's changes to a version.
 *
 * pnpm's own naming for a patched package is `<scope>__<name>@<version>.patch`
 * in the repository's `patches/` directory, and the workspace's key points at
 * it by path, so the name and the key carry the same version twice.
 */
export function opencliPatchFileName(version: string): string {
  return `patches/${OPENCLI_PACKAGE.replace("/", "__")}@${version}.patch`;
}

/** The files that state the pinned version, relative to the repository root. */
const MANIFEST_FILE = "runtime/package.json";
const WORKSPACE_FILE = "pnpm-workspace.yaml";
const LOCKFILE_FILE = "pnpm-lock.yaml";

/** One file that does not say the version the repository pins. */
export interface OpencliVersionDrift {
  /** The file, relative to the repository root. */
  readonly file: string;
  /** What the file has to say. */
  readonly expected: string;
  /** What it says. */
  readonly found: string;
  /** Why the two differ, in one sentence. */
  readonly reason: string;
}

/** The line that opens the `patchedDependencies` block. */
const PATCHED_DEPENDENCIES_BLOCK = /^patchedDependencies:[ \t]*$/mu;
/** One entry of the block: an indented key and the path it points at. */
const PATCHED_DEPENDENCY_ENTRY =
  /^[ \t]+['"]?([^'":\s]+)['"]?:[ \t]*(\S+)[ \t]*$/mu;
/** A line that ends the block: one that starts in the first column. */
const TOP_LEVEL_LINE = /^\S/mu;

/**
 * The `patchedDependencies` entries of a pnpm workspace file.
 *
 * The block is a flat map of a quoted key to a path, so it is read line by
 * line: the Runtime does not depend on a YAML parser, and a block of string
 * pairs needs none.
 */
export function parsePatchedDependencies(
  workspaceYaml: string
): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = workspaceYaml.split("\n");
  let inBlock = false;
  for (const line of lines) {
    if (PATCHED_DEPENDENCIES_BLOCK.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (TOP_LEVEL_LINE.test(line)) break;
    const match = PATCHED_DEPENDENCY_ENTRY.exec(line);
    if (match?.[1] && match[2]) entries.set(match[1].trim(), match[2].trim());
  }
  return entries;
}

/**
 * A workspace file whose patched dependencies name one version of opencli.
 *
 * The entry for the version is replaced in place and every other entry is
 * left alone, so the file keeps its shape and its other patches.
 */
export function withOpencliPatchEntry(
  workspaceYaml: string,
  key: string,
  patchPath: string
): string {
  const lines = workspaceYaml.split("\n");
  let inBlock = false;
  let replaced = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (PATCHED_DEPENDENCIES_BLOCK.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (TOP_LEVEL_LINE.test(line)) break;
    const match = PATCHED_DEPENDENCY_ENTRY.exec(line);
    if (!match?.[1]) continue;
    if (match[1].trim() !== key) continue;
    lines[index] = `  '${key}': ${patchPath}`;
    replaced = true;
    break;
  }
  if (replaced) return lines.join("\n");
  // The workspace has no entry for this version yet: add one under the block.
  const block = lines.findIndex((line) =>
    PATCHED_DEPENDENCIES_BLOCK.test(line)
  );
  if (block === -1) return workspaceYaml;
  lines.splice(block + 1, 0, `  '${key}': ${patchPath}`);
  return lines.join("\n");
}

/**
 * Every place the pinned version has to appear and does not.
 *
 * The manifest and the workspace are read as text and judged here, so the
 * check is a pure function of two strings and can be tested without a
 * repository.
 */
export function opencliVersionDrift(input: {
  /** The contents of `runtime/package.json`. */
  readonly manifest: string;
  /** The contents of `pnpm-workspace.yaml`. */
  readonly workspace: string;
  /** The contents of `pnpm-lock.yaml`, when the repository has one. */
  readonly lockfile?: string;
  /** The sha256 of the patch file the repository holds. */
  readonly patchHash?: string;
}): OpencliVersionDrift[] {
  const version = pinnedOpencliVersion(input.manifest);
  if (version === null)
    return [
      {
        file: MANIFEST_FILE,
        expected: `an exact ${OPENCLI_PACKAGE} version`,
        found: "unpinned",
        reason: `the Runtime manifest does not pin ${OPENCLI_PACKAGE} to one exact version`
      }
    ];
  const drift: OpencliVersionDrift[] = [];

  const patched = parsePatchedDependencies(input.workspace);
  const opencliEntries = [...patched.entries()].filter(([key]) =>
    key.startsWith(`${OPENCLI_PACKAGE}@`)
  );
  const expectedKey = opencliPatchKey(version);
  if (opencliEntries.length === 0)
    drift.push({
      file: WORKSPACE_FILE,
      expected: expectedKey,
      found: "no entry",
      reason: "the workspace patches no version of opencli"
    });
  for (const [key] of opencliEntries)
    if (key !== expectedKey)
      drift.push({
        file: WORKSPACE_FILE,
        expected: expectedKey,
        found: key,
        reason: "the workspace patches a different opencli version"
      });
  const expectedPath = opencliPatchFileName(version);
  const patchPath = patched.get(expectedKey);
  if (patchPath !== undefined && patchPath !== expectedPath)
    drift.push({
      file: WORKSPACE_FILE,
      expected: expectedPath,
      found: patchPath,
      reason: "the patched dependency does not point at the patch file"
    });

  // The lockfile records the hash of the patch it installed, so it says
  // which patch the bridge is really running: a patch file that was edited
  // and not installed leaves the repository describing code the site never
  // serves.
  drift.push(
    ...lockfilePatchDrift({
      ...(input.lockfile === undefined ? {} : { lockfile: input.lockfile }),
      ...(input.patchHash === undefined ? {} : { patchHash: input.patchHash }),
      key: expectedKey
    })
  );
  return drift;
}

/**
 * What the lockfile says about the patch that was installed.
 *
 * The lockfile records the hash of the patch file it installed, so it says
 * which patch the bridge is really running: a patch file that was edited and
 * not installed leaves the repository describing code the site never serves.
 */
function lockfilePatchDrift(input: {
  readonly lockfile?: string;
  readonly patchHash?: string;
  readonly key: string;
}): OpencliVersionDrift[] {
  if (input.lockfile === undefined || input.patchHash === undefined) return [];
  const hash = parseLockfilePatchedDependencies(input.lockfile).get(input.key);
  if (hash === undefined)
    return [
      {
        file: LOCKFILE_FILE,
        expected: input.key,
        found: "no entry",
        reason: "the lockfile installs no patch for the pinned version"
      }
    ];
  if (hash === input.patchHash) return [];
  return [
    {
      file: LOCKFILE_FILE,
      expected: input.patchHash,
      found: hash,
      reason:
        "the lockfile installs a different patch than the repository holds"
    }
  ];
}

/** One entry of the lockfile's block: an indented key and the patch's hash. */
const LOCKFILE_PATCHED_ENTRY =
  /^[ \t]+['"]?([^'":\s]+)['"]?:[ \t]*(\S+)[ \t]*$/u;

/**
 * The `patchedDependencies` entries of a pnpm lockfile, as key to the sha256
 * of the patch file pnpm installed.
 *
 * The hash is the sha256 of that file's bytes: it says which patch the running
 * code came from, so the patch in the repository can be checked against it.
 */
export function parseLockfilePatchedDependencies(
  lockfile: string
): Map<string, string> {
  const entries = new Map<string, string>();
  let inBlock = false;
  for (const line of lockfile.split("\n")) {
    if (!inBlock) {
      if (PATCHED_DEPENDENCIES_BLOCK.test(line)) inBlock = true;
      continue;
    }
    if (TOP_LEVEL_LINE.test(line)) break;
    const entry = LOCKFILE_PATCHED_ENTRY.exec(line);
    if (entry?.[1] && entry[2]) entries.set(entry[1].trim(), entry[2].trim());
  }
  return entries;
}

function manifestPath(root: string): string {
  return path.join(root, MANIFEST_FILE);
}

function workspacePath(root: string): string {
  return path.join(root, WORKSPACE_FILE);
}

function readLockfile(root: string): string | undefined {
  const lockfile = path.join(root, LOCKFILE_FILE);
  return existsSync(lockfile) ? readFileSync(lockfile, "utf8") : undefined;
}

/**
 * The hash of the patch the repository holds.
 *
 * It is the sha256 of the patch file's bytes, which is what pnpm records in
 * the lockfile: the two together say whether the code the bridge runs is the
 * patch in this repository. A repository without the patch file has no hash.
 */
function patchHash(root: string, version: string): string {
  const file = path.join(root, opencliPatchFileName(version));
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
function installedVersion(root: string): string | null {
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

function write(root: string): void {
  const version = pinnedOpencliVersion(
    readFileSync(manifestPath(root), "utf8")
  );
  if (version === null)
    throw new Error(
      `${MANIFEST_FILE} does not pin ${OPENCLI_PACKAGE} to one exact version`
    );
  const workspace = withOpencliPatchEntry(
    readFileSync(workspacePath(root), "utf8"),
    opencliPatchKey(version),
    opencliPatchFileName(version)
  );
  writeFileSync(workspacePath(root), workspace);

  // The patch file carries the version in its name, so a version bump moves
  // it: the patch's content is rebased by hand, its name by this command.
  const patches = path.join(root, "patches");
  const canonical = path.join(root, opencliPatchFileName(version));
  if (existsSync(patches))
    for (const entry of readdirSync(patches))
      if (
        entry.startsWith("@jackwener__opencli@") &&
        entry !== path.basename(canonical)
      )
        // Moves the existing patch file; there are no new bytes to write.
        renameSync(path.join(patches, entry), canonical);
  writeLine(`opencli pinned at ${version}`);
}

/**
 * Every statement about the pinned version the repository at `root` gets
 * wrong.
 *
 * It judges the manifest, the workspace patch key and the lockfile with
 * `opencliVersionDrift`, and adds what only a repository can say: whether the
 * patch file is there, and whether the installed package is the pinned one.
 * An empty list is a repository whose bridge runs the code AutoDev patched.
 */
export function opencliRepositoryDrift(root: string): OpencliVersionDrift[] {
  const manifest = readFileSync(manifestPath(root), "utf8");
  const version = pinnedOpencliVersion(manifest);
  if (version === null) return opencliVersionDrift({ manifest, workspace: "" });
  const lockfile = readLockfile(root);
  const hash = patchHash(root, version);
  const drift = opencliVersionDrift({
    manifest,
    workspace: readFileSync(workspacePath(root), "utf8"),
    ...(lockfile === undefined ? {} : { lockfile }),
    ...(hash === "" ? {} : { patchHash: hash })
  });
  if (!existsSync(path.join(root, opencliPatchFileName(version))))
    drift.push({
      file: opencliPatchFileName(version),
      expected: "present",
      found: "missing",
      reason: "the patch for the pinned version is not in the repository"
    });
  const installed = installedVersion(root);
  if (installed !== null && installed !== version)
    drift.push({
      file: `runtime/node_modules/${OPENCLI_PACKAGE}`,
      expected: version,
      found: installed,
      reason: "the installed package is not the pinned version"
    });
  return drift;
}

function check(root: string): boolean {
  const drift = opencliRepositoryDrift(root);
  const version =
    pinnedOpencliVersion(readFileSync(manifestPath(root), "utf8")) ??
    "(unpinned)";
  if (drift.length === 0) {
    writeLine(
      `opencli ${version}: manifest, patch key, patch file and lockfile agree`
    );
    return true;
  }
  for (const entry of drift)
    writeErrorLine(
      `${entry.file}: ${entry.reason} (expected ${entry.expected}, found ${entry.found})`
    );
  writeErrorLine(
    `opencli ${version} is not consistent; run: node runtime/src/cli/opencli-version.ts --write`
  );
  return false;
}

const IS_MAIN =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (IS_MAIN) {
  const root = resolveRuntimeSourceRoot(import.meta.dirname);
  if (process.argv.includes("--write")) write(root);
  else if (!check(root)) process.exit(1);
}
