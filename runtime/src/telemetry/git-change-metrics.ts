/**
 * Exact measurement of what a git commit changed.
 *
 * The numbers here come from git itself (`diff-tree` for statuses, `numstat`
 * for line counts). Nothing is inferred from edit counts, tool calls, or diff
 * size, because the requirement is a record of what the commit actually
 * contains -- and a proxy would let a commit of nine empty files look like a
 * large one.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { mapConcurrentOrdered } from "../shared/map-concurrent-ordered.ts";
import {
  type GitCommitActor,
  gitCommitActorFromEmail
} from "./git-commit-identity.ts";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/iu;
/** Git prints `-` in place of a count for binary files. */
const BINARY_NUMSTAT_FIELD = "-";
const MAX_COMMITS_PER_OBSERVATION = 200;
const MAX_CONCURRENT_COMMIT_MEASUREMENTS = 4;

export type GitChangeStatus = "added" | "deleted" | "modified" | "renamed";

export interface GitCommitChange {
  /** The commit object that was actually created. Never a metric dimension. */
  readonly commit: string;
  /** Distinct paths touched, across added/deleted/modified/renamed. */
  readonly filesChanged: number;
  readonly filesAdded: number;
  readonly filesDeleted: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /**
   * The actor recovered from the commit's own committer identity, or `null`
   * when the commit was not made by an AutoDev agent.
   *
   * Recovered from git rather than supplied by the caller: the caller is
   * observing a workspace it may share with subagents, and cannot know which
   * of them made this commit.
   */
  readonly actor: GitCommitActor | null;
  /**
   * True when some diff could not be summarized -- a binary file, an unreadable
   * numstat, or a merge commit whose combined diff git declines to render.
   *
   * Partial is reported rather than absorbed: a smaller "complete" number would
   * be indistinguishable from a genuinely small commit.
   */
  readonly partial: boolean;
}

export interface GitCommitChangeOptions {
  readonly repositoryRoot: string;
  /** Commit ids, oldest-first. Bounds are enforced by the caller. */
  readonly commits: readonly string[];
  /** Injected for tests; defaults to a real `git` invocation. */
  readonly runGit?: (
    repositoryRoot: string,
    args: readonly string[]
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

async function defaultRunGit(
  repositoryRoot: string,
  args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  try {
    const result = await execFileAsync("git", ["-C", repositoryRoot, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES
    });
    return { exitCode: 0, stdout: result.stdout };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    return { exitCode: typeof code === "number" ? code : -1, stdout: "" };
  }
}

/**
 * Parse `git diff-tree --name-status -r -M` output.
 *
 * Renames are reported as `R<score>\told\tnew`, so the two-path form must be
 * consumed without counting the old path as a second changed file.
 */
export function parseChangeStatuses(stdout: string): {
  readonly statuses: readonly GitChangeStatus[];
  readonly partial: boolean;
} {
  const statuses: GitChangeStatus[] = [];
  let partial = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [rawStatus = ""] = trimmed.split("\t");
    const letter = rawStatus.charAt(0).toUpperCase();
    if (letter === "A") statuses.push("added");
    else if (letter === "D") statuses.push("deleted");
    else if (letter === "R") statuses.push("renamed");
    else if (letter === "M" || letter === "T" || letter === "C")
      statuses.push("modified");
    // An unrecognised status means git told us about a change we cannot
    // classify, so the commit is partial rather than quietly undercounted.
    else partial = true;
  }
  return { statuses, partial };
}

/** Parse `git show --numstat` output into insertions/deletions totals. */
export function parseNumstat(stdout: string): {
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly partial: boolean;
} {
  let linesAdded = 0;
  let linesRemoved = 0;
  let partial = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const [added, removed] = trimmed.split("\t");
    if (added === BINARY_NUMSTAT_FIELD || removed === BINARY_NUMSTAT_FIELD) {
      // Git counted the file but not its lines. That is a real change with an
      // unreportable size, so it marks the commit partial.
      partial = true;
      continue;
    }
    const parsedAdded = Number.parseInt(added ?? "", 10);
    const parsedRemoved = Number.parseInt(removed ?? "", 10);
    if (!Number.isInteger(parsedAdded) || !Number.isInteger(parsedRemoved)) {
      partial = true;
      continue;
    }
    linesAdded += parsedAdded;
    linesRemoved += parsedRemoved;
  }
  return { linesAdded, linesRemoved, partial };
}

/**
 * Measure the change-output of specific commits.
 *
 * Returns one observation per commit that git could actually summarize. A
 * commit that cannot be read is omitted rather than reported as zero changes,
 * because "git could not tell us" and "this commit changed nothing" are
 * different facts.
 */
export async function measureGitCommitChanges({
  repositoryRoot,
  commits,
  runGit = defaultRunGit
}: GitCommitChangeOptions): Promise<readonly GitCommitChange[]> {
  const bounded = commits
    .filter((commit) => COMMIT_PATTERN.test(commit))
    .slice(0, MAX_COMMITS_PER_OBSERVATION);

  const measured = await mapConcurrentOrdered(
    bounded,
    MAX_CONCURRENT_COMMIT_MEASUREMENTS,
    async (commit) => {
      // The committer email is read from the commit itself, so attribution does
      // not depend on the caller knowing which actor ran in this workspace.
      const [identity, names, numstat] = await Promise.all([
        runGit(repositoryRoot, ["log", "-1", "--format=%ce", commit]),
        runGit(repositoryRoot, [
          "diff-tree",
          "--no-commit-id",
          "--name-status",
          "-r",
          "-M",
          commit
        ]),
        runGit(repositoryRoot, ["show", "--numstat", "--format=", commit])
      ]);
      if (names.exitCode !== 0 || numstat.exitCode !== 0) return null;

      const statuses = parseChangeStatuses(names.stdout);
      const lines = parseNumstat(numstat.stdout);
      return {
        commit,
        // Added and deleted files are subsets of changed files, not additions to
        // them: summing all three into one total would double-count.
        filesChanged: statuses.statuses.length,
        filesAdded: statuses.statuses.filter((value) => value === "added")
          .length,
        filesDeleted: statuses.statuses.filter((value) => value === "deleted")
          .length,
        linesAdded: lines.linesAdded,
        linesRemoved: lines.linesRemoved,
        // A human commit has no AutoDev identity and stays unattributed rather
        // than being folded into agent output.
        actor: gitCommitActorFromEmail(
          identity.exitCode === 0 ? identity.stdout.trim() : null
        ),
        partial: statuses.partial || lines.partial
      };
    }
  );
  return measured.filter(
    (change): change is GitCommitChange => change !== null
  );
}

/**
 * Commits created in `range`, oldest-first.
 *
 * An empty range is a normal result meaning "nothing was committed", so it
 * returns an empty list rather than an error.
 */
export async function listCommitsInRange(
  repositoryRoot: string,
  range: string,
  runGit: (
    repositoryRoot: string,
    args: readonly string[]
  ) => Promise<{
    readonly exitCode: number;
    readonly stdout: string;
  }> = defaultRunGit
): Promise<readonly string[]> {
  if (range.trim().length === 0) return [];
  const result = await runGit(repositoryRoot, [
    "rev-list",
    "--reverse",
    "--max-count",
    String(MAX_COMMITS_PER_OBSERVATION),
    range
  ]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => COMMIT_PATTERN.test(line));
}
