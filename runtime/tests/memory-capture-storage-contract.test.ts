import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  truncate,
  writeFile
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type ExperienceEnvelope,
  type MemoryReadContext
} from "@simulatorlife/autodev-core";
import {
  MemoryConflictError,
  type MemoryService
} from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  clearTrustedMemoryContextsForTest,
  injectOrchestratorMemory
} from "../src/router/memory-injection.ts";
import {
  makeRequest,
  type RecordedResponse,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * What the native capture routes do once a request has cleared every guard.
 *
 * Both capture handlers resolve the orchestrator memory service *directly*,
 * bypassing the `createMemoryService` dependency the rest of this file honours at
 * its one resolution site. So the three answers that decide whether a capture
 * worked — stored, already stored, or in conflict with something already there —
 * were reachable only against a live Postgres, and the whole of
 * `captureExperienceIdempotently` plus `respondToDuplicateCapture` ran untested.
 *
 * That is not a coverage gap; it is a missing test seam on a boundary the file
 * already had. It mattered because idempotency is the property these routes are
 * for: a SessionEnd hook fires on a session the user may end twice, and the
 * second firing has to be recognised as the same capture rather than either
 * writing a second envelope or — worse — reporting a conflict to a hook that
 * did nothing wrong.
 *
 * The service below is a double, but not a permissive one: it keys its answers by
 * experience id, stores what it was given, and returns that stored envelope on the
 * next read. A double that answered every read with one fixed envelope would make
 * the duplicate path pass for the wrong reason, and the conflict path
 * unreachable.
 */

const CODEX_CAPTURE = "/control/memory/capture";
const CLAUDE_CAPTURE = "/control/memory/claude-code/capture";
const BINDING_ENV = "AUTODEV_CLAUDE_CODE_BINDING_FILE";
const MAX_NATIVE_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

interface AuditEntry {
  readonly action: string;
  readonly resource: string;
  readonly outcome: "ok" | "denied" | "error";
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly audits: AuditEntry[];
}

function errorCode(body: Record<string, unknown> | null): unknown {
  const envelope = body?.error;
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>).code
    : undefined;
}

/**
 * A store that remembers what it was asked to store.
 *
 * `seeded` names an envelope the store already holds under the id the route is
 * about to use, which is how the duplicate and conflict paths are reached. It is
 * keyed by id rather than returned unconditionally, so a route reading the wrong
 * id gets `null` and writes — a silent wrong-key bug cannot pass as a duplicate.
 *
 * `broken` makes every call throw. A capture against a store that is down is not
 * the caller's fault, so it has to reach the catch arm rather than the duplicate
 * arm, and the difference between those is only observable with a store that can
 * actually fail.
 */
function recordingService(
  seeded: Readonly<Record<string, ExperienceEnvelope>> = {},
  options: { readonly broken?: boolean } = {}
) {
  const stored: Record<string, ExperienceEnvelope> = { ...seeded };
  const captured: ExperienceEnvelope[] = [];
  const reads: string[] = [];
  const contexts: MemoryReadContext[] = [];
  let conflictOnWrite: "matching" | "differing" | null = null;
  const broken = options.broken === true;

  const service = {
    async getExperience(id: string, context: MemoryReadContext) {
      if (broken) throw new Error("the store is down");
      reads.push(id);
      contexts.push(context);
      return stored[id] ?? null;
    },
    async captureExperience(input: CaptureInput) {
      if (broken) throw new Error("the store is down");
      if (conflictOnWrite) {
        // The store lost the race: something else stored this id first. Report
        // the conflict the way a real store would, then let the route re-read.
        //
        // The winner is keyed on the same trajectory uri and differs only in
        // digest. Leaving the uri out would make every "differing" case fail the
        // first half of the comparison instead of the half this fixture is about.
        const winner = conflictOnWrite === "matching";
        conflictOnWrite = null;
        stored[input.experience.id] = withTrajectory(
          input.experience,
          input.trajectoryUri,
          winner ? digestOf(input) : "a-different-digest"
        );
        throw new MemoryConflictError("Experience already exists.");
      }
      const envelope = withTrajectory(
        input.experience,
        input.trajectoryUri,
        digestOf(input)
      );
      stored[envelope.id] = envelope;
      captured.push(envelope);
      return { steps: [] };
    }
  } as unknown as MemoryService;

  return {
    service,
    reads,
    contexts,
    get captures() {
      return captured;
    },
    stored,
    /** Make the next write lose a race to a concurrent capture. */
    loseNextWriteRaceTo(mode: "matching" | "differing") {
      conflictOnWrite = mode;
    }
  };
}

interface CaptureInput {
  readonly transcript: string;
  readonly trajectoryUri: string;
  readonly experience: ExperienceEnvelope;
}

/**
 * The stored envelope, as a store would build it.
 *
 * The route hands over an envelope with no `trajectory` at all — the store
 * normalizes the transcript and fills the trajectory in. Reproducing that here
 * matters: the duplicate comparison the route makes is on `trajectory.uri` and
 * `trajectory.digest`, so a double that invented them would be deciding the
 * outcome the test is trying to observe.
 */
function withTrajectory(
  envelope: ExperienceEnvelope,
  uri: string,
  digest: string
): ExperienceEnvelope {
  return {
    ...envelope,
    trajectory: { uri, digest, steps: [] }
  } as unknown as ExperienceEnvelope;
}

type StoreHandle = ReturnType<typeof recordingService>;

/**
 * The one envelope a store was asked to write, as a value rather than an
 * index. The count is asserted first so a store that wrote twice fails here
 * instead of silently passing on its first entry.
 */
function onlyCaptured(store: StoreHandle): ExperienceEnvelope {
  assert.equal(
    store.captures.length,
    1,
    `expected exactly one stored envelope, saw ${store.captures.length}`
  );
  const envelope = store.captures[0];
  assert.ok(envelope, "the stored envelope is missing");
  return envelope;
}

/** The digest the route would have computed for these contents. */
function digestOf(input: { readonly transcript: string }): string {
  // The route hashes the transcript it read. Recomputing it here keeps the double
  // honest: a duplicate is "the same bytes were captured before", not "the route
  // asked for the same id twice".
  return createHash("sha256")
    .update(input.transcript, "utf8")
    .digest("hex");
}

async function call(
  request: IncomingMessage,
  pathname: string,
  service: MemoryService | null
): Promise<CallResult> {
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  const handled = await handleMemoryControlApiRequest(
    request,
    response,
    pathname,
    { actor: "test-operator", role: "operator" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => service }
  );
  assert.equal(handled, true, `${pathname} was not handled`);
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits
  };
}

/* ------------------------------------------------------------------ *
 * Codex: authority from the router's record of sessions it observed.
 * ------------------------------------------------------------------ */

const OBSERVED_SESSION = "session-abc123";

interface CodexFixture {
  readonly workspaceCwd: string;
  readonly sessionsRoot: string;
  readonly transcript: string;
  readonly transcriptBody: string;
  readonly capture: (store: StoreHandle | null) => Promise<CallResult>;
}

/**
 * A workspace the router has observed, a `CODEX_HOME` whose sessions directory
 * exists, and a transcript inside it that clears every guard.
 */
async function withCapturableSession(
  run: (fixture: CodexFixture) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "autodev-capture-store-"));
  const workspaceCwd = join(root, "repo");
  const sessionsRoot = join(root, "codex", "sessions");
  await mkdir(workspaceCwd, { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  const transcript = join(sessionsRoot, "rollout.jsonl");
  const transcriptBody = '{"type":"assistant"}\n';
  await writeFile(transcript, transcriptBody);
  const previousCodexHome = process.env.CODEX_HOME;
  const previousMode = process.env.AUTODEV_MEMORY_MODE;
  process.env.CODEX_HOME = join(root, "codex");
  process.env.AUTODEV_MEMORY_MODE = "jit";
  clearTrustedMemoryContextsForTest();
  try {
    // A `null` host returns from the injection immediately; the session is
    // recorded by then, which is the point of registering it this way.
    await injectOrchestratorMemory(
      {
        payload: {
          model: "autodev/orchestrator",
          instructions: "Authoritative root policy.",
          input: [{ type: "message", role: "user", content: "Do the task." }]
        },
        requestId: "request-current",
        sessionKey: OBSERVED_SESSION,
        sessionScope: "identified",
        threadId: "root-thread",
        workspace: {
          key: "owner/repo",
          cwd: workspaceCwd,
          workspace_id: "workspace-a"
        }
      },
      null
    );
    await run({
      workspaceCwd,
      sessionsRoot,
      transcript,
      transcriptBody,
      capture: (store) =>
        call(
          makeRequest("POST", CODEX_CAPTURE, {
            sessionId: OBSERVED_SESSION,
            transcriptPath: transcript,
            cwd: workspaceCwd
          }),
          CODEX_CAPTURE,
          store?.service ?? null
        )
    });
  } finally {
    clearTrustedMemoryContextsForTest();
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousMode === undefined) delete process.env.AUTODEV_MEMORY_MODE;
    else process.env.AUTODEV_MEMORY_MODE = previousMode;
    await rm(root, { recursive: true, force: true });
  }
}

/** The id the route derives from the session, so a test can seed the store. */
function codexExperienceId(): string {
  return `codex-session-${createHash("sha256")
    .update(OBSERVED_SESSION, "utf8")
    .digest("hex")}`;
}

test("a cleared capture stores an envelope scoped by the router, not the request", async () => {
  await withCapturableSession(async ({ capture, transcriptBody }) => {
    const store = recordingService();

    const { status, body, audits } = await capture(store);

    assert.equal(status, 200, JSON.stringify({ body, audits }));
    assert.equal(body?.schema, "autodev-memory-capture-v1");
    assert.equal(body?.captured, true);
    // `ok` is emitted only after the envelope is stored, so the audit trail and
    // the reply are both downstream of the write.
    assert.equal(audits.at(-1)?.outcome, "ok");
    assert.deepEqual(audits.at(-1)?.changes, {
      source: "codex",
      outcome: "unknown"
    });

    const envelope = onlyCaptured(store);
    assert.equal(envelope.id, codexExperienceId());
    // The scope came from the workspace the router observed. The request named a
    // `cwd` and a `sessionId`; neither of those is the workspace.
    assert.equal(envelope.workspaceId, "workspace-a");
    assert.equal(envelope.taskId, OBSERVED_SESSION);
    assert.deepEqual(envelope.scope, {
      kind: "task",
      workspaceId: "workspace-a",
      taskId: OBSERVED_SESSION,
      runId: OBSERVED_SESSION
    });
    assert.equal(envelope.trajectory.digest, digestOf({ transcript: transcriptBody }));
  });
});

test("the same session captured twice is answered as a duplicate and stores nothing", async () => {
  // The property this route exists for. A SessionEnd hook can fire twice; the
  // second firing must be told `captured: false` rather than either writing a
  // second envelope or reporting a conflict to a hook that did nothing wrong.
  await withCapturableSession(async ({ capture }) => {
    const store = recordingService();
    const first = await capture(store);
    assert.equal(first.body?.captured, true, "the first capture did not store");

    const second = await capture(store);

    assert.equal(second.status, 200);
    assert.equal(second.body?.schema, "autodev-memory-capture-v1");
    assert.equal(second.body?.captured, false);
    // A duplicate is an `ok`: the caller wanted this stored and it is stored. The
    // distinction the audit trail needs is the `duplicate` flag, not the outcome.
    assert.equal(second.audits.at(-1)?.outcome, "ok");
    assert.deepEqual(second.audits.at(-1)?.changes, {
      source: "codex",
      duplicate: true
    });
    assert.equal(store.captures.length, 1, "the replay wrote a second envelope");
  });
});

test("a transcript that changed under a captured session is a conflict, not a duplicate", async () => {
  // The other half of idempotency, and the reason the comparison is on the
  // transcript digest rather than on the session id. Same session, different
  // bytes: reporting that as a duplicate would silently discard a real change to
  // the trajectory, and overwriting it would erase what was captured first.
  await withCapturableSession(async ({ capture, transcriptBody }) => {
    const id = codexExperienceId();
    const uri = `codex://session/${OBSERVED_SESSION}`;
    const store = recordingService({
      [id]: {
        id,
        workspaceId: "workspace-a",
        trajectory: { uri, digest: "stale" },
        steps: []
      } as unknown as ExperienceEnvelope
    });
    assert.notEqual(
      "stale",
      digestOf({ transcript: transcriptBody }),
      "the fixture must disagree with the transcript, or it proves nothing"
    );
    // Both halves of the comparison have to agree with the request except for the
    // digest. A fixture that merely supplied a different uri would reach the 409
    // too, and would do so without ever testing the digest.
    assert.equal(
      store.stored[id]?.trajectory.uri,
      uri,
      "the seeded envelope must name the trajectory this request carries"
    );

    const { status, body, audits } = await capture(store);

    assert.equal(status, 409);
    assert.equal(errorCode(body), "autodev_memory_capture_conflict");
    assert.equal(audits.at(-1)?.reason, "captured_transcript_conflict");
    assert.equal(audits.at(-1)?.outcome, "error");
    assert.equal(
      store.captures.length,
      0,
      "a conflicting capture overwrote the stored envelope"
    );
  });
});

test("a capture that loses the write race to the same transcript is a duplicate", async () => {
  // The reason `captureExperienceIdempotently` catches the conflict at all: two
  // SessionEnd hooks for one session is not hypothetical, and the loser of that
  // race must not report a 409 to a hook whose capture did in fact land.
  await withCapturableSession(async ({ capture }) => {
    const store = recordingService();
    store.loseNextWriteRaceTo("matching");

    const { status, body, audits } = await capture(store);

    assert.equal(status, 200, JSON.stringify({ body, audits }));
    assert.equal(body?.captured, false);
    assert.deepEqual(audits.at(-1)?.changes, {
      source: "codex",
      duplicate: true
    });
    // Two reads: one before the write, one to see who won it.
    assert.equal(store.reads.length, 2, "the race was not re-read after losing");
  });
});

test("a capture that loses the write race to a different transcript still conflicts", async () => {
  // The re-read is a check, not a retry. If the winner stored something other
  // than what this request carries, returning `false` would report a duplicate
  // for an envelope nobody has.
  await withCapturableSession(async ({ capture, transcriptBody }) => {
    const store = recordingService();
    store.loseNextWriteRaceTo("differing");

    const { status, body, audits } = await capture(store);

    assert.equal(status, 409);
    assert.equal(errorCode(body), "autodev_memory_capture_conflict");
    assert.equal(audits.at(-1)?.reason, "captured_transcript_conflict");
    // The winner names the same trajectory and a different digest. If the uri
    // had differed instead, this 409 would be the *pre-write* check answering and
    // the post-write re-read would never have run.
    const winner = store.stored[codexExperienceId()];
    assert.equal(
      winner?.trajectory.uri,
      `codex://session/${OBSERVED_SESSION}`,
      "the winner must agree with the request on the trajectory uri"
    );
    assert.equal(winner?.trajectory.digest, "a-different-digest");
    assert.notEqual(
      winner?.trajectory.digest,
      digestOf({ transcript: transcriptBody }),
      "the winner must not hold the bytes this request carries"
    );
  });
});

test("the store is asked to read the scope the router observed", async () => {
  // The read context is where the request's authority becomes the store's
  // authorization. A context carrying the caller's own `cwd`, or a
  // `canReadGlobal: true` the router never granted, would widen every read this
  // route performs.
  await withCapturableSession(async ({ capture }) => {
    const store = recordingService();

    await capture(store);

    assert.equal(store.contexts.length >= 1, true, "the store was never read");
    for (const context of store.contexts) {
      assert.equal(context.workspaceId, "workspace-a");
      assert.equal(context.repositoryId, "owner/repo");
      assert.equal(context.taskId, OBSERVED_SESSION);
      assert.equal(context.role, "orchestrator");
      assert.equal(context.canReadGlobal, false);
    }
  });
});

test("an unconfigured store is answered 503 and audited, not silently skipped", async () => {
  // The fallback the route had *only* before it was injectable. The hook sees a
  // 503 and nothing else, so without the audit entry "capture never happened"
  // and "capture was refused" would be the same fact in the trail.
  await withCapturableSession(async ({ capture }) => {
    const { status, body, audits } = await capture(null);

    assert.equal(status, 503);
    assert.equal(errorCode(body), "autodev_memory_unavailable");
    assert.equal(audits.at(-1)?.reason, "memory_unavailable");
    assert.equal(audits.at(-1)?.outcome, "error");
  });
});

test("a store that fails outright is a 503, not a validation error", async () => {
  // The catch arm nothing else reaches. A broken store is not the caller's fault,
  // so it must not borrow the 400 that says the request was invalid — a hook that
  // sees 400 on a well-formed body has no way to tell it from a bad argument.
  await withCapturableSession(async ({ capture }) => {
    const store = recordingService({}, { broken: true });

    const { status, body, audits } = await capture(store);

    assert.equal(status, 503);
    assert.equal(errorCode(body), "autodev_memory_capture_failed");
    assert.equal(audits.at(-1)?.reason, "capture_failed");
    assert.equal(audits.at(-1)?.outcome, "error");
    assert.equal(store.captures.length, 0, "a failed store still recorded a write");
  });
});

/* ------------------------------------------------------------------ *
 * Claude Code: authority from the operator's binding file.
 * ------------------------------------------------------------------ */

const CLAUDE_SESSION_ID = "session-a";

interface ClaudeFixture {
  readonly home: string;
  readonly bindingPath: string;
  readonly cwd: string;
  readonly transcriptRoot: string;
  readonly transcript: string;
  readonly transcriptBody: string;
  readonly capture: (store: StoreHandle | null) => Promise<CallResult>;
  /** The same capture, naming a different file under the bound root. */
  readonly captureFile: (
    transcriptPath: string,
    store: StoreHandle | null
  ) => Promise<CallResult>;
}

/**
 * A bound workspace, a bound transcript root, and a transcript under it that
 * clears every binding check.
 */
async function withBoundClaudeSession(
  run: (fixture: ClaudeFixture) => Promise<void>
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "autodev-claude-store-"));
  const repo = join(home, "repo");
  const transcripts = join(home, "transcripts");
  await mkdir(repo, { recursive: true });
  await mkdir(transcripts, { recursive: true });
  // macOS resolves /var to /private/var, so the binding must name canonical paths
  // or every realpath comparison inside the route would miss.
  const cwd = realpathSync(repo);
  const transcriptRoot = realpathSync(transcripts);
  const transcript = join(transcriptRoot, `${CLAUDE_SESSION_ID}.jsonl`);
  const transcriptBody = '{"type":"assistant","message":{"content":"done"}}\n';
  await writeFile(transcript, transcriptBody);
  const bindingPath = join(home, "claude-code-memory.toml");
  await writeFile(
    bindingPath,
    `optIn = true
[[workspace]]
root = "${cwd}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptRoot}"
`
  );
  const previous = process.env[BINDING_ENV];
  process.env[BINDING_ENV] = bindingPath;
  const captureFile = async (
    transcriptPath: string,
    store: StoreHandle | null
  ): Promise<CallResult> => {
    const audits: AuditEntry[] = [];
    const response: RecordedResponse = responseRecorder();
    const handled = await handleMemoryControlApiRequest(
      makeRequest("POST", CLAUDE_CAPTURE, {
        sessionId: CLAUDE_SESSION_ID,
        transcriptPath,
        cwd
      }),
      response,
      CLAUDE_CAPTURE,
      { actor: "test-operator", role: "operator" },
      (entry) => audits.push(entry as AuditEntry),
      { createMemoryService: () => store?.service ?? null }
    );
    assert.equal(handled, true, "the Claude capture route was not handled");
    return { status: response.statusCode, body: responseBody(response), audits };
  };
  try {
    await run({
      home,
      bindingPath,
      cwd,
      transcriptRoot,
      transcript,
      transcriptBody,
      captureFile,
      capture: (store) => captureFile(transcript, store)
    });
  } finally {
    if (previous === undefined) delete process.env[BINDING_ENV];
    else process.env[BINDING_ENV] = previous;
    await rm(home, { recursive: true, force: true });
  }
}

test("a bound Claude capture stores an envelope scoped by the binding", async () => {
  await withBoundClaudeSession(async ({ capture, transcriptBody }) => {
    const store = recordingService();

    const { status, body, audits } = await capture(store);

    assert.equal(status, 200, JSON.stringify({ body, audits }));
    assert.equal(body?.schema, "autodev-memory-capture-v1");
    assert.equal(body?.captured, true);
    assert.deepEqual(audits.at(-1)?.changes, {
      source: "claude-code",
      outcome: "unknown"
    });

    const envelope = onlyCaptured(store);
    // The workspace identity is the operator's, read out of the binding — never
    // anything the hook sent.
    assert.equal(envelope.workspaceId, "ws_a");
    assert.equal(envelope.repositoryId, "repo_a");
    assert.equal(envelope.taskId, CLAUDE_SESSION_ID);
    assert.equal(
      envelope.trajectory.digest,
      digestOf({ transcript: transcriptBody })
    );
    // The envelope and the store read it under agree on which session this was,
    // so the write cannot have been scoped to something the request named.
    assert.equal(store.contexts.length >= 1, true, "the store was never read");
    assert.equal(store.contexts[0]?.taskId, CLAUDE_SESSION_ID);
    assert.equal(store.contexts[0]?.workspaceId, "ws_a");
  });
});

test("a repeated Claude capture is answered as a duplicate and stores nothing", async () => {
  // SessionEnd hooks are not once-only: a resumed or re-fired hook must not write
  // a second envelope for the same session, and must not be told it conflicted.
  await withBoundClaudeSession(async ({ capture }) => {
    const store = recordingService();
    const first = await capture(store);
    assert.equal(first.body?.captured, true, "the first capture did not store");

    const second = await capture(store);

    assert.equal(second.status, 200);
    assert.equal(second.body?.captured, false);
    assert.deepEqual(second.audits.at(-1)?.changes, {
      source: "claude-code",
      duplicate: true
    });
    assert.equal(store.captures.length, 1, "the replay wrote a second envelope");
  });
});

test("a changed Claude transcript under the same session is a conflict", async () => {
  await withBoundClaudeSession(async ({ capture }) => {
    const store = recordingService();
    store.loseNextWriteRaceTo("differing");

    const { status, body, audits } = await capture(store);

    assert.equal(status, 409);
    assert.equal(errorCode(body), "autodev_memory_capture_conflict");
    assert.equal(audits.at(-1)?.reason, "captured_transcript_conflict");
  });
});

/* ------------------------------------------------------------------ *
 * The Claude transcript reader, which sits below the store lookup.
 * ------------------------------------------------------------------ */

/**
 * Every guard inside `readClaudeCodeTranscript` was written off as unenforced
 * while the reader sat below a service the route built itself: with no store
 * configured the route answered 503 before opening anything, so the reader was
 * only ever entered by a live deployment. These tests are possible now that the
 * route resolves through the injectable factory.
 *
 * They matter for a specific reason: this route is the one whose authority is a
 * file, so a request that clears every binding check names an arbitrary path
 * inside a bound root. The reader's own checks are the last thing standing
 * between "inside the root" and "a regular, non-empty, bounded file the operator
 * meant to share".
 *
 * Two things about these tests are worth stating because mutation testing is what
 * established them:
 *
 * - They pin the *refusal*, not the individual predicate. The reader checks the
 *   size twice — once from `stat`, before it allocates its buffer, and once from
 *   the bytes it actually read — and the two overlap for every fixture here.
 *   Removing either one alone leaves all four tests green; removing both turns the
 *   empty and oversized cases red. Which of the two refuses is not observable from
 *   a response, so it is not claimed.
 *
 * - One arm stays out of reach and is deliberately not faked.
 *   `readClaudeCodeTranscript` opens with `O_NOFOLLOW`, but the path it is handed
 *   is already the `realpath` of the hook-supplied one, so it is canonical before
 *   it arrives and a symlink at that location has been resolved away. The flag is
 *   defence against a swap in the window between the `realpath` and the `open`,
 *   and this route cannot stage that window from a request.
 */
test("a transcript that is a directory is refused by the reader, not by the binding", async () => {
  // Every binding check passes this: it is under the bound root and its basename
  // matches the session. What refuses it is inside the reader. Which reader check
  // is not claimed — a directory also fails the read, so dropping the `isFile`
  // predicate alone leaves this green.
  await withBoundClaudeSession(async ({ captureFile, transcriptRoot }) => {
    const asDirectory = join(transcriptRoot, `${CLAUDE_SESSION_ID}.jsonl`);
    await rm(asDirectory, { force: true });
    await mkdir(asDirectory);

    const { status, body, audits } = await captureFile(
      asDirectory,
      recordingService()
    );

    assert.equal(status, 400, JSON.stringify({ body, audits }));
    assert.equal(errorCode(body), "autodev_memory_capture_invalid");
    assert.equal(audits.at(-1)?.reason, "invalid_capture");
  });
});

test("an empty Claude transcript is refused by the reader", async () => {
  // Non-empty is its own bound, separate from "is a file": an operator's hook can
  // fire before Claude Code has flushed its first record, and storing an empty
  // trajectory would be indistinguishable from a session that produced nothing.
  // This is one of the two tests that turn red when both size checks are removed.
  await withBoundClaudeSession(async ({ captureFile, transcriptRoot }) => {
    const empty = join(transcriptRoot, `${CLAUDE_SESSION_ID}.jsonl`);
    await rm(empty, { force: true });
    await writeFile(empty, "");

    const { status, body, audits } = await captureFile(
      empty,
      recordingService()
    );

    assert.equal(status, 400, JSON.stringify({ body, audits }));
    assert.equal(errorCode(body), "autodev_memory_capture_invalid");
    assert.equal(audits.at(-1)?.reason, "invalid_capture");
  });
});

test("an oversized Claude transcript is refused on its size", async () => {
  // Unlike the Codex route, the reader here has to open the file before it can
  // stat it, so there is no way to refuse an unreadable-and-oversized file on the
  // size alone — an earlier version of this fixture made exactly that mistake by
  // also chmod'ing the file to 000, which meant the open failed first and the
  // size bound was never reached. Mutating both size checks out of the reader
  // leaves this test red; mutating either one alone leaves it green.
  await withBoundClaudeSession(async ({ captureFile, transcriptRoot }) => {
    const oversized = join(transcriptRoot, `${CLAUDE_SESSION_ID}.jsonl`);
    await rm(oversized, { force: true });
    // Sparse, so this costs no disk: create it, then extend the length.
    await writeFile(oversized, "");
    await truncate(oversized, MAX_NATIVE_TRANSCRIPT_BYTES + 1);

    const store = recordingService();
    const { status, body, audits } = await captureFile(oversized, store);

    assert.equal(status, 400, JSON.stringify({ body, audits }));
    assert.equal(errorCode(body), "autodev_memory_capture_invalid");
    assert.equal(audits.at(-1)?.reason, "invalid_capture");
    // Refused, not truncated-and-stored: a 32MiB envelope is not the outcome the
    // bound exists to prevent.
    assert.equal(store.captures.length, 0, "an oversized transcript was stored");
  });
});

test("an unreadable Claude transcript is refused by the open, not the size", async () => {
  // The open-failure arm, which is a different check from the size bounds and
  // fires earlier: the reader opens before it can stat. A file that is neither
  // empty nor large, only unreadable, so nothing but the open can refuse it.
  await withBoundClaudeSession(async ({ captureFile, transcriptRoot }) => {
    const unreadable = join(transcriptRoot, `${CLAUDE_SESSION_ID}.jsonl`);
    const before = (await stat(unreadable)).size;
    assert.ok(before > 0, "the fixture must not be refused for being empty");

    await chmod(unreadable, 0o000);

    const store = recordingService();
    const { status, body, audits } = await captureFile(unreadable, store);

    assert.equal(status, 400, JSON.stringify({ body, audits }));
    assert.equal(errorCode(body), "autodev_memory_capture_invalid");
    assert.notEqual(audits.at(-1)?.outcome, "ok");
    assert.equal(store.captures.length, 0, "an unreadable transcript was stored");
  });
});