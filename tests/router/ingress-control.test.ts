import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startRouterIngressProcess } from "../../runtime/src/router/ingress-main.ts";

const TOKEN = "isolated-ingress-management-secret-0123456789";

function controlRequest(
  socketPath: string,
  method: string,
  pathname: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const contents = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath,
        path: pathname,
        method,
        headers: {
          ...(token ? { authorization: "Bearer " + token } : {}),
          ...(contents
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(contents)
              }
            : {})
        }
      },
      async (response) => {
        const chunks: Buffer[] = [];
        try {
          for await (const chunk of response) chunks.push(chunk as Buffer);
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
              string,
              unknown
            >
          });
        } catch (error) {
          reject(error);
        }
      }
    );
    req.once("error", reject);
    req.end(contents);
  });
}

test("private control API spawns verified generations and rejects arbitrary endpoints", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autodev-ingress-control-")
  );
  const releases = path.join(directory, "releases");
  await mkdir(releases);
  const entry = path.join(releases, "worker.mjs");
  const outside = path.join(directory, "outside.mjs");
  const socket = path.join(directory, "control.sock");
  const workerCode = [
    'import { createServer } from "node:http";',
    "const id = process.env.AUTODEV_ROUTER_WORKER_GENERATION;",
    "const server = createServer((req, res) => {",
    '  if (req.url === "/health/readiness") {',
    '    res.setHeader("content-type", "application/json");',
    '    res.end(JSON.stringify({ status:"ready", router:"codex-model-router",',
    '      lifecycle:{ state:"ready", draining:false, changedAt:"fixture", activeResponseRequests:0 } }));',
    "    return;",
    "  }",
    "  res.end(id);",
    "});",
    'server.listen(0, "127.0.0.1", () => {',
    '  process.send?.({ type:"autodev-router-worker-listening", generationId:id, port:server.address().port });',
    "});",
    'process.on("SIGTERM", () => server.close());'
  ].join("\n");
  await Promise.all([
    writeFile(entry, workerCode),
    writeFile(outside, workerCode)
  ]);
  const { ingress, supervisor } = await startRouterIngressProcess({
    AUTODEV_ROUTER_INGRESS_CONTROL_SOCKET: socket,
    AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN: TOKEN,
    AUTODEV_ROUTER_RELEASES_DIRECTORY: releases,
    CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
    CODEX_MODEL_ROUTER_PORT: "0"
  });
  try {
    const address = ingress.server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port;
    assert.equal(
      (await controlRequest(socket, "GET", "/v1/status")).status,
      401
    );
    assert.equal(
      (await controlRequest(socket, "GET", "/v1/status", "wrong-token")).status,
      401
    );
    assert.equal(
      (await controlRequest(socket, "GET", "/v1/status", TOKEN)).status,
      200
    );
    assert.equal((await fetch(base + "/v1/status")).status, 503);
    assert.equal(
      (
        await controlRequest(socket, "POST", "/v1/generations", TOKEN, {
          id: "outside",
          entry: outside
        })
      ).status,
      422
    );
    assert.equal(
      (
        await controlRequest(socket, "POST", "/v1/generations", TOKEN, {
          id: "arbitrary",
          host: "169.254.169.254",
          port: 80
        })
      ).status,
      400
    );
    const activated = await controlRequest(
      socket,
      "POST",
      "/v1/generations",
      TOKEN,
      {
        id: "generation-a",
        entry
      }
    );
    assert.equal(activated.status, 200);
    assert.equal(activated.body.activeGenerationId, "generation-a");
    assert.equal(await (await fetch(base)).text(), "generation-a");
    const replaced = await controlRequest(
      socket,
      "POST",
      "/v1/generations",
      TOKEN,
      {
        id: "generation-b",
        entry
      }
    );
    assert.equal(replaced.status, 200);
    assert.equal(replaced.body.retiringGenerationId, "generation-a");
    assert.equal(await (await fetch(base)).text(), "generation-b");
    const retired = await controlRequest(
      socket,
      "GET",
      "/v1/generations/generation-a/retirement",
      TOKEN
    );
    assert.ok(retired.status === 200 || retired.status === 202);
    const status = await controlRequest(socket, "GET", "/v1/status", TOKEN);
    assert.equal(status.body.activeGenerationId, "generation-b");
    const mode = (await import("node:fs/promises")).stat(socket);
    assert.equal((await mode).mode & 0o777, 0o600);
  } finally {
    await supervisor.close();
    await new Promise<void>((resolve, reject) => {
      ingress.server.closeAllConnections();
      ingress.server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(directory, { recursive: true, force: true });
  }
});
