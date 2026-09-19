import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setRouterAuthTokenForTests } from "../../src/router/auth.ts";
import {
  handleRequest,
  ingestAgentEvents,
  loadCatalog,
  requestSession,
  workspaceContextFromRequest,
  workspaceMetadataForSession
} from "../../src/router/http.ts";
import {
  getWorkspaceMetadata,
  noteBridgeRequest,
  rememberWorkspaceMetadata,
  resetSubagentTelemetry
} from "../../src/router/subagents.ts";

class FakeRequest extends EventTarget {
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  private readonly body: Buffer;
  complete = true;

  constructor(method: string, url: string, body: unknown = "") {
    super();
    this.method = method;
    this.url = url;
    this.headers = { host: "127.0.0.1" };
    this.socket = { remoteAddress: "127.0.0.1" };
    this.body = Buffer.from(
      typeof body === "string" ? body : JSON.stringify(body)
    );
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    if (this.body.length > 0) yield this.body;
  }
}

function responseRecorder(): any {
  const chunks: Buffer[] = [];
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    closed: false,
    writeHead(status: number, headers: Record<string, string>) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.body = Buffer.concat(chunks).toString("utf8");
      this.writableEnded = true;
    },
    on() {
      return this;
    },
    removeListener() {
      return this;
    }
  };
}

test("workspace and session resolution prefer explicit continuity metadata", () => {
  const workspace = workspaceContextFromRequest(
    { headers: {} },
    {},
    JSON.stringify({
      workspaces: {
        "/Users/henrykirk/AutoDev": {
          workspace_id: "workspace-123",
          associated_remote_urls: { origin: "git@github.com:Owner/Repo.git" }
        }
      }
    })
  );
  assert.deepEqual(workspace, {
    key: "Owner/Repo",
    cwd: "AutoDev",
    workspace_id: "workspace-123"
  });

  const session = requestSession(
    { headers: { "x-codex-session-id": " session-7 " } } as any,
    {}
  );
  assert.deepEqual(session, {
    key: "session-7",
    scope: "identified",
    thread: null
  });
  assert.equal(
    requestSession({ headers: {} } as any, {}).scope,
    "process-fallback"
  );
});

test("catalog loading returns the public models/data envelope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autodev-router-http-"));
  const file = join(directory, "catalog.json");
  await writeFile(
    file,
    JSON.stringify({ models: [{ slug: "sonnet" }, { slug: "MiniMax-M3" }] })
  );
  const catalog = await loadCatalog(file);
  assert.deepEqual(catalog.models, [
    { slug: "sonnet" },
    { slug: "MiniMax-M3" }
  ]);
  assert.equal(catalog.data.length, 2);
  assert.equal((catalog.data[0] as any).id, "sonnet");
});

test("HTTP endpoint routing keeps health, status, models, provider, and response contracts", async () => {
  const previousAuthToken = process.env.CODEX_ROUTER_AUTH_TOKEN;
  setRouterAuthTokenForTests("");
  try {
    const healthResponse = responseRecorder();
    await handleRequest(
      new FakeRequest("GET", "/health") as any,
      healthResponse
    );
    assert.equal(healthResponse.statusCode, 200);
    assert.deepEqual(JSON.parse(healthResponse.body), {
      status: "ok",
      router: "codex-model-router"
    });

    const statusResponse = responseRecorder();
    await handleRequest(
      new FakeRequest("GET", "/status") as any,
      statusResponse
    );
    assert.equal(statusResponse.statusCode, 200);
    assert.equal(
      JSON.parse(statusResponse.body).schema,
      "autodev-router-status-v2"
    );

    const providerResponse = responseRecorder();
    await handleRequest(
      new FakeRequest("POST", "/v1/providers/not-a-provider", {}) as any,
      providerResponse
    );
    assert.equal(providerResponse.statusCode, 404);
    assert.equal(
      JSON.parse(providerResponse.body).error.code,
      "router_unknown_provider"
    );

    const responseResponse = responseRecorder();
    await handleRequest(
      new FakeRequest("POST", "/v1/responses", {}) as any,
      responseResponse
    );
    assert.equal(responseResponse.statusCode, 400);
    assert.match(
      JSON.parse(responseResponse.body).error.message,
      /requires a non-empty string model/
    );
  } finally {
    setRouterAuthTokenForTests(previousAuthToken ?? "");
  }
});

test("agent event ingestion accepts activity only for a router-owned request", () => {
  resetSubagentTelemetry();
  noteBridgeRequest("http-request", {
    activitySubject: `req:${"http-request"}`,
    provider: "claude",
    model: "sonnet",
    role: "worker",
    workspace: "Owner/Repo",
    sessionKey: "http-session"
  });
  assert.deepEqual(
    ingestAgentEvents({
      requestId: "http-request",
      events: [{ type: "activity", state: "heartbeat" }]
    }),
    { accepted: 1, closed: 0, unavailable: 0, rejected: 0, reason: null }
  );
  assert.equal(
    ingestAgentEvents({ requestId: "unknown", events: [] }).reason,
    "unknown_request_id"
  );
});

test("canonical Codex session-id header identifies metadata-less continuation and restores remembered workspace", () => {
  // Repro of the RacingGame compaction failure: Codex 0.154.0+ sends the
  // canonical `session-id` header on every request. Before the fix the
  // resolver ignored that header and the request collapsed to the
  // process-wide fallback session, so workspaceMetadataForSession never
  // restored the previously-remembered workspace and the bridge received
  // `workspace=unknown/cwd=null`.
  resetSubagentTelemetry();
  const sessionKey = "01a0ba14-d54c-78f2-9367-3f80e9a8f75f";
  const remembered = "/Users/henrykirk/Desktop/RacingGame";
  rememberWorkspaceMetadata(sessionKey, remembered);
  try {
    // Metadata-less compaction/continuation: no legacy alias headers,
    // no payload workspace, no turn-metadata header.
    const canonicalRequest = { headers: { "session-id": ` ${sessionKey} ` } };
    const session = requestSession(canonicalRequest as any, {});
    assert.deepEqual(session, {
      key: sessionKey,
      scope: "identified",
      thread: null
    });

    // Sanity: the same canonical-header-only request was previously returning
    // the process-wide fallback key. Without the fix this assertion would
    // fail (the lookup returns null), which is the exact regression.
    assert.ok(getWorkspaceMetadata(session.key));

    // workspaceMetadataForSession must now restore the remembered workspace
    // turn-metadata so the bridge downstream sees workspace metadata again.
    const restored = workspaceMetadataForSession({}, null, session);
    assert.ok(restored, "expected a restored turn-metadata header");
    const parsed = JSON.parse(restored!);
    assert.ok(parsed.workspaces, "expected turn-metadata to carry workspaces");
    assert.ok(
      Object.hasOwn(parsed.workspaces, remembered),
      `expected remembered path ${remembered} in restored turn-metadata, got ${JSON.stringify(
        parsed.workspaces
      )}`
    );

    // The pre-fix behavior must still hold: a request that omits every
    // session-id signal falls back to the process-wide bucket and never
    // fan-outs into another session's remembered workspace.
    const anonymous = requestSession({ headers: {} } as any, {});
    assert.equal(anonymous.scope, "process-fallback");
    assert.equal(workspaceMetadataForSession({}, null, anonymous), null);
  } finally {
    resetSubagentTelemetry();
  }
});
