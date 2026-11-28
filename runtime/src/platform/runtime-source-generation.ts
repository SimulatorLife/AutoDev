/**
The installed Runtime source tree, published as immutable generations.

Bridges run from `$CODEX_HOME/src` under launchd `KeepAlive`, so one can
(re)start at any moment of an install. Rewriting that tree file by file let
a starting process load an updated module beside an old one that lacked a
subpath or symbol the update imported (`ERR_PACKAGE_PATH_NOT_EXPORTED:
'./shared/compaction'`), and `KeepAlive` crash-looped it until the install
finished. No ordering of per-file writes closes that window.

So the tree a process can load is never written in place. Each install
builds a complete tree at `$CODEX_HOME/.src-<hash>`, named by its content,
and then repoints the `$CODEX_HOME/src` symlink at it with one `rename`.
Node resolves a module's realpath, and every later import -- a lazy
`import()` included -- relative to that, so a process stays on the
generation it started on for its whole life. Generations are siblings at the
top of `$CODEX_HOME`, so module-relative paths (`../..` is `$CODEX_HOME`,
`../../vendor`, the `node_modules` walk-up) resolve as they did when `src`
was a directory.

A replaced generation is kept for {@link GENERATION_RETENTION_MS} after it
stops being current: long-lived Codex sessions and the MCP servers they
started still import from it.
*/
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { ingressGenerationsStateFile } from "./install-state.ts";

/**
The `$CODEX_HOME` entry every launcher, hook and service imports through.
*/
export const RUNTIME_SOURCE_LINK = "src";
/**
Every generation's directory name starts with this.
*/
const GENERATION_PREFIX = ".src-";
/**
In-progress builds: `.src-<hash>.tmp-<pid>`.
*/
const BUILD_MARKER = ".tmp-";
/**
In-progress swaps: `src.swap-<pid>`.
*/
const SWAP_PREFIX = `${RUNTIME_SOURCE_LINK}.swap-`;
/**
How long a replaced generation outlives its replacement.
*/
export const GENERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface RuntimeSourceTree {
  /**
  Tree-relative path (`router/server.ts`, `package.json`) to its content.
  */
  readonly files: ReadonlyMap<string, string | Buffer>;
  /**
  The `node_modules` directory the tree's own `node_modules` links to.
  */
  readonly nodeModules: string;
}

export interface RuntimeSourceGenerationResult {
  /**
  The current generation's directory name, `.src-<hash>`.
  */
  readonly generation: string;
  /**
  Whether `$CODEX_HOME/src` was repointed by this call.
  */
  readonly swapped: boolean;
  /**
  Generations and abandoned build artifacts this call removed.
  */
  readonly collected: readonly string[];
}

/**
The directory name a tree is published under: its content hash.
*/
export function runtimeSourceGenerationName(tree: RuntimeSourceTree): string {
  const hash = createHash("sha256");
  for (const relativePath of [...tree.files.keys()].sort()) {
    const content = Buffer.from(tree.files.get(relativePath)!);
    hash.update(`${relativePath}\0${content.length}\0`);
    hash.update(content);
  }
  hash.update(`node_modules\0${tree.nodeModules}`);
  return `${GENERATION_PREFIX}${hash.digest("hex").slice(0, 16)}`;
}

/**
The generation `$CODEX_HOME/src` points at, or null when it is not a link.
*/
export function currentRuntimeSourceGeneration(
  codexHome: string
): string | null {
  try {
    return path.basename(
      readlinkSync(path.join(codexHome, RUNTIME_SOURCE_LINK))
    );
  } catch {
    return null;
  }
}

/**
Publish `tree` as a generation, make it current, and collect generations
past their retention while never collecting protected live or rollback
generations. Idempotent: an install whose tree is already current changes nothing.
*/
export function materializeRuntimeSourceGeneration(
  codexHome: string,
  tree: RuntimeSourceTree,
  now = Date.now(),
  protectedGenerations: ReadonlySet<string> = resolveProtectedRuntimeGenerations(
    codexHome
  )
): RuntimeSourceGenerationResult {
  const generation = runtimeSourceGenerationName(tree);
  const previous = currentRuntimeSourceGeneration(codexHome);
  let isSwapped = false;
  if (previous !== generation) {
    publishGeneration(codexHome, generation, tree);
    swapCurrentGeneration(codexHome, generation, now);
    isSwapped = true;
  }
  return {
    generation,
    swapped: isSwapped,
    collected: collectGenerations(
      codexHome,
      generation,
      now,
      protectedGenerations
    )
  };
}

/**
Read live active/retiring/rollback release directory names recorded by the
Router ingress supervisor so garbage collection never deletes them or their
dependency closures.
*/
export function resolveProtectedRuntimeGenerations(
  codexHome: string
): Set<string> {
  const protectedSet = new Set<string>();
  const current = currentRuntimeSourceGeneration(codexHome);
  if (current) protectedSet.add(current);
  const stateFile = ingressGenerationsStateFile(codexHome);
  if (!existsSync(stateFile)) return protectedSet;
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      protectedReleases?: unknown;
    };
    if (Array.isArray(parsed.protectedReleases)) {
      for (const item of parsed.protectedReleases) {
        if (typeof item === "string" && item.startsWith(GENERATION_PREFIX)) {
          protectedSet.add(item);
        }
      }
    }
  } catch {
    /* ignore unreadable or mid-write state file */
  }
  return protectedSet;
}

/**
Build the tree beside its final name and rename it into place, so a
generation directory only ever exists complete.
*/
function publishGeneration(
  codexHome: string,
  generation: string,
  tree: RuntimeSourceTree
): void {
  const target = path.join(codexHome, generation);
  if (exists(target)) return;
  const build = `${target}${BUILD_MARKER}${process.pid}`;
  rmSync(build, { recursive: true, force: true });
  for (const [relativePath, content] of tree.files) {
    const filePath = path.join(build, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o755 });
    writeFileSync(filePath, content, { mode: 0o644 });
  }
  symlinkSync(tree.nodeModules, path.join(build, "node_modules"));
  try {
    renameSync(build, target);
  } catch (error) {
    // A concurrent install published the same content first.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    rmSync(build, { recursive: true, force: true });
  }
}

/**
Repoint `$CODEX_HOME/src` at `generation` with one `rename` over the link.

The replaced generation's mtime records when it stopped being current, which
is what its retention counts from. A `src` that is still a plain directory
-- an installation from before generations -- is moved aside as a
generation first; it ages out like any other.
*/
function swapCurrentGeneration(
  codexHome: string,
  generation: string,
  now: number
): void {
  const link = path.join(codexHome, RUNTIME_SOURCE_LINK);
  const previous = currentRuntimeSourceGeneration(codexHome);
  if (previous === null && exists(link)) {
    const retired = `${GENERATION_PREFIX}directory-${now}`;
    renameSync(link, path.join(codexHome, retired));
    markReplaced(path.join(codexHome, retired), now);
  }
  const swap = path.join(codexHome, `${SWAP_PREFIX}${process.pid}`);
  rmSync(swap, { force: true });
  symlinkSync(generation, swap);
  renameSync(swap, link);
  if (previous !== null) markReplaced(path.join(codexHome, previous), now);
}

function markReplaced(directory: string, now: number): void {
  const time = new Date(now);
  try {
    utimesSync(directory, time, time);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
Remove generations replaced more than the retention ago, and the build
directories and swap links of installs that died before finishing.
*/
function collectGenerations(
  codexHome: string,
  current: string,
  now: number,
  protectedGenerations: ReadonlySet<string> = new Set()
): string[] {
  const collected: string[] = [];
  for (const name of readdirSync(codexHome)) {
    const entry = path.join(codexHome, name);
    const abandoned =
      (name.startsWith(GENERATION_PREFIX) && name.includes(BUILD_MARKER)) ||
      name.startsWith(SWAP_PREFIX);
    if (abandoned) {
      if (processAlive(Number(name.slice(name.lastIndexOf("-") + 1)))) continue;
    } else if (
      !name.startsWith(GENERATION_PREFIX) ||
      name === current ||
      protectedGenerations.has(name) ||
      now - lstatSync(entry).mtimeMs < GENERATION_RETENTION_MS
    ) {
      continue;
    }
    rmSync(entry, { recursive: true, force: true });
    collected.push(name);
  }
  return collected;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function exists(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}
