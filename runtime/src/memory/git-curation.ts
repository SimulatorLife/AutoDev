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
const GITHUB_LOOKUPS_PER_CONTEXT = 1;

interface GitHubPullRequestLocator {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

interface GitHubPullRequestState {
  readonly state: string;
  readonly isDraft: boolean;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly mergeCommit: string | null;
  readonly reviewDecision: string | null;
  readonly checksState: string | null;
}

interface PullRequestLookupState {
  lookups: number;
  readonly states: Map<string, Promise<GitHubPullRequestState | null>>;
}

type PullRequestVerificationResult =
  | { readonly kind: "none" }
  | { readonly kind: "unknown" }
  | {
      readonly kind: "verified";
      readonly reference: EvidenceReference;
      readonly mergeCommit: string;
    };

export interface MemoryRepositoryRootResolver {
  /** Resolves a repository from trusted runtime metadata, never a tool argument. */
  resolve(context: MemoryReadContext): string | null | Promise<string | null>;
}

/**
 * Conservative current-state validation for memories grounded in Git files.
 * A cited same-repository PR is checked once per research context and must be
 * merged, approved, and have successful checks before it can supply commit
 * lineage. Local ancestry and exact cited-file identity remain mandatory;
 * missing GitHub state stays unknown and cannot authorize injection.
 */
interface GitRepositorySnapshot {
  readonly root: string;
  readonly head: string;
}

export class GitWorkingTreeMemoryVerifier implements MemoryCurrentStateVerifier {
  private readonly repositories: MemoryRepositoryRootResolver;
  private readonly now: () => string;
  private readonly pullRequestState: (
    repositoryId: string,
    uri: string
  ) => Promise<GitHubPullRequestState | null>;
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
    readonly pullRequestState?: (
      repositoryId: string,
      uri: string
    ) => Promise<GitHubPullRequestState | null>;
  }) {
    this.repositories = options.repositories;
    this.now = options.now ?? (() => new Date().toISOString());
    this.pullRequestState = options.pullRequestState ?? githubPullRequestState;
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
    const citedFiles = citedRepositoryFiles(repositoryRoot, evidence);
    if (citedFiles.length === 0) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }
    const pullRequestVerification = await this.verifyCitedPullRequest(
      evidence,
      input.context,
      input.context.repositoryId
    );
    if (pullRequestVerification.kind === "unknown") {
      return unknownAssessment(
        checkedAt,
        "verification_inconclusive",
        "git_github_pr_review_checks"
      );
    }
    const sourceCommit =
      sourceCommitFrom(evidence) ??
      (pullRequestVerification.kind === "verified"
        ? pullRequestVerification.mergeCommit
        : null);
    const resolvedPullRequest =
      pullRequestVerification.kind === "verified"
        ? {
            ...pullRequestVerification.reference,
            revision:
              pullRequestVerification.reference.revision ??
              pullRequestVerification.mergeCommit,
            observedAt: checkedAt
          }
        : null;
    if (!sourceCommit) {
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

    // Identical final bytes do not erase intervening changes to cited files:
    // a later semantic supersession or manual revert may restore the old text.
    // Inspect only commits touching these paths. A canonical revert is stale;
    // any other intervening change remains unknown and is excluded from injection.
    const pathHistory = await inspectCitedFileHistory(
      repositoryRoot,
      sourceCommit,
      currentCommit,
      citedFiles.map((file) => file.relativePath)
    );
    if (pathHistory.exitCode !== 0) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }
    if (pathHistory.reverted) {
      return contradictedAssessment(
        checkedAt,
        "stale",
        input.context.repositoryId,
        currentCommit,
        citedFiles.map((file) => file.reference)
      );
    }
    if (pathHistory.changed) {
      return unknownAssessment(
        checkedAt,
        "verification_inconclusive",
        "git_cited_file_history_changed"
      );
    }

    return {
      compatibility: "compatible",
      source: resolvedPullRequest
        ? "git_github_pr_review_checks_and_file_identity"
        : "git_commit_and_file_identity",
      checkedAt,
      reasonCode: "verified_current_state",
      evidence: [
        {
          kind: "commit",
          uri: commitUri(input.context.repositoryId, currentCommit),
          revision: currentCommit,
          observedAt: checkedAt
        },
        ...(resolvedPullRequest ? [resolvedPullRequest] : []),
        ...citedFiles.map(({ reference }) => ({
          ...reference,
          revision: currentCommit,
          observedAt: checkedAt
        }))
      ]
    };
  }

  private async verifyCitedPullRequest(
    evidence: readonly EvidenceReference[],
    context: MemoryReadContext,
    repositoryId: string
  ): Promise<PullRequestVerificationResult> {
    const pullRequests = new Map<string, EvidenceReference>();
    for (const reference of evidence) {
      if (reference.kind !== "pull_request") continue;
      const locator = parseGitHubPullRequestLocator(
        reference.uri,
        repositoryId
      );
      if (!locator) continue;
      const key = `${locator.owner.toLowerCase()}/${locator.repository.toLowerCase()}#${locator.number}`;
      pullRequests.set(key, reference);
    }
    if (pullRequests.size > 1) return { kind: "unknown" };
    const reference = pullRequests.values().next().value;
    if (!reference) return { kind: "none" };
    const state = await this.pullRequestStateForContext(
      context,
      repositoryId,
      reference.uri
    );
    if (!isVerifiedPullRequestState(state)) return { kind: "unknown" };
    return {
      kind: "verified",
      reference,
      mergeCommit: state.mergeCommit
    };
  }

  /**
   * Resolve and validate at most one cited GitHub PR per research context.
   * The query captures the PR merge, review decision, and aggregate check
   * state together so a reference cannot authorize injection based on merge
   * lineage alone. Unavailable or incomplete API data stays unknown.
   */
  private pullRequestStateForContext(
    context: MemoryReadContext,
    repositoryId: string,
    uri: string
  ): Promise<GitHubPullRequestState | null> {
    const locator = parseGitHubPullRequestLocator(uri, repositoryId);
    if (!locator) return Promise.resolve(null);
    let state = this.pullRequestLookups.get(context);
    if (!state) {
      state = { lookups: 0, states: new Map() };
      this.pullRequestLookups.set(context, state);
    }
    const lookupKey = `${locator.owner}/${locator.repository}#${locator.number}`;
    const cached = state.states.get(lookupKey);
    if (cached) return cached;
    if (state.lookups >= GITHUB_LOOKUPS_PER_CONTEXT)
      return Promise.resolve(null);
    state.lookups += 1;
    const lookup = Promise.resolve()
      .then(() => this.pullRequestState(repositoryId, uri))
      .catch(() => null);
    state.states.set(lookupKey, lookup);
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
        input.assessment.source ===
        "git_github_pr_review_checks_and_file_identity"
          ? "The cited PR is merged with an approved review decision and successful checks; its source commit is in the current repository lineage and cited files are unchanged."
          : "The cited source commit is in the current repository lineage and the cited files are unchanged."
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

/**
 * Read current PR merge, review, and aggregate check state in one bounded
 * GraphQL request. Only a closed, merged PR with an approved review decision
 * and successful check rollup can contribute commit lineage. The calling
 * verifier still independently checks local ancestry and cited-file identity.
 */
async function githubPullRequestState(
  repositoryId: string,
  uri: string
): Promise<GitHubPullRequestState | null> {
  const locator = parseGitHubPullRequestLocator(uri, repositoryId);
  if (!locator) return null;
  const query = `query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        state
        isDraft
        merged
        mergedAt
        mergeCommit { oid }
        reviewDecision
        statusCheckRollup { state }
      }
    }
  }`;
  try {
    const result = await execFileAsync(
      "gh",
      [
        "api",
        "graphql",
        "-F",
        `owner=${locator.owner}`,
        "-F",
        `name=${locator.repository}`,
        "-F",
        `number=${locator.number}`,
        "-f",
        `query=${query}`
      ],
      {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        env: githubCliEnvironment()
      }
    );
    const response = parseJsonObject(result.stdout);
    if (
      response &&
      "errors" in response &&
      (!Array.isArray(response.errors) || response.errors.length > 0)
    ) {
      return null;
    }
    const data = response ? asRecord(response.data) : null;
    const repository = data ? asRecord(data.repository) : null;
    const pullRequest = repository ? asRecord(repository.pullRequest) : null;
    const mergeCommit = pullRequest ? asRecord(pullRequest.mergeCommit) : null;
    const statusCheckRollup = pullRequest
      ? asRecord(pullRequest.statusCheckRollup)
      : null;
    if (
      !pullRequest ||
      typeof pullRequest.state !== "string" ||
      typeof pullRequest.isDraft !== "boolean" ||
      typeof pullRequest.merged !== "boolean" ||
      (pullRequest.mergedAt !== null &&
        typeof pullRequest.mergedAt !== "string") ||
      (pullRequest.reviewDecision !== null &&
        typeof pullRequest.reviewDecision !== "string") ||
      (statusCheckRollup !== null &&
        typeof statusCheckRollup.state !== "string")
    ) {
      return null;
    }
    const mergeCommitOid = mergeCommit?.oid;
    return {
      state: pullRequest.state,
      isDraft: pullRequest.isDraft,
      merged: pullRequest.merged,
      mergedAt: pullRequest.mergedAt,
      mergeCommit:
        typeof mergeCommitOid === "string" &&
        COMMIT_PATTERN.test(mergeCommitOid)
          ? mergeCommitOid.toLowerCase()
          : null,
      reviewDecision: pullRequest.reviewDecision,
      checksState:
        statusCheckRollup && typeof statusCheckRollup.state === "string"
          ? statusCheckRollup.state
          : null
    };
  } catch {
    // Missing gh, unavailable credentials/network, private-repo access, and
    // API failures remain inconclusive; none may authorize memory injection.
    return null;
  }
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isVerifiedPullRequestState(
  value: GitHubPullRequestState | null
): value is GitHubPullRequestState & { readonly mergeCommit: string } {
  return (
    value !== null &&
    (value.state === "CLOSED" || value.state === "MERGED") &&
    !value.isDraft &&
    value.merged &&
    typeof value.mergedAt === "string" &&
    Number.isFinite(Date.parse(value.mergedAt)) &&
    typeof value.mergeCommit === "string" &&
    value.reviewDecision === "APPROVED" &&
    value.checksState === "SUCCESS"
  );
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
  reasonCode: "verification_inconclusive",
  source = "git_commit_and_file_identity"
): CurrentStateAssessment {
  return {
    compatibility: "unknown",
    source,
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
 * Inspect every descendant commit that changed a cited path. A standard
 * `git revert <source>` is a direct contradiction even if a later commit
 * restores the same bytes. Other path-changing history leaves compatibility
 * unknown and excludes the memory rather than silently treating old bytes as
 * current. The path filter excludes unrelated repository churn;
 * Git timeout/buffer failures remain inconclusive.
 */
async function inspectCitedFileHistory(
  repositoryRoot: string,
  sourceCommit: string,
  currentCommit: string,
  citedRelativePaths: readonly string[]
): Promise<{
  readonly exitCode: number;
  readonly changed: boolean;
  readonly reverted: boolean;
}> {
  const marker = new RegExp(
    String.raw`^This reverts commit ${sourceCommit.toLowerCase()}[0-9a-f]*\.$`,
    "m"
  );
  const result = await runGit(repositoryRoot, [
    "log",
    "--full-history",
    "--format=tformat:%H%x00%s%x00%B%x00%x1e",
    `${sourceCommit}..${currentCommit}`,
    "--",
    ...citedRelativePaths
  ]);
  if (result.exitCode !== 0) {
    return { exitCode: result.exitCode, changed: false, reverted: false };
  }
  const records = result.stdout
    .split("\u001E")
    .map((record) => record.trim())
    .filter(Boolean);
  let reverted = false;
  for (const record of records) {
    const [commit, subject, ...bodyParts] = record.split("\u0000");
    if (!commit || !COMMIT_PATTERN.test(commit) || !subject) {
      return { exitCode: -1, changed: false, reverted: false };
    }
    const body = bodyParts.join("\u0000");
    if (subject.startsWith("Revert ") && marker.test(body)) reverted = true;
  }
  return { exitCode: 0, changed: records.length > 0, reverted };
}
