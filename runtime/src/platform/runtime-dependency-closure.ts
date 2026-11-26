/**
The installed Runtime's dependency closure: a protected copy of every package
the Runtime imports or launches, deployed by pnpm outside every workspace.

The installed source tree used to link `node_modules` back into the
checkout (`<repo>/node_modules`, `<repo>/runtime/node_modules`). Those trees
resolve the workspace packages (`@simulatorlife/autodev-core`, `-data`) as
symlinks to the editable sources, and their files are hard links into the
pnpm store shared with the checkout. When AutoDev itself is the authorized
workspace, an agent that could edit those files was editing the very
services that confine it.

`pnpm deploy --prod` produces a self-contained `node_modules` for the Runtime
package: workspace dependencies are injected as copies and every symlink in
the tree is relative to it. `package-import-method=clone-or-copy` keeps a
store hard link from aliasing a checkout file, so writing to the checkout
cannot reach the closure. The closure is named by the hash of everything the
deploy reads -- the lockfile, the workspace and patch configuration, the
Runtime manifest and the injected workspace packages -- so a read-only check
can name the closure an install would produce without running pnpm.

The workspace packages ship TypeScript sources, and Node refuses to strip
types from any file whose real path is under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). After the deploy each
injected workspace package is therefore moved to `<closure>/workspace/` and
linked back into place, with its own dependencies linked beside it, so it
resolves exactly as pnpm laid it out while its sources load from a real path
outside `node_modules`.
*/
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync
} from "node:fs";
import path from "node:path";

import { execaSync } from "execa";

/**
A fixed order for the hashed inputs; a different order (a new ICU) only names
a new closure, which the next install deploys.
*/
const PATH_ORDER = new Intl.Collator("en");
/**
The closure's on-disk layout revision; part of its name, so a layout change
deploys a new closure instead of reusing one laid out the old way.
*/
const CLOSURE_LAYOUT = 2;
/**
Where injected workspace packages live inside a closure, outside
`node_modules`.
*/
const WORKSPACE_DIRECTORY = "workspace";
/**
pnpm's virtual store entries for local (`file:`) packages, which is how
`pnpm deploy` injects workspace dependencies.
*/
const INJECTED_ENTRY = "@file+";
/**
Every closure's directory name starts with this.
*/
const CLOSURE_PREFIX = ".deps-";
/**
In-progress deploys: `.deps-<hash>.tmp-<pid>`.
*/
const BUILD_MARKER = ".tmp-";
/**
The Runtime package `pnpm deploy` selects.
*/
const RUNTIME_PACKAGE = "@simulatorlife/autodev-runtime";
/**
Repository files that decide what the deploy installs.
*/
const CLOSURE_INPUT_FILES = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "runtime/package.json"
] as const;
/**
Directories whose contents the deploy copies into the closure: the injected
workspace packages and the dependency patches. Build and dependency output
inside them is not deploy input.
*/
const CLOSURE_INPUT_DIRECTORIES = ["core", "data", "patches"] as const;
const IGNORED_INPUT_ENTRIES = new Set([
  "node_modules",
  "tsconfig.tsbuildinfo",
  ".DS_Store"
]);

function collectInputFiles(root: string, relative: string, into: string[]) {
  let entries;
  try {
    entries = readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (IGNORED_INPUT_ENTRIES.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) collectInputFiles(root, child, into);
    else if (entry.isFile() || entry.isSymbolicLink()) into.push(child);
  }
}

/**
The directory name the closure for this checkout is deployed under.
*/
export function runtimeDependencyClosureName(repositoryRoot: string): string {
  const files: string[] = [...CLOSURE_INPUT_FILES];
  for (const directory of CLOSURE_INPUT_DIRECTORIES)
    collectInputFiles(repositoryRoot, directory, files);
  const hash = createHash("sha256");
  hash.update(`layout:${CLOSURE_LAYOUT}\0`);
  files.sort(PATH_ORDER.compare);
  for (const relativePath of files) {
    const filePath = path.join(repositoryRoot, relativePath);
    const content = lstatSync(filePath).isSymbolicLink()
      ? Buffer.from(`symlink:${readlinkSync(filePath)}`)
      : readFileSync(filePath);
    hash.update(`${relativePath}\0${content.length}\0`);
    hash.update(content);
  }
  return `${CLOSURE_PREFIX}${hash.digest("hex").slice(0, 16)}`;
}

/**
The `node_modules` directory of the closure for this checkout.
*/
export function runtimeDependencyClosure(
  repositoryRoot: string,
  codexHome: string
): string {
  return path.join(
    codexHome,
    runtimeDependencyClosureName(repositoryRoot),
    "node_modules"
  );
}

export type DeployRuntimeClosure = (
  repositoryRoot: string,
  target: string
) => void;

/**
`pnpm deploy` of the Runtime package's production dependencies.
*/
export const deployWithPnpm: DeployRuntimeClosure = (
  repositoryRoot,
  target
) => {
  execaSync(
    "pnpm",
    [
      "--filter",
      RUNTIME_PACKAGE,
      "deploy",
      "--prod",
      "--prefer-offline",
      "--config.package-import-method=clone-or-copy",
      target
    ],
    { cwd: repositoryRoot, stdio: ["ignore", "ignore", "inherit"] }
  );
};

export interface RuntimeDependencyClosureResult {
  /**
  The closure's `node_modules`.
  */
  readonly nodeModules: string;
  /**
  Whether this call deployed it.
  */
  readonly deployed: boolean;
}

/**
Deploy this checkout's closure under `$CODEX_HOME` unless it is already
there. The deploy runs beside its final name and is renamed into place, so a
closure directory only ever exists complete; everything but `node_modules`
(the Runtime package's own files, which the source generation installs) is
dropped first.
*/
export function materializeRuntimeDependencyClosure(
  repositoryRoot: string,
  codexHome: string,
  deploy: DeployRuntimeClosure = deployWithPnpm
): RuntimeDependencyClosureResult {
  const name = runtimeDependencyClosureName(repositoryRoot);
  const target = path.join(codexHome, name);
  const nodeModules = path.join(target, "node_modules");
  if (doesExist(nodeModules)) return { nodeModules, deployed: false };
  const build = `${target}${BUILD_MARKER}${process.pid}`;
  rmSync(build, { recursive: true, force: true });
  try {
    deploy(repositoryRoot, build);
    for (const entry of readdirSync(build))
      if (entry !== "node_modules")
        rmSync(path.join(build, entry), { recursive: true, force: true });
    if (!doesExist(path.join(build, "node_modules")))
      throw new Error(`pnpm deploy produced no node_modules in ${build}`);
    relocateWorkspacePackages(build);
    try {
      renameSync(build, target);
    } catch (error) {
      // A concurrent install published the same closure first.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
  return { nodeModules, deployed: true };
}

/**
Re-create `link` (an absolute-target symlink's location) at `location`,
pointing at the same target with a relative path, so the tree stays
self-contained.
*/
function relinkBeside(link: string, location: string): void {
  const target = path.resolve(path.dirname(link), readlinkSync(link));
  mkdirSync(path.dirname(location), { recursive: true });
  symlinkSync(path.relative(path.dirname(location), target), location);
}

/**
The real package directories of one virtual-store entry's `node_modules`
(`name` or `@scope/name`), and the dependency links beside them.
*/
function entryContents(modules: string): {
  readonly packages: string[];
  readonly links: string[];
} {
  const packages: string[] = [];
  const links: string[] = [];
  for (const name of readdirSync(modules)) {
    if (name === ".bin") continue;
    const scoped = name.startsWith("@")
      ? readdirSync(path.join(modules, name)).map((child) => `${name}/${child}`)
      : [name];
    for (const packageName of scoped) {
      const entryPath = path.join(modules, packageName);
      if (lstatSync(entryPath).isSymbolicLink()) links.push(packageName);
      else packages.push(packageName);
    }
  }
  return { packages, links };
}

/**
Move every injected workspace package out of `node_modules` (see the module
documentation) and link it back where pnpm placed it.
*/
function relocateWorkspacePackages(closureRoot: string): void {
  const store = path.join(closureRoot, "node_modules", ".pnpm");
  for (const entry of readdirSync(store)) {
    if (!entry.includes(INJECTED_ENTRY)) continue;
    const modules = path.join(store, entry, "node_modules");
    const { packages, links } = entryContents(modules);
    for (const packageName of packages) {
      const placed = path.join(modules, packageName);
      const relocated = path.join(
        closureRoot,
        WORKSPACE_DIRECTORY,
        packageName.replace("/", "+")
      );
      mkdirSync(path.dirname(relocated), { recursive: true });
      renameSync(placed, relocated);
      symlinkSync(path.relative(path.dirname(placed), relocated), placed);
      // The package resolves its dependencies from its own node_modules now
      // that the virtual-store directory is no longer above it.
      for (const dependency of links)
        relinkBeside(
          path.join(modules, dependency),
          path.join(relocated, "node_modules", dependency)
        );
    }
  }
}

/**
Remove closures nothing installed links to any more, and the build
directories of installs that died before finishing. `referenced` is every
closure directory a retained source generation or `$CODEX_HOME/node_modules`
still resolves through.
*/
export function collectRuntimeDependencyClosures(
  codexHome: string,
  referenced: ReadonlySet<string>
): string[] {
  const collected: string[] = [];
  for (const name of readdirSync(codexHome)) {
    if (!name.startsWith(CLOSURE_PREFIX)) continue;
    const pid = Number(name.slice(name.lastIndexOf("-") + 1));
    if (name.includes(BUILD_MARKER)) {
      if (isProcessAlive(pid)) continue;
    } else if (referenced.has(name)) {
      continue;
    }
    rmSync(path.join(codexHome, name), { recursive: true, force: true });
    collected.push(name);
  }
  return collected;
}

/**
The closure directory name a `node_modules` link under `$CODEX_HOME`
resolves to, or null when it resolves anywhere else.
*/
export function referencedRuntimeDependencyClosure(
  codexHome: string,
  link: string
): string | null {
  let target: string;
  try {
    target = path.resolve(path.dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
  const [name, rest, ...extra] = path
    .relative(codexHome, target)
    .split(path.sep);
  const isClosureModules =
    extra.length === 0 &&
    rest === "node_modules" &&
    name?.startsWith(CLOSURE_PREFIX) === true &&
    !name.includes(BUILD_MARKER);
  return isClosureModules ? name! : null;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function doesExist(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}
