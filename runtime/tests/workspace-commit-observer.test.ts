import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AggregationTemporality,
  InMemoryMetricExporter
} from "@opentelemetry/sdk-metrics";

import { resetRouterWorkspaceGitObserversForTest } from "../src/router/git-commit-observation.ts";
import {
  flushTelemetryMetrics,
  METRIC_GIT_COMMITS,
  observeRouterWorkspaceGitCommits,
  resetTrackedGitCommitsForTest,
  setTelemetryMetricExporterForTest
} from "../src/router/telemetry.ts";
import {
  gitCommitIdentity,
  gitCommitIdentityEnv
} from "../src/telemetry/git-commit-identity.ts";
import {
  createWorkspaceCommitObserver,
  gitCommitObservationToRecordOptions,
  type RunGit
} from "../src/telemetry/workspace-commit-observer.ts";

const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE
);
setTelemetryMetricExporterForTest(metricExporter);

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
  const root = await mkdtemp(join(tmpdir(), "autodev-workspace-observer-"));
  try {
    execGit(root, ["init", "-q", "-b", "main", "--template="]);
    execGit(root, ["config", "user.email", "test@example.com"]);
    execGit(root, ["config", "user.name", "Test"]);
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function realRunGit(root: string): RunGit {
  return async (repositoryRoot, args) => {
    if (repositoryRoot !== root) {
      return { exitCode: -1, stdout: "" };
    }
    try {
      const stdout = execGit(root, args);
      return { exitCode: 0, stdout };
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
      return {
        exitCode: typeof code === "number" ? code : -1,
        stdout: ""
      };
    }
  };
}

test("constructor rejects a workspace key that is not source-confirmed", () => {
  // The metric path is opaque: a path, URL, or reserved word would
  // contaminate metric dimensions. None of these are valid source-
  // confirmed keys.
  for (const bad of [
    "/etc/passwd",
    "~/.ssh/id_rsa",
    "unknown",
    "unattributed",
    "",
    "https://example.com/repo"
  ]) {
    assert.throws(
      () =>
        createWorkspaceCommitObserver({
          workspaceKey: bad,
          repositoryRoot: "/tmp"
        }),
      /workspaceKey/,
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
  // An empty repositoryRoot is also a caller error.
  assert.throws(
    () =>
      createWorkspaceCommitObserver({
        workspaceKey: "ws-test-000",
        repositoryRoot: ""
      }),
    /repositoryRoot/
  );
});

test("the first observation is a baseline; later ones list new commits", async () => {
  await withGitRepository(async (root) => {
    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-001",
      repositoryRoot: root,
      clock: () => 1000
    });

    // No commits yet: the first observation captures the empty baseline.
    const baseline = await observer.observe();
    assert.equal(baseline.isBaseline, true);
    assert.equal(baseline.baselineHead, null);
    assert.equal(baseline.currentHead, null);
    assert.equal(baseline.observedButNotRecordable.length, 0);
    assert.equal(baseline.unmeasured.length, 0);
    assert.equal(baseline.error, null);
    assert.equal(observer.isInitialized(), true);
    assert.equal(baseline.observedAt, 1000);

    // First real commit: the observer now has a HEAD to anchor on.
    await writeFile(join(root, "a.txt"), "a\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "first"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);

    const after = await observer.observe();
    assert.equal(after.isBaseline, false);
    assert.equal(after.baselineHead, null, "the prior baseline was null");
    assert.equal(after.currentHead, head);
    assert.equal(after.recordableCommits.length, 0);
    assert.equal(after.observedButNotRecordable.length, 1);
    assert.equal(after.observedButNotRecordable[0]?.commit, head);
    assert.equal(after.observedButNotRecordable[0]?.filesChanged, 1);
    assert.equal(after.observedButNotRecordable[0]?.linesAdded, 1);
    assert.equal(after.unmeasured.length, 0);
    assert.equal(after.error, null);

    // No new commits: a second observe after the advance reports nothing.
    const stable = await observer.observe();
    assert.equal(stable.isBaseline, false);
    assert.equal(stable.currentHead, head);
    assert.equal(stable.observedButNotRecordable.length, 0);
    assert.equal(stable.error, null);
  });
});

test("explicit initialize() captures the baseline before commits happen", async () => {
  await withGitRepository(async (root) => {
    // Make a commit, then initialize against it, then make a new one
    // and observe. The baseline must come from initialize(), not from
    // the first observe() call.
    await writeFile(join(root, "a.txt"), "a\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "base"]);
    const base = execGit(root, ["rev-parse", "HEAD"]);

    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-002",
      repositoryRoot: root
    });
    const baseline = await observer.initialize();
    assert.equal(baseline.head, base);
    assert.equal(observer.isInitialized(), true);

    await writeFile(join(root, "b.txt"), "b\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "next"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);

    const observation = await observer.observe();
    assert.equal(observation.isBaseline, false);
    // Log-mode baseline: the baseline is the captured HEAD at
    // initialize() and does not advance when an observation
    // succeeds. The same range is re-listed on every observe(),
    // and the process dedup keeps the same commit from being
    // reported twice.
    assert.equal(observation.baselineHead, base);
    assert.equal(observation.currentHead, head);
    assert.equal(observation.recordableCommits.length, 0);
    assert.equal(observation.observedButNotRecordable.length, 1);
    assert.equal(observation.observedButNotRecordable[0]?.commit, head);
  });
});

test("the actor on each commit is read from the commit's committer identity", async () => {
  await withGitRepository(async (root) => {
    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-003",
      repositoryRoot: root
    });
    await observer.initialize();

    // A human commit: the repository's ordinary identity, no AutoDev
    // marker. Attribution is null because the commit did not establish
    // an AutoDev actor.
    await writeFile(join(root, "h.txt"), "h\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "human"]);
    const humanCommit = execGit(root, ["rev-parse", "HEAD"]);

    // An agent commit: the process environment carries the bounded
    // AutoDev committer identity, so the commit itself is the source
    // of its attribution.
    const identity = gitCommitIdentity({
      role: "orchestrator",
      provider: "antigravity"
    });
    assert.ok(identity, "a known role and provider must yield an identity");
    await writeFile(join(root, "a.txt"), "a\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "agent"], {
      env: {
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email
      }
    });
    const agentCommit = execGit(root, ["rev-parse", "HEAD"]);

    const observation = await observer.observe();
    // The human commit goes to observedButNotRecordable because the
    // observer cannot vouch for it as AutoDev agent output. The
    // agent commit goes to recordableCommits with its source-
    // confirmed actor.
    assert.equal(observation.recordableCommits.length, 1);
    assert.equal(observation.observedButNotRecordable.length, 1);
    const recordable = observation.recordableCommits[0];
    const observed = observation.observedButNotRecordable[0];
    assert.equal(recordable?.commit, agentCommit);
    assert.deepEqual(recordable?.actor, {
      role: "orchestrator",
      provider: "antigravity"
    });
    assert.ok(observation, "an observation must exist");
    assert.ok(recordable, "the agent commit must be recordable");
    assert.deepEqual(
      gitCommitObservationToRecordOptions(observation, recordable),
      {
        commit: agentCommit,
        filesChanged: 1,
        filesAdded: 1,
        filesDeleted: 0,
        linesAdded: 1,
        linesRemoved: 0,
        partial: false,
        workspace: { key: "ws-test-003" },
        role: "orchestrator",
        provider: "antigravity",
        model: null,
        actorFromCommitIdentity: true
      }
    );
    assert.equal(observed?.commit, humanCommit);
    assert.equal(observed?.actor, null);
    assert.ok(observed, "the human commit must remain observable separately");
    assert.throws(
      () => gitCommitObservationToRecordOptions(observation, observed),
      /non-AutoDev commit/u
    );
  });
});

test("an unmeasurable commit blocks the baseline and is retried", async () => {
  await withGitRepository(async (root) => {
    await writeFile(join(root, "a.txt"), "a\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "base"]);
    const base = execGit(root, ["rev-parse", "HEAD"]);

    // Inject a runGit that refuses to summarize the new commit. The
    // listing, the committer-email read, and everything else still
    // work, so the failure is isolated to a single commit.
    const failing = new Set<string>();
    const real = realRunGit(root);
    const runGit: RunGit = async (repositoryRoot, args) => {
      if (args[0] === "show") {
        const commit = args.at(-1);
        if (commit && failing.has(commit)) {
          return { exitCode: 128, stdout: "" };
        }
      }
      return real(repositoryRoot, args);
    };

    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-004",
      repositoryRoot: root,
      runGit
    });
    await observer.initialize();

    await writeFile(join(root, "b.txt"), "b\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "change"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);
    failing.add(head);

    const first = await observer.observe();
    assert.equal(first.recordableCommits.length, 0);
    assert.equal(first.unmeasured.length, 1);
    assert.equal(first.unmeasured[0]?.commit, head);
    assert.equal(first.error?.kind, "unmeasured_commits");
    // Baseline must not advance past the unmeasured commit: a smaller
    // "no commits" reading would erase the evidence this turn produced.
    assert.equal(first.baselineHead, base);
    assert.equal(first.currentHead, head);

    // A second attempt with the same broken runGit still does not
    // advance: the rule is not "succeed once and forget", it is
    // "measure every commit before advancing".
    const second = await observer.observe();
    assert.equal(second.recordableCommits.length, 0);
    assert.equal(second.unmeasured.length, 1);
    assert.equal(second.error?.kind, "unmeasured_commits");
    assert.equal(second.baselineHead, base);

    // With a healthy runGit, the commit is measured and the baseline
    // advances to HEAD.
    failing.clear();
    const third = await observer.observe();
    assert.equal(third.observedButNotRecordable.length, 1);
    assert.equal(third.observedButNotRecordable[0]?.commit, head);
    assert.equal(third.unmeasured.length, 0);
    assert.equal(third.error, null);
    assert.equal(third.baselineHead, base);
    const settled = await observer.observe();
    assert.equal(settled.baselineHead, head);
    assert.equal(settled.currentHead, head);
    assert.equal(settled.recordableCommits.length, 0);
    assert.equal(settled.observedButNotRecordable.length, 0);
  });
});

test("independent observers surface the same commit for emitter-level deduplication", async () => {
  await withGitRepository(async (root) => {
    await writeFile(join(root, "base.txt"), "base\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "base"]);
    const base = execGit(root, ["rev-parse", "HEAD"]);

    // Two observers, same root, same workspace key. Both initialize
    // against the same HEAD. The observer reports source measurements;
    // the shared Runtime telemetry emitter owns cross-producer commit
    // idempotency when both forward the same observation.
    const a = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-005",
      repositoryRoot: root
    });
    const b = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-005",
      repositoryRoot: root
    });
    await a.initialize();
    await b.initialize();

    await writeFile(join(root, "x.txt"), "x\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "x"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);

    const [obsA, obsB] = await Promise.all([a.observe(), b.observe()]);
    for (const observation of [obsA, obsB]) {
      assert.equal(observation.observedButNotRecordable.length, 1);
      assert.equal(observation.observedButNotRecordable[0]?.commit, head);
      assert.equal(observation.unmeasured.length, 0);
      assert.equal(observation.error, null);
      assert.equal(observation.baselineHead, base);
    }
  });
});

test("observe() runs in order when fired concurrently on one observer", async () => {
  await withGitRepository(async (root) => {
    await writeFile(join(root, "a.txt"), "a\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "base"]);
    const base = execGit(root, ["rev-parse", "HEAD"]);
    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-006",
      repositoryRoot: root
    });
    await observer.initialize();
    await writeFile(join(root, "b.txt"), "b\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "next"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);

    // Fire five observe() calls in parallel. The first one to acquire
    // the chain captures the commits; the rest see an already-advanced
    // baseline and report nothing. Without the serialization, two
    // observes could each claim half the range or race the dedup set.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => observer.observe())
    );
    const total = results.reduce(
      (sum, r) => sum + r.observedButNotRecordable.length,
      0
    );
    assert.equal(
      total,
      1,
      "exactly one of the parallel observes must report the new commit"
    );
    const observed = results.find(
      (r) => r.observedButNotRecordable.length === 1
    );
    assert.ok(observed, "exactly one result must report a new commit");
    // The first observe() in submission order measures from the baseline
    // captured before the commit.
    assert.equal(observed?.isBaseline, false);
    assert.equal(observed?.currentHead, head);
    // The other observes see the advanced baseline.
    const idles = results.filter(
      (r) => r.observedButNotRecordable.length === 0
    );
    assert.equal(idles.length, 4);
    for (const idle of idles) {
      assert.equal(idle.error, null);
      assert.equal(idle.unmeasured.length, 0);
    }
    assert.equal(observed?.baselineHead, base);
    assert.ok(idles.every((idle) => idle.baselineHead === head));
  });
});

test("git failures are reported, not absorbed into a fabricated zero", async () => {
  await withGitRepository(async (root) => {
    await writeFile(join(root, "a.txt"), "a\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "base"]);
    const base = execGit(root, ["rev-parse", "HEAD"]);
    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-007",
      repositoryRoot: root,
      runGit: async (repositoryRoot, args) => {
        if (args[0] === "rev-list") {
          return { exitCode: 128, stdout: "" };
        }
        return realRunGit(root)(repositoryRoot, args);
      }
    });
    await observer.initialize();

    await writeFile(join(root, "b.txt"), "b\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "next"]);
    const head = execGit(root, ["rev-parse", "HEAD"]);

    // Simulate git being partially broken: HEAD reads succeed, but the
    // listing call fails. This is the case where a fabricated "no new
    // commits" would be a different fact than "git could not tell us".

    const observation = await observer.observe();
    assert.equal(observation.recordableCommits.length, 0);
    assert.equal(observation.unmeasured.length, 0);
    assert.equal(observation.error?.kind, "list_failed");
    // The baseline must not advance: there is no evidence either way.
    assert.equal(observation.baselineHead, base);
    assert.equal(observation.currentHead, head);

    // A second observe() with the same broken listing still does not
    // fabricate progress. The same error is reported.
    const second = await observer.observe();
    assert.equal(second.error?.kind, "list_failed");
    assert.equal(second.baselineHead, base);
    assert.equal(second.recordableCommits.length, 0);
  });
});

test("a completely broken git surfaces a head-unreadable error", async () => {
  await withGitRepository(async (root) => {
    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-008",
      repositoryRoot: root,
      runGit: async () => ({ exitCode: 128, stdout: "" })
    });

    // initialize() throws because the repo has no readable HEAD; the
    // error is a caller-visible failure rather than a hidden state.
    await assert.rejects(
      observer.initialize(),
      /workspace-commit-observer: cannot read HEAD/
    );

    // observe() in this state returns an error observation rather than
    // a fabricated empty one.
    const observation = await observer.observe();
    assert.equal(observation.error?.kind, "head_unreadable");
    assert.equal(observation.recordableCommits.length, 0);
    assert.equal(observation.baselineHead, null);
  });
});

test("an empty repository reports a null head and never fabricates commits", async () => {
  await withGitRepository(async (root) => {
    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-009",
      repositoryRoot: root
    });
    const observation = await observer.observe();
    assert.equal(observation.isBaseline, true);
    assert.equal(observation.currentHead, null);
    assert.equal(observation.baselineHead, null);
    assert.equal(observation.recordableCommits.length, 0);
    assert.equal(observation.error, null);
  });
});

test("the first commit after a baseline is reported even when the baseline is null", async () => {
  await withGitRepository(async (root) => {
    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-010",
      repositoryRoot: root
    });

    // Baseline: empty repo, head = null.
    const baseline = await observer.observe();
    assert.equal(baseline.isBaseline, true);
    assert.equal(baseline.currentHead, null);

    // First real commit, made by an agent that the process will attribute
    // back to itself.
    const identity = gitCommitIdentity({ role: "subagent", provider: "codex" });
    assert.ok(identity);
    await writeFile(join(root, "agent.txt"), "agent\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "agent"], {
      env: {
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email
      }
    });
    const head = execGit(root, ["rev-parse", "HEAD"]);

    const observation = await observer.observe();
    assert.equal(observation.isBaseline, false);
    // Log-mode baseline: the captured baseline was null on the
    // empty repo, and it stays null because the baseline never
    // advances on observation. The process dedup is what stops
    // this commit from being re-reported on a subsequent observe.
    assert.equal(observation.baselineHead, null);
    assert.equal(observation.currentHead, head);
    assert.equal(observation.recordableCommits.length, 1);
    assert.equal(observation.recordableCommits[0]?.commit, head);
    assert.deepEqual(observation.recordableCommits[0]?.actor, {
      role: "subagent",
      provider: "codex"
    });
  });
});

test("reset() clears the per-observer cursor", async () => {
  await withGitRepository(async (root) => {
    const observer = createWorkspaceCommitObserver({
      workspaceKey: "ws-test-011",
      repositoryRoot: root
    });
    await observer.initialize();
    observer.reset();
    assert.equal(observer.isInitialized(), false);
    // Re-initializing after a reset re-captures HEAD as the new baseline.
    const baseline = await observer.initialize();
    assert.equal(observer.isInitialized(), true);
    assert.equal(
      typeof baseline.head === "string" || baseline.head === null,
      true
    );
  });
});

test("Router selected/result events emit only commit-identity Git metrics", async () => {
  resetRouterWorkspaceGitObserversForTest();
  resetTrackedGitCommitsForTest();
  metricExporter.reset();

  await withGitRepository(async (root) => {
    const workspaceKey = "ws-test-commit-output";
    const observe = (phase: "selected" | "result") =>
      observeRouterWorkspaceGitCommits({
        phase,
        workspaceKey,
        repositoryRoot: root,
        routerInstanceId: "router-commit-observer-test"
      });

    await observe("selected");

    await writeFile(join(root, "operator.txt"), "operator\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "operator"]);

    const identity = gitCommitIdentity({ role: "worker", provider: "codex" });
    assert.ok(identity);
    await writeFile(join(root, "agent.txt"), "agent\n");
    execGit(root, ["add", "."]);
    execGit(root, ["commit", "-q", "-m", "agent"], {
      env: gitCommitIdentityEnv({ role: "worker", provider: "codex" })
    });

    await observe("result");
    await flushTelemetryMetrics();

    const metric = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === METRIC_GIT_COMMITS);
    assert.ok(metric, "the commit counter must be emitted");
    const points = metric.dataPoints as unknown as readonly {
      readonly attributes: Readonly<Record<string, unknown>>;
      readonly value: number;
    }[];
    assert.equal(points.length, 1);
    const point = points[0];
    assert.ok(point);
    assert.equal(point.value, 1);
    assert.equal(point.attributes["autodev.workspace"], workspaceKey);
    assert.equal(point.attributes["autodev.agent.role"], "worker");
    assert.equal(point.attributes["gen_ai.provider.name"], "codex");
    assert.equal(
      point.attributes["autodev.git.attribution"],
      "commit_identity"
    );
    assert.equal(point.attributes["gen_ai.request.model"], undefined);
    const dimensions = JSON.stringify(point.attributes);
    assert.equal(dimensions.includes("agent.txt"), false);
    assert.equal(dimensions.includes("operator.txt"), false);
  });
});
