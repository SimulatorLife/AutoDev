import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import test from "node:test";

import {
  type RouterGenerationEndpoint,
  RouterIngress,
  type RouterIngressEvent
} from "../../runtime/src/router/ingress.ts";

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
