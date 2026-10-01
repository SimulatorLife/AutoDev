import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_CONTROL_API_ACTOR } from "@simulatorlife/autodev-core";

import {
  codexSessionEndCapture,
  createMemorySessionEndHandler
} from "../../src/hooks/memory-session-end.ts";

const validEvent = {
  hook_event_name: "SessionEnd",
  session_id: "codex-session-1",
  transcript_path: "/tmp/codex/sessions/2026/10/01/transcript.jsonl",
  cwd: "/workspace/repo",
  reason: "completed"
};

test("Codex SessionEnd capture accepts only bounded session identity and local paths", () => {
  assert.deepEqual(codexSessionEndCapture(validEvent), {
    sessionId: "codex-session-1",
    transcriptPath: validEvent.transcript_path,
    cwd: validEvent.cwd
  });
  assert.equal(
    codexSessionEndCapture({ ...validEvent, hook_event_name: "SessionStart" }),
    null
  );
  assert.equal(
    codexSessionEndCapture({
      ...validEvent,
      transcript_path: "https://example.test/transcript"
    }),
    null
  );
  assert.equal(
    codexSessionEndCapture({ ...validEvent, session_id: "../outside" }),
    null
  );
});

test("SessionEnd forwards references only to the local authenticated Memory Control API", async () => {
  const observed: { request: { url: string; init: RequestInit } | null } = {
    request: null
  };
  const run = createMemorySessionEndHandler({
    env: {
      CODEX_HOME: "/tmp/codex",
      AUTODEV_CONTROL_API_LISTEN_PORT: "4201"
    },
    readToken: () => "local-service-token",
    fetchImpl: async (url, init) => {
      observed.request = { url: String(url), init: init ?? {} };
      return new Response(null, { status: 200 });
    }
  });

  assert.equal(await run(JSON.stringify(validEvent)), 0);
  const request = observed.request;
  assert.ok(request);
  assert.equal(request.url, "http://127.0.0.1:4201/control/memory/capture");
  assert.equal(request.init.method, "POST");
  const headers = new Headers(request.init.headers);
  assert.equal(headers.get("authorization"), "Bearer local-service-token");
  assert.equal(headers.get("x-autodev-actor"), LOCAL_CONTROL_API_ACTOR);
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    sessionId: validEvent.session_id,
    transcriptPath: validEvent.transcript_path,
    cwd: validEvent.cwd
  });
});

test("SessionEnd capture fails open when secrets or the control API are unavailable", async () => {
  let calls = 0;
  const missingToken = createMemorySessionEndHandler({
    env: { CODEX_HOME: "/tmp/codex" },
    readToken: () => null,
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    }
  });
  assert.equal(await missingToken(JSON.stringify(validEvent)), 0);
  assert.equal(calls, 0);

  const unavailable = createMemorySessionEndHandler({
    env: { CODEX_HOME: "/tmp/codex" },
    readToken: () => "token",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("unreachable");
    }
  });
  assert.equal(await unavailable(JSON.stringify(validEvent)), 0);
  assert.equal(calls, 1);
});
