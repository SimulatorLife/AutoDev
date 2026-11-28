import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureLocalAdmission } from "@simulatorlife/autodev-runtime/mcp/gateway-admission";
import { setRouterAuthTokenForTests } from "@simulatorlife/autodev-runtime/router/auth";
import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";
import {
  handleRequest,
  loadCatalog,
  requestSession,
  workspaceContextFromRequest
} from "@simulatorlife/autodev-runtime/router/http";
import type { RoutingPolicy } from "@simulatorlife/autodev-runtime/router/routing";
import { didHandleAcpRoute } from "@simulatorlife/autodev-runtime/xacpx/http";
import { XacpxSessionManager } from "@simulatorlife/autodev-runtime/xacpx/manager";

// ACP launches sign their sessions' gateway grants: give the test process's
// isolated CODEX_HOME the gateway's admission files.
ensureLocalAdmission(process.env.CODEX_HOME!);

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

  // The request lifecycle listeners the router registers on a real request.
  once(_event: string, _listener: (...arguments_: unknown[]) => void): this {
    return this;
  }

  removeListener(
    _event: string,
    _listener: (...arguments_: unknown[]) => void
  ): this {
    return this;
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
    once() {
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
    thread: null,
    clientSurface: null,
    sessionId: "session-7"
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
    JSON.stringify({
      models: [{ slug: "sonnet" }, { slug: "MiniMax-test-model" }]
    })
  );
  const catalog = await loadCatalog(file);
  assert.deepEqual(catalog.models, [
    { slug: "sonnet" },
    { slug: "MiniMax-test-model" }
  ]);
  assert.equal(catalog.data.length, 2);
  assert.equal((catalog.data[0] as any).id, "sonnet");
});

test("HTTP endpoint routing keeps health, status, models, control, and response contracts", async () => {
  const previousAuthToken = process.env.CODEX_ROUTER_AUTH_TOKEN;
  const previousControlToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousControlViewers = process.env.AUTODEV_CONTROL_VIEWERS;
  const previousControlOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN =
    "http-control-test-token-0123456789abcdef";
  process.env.AUTODEV_CONTROL_VIEWERS = "http-viewer";
  process.env.AUTODEV_CONTROL_OPERATORS = "http-operator";
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

    const providerRequest = new FakeRequest("GET", "/control/providers");
    providerRequest.headers.authorization =
      "Bearer http-control-test-token-0123456789abcdef";
    providerRequest.headers["x-autodev-actor"] = "http-viewer";
    const providerResponse = responseRecorder();
    await handleRequest(providerRequest as any, providerResponse);
    assert.equal(providerResponse.statusCode, 200);
    const providerBody = JSON.parse(providerResponse.body);
    assert.equal(providerBody.schema, "autodev-control-providers-v5");
    // The router registers its live provider evidence with the Control API.
    for (const provider of providerBody.providers) {
      if (provider.route === null) continue;
      assert.equal(typeof provider.health?.inFlightRequests, "number");
      assert.equal(typeof provider.health?.failureStreak, "number");
    }

    const retiredResponses = responseRecorder();
    await handleRequest(
      new FakeRequest("POST", "/v1/responses", {}) as any,
      retiredResponses
    );
    assert.equal(retiredResponses.statusCode, 404);

    const acpResponse = responseRecorder();
    await handleRequest(
      new FakeRequest("POST", "/v1/acp/sessions", {}) as any,
      acpResponse
    );
    assert.equal(acpResponse.statusCode, 400);
    assert.match(
      JSON.parse(acpResponse.body).error,
      /Fields `role`, `cwd`, and `promptOrTask` are required/
    );
  } finally {
    setRouterAuthTokenForTests(previousAuthToken ?? "");
    if (previousControlToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousControlToken;
    if (previousControlViewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = previousControlViewers;
    if (previousControlOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousControlOperators;
  }
});

test(
  "an ACP session whose pinned provider is under a hard cooldown makes no upstream launch",
  { concurrency: false },
  async () => {
    COOLDOWNS.clearAll();
    let calls = 0;
    const manager = new XacpxSessionManager({
      policy: {
        roleCandidates: () => [
          { provider: "claude", model: "sonnet", reasoningEffort: null }
        ],
        orchestratorCandidates: () => [],
        providerReachesRoleMcp: () => true
      } as unknown as RoutingPolicy,
      acpTransportFactory: async () => {
        calls += 1;
        throw new Error("should not launch ACP while provider is cooling down");
      }
    });
    manager.planDispatch({
      sessionId: "cooled-session-1",
      role: "worker",
      cwd: process.cwd(),
      systemPrompt: "",
      promptOrTask: "initial"
    });
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    try {
      COOLDOWNS.cooldownProvider("claude", {
        failureClass: "quota_exhausted",
        resetsAt,
        structured: true
      });
      const response = responseRecorder();
      const handled = await didHandleAcpRoute(
        new FakeRequest("POST", "/v1/acp/sessions", {
          sessionId: "cooled-session-1",
          role: "worker",
          cwd: process.cwd(),
          promptOrTask: "follow-up"
        }) as any,
        response,
        "/v1/acp/sessions",
        manager
      );
      assert.equal(handled, true);
      assert.equal(calls, 0);
      assert.equal(response.statusCode, 400);
      const body = JSON.parse(response.body);
      assert.match(body.error, /Pinned provider 'claude' is cooling down/i);
    } finally {
      COOLDOWNS.clearAll();
    }
  }
);
