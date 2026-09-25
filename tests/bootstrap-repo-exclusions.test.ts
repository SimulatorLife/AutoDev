// Focused regression coverage for scripts/bootstrap-repo-exclusions.sh.
//
// Exercises the script against real temporary git repositories (never this
// repository's own .git/info/exclude) to prove: idempotent reconciliation,
// detection of the Rulesync/.agents/skills signal, the machine-local
// fallback path when no global excludes file is effective, avoidance of
// duplicate entries already covered by a tracked .gitignore or an effective
// global excludes file, and a clear failure outside a git repository. The
// script never touches home files or hook wiring, so tests point
// core.excludesFile and HOME at throwaway fixtures rather than the
// developer's real global config.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = join(
  repositoryRoot,
  "scripts",
  "bootstrap-repo-exclusions.sh"
);

interface RunOptions {
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

function runScript(cwd: string, options: RunOptions = {}) {
  return spawnSync("bash", [scriptPath, ...(options.args ?? [cwd])], {
    cwd,
    encoding: "utf8",
    env: options.env ?? process.env
  });
}

function makeRepo(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const init = spawnSync("git", ["init", "-q"], { cwd: directory });
  assert.equal(init.status, 0, init.stderr?.toString());
  return directory;
}

function excludePath(repo: string): string {
  return join(repo, ".git", "info", "exclude");
}

function readExclude(repo: string): string {
  try {
    return readFileSync(excludePath(repo), "utf8");
  } catch {
    return "";
  }
}

// A machine's real global excludes file / HOME must never be touched by this
// script or by these tests; every scenario below supplies its own throwaway
// HOME and excludesFile so behavior does not depend on (or mutate) developer
// machine state.
function withEffectiveGlobalExcludes(repo: string): NodeJS.ProcessEnv {
  const globalDir = mkdtempSync(join(tmpdir(), "autodev-bootstrap-global-"));
  const globalExcludes = join(globalDir, "gitignore_global");
  writeFileSync(globalExcludes, "*~\n.DS_Store\n");
  spawnSync("git", ["config", "--local", "core.excludesFile", globalExcludes], {
    cwd: repo
  });
  return process.env;
}

function withoutEffectiveGlobalExcludes(repo: string): NodeJS.ProcessEnv {
  const fakeHome = mkdtempSync(join(tmpdir(), "autodev-bootstrap-home-"));
  spawnSync("git", ["config", "--local", "--unset", "core.excludesFile"], {
    cwd: repo
  });
  return { ...process.env, HOME: fakeHome, XDG_CONFIG_HOME: fakeHome };
}

test("adds the Rulesync /.agents/skills/ entry when the repo generates it, and is idempotent", () => {
  const repo = makeRepo("autodev-bootstrap-rulesync-");
  try {
    mkdirSync(join(repo, ".rulesync", "skills"), { recursive: true });
    mkdirSync(join(repo, ".agents"), { recursive: true });
    const env = withEffectiveGlobalExcludes(repo);

    const first = runScript(repo, { args: [repo], env });
    assert.equal(first.status, 0, first.stderr);
    assert.match(readExclude(repo), /^\/\.agents\/skills\/$/m);

    const before = readExclude(repo);
    const second = runScript(repo, { args: [repo], env });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already up to date/);
    assert.equal(readExclude(repo), before, "rerun must not change the file");

    const check = runScript(repo, { args: ["--check", repo], env });
    assert.equal(check.status, 0, "clean repo must report no pending changes");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("does not add the Rulesync entry for a repo that does not generate .agents/skills", () => {
  const repo = makeRepo("autodev-bootstrap-no-rulesync-");
  try {
    const env = withEffectiveGlobalExcludes(repo);
    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readExclude(repo), /\.agents\/skills/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("falls back to a machine-local tool-config entry only when global excludes are not effective", () => {
  const repo = makeRepo("autodev-bootstrap-no-global-");
  try {
    const env = withoutEffectiveGlobalExcludes(repo);
    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /no effective global excludes file/);
    assert.match(readExclude(repo), /^\.claude\/settings\.local\.json$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("skips the machine-local fallback once an effective global excludes file exists", () => {
  const repo = makeRepo("autodev-bootstrap-global-present-");
  try {
    const env = withEffectiveGlobalExcludes(repo);
    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(readExclude(repo), /settings\.local\.json/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("does not duplicate an entry the tracked .gitignore already declares", () => {
  const repo = makeRepo("autodev-bootstrap-gitignore-covered-");
  try {
    mkdirSync(join(repo, ".rulesync", "skills"), { recursive: true });
    mkdirSync(join(repo, ".agents"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "/.agents/skills/\n");
    const env = withEffectiveGlobalExcludes(repo);

    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already up to date/);
    assert.doesNotMatch(readExclude(repo), /agents\/skills/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("preserves pre-existing info/exclude content and only appends missing entries", () => {
  const repo = makeRepo("autodev-bootstrap-preserve-");
  try {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(excludePath(repo), "# operator note\n/local-scratch/\n");
    mkdirSync(join(repo, ".rulesync", "skills"), { recursive: true });
    mkdirSync(join(repo, ".agents"), { recursive: true });
    const env = withEffectiveGlobalExcludes(repo);

    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);
    const content = readExclude(repo);
    assert.match(content, /# operator note/);
    assert.match(content, /^\/local-scratch\/$/m);
    assert.match(content, /^\/\.agents\/skills\/$/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("--check reports pending changes without writing and exits non-zero", () => {
  const repo = makeRepo("autodev-bootstrap-check-");
  try {
    mkdirSync(join(repo, ".rulesync", "skills"), { recursive: true });
    mkdirSync(join(repo, ".agents"), { recursive: true });
    const env = withEffectiveGlobalExcludes(repo);
    const before = readExclude(repo);

    const check = runScript(repo, { args: ["--check", repo], env });
    assert.equal(check.status, 1);
    assert.match(check.stderr, /would add/);
    assert.equal(
      readExclude(repo),
      before,
      "check mode must not write to info/exclude"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fails clearly outside a git repository and never creates .git", () => {
  const outside = mkdtempSync(join(tmpdir(), "autodev-bootstrap-nongit-"));
  try {
    const result = runScript(outside, { args: [outside], env: process.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not inside a git repository/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects an unknown option before touching any repository", () => {
  const repo = makeRepo("autodev-bootstrap-badopt-");
  try {
    const result = runScript(repo, {
      args: ["--bogus", repo],
      env: process.env
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown option/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CGC per-repo mode creates .cgcignore and keeps it untracked in info/exclude", () => {
  const repo = makeRepo("autodev-bootstrap-cgc-per-repo-");
  try {
    mkdirSync(join(repo, ".codegraphcontext"), { recursive: true });
    const env = withEffectiveGlobalExcludes(repo);

    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);

    const cgcignorePath = join(repo, ".cgcignore");
    const content = readFileSync(cgcignorePath, "utf8");
    assert.match(content, /repomix-output\.\*/);
    assert.match(content, /\.codegraphcontext\//);

    // .cgcignore must be kept untracked in info/exclude
    assert.match(readExclude(repo), /\.cgcignore/);

    // Idempotent: running again leaves .cgcignore identical
    const before = readFileSync(cgcignorePath, "utf8");
    const second = runScript(repo, { args: [repo], env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(cgcignorePath, "utf8"), before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CGC per-repo mode safely merges existing .cgcignore without overwriting user rules", () => {
  const repo = makeRepo("autodev-bootstrap-cgc-merge-");
  try {
    mkdirSync(join(repo, ".codegraphcontext"), { recursive: true });
    const cgcignorePath = join(repo, ".cgcignore");
    writeFileSync(cgcignorePath, "# Custom user rule\nmy-custom-build/\n");
    const env = withEffectiveGlobalExcludes(repo);

    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);

    const content = readFileSync(cgcignorePath, "utf8");
    assert.match(content, /# Custom user rule/);
    assert.match(content, /my-custom-build\//);
    assert.match(content, /repomix-output\.\*/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CGC global mode does not create repo-local .cgcignore", () => {
  const repo = makeRepo("autodev-bootstrap-cgc-global-");
  try {
    const env = withEffectiveGlobalExcludes(repo);
    const result = runScript(repo, {
      args: ["--cgc-mode", "global", repo],
      env
    });
    assert.equal(result.status, 0, result.stderr);

    const cgcignorePath = join(repo, ".cgcignore");
    let exists = true;
    try {
      readFileSync(cgcignorePath, "utf8");
    } catch {
      exists = false;
    }
    assert.equal(
      exists,
      false,
      ".cgcignore must not be created in global mode"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Repomix with useGitignore:false creates .repomixignore and keeps it untracked", () => {
  const repo = makeRepo("autodev-bootstrap-repomix-nogit-");
  try {
    writeFileSync(
      join(repo, "repomix.config.json"),
      JSON.stringify({ ignore: { useGitignore: false } }, null, 2)
    );
    const env = withEffectiveGlobalExcludes(repo);

    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);

    const repomixignorePath = join(repo, ".repomixignore");
    const content = readFileSync(repomixignorePath, "utf8");
    assert.match(content, /\*\*\/\.codegraphcontext\/\*\*/);
    assert.match(content, /\*\*\/\.cgc\/\*\*/);
    assert.match(content, /\*\*\/\.cocoindex_code\/\*\*/);

    // .repomixignore must be kept untracked in info/exclude
    assert.match(readExclude(repo), /\.repomixignore/);

    // Idempotent
    const before = readFileSync(repomixignorePath, "utf8");
    const second = runScript(repo, { args: [repo], env });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(repomixignorePath, "utf8"), before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Repomix with default settings does not create repo-local .repomixignore", () => {
  const repo = makeRepo("autodev-bootstrap-repomix-default-");
  try {
    writeFileSync(
      join(repo, "repomix.config.json"),
      JSON.stringify({ output: { style: "markdown" } }, null, 2)
    );
    const env = withEffectiveGlobalExcludes(repo);

    const result = runScript(repo, { args: [repo], env });
    assert.equal(result.status, 0, result.stderr);

    const repomixignorePath = join(repo, ".repomixignore");
    let exists = true;
    try {
      readFileSync(repomixignorePath, "utf8");
    } catch {
      exists = false;
    }
    assert.equal(
      exists,
      false,
      ".repomixignore must not be created when gitignore is used"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
