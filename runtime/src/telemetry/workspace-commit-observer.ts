/**
 * Bounded per-workspace Git commit observer.
 *
 * Section 10 of docs/autodev-console-target-state.md ("Git change metrics")
 * requires that one observation be emitted per commit an AutoDev-managed
 * agent actually creates, attributed to the commit's own committer rather
 * than to the observing Runtime. This module is the producer side of that
 * contract for the common case where the Runtime has the workspace at
 * hand: it watches one workspace (a checked-out repository rooted at a
 * specific path), records a baseline HEAD when the turn starts, and on
 * demand lists and measures whatever commits the agent added before the
 * turn ended.
 *
 * The observer is deliberately narrow:
 *
 * - one workspace, one repository root, one observer;
 * - the actor is read from the commit's own committer identity via
 *   `gitCommitActorFromEmail`; the observer never accepts a role or
 *   provider from the caller, because the caller is a Runtime that may
 *   share the workspace with subagents and therefore cannot know who
 *   made the commit;
 * - the observer reports exact commit objects; cross-producer metric
 *   deduplication is owned by `recordGitCommit`, which claims the SHA
 *   before emitting its counters;
 * - failures are reported, not absorbed: a commit git cannot read is
 *   listed in the observation's `unmeasured` field and the baseline does
 *   not advance past it, so the next observe() retries instead of
 *   silently dropping evidence.
 *
 * The observer never writes to the workspace, never edits git config, and
 * never mutates the operator's own commits: it only runs read-only git
 * commands via the shared telemetry helper. Process environment changes
 * for the agent's committer identity are not this module's concern --
 * those belong to the agent that actually executes `git commit`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type RecordGitCommitOptions } from "../router/telemetry.ts";
import {
  type GitCommitChange,
  listCommitsInRange,
  measureGitCommitChanges
} from "./git-change-metrics.ts";
import { safeAutoDevWorkspaceKey } from "./resource-context/index.ts";

const execFileAsync = promisify(execFile);

/** Timeout for each read-only git invocation (ms). */
export const OBSERVE_GIT_TIMEOUT_MS = 10_000;
/** Buffer cap for each read-only git invocation (bytes). */
export const OBSERVE_GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** Git commit SHA pattern, copied from the shared git-change-metrics helper. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/iu;

/** A single read-only git invocation. Injected for tests. */
export type RunGit = (
  repositoryRoot: string,
  args: readonly string[]
) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
}>;

export interface WorkspaceCommitObserverOptions {
  /**
   * The opaque workspace key, source-confirmed.
   *
   * Validated through `safeAutoDevWorkspaceKey`: a path, URL, empty
   * string, or reserved word is rejected at construction time. A key
   * that fails the validator is a caller error rather than a runtime
   * failure, and would produce a metric dimension the rest of the
   * pipeline is required to drop.
   */
  readonly workspaceKey: string;
  /** Absolute path of the repository being watched. */
  readonly repositoryRoot: string;
  /** Injected clock for deterministic tests. */
  readonly clock?: () => number;
  /** Injected git runner for tests; defaults to a real read-only git call. */
  readonly runGit?: RunGit;
}

export interface WorkspaceCommitBaseline {
  readonly workspaceKey: string;
  readonly repositoryRoot: string;
  /** HEAD sha at baseline time, or null when the repo has no commits yet. */
  readonly head: string | null;
  readonly observedAt: number;
}

export type WorkspaceCommitError =
  /** The process-local registry reached its fixed observer bound. */
  | { readonly kind: "observer_limit"; readonly reason: string }
  /** The repository's HEAD could not be read. */
  | { readonly kind: "head_unreadable"; readonly reason: string }
  /** The `git rev-list` call that enumerates new commits returned nothing. */
  | { readonly kind: "list_failed"; readonly reason: string }
  /**
   * One or more commits were listed but git refused to summarize them.
   * The baseline does not advance until a subsequent observe() can
   * measure them; this preserves the "never silently advance past
   * commits that were not measured" rule.
   */
  | {
      readonly kind: "unmeasured_commits";
      readonly commits: readonly {
        readonly commit: string;
        readonly reason: string;
      }[];
    };

export interface WorkspaceCommitObservation {
  readonly workspaceKey: string;
  readonly repositoryRoot: string;
  /** True on the first observation, when there is no prior baseline. */
  readonly isBaseline: boolean;
  /** Cursor HEAD when this observation began; null for an empty repo. */
  readonly baselineHead: string | null;
  /** HEAD at the moment of this observe(); null for an empty repo. */
  readonly currentHead: string | null;
  readonly observedAt: number;
  /**
   * Commits the observer measured AND that carry a source-confirmed
   * AutoDev committer identity (the commit's email was recovered via
   * `gitCommitActorFromEmail`). These are the only commits the
   * observer will vouch for as AutoDev agent work. The parent should
   * record each entry through `gitCommitObservationToRecordOptions`,
   * which throws on a non-AutoDev commit so an operator commit cannot
   * be blended onto a role.
   */
  readonly recordableCommits: readonly GitCommitChange[];
  /**
   * Commits the observer measured that do NOT carry an AutoDev
   * committer identity. The observer has no positive evidence the
   * commit is AutoDev work -- it could be the operator, a pre-AutoDev
   * commit already on the branch, a tool that bypassed the AutoDev
   * identity environment, or a subagent that committed without it.
   *
   * Exposed for diagnostics only. The parent must NOT record these as
   * AutoDev agent output (`actorFromCommitIdentity: true`). The
   * AutoDev `unattributed` dimension value is reserved for a producer
   * that independently knows a commit is its work but cannot prove
   * the actor; the Runtime observer is not that producer.
   */
  readonly observedButNotRecordable: readonly GitCommitChange[];
  /** Commits git listed but could not fully summarize. */
  readonly unmeasured: readonly {
    readonly commit: string;
    readonly reason: string;
  }[];
  /** First failure that prevents this observation from advancing, or null. */
  readonly error: WorkspaceCommitError | null;
}

export interface WorkspaceCommitObserver {
  readonly workspaceKey: string;
  readonly repositoryRoot: string;
  isInitialized(): boolean;
  /** Capture the current HEAD as the new baseline. */
  initialize(): Promise<WorkspaceCommitBaseline>;
  /**
   * Measure and return the commits reachable from the baseline.
   *
   * If the observer has not been initialized, the first call records the
   * baseline and reports empty `recordableCommits` and `observedButNotRecordable` arrays -- the first observation
   * is always a baseline. Subsequent calls list commits since the
   * baseline, and measure them through the existing Git helper. The
   * cursor ensures this observer does not repeat its own range; the
   * telemetry emitter owns cross-producer idempotency by commit SHA.
   *
   * Concurrent observe() calls on the same observer are serialized so a
   * caller can fire one per provider attempt without racing its own
   * state. Independent observers may report the same immutable commit;
   * this is expected, since the telemetry emitter is the single owner
   * of cross-producer deduplication.
   */
  observe(): Promise<WorkspaceCommitObservation>;
  /** Test seam: drop this observer's cursor. */
  reset(): void;
}

async function defaultRunGit(
  repositoryRoot: string,
  args: readonly string[]
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const result = await execFileAsync("git", ["-C", repositoryRoot, ...args], {
      timeout: OBSERVE_GIT_TIMEOUT_MS,
      maxBuffer: OBSERVE_GIT_MAX_BUFFER_BYTES
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? (error as { stderr?: unknown }).stderr
        : "";
    return {
      exitCode: typeof code === "number" ? code : -1,
      stdout: "",
      stderr: typeof stderr === "string" ? stderr : ""
    };
  }
}

/**
 * The set of stderr fragments git emits when `git rev-parse --verify
 * HEAD` is called on an initialized repository with no commits yet
 * (the "unborn HEAD" state). Anything else is treated as a real
 * failure so corruption, "fatal: not a git repository", and similar
 * errors do not get reported as a fabricated empty baseline.
 */
const UNBORN_HEAD_STDERR_PATTERNS: readonly string[] = [
  "ambiguous argument 'HEAD'",
  "Needed a single revision",
  "bad revision 'HEAD'",
  "invalid object name 'HEAD'"
];

function isUnbornHeadStderr(stderr: string): boolean {
  for (const pattern of UNBORN_HEAD_STDERR_PATTERNS) {
    if (stderr.includes(pattern)) return true;
  }
  return false;
}

async function readHead(
  repositoryRoot: string,
  runGit: RunGit
): Promise<{ readonly head: string | null; readonly error: string | null }> {
  // Step 1: verify the path is actually a git working tree. A
  // non-repo directory ("fatal: not a git repository") and a missing
  // git binary (no stderr) both fail here, and both must surface as
  // head-unreadable rather than be mistaken for an empty repo.
  const repoCheck = await runGit(repositoryRoot, ["rev-parse", "--git-dir"]);
  if (repoCheck.exitCode !== 0) {
    const stderr =
      typeof repoCheck.stderr === "string" ? repoCheck.stderr.trim() : "";
    return {
      head: null,
      error:
        stderr.length > 0
          ? `path is not a git working tree: ${stderr}`
          : "git rev-parse --git-dir failed with no output"
    };
  }

  // Step 2: read HEAD. Only the known unborn-HEAD stderr pattern
  // is treated as the empty-repo baseline; every other failure is
  // reported as head-unreadable so the caller never gets a
  // fabricated zero.
  const result = await runGit(repositoryRoot, [
    "rev-parse",
    "--verify",
    "HEAD"
  ]);
  if (result.exitCode !== 0) {
    const stderr =
      typeof result.stderr === "string" ? result.stderr.trim() : "";
    if (isUnbornHeadStderr(stderr)) {
      return { head: null, error: null };
    }
    return {
      head: null,
      error:
        stderr.length > 0
          ? `git rev-parse --verify HEAD failed: ${stderr}`
          : "git rev-parse --verify HEAD failed with no output"
    };
  }
  const trimmed = result.stdout.trim();
  if (COMMIT_SHA_PATTERN.test(trimmed)) return { head: trimmed, error: null };
  return {
    head: null,
    error: `git rev-parse HEAD returned an unrecognized value: ${JSON.stringify(
      trimmed
    )}`
  };
}

/**
 * Build safe `RecordGitCommitOptions` from one measured change in an
 * observation.
 *
 * This is the integration seam between the observer and the existing
 * `recordGitCommit` emitter. The observer does not call
 * `recordGitCommit` itself: no metric is emitted by this module.
 * The parent calls this helper once per
 * `observation.recordableCommits` entry and forwards the result to
 * `recordGitCommit`.
 *
 * The helper throws on a change whose `actor` is `null`, so an
 * operator commit (a human commit, a pre-AutoDev commit, a tool that
 * bypassed the AutoDev identity environment) cannot be recorded as
 * AutoDev agent output by accident. The AutoDev `unattributed`
 * dimension value is reserved for a producer that independently
 * knows a commit is its work but cannot prove the actor from the
 * commit; the observer is not that producer. `model` is always
 * `null` because the observer never accepts session or model
 * context.
 */
export function gitCommitObservationToRecordOptions(
  observation: WorkspaceCommitObservation,
  change: GitCommitChange
): RecordGitCommitOptions {
  if (change.actor === null) {
    throw new TypeError(
      "gitCommitObservationToRecordOptions called with a non-AutoDev commit; " +
        "iterate observation.recordableCommits instead of " +
        "observation.observedButNotRecordable when forwarding to recordGitCommit"
    );
  }
  return {
    commit: change.commit,
    filesChanged: change.filesChanged,
    filesAdded: change.filesAdded,
    filesDeleted: change.filesDeleted,
    linesAdded: change.linesAdded,
    linesRemoved: change.linesRemoved,
    partial: change.partial,
    workspace: { key: observation.workspaceKey },
    role: change.actor.role,
    provider: change.actor.provider,
    model: null,
    actorFromCommitIdentity: true
  };
}

export function createWorkspaceCommitObserver(
  options: WorkspaceCommitObserverOptions
): WorkspaceCommitObserver {
  const safeKey = safeAutoDevWorkspaceKey(options.workspaceKey);
  if (!safeKey) {
    throw new TypeError(
      `workspaceKey is not a bounded, source-confirmed metric value: ${JSON.stringify(
        options.workspaceKey
      )}`
    );
  }
  if (typeof options.repositoryRoot !== "string" || !options.repositoryRoot) {
    throw new TypeError(
      `repositoryRoot must be a non-empty string: ${JSON.stringify(
        options.repositoryRoot
      )}`
    );
  }
  const repositoryRoot = options.repositoryRoot;
  const runGit: RunGit = options.runGit ?? defaultRunGit;
  const clock = options.clock ?? Date.now;

  let initialized = false;
  let baselineHead: string | null = null;
  // A serialized queue so concurrent observe() / initialize() calls on
  // the same observer run in submission order without racing their own
  // state. The chain is kept non-rejecting so a single failure does not
  // poison the next call; the original promise that was returned still
  // rejects for the caller that triggered it.
  let chain: Promise<unknown> = Promise.resolve();

  const runInitialize = async (): Promise<WorkspaceCommitBaseline> => {
    const { head, error } = await readHead(repositoryRoot, runGit);
    if (error) {
      throw new Error(
        `workspace-commit-observer: cannot read HEAD at ${JSON.stringify(
          repositoryRoot
        )}: ${error}`
      );
    }
    baselineHead = head;
    initialized = true;
    return {
      workspaceKey: safeKey,
      repositoryRoot,
      head,
      observedAt: clock()
    };
  };

  const runObserve = async (): Promise<WorkspaceCommitObservation> => {
    if (!initialized) {
      // First observation is a baseline; capture HEAD now and report
      // zero new commits. The caller has not yet given us a turn-end
      // signal, so there is nothing to enumerate yet.
      const { head, error } = await readHead(repositoryRoot, runGit);
      if (error) {
        return {
          workspaceKey: safeKey,
          repositoryRoot,
          isBaseline: true,
          baselineHead: null,
          currentHead: null,
          observedAt: clock(),
          recordableCommits: [],
          observedButNotRecordable: [],
          unmeasured: [],
          error: { kind: "head_unreadable", reason: error }
        };
      }
      // Calls are serialized through `chain`; no observer operation can
      // reassign these fields while this read has yielded at the Git call.
      baselineHead = head;
      // eslint-disable-next-line require-atomic-updates -- chain serializes all observer state transitions.
      initialized = true;
      return {
        workspaceKey: safeKey,
        repositoryRoot,
        isBaseline: true,
        baselineHead: head,
        currentHead: head,
        observedAt: clock(),
        recordableCommits: [],
        observedButNotRecordable: [],
        unmeasured: [],
        error: null
      };
    }

    const headRead = await readHead(repositoryRoot, runGit);
    if (headRead.error) {
      return {
        workspaceKey: safeKey,
        repositoryRoot,
        isBaseline: false,
        baselineHead,
        currentHead: null,
        observedAt: clock(),
        recordableCommits: [],
        observedButNotRecordable: [],
        unmeasured: [],
        error: { kind: "head_unreadable", reason: headRead.error }
      };
    }
    const currentHead = headRead.head;
    const observationBaselineHead = baselineHead;

    if (currentHead === baselineHead) {
      // No work, and no need to ask git again. A fabricated "no new
      // commits" is acceptable here because it is the only consistent
      // reading of `currentHead === baselineHead`.
      return {
        workspaceKey: safeKey,
        repositoryRoot,
        isBaseline: false,
        baselineHead,
        currentHead,
        observedAt: clock(),
        recordableCommits: [],
        observedButNotRecordable: [],
        unmeasured: [],
        error: null
      };
    }

    const range =
      baselineHead === null
        ? (currentHead ?? "")
        : `${baselineHead}..${currentHead ?? ""}`;
    const listed = await listCommitsInRange(repositoryRoot, range, runGit);

    if (listed.length === 0) {
      // listCommitsInRange returns [] both for an empty range and for a
      // failed git call. We already handled the equal-HEAD case above,
      // so an empty listing here means git could not enumerate the
      // range -- a real failure that must not silently advance.
      return {
        workspaceKey: safeKey,
        repositoryRoot,
        isBaseline: false,
        baselineHead,
        currentHead,
        observedAt: clock(),
        recordableCommits: [],
        observedButNotRecordable: [],
        unmeasured: [],
        error: {
          kind: "list_failed",
          reason: `git rev-list ${JSON.stringify(range)} returned no commits`
        }
      };
    }

    const measured = await measureGitCommitChanges({
      repositoryRoot,
      commits: listed,
      runGit
    });

    const measuredByCommit = new Map(
      measured.map((change) => [change.commit, change] as const)
    );
    const recordableCommits: GitCommitChange[] = [];
    const observedButNotRecordable: GitCommitChange[] = [];
    const unmeasured: { commit: string; reason: string }[] = [];
    for (const commit of listed) {
      const change = measuredByCommit.get(commit);
      if (change) {
        // Split measured commits by whether they carry a verified
        // AutoDev committer identity. An actor of `null` means git
        // confirmed the commit exists but the observer cannot vouch
        // for it as agent work, so the parent must not record it as
        // AutoDev output.
        if (change.actor === null) {
          observedButNotRecordable.push(change);
        } else {
          recordableCommits.push(change);
        }
      } else {
        unmeasured.push({
          commit,
          reason: "git could not read this commit"
        });
      }
    }

    if (unmeasured.length > 0) {
      // The "never advance past unmeasured commits" rule: hold the
      // baseline where it was so the next observe() retries these
      // commits, even though other commits in the same range did get
      // measured and recorded.
      return {
        workspaceKey: safeKey,
        repositoryRoot,
        isBaseline: false,
        baselineHead: observationBaselineHead,
        currentHead,
        observedAt: clock(),
        recordableCommits,
        observedButNotRecordable,
        unmeasured,
        error: { kind: "unmeasured_commits", commits: unmeasured }
      };
    }

    // Advance the cursor only through commits that were measured. The
    // list helper bounds one scan, so a long range is drained in later
    // observations rather than skipping commits beyond the cap.
    const lastListed = listed.at(-1);
    // Calls are serialized through `chain`; a concurrent observation
    // cannot advance the cursor between the Git reads and this update.
    // eslint-disable-next-line require-atomic-updates -- chain serializes all cursor reads and writes.
    if (lastListed) baselineHead = lastListed;
    return {
      workspaceKey: safeKey,
      repositoryRoot,
      isBaseline: false,
      baselineHead: observationBaselineHead,
      currentHead,
      observedAt: clock(),
      recordableCommits,
      observedButNotRecordable,
      unmeasured: [],
      error: null
    };
  };

  return {
    workspaceKey: safeKey,
    repositoryRoot,
    isInitialized: () => initialized,
    initialize: () => {
      const next = chain.then(
        () => runInitialize(),
        () => runInitialize()
      );
      chain = next.catch(() => undefined);
      return next;
    },
    observe: () => {
      const next = chain.then(
        () => runObserve(),
        () => runObserve()
      );
      chain = next.catch(() => undefined);
      return next;
    },
    reset: () => {
      initialized = false;
      baselineHead = null;
      chain = Promise.resolve();
    }
  };
}
