import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createMemorySessionEndHandler,
  sessionEndCapture
} from "../src/hooks/memory-session-end.ts";

/**
 * The Codex session-end hook, which runs in the ended session's own process and
 * had 14% function coverage.
 *
 * Two boundaries live in here and neither was tested. The first is a *file
 * read*: the hook takes a transcript path from its stdin payload and asks the
 * Runtime to read that file, so a payload naming an arbitrary absolute path
 * would turn a memory hook into an arbitrary-file reader. `isTranscriptPathAllowed`
 * is the only thing standing there. The second is a *credential read*: with no
 * token in the environment the hook goes looking through `~/.codex` and
 * `~/.claude` for one, so which file it reads first — and what it accepts out
 * of it — decides whose credential it uses.
 *
 * The hook's contract is to fail open and quietly, which is exactly what makes
 * it hard to test: a capture that silently declines is indistinguishable from
 * one that works. So every test below asserts on the request that was *not*
 * made as carefully as the one that was.
 */

const TOKEN = "t".repeat(64);

interface Request {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Run the hook against a payload and report what it posted.
 *
 * `env` is passed through the dependency seam rather than assigned to
 * `process.env`, so the real credential-file reader runs against a real temp
 * directory without touching the machine's own.
 */
async function capture(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly payload?: unknown;
  readonly raw?: string;
}): Promise<{ readonly requests: readonly Request[]; readonly code: number }> {
  const requests: Request[] = [];
  const handler = createMemorySessionEndHandler({
    env: options.env,
    fetchImpl: (async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch
  });
  const code = await handler(options.raw ?? JSON.stringify(options.payload));
  return { requests, code };
}

/** A payload that passes every check, so a test can break exactly one field. */
function sessionEndPayload(
  transcriptPath: string,
  cwd: string
): Record<string, unknown> {
  return {
    hook_event_name: "SessionEnd",
    session_id: "session-hook-1",
    transcript_path: transcriptPath,
    cwd
  };
}

/**
 * Run a body against a throwaway HOME, removing it only once the body has
 * actually finished.
 *
 * `async` on purpose: a plain function returning `run(dir)` would run its
 * `finally` as soon as the body's promise was *created*, deleting the
 * credential files while the first test was still awaiting. Every assertion
 * that survived was surviving on the synchronous part of the call.
 */
async function withTempHome<T>(
  run: (dir: string) => T | Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "autodev-session-end-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a well-formed SessionEnd payload yields the identifiers the capture API needs", () => {
  const captureValue = sessionEndCapture(
    sessionEndPayload("/codex/sessions/rollout.jsonl", "/repo/app"),
    { CODEX_HOME: "/codex" } as NodeJS.ProcessEnv
  );

  assert.ok(captureValue !== null);
  assert.equal(captureValue.sessionId, "session-hook-1");
  assert.equal(captureValue.transcriptPath, "/codex/sessions/rollout.jsonl");
  assert.equal(captureValue.cwd, "/repo/app");
  assert.equal(captureValue.provider, "codex");
});

test("only a SessionEnd event is a capture", () => {
  for (const hookEventName of ["SessionStart", "PreToolUse", "", "sessionend"]) {
    assert.equal(
      sessionEndCapture(
        { ...sessionEndPayload("/codex/sessions/a.jsonl", "/repo"), hook_event_name: hookEventName },
        {} as NodeJS.ProcessEnv
      ),
      null,
      `${JSON.stringify(hookEventName)} must not be treated as a session end`
    );
  }
  for (const value of [null, undefined, "string", 42, ["array"]]) {
    assert.equal(sessionEndCapture(value, {} as NodeJS.ProcessEnv), null);
  }
});

test("a session id outside the pattern is refused", () => {
  // The id ends up in a URL path and a database key, so the bound is a
  // character class and not merely a length.
  for (const sessionId of [
    "",
    "a".repeat(129),
    "has space",
    "has/slash",
    "has\\backslash",
    "has space",
    "quote\"injection",
    42,
    null
  ]) {
    assert.equal(
      sessionEndCapture(
        { ...sessionEndPayload("/codex/sessions/a.jsonl", "/repo"), session_id: sessionId },
        {} as NodeJS.ProcessEnv
      ),
      null,
      `session id ${JSON.stringify(sessionId)} must be refused`
    );
  }
});

test("a transcript path that is not an absolute, bounded path is refused", () => {
  const base = sessionEndPayload("/codex/sessions/a.jsonl", "/repo/app");
  for (const transcriptPath of [
    "relative/rollout.jsonl",
    "./rollout.jsonl",
    "/codex/sessions/" + "a".repeat(4096),
    42,
    null
  ]) {
    assert.equal(
      sessionEndCapture({ ...base, transcript_path: transcriptPath }, {} as NodeJS.ProcessEnv),
      null,
      `transcript path ${JSON.stringify(transcriptPath)} must be refused`
    );
  }
  // The cwd is held to the same rule; it names a repository root later.
  for (const cwd of ["relative/dir", "/" + "a".repeat(4096), null]) {
    assert.equal(
      sessionEndCapture({ ...base, cwd }, {} as NodeJS.ProcessEnv),
      null,
      `cwd ${JSON.stringify(cwd)} must be refused`
    );
  }
});

test("the provider is operator-controlled, and the payload cannot choose it", () => {
  const base = sessionEndPayload("/codex/sessions/a.jsonl", "/repo/app");

  assert.equal(
    sessionEndCapture(base, { AUTODEV_MEMORY_HOOK_PROVIDER: "claude-code" } as NodeJS.ProcessEnv)
      ?.provider,
    "claude-code"
  );
  // Anything else falls back to Codex rather than erroring: a typo in the
  // operator's env must not silently route a Claude Code session elsewhere.
  for (const value of ["codex", "Claude-Code", "", "claude_code"]) {
    assert.equal(
      sessionEndCapture(base, { AUTODEV_MEMORY_HOOK_PROVIDER: value } as NodeJS.ProcessEnv)
        ?.provider,
      "codex",
      `${JSON.stringify(value)} must not select a provider`
    );
  }
  // A provider named by the payload is not read at all.
  assert.equal(
    sessionEndCapture({ ...base, provider: "claude-code" }, {} as NodeJS.ProcessEnv)?.provider,
    "codex",
    "the payload's own provider field must be ignored"
  );
});

test("a Codex transcript inside CODEX_HOME/sessions is captured", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    const transcriptPath = join(codexHome, "sessions", "2026", "rollout.jsonl");
    mkdirSync(join(transcriptPath, ".."), { recursive: true });
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      `AUTODEV_CONTROL_API_TOKEN=${TOKEN}\n`
    );

    const { requests, code } = await capture({
      env: { HOME: home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(transcriptPath, join(home, "repo"))
    });

    assert.equal(code, 0);
    assert.equal(requests.length, 1, "the capture must actually be posted");
    assert.equal(requests[0]?.url, "http://127.0.0.1:4101/control/memory/capture");
  });
});

test("a Codex transcript outside CODEX_HOME/sessions is never posted", async () => {
  // The boundary. The payload is untrusted input and it names a file the
  // Runtime will read; only a transcript inside the Codex sessions directory
  // may be requested.
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      `AUTODEV_CONTROL_API_TOKEN=${TOKEN}\n`
    );

    for (const transcriptPath of [
      join(home, "etc", "passwd"),
      "/etc/passwd",
      // A sibling whose name merely starts with the sessions directory.
      join(codexHome, "sessions-evil", "rollout.jsonl"),
      // Climbing out of the sessions directory from inside it.
      join(codexHome, "sessions", "..", "..", "..", "etc", "passwd"),
      codexHome
    ]) {
      const { requests } = await capture({
        env: { HOME: home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        payload: sessionEndPayload(transcriptPath, join(home, "repo"))
      });

      assert.equal(
        requests.length,
        0,
        `${transcriptPath} must not be requested from the Runtime`
      );
    }
  });
});

test("CODEX_HOME defaults to ~/.codex when unset", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    writeFileSync(
      join(codexHome, "openlit-secrets.env"),
      `AUTODEV_CONTROL_API_TOKEN=${TOKEN}\n`
    );

    const inside = await capture({
      env: { HOME: home, AUTODEV_CONTROL_API_TOKEN: TOKEN } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(join(codexHome, "sessions", "r.jsonl"), home)
    });
    assert.equal(inside.requests.length, 1, "the default CODEX_HOME must be honoured");

    const outside = await capture({
      env: { HOME: home, AUTODEV_CONTROL_API_TOKEN: TOKEN } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(join(home, "elsewhere", "r.jsonl"), home)
    });
    assert.equal(outside.requests.length, 0);
  });
});

test("a Claude Code capture is routed to its own endpoint and skips the allowlist", async () => {
  // Deliberate asymmetry, and worth pinning rather than guessing at: the Codex
  // path is constrained to its sessions directory because Codex writes
  // transcripts there, while a Claude Code capture accepts any absolute path.
  // If that ever stops being true this is the test that notices.
  await withTempHome(async (home) => {
    const { requests } = await capture({
      env: {
        HOME: home,
        AUTODEV_CONTROL_API_TOKEN: TOKEN,
        AUTODEV_MEMORY_HOOK_PROVIDER: "claude-code"
      } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(join(home, "projects", "session.jsonl"), join(home, "repo"))
    });

    assert.equal(requests.length, 1);
    assert.equal(
      requests[0]?.url,
      "http://127.0.0.1:4101/control/memory/claude-code/capture"
    );
  });
});

test("the capture posts only the three fields the API reads", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    const transcriptPath = join(codexHome, "sessions", "r.jsonl");
    const cwd = join(home, "repo");

    const { requests } = await capture({
      env: { HOME: home, AUTODEV_CONTROL_API_TOKEN: TOKEN, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      payload: { ...sessionEndPayload(transcriptPath, cwd), extra: "must not be forwarded" }
    });

    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["cwd", "sessionId", "transcriptPath"]);
    const init = requests[0]?.init;
    assert.equal(init?.method, "POST");
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(headers["X-AutoDev-Actor"], "autodev-local");
    // The whole payload must not ride along in a header.
    assert.equal(headers["X-AutoDev-Session"], undefined);
  });
});

test("the environment token wins over any credential file", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    writeFileSync(join(codexHome, "openlit-secrets.env"), `AUTODEV_CONTROL_API_TOKEN=file-token\n`);

    const { requests } = await capture({
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        AUTODEV_CONTROL_API_TOKEN: TOKEN
      } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(join(codexHome, "sessions", "r.jsonl"), join(home, "repo"))
    });

    const headers = requests[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  });
});

test("a credential file is read in the order the active provider implies", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    const claudeHome = join(home, ".claude");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    writeFileSync(join(codexHome, "openlit-secrets.env"), `AUTODEV_CONTROL_API_TOKEN=codex-token\n`);
    writeFileSync(join(claudeHome, "openlit-secrets.env"), `AUTODEV_CONTROL_API_TOKEN=claude-token\n`);

    const asCodex = await capture({
      env: { HOME: home, CODEX_HOME: codexHome, CLAUDE_HOME: claudeHome } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(join(codexHome, "sessions", "r.jsonl"), join(home, "repo"))
    });
    assert.equal(
      (asCodex.requests[0]?.init.headers as Record<string, string>).Authorization,
      "Bearer codex-token"
    );

    const asClaude = await capture({
      env: {
        HOME: home,
        CODEX_HOME: codexHome,
        CLAUDE_HOME: claudeHome,
        AUTODEV_MEMORY_HOOK_PROVIDER: "claude-code"
      } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(join(claudeHome, "projects", "r.jsonl"), join(home, "repo"))
    });
    assert.equal(
      (asClaude.requests[0]?.init.headers as Record<string, string>).Authorization,
      "Bearer claude-token"
    );
  });
});

test("only a line that really carries a token counts as a credential", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    writeFileSync(
      join(codexHome, ".env"),
      [
        "# AUTODEV_CONTROL_API_TOKEN=commented-out",
        "OTHER=value",
        "AUTODEV_MCP_SERVER=x",
        "AUTODEV_CONTROL_API_TOKEN=",
        "export AUTODEV_CONTROL_API_TOKEN=",
        `export AUTODEV_CONTROL_API_TOKEN='${TOKEN}'`,
        ""
      ].join("\n")
    );

    const { requests } = await capture({
      env: { HOME: home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(join(codexHome, "sessions", "r.jsonl"), join(home, "repo"))
    });

    assert.equal(requests.length, 1, "the exported, quoted token must be found");
    assert.equal(
      (requests[0]?.init.headers as Record<string, string>).Authorization,
      `Bearer ${TOKEN}`
    );
  });
});

test("a torn quote in the credential file does not shadow a valid token", async () => {
  // `parseControlApiToken` used to read an unbalanced quote as a literal, so
  // `AUTODEV_CONTROL_API_TOKEN="` yielded the one-character credential `"` --
  // and `tokenFromFile` takes the first line that yields one, so a correct
  // token later in the same file was never read. It failed closed at the
  // Runtime rather than open, so nothing leaked; the cost was that an operator
  // whose token was correct got no captures and nothing to say why.
  //
  // Both orders are covered on purpose. "Torn line first" is the reported case;
  // "torn line last" is what rules out the tempting fix, because switching to
  // dotenv's last-wins would have fixed the first and broken the second.
  for (const [label, lines] of [
    ["torn line first", ['AUTODEV_CONTROL_API_TOKEN="', `AUTODEV_CONTROL_API_TOKEN=${TOKEN}`]],
    ["torn line last", [`AUTODEV_CONTROL_API_TOKEN=${TOKEN}`, 'AUTODEV_CONTROL_API_TOKEN="']],
    ["torn mid-value", ['AUTODEV_CONTROL_API_TOKEN="abc', `AUTODEV_CONTROL_API_TOKEN=${TOKEN}`]],
    ["mismatched quotes", [`AUTODEV_CONTROL_API_TOKEN="${TOKEN}'`]]
  ] as const) {
    await withTempHome(async (home) => {
      const codexHome = join(home, ".codex");
      mkdirSync(join(codexHome, "sessions"), { recursive: true });
      writeFileSync(join(codexHome, ".env"), [...lines, ""].join("\n"));

      const { requests } = await capture({
        env: { HOME: home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        payload: sessionEndPayload(
          join(codexHome, "sessions", "r.jsonl"),
          join(home, "repo")
        )
      });

      // The "mismatched quotes" case has no usable token anywhere, so the hook
      // posts nothing -- which is the point: it must not post a credential built
      // out of a stray quote character.
      assert.equal(
        requests.length,
        label === "mismatched quotes" ? 0 : 1,
        `${label}: the torn line must not become the credential`
      );
      if (requests.length > 0) {
        assert.equal(
          (requests[0]?.init.headers as Record<string, string>).Authorization,
          `Bearer ${TOKEN}`,
          `${label}: the well-formed token must be the one that is used`
        );
      }
    });
  }
});

test("a balanced quote is still stripped, in both quote styles", async () => {
  // The positive control for the rule above. Without it, "the torn quote is
  // skipped" and "quoting was never handled" are the same observation.
  for (const [label, line] of [
    ["double", `AUTODEV_CONTROL_API_TOKEN="${TOKEN}"`],
    ["single", `AUTODEV_CONTROL_API_TOKEN='${TOKEN}'`],
    ["bare", `AUTODEV_CONTROL_API_TOKEN=${TOKEN}`]
  ] as const) {
    await withTempHome(async (home) => {
      const codexHome = join(home, ".codex");
      mkdirSync(join(codexHome, "sessions"), { recursive: true });
      writeFileSync(join(codexHome, ".env"), `${line}\n`);

      const { requests } = await capture({
        env: { HOME: home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
        payload: sessionEndPayload(
          join(codexHome, "sessions", "r.jsonl"),
          join(home, "repo")
        )
      });

      assert.equal(requests.length, 1, `${label}: a well-formed token must be used`);
      assert.equal(
        (requests[0]?.init.headers as Record<string, string>).Authorization,
        `Bearer ${TOKEN}`,
        `${label}: the quotes must be stripped, not carried into the credential`
      );
    });
  }
});

test("with no credential anywhere the hook posts nothing and still succeeds", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });

    const { requests, code } = await capture({
      env: { HOME: home, CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      payload: sessionEndPayload(join(codexHome, "sessions", "r.jsonl"), join(home, "repo"))
    });

    assert.equal(requests.length, 0, "an unauthenticated capture must not be attempted");
    assert.equal(code, 0, "the ended session must not fail");
  });
});

test("the listen port comes from the environment and rejects anything else", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    const payload = sessionEndPayload(join(codexHome, "sessions", "r.jsonl"), join(home, "repo"));
    const base = { HOME: home, CODEX_HOME: codexHome, AUTODEV_CONTROL_API_TOKEN: TOKEN } as NodeJS.ProcessEnv;

    const custom = await capture({
      env: { ...base, AUTODEV_CONTROL_API_LISTEN_PORT: "5999" } as NodeJS.ProcessEnv,
      payload
    });
    assert.equal(custom.requests[0]?.url, "http://127.0.0.1:5999/control/memory/capture");

    for (const port of ["", "abc", "-1", "70000", "123456", "4101.5"]) {
      const fallback = await capture({
        env: { ...base, AUTODEV_CONTROL_API_LISTEN_PORT: port } as NodeJS.ProcessEnv,
        payload
      });
      assert.equal(
        fallback.requests[0]?.url,
        "http://127.0.0.1:4101/control/memory/capture",
        `port ${JSON.stringify(port)} must fall back to the default`
      );
    }
  });
});

test("input the hook cannot read is declined, and the session still succeeds", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      AUTODEV_CONTROL_API_TOKEN: TOKEN
    } as NodeJS.ProcessEnv;

    for (const raw of [
      "",
      "not json at all",
      JSON.stringify([1, 2, 3]),
      // Past the 64 KiB hook-input bound. Every other field is a *valid* capture,
      // and the transcript path really is inside this test's CODEX_HOME: an
      // oversized payload that was also malformed, or that pointed outside the
      // sessions directory, would be declined anyway and the bound would look
      // tested while never running.
      JSON.stringify({
        ...sessionEndPayload(
          join(codexHome, "sessions", "r.jsonl"),
          join(home, "repo")
        ),
        padding: "x".repeat(70 * 1024)
      })
    ]) {
      const { requests, code } = await capture({ env, raw });
      assert.equal(requests.length, 0, `${JSON.stringify(raw.slice(0, 24))} must not be posted`);
      assert.equal(code, 0);
    }
  });
});

test("a Runtime that cannot be reached is reported on stderr, never thrown", async () => {
  await withTempHome(async (home) => {
    const codexHome = join(home, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const handler = createMemorySessionEndHandler({
        env: {
          HOME: home,
          CODEX_HOME: codexHome,
          AUTODEV_CONTROL_API_TOKEN: TOKEN
        } as NodeJS.ProcessEnv,
        fetchImpl: (async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:4101");
        }) as typeof fetch
      });
      const code = await handler(
        JSON.stringify(
          sessionEndPayload(join(codexHome, "sessions", "r.jsonl"), join(home, "repo"))
        )
      );

      assert.equal(code, 0, "an unreachable Runtime must not fail the ended session");
      // Failing open still has to be visible: this hook's whole contract is to
      // succeed quietly, so a silent decline is indistinguishable from a
      // working capture.
      assert.ok(
        written.some((line) => line.includes("memory-session-end")),
        `expected a stderr diagnostic, got ${JSON.stringify(written)}`
      );
      assert.doesNotMatch(
        written.join("\n"),
        /ECONNREFUSED/u,
        "the raw error must not be copied into the diagnostic"
      );
    } finally {
      process.stderr.write = original;
    }
  });
});