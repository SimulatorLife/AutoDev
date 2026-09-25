/**
 * Keeps the active repository's CodeGraphContext graph present and current.
 *
 * Session start owns graph creation and refresh so agents never index a
 * repository themselves: CGC answers structural queries against a repository
 * it has not indexed with a successful, empty result, which reads as "no
 * callers" rather than as missing context. Session start spawns a detached
 * worker and returns at once; the worker indexes a repository the graph does
 * not know, refreshes one whose checkout changed since the last successful
 * run, and otherwise does nothing. Its lock, freshness stamp, and log live in
 * AutoDev's own state directory, never in the repository.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCodeGraphContextBinary } from "../shared/executables.ts";
import { writeErrorLine, writeLine } from "../shared/output.ts";

const WORKER_FLAG = "--worker";
const REPOSITORIES_QUERY = "MATCH (r:Repository) RETURN r.path AS path";
const JSON_RESULT_START = /^\[/m;

export interface CodeGraphState {
  stamp: string;
  refreshedAt: string;
  action: "index" | "update";
}

export type CodeGraphWorkerResult =
  "indexed" | "updated" | "fresh" | "locked" | "failed";

/** The repository's git top level, or null outside a git checkout. */
export function gitRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return null;
  }
}

/** AutoDev's per-repository CGC state directory. */
export function codeGraphStateDir(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const codexHome =
    env.CODEX_HOME ?? path.join(env.HOME ?? homedir(), ".codex");
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return path.join(codexHome, "provider-runtime", "code-graph", key);
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return "";
  }
}

/** Identifies the checkout's content: the commit plus every uncommitted change. */
export function checkoutStamp(root: string): string {
  return createHash("sha256")
    .update(git(root, ["rev-parse", "HEAD"]))
    .update("\0")
    .update(git(root, ["status", "--porcelain", "--untracked-files=all"]))
    .digest("hex");
}

function readState(file: string): CodeGraphState | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CodeGraphState;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the per-repository lock, replacing one whose owner has exited. */
function acquireLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(readFileSync(lock, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && processAlive(owner))
        return false;
      rmSync(lock, { force: true });
    }
  }
  return false;
}

/** The repository paths the graph has indexed, parsed from `query`'s JSON. */
function indexedRepositories(binary: string, env: NodeJS.ProcessEnv): string[] {
  const output = execFileSync(binary, ["query", REPOSITORIES_QUERY], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const start = output.search(JSON_RESULT_START);
  if (start < 0)
    throw new Error("codegraphcontext query returned no JSON result");
  const rows = JSON.parse(output.slice(start)) as { path?: unknown }[];
  return rows
    .map((row) => row.path)
    .filter((value): value is string => typeof value === "string");
}

/** Index or refresh `root`'s graph unless it is current or another run holds it. */
export function runCodeGraphWorker(
  root: string,
  env: NodeJS.ProcessEnv = process.env
): CodeGraphWorkerResult {
  const stateDir = codeGraphStateDir(root, env);
  mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, "lock");
  const stateFile = path.join(stateDir, "state.json");
  if (!acquireLock(lock)) return "locked";
  try {
    const stamp = checkoutStamp(root);
    const binary = resolveCodeGraphContextBinary(env);
    if (!binary)
      throw new Error(
        "CodeGraphContext binary is missing; install codegraphcontext or set AUTODEV_CODEGRAPHCONTEXT_BIN"
      );
    const indexed = indexedRepositories(binary, env).includes(root);
    if (indexed && readState(stateFile)?.stamp === stamp) return "fresh";
    const action = indexed ? "update" : "index";
    execFileSync(
      binary,
      indexed ? ["update", "--quiet", root] : ["index", "--no-progress", root],
      { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] }
    );
    const state: CodeGraphState = {
      stamp,
      refreshedAt: new Date().toISOString(),
      action
    };
    writeFileSync(`${stateFile}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${stateFile}.tmp`, stateFile);
    return indexed ? "updated" : "indexed";
  } catch (error) {
    writeErrorLine(
      `code-graph-ensure: ${root}: ${error instanceof Error ? error.message : error}`
    );
    return "failed";
  } finally {
    rmSync(lock, { force: true });
  }
}

export type SpawnCodeGraphWorker = (root: string, log: string) => void;

function spawnDetachedWorker(root: string, log: string): void {
  const fd = openSync(log, "a", 0o600);
  try {
    spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), WORKER_FLAG, root],
      { detached: true, stdio: ["ignore", fd, fd] }
    ).unref();
  } finally {
    closeSync(fd);
  }
}

/**
 * Start the background worker for the checkout containing `cwd`. Returns the
 * repository root it was started for, or null outside a git checkout.
 */
export function ensureCodeGraph(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  spawnWorker: SpawnCodeGraphWorker = spawnDetachedWorker
): string | null {
  const root = gitRoot(cwd);
  if (!root) return null;
  const stateDir = codeGraphStateDir(root, env);
  mkdirSync(stateDir, { recursive: true });
  spawnWorker(root, path.join(stateDir, "worker.log"));
  return root;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, root] = process.argv.slice(2);
  if (flag !== WORKER_FLAG || !root) {
    writeErrorLine(`usage: code-graph-ensure.ts ${WORKER_FLAG} <repo-root>`);
    process.exitCode = 2;
  } else {
    const result = runCodeGraphWorker(root);
    writeLine(`${new Date().toISOString()} ${root}: ${result}`);
    process.exitCode = result === "failed" ? 1 : 0;
  }
}
