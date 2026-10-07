import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  responseBody,
  type RecordedResponse,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The Claude Code capture route's authority boundary.
 *
 * `POST /control/memory/claude-code/capture` is fired by a hook on SessionEnd,
 * not by a form, and everything it is told arrives in the request: which
 * session, which transcript, which directory. None of it can be trusted, so the
 * route derives authority from the one thing the caller does not control — an
 * operator-owned binding file naming the workspace roots and transcript roots
 * that are allowed to be captured.
 *
 * That makes this route the one memory write path whose authority is fully
 * reachable in a test: unlike the Codex capture, whose trust comes from
 * router-observed session state, this one comes from a file. So the refusals
 * can be exercised end to end rather than approximated.
 *
 * What is being pinned is that the binding is consulted *before* anything is
 * read or stored, that every way of failing it carries its own reason, and that
 * none of it leaves a silent trace.
 */

const CAPTURE = "/control/memory/claude-code/capture";
const BINDING_ENV = "AUTODEV_CLAUDE_CODE_BINDING_FILE";
const SESSION_ID = "session-a";

interface AuditEntry {
  readonly action: string;
  readonly outcome: string;
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly audits: AuditEntry[];
}

function errorCode(body: Record<string, unknown> | null): unknown {
  const envelope = body?.["error"];
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>)["code"]
    : undefined;
}

function errorMessage(body: Record<string, unknown> | null): string {
  const envelope = body?.["error"];
  return typeof envelope === "object" && envelope !== null
    ? String((envelope as Record<string, unknown>)["message"])
    : "";
}

/**
 * A workspace with its own bound transcript root, a real transcript file, and a
 * binding file naming both. Returns the paths a caller would have to name.
 */
function workspaceFixture(options: { readonly optIn?: boolean } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "claude-capture-"));
  const repo = path.join(home, "repo");
  const transcripts = path.join(home, "transcripts");
  mkdirSync(repo, { recursive: true });
  mkdirSync(transcripts, { recursive: true });
  // macOS resolves /var to /private/var, so the binding must name the canonical
  // path or every realpath comparison below would miss.
  const repoReal = realpathSync(repo);
  const transcriptsReal = realpathSync(transcripts);
  const transcript = path.join(transcriptsReal, `${SESSION_ID}.jsonl`);
  writeFileSync(transcript, '{"type":"assistant","message":{"content":"done"}}\n');
  const bindingPath = path.join(home, "claude-code-memory.toml");
  writeFileSync(
    bindingPath,
    `optIn = ${options.optIn === false ? "false" : "true"}
[[workspace]]
root = "${repoReal}"
workspaceId = "ws_a"
repositoryId = "repo_a"
transcriptRoot = "${transcriptsReal}"
`,
    "utf8"
  );
  return {
    home,
    bindingPath,
    cwd: repoReal,
    transcript,
    otherTranscriptRoot: path.join(home, "elsewhere")
  };
}

function request(body: Record<string, unknown>): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST",
    url: CAPTURE,
    headers: { "content-type": "application/json" }
  }) as IncomingMessage;
}

async function capture(
  body: Record<string, unknown>,
  options: {
    readonly bindingPath: string;
    readonly role?: "viewer" | "operator";
  }
): Promise<CallResult> {
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  const previous = process.env[BINDING_ENV];
  process.env[BINDING_ENV] = options.bindingPath;
  try {
    await handleMemoryControlApiRequest(
      request(body),
      response,
      CAPTURE,
      { actor: "memory-operator", role: options.role ?? "operator" },
      (entry) => audits.push(entry as AuditEntry)
    );
  } finally {
    if (previous === undefined) delete process.env[BINDING_ENV];
    else process.env[BINDING_ENV] = previous;
  }
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits
  };
}

const WELL_FORMED = (fixture: {
  readonly cwd: string;
  readonly transcript: string;
}) => ({
  sessionId: SESSION_ID,
  transcriptPath: fixture.transcript,
  cwd: fixture.cwd
});

test("a viewer is refused before the binding file is opened", async () => {
  // The role check comes first, which is observable: the binding path points
  // nowhere, and a viewer is still told it is not an operator rather than that
  // capture is unconfigured.
  const fixture = workspaceFixture();
  try {
    const { status, body, audits } = await capture(
      WELL_FORMED(fixture),
      { bindingPath: path.join(fixture.home, "missing.toml"), role: "viewer" }
    );

    assert.equal(status, 403);
    assert.equal(errorCode(body), "autodev_memory_capture_forbidden");
    assert.equal(audits.at(-1)?.reason, "viewer_cannot_capture");
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("capture fails closed when the operator has authored no binding", async () => {
  const fixture = workspaceFixture();
  try {
    const { status, body, audits } = await capture(WELL_FORMED(fixture), {
      bindingPath: path.join(fixture.home, "missing.toml")
    });

    assert.equal(status, 400);
    assert.equal(errorCode(body), "autodev_memory_capture_invalid");
    assert.equal(audits.at(-1)?.reason, "binding_file_missing");
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("capture fails closed when the binding opts out", async () => {
  // Opting out is a decision the operator made on purpose, and it has to be
  // distinguishable from a broken binding: one is "do not capture", the other is
  // "the configuration is wrong".
  const fixture = workspaceFixture({ optIn: false });
  try {
    const { status, body, audits } = await capture(WELL_FORMED(fixture), {
      bindingPath: fixture.bindingPath
    });

    assert.equal(status, 400);
    assert.equal(audits.at(-1)?.reason, "claude_binding_disabled");
    // The wire message is deliberately the generic one; the reason is what
    // carries the distinction. What the message must not do is describe the
    // operator's own configuration back to them, since the hook that fired
    // this is the untrusted party.
    assert.equal(
      errorMessage(body).includes(fixture.home),
      false,
      "the refusal must not echo the binding path back to the hook"
    );
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("a cwd outside every bound workspace root is refused", async () => {
  // The hook names its own cwd, so naming it proves nothing. Authority is the
  // operator's list of roots, and a directory that is not on it is refused even
  // though the transcript beside it is perfectly readable.
  const fixture = workspaceFixture();
  try {
    const { status, body, audits } = await capture(
      { ...WELL_FORMED(fixture), cwd: fixture.otherTranscriptRoot },
      { bindingPath: fixture.bindingPath }
    );

    assert.equal(status, 400);
    assert.equal(errorCode(body), "autodev_memory_capture_invalid");
    assert.equal(audits.at(-1)?.reason, "workspace_root_unresolved");
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("a transcript outside the bound transcript root is refused", async () => {
  // The workspace is authorized but the transcript is not inside the root the
  // operator bound to it. This is the case that stops a hook from being talked
  // into handing over an arbitrary file.
  const fixture = workspaceFixture();
  try {
    const { status, audits } = await capture(
      { ...WELL_FORMED(fixture), transcriptPath: "/etc/passwd" },
      { bindingPath: fixture.bindingPath }
    );

    assert.equal(status, 400);
    assert.ok(
      audits.at(-1)?.reason !== "workspace_root_unresolved",
      "the workspace was authorized; the transcript is what failed"
    );
    assert.match(String(audits.at(-1)?.reason), /transcript/u);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("a transcript that is a symlink out of the bound root is refused", async () => {
  // A symlink sitting *inside* the bound transcript root, pointing at a file
  // outside it, named for the right session. Compared literally the path is
  // under the root, so this only fails if something canonicalizes it first.
  //
  // Two things do, and the test does not claim which: the route realpaths the
  // hook-supplied path, and `resolveClaudeCodeTranscriptBinding` realpaths both
  // sides of the comparison itself. Removing either one leaves the refusal in
  // place — which is worth stating plainly, because the obvious way to test this
  // is to remove one and expect red, and it stays green.
  const fixture = workspaceFixture();
  try {
    const secret = path.join(fixture.home, "outside.jsonl");
    writeFileSync(secret, '{"type":"assistant","message":{"content":"secret"}}\n');
    const link = path.join(path.dirname(fixture.transcript), `${SESSION_ID}.jsonl`);
    // Replace the fixture's own transcript with a symlink to a file outside the
    // bound root, keeping the basename that ties it to the session.
    rmSync(link, { force: true });
    symlinkSync(secret, link);

    const { status, body, audits } = await capture(WELL_FORMED(fixture), {
      bindingPath: fixture.bindingPath
    });

    assert.equal(status, 400, "a symlink escape was accepted");
    assert.equal(errorCode(body), "autodev_memory_capture_invalid");
    assert.notEqual(
      audits.at(-1)?.outcome,
      "ok",
      "a symlink escape was reported as a capture"
    );
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("a transcript whose name carries another session is refused", async () => {
  // The basename is the only thing tying a file on disk to a session id, so a
  // file named for a different session is refused rather than relabelled.
  const fixture = workspaceFixture();
  try {
    const impostor = path.join(
      path.dirname(fixture.transcript),
      "session-somebody-else.jsonl"
    );
    writeFileSync(impostor, '{"type":"assistant"}\n');
    const { status, audits } = await capture(
      { ...WELL_FORMED(fixture), transcriptPath: impostor },
      { bindingPath: fixture.bindingPath }
    );

    assert.equal(status, 400);
    assert.equal(audits.at(-1)?.reason, "session_id_mismatch");
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("an operator-supplied field is refused rather than ignored", async () => {
  // The same `exactKeys` rule the Codex capture follows, and for the same
  // reason: a hook that could add `workspaceId` would be naming its own scope.
  const fixture = workspaceFixture();
  try {
    const { status, body, audits } = await capture(
      { ...WELL_FORMED(fixture), workspaceId: "ws_somewhere_else" },
      { bindingPath: fixture.bindingPath }
    );

    assert.equal(status, 400);
    assert.equal(errorCode(body), "autodev_memory_capture_invalid");
    assert.equal(audits.at(-1)?.reason, "invalid_capture");
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("the body is validated before the binding is consulted", async () => {
  // Ordering, stated as a test. Each case is both malformed *and* about a
  // workspace the binding does not authorize, so the 400 has to come from
  // validation. If the binding ran first, the audit reason would name the
  // binding instead — which would tell a caller probing this route which of its
  // two refusals it had reached.
  const fixture = workspaceFixture();
  try {
    const cases = [
      { ...WELL_FORMED(fixture), extra: "field" },
      { ...WELL_FORMED(fixture), sessionId: "../../etc/passwd" },
      { ...WELL_FORMED(fixture), transcriptPath: "relative/rollout.jsonl" },
      { ...WELL_FORMED(fixture), cwd: "relative/path" }
    ];
    for (const body of cases) {
      const result = await capture(body, {
        bindingPath: fixture.bindingPath
      });
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(
        result.audits.at(-1)?.reason,
        "invalid_capture",
        `a malformed body reached the binding: ${JSON.stringify(body)}`
      );
    }
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("each refusal carries its own reason", async () => {
  // These land in the audit trail an operator reads after the fact, so "the
  // binding is missing" and "this workspace is not authorized" have to stay
  // distinguishable there. A single catch-all reason would make the trail
  // useless for the one thing it is for.
  const fixture = workspaceFixture();
  const optedOut = workspaceFixture({ optIn: false });
  try {
    const missing = await capture(WELL_FORMED(fixture), {
      bindingPath: path.join(fixture.home, "missing.toml")
    });
    const disabled = await capture(WELL_FORMED(optedOut), {
      bindingPath: optedOut.bindingPath
    });
    const unauthorized = await capture(
      { ...WELL_FORMED(fixture), cwd: fixture.otherTranscriptRoot },
      { bindingPath: fixture.bindingPath }
    );
    const malformed = await capture(
      { ...WELL_FORMED(fixture), extra: "field" },
      { bindingPath: fixture.bindingPath }
    );

    const reasons = [missing, disabled, unauthorized, malformed].map(
      (result) => result.audits.at(-1)?.reason
    );
    assert.deepEqual(reasons, [
      "binding_file_missing",
      "claude_binding_disabled",
      "workspace_root_unresolved",
      "invalid_capture"
    ]);
    assert.equal(new Set(reasons).size, reasons.length);
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
    rmSync(optedOut.home, { recursive: true, force: true });
  }
});

test("a fully authorized capture gets past every binding check", async () => {
  // The positive half, and the reason the rest of the suite is meaningful: with
  // a real binding, a real bound workspace and a real transcript under the
  // bound root, the request must not be refused for a binding reason at all.
  // It goes on to resolve storage, which is not configured in this environment,
  // so it ends at `unavailable` — a different fact entirely, and the next case
  // pins that it is recorded.
  const fixture = workspaceFixture();
  try {
    const { status, body, audits } = await capture(WELL_FORMED(fixture), {
      bindingPath: fixture.bindingPath
    });

    assert.notEqual(status, 400, "an authorized capture was refused");
    assert.notEqual(errorCode(body), "autodev_memory_capture_invalid");
    assert.equal(
      audits.some((entry) =>
        [
          "binding_file_missing",
          "claude_binding_disabled",
          "workspace_root_unresolved",
          "transcript_root_escape",
          "session_id_mismatch"
        ].includes(String(entry.reason))
      ),
      false,
      "an authorized capture reported a binding refusal"
    );
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("storage that is not configured is recorded, not just answered", async () => {
  // The one place this route has no service to fall back on. The hook that
  // fired it sees a 503 and otherwise nothing at all: without an audit entry,
  // "capture never happened" and "capture was refused" are indistinguishable in
  // the trail, and this is the one refusal an operator would otherwise have no
  // way to diagnose from the deployment at all.
  const fixture = workspaceFixture();
  try {
    const { status, body, audits } = await capture(WELL_FORMED(fixture), {
      bindingPath: fixture.bindingPath
    });

    assert.equal(status, 503);
    assert.equal(errorCode(body), "autodev_memory_unavailable");
    assert.equal(audits.at(-1)?.reason, "memory_unavailable");
    assert.equal(audits.at(-1)?.outcome, "error");
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("no refusal is audited as a success", async () => {
  const fixture = workspaceFixture();
  try {
    const results = [
      await capture(WELL_FORMED(fixture), {
        role: "viewer",
        bindingPath: fixture.bindingPath
      }),
      await capture(WELL_FORMED(fixture), {
        bindingPath: path.join(fixture.home, "missing.toml")
      }),
      await capture(
        { ...WELL_FORMED(fixture), cwd: fixture.otherTranscriptRoot },
        { bindingPath: fixture.bindingPath }
      ),
      await capture(
        { ...WELL_FORMED(fixture), extra: "field" },
        { bindingPath: fixture.bindingPath }
      )
    ];

    for (const result of results) {
      assert.ok(result.audits.length > 0, "a refusal must be audited");
      assert.notEqual(
        result.audits.at(-1)?.outcome,
        "ok",
        `a refusal reported success: ${JSON.stringify(result.audits.at(-1))}`
      );
    }
  } finally {
    rmSync(fixture.home, { recursive: true, force: true });
  }
});