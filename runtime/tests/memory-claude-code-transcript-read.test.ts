import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  type RecordedResponse,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The transcript reader, which had never run in a test.
 *
 * `persistClaudeCodeExperience` looks up the orchestrator service *before* it
 * reads anything:
 *
 *     const service = createOrchestratorMemoryService();
 *     if (!service) return "unavailable";
 *     const transcript = await readClaudeCodeTranscript(transcriptPath);
 *
 * so without a configured memory host every capture stopped one line early and
 * all 61 lines of the reader were unreachable. That read had been written off
 * as needing a live database, which is not true: `createPostgresMemoryHost`
 * builds a `pg.Pool`, which connects lazily, so *any* syntactically valid
 * `AUTODEV_MEMORY_DATABASE_URL` produces a real service. The write downstream
 * then fails against a host that does not exist -- which is the whole trick
 * here, because it lets the read be exercised without a database.
 *
 * What is worth pinning is the boundary the route actually exposes: a
 * transcript the reader refuses is `autodev_memory_capture_invalid`, and one it
 * accepts gets as far as the write. The reader has three distinct refusal
 * messages -- unreadable, bad size, and a stat/read disagreement -- and the
 * route collapses all of them into one message, so the finer distinctions are
 * not observable here. What *is* observable is that each of two malformed
 * shapes is refused and a well-formed one is not, and both of the reader's
 * guards for each shape are covered: dropping the `size <= 0` check still
 * refuses an empty file through the `bytesRead <= 0` check below it, and
 * dropping the `isFile` check still refuses a directory when the read fails.
 *
 * The 32 MiB ceiling is not tested by writing 32 MiB: it shares one condition
 * with the empty-file and not-a-file cases. The `O_NOFOLLOW` open is defence
 * against a symlink swapped in between the canonicalisation above and the open
 * below -- a window no test can open deterministically, and the path handed to
 * `open` has already been through `realpathSync`.
 */

const CAPTURE = "/control/memory/claude-code/capture";
const BINDING_ENV = "AUTODEV_CLAUDE_CODE_BINDING_FILE";
const DATABASE_ENV = "AUTODEV_MEMORY_DATABASE_URL";
const SESSION_ID = "session-transcript";

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

function errorCode(body: Record<string, unknown> | null): unknown {
  const envelope = body?.error;
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>).code
    : undefined;
}

function errorMessage(body: Record<string, unknown> | null): string {
  const envelope = body?.error;
  return typeof envelope === "object" && envelope !== null
    ? String((envelope as Record<string, unknown>).message)
    : "";
}

/**
 * A workspace with a bound transcript root and a binding file naming both.
 *
 * `makeTranscript` writes whatever the transcript should be, so a test can put
 * an empty file, a directory, or a real transcript at the same canonical path.
 */
function workspaceFixture(makeTranscript: (transcriptPath: string) => void): {
  readonly home: string;
  readonly bindingPath: string;
  readonly cwd: string;
} {
  const home = mkdtempSync(path.join(tmpdir(), "claude-transcript-"));
  const repo = path.join(home, "repo");
  const transcripts = path.join(home, "transcripts");
  mkdirSync(repo, { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  // macOS resolves /var to /private/var, so the binding must name the canonical
  // path or every realpath comparison below would miss.
  const repoReal = realpathSync(repo);
  const transcriptsReal = realpathSync(transcripts);
  makeTranscript(path.join(transcriptsReal, `${SESSION_ID}.jsonl`));
  const bindingPath = path.join(home, "claude-code-memory.toml");
  writeFileSync(
    bindingPath,
    `optIn = true
[[workspace]]
root = "${repoReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`,
    "utf8"
  );
  return { home, bindingPath, cwd: repoReal };
}

function request(body: Record<string, unknown>): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url: CAPTURE,
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

/**
 * Run one capture with a syntactically valid memory database URL.
 *
 * The host is constructed lazily, so this is enough for the capture to reach
 * the transcript read. `AUTODEV_MEMORY_RECONSTRUCTION=deterministic` keeps the
 * host from also building a routed reconstructor, which is not what these tests
 * are about.
 */
async function capture(fixture: {
  readonly bindingPath: string;
  readonly cwd: string;
  readonly transcriptPath: string;
}): Promise<CallResult> {
  const response: RecordedResponse = responseRecorder();
  const previousBinding = process.env[BINDING_ENV];
  const previousDatabase = process.env[DATABASE_ENV];
  const previousReconstruction = process.env.AUTODEV_MEMORY_RECONSTRUCTION;
  process.env[BINDING_ENV] = fixture.bindingPath;
  process.env[DATABASE_ENV] = "postgresql://memory.invalid:5432/autodev";
  process.env.AUTODEV_MEMORY_RECONSTRUCTION = "deterministic";
  try {
    await handleMemoryControlApiRequest(
      request({
        sessionId: SESSION_ID,
        transcriptPath: fixture.transcriptPath,
        cwd: fixture.cwd
      }),
      response,
      CAPTURE,
      { actor: "memory-operator", role: "operator" },
      () => undefined
    );
  } finally {
    for (const [key, value] of [
      [BINDING_ENV, previousBinding],
      [DATABASE_ENV, previousDatabase],
      ["AUTODEV_MEMORY_RECONSTRUCTION", previousReconstruction]
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { status: response.statusCode, body: responseBody(response) };
}

test("an empty transcript is refused on size, not read as an empty experience", async () => {
  const fixture = workspaceFixture((transcriptPath) =>
    writeFileSync(transcriptPath, "")
  );
  try {
    const { status, body } = await capture({
      ...fixture,
      transcriptPath: realpathSync(
        path.join(fixture.home, "transcripts", `${SESSION_ID}.jsonl`)
      )
    });

    // `capture_invalid` is what a read-side guard produces; `capture_failed`
    // is what a request that passed every guard and failed later produces. So
    // the code, not the message, is what says the reader refused this file --
    // the route deliberately reports one message for every validation refusal.
    assert.equal(status, 400);
    assert.equal(
      errorCode(body),
      "autodev_memory_capture_invalid",
      "an empty transcript must be refused by the reader, not read as empty"
    );
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("a transcript path that is not a file is refused on size", async () => {
  // A directory at the transcript path. `open` succeeds on a directory with
  // O_RDONLY, so only the `isFile` check can catch this -- and catching it is
  // what stops a directory being read as an empty transcript.
  const fixture = workspaceFixture((transcriptPath) => {
    mkdirSync(transcriptPath, { recursive: true });
  });
  try {
    const { status, body } = await capture({
      ...fixture,
      transcriptPath: realpathSync(
        path.join(fixture.home, "transcripts", `${SESSION_ID}.jsonl`)
      )
    });

    assert.equal(status, 400);
    assert.equal(
      errorCode(body),
      "autodev_memory_capture_invalid",
      "a directory at the transcript path must be refused by the reader"
    );
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("a readable transcript is read, and the failure that follows is downstream", async () => {
  // The positive half, and the reason the other two are meaningful. A real
  // transcript passes every read-side guard, so whatever the capture says next
  // must be the write failing against the host that does not exist -- and
  // demonstrably not a size refusal.
  const fixture = workspaceFixture((transcriptPath) =>
    writeFileSync(
      transcriptPath,
      '{"type":"assistant","message":{"content":"done"}}\n'
    )
  );
  try {
    const { body } = await capture({
      ...fixture,
      transcriptPath: realpathSync(
        path.join(fixture.home, "transcripts", `${SESSION_ID}.jsonl`)
      )
    });

    // The positive half, and the reason the other two mean something. A real
    // transcript clears every read-side guard, so the capture fails later --
    // against the host that does not exist -- and says so with a different code.
    assert.equal(
      errorCode(body),
      "autodev_memory_capture_failed",
      "a real transcript must clear the reader and fail later, not be refused"
    );
    assert.doesNotMatch(
      errorMessage(body),
      /input is invalid/u,
      "a readable transcript must not be reported as an invalid input"
    );
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});
