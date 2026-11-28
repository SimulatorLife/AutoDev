import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse
} from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  type RouterGenerationEndpoint,
  RouterIngress,
  type RouterIngressEvent
} from "../src/router/ingress.ts";

async function worker(
  id: string,
  options: { ready?: boolean; token?: string } = {}
): Promise<{
  server: Server;
  endpoint: RouterGenerationEndpoint;
  finishStreams: () => void;
}> {
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    if (request.url === "/health/readiness") {
      response.writeHead(options.ready === false ? 503 : 200, {
        "content-type": "application/json"
      });
      response.end(
        JSON.stringify({
          status: options.ready === false ? "draining" : "ready",
          router: "codex-model-router",
          lifecycle: {
            state: options.ready === false ? "draining" : "ready",
            draining: options.ready === false,
            changedAt: "2026-11-16T00:00:00.000Z",
            activeResponseRequests: 0
          }
        })
      );
      return;
    }
    if (
      options.token &&
      request.headers.authorization !== "Bearer " + options.token
    ) {
      response.writeHead(401);
      response.end("unauthorized");
      return;
    }
    if (request.url === "/headers") {
      response.writeHead(200, {
        connection: "close, X-Worker-Hop",
        "x-worker-hop": "private",
        "proxy-authenticate": "Basic realm=worker",
        "proxy-authorization": "private",
        "proxy-connection": "private",
        te: "trailers",
        trailer: "X-Worker-Trailer",
        upgrade: "private",
        "x-end-to-end": "preserved"
      });
      response.write(JSON.stringify(request.headers));
      response.addTrailers({ "X-Worker-Trailer": "private" });
      response.end();
      return;
    }
    if (request.url === "/stall") {
      return;
    }
    if (request.url === "/stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: " + id + "-first\n\n");
      streams.add(response);
      response.once("close", () => streams.delete(response));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("x-worker", id);
      response.setHeader(
        "x-seen-request-id",
        String(request.headers["x-request-id"] ?? "")
      );
      response.end(Buffer.concat(chunks).toString() || id);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    endpoint: { id, host: "127.0.0.1", port: address.port },
    finishStreams: () => {
      for (const response of streams) response.end("data: " + id + "-done\n\n");
    }
  };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("failed successor never replaces the active generation", async () => {
  const ingress = new RouterIngress();
  const current = await worker("current");
  const failed = await worker("failed", { ready: false });
  try {
    await ingress.listen(0, "127.0.0.1");
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    assert.equal(
      (await fetch(base + "/_autodev/ingress/readiness")).status,
      503
    );
    assert.equal(await ingress.activateGeneration(current.endpoint), null);
    await assert.rejects(
      ingress.activateGeneration(failed.endpoint),
      /not ready/
    );
    assert.equal(ingress.getStatus().activeGenerationId, "current");
    const response = await fetch(base + "/");
    assert.equal(response.headers.get("x-worker"), "current");
    assert.equal(await response.text(), "current");
  } finally {
    await Promise.all([
      close(ingress.server),
      close(current.server),
      close(failed.server)
    ]);
  }
});

test("cutover preserves established SSE and waits for safe retirement", async () => {
  const events: RouterIngressEvent[] = [];
  const ingress = new RouterIngress({ onEvent: (event) => events.push(event) });
  const previous = await worker("previous");
  const successor = await worker("successor");
  try {
    await ingress.listen(0, "127.0.0.1");
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    await ingress.activateGeneration(previous.endpoint);
    const stream = await fetch(base + "/stream");
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /previous-first/
    );
    assert.equal(
      await ingress.activateGeneration(successor.endpoint),
      "previous"
    );
    assert.deepEqual(
      ingress.getStatus().generations.find((entry) => entry.id === "previous"),
      { id: "previous", state: "retiring", inFlight: 1 }
    );
    const next = await fetch(base + "/", {
      method: "POST",
      headers: {
        "x-request-id": "known-request",
        authorization: "Bearer token"
      },
      body: "posted-body"
    });
    assert.equal(next.headers.get("x-worker"), "successor");
    assert.equal(next.headers.get("x-seen-request-id"), "known-request");
    assert.equal(await next.text(), "posted-body");
    previous.finishStreams();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /previous-done/
    );
    await reader.cancel();
    await ingress.waitForRetirement("previous");
    assert.equal(
      ingress.getStatus().generations.find((entry) => entry.id === "previous")
        ?.state,
      "retired"
    );
    assert.ok(
      events.some(
        (event) =>
          event.phase === "generation_retired" &&
          event.generationId === "previous"
      )
    );
    await assert.rejects(ingress.waitForRetirement("successor"), /active/);
  } finally {
    await Promise.all([
      close(ingress.server),
      close(previous.server),
      close(successor.server)
    ]);
  }
});

test("retirement deadline aborts only the predecessor's admitted requests", { timeout: 10_000 }, async () => {
  const events: RouterIngressEvent[] = [];
  const ingress = new RouterIngress({
    retirementDrainTimeoutMs: 500,
    onEvent: (event) => events.push(event)
  });
  const previous = await worker("previous");
  const successor = await worker("successor");
  try {
    await ingress.listen(0, "127.0.0.1");
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    await ingress.activateGeneration(previous.endpoint);

    const stream = await fetch(base + "/stream");
    const reader = stream.body!.getReader();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /previous-first/
    );
    const streamAborted = assert.rejects(reader.read());
    const stallAdmitted = new Promise<void>((resolve) => {
      previous.server.once("request", () => resolve());
    });
    const stallAborted = assert.rejects(
      fetch(base + "/stall", { method: "POST" })
    );
    await stallAdmitted;

    await ingress.activateGeneration(successor.endpoint);
    assert.deepEqual(ingress.getStatus().generations[0], {
      id: "previous",
      state: "retiring",
      inFlight: 2
    });
    const next = await fetch(base + "/stream");
    const nextReader = next.body!.getReader();
    assert.match(
      new TextDecoder().decode((await nextReader.read()).value),
      /successor-first/
    );

    await ingress.waitForRetirement("previous");
    await Promise.all([streamAborted, stallAborted]);
    assert.deepEqual(ingress.getStatus().generations, [
      { id: "previous", state: "retired", inFlight: 0 },
      { id: "successor", state: "active", inFlight: 1 }
    ]);
    assert.deepEqual(
      events.filter((event) => event.generationId === "previous"),
      [
        { phase: "generation_activated", generationId: "previous" },
        {
          phase: "generation_drain_deadline_expired",
          generationId: "previous",
          inFlight: 2
        },
        { phase: "generation_retired", generationId: "previous" }
      ]
    );
    successor.finishStreams();
    assert.match(
      new TextDecoder().decode((await nextReader.read()).value),
      /successor-done/
    );
    assert.equal((await nextReader.read()).done, true);
    assert.equal(await (await fetch(base)).text(), "successor");
  } finally {
    await Promise.all([
      close(ingress.server),
      close(previous.server),
      close(successor.server)
    ]);
  }
});

test("a drained generation clears its deadline and never aborts the successor", { timeout: 10_000 }, async () => {
  const events: RouterIngressEvent[] = [];
  const ingress = new RouterIngress({
    retirementDrainTimeoutMs: 500,
    onEvent: (event) => events.push(event)
  });
  const previous = await worker("previous");
  const successor = await worker("successor");
  try {
    await ingress.listen(0, "127.0.0.1");
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    await ingress.activateGeneration(previous.endpoint);
    const stream = await fetch(base + "/stream");
    const reader = stream.body!.getReader();
    await reader.read();
    await ingress.activateGeneration(successor.endpoint);
    previous.finishStreams();
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /previous-done/
    );
    assert.equal((await reader.read()).done, true);
    await ingress.waitForRetirement("previous");
    await delay(550);
    assert.equal(
      events.filter((event) => event.phase === "generation_retired").length,
      1
    );
    assert.ok(
      events.every((event) => event.phase !== "generation_drain_deadline_expired")
    );
    assert.equal(await (await fetch(base)).text(), "successor");
  } finally {
    await Promise.all([
      close(ingress.server),
      close(previous.server),
      close(successor.server)
    ]);
  }
});

test("ingress rejects invalid retirement deadlines", () => {
  for (const retirementDrainTimeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(
      () => new RouterIngress({ retirementDrainTimeoutMs }),
      /Invalid ingress retirement drain timeout/
    );
  }
});

async function ingressRequest(
  port: number,
  path: string,
  headers: IncomingHttpHeaders
): Promise<IncomingMessage> {
  const request = httpRequest({ host: "127.0.0.1", port, path, headers });
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Unexpected protocol upgrade"));
    });
  });
  request.end();
  return response;
}

test("ingress strips hop-by-hop headers in both directions", async () => {
  const ingress = new RouterIngress();
  const current = await worker("current");
  try {
    await ingress.listen(0, "127.0.0.1");
    await ingress.activateGeneration(current.endpoint);
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    const response = await ingressRequest(address.port, "/headers", {
      connection: "close, X-Client-Hop, X-Request-ID",
      "x-client-hop": "private",
      "x-request-id": "connection-scoped-id",
      "proxy-authorization": "Basic private",
      "proxy-authenticate": "private",
      "proxy-connection": "private",
      te: "trailers",
      authorization: "Bearer fixture",
      "x-end-to-end": "preserved"
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response) chunks.push(chunk as Buffer);
    const observed = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    ) as IncomingHttpHeaders;
    assert.equal(response.statusCode, 200);
    for (const name of [
      "proxy-authorization",
      "proxy-authenticate",
      "proxy-connection",
      "te",
      "trailer",
      "upgrade"
    ]) {
      assert.equal(observed[name], undefined, name);
      assert.equal(response.headers[name], undefined, name);
    }
    assert.equal(observed["x-client-hop"], undefined);
    assert.equal(response.headers["x-worker-hop"], undefined);
    assert.deepEqual(response.trailers, {});
    assert.equal(observed.authorization, "Bearer fixture");
    assert.equal(observed["x-end-to-end"], "preserved");
    assert.equal(response.headers["x-end-to-end"], "preserved");
    assert.match(observed["x-request-id"] as string, /^[\da-f-]{36}$/i);
  } finally {
    await Promise.all([close(ingress.server), close(current.server)]);
  }
});

test("ingress explicitly refuses upgrades without admitting them", async () => {
  const ingress = new RouterIngress();
  const current = await worker("current");
  try {
    await ingress.listen(0, "127.0.0.1");
    await ingress.activateGeneration(current.endpoint);
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    let forwarded = 0;
    current.server.on("request", () => {
      forwarded += 1;
    });
    current.server.on("upgrade", (_request, socket) => {
      forwarded += 1;
      socket.destroy();
    });
    const response = await ingressRequest(address.port, "/stream", {
      connection: "Upgrade",
      upgrade: "websocket"
    });
    response.resume();
    assert.equal(response.statusCode, 501);
    assert.equal(response.headers.connection, "close");
    assert.equal(forwarded, 0);
    assert.equal(ingress.getStatus().generations[0]?.inFlight, 0);
    const ordinary = await fetch("http://127.0.0.1:" + address.port + "/");
    assert.equal(await ordinary.text(), "current");
  } finally {
    await Promise.all([close(ingress.server), close(current.server)]);
  }
});

test("ingress delegates authentication and creates request IDs", async () => {
  const ingress = new RouterIngress();
  const secured = await worker("secured", { token: "fixture-token" });
  try {
    await ingress.listen(0, "127.0.0.1");
    await ingress.activateGeneration(secured.endpoint);
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    assert.equal((await fetch(base + "/")).status, 401);
    const response = await fetch(base + "/", {
      headers: { authorization: "Bearer fixture-token" }
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("x-seen-request-id") ?? "",
      /^[\da-f-]{36}$/i
    );
  } finally {
    await Promise.all([close(ingress.server), close(secured.server)]);
  }
});

test("session affinity keeps pinned ACP and provider sessions on their generation until end or deadline", async () => {
  const ingress = new RouterIngress({ retirementDrainTimeoutMs: 400 });
  const acpFirstServer = await worker("first");
  const acpSecondServer = await worker("second");
  // Augment workers with response headers that simulate ACP creation/deletion
  acpFirstServer.server.removeAllListeners("request");
  acpFirstServer.server.on("request", (request, response) => {
    if (request.url === "/health/readiness") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ready",
          router: "codex-model-router",
          lifecycle: { state: "ready", draining: false }
        })
      );
      return;
    }
    if (request.url === "/v1/acp/sessions" && request.method === "POST") {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-autodev-session-id": "sess-alpha"
      });
      response.end(JSON.stringify({ worker: "first", sessionId: "sess-alpha" }));
      return;
    }
    if (
      request.url === "/v1/acp/sessions/sess-alpha" &&
      request.method === "DELETE"
    ) {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-autodev-session-id": "sess-alpha",
        "x-autodev-session-ended": "1"
      });
      response.end(JSON.stringify({ worker: "first", closed: true }));
      return;
    }
    response.setHeader("x-worker", "first");
    response.end("first");
  });
  try {
    await ingress.listen(0, "127.0.0.1");
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    await ingress.activateGeneration(acpFirstServer.endpoint);

    // 1. Establish both an ACP session and a pinned provider session on first generation.
    const created = await fetch(base + "/v1/acp/sessions", { method: "POST" });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).worker, "first");

    const pinnedFirst = await fetch(base + "/v1/responses", {
      headers: { "x-codex-session-id": "provider-pinned-1" }
    });
    assert.equal(pinnedFirst.headers.get("x-worker"), "first");

    // 2. Cut over to successor: new unpinned and new session traffic move to second.
    await ingress.activateGeneration(acpSecondServer.endpoint);
    assert.equal(
      ingress.getStatus().generations.find((entry) => entry.id === "first")?.state,
      "retiring",
      "first generation stays retiring while ACP and provider sessions remain open"
    );

    const newTraffic = await fetch(base + "/");
    assert.equal(newTraffic.headers.get("x-worker"), "second");
    const newSession = await fetch(base + "/v1/responses", {
      headers: { "x-codex-session-id": "provider-pinned-2" }
    });
    assert.equal(newSession.headers.get("x-worker"), "second");

    // 3. Existing ACP prompt and pinned provider session remain pinned to first.
    const acpPrompt = await fetch(base + "/v1/acp/sessions/sess-alpha/prompt", {
      method: "POST"
    });
    assert.equal(acpPrompt.headers.get("x-worker"), "first");
    const pinnedContinuation = await fetch(base + "/v1/responses", {
      headers: { "x-codex-session-id": "provider-pinned-1" }
    });
    assert.equal(pinnedContinuation.headers.get("x-worker"), "first");

    // 4. Ending ACP session explicitly removes it; drain deadline cleans up the unclosed provider pin.
    const deleted = await fetch(base + "/v1/acp/sessions/sess-alpha", {
      method: "DELETE"
    });
    assert.equal(deleted.status, 200);
    await ingress.waitForRetirement("first");
    assert.equal(
      ingress.getStatus().generations.find((entry) => entry.id === "first")?.state,
      "retired"
    );

    // After first retired, re-using that stale session id routes fresh onto second.
    const postRetire = await fetch(base + "/v1/responses", {
      headers: { "x-codex-session-id": "provider-pinned-1" }
    });
    assert.equal(postRetire.headers.get("x-worker"), "second");
  } finally {
    await Promise.all([
      close(ingress.server),
      close(acpFirstServer.server),
      close(acpSecondServer.server)
    ]);
  }
});
