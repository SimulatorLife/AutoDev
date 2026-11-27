import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";

import { startRouterIngressProcess } from "../src/router/ingress-main.ts";
import {
  getFinishedSpans,
  resetTelemetryExporter,
  setTelemetryExporter
} from "../src/router/telemetry.ts";

const TOKEN = "isolated-ingress-management-secret-0123456789";

setTelemetryExporter(new InMemorySpanExporter());

/**
A worker fixture: answers readiness, echoes its generation, streams on
/stream, exits with code 3 on /crash, and records SIGTERM beside itself.
*/
function workerSource(options: { exitAfterReadiness?: boolean } = {}): string {
  return [
    'import { createServer } from "node:http";',
    'import { writeFileSync } from "node:fs";',
    "const id = process.env.AUTODEV_ROUTER_WORKER_GENERATION;",
    "const server = createServer((req, res) => {",
    '  if (req.url === "/health/readiness") {',
    '    res.setHeader("content-type", "application/json");',
    '    res.end(JSON.stringify({ status:"ready", router:"codex-model-router",',
    '      lifecycle:{ state:"ready", draining:false, changedAt:"fixture", activeResponseRequests:0 } }));',
    ...(options.exitAfterReadiness
      ? ["    setTimeout(() => process.exit(3), 50);"]
      : []),
    "    return;",
    "  }",
    '  if (req.url === "/pid") { res.end(String(process.pid)); return; }',
    '  if (req.url === "/crash") { process.exit(3); }',
    '  if (req.url === "/stream") {',
    '    res.writeHead(200, { "content-type": "text/event-stream" });',
    '    res.write("data: " + id + "-first\\n\\n");',
    "    return;",
    "  }",
    "  res.end(id);",
    "});",
    'server.listen(0, "127.0.0.1", () => {',
    '  process.send?.({ type:"autodev-router-worker-listening", generationId:id, port:server.address().port });',
    "});",
    'process.on("SIGTERM", () => {',
    '  writeFileSync(new URL(id + ".sigterm", import.meta.url), "received");',
    '  if (id !== "generation-b") server.close();',
    "});"
  ].join("\n");
}

async function startIngress(directory: string, releases: string) {
  const socket = path.join(directory, "control.sock");
  const started = await startRouterIngressProcess({
    AUTODEV_ROUTER_INGRESS_CONTROL_SOCKET: socket,
    AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN: TOKEN,
    AUTODEV_ROUTER_RELEASES_DIRECTORY: releases,
    AUTODEV_ROUTER_INGRESS_DRAIN_MS: "750",
    AUTODEV_ROUTER_INGRESS_WORKER_SHUTDOWN_MS: "1000",
    CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
    CODEX_MODEL_ROUTER_PORT: "0"
  });
  const address = started.ingress.server.address();
  assert.ok(address && typeof address !== "string");
  return {
    ...started,
    socket,
    base: "http://127.0.0.1:" + address.port,
    async close() {
      await started.supervisor.close();
      await new Promise<void>((resolve, reject) => {
        started.ingress.server.closeAllConnections();
        started.ingress.server.close((error) =>
          error ? reject(error) : resolve()
        );
      });
    }
  };
}

async function waitForStatus(
  socket: string,
  predicate: (status: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  const deadline = performance.now() + 10_000;
  do {
    const { body } = await controlRequest(socket, "GET", "/v1/status", TOKEN);
    if (predicate(body)) return body;
    await delay(25);
  } while (performance.now() < deadline);
  assert.fail("Ingress status never matched");
}

function ingressEvents(): Array<Record<string, unknown>> {
  return getFinishedSpans()
    .filter((span) => span.name === "autodev.router.ingress")
    .map((span) => ({ ...span.attributes }));
}

function controlRequest(
  socketPath: string,
  method: string,
  pathname: string,
  token?: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const contents = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest(
      {
        socketPath,
        path: pathname,
        method,
        headers: {
          ...(token && { authorization: "Bearer " + token }),
          ...(contents && {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(contents)
          })
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
    request.once("error", reject);
    request.end(contents);
  });
}

async function waitForWorkerRetirement(
  socket: string,
  generationId: string
): Promise<Record<string, unknown>> {
  const deadline = performance.now() + 10_000;
  do {
    const result = await controlRequest(
      socket,
      "GET",
      "/v1/generations/" + generationId + "/retirement",
      TOKEN
    );
    if (result.status === 200) return result.body;
    assert.equal(result.status, 202);
    await delay(25);
  } while (performance.now() < deadline);
  assert.fail("Worker did not retire: " + generationId);
}

test(
  "private control API spawns verified generations and rejects arbitrary endpoints",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "autodev-ingress-control-")
    );
    const releases = path.join(directory, "releases");
    await mkdir(releases);
    const entry = path.join(releases, "worker.mjs");
    const outside = path.join(directory, "outside.mjs");
    const socket = path.join(directory, "control.sock");
    const workerCode = workerSource();
    await Promise.all([
      writeFile(entry, workerCode),
      writeFile(outside, workerCode)
    ]);
    const { ingress, supervisor } = await startRouterIngressProcess({
      AUTODEV_ROUTER_INGRESS_CONTROL_SOCKET: socket,
      AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN: TOKEN,
      AUTODEV_ROUTER_RELEASES_DIRECTORY: releases,
      AUTODEV_ROUTER_INGRESS_DRAIN_MS: "750",
      AUTODEV_ROUTER_INGRESS_WORKER_SHUTDOWN_MS: "1000",
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
        (await controlRequest(socket, "GET", "/v1/status", "wrong-token"))
          .status,
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
      assert.deepEqual(await waitForWorkerRetirement(socket, "generation-a"), {
        id: "generation-a",
        state: "retired",
        inFlight: 0
      });
      assert.equal(
        await readFile(path.join(releases, "generation-a.sigterm"), "utf8"),
        "received"
      );

      // B stalls an admitted stream and deliberately ignores SIGTERM. C must
      // remain available while B drains, then B must be reaped by escalation.
      const pid = Number(await (await fetch(base + "/pid")).text());
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const stream = await fetch(base + "/stream");
      const reader = stream.body!.getReader();
      assert.match(
        new TextDecoder().decode((await reader.read()).value),
        /generation-b-first/
      );
      const aborted = assert.rejects(reader.read());
      const third = await controlRequest(
        socket,
        "POST",
        "/v1/generations",
        TOKEN,
        { id: "generation-c", entry }
      );
      assert.equal(third.status, 200);
      assert.equal(third.body.retiringGenerationId, "generation-b");
      assert.equal(await (await fetch(base)).text(), "generation-c");
      assert.equal(
        (
          await controlRequest(
            socket,
            "GET",
            "/v1/generations/generation-b/retirement",
            TOKEN
          )
        ).status,
        202
      );
      await aborted;
      assert.deepEqual(await waitForWorkerRetirement(socket, "generation-b"), {
        id: "generation-b",
        state: "retired",
        inFlight: 0
      });
      assert.equal(
        await readFile(path.join(releases, "generation-b.sigterm"), "utf8"),
        "received"
      );
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      const status = await controlRequest(socket, "GET", "/v1/status", TOKEN);
      assert.equal(status.body.activeGenerationId, "generation-c");
      assert.equal(await (await fetch(base)).text(), "generation-c");
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
  }
);

test("control socket refuses to bind in a directory others can reach", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "autodev-ingress-shared-")
  );
  try {
    await chmod(directory, 0o755);
    await assert.rejects(
      startRouterIngressProcess({
        AUTODEV_ROUTER_INGRESS_CONTROL_SOCKET: path.join(
          directory,
          "control.sock"
        ),
        AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN: TOKEN,
        AUTODEV_ROUTER_RELEASES_DIRECTORY: directory,
        CODEX_MODEL_ROUTER_PORT: "0"
      }),
      /private \(0700\) directory/
    );
    await assert.rejects(stat(path.join(directory, "control.sock")), {
      code: "ENOENT"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "an active worker crash flips readiness, restarts its release, and rollback reactivates the retained one",
  { timeout: 20_000 },
  async () => {
    resetTelemetryExporter();
    const directory = await mkdtemp(
      path.join(tmpdir(), "autodev-ingress-crash-")
    );
    const releases = path.join(directory, "releases");
    await mkdir(releases);
    const entry = path.join(releases, "worker.mjs");
    await writeFile(entry, workerSource());
    const ingress = await startIngress(directory, releases);
    try {
      assert.deepEqual(
        await controlRequest(ingress.socket, "POST", "/v1/rollback", TOKEN, {
          id: "nothing-retained"
        }),
        { status: 409, body: { error: "no_rollback_target" } }
      );
      for (const id of ["generation-a", "generation-b"]) {
        const activated = await controlRequest(
          ingress.socket,
          "POST",
          "/v1/generations",
          TOKEN,
          { id, entry }
        );
        assert.equal(activated.status, 200);
      }
      await waitForWorkerRetirement(ingress.socket, "generation-a");
      assert.equal(
        (await controlRequest(ingress.socket, "GET", "/v1/status", TOKEN)).body
          .rollbackGenerationId,
        "generation-a"
      );

      await fetch(ingress.base + "/crash").catch(() => undefined);
      const restarted = await waitForStatus(
        ingress.socket,
        (status) => status.activeGenerationId === "generation-b.restart-1"
      );
      assert.equal(restarted.rollbackGenerationId, "generation-a");
      assert.equal(
        await (await fetch(ingress.base)).text(),
        "generation-b.restart-1"
      );
      assert.deepEqual(
        (restarted.generations as Array<Record<string, unknown>>).find(
          (generation) => generation.id === "generation-b"
        ),
        { id: "generation-b", state: "retired", inFlight: 0 }
      );

      const rolledBack = await controlRequest(
        ingress.socket,
        "POST",
        "/v1/rollback",
        TOKEN,
        { id: "generation-a.rollback" }
      );
      assert.deepEqual(rolledBack, {
        status: 200,
        body: {
          activeGenerationId: "generation-a.rollback",
          retiringGenerationId: "generation-b.restart-1"
        }
      });
      assert.equal(
        await (await fetch(ingress.base)).text(),
        "generation-a.rollback"
      );
      await waitForWorkerRetirement(ingress.socket, "generation-b.restart-1");
      assert.equal(
        (await controlRequest(ingress.socket, "GET", "/v1/status", TOKEN)).body
          .rollbackGenerationId,
        "generation-b.restart-1"
      );

      const events = ingressEvents();
      assert.deepEqual(
        events.find(
          (event) =>
            event["autodev.router.ingress.phase"] === "generation_worker_exited"
        ),
        {
          "autodev.router.ingress.phase": "generation_worker_exited",
          "autodev.router.generation.id": "generation-b",
          "process.exit.code": 3
        }
      );
      assert.ok(
        events.some(
          (event) =>
            event["autodev.router.ingress.phase"] === "generation_restarted" &&
            event["autodev.router.generation.id"] ===
              "generation-b.restart-1" &&
            event["autodev.router.generation.source_id"] === "generation-b"
        )
      );
      assert.ok(
        events.some(
          (event) =>
            event["autodev.router.ingress.phase"] ===
              "generation_rolled_back" &&
            event["autodev.router.generation.id"] === "generation-a.rollback" &&
            event["autodev.router.generation.source_id"] === "generation-a"
        )
      );
    } finally {
      await ingress.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  "a crash-looping release ends in explicit unavailability instead of restarting forever",
  { timeout: 20_000 },
  async () => {
    resetTelemetryExporter();
    const directory = await mkdtemp(
      path.join(tmpdir(), "autodev-ingress-loop-")
    );
    const releases = path.join(directory, "releases");
    await mkdir(releases);
    const entry = path.join(releases, "crashing.mjs");
    await writeFile(entry, workerSource({ exitAfterReadiness: true }));
    const ingress = await startIngress(directory, releases);
    try {
      const activated = await controlRequest(
        ingress.socket,
        "POST",
        "/v1/generations",
        TOKEN,
        { id: "looping", entry }
      );
      assert.equal(activated.status, 200);
      const deadline = performance.now() + 10_000;
      while (
        !ingressEvents().some(
          (event) =>
            event["autodev.router.ingress.phase"] ===
            "generation_restart_exhausted"
        )
      ) {
        assert.ok(performance.now() < deadline, "restart never gave up");
        await delay(25);
      }
      await delay(200);
      const status = await controlRequest(
        ingress.socket,
        "GET",
        "/v1/status",
        TOKEN
      );
      assert.equal(status.body.activeGenerationId, null);
      assert.deepEqual(
        ingressEvents()
          .filter(
            (event) =>
              event["autodev.router.ingress.phase"] === "generation_restarted"
          )
          .map((event) => event["autodev.router.generation.id"]),
        ["looping.restart-1", "looping.restart-2", "looping.restart-3"]
      );
      const response = await fetch(ingress.base);
      assert.equal(response.status, 503);
      assert.equal(
        (await fetch(ingress.base + "/_autodev/ingress/readiness")).status,
        503
      );
    } finally {
      await ingress.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
