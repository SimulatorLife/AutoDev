import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

const MAX_BINDING_FILE_BYTES = 32 * 1024;
const MAX_ABSOLUTE_PATH = 4096;
const MAX_ID_LENGTH = 256;
const ABSOLUTE_PATH_PATTERN = /^\/.+/u;

/** Workspace entry binding a canonical repository root to a (workspaceId, repositoryId). */
export interface ClaudeCodeWorkspaceBinding {
  readonly canonicalRoot: string;
  readonly canonicalTranscriptRoot: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
}

/** Canonical Claude Code capture configuration loaded from the operator-owned binding file. */
export interface ClaudeCodeCaptureBinding {
  readonly optIn: boolean;
  readonly workspaces: readonly ClaudeCodeWorkspaceBinding[];
}

/** Stable, bounded failure classification. Never derived from caller-supplied fields. */
export type ClaudeCodeBindingFailure =
  | "binding_file_unset"
  | "binding_file_missing"
  | "binding_file_malformed"
  | "binding_unconfigured"
  | "transcript_root_unresolved"
  | "transcript_root_ambiguous"
  | "workspace_root_unresolved"
  | "workspace_unauthorized"
  | "workspace_ambiguous"
  | "transcript_root_escape"
  | "session_id_mismatch";

export type ClaudeCodeBindingResult =
  | { readonly ok: true; readonly binding: ClaudeCodeCaptureBinding }
  | {
      readonly ok: false;
      readonly failure: ClaudeCodeBindingFailure;
      readonly failureMessage?: string;
    };

/** Dependency seam shared by the workspace and transcript resolvers. */
export interface ClaudeCodeResolverDependencies {
  readonly realpath?: (path: string) => string;
}

export interface ClaudeCodeBindingDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly realpath?: (path: string) => string;
}

class OversizedBindingFileError extends Error {}

/** Resolve the canonical operator-owned binding file path for Claude Code capture. */
export function resolveClaudeCodeBindingFilePath(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const explicit = env.AUTODEV_CLAUDE_CODE_BINDING_FILE?.trim();
  if (explicit) return path.isAbsolute(explicit) ? explicit : null;
  const configuredHome = env.CLAUDE_HOME?.trim();
  if (configuredHome && !path.isAbsolute(configuredHome)) return null;
  const claudeHome = configuredHome || path.join(homedir(), ".claude");
  return path.join(claudeHome, "claude-code-memory.toml");
}

export function loadClaudeCodeCaptureBinding(
  dependencies: ClaudeCodeBindingDependencies = {}
): ClaudeCodeBindingResult {
  const filePath = resolveClaudeCodeBindingFilePath(
    dependencies.env ?? process.env
  );
  if (!filePath) return { ok: false, failure: "binding_file_unset" };

  let parsed: Record<string, unknown>;
  try {
    parsed = parseBinding(readBoundedBindingFile(filePath));
  } catch (error) {
    if (error instanceof OversizedBindingFileError) {
      return {
        ok: false,
        failure: "binding_file_malformed",
        failureMessage: error.message
      };
    }
    return {
      ok: false,
      failure: isErrorCode(error, "ENOENT")
        ? "binding_file_missing"
        : "binding_file_malformed"
    };
  }

  if (typeof parsed.optIn !== "boolean")
    return { ok: false, failure: "binding_unconfigured" };
  const realpath = dependencies.realpath ?? realpathSync;
  const workspaceResult = configuredWorkspaces(parsed.workspace, realpath);
  if (!workspaceResult.ok) return workspaceResult;

  return {
    ok: true,
    binding: {
      optIn: parsed.optIn,
      workspaces: workspaceResult.workspaces
    }
  };
}

function readBoundedBindingFile(filePath: string): string {
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile())
      throw new Error("Binding path must be a regular file.");
    if (metadata.size > MAX_BINDING_FILE_BYTES)
      throw new OversizedBindingFileError(
        "Binding file exceeds the 32 KiB size bound."
      );

    const buffer = Buffer.allocUnsafe(MAX_BINDING_FILE_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_BINDING_FILE_BYTES)
      throw new OversizedBindingFileError(
        "Binding file exceeds the 32 KiB size bound."
      );
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function parseBinding(contents: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseToml(contents) as unknown;
  } catch {
    throw new Error("Binding file is not valid TOML.");
  }
  if (!isRecord(value))
    throw new Error("Binding file must contain a TOML table.");
  return value;
}

function configuredWorkspaces(
  value: unknown,
  realpath: (path: string) => string
):
  | {
      readonly ok: true;
      readonly workspaces: readonly ClaudeCodeWorkspaceBinding[];
    }
  | Extract<ClaudeCodeBindingResult, { readonly ok: false }> {
  if (!Array.isArray(value) || value.length === 0)
    return { ok: false, failure: "binding_unconfigured" };

  const seenRoots = new Set<string>();
  const transcriptRoots: string[] = [];
  const workspaces: ClaudeCodeWorkspaceBinding[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return { ok: false, failure: "binding_unconfigured" };
    const { root, workspaceId, repositoryId } = entry;
    if (
      typeof root !== "string" ||
      !ABSOLUTE_PATH_PATTERN.test(root) ||
      root.length > MAX_ABSOLUTE_PATH ||
      typeof workspaceId !== "string" ||
      workspaceId.length === 0 ||
      workspaceId.length > MAX_ID_LENGTH ||
      typeof repositoryId !== "string" ||
      repositoryId.length === 0 ||
      repositoryId.length > MAX_ID_LENGTH ||
      typeof entry.transcriptRoot !== "string" ||
      !ABSOLUTE_PATH_PATTERN.test(entry.transcriptRoot) ||
      entry.transcriptRoot.length > MAX_ABSOLUTE_PATH
    ) {
      return { ok: false, failure: "binding_unconfigured" };
    }

    let canonicalRoot: string;
    let canonicalTranscriptRoot: string;
    try {
      canonicalRoot = realpath(root);
    } catch {
      return { ok: false, failure: "workspace_root_unresolved" };
    }
    try {
      canonicalTranscriptRoot = realpath(entry.transcriptRoot);
    } catch {
      return { ok: false, failure: "transcript_root_unresolved" };
    }
    if (seenRoots.has(canonicalRoot))
      return { ok: false, failure: "workspace_ambiguous" };
    if (
      transcriptRoots.some((existing) =>
        pathsOverlap(existing, canonicalTranscriptRoot)
      )
    ) {
      return { ok: false, failure: "transcript_root_ambiguous" };
    }
    seenRoots.add(canonicalRoot);
    transcriptRoots.push(canonicalTranscriptRoot);
    workspaces.push({
      canonicalRoot,
      canonicalTranscriptRoot,
      workspaceId,
      repositoryId
    });
  }
  return { ok: true, workspaces };
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = path.relative(left, right);
  const rightToLeft = path.relative(right, left);
  const isWithin = (relative: string): boolean =>
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative));
  return isWithin(leftToRight) || isWithin(rightToLeft);
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

export interface ResolveClaudeCodeWorkspaceResult {
  readonly ok: boolean;
  readonly workspace?: ClaudeCodeWorkspaceBinding;
  readonly failure?: ClaudeCodeBindingFailure;
  readonly failureMessage?: string;
  /** All canonical roots that realpath'd to the same resolved cwd; size >1 means ambiguity. */
  readonly matches?: readonly ClaudeCodeWorkspaceBinding[];
}

/**
 * Resolve a realpath'd hook-supplied cwd against the canonical binding.
 *
 * The resolver accepts exactly one operator-authorized entry whose
 * `realpath` equals `realpath(cwd)`. It rejects:
 *
 * - nested roots (`cwd` deeper than a configured root);
 * - parent roots (`cwd` is an ancestor of a configured root);
 * - symlink aliases that resolve to the same canonical path as a
 *   different configured root (ambiguity);
 * - configured roots whose own `realpath` cannot be resolved.
 *
 * The hook-supplied `cwd` is never treated as scope authority; it is
 * only a lookup key into the operator-owned canonical binding map.
 */
export function resolveClaudeCodeWorkspaceBinding(
  binding: ClaudeCodeCaptureBinding,
  candidatePath: string,
  dependencies: ClaudeCodeResolverDependencies = {}
): ResolveClaudeCodeWorkspaceResult {
  const realpath = dependencies.realpath ?? realpathSync;
  if (!path.isAbsolute(candidatePath)) {
    return {
      ok: false,
      failure: "workspace_unauthorized",
      failureMessage: "Claude Code hook cwd must be an absolute path."
    };
  }
  let resolvedCwd: string;
  try {
    resolvedCwd = realpath(candidatePath);
  } catch {
    return {
      ok: false,
      failure: "workspace_root_unresolved",
      failureMessage: "Claude Code hook cwd failed to realpath."
    };
  }
  const matches: ClaudeCodeWorkspaceBinding[] = [];
  for (const workspace of binding.workspaces) {
    if (workspace.canonicalRoot === resolvedCwd) {
      matches.push(workspace);
      continue;
    }
    // Nested/parent path: cwd deeper than the configured root, or cwd
    // is an ancestor of the configured root, indicates Claude Code ran
    // inside a subdirectory of an authorized repo (or outside it). The
    // canonical binding is anchored at the repository root, so any
    // subdirectory is treated as unauthorized.
    if (
      resolvedCwd.startsWith(workspace.canonicalRoot + path.sep) ||
      workspace.canonicalRoot.startsWith(resolvedCwd + path.sep)
    ) {
      return {
        ok: false,
        failure: "workspace_unauthorized",
        failureMessage:
          "Claude Code hook cwd must match a canonical workspace root exactly; subdirectory or ancestor paths are unauthorized."
      };
    }
  }
  if (matches.length === 0) {
    return {
      ok: false,
      failure: "workspace_unauthorized",
      failureMessage:
        "Claude Code hook cwd does not match any operator-authorized workspace root."
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      failure: "workspace_ambiguous",
      matches,
      failureMessage:
        "Multiple operator-authorized workspace entries share the resolved canonical root."
    };
  }
  const [matched] = matches;
  if (!matched) {
    return {
      ok: false,
      failure: "workspace_ambiguous",
      failureMessage:
        "Multiple operator-authorized workspace entries share the resolved canonical root."
    };
  }
  return { ok: true, workspace: matched };
}

/**
 * Validate that a realpath'd hook-supplied transcript path stays beneath
 * the matched workspace's transcript root. Uses `realpath` for both
 * sides so symlink escapes cannot bypass the check.
 */
export function resolveClaudeCodeTranscriptBinding(
  workspace: ClaudeCodeWorkspaceBinding,
  candidatePath: string,
  sessionId: string,
  dependencies: ClaudeCodeResolverDependencies = {}
): ResolveClaudeCodeWorkspaceResult {
  const realpath = dependencies.realpath ?? realpathSync;
  if (!path.isAbsolute(candidatePath)) {
    return {
      ok: false,
      failure: "transcript_root_escape",
      failureMessage: "Claude Code transcript path must be an absolute path."
    };
  }
  let resolvedTranscript: string;
  try {
    resolvedTranscript = realpath(candidatePath);
  } catch {
    return {
      ok: false,
      failure: "transcript_root_escape",
      failureMessage: "Claude Code transcript path failed to realpath."
    };
  }
  const relative = path.relative(
    workspace.canonicalTranscriptRoot,
    resolvedTranscript
  );
  const inside =
    Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative) &&
    relative !== ".";
  if (!inside) {
    return {
      ok: false,
      failure: "transcript_root_escape",
      failureMessage:
        "Claude Code transcript must remain beneath the operator-configured transcript root."
    };
  }
  if (path.basename(resolvedTranscript) !== `${sessionId}.jsonl`) {
    return {
      ok: false,
      failure: "session_id_mismatch",
      failureMessage:
        "Claude Code transcript basename must match the bound session_id."
    };
  }
  return { ok: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
