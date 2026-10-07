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
  CurrentStateIssueObservation,
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
/**
 * GraphQL type names the supersession parse compares against.
 *
 * Named once because they appear in both the query selection and the parser, and
 * a typo that changed only one of them would produce a query the API accepts and
 * a branch the parser never takes -- which reads as "GitHub never supersedes
 * anything".
 */
const GITHUB_CLOSED_EVENT = "ClosedEvent";
const GITHUB_COMMIT_CLOSER = "Commit";
const GITHUB_PULL_REQUEST_CLOSER = "PullRequest";
const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER_BYTES = 512 * 1024;
const GITHUB_LOOKUPS_PER_CONTEXT = 1;
/**
 * GitHub's page size for `reviewThreads`, and the bound the response is
 * measured against.
 *
 * One owner for both because they describe the same fact: asking for more than
 * GitHub will return and refusing a response that somehow contains more than
 * were asked for. They were three separate `100`s -- the query, the parser's
 * reject, and a third clause in the parser that could never be false.
 */
const MAX_GITHUB_REVIEW_THREADS = 100;

interface GitHubPullRequestLocator {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

/**
 * The pull request that superseded this one, as GitHub reported it.
 *
 * Carried as the number and the canonical URL rather than a full locator: the
 * closer is a field of the same repository's pull request, so its owner and
 * repository are the ones already in hand and re-deriving them would only add a
 * way to disagree with them.
 */
interface GitHubSupersedingPullRequest {
  readonly number: number;
  readonly url: string;
}

/**
 * A pull request that was closed by something other than its own merge.
 *
 * `byPullRequest` is `null` when GitHub reported the closer as a commit rather
 * than naming the pull request. The supersession is still observed -- the PR was
 * closed by an outside commit, which is how a referencing commit closes an issue
 * -- but the operator is not handed an address they can open, because none was
 * observed.
 */
interface GitHubSupersession {
  readonly byPullRequest: GitHubSupersedingPullRequest | null;
}

interface GitHubIssueLocator {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

interface GitHubIssueState {
  readonly state: "OPEN" | "CLOSED";
  readonly stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
  readonly updatedAt: string;
}

interface GitHubReferenceState {
  readonly pullRequest: GitHubPullRequestState | null;
  readonly issue: GitHubIssueState | null;
}

interface GitHubPullRequestState {
  readonly state: string;
  readonly isDraft: boolean;
  readonly merged: boolean;
  readonly mergedAt: string | null;
  readonly mergeCommit: string | null;
  readonly reviewDecision: string | null;
  readonly checksState: string | null;
  readonly reviewThreadsComplete: boolean;
  readonly unresolvedReviewThreadCount: number;
  /**
   * Set when GitHub recorded this pull request being closed by something other
   * than its own merge or a human closing it.
   *
   * `null` is the ordinary case and is what every merged and hand-closed
   * pull request reports; it is an observation, not a missing value.
   */
  readonly supersession: GitHubSupersession | null;
}

interface GitHubLookupState {
  lookups: number;
  readonly states: Map<string, Promise<GitHubReferenceState | null>>;
}

type GitHubReferenceSource =
  | "git_github_pr_review_checks"
  | "git_github_issue_state"
  | "git_github_reference_state";

type GitHubReferenceSelectionResult =
  | {
      readonly kind: "selected";
      readonly pullRequestReference: EvidenceReference | null;
      readonly issueReference: EvidenceReference | null;
    }
  | { readonly kind: "unknown"; readonly source: GitHubReferenceSource };

type GitHubEvidenceVerificationResult =
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly source: GitHubReferenceSource }
  | {
      readonly kind: "superseded";
      readonly source: "git_github_pr_supersession";
      readonly supersedingPullRequest: EvidenceReference | null;
    }
  | {
      readonly kind: "verified";
      readonly pullRequestReference: EvidenceReference | null;
      readonly mergeCommit: string | null;
      readonly issueObservation: CurrentStateIssueObservation | null;
    };

export interface MemoryRepositoryRootResolver {
  /** Resolves a repository from trusted runtime metadata, never a tool argument. */
  resolve(context: MemoryReadContext): string | null | Promise<string | null>;
}

/**
 * Conservative current-state validation for memories grounded in Git files.
 * Cited same-repository PRs require merge, approval, successful checks, and no
 * unresolved current review threads before supplying lineage. Canonical issue
 * state is returned as dated context, never a task outcome. Local ancestry and
 * exact cited-file identity remain mandatory; unavailable GitHub state is unknown.
 */
interface GitRepositorySnapshot {
  readonly root: string;
  readonly head: string;
}

export class GitWorkingTreeMemoryVerifier implements MemoryCurrentStateVerifier {
  private readonly repositories: MemoryRepositoryRootResolver;
  private readonly now: () => string;
  private readonly githubState: (
    repositoryId: string,
    pullRequestUri: string | null,
    issueUri: string | null
  ) => Promise<GitHubReferenceState | null>;
  private readonly snapshots = new WeakMap<
    MemoryReadContext,
    Promise<GitRepositorySnapshot | null>
  >();
  private readonly githubLookups = new WeakMap<
    MemoryReadContext,
    GitHubLookupState
  >();

  constructor(options: {
    readonly repositories: MemoryRepositoryRootResolver;
    readonly now?: () => string;
    /** Substitutable only for hermetic tests; production uses the GitHub CLI. */
    readonly githubState?: (
      repositoryId: string,
      pullRequestUri: string | null,
      issueUri: string | null
    ) => Promise<GitHubReferenceState | null>;
  }) {
    this.repositories = options.repositories;
    this.now = options.now ?? (() => new Date().toISOString());
    this.githubState = options.githubState ?? githubReferenceState;
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
    const githubEvidence = await this.verifyCitedGitHubEvidence(
      evidence,
      input.context,
      input.context.repositoryId,
      checkedAt
    );
    if (githubEvidence.kind === "unknown") {
      return unknownAssessment(
        checkedAt,
        "verification_inconclusive",
        githubEvidence.source
      );
    }
    if (githubEvidence.kind === "superseded") {
      return supersededAssessment(
        checkedAt,
        input.context.repositoryId,
        currentCommit,
        githubEvidence.supersedingPullRequest
      );
    }
    const sourceCommit =
      sourceCommitFrom(evidence) ??
      (githubEvidence.kind === "verified" ? githubEvidence.mergeCommit : null);
    const resolvedPullRequest =
      githubEvidence.kind === "verified" && githubEvidence.pullRequestReference
        ? {
            ...githubEvidence.pullRequestReference,
            revision:
              githubEvidence.pullRequestReference.revision ??
              githubEvidence.mergeCommit!,
            observedAt: checkedAt
          }
        : null;
    const issueObservation =
      githubEvidence.kind === "verified"
        ? githubEvidence.issueObservation
        : null;
    if (!sourceCommit) {
      return unknownAssessment(checkedAt, "verification_inconclusive");
    }

    return this.verifyGitLineage({
      repositoryId: input.context.repositoryId,
      repositoryRoot,
      currentCommit,
      sourceCommit,
      checkedAt,
      citedFiles,
      resolvedPullRequest,
      issueObservation
    });
  }

  private async verifyGitLineage(input: {
    readonly repositoryId: string;
    readonly repositoryRoot: string;
    readonly currentCommit: string;
    readonly sourceCommit: string;
    readonly checkedAt: string;
    readonly citedFiles: readonly {
      readonly reference: EvidenceReference;
      readonly relativePath: string;
    }[];
    readonly resolvedPullRequest: EvidenceReference | null;
    readonly issueObservation: CurrentStateIssueObservation | null;
  }): Promise<CurrentStateAssessment> {
    const ancestry = await runGit(input.repositoryRoot, [
      "merge-base",
      "--is-ancestor",
      input.sourceCommit,
      input.currentCommit
    ]);
    if (ancestry.exitCode === 1) {
      return contradictedAssessment(
        input.checkedAt,
        "current_state_conflict",
        input.repositoryId,
        input.currentCommit
      );
    }
    if (ancestry.exitCode !== 0) {
      return unknownAssessment(input.checkedAt, "verification_inconclusive");
    }

    const tracked = await runGit(input.repositoryRoot, [
      "ls-files",
      "--error-unmatch",
      "--",
      ...input.citedFiles.map((file) => file.relativePath)
    ]);
    if (tracked.exitCode !== 0)
      return unknownAssessment(input.checkedAt, "verification_inconclusive");

    const diff = await runGit(input.repositoryRoot, [
      "diff",
      "--quiet",
      input.sourceCommit,
      "--",
      ...input.citedFiles.map((file) => file.relativePath)
    ]);
    if (diff.exitCode === 1) {
      return contradictedAssessment(
        input.checkedAt,
        "stale",
        input.repositoryId,
        input.currentCommit,
        input.citedFiles.map((file) => file.reference)
      );
    }
    if (diff.exitCode !== 0) {
      return unknownAssessment(input.checkedAt, "verification_inconclusive");
    }

    // Identical final bytes do not erase intervening changes to cited files:
    // a later semantic supersession or manual revert may restore the old text.
    // Inspect only commits touching these paths. A canonical revert is stale;
    // any other intervening change remains unknown and is excluded from injection.
    const pathHistory = await inspectCitedFileHistory(
      input.repositoryRoot,
      input.sourceCommit,
      input.currentCommit,
      input.citedFiles.map((file) => file.relativePath)
    );
    if (pathHistory.exitCode !== 0) {
      return unknownAssessment(input.checkedAt, "verification_inconclusive");
    }
    if (pathHistory.reverted) {
      return contradictedAssessment(
        input.checkedAt,
        "stale",
        input.repositoryId,
        input.currentCommit,
        input.citedFiles.map((file) => file.reference)
      );
    }
    if (pathHistory.changed) {
      return unknownAssessment(
        input.checkedAt,
        "verification_inconclusive",
        "git_cited_file_history_changed"
      );
    }

    return {
      compatibility: "compatible",
      source: input.resolvedPullRequest
        ? "git_github_pr_review_checks_and_file_identity"
        : input.issueObservation
          ? "git_github_issue_state_and_file_identity"
          : "git_commit_and_file_identity",
      checkedAt: input.checkedAt,
      reasonCode: "verified_current_state",
      evidence: [
        {
          kind: "commit",
          uri: commitUri(input.repositoryId, input.currentCommit),
          revision: input.currentCommit,
          observedAt: input.checkedAt
        },
        ...(input.resolvedPullRequest ? [input.resolvedPullRequest] : []),
        ...(input.issueObservation
          ? [
              {
                kind: "issue" as const,
                uri: input.issueObservation.uri,
                observedAt: input.checkedAt
              }
            ]
          : []),
        ...input.citedFiles.map(({ reference }) => ({
          ...reference,
          revision: input.currentCommit,
          observedAt: input.checkedAt
        }))
      ],
      ...(input.issueObservation
        ? { issueObservations: [input.issueObservation] }
        : {})
    };
  }

  private async verifyCitedGitHubEvidence(
    evidence: readonly EvidenceReference[],
    context: MemoryReadContext,
    repositoryId: string,
    observedAt: string
  ): Promise<GitHubEvidenceVerificationResult> {
    const selection = selectGitHubReferences(evidence, repositoryId);
    if (selection.kind === "unknown") return selection;
    const { pullRequestReference, issueReference } = selection;
    if (!pullRequestReference && !issueReference) return { kind: "none" };

    const state = await this.githubStateForContext(
      context,
      repositoryId,
      pullRequestReference?.uri ?? null,
      issueReference?.uri ?? null
    );
    if (!state) {
      return {
        kind: "unknown",
        source: referenceStateSource(pullRequestReference, issueReference)
      };
    }
    if (pullRequestReference && state.pullRequest?.supersession) {
      // Checked before the merge/review/checks gate, not after it. A PR that
      // was replaced by a later one is usually *not* itself merged and approved,
      // so letting the gate answer first would report this as an ordinary
      // inconclusive read and discard the one finding that explains what
      // happened to the work the memory describes.
      const byPullRequest = state.pullRequest.supersession.byPullRequest;
      return {
        kind: "superseded",
        source: "git_github_pr_supersession",
        // Null when GitHub named a commit rather than the pull request that
        // closed this one. The supersession is still observed; only the address
        // an operator could open is missing, and inventing one would be
        // inventing evidence.
        supersedingPullRequest:
          byPullRequest === null
            ? null
            : { kind: "pull_request", uri: byPullRequest.url, observedAt }
      };
    }
    if (
      pullRequestReference &&
      !isVerifiedPullRequestState(state.pullRequest)
    ) {
      return { kind: "unknown", source: "git_github_pr_review_checks" };
    }
    if (issueReference && !state.issue) {
      return { kind: "unknown", source: "git_github_issue_state" };
    }

    const issueObservation =
      issueReference && state.issue
        ? {
            uri: issueReference.uri,
            state: state.issue.state,
            stateReason: state.issue.stateReason,
            updatedAt: state.issue.updatedAt,
            observedAt
          }
        : null;
    return {
      kind: "verified",
      pullRequestReference,
      mergeCommit: state.pullRequest?.mergeCommit ?? null,
      issueObservation
    };
  }

  /**
   * Resolve at most one PR and one issue together in a single GitHub query per
   * research context. Issue state is surfaced as context, never interpreted as
   * a task outcome; unavailable state fails closed when an issue was cited.
   */
  private githubStateForContext(
    context: MemoryReadContext,
    repositoryId: string,
    pullRequestUri: string | null,
    issueUri: string | null
  ): Promise<GitHubReferenceState | null> {
    const pullRequestLocator = pullRequestUri
      ? parseGitHubPullRequestLocator(pullRequestUri, repositoryId)
      : null;
    const issueLocator = issueUri
      ? parseGitHubIssueLocator(issueUri, repositoryId)
      : null;
    if (
      (pullRequestUri && !pullRequestLocator) ||
      (issueUri && !issueLocator) ||
      (!pullRequestLocator && !issueLocator)
    ) {
      return Promise.resolve(null);
    }

    let state = this.githubLookups.get(context);
    if (!state) {
      state = { lookups: 0, states: new Map() };
      this.githubLookups.set(context, state);
    }
    const pullRequestKey = pullRequestLocator
      ? `${pullRequestLocator.owner}/${pullRequestLocator.repository}#${pullRequestLocator.number}`.toLowerCase()
      : "";
    const issueKey = issueLocator
      ? `${issueLocator.owner}/${issueLocator.repository}#${issueLocator.number}`.toLowerCase()
      : "";
    const lookupKey = `pr=${pullRequestKey}|issue=${issueKey}`;
    const cached = state.states.get(lookupKey);
    if (cached) return cached;
    if (state.lookups >= GITHUB_LOOKUPS_PER_CONTEXT)
      return Promise.resolve(null);
    state.lookups += 1;
    const lookup = Promise.resolve()
      .then(() => this.githubState(repositoryId, pullRequestUri, issueUri))
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
    const baseRationale =
      input.assessment.source ===
      "git_github_pr_review_checks_and_file_identity"
        ? "The cited PR is merged with an approved review decision, successful checks, and no unresolved current review threads; its source commit is in the current repository lineage and cited files are unchanged."
        : "The cited source commit is in the current repository lineage and the cited files are unchanged.";
    const issueRationale = (input.assessment.issueObservations ?? []).map(
      (observation) =>
        `Current linked GitHub issue state is ${observation.state.toLowerCase()}${observation.stateReason ? ` (${observation.stateReason.toLowerCase().replaceAll("_", " ")})` : ""}, updated ${observation.updatedAt} and observed ${observation.observedAt}; this status alone does not establish task success or memory correctness.`
    );
    return Promise.resolve({
      disposition: "retain",
      guidance: input.memory.claim,
      rationale: [baseRationale, ...issueRationale].join(" ")
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
function selectGitHubReferences(
  evidence: readonly EvidenceReference[],
  repositoryId: string
): GitHubReferenceSelectionResult {
  const pullRequests = new Map<string, EvidenceReference>();
  const issues = new Map<string, EvidenceReference>();
  for (const reference of evidence) {
    if (reference.kind === "pull_request") {
      const locator = parseGitHubPullRequestLocator(
        reference.uri,
        repositoryId
      );
      if (!locator) continue;
      const key = `${locator.owner.toLowerCase()}/${locator.repository.toLowerCase()}#${locator.number}`;
      pullRequests.set(key, reference);
    } else if (reference.kind === "issue") {
      const locator = parseGitHubIssueLocator(reference.uri, repositoryId);
      if (!locator) continue;
      const key = `${locator.owner.toLowerCase()}/${locator.repository.toLowerCase()}#${locator.number}`;
      issues.set(key, reference);
    }
  }

  const ambiguousPullRequests = pullRequests.size > 1;
  const ambiguousIssues = issues.size > 1;
  if (ambiguousPullRequests || ambiguousIssues) {
    return {
      kind: "unknown",
      source:
        ambiguousPullRequests && ambiguousIssues
          ? "git_github_reference_state"
          : ambiguousPullRequests
            ? "git_github_pr_review_checks"
            : "git_github_issue_state"
    };
  }
  return {
    kind: "selected",
    pullRequestReference: pullRequests.values().next().value ?? null,
    issueReference: issues.values().next().value ?? null
  };
}

function referenceStateSource(
  pullRequestReference: EvidenceReference | null,
  issueReference: EvidenceReference | null
): GitHubReferenceSource {
  if (pullRequestReference && issueReference)
    return "git_github_reference_state";
  return pullRequestReference
    ? "git_github_pr_review_checks"
    : "git_github_issue_state";
}

function parseGitHubPullRequestLocator(
  uri: string,
  repositoryId: string
): GitHubPullRequestLocator | null {
  const target = canonicalGitHubPullRequestTarget(uri);
  if (!target) return null;
  // Evidence must name this repository. A pull request in another project is
  // not evidence about these files no matter how canonical its URL is.
  if (
    `${target.owner}/${target.repository}`.toLowerCase() !==
    repositoryId.trim().toLowerCase()
  ) {
    return null;
  }
  return target;
}

function parseGitHubIssueLocator(
  uri: string,
  repositoryId: string
): GitHubIssueLocator | null {
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
      segments[2] !== "issues" ||
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
 * Read current PR review/check state and/or issue state in one bounded query.
 * Issue state is context only, never a task-outcome verdict. The caller
 * independently checks local Git ancestry and cited-file identity.
 */
async function githubReferenceState(
  repositoryId: string,
  pullRequestUri: string | null,
  issueUri: string | null
): Promise<GitHubReferenceState | null> {
  const pullRequestLocator = pullRequestUri
    ? parseGitHubPullRequestLocator(pullRequestUri, repositoryId)
    : null;
  const issueLocator = issueUri
    ? parseGitHubIssueLocator(issueUri, repositoryId)
    : null;
  if (
    (pullRequestUri && !pullRequestLocator) ||
    (issueUri && !issueLocator) ||
    (!pullRequestLocator && !issueLocator)
  ) {
    return null;
  }

  const variableDefinitions = ["$owner: String!", "$name: String!"];
  const argumentsList = [
    "api",
    "graphql",
    "-F",
    `owner=${pullRequestLocator?.owner ?? issueLocator!.owner}`,
    "-F",
    `name=${pullRequestLocator?.repository ?? issueLocator!.repository}`
  ];
  const selections: string[] = [];
  if (pullRequestLocator) {
    variableDefinitions.push("$pullRequestNumber: Int!");
    argumentsList.push("-F", `pullRequestNumber=${pullRequestLocator.number}`);
    selections.push(`pullRequest(number: $pullRequestNumber) {
      state
      isDraft
      merged
      mergedAt
      mergeCommit { oid }
      reviewDecision
      statusCheckRollup { state }
      reviewThreads(first: ${MAX_GITHUB_REVIEW_THREADS}) {
        totalCount
        nodes { isResolved isOutdated }
      }
      timelineItems(first: 1, itemTypes: [CLOSED_EVENT]) {
        nodes {
          __typename
          ... on ClosedEvent {
            closer {
              __typename
              ... on PullRequest { number url merged }
            }
          }
        }
      }
    }`);
  }
  if (issueLocator) {
    variableDefinitions.push("$issueNumber: Int!");
    argumentsList.push("-F", `issueNumber=${issueLocator.number}`);
    selections.push(`issue(number: $issueNumber) {
      state
      stateReason
      updatedAt
    }`);
  }
  const query = `query(${variableDefinitions.join(", ")}) {
    repository(owner: $owner, name: $name) {
      ${selections.join("\n      ")}
    }
  }`;

  try {
    const result = await execFileAsync(
      "gh",
      [...argumentsList, "-f", `query=${query}`],
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
    if (!repository) return null;
    const pullRequest = pullRequestLocator
      ? parseGitHubPullRequestState(repository.pullRequest)
      : null;
    const issue = issueLocator ? parseGitHubIssueState(repository.issue) : null;
    if ((pullRequestLocator && !pullRequest) || (issueLocator && !issue))
      return null;
    return { pullRequest, issue };
  } catch {
    // Missing gh, unavailable credentials/network, private-repo access, an
    // invalid query, and API failures all remain inconclusive; none may
    // authorize memory injection.
    return null;
  }
}

function parseGitHubPullRequestState(
  value: unknown
): GitHubPullRequestState | null {
  const pullRequest = asRecord(value);
  if (!pullRequest) return null;
  const mergeCommit = asRecord(pullRequest.mergeCommit);
  const statusCheckRollup = asRecord(pullRequest.statusCheckRollup);
  const reviewThreadSummary = parseGitHubReviewThreadSummary(
    pullRequest.reviewThreads
  );
  if (
    typeof pullRequest.state !== "string" ||
    typeof pullRequest.isDraft !== "boolean" ||
    typeof pullRequest.merged !== "boolean" ||
    (pullRequest.mergedAt !== null &&
      typeof pullRequest.mergedAt !== "string") ||
    (pullRequest.reviewDecision !== null &&
      typeof pullRequest.reviewDecision !== "string") ||
    (statusCheckRollup !== null &&
      typeof statusCheckRollup.state !== "string") ||
    !reviewThreadSummary
  ) {
    return null;
  }
  const supersession = parseGitHubPullRequestSupersession(
    pullRequest.timelineItems
  );
  // An unreadable timeline must not become "nothing superseded this". Failing
  // the whole PR state closed here sends the memory down the existing unknown
  // path rather than minting an absence of supersession we never observed.
  if (!supersession.readable) return null;
  const mergeCommitOid = mergeCommit?.oid;
  return {
    state: pullRequest.state,
    isDraft: pullRequest.isDraft,
    merged: pullRequest.merged,
    mergedAt: pullRequest.mergedAt,
    mergeCommit:
      typeof mergeCommitOid === "string" && COMMIT_PATTERN.test(mergeCommitOid)
        ? mergeCommitOid.toLowerCase()
        : null,
    reviewDecision: pullRequest.reviewDecision,
    checksState:
      statusCheckRollup && typeof statusCheckRollup.state === "string"
        ? statusCheckRollup.state
        : null,
    reviewThreadsComplete: reviewThreadSummary.complete,
    unresolvedReviewThreadCount: reviewThreadSummary.unresolvedCount,
    supersession: supersession.supersession
  };
}

/**
 * The outcome of reading the supersession timeline.
 *
 * `readable: false` is deliberately not `supersession: null`. "Nothing superseded
 * this" and "we could not tell" have opposite consequences, and collapsing them
 * into one nullable value means the caller cannot fail closed on the second one.
 */
type SupersessionParse =
  | {
      readonly readable: true;
      readonly supersession: GitHubSupersession | null;
    }
  | { readonly readable: false };

const UNREADABLE_SUPERSESSION: SupersessionParse = { readable: false };

/**
 * Read whether anything superseded this pull request.
 *
 * The timeline is the only route to a close event: `PullRequest` has no
 * `closedEvent` field, so the closer is reached through
 * `PullRequestTimelineItemsConnection` filtered to `CLOSED_EVENT`. An open pull
 * request has no close event, so an empty node list is a readable "nothing did"
 * -- and the review and check gate rejects the open pull request on its own.
 */
function parseGitHubPullRequestSupersession(
  value: unknown
): SupersessionParse {
  const timeline = asRecord(value);
  if (!timeline) return UNREADABLE_SUPERSESSION;
  const nodes = timeline.nodes;
  if (!Array.isArray(nodes)) return UNREADABLE_SUPERSESSION;
  // One close event was requested. More than one means the connection answered
  // a different question than the one asked, and picking the first of them would
  // be guessing which one closed the pull request.
  if (nodes.length > 1) return UNREADABLE_SUPERSESSION;
  if (nodes.length === 0) return { readable: true, supersession: null };
  const event = asRecord(nodes[0]);
  if (!event || typeof event.__typename !== "string")
    return UNREADABLE_SUPERSESSION;
  // A node that is not a close event is not a supersession finding, but it is
  // also not a response that answered the question, so it stays unreadable.
  if (event.__typename !== GITHUB_CLOSED_EVENT)
    return UNREADABLE_SUPERSESSION;
  const closer = event.closer;
  if (closer === null) return { readable: true, supersession: null };
  const closerRecord = asRecord(closer);
  if (!closerRecord) return UNREADABLE_SUPERSESSION;
  const typeName = closerRecord.__typename;
  if (typeName === GITHUB_COMMIT_CLOSER)
    return { readable: true, supersession: { byPullRequest: null } };
  if (typeName !== GITHUB_PULL_REQUEST_CLOSER)
    return UNREADABLE_SUPERSESSION;
  if (
    typeof closerRecord.merged !== "boolean" ||
    typeof closerRecord.url !== "string" ||
    typeof closerRecord.number !== "number"
  ) {
    return UNREADABLE_SUPERSESSION;
  }
  // A pull request closed by another that never merged replaced nothing: the
  // closing pull request was abandoned, so the cited work is still the latest
  // account of itself.
  if (!closerRecord.merged) return { readable: true, supersession: null };
  const target = canonicalGitHubPullRequestTarget(closerRecord.url);
  // The URL is the address an operator would open and the number is the value
  // the rest of the system compares, so a response where they disagree is not
  // one to build a verdict on.
  if (target === null || target.number !== closerRecord.number)
    return UNREADABLE_SUPERSESSION;
  return {
    readable: true,
    supersession: {
      byPullRequest: { number: target.number, url: closerRecord.url }
    }
  };
}

/**
 * Owner, repository, and number of a canonical GitHub pull request URL.
 *
 * Split out from `parseGitHubPullRequestLocator` so a URL this code merely
 * inspects -- the superseding pull request reported inside a close event -- is
 * checked by the same rules as one it is about to authorize. A second copy of
 * these comparisons is a second set of rules that can drift from the first, and
 * it drifts in the direction of accepting a URL the first one would refuse.
 */
function canonicalGitHubPullRequestTarget(
  uri: string
): { owner: string; repository: string; number: number } | null {
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
      !GITHUB_PULL_REQUEST_NUMBER_PATTERN.test(segments[3]!)
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

interface GitHubReviewThreadSummary {
  readonly complete: boolean;
  readonly unresolvedCount: number;
}

function parseGitHubReviewThreadSummary(
  value: unknown
): GitHubReviewThreadSummary | null {
  const summary = asRecord(value);
  if (
    !summary ||
    !Number.isSafeInteger(summary.totalCount) ||
    (summary.totalCount as number) < 0 ||
    !Array.isArray(summary.nodes) ||
    summary.nodes.length > MAX_GITHUB_REVIEW_THREADS
  ) {
    return null;
  }
  const threads = summary.nodes.map(asRecord);
  if (
    threads.some(
      (thread) =>
        !thread ||
        typeof thread.isResolved !== "boolean" ||
        typeof thread.isOutdated !== "boolean"
    )
  ) {
    return null;
  }
  return {
    // `complete` answers "did we see every thread?", so it compares against the
    // count GitHub reports rather than the count we happened to receive. It
    // carried a second `threads.length <= 100` clause that could not be false --
    // the guard above has already returned for a longer page, and `.map`
    // preserves length -- so it only restated the bound beside a check that
    // already enforced it.
    complete: summary.totalCount === threads.length,
    unresolvedCount: threads.filter(
      (thread) => !thread!.isResolved && !thread!.isOutdated
    ).length
  };
}

function parseGitHubIssueState(value: unknown): GitHubIssueState | null {
  const issue = asRecord(value);
  if (
    !issue ||
    (issue.state !== "OPEN" && issue.state !== "CLOSED") ||
    (issue.stateReason !== null &&
      issue.stateReason !== "COMPLETED" &&
      issue.stateReason !== "NOT_PLANNED" &&
      issue.stateReason !== "REOPENED") ||
    typeof issue.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(issue.updatedAt))
  ) {
    return null;
  }
  return {
    state: issue.state,
    stateReason: issue.stateReason,
    updatedAt: issue.updatedAt
  };
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
    value.checksState === "SUCCESS" &&
    value.reviewThreadsComplete &&
    value.unresolvedReviewThreadCount === 0
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

function supersededAssessment(
  checkedAt: string,
  repositoryId: string,
  currentCommit: string,
  supersedingPullRequest: EvidenceReference | null
): CurrentStateAssessment {
  return {
    compatibility: "contradicted",
    source: "git_github_pr_supersession",
    checkedAt,
    reasonCode: "superseded",
    evidence: [
      {
        kind: "commit",
        uri: commitUri(repositoryId, currentCommit),
        revision: currentCommit,
        observedAt: checkedAt
      },
      ...(supersedingPullRequest === null ? [] : [supersedingPullRequest])
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
