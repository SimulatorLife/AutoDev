/**
 * The opencli version this repository pins, and the files that have to carry it.
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
 * This module is the one place the version is written down. The
 * `opencli-version` command (`src/cli/opencli-version.ts`) rewrites the files
 * that must carry it and refuses to leave them inconsistent, and the test that
 * guards the repository asserts they agree.
 */

/** The package AutoDev patches and runs. */
export const OPENCLI_PACKAGE = "@jackwener/opencli";

/**
 * The one opencli version this repository pins.
 *
 * Bumping it means: this constant, `runtime/package.json`, the
 * `patchedDependencies` key in `pnpm-workspace.yaml`, the patch file's name,
 * the lockfile, and the patch itself rebased onto the new release. The
 * `opencli-version` command does the first four and refuses to leave any of
 * them out of step with this one.
 */
export const OPENCLI_VERSION = "2.0.3";

/** The key pnpm patches a package version under. */
export function opencliPatchKey(version: string = OPENCLI_VERSION): string {
  return `${OPENCLI_PACKAGE}@${version}`;
}

/**
 * The patch file that carries AutoDev's changes to a version.
 *
 * pnpm's own naming for a patched package is `<scope>__<name>@<version>.patch`
 * in the repository's `patches/` directory, and the workspace's key points at
 * it by path, so the name and the key carry the same version twice.
 */
export function opencliPatchFileName(
  version: string = OPENCLI_VERSION
): string {
  return `patches/${OPENCLI_PACKAGE.replace("/", "__")}@${version}.patch`;
}

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
}): OpencliVersionDrift[] {
  const drift: OpencliVersionDrift[] = [];
  let manifest: { dependencies?: Record<string, unknown> } = {};
  try {
    manifest = JSON.parse(input.manifest) as {
      dependencies?: Record<string, unknown>;
    };
  } catch {
    drift.push({
      file: "runtime/package.json",
      expected: OPENCLI_VERSION,
      found: "unreadable",
      reason: "the Runtime manifest is not valid JSON"
    });
  }
  const declared = manifest.dependencies?.[OPENCLI_PACKAGE];
  if (declared !== OPENCLI_VERSION)
    drift.push({
      file: "runtime/package.json",
      expected: OPENCLI_VERSION,
      found: typeof declared === "string" ? declared : "unset",
      reason: `the Runtime depends on a different ${OPENCLI_PACKAGE} version`
    });

  const patched = parsePatchedDependencies(input.workspace);
  const opencliEntries = [...patched.entries()].filter(([key]) =>
    key.startsWith(`${OPENCLI_PACKAGE}@`)
  );
  const expectedKey = opencliPatchKey();
  if (opencliEntries.length === 0)
    drift.push({
      file: "pnpm-workspace.yaml",
      expected: expectedKey,
      found: "no entry",
      reason: "the workspace patches no version of opencli"
    });
  for (const [key] of opencliEntries)
    if (key !== expectedKey)
      drift.push({
        file: "pnpm-workspace.yaml",
        expected: expectedKey,
        found: key,
        reason: "the workspace patches a different opencli version"
      });
  const expectedPath = opencliPatchFileName();
  const patchPath = patched.get(expectedKey);
  if (patchPath !== undefined && patchPath !== expectedPath)
    drift.push({
      file: "pnpm-workspace.yaml",
      expected: expectedPath,
      found: patchPath,
      reason: "the patched dependency does not point at the patch file"
    });
  return drift;
}
