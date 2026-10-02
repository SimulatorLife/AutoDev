import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  type ClaudeCodeBindingDependencies,
  loadClaudeCodeCaptureBinding,
  resolveClaudeCodeTranscriptBinding,
  resolveClaudeCodeWorkspaceBinding
} from "../src/control-api/claude-code-binding.ts";
import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";

function captureRequest(body: Record<string, unknown>): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url: "/control/memory/claude-code/capture",
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

function captureResponse(): {
  readonly response: ServerResponse;
  readonly status: () => number;
  readonly body: () => Record<string, unknown>;
} {
  let status = 0;
  let body = "";
  const response = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    end(value?: Buffer | string) {
      body = value?.toString() ?? "";
      return this;
    }
  } as unknown as ServerResponse;
  return {
    response,
    status: () => status,
    body: () => JSON.parse(body) as Record<string, unknown>
  };
}

function makeRootDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function makeDirs(...segments: string[]): string {
  const full = path.join(...segments);
  mkdirSync(full, { recursive: true });
  return full;
}

function writeBinding(dir: string, contents: string): string {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "claude-code-memory.toml");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function makeDeps(
  partial: Partial<ClaudeCodeBindingDependencies> = {}
): ClaudeCodeBindingDependencies & { realpath: (p: string) => string } {
  return {
    realpath: (p) => realpathSync(p),
    ...partial
  };
}

test("Claude Code capture requires operator authority and an operator-owned binding", async () => {
  const bindingHome = makeRootDir("claude-binding-api-");
  const bindingPath = path.join(bindingHome, "missing.toml");
  const previousBindingPath = process.env.AUTODEV_CLAUDE_CODE_BINDING_FILE;
  process.env.AUTODEV_CLAUDE_CODE_BINDING_FILE = bindingPath;
  const requestBody = {
    sessionId: "session-a",
    transcriptPath: "/private/transcripts/session-a.jsonl",
    cwd: "/private/repo"
  };
  const auditRecords: Array<Record<string, unknown>> = [];
  try {
    const viewerResponse = captureResponse();
    await handleMemoryControlApiRequest(
      captureRequest(requestBody),
      viewerResponse.response,
      "/control/memory/claude-code/capture",
      { actor: "memory-viewer", role: "viewer" },
      (event) => auditRecords.push(event)
    );
    assert.equal(viewerResponse.status(), 403);

    const operatorResponse = captureResponse();
    await handleMemoryControlApiRequest(
      captureRequest(requestBody),
      operatorResponse.response,
      "/control/memory/claude-code/capture",
      { actor: "memory-operator", role: "operator" },
      (event) => auditRecords.push(event)
    );
    assert.equal(operatorResponse.status(), 400);
    assert.equal(auditRecords.at(-1)?.reason, "binding_file_missing");
  } finally {
    if (previousBindingPath === undefined)
      delete process.env.AUTODEV_CLAUDE_CODE_BINDING_FILE;
    else process.env.AUTODEV_CLAUDE_CODE_BINDING_FILE = previousBindingPath;
    rmSync(bindingHome, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCaptureBinding parses the canonical operator-owned binding", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcripts = makeDirs(home, "transcripts");
    const repoA = makeDirs(home, "repo-a");
    const transcriptsReal = realpathSync(transcripts);
    const repoAReal = realpathSync(repoA);
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${repoAReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, true);
    assert.ok(result.binding);
    assert.equal(result.binding!.optIn, true);
    assert.equal(
      result.binding!.workspaces[0]!.canonicalTranscriptRoot,
      transcriptsReal
    );
    assert.equal(result.binding!.workspaces.length, 1);
    assert.equal(result.binding!.workspaces[0]!.canonicalRoot, repoAReal);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCaptureBinding fails closed when the binding file is missing", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const result = loadClaudeCodeCaptureBinding({
      env: {
        AUTODEV_CLAUDE_CODE_BINDING_FILE: path.join(home, "missing.toml")
      },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "binding_file_missing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCaptureBinding fails closed when the binding file is malformed", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const filePath = writeBinding(home, "optIn = \ninvalid toml");
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "binding_file_malformed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCaptureBinding fails closed when optIn is missing", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcriptsReal = realpathSync(makeDirs(home, "transcripts"));
    const repoAReal = realpathSync(makeDirs(home, "repo-a"));
    const filePath = writeBinding(
      home,
      `
[[workspace]]
root = "${repoAReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "binding_unconfigured");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCaptureBinding fails closed on duplicate realpath'd canonical roots", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcriptsReal = realpathSync(makeDirs(home, "transcripts"));
    const repoAReal = realpathSync(makeDirs(home, "repo-a"));
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${repoAReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
[[workspace]]
root = "${repoAReal}/"
workspaceId = "ws_a_dup"
repositoryId = "repo_a_dup"
transcriptRoot = "${transcriptsReal}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "workspace_ambiguous");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCaptureBinding rejects overlapping transcript roots across workspaces", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const repoA = realpathSync(makeDirs(home, "repo-a"));
    const repoB = realpathSync(makeDirs(home, "repo-b"));
    const transcripts = realpathSync(makeDirs(home, "transcripts"));
    const nestedTranscripts = realpathSync(
      makeDirs(home, "transcripts", "nested")
    );
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${repoA}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcripts}"
[[workspace]]
root = "${repoB}"
workspaceId = "ws_b"
repositoryId = "repo_b"
transcriptRoot = "${nestedTranscripts}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath }
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "transcript_root_ambiguous");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCaptureBinding fails closed when a workspace root fails to realpath", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcriptsReal = realpathSync(makeDirs(home, "transcripts"));
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "/this/path/is/definitely/missing"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => {
        if (p === "/this/path/is/definitely/missing") throw new Error("ENOENT");
        return realpathSync(p);
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "workspace_root_unresolved");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeWorkspaceBinding rejects nested subdirectory cwds", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const repoReal = realpathSync(makeDirs(home, "repo-a"));
    const binding = {
      optIn: true,
      workspaces: [
        {
          canonicalRoot: repoReal,
          canonicalTranscriptRoot: realpathSync(makeDirs(home, "transcripts")),
          workspaceId: "ws_a",
          repositoryId: "repo_a"
        }
      ]
    };
    const subReal = realpathSync(makeDirs(home, "repo-a", "subdir"));
    const resolution = resolveClaudeCodeWorkspaceBinding(
      binding,
      subReal,
      makeDeps()
    );
    assert.equal(resolution.ok, false);
    assert.equal(resolution.failure, "workspace_unauthorized");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeWorkspaceBinding rejects ancestor cwds", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const repoSubReal = realpathSync(makeDirs(home, "repo-a", "subdir"));
    const repoReal = realpathSync(makeDirs(home, "repo-a"));
    const binding = {
      optIn: true,
      workspaces: [
        {
          canonicalRoot: repoSubReal,
          canonicalTranscriptRoot: realpathSync(makeDirs(home, "transcripts")),
          workspaceId: "ws_a",
          repositoryId: "repo_a"
        }
      ]
    };
    const resolution = resolveClaudeCodeWorkspaceBinding(
      binding,
      repoReal,
      makeDeps()
    );
    assert.equal(resolution.ok, false);
    assert.equal(resolution.failure, "workspace_unauthorized");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeWorkspaceBinding rejects forged sibling paths", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const repoReal = realpathSync(makeDirs(home, "repo-a"));
    const repoSiblingReal = realpathSync(makeDirs(home, "repo-aa"));
    const binding = {
      optIn: true,
      workspaces: [
        {
          canonicalRoot: repoReal,
          canonicalTranscriptRoot: realpathSync(makeDirs(home, "transcripts")),
          workspaceId: "ws_a",
          repositoryId: "repo_a"
        }
      ]
    };
    const resolution = resolveClaudeCodeWorkspaceBinding(
      binding,
      repoSiblingReal,
      makeDeps()
    );
    assert.equal(resolution.ok, false);
    assert.equal(resolution.failure, "workspace_unauthorized");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeWorkspaceBinding accepts exact realpath match and rejects subdirectory", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const repoReal = realpathSync(makeDirs(home, "repo-real"));
    makeDirs(repoReal, "sub");
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${repoReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${realpathSync(makeDirs(home, "transcripts"))}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, true);
    const binding = result.binding!;
    // Exact match via realpath.
    const exact = resolveClaudeCodeWorkspaceBinding(
      binding,
      repoReal,
      makeDeps()
    );
    assert.equal(exact.ok, true);
    // Subdirectory of the canonical root must NOT match.
    const subdir = resolveClaudeCodeWorkspaceBinding(
      binding,
      path.join(repoReal, "sub"),
      makeDeps()
    );
    assert.equal(subdir.ok, false);
    assert.equal(subdir.failure, "workspace_unauthorized");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a workspace binding cannot accept another workspace's Claude transcript", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const repoA = realpathSync(makeDirs(home, "repo-a"));
    const repoB = realpathSync(makeDirs(home, "repo-b"));
    const transcriptsA = realpathSync(makeDirs(home, "transcripts-a"));
    const transcriptsB = realpathSync(makeDirs(home, "transcripts-b"));
    const transcriptA = path.join(transcriptsA, "session-a.jsonl");
    writeFileSync(transcriptA, "{}", "utf8");
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${repoA}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsA}"
[[workspace]]
root = "${repoB}"
workspaceId = "ws_b"
repositoryId = "repo_b"
transcriptRoot = "${transcriptsB}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath }
    });
    assert.equal(result.ok, true);
    const workspaceB = resolveClaudeCodeWorkspaceBinding(
      result.binding!,
      repoB
    );
    assert.equal(workspaceB.ok, true);
    const resolution = resolveClaudeCodeTranscriptBinding(
      workspaceB.workspace!,
      transcriptA,
      "session-a"
    );
    assert.equal(resolution.ok, false);
    assert.equal(resolution.failure, "transcript_root_escape");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeTranscriptBinding rejects realpath escape via symlink", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcriptsReal = realpathSync(makeDirs(home, "transcripts"));
    const escaped = makeDirs(home, "escaped");
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${realpathSync(makeDirs(home, "repo-a"))}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, true);
    const resolution = resolveClaudeCodeTranscriptBinding(
      result.binding!.workspaces[0]!,
      path.join(escaped, "session-a.jsonl"),
      "session-a",
      makeDeps()
    );
    assert.equal(resolution.ok, false);
    assert.equal(resolution.failure, "transcript_root_escape");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeTranscriptBinding accepts a transcript whose basename carries the bound session id", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcriptsReal = realpathSync(makeDirs(home, "transcripts"));
    const repoAReal = realpathSync(makeDirs(home, "repo-a"));
    const transcript = makeDirs(transcriptsReal, "sub");
    const transcriptFile = path.join(transcript, "session-a.jsonl");
    writeFileSync(transcriptFile, "{}", "utf8");
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${repoAReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, true);
    const resolution = resolveClaudeCodeTranscriptBinding(
      result.binding!.workspaces[0]!,
      transcriptFile,
      "session-a",
      makeDeps()
    );
    assert.equal(resolution.ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeTranscriptBinding rejects a transcript whose basename carries a different session id", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcriptsReal = realpathSync(makeDirs(home, "transcripts"));
    const repoAReal = realpathSync(makeDirs(home, "repo-a"));
    const transcript = makeDirs(transcriptsReal, "sub");
    const transcriptFile = path.join(transcript, "session-other.jsonl");
    writeFileSync(transcriptFile, "{}", "utf8");
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${repoAReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, true);
    const resolution = resolveClaudeCodeTranscriptBinding(
      result.binding!.workspaces[0]!,
      transcriptFile,
      "session-a",
      makeDeps()
    );
    assert.equal(resolution.ok, false);
    assert.equal(resolution.failure, "session_id_mismatch");
    const unrecognizedName = path.join(transcript, "archive.jsonl");
    writeFileSync(unrecognizedName, "{}", "utf8");
    const unrecognized = resolveClaudeCodeTranscriptBinding(
      result.binding!.workspaces[0]!,
      unrecognizedName,
      "session-a",
      makeDeps()
    );
    assert.equal(unrecognized.ok, false);
    assert.equal(unrecognized.failure, "session_id_mismatch");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveClaudeCodeTranscriptBinding rejects `..` escape via realpath", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcriptsReal = realpathSync(makeDirs(home, "transcripts"));
    const repoAReal = realpathSync(makeDirs(home, "repo-a"));
    const escapedFile = path.join(home, "secret.jsonl");
    writeFileSync(escapedFile, "{}", "utf8");
    const crafted = path.join(transcriptsReal, "..", "secret.jsonl");
    const filePath = writeBinding(
      home,
      `
optIn = true
[[workspace]]
root = "${repoAReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`
    );
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => realpathSync(p)
    });
    assert.equal(result.ok, true);
    const resolution = resolveClaudeCodeTranscriptBinding(
      result.binding!.workspaces[0]!,
      crafted,
      "session-a",
      makeDeps()
    );
    assert.equal(resolution.ok, false);
    assert.equal(resolution.failure, "transcript_root_escape");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadClaudeCodeCaptureBinding rejects oversized binding files before parsing", () => {
  const home = makeRootDir("claude-binding-");
  try {
    const transcriptsReal = realpathSync(makeDirs(home, "transcripts"));
    const repoAReal = realpathSync(makeDirs(home, "repo-a"));
    const oversizedContents = "x".repeat(40 * 1024);
    const filePath = path.join(home, "claude-code-memory.toml");
    writeFileSync(filePath, oversizedContents, "utf8");
    const result = loadClaudeCodeCaptureBinding({
      env: { AUTODEV_CLAUDE_CODE_BINDING_FILE: filePath },
      realpath: (p) => {
        if (p === transcriptsReal) return transcriptsReal;
        if (p === repoAReal) return repoAReal;
        throw new Error(`unexpected realpath: ${p}`);
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure, "binding_file_malformed");
    assert.match(result.failureMessage ?? "", /exceeds the 32 KiB size bound/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
