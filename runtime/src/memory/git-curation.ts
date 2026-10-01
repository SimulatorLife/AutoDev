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
const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER_BYTES = 512 * 1024;

export interface MemoryRepositoryRootResolver {
  /** Resolves a repository from trusted runtime metadata, never a tool argument. */
  resolve(context: MemoryReadContext): string | null | Promise<string | null>;
}

/**
 * Conservative current-state validation for memories grounded in Git files.
 * It only marks a claim compatible when its source commit is an ancestor of
 * current HEAD and every cited file is byte-for-byte unchanged in the current
 * working tree. Anything without that evidence remains unknown and cannot be
 * injected by MemoryService.
 */
interface GitRepositorySnapshot {
  readonly root: string;
  readonly head: string;
}

export class GitWorkingTreeMemoryVerifier implements MemoryCurrentStateVerifier {
  private readonly repositories: MemoryRepositoryRootResolver;
  private readonly now: () => string;
  private readonly snapshots = new WeakMap<
    MemoryReadContext,
    Promise<GitRepositorySnapshot | null>
  >();

  constructor(options: {
    readonly repositories: MemoryRepositoryRootResolver;
    readonly now?: () => string;
  }) {
    this.repositories = options.repositories;
    this.now = options.now ?? (() => new Date().toISOString());
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
    const sourceCommit = sourceCommitFrom(input.memory.provenance.evidence);
    const citedFiles = citedRepositoryFiles(
      repositoryRoot,
      input.memory.provenance.evidence
    );
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
        ...citedFiles.map(({ reference }) => ({
          ...reference,
          revision: currentCommit,
          observedAt: checkedAt
        }))
      ]
    };
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
