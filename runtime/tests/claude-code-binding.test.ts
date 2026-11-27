/**
The Claude Code capture binding: which workspace a hook's cwd belongs to, and
which transcript it may write.

Both are authorization boundaries, and both are decided by one owner of path
containment rather than by a spelling of their own. The workspace is matched
exactly -- a subdirectory of an authorized repository is not the repository --
and the transcript must stay beneath the operator-configured transcript root,
where the root itself is a directory and not a transcript.
*/
import assert from "node:assert/strict";
import test from "node:test";

import {
  type ClaudeCodeCaptureBinding,
  type ClaudeCodeWorkspaceBinding,
  resolveClaudeCodeTranscriptBinding,
  resolveClaudeCodeWorkspaceBinding
} from "../src/control-api/claude-code-binding.ts";

const WORKSPACE_ROOT = "/repos/project";
const TRANSCRIPT_ROOT = "/repos/project/.claude/transcripts";
const SESSION_ID = "session-1";

const workspace: ClaudeCodeWorkspaceBinding = {
  canonicalRoot: WORKSPACE_ROOT,
  canonicalTranscriptRoot: TRANSCRIPT_ROOT,
  workspaceId: "workspace-1",
  repositoryId: "repository-1"
};

const binding: ClaudeCodeCaptureBinding = {
  optIn: true,
  workspaces: [workspace]
};

/**
The paths under test are already canonical, so the realpath seam is the
identity: the resolver is asked about the paths it would see after realpath.
*/
const canonical = { realpath: (value: string): string => value };

test("a cwd that is the authorized workspace root resolves to it", () => {
  const result = resolveClaudeCodeWorkspaceBinding(
    binding,
    WORKSPACE_ROOT,
    canonical
  );
  assert.equal(result.ok, true);
  assert.equal(result.workspace, workspace);
});

test("a cwd inside the authorized workspace is refused as nested, not as an unknown path", () => {
  // The canonical binding is anchored at the repository root, so a
  // subdirectory is a different path than the one the operator authorized.
  // The operator is told it is nested rather than told it matches nothing,
  // because those are different mistakes with different repairs.
  const result = resolveClaudeCodeWorkspaceBinding(
    binding,
    `${WORKSPACE_ROOT}/src`,
    canonical
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure, "workspace_unauthorized");
  assert.match(result.failureMessage ?? "", /subdirectory or ancestor/u);
});

test("a cwd that is an ancestor of the authorized workspace is refused", () => {
  const result = resolveClaudeCodeWorkspaceBinding(
    binding,
    "/repos",
    canonical
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure, "workspace_unauthorized");
});

test("a cwd that matches no authorized workspace is refused as unknown", () => {
  const result = resolveClaudeCodeWorkspaceBinding(
    binding,
    "/elsewhere/project",
    canonical
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure, "workspace_unauthorized");
  assert.match(
    result.failureMessage ?? "",
    /does not match any operator-authorized workspace root/u
  );
});

test("a transcript beneath the transcript root resolves to the workspace", () => {
  const result = resolveClaudeCodeTranscriptBinding(
    workspace,
    `${TRANSCRIPT_ROOT}/${SESSION_ID}.jsonl`,
    SESSION_ID,
    canonical
  );
  assert.equal(result.ok, true);
  assert.equal(result.failure, undefined);
});

test("the transcript root itself is refused: it is a directory, not a transcript", () => {
  const result = resolveClaudeCodeTranscriptBinding(
    workspace,
    TRANSCRIPT_ROOT,
    SESSION_ID,
    canonical
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure, "transcript_root_escape");
});

test("a transcript one level above the transcript root is refused", () => {
  // The transcript root's own parent is not beneath it. A path that leaves
  // the root by exactly one level does not walk out of it the way a deeper
  // escape does, so the containment check has to say so itself.
  const result = resolveClaudeCodeTranscriptBinding(
    workspace,
    "/repos/project/.claude/session-1.jsonl",
    SESSION_ID,
    canonical
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure, "transcript_root_escape");
});

test("a transcript that belongs to another session is refused", () => {
  const result = resolveClaudeCodeTranscriptBinding(
    workspace,
    `${TRANSCRIPT_ROOT}/session-2.jsonl`,
    SESSION_ID,
    canonical
  );
  assert.equal(result.ok, false);
  assert.equal(result.failure, "session_id_mismatch");
});
