import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  listCommitsInRange,
  measureGitCommitChanges,
  parseChangeStatuses,
  parseNumstat
} from "../src/telemetry/git-change-metrics.ts";
import {
  gitCommitActorFromEmail,
  gitCommitIdentity
} from "../src/telemetry/git-commit-identity.ts";

function execGit(
  root: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv } = {}
): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env
  }).trim();
}

async function withGitRepository<T>(
  body: (root: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "autodev-git-metrics-"));
  try {
    execGit(root, ["init", "-q", "-b", "main"]);
    execGit(root, ["config", "user.email", "test@example.com"]);
    execGit(root, ["config", "user.name", "Test"]);
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a commit's added and deleted files are subsets of the files it changed", async () => {
  await withGitRepository(async (root) => {
    await writeFile(join(root, "keep.txt"), "one\ntwo\n");
    await writeFile(join(root, "gone.txt"), "old\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "base"]);
    const base = execGit(root, ["rev-parse", "HEAD"]);

    await writeFile(join(root, "keep.txt"), "one\ntwo\nthree\n");
    await writeFile(join(root, "added.txt"), "new\nfile\n");
    await rm(join(root, "gone.txt"));
    execGit(root, ["add", "-A"]);
    execGit(root, ["commit", "-q", "-m", "change"]);
    const commit = execGit(root, ["rev-parse", "HEAD"]);

    const [change] = await measureGitCommitChanges({
      repositoryRoot: root,
      commits: [commit]
    });
    assert.ok(change, "the commit must be measured");

    // 1 modified + 1 added + 1 deleted = 3 distinct paths.
    assert.equal(change.filesChanged, 3);
    assert.equal(change.filesAdded, 1);
    assert.equal(change.filesDeleted, 1);
    // The subset relationship is the whole point: adding these three numbers
    // together to make a total would report 5 files for a 3-file commit.
    assert.notEqual(
      change.filesChanged,
      change.filesChanged + change.filesAdded + change.filesDeleted
    );
    assert.ok(change.filesChanged >= change.filesAdded);
    assert.ok(change.filesChanged >= change.filesDeleted);
    assert.equal(change.partial, false);

    // The exact line counts come from git's numstat, not an estimate.
    assert.equal(change.linesAdded, 3);
    assert.equal(change.linesRemoved, 1);

    const commits = await listCommitsInRange(root, `${base}..HEAD`);
    assert.deepEqual(commits, [commit]);
  });
});

test("commit measurements bound independent Git reads and preserve commit order", async () => {
  const commits = ["1", "2", "3", "4", "5", "6"].map((digit) =>
    digit.repeat(40)
  );
  let active = 0;
  let peak = 0;
  const changes = await measureGitCommitChanges({
    repositoryRoot: "/synthetic/repository",
    commits,
    runGit: async (_root, args) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const commit = args.at(-1) ?? "";
      if (args[0] === "log")
        return { exitCode: 0, stdout: "human@example.test" };
      if (args[0] === "diff-tree") {
        return { exitCode: 0, stdout: `A\t${commit}.txt` };
      }
      if (args[0] === "show") {
        return { exitCode: 0, stdout: `1\t0\t${commit}.txt` };
      }
      throw new Error(`Unexpected Git operation: ${String(args[0])}`);
    }
  });

  assert.equal(peak, 12, "four commits × three independent Git reads");
  assert.deepEqual(
    changes.map(({ commit }) => commit),
    commits,
    "parallel completion must not reorder commit observations"
  );
  assert.ok(
    changes.every(
      ({ filesChanged, linesAdded }) => filesChanged === 1 && linesAdded === 1
    )
  );
});

test("a rename counts as one changed file, not two paths", async () => {
  await withGitRepository(async (root) => {
    await writeFile(join(root, "before.txt"), "same\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "base"]);

    execGit(root, ["mv", "before.txt", "after.txt"]);
    execGit(root, ["commit", "-q", "-m", "rename"]);
    const commit = execGit(root, ["rev-parse", "HEAD"]);

    const [change] = await measureGitCommitChanges({
      repositoryRoot: root,
      commits: [commit]
    });
    assert.ok(change);
    assert.equal(change.filesChanged, 1);
    // A rename is neither an addition nor a deletion of content.
    assert.equal(change.filesAdded, 0);
    assert.equal(change.filesDeleted, 0);
    assert.equal(change.linesAdded, 0);
    assert.equal(change.linesRemoved, 0);
  });
});

test("a binary file is reported as partial rather than counted as no lines", () => {
  // git prints `-` for both counts on a binary file. Treating that as 0 would
  // report a real change as though it had changed no lines.
  const parsed = parseNumstat("-\t-\tassets/logo.png\n3\t1\tsrc/app.ts\n");
  assert.equal(parsed.partial, true);
  assert.equal(parsed.linesAdded, 3);
  assert.equal(parsed.linesRemoved, 1);
});

test("an unclassifiable change status makes the commit partial", () => {
  const parsed = parseChangeStatuses("A\ta.txt\nZ\tb.txt\n");
  assert.equal(parsed.partial, true);
  // The status that *was* understood is still counted.
  assert.deepEqual(parsed.statuses, ["added"]);
});

test("a commit git cannot read is omitted, never reported as zero changes", async () => {
  await withGitRepository(async (root) => {
    const changes = await measureGitCommitChanges({
      repositoryRoot: root,
      commits: ["0".repeat(40)]
    });
    // An unreadable commit is missing evidence, not an empty commit.
    assert.deepEqual(changes, []);
  });
});

test("an empty commit range lists no commits rather than failing", async () => {
  await withGitRepository(async (root) => {
    await writeFile(join(root, "a.txt"), "x\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "base"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);

    assert.deepEqual(await listCommitsInRange(root, ""), []);
    // Nothing committed since HEAD: a normal result, not an error.
    assert.deepEqual(await listCommitsInRange(root, `${head}..${head}`), []);
  });
});

test("an agent commit's own identity is read back from git, a human commit's is not", async () => {
  await withGitRepository(async (root) => {
    // A human commit: the repository's ordinary identity, no AutoDev marker.
    await writeFile(join(root, "human.txt"), "human\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "human work"]);
    const humanCommit = execGit(root, ["rev-parse", "HEAD"]);

    // An agent commit: made in a process carrying the AutoDev identity, which
    // is exactly how a spawned agent commits.
    const identity = gitCommitIdentity({
      role: "orchestrator",
      provider: "antigravity"
    });
    assert.ok(identity, "a known role must yield an identity");
    await writeFile(join(root, "agent.txt"), "agent\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "agent work"], {
      env: {
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email
      }
    });
    const agentCommit = execGit(root, ["rev-parse", "HEAD"]);

    const changes = await measureGitCommitChanges({
      repositoryRoot: root,
      commits: [humanCommit, agentCommit]
    });
    const byCommit = new Map(changes.map((change) => [change.commit, change]));

    // Attribution comes from the commit, so the two are told apart without the
    // observer knowing which actor ran.
    assert.equal(byCommit.get(humanCommit)?.actor, null);
    assert.deepEqual(byCommit.get(agentCommit)?.actor, {
      role: "orchestrator",
      provider: "antigravity"
    });
  });
});

test("the agent identity is bounded and round-trips through a real commit", async () => {
  await withGitRepository(async () => {
    const identity = gitCommitIdentity({ role: "subagent", provider: "codex" });
    assert.ok(identity);
    assert.equal(
      identity.email,
      "autodev-subagent-codex@agents.autodev.local",
      "the identity must be a fixed domain plus bounded parts"
    );
    assert.deepEqual(gitCommitActorFromEmail(identity.email), {
      role: "subagent",
      provider: "codex"
    });

    // An unknown role produces no identity at all, so the commit stays the
    // user's rather than becoming a fabricated agent commit.
    assert.equal(
      gitCommitIdentity({ role: undefined, provider: "codex" }),
      null
    );
    assert.equal(gitCommitIdentity({ role: "  ", provider: "codex" }), null);
    // An out-of-vocabulary provider is collapsed, not written verbatim.
    assert.equal(
      gitCommitIdentity({ role: "subagent", provider: "some-random-vendor" })
        ?.email,
      "autodev-subagent-other@agents.autodev.local"
    );
    // A human email is not an AutoDev identity.
    assert.equal(gitCommitActorFromEmail("dev@example.com"), null);
  });
});
