import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  codeGraphStateDir,
  ensureCodeGraph,
  gitRoot,
  runCodeGraphWorker
} from "../../src/platform/code-graph-ensure.ts";

interface Fixture {
  root: string;
  env: NodeJS.ProcessEnv;
  calls(): string[];
  setIndexed(paths: string[]): void;
  cleanup(): void;
}

// A git checkout plus a fake `codegraphcontext` that records each call and
// answers `query` with the repository paths the test says are indexed.
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "autodev-code-graph-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
    { cwd: repo }
  );
  const log = join(base, "calls.log");
  const indexed = join(base, "indexed.json");
  writeFileSync(log, "");
  writeFileSync(indexed, "[]");
  const binary = join(base, "codegraphcontext");
  writeFileSync(
    binary,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  query) echo "Services initialized."; cat "${indexed}" ;;
  index|update) exit "\${FAKE_CGC_EXIT:-0}" ;;
esac
`,
    { mode: 0o755 }
  );
  const root = gitRoot(repo);
  assert.ok(root);
  return {
    root,
    env: {
      ...process.env,
      CODEX_HOME: join(base, "codex"),
      AUTODEV_CODEGRAPHCONTEXT_BIN: binary
    },
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    setIndexed: (paths) =>
      writeFileSync(indexed, JSON.stringify(paths.map((path) => ({ path })))),
    cleanup: () => rmSync(base, { recursive: true, force: true })
  };
}

test("a repository the graph does not list is indexed and stamped", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(runCodeGraphWorker(f.root, f.env), "indexed");
  assert.deepEqual(f.calls().slice(1), [`index --no-progress ${f.root}`]);
  const stateDir = codeGraphStateDir(f.root, f.env);
  const state = JSON.parse(
    readFileSync(join(stateDir, "state.json"), "utf8")
  ) as { action: string; stamp: string };
  assert.equal(state.action, "index");
  assert.match(state.stamp, /^[0-9a-f]{64}$/);
  assert.equal(existsSync(join(stateDir, "lock")), false);
});

test("a listed repository is refreshed, then skipped until the checkout changes", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  f.setIndexed([f.root]);
  assert.equal(runCodeGraphWorker(f.root, f.env), "updated");
  assert.deepEqual(f.calls().slice(1), [`update --quiet ${f.root}`]);

  assert.equal(runCodeGraphWorker(f.root, f.env), "fresh");
  assert.equal(f.calls().length, 3, "a fresh graph only runs the query");

  writeFileSync(join(f.root, "b.ts"), "export const b = 2;\n");
  assert.equal(runCodeGraphWorker(f.root, f.env), "updated");
  assert.equal(f.calls().at(-1), `update --quiet ${f.root}`);
});

test("a stamp from an earlier run does not skip a repository the graph lost", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  assert.equal(runCodeGraphWorker(f.root, f.env), "indexed");
  f.setIndexed([]);
  assert.equal(runCodeGraphWorker(f.root, f.env), "indexed");
});

test("a live lock holder makes the worker skip without calling CGC", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const stateDir = codeGraphStateDir(f.root, f.env);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "lock"), String(process.pid));
  assert.equal(runCodeGraphWorker(f.root, f.env), "locked");
  assert.deepEqual(f.calls(), []);
  assert.equal(
    readFileSync(join(stateDir, "lock"), "utf8"),
    String(process.pid)
  );
});

test("a lock left by an exited process is replaced", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const exited = spawnSync("true").pid;
  assert.ok(exited);
  const stateDir = codeGraphStateDir(f.root, f.env);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "lock"), String(exited));
  assert.equal(runCodeGraphWorker(f.root, f.env), "indexed");
  assert.equal(existsSync(join(stateDir, "lock")), false);
});

test("a failed index records no stamp, releases the lock, and retries next time", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const stateDir = codeGraphStateDir(f.root, f.env);
  assert.equal(
    runCodeGraphWorker(f.root, { ...f.env, FAKE_CGC_EXIT: "3" }),
    "failed"
  );
  assert.equal(existsSync(join(stateDir, "state.json")), false);
  assert.equal(existsSync(join(stateDir, "lock")), false);
  assert.equal(runCodeGraphWorker(f.root, f.env), "indexed");
});

test("ensureCodeGraph starts a worker for the checkout's top level only", (t) => {
  const f = fixture();
  t.after(f.cleanup);
  const started: { root: string; log: string }[] = [];
  const spawnWorker = (root: string, log: string): void => {
    started.push({ root, log });
  };
  const nested = join(f.root, "src");
  mkdirSync(nested);
  assert.equal(ensureCodeGraph(nested, f.env, spawnWorker), f.root);
  assert.deepEqual(started, [
    {
      root: f.root,
      log: join(codeGraphStateDir(f.root, f.env), "worker.log")
    }
  ]);

  const outside = mkdtempSync(join(tmpdir(), "autodev-code-graph-plain-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal(ensureCodeGraph(outside, f.env, spawnWorker), null);
  assert.equal(started.length, 1, "no worker outside a git checkout");
});
