import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOCAL_CONTROL_API_ACTOR } from "@simulatorlife/autodev-core";
import {
  materializeRuntimeFile,
  runtimeFileMatches,
  runtimeTarget
} from "@simulatorlife/autodev-runtime/platform/runtime-files";

import {
  codexSessionEndCapture,
  createMemorySessionEndHandler
} from "../../runtime/src/hooks/memory-session-end.ts";

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

test("materialized Codex hook reads its installed secret and posts to the loopback API", async () => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const codexHome = mkdtempSync(path.join(tmpdir(), "autodev-codex-hook-"));
  const transcriptPath = path.join(
    codexHome,
    "sessions",
    "2026",
    "10",
    "01",
    "session.jsonl"
  );
  mkdirSync(path.dirname(transcriptPath), { recursive: true });
  writeFileSync(transcriptPath, '{"private":"payload stays in source"}\n');
  writeFileSync(
    path.join(codexHome, ".env"),
    "AUTODEV_CONTROL_API_TOKEN=installed-local-token\n"
  );
  chmodSync(path.join(codexHome, ".env"), 0o600);

  let resolveObserved!: (value: {
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    body: string;
  }) => void;
  const observed = new Promise<{
    method: string | undefined;
    url: string | undefined;
    authorization: string | undefined;
    body: string;
  }>((resolve) => {
    resolveObserved = resolve;
  });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"captured":true}');
      resolveObserved({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
    });
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");

    const source = path.join(
      repositoryRoot,
      "runtime/src/hooks/memory-session-end.ts"
    );
    const installed = runtimeTarget(
      "runtime/src/hooks/memory-session-end.ts",
      codexHome
    );
    materializeRuntimeFile(source, installed, 0o755);
    assert.equal(runtimeFileMatches(source, installed), true);
    assert.equal(
      path.relative(codexHome, installed),
      "src/hooks/memory-session-end.ts"
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: codexHome,
      AUTODEV_CONTROL_API_LISTEN_PORT: String(address.port)
    };
    delete env.AUTODEV_CONTROL_API_TOKEN;
    const event = {
      ...validEvent,
      session_id: "installed-session-1",
      transcript_path: transcriptPath,
      cwd: path.dirname(codexHome)
    };
    const child = spawn(process.execPath, [installed], {
      env,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const childResult = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    child.stdin.end(JSON.stringify(event));
    const result = await childResult;
    assert.equal(result.signal, null);
    assert.equal(result.code, 0, stderr);
    assert.equal(stderr, "");

    let timeout: NodeJS.Timeout | undefined;
    const request = await Promise.race([
      observed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Installed hook did not reach Control API")),
          5000
        );
      })
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/control/memory/capture");
    assert.equal(request.authorization, "Bearer installed-local-token");
    assert.deepEqual(JSON.parse(request.body), {
      sessionId: event.session_id,
      transcriptPath,
      cwd: event.cwd
    });
    assert.doesNotMatch(request.body, /private payload stays in source/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(codexHome, { recursive: true, force: true });
  }
});
