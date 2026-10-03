import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type {
  EvidenceReference,
  MemoryReadContext,
  MemoryRecord
} from "@simulatorlife/autodev-core";

import type {
  CurrentStateAssessment,
  MemoryCurrentStateVerifier,
  MemoryReconstructor
} from "./service.ts";

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;
const COMMIT_URI_PATTERN = /\/commit\/([0-9a-f]{7,64})(?:$|[/?#])/i;
const NON_FILE_URI_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const RULESYNC_SKILL_NAME_PATTERN = /^[a-z0-9-]{1,64}$/u;
const GITHUB_REPOSITORY_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/u;
const GITHUB_PULL_REQUEST_NUMBER_PATTERN = /^[1-9]\d{0,9}$/u;
const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER_BYTES = 512 * 1024;
const GIT_LOG_RECORD_SEPARATOR = /\r?\n/u;
const GITHUB_LOOKUPS_PER_CONTEXT = 1;

interface GitHubPullRequestLocator {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

interface PullRequestLookupState {
  lookups: number;
  readonly revisions: Map<string, Promise<string | null>>;
}

export interface MemoryRepositoryRootResolver {
  /** Resolves a repository from trusted runtime metadata, never a tool argument. */
  resolve(context: MemoryReadContext): string | null | Promise<string | null>;
}

/**
 * Conservative current-state validation for memories grounded in Git files.
 * A revisionless same-repository GitHub PR may supply its merge commit through
 * one bounded `gh api` lookup per research context, but Git ancestry and exact
 * cited-file identity remain mandatory. Missing Git/PR evidence or an
 * unavailable status lookup stays unknown and cannot authorize injection.
 */
interface GitRepositorySnapshot {
  readonly root: string;
  readonly head: string;
}

export class GitWorkingTreeMemoryVerifier implements MemoryCurrentStateVerifier {
  private readonly repositories: MemoryRepositoryRootResolver;
  private readonly now: () => string;
  private readonly pullRequestMergeCommit: (
    repositoryId: string,
    uri: string
  ) => Promise<string | null>;
  private readonly snapshots = new WeakMap<
    MemoryReadContext,
    Promise<GitRepositorySnapshot | null>
  >();
  private readonly pullRequestLookups = new WeakMap<
    MemoryReadContext,
    PullRequestLookupState
  >();

  constructor(options: {
    readonly repositories: MemoryRepositoryRootResolver;
    readonly now?: () => string;
    /** Substitutable only for hermetic tests; production uses the GitHub CLI. */
    readonly pullRequestMergeCommit?: (
      repositoryId: string,
      uri: string
    ) => Promise<string | null>;
  }) {
    this.repositories = options.repositories;
    this.now = options.now ?? (() => new Date().toISOString());
    this.pullRequestMergeCommit =
      options.pullRequestMergeCommit ?? githubMergedPullRequestCommit;
  }

  async verify(input: {
    readonly memory: MemoryRecord;
    readonly task: string;
    readonly context: MemoryReadContext;
    readonly asOf: string;
  }): Promise<CurrentStateAssessment> {
    const checkedAt = this.now();
    if (!input.context.repositoryId) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }

    const snapshot = await this.repositorySnapshot(input.context);
    if (!snapshot) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }
    const { root: repositoryRoot, head: currentCommit } = snapshot;
    const evidence = input.memory.provenance.evidence;
    let sourceCommit = sourceCommitFrom(evidence);
    let resolvedPullRequest: EvidenceReference | null = null;
    if (!sourceCommit) {
      const pullRequest = evidence.find(
        (reference) =>
          reference.kind === "pull_request" &&
          parseGitHubPullRequestLocator(
            reference.uri,
            input.context.repositoryId!
          ) !== null
      );
      if (pullRequest) {
        const mergeCommit = await this.pullRequestMergeCommitForContext(
          input.context,
          input.context.repositoryId,
          pullRequest.uri
        );
        if (mergeCommit) {
          sourceCommit = mergeCommit;
          resolvedPullRequest = pullRequest;
        }
      }
    }
    const citedFiles = citedRepositoryFiles(repositoryRoot, evidence);
    if (!sourceCommit || citedFiles.length === 0) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }

    const ancestry = await runGit(repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      sourceCommit,
      currentCommit
    ]);
    if (ancestry.exitCode === 1) {
      return contradictedAssessment(
        checkedAt,
        "current_state_conflict",
        input.context.repositoryId,
        currentCommit
      );
    }
    if (ancestry.exitCode !== 0) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }

    const tracked = await runGit(repositoryRoot, [
      "ls-files",
      "--error-unmatch",
      "--",
      ...citedFiles.map((file) => file.relativePath)
    ]);
    if (tracked.exitCode !== 0)
      return unknownAssessment(checkedAt, "verification_inconclusive");

    const diff = await runGit(repositoryRoot, [
      "diff",
      "--quiet",
      sourceCommit,
      "--",
      ...citedFiles.map((file) => file.relativePath)
    ]);
    if (diff.exitCode === 1) {
      return contradictedAssessment(
        checkedAt,
        "stale",
        input.context.repositoryId,
        currentCommit,
        citedFiles.map((file) => file.reference)
      );
    }
    if (diff.exitCode !== 0) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }

    // The cited files at HEAD are byte-identical to the source commit, but a
    // later standard `git revert <sourceCommit>` (followed by a no-op
    // restoration of the same contents) would otherwise pass the diff check.
    // Walk the descendants between the source commit and current HEAD, scoped
    // to the cited paths, and require the standard `Revert` subject and
    // body marker naming the source commit exactly. Any Git inspection failure remains
    // inconclusive and cannot authorize the memory.
    const revert = await inspectDescendantsForRevert(
      repositoryRoot,
      sourceCommit,
      currentCommit,
      citedFiles.map((file) => file.relativePath)
    );
    if (revert.exitCode !== 0) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }
    if (revert.reverted) {
      return contradictedAssessment(
        checkedAt,
        "stale",
        input.context.repositoryId,
        currentCommit,
        citedFiles.map((file) => file.reference)
      );
    }

    return {
      compatibility: "compatible",
      source: "git_commit_and_file_identity",
      checkedAt,
      reasonCode: "verified_current_state",
      evidence: [
        {
          kind: "commit",
          uri: commitUri(input.context.repositoryId, currentCommit),
          revision: currentCommit,
          observedAt: checkedAt
        },
        ...(resolvedPullRequest && sourceCommit
          ? [
              {
                ...resolvedPullRequest,
                revision: sourceCommit,
                observedAt: checkedAt
              }
            ]
          : []),
        ...citedFiles.map(({ reference }) => ({
          ...reference,
          revision: currentCommit,
          observedAt: checkedAt
        }))
      ]
    };
  }

  /**
   * Resolve at most one revisionless GitHub PR per research context. The
   * ranked JIT candidate order determines which PR is consulted first; failed
   * or unavailable lookups remain unknown rather than authorizing a claim.
   */
  private pullRequestMergeCommitForContext(
    context: MemoryReadContext,
    repositoryId: string,
    uri: string
  ): Promise<string | null> {
    const locator = parseGitHubPullRequestLocator(uri, repositoryId);
    if (!locator) return Promise.resolve(null);
    let state = this.pullRequestLookups.get(context);
    if (!state) {
      state = { lookups: 0, revisions: new Map() };
      this.pullRequestLookups.set(context, state);
    }
    const lookupKey = `${locator.owner}/${locator.repository}#${locator.number}`;
    const cached = state.revisions.get(lookupKey);
    if (cached) return cached;
    if (state.lookups >= GITHUB_LOOKUPS_PER_CONTEXT)
      return Promise.resolve(null);
    state.lookups += 1;
    const lookup = Promise.resolve()
      .then(() => this.pullRequestMergeCommit(repositoryId, uri))
      .then((revision) =>
        typeof revision === "string" && COMMIT_PATTERN.test(revision)
          ? revision.toLowerCase()
          : null
      )
      .catch(() => null);
    state.revisions.set(lookupKey, lookup);
    return lookup;
  }

  private repositorySnapshot(
    context: MemoryReadContext
  ): Promise<GitRepositorySnapshot | null> {
    const existing = this.snapshots.get(context);
    if (existing) return existing;
    const snapshot = this.readRepositorySnapshot(context);
    this.snapshots.set(context, snapshot);
    return snapshot;
  }

  private async readRepositorySnapshot(
    context: MemoryReadContext
  ): Promise<GitRepositorySnapshot | null> {
    const root = await this.repositories.resolve(context);
    if (!root) return null;
    const head = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
    if (head.exitCode !== 0 || !COMMIT_PATTERN.test(head.stdout)) return null;
    return { root, head: head.stdout };
  }
}

/**
 * A deterministic reconstructor for evidence that passed Git current-state
 * validation. It retains the reviewed claim with explicit applicability
 * rationale instead of requiring a second, privately routed model call.
 */
export class VerifiedMemoryReconstructor implements MemoryReconstructor {
  reconstruct(input: {
    readonly memory: MemoryRecord;
    readonly task: string;
    readonly assessment: CurrentStateAssessment;
  }): Promise<{
    readonly disposition: "retain" | "revise" | "reject" | "uncertain";
    readonly guidance?: string;
    readonly rationale: string;
  }> {
    if (input.assessment.compatibility !== "compatible") {
      return Promise.resolve({
        disposition: "uncertain",
        rationale: "Current authoritative state did not verify this memory."
      });
    }
    return Promise.resolve({
      disposition: "retain",
      guidance: input.memory.claim,
      rationale:
        "The cited source commit is in the current repository lineage and the cited files are unchanged."
    });
  }
}

function sourceCommitFrom(
  evidence: readonly EvidenceReference[]
): string | null {
  for (const reference of evidence) {
    if (reference.kind !== "commit" && reference.kind !== "pull_request")
      continue;
    const candidate =
      reference.revision ??
      (reference.kind === "commit"
        ? (COMMIT_URI_PATTERN.exec(reference.uri)?.[1] ?? null)
        : null);
    if (candidate && COMMIT_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Restrict live PR lookups to a canonical GitHub PR for the trusted current
 * repository. Memory evidence can never select an arbitrary host or project.
 */
function parseGitHubPullRequestLocator(
  uri: string,
  repositoryId: string
): GitHubPullRequestLocator | null {
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (
      segments.length !== 4 ||
      segments[2] !== "pull" ||
      !GITHUB_REPOSITORY_SEGMENT_PATTERN.test(segments[0]!) ||
      !GITHUB_REPOSITORY_SEGMENT_PATTERN.test(segments[1]!) ||
      !GITHUB_PULL_REQUEST_NUMBER_PATTERN.test(segments[3]!) ||
      `${segments[0]}/${segments[1]}`.toLowerCase() !==
        repositoryId.trim().toLowerCase()
    ) {
      return null;
    }
    const number = Number(segments[3]);
    if (!Number.isSafeInteger(number)) return null;
    return { owner: segments[0]!, repository: segments[1]!, number };
  } catch {
    return null;
  }
}

/**
 * Pass only the environment required for GitHub CLI configuration and auth.
 * The Runtime process may contain unrelated provider/control-plane secrets;
 * none of those need to cross into the child process.
 */
function githubCliEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "GH_CONFIG_DIR",
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
    "TMPDIR",
    "TMP",
    "TEMP"
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.GH_HOST = "github.com";
  environment.GH_PROMPT_DISABLED = "1";
  environment.GH_NO_UPDATE_NOTIFIER = "1";
  return environment;
}

/** Resolve a PR commit only when GitHub reports that PR as merged. */
async function githubMergedPullRequestCommit(
  repositoryId: string,
  uri: string
): Promise<string | null> {
  const locator = parseGitHubPullRequestLocator(uri, repositoryId);
  if (!locator) return null;
  const endpoint = `repos/${locator.owner}/${locator.repository}/pulls/${locator.number}`;
  try {
    const result = await execFileAsync(
      "gh",
      [
        "api",
        endpoint,
        "--jq",
        "if .merged == true then (.merge_commit_sha // empty) else empty end"
      ],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 1024,
        env: githubCliEnvironment()
      }
    );
    const revision = result.stdout.trim();
    return COMMIT_PATTERN.test(revision) ? revision.toLowerCase() : null;
  } catch {
    // Missing gh, unavailable credentials/network, private-repo access, and
    // API failures remain inconclusive; Git validation fails closed without
    // allowing a PR URL to authorize memory by itself.
    return null;
  }
}

function citedRepositoryFiles(
  repositoryRoot: string,
  evidence: readonly EvidenceReference[]
): readonly {
  readonly reference: EvidenceReference;
  readonly relativePath: string;
}[] {
  const files: { reference: EvidenceReference; relativePath: string }[] = [];
  for (const reference of evidence) {
    const relativePath =
      reference.kind === "file"
        ? safeRepositoryRelativePath(repositoryRoot, reference.uri)
        : reference.kind === "skill"
          ? safeRuleSyncSkillPath(repositoryRoot, reference.uri)
          : reference.kind === "rule"
            ? (safeRuleSyncRulePath(repositoryRoot, reference.uri) ??
              safeRepositoryRelativePath(repositoryRoot, reference.uri))
            : reference.kind === "document"
              ? safeRepositoryRelativePath(repositoryRoot, reference.uri)
              : null;
    if (relativePath) files.push({ reference, relativePath });
  }
  return files;
}

function safeRuleSyncSkillPath(root: string, uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== "rulesync:" ||
      parsed.hostname !== "skills" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const segments = parsed.pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (
      segments.length !== 2 ||
      !RULESYNC_SKILL_NAME_PATTERN.test(segments[0]!) ||
      segments[0]!.startsWith("-") ||
      segments[0]!.endsWith("-") ||
      segments[0]!.includes("--") ||
      segments[1] !== "SKILL.md"
    ) {
      return null;
    }
    return safeRepositoryRelativePath(
      root,
      path.join(".rulesync", "skills", segments[0]!, "SKILL.md")
    );
  } catch {
    return null;
  }
}

function safeRuleSyncRulePath(root: string, uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "rulesync:" || parsed.search || parsed.hash)
      return null;
    if (parsed.hostname === "commands") {
      const segments = parsed.pathname
        .split("/")
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
      if (segments.length !== 1 || !isRuleSyncCommandFilename(segments[0]!)) {
        return null;
      }
      return safeRepositoryRelativePath(
        root,
        path.join(".rulesync", "commands", segments[0]!)
      );
    }
    if (
      (parsed.hostname === "hooks.jsonc" || parsed.hostname === "mcp.jsonc") &&
      (parsed.pathname === "" || parsed.pathname === "/")
    ) {
      return safeRepositoryRelativePath(
        root,
        path.join(".rulesync", parsed.hostname)
      );
    }
    return null;
  } catch {
    return null;
  }
}

function isRuleSyncCommandFilename(filename: string): boolean {
  if (!filename.endsWith(".md")) return false;
  const stem = filename.slice(0, -3);
  if (
    !stem ||
    stem.startsWith("-") ||
    stem.endsWith("-") ||
    stem.includes("--")
  )
    return false;
  return [...stem].every(
    (character) =>
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9") ||
      character === "-"
  );
}

function safeRepositoryRelativePath(root: string, uri: string): string | null {
  let sourcePath: string;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:") return null;
    sourcePath = fileURLToPath(parsed);
  } catch {
    if (NON_FILE_URI_SCHEME_PATTERN.test(uri)) return null;
    sourcePath = uri;
  }

  const absolutePath = path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(root, sourcePath);
  const relativePath = path.relative(path.resolve(root), absolutePath);
  if (
    !relativePath ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath;
}

async function runGit(
  repositoryRoot: string,
  args: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  try {
    const result = await execFileAsync("git", ["-C", repositoryRoot, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER_BYTES
    });
    return { exitCode: 0, stdout: result.stdout.trim() };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : null;
    return {
      exitCode: typeof code === "number" ? code : -1,
      stdout: ""
    };
  }
}

function unknownAssessment(
  checkedAt: string,
  reasonCode: "verification_inconclusive"
): CurrentStateAssessment {
  return {
    compatibility: "unknown",
    source: "git_commit_and_file_identity",
    checkedAt,
    reasonCode,
    evidence: []
  };
}

function contradictedAssessment(
  checkedAt: string,
  reasonCode: "current_state_conflict" | "stale",
  repositoryId: string,
  currentCommit: string,
  files: readonly EvidenceReference[] = []
): CurrentStateAssessment {
  return {
    compatibility: "contradicted",
    source: "git_commit_and_file_identity",
    checkedAt,
    reasonCode,
    evidence: [
      {
        kind: "commit",
        uri: commitUri(repositoryId, currentCommit),
        revision: currentCommit,
        observedAt: checkedAt
      },
      ...files
    ]
  };
}

function commitUri(repositoryId: string, commit: string): string {
  return `git://${encodeURIComponent(repositoryId)}/commit/${commit}`;
}

/**
 * Detect a standard `git revert` of the exact source commit somewhere on the
 * descendant path between it and the current HEAD. `git revert` writes a
 * `Revert ...` subject and a `This reverts commit <full-sha>.` body marker;
 * both are required. Manual reverts without that canonical message are
 * intentionally outside scope. The log is scoped to the cited paths so an
 * unrelated revert elsewhere cannot flip the assessment. Git execution
 * inherits the same timeout/buffer caps as the rest of the verifier and any
 * failure returns exitCode != 0, which the caller treats as inconclusive.
 */
async function inspectDescendantsForRevert(
  repositoryRoot: string,
  sourceCommit: string,
  currentCommit: string,
  citedRelativePaths: readonly string[]
): Promise<{ readonly exitCode: number; readonly reverted: boolean }> {
  // Evidence may carry an unambiguous abbreviated SHA; standard `git revert`
  // records the full object id. Match only a standalone canonical marker line,
  // allowing the full SHA suffix after that verified prefix.
  const marker = String.raw`^This reverts commit ${sourceCommit.toLowerCase()}[0-9a-f]*\.$`;
  const result = await runGit(repositoryRoot, [
    "log",
    "--format=%H%x00%s",
    "--grep",
    marker,
    `${sourceCommit}..${currentCommit}`,
    "--",
    ...citedRelativePaths
  ]);
  if (result.exitCode !== 0) {
    return { exitCode: result.exitCode, reverted: false };
  }
  const reverted = result.stdout
    .split(GIT_LOG_RECORD_SEPARATOR)
    .some((record) => {
      const subjectBoundary = record.indexOf("\u0000");
      return (
        subjectBoundary !== -1 &&
        record.slice(subjectBoundary + 1).startsWith("Revert ")
      );
    });
  return { exitCode: 0, reverted };
}
