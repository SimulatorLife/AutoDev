import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as connectUnixSocket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { startRouterIngressProcess } from "../src/router/ingress-main.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

async function controlCall(
  socketPath: string,
  token: string,
  method: "GET" | "POST",
  pathname: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        path: pathname,
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload !== undefined && {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload)
          })
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 500,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >
          });
        });
      }
    );
    request.once("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

async function xacpxRpc(
  socketPath: string,
  method: string,
  parameters: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> {
  return await new Promise((resolve, reject) => {
    const socket = connectUnixSocket(socketPath);
    let buffer = "";
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ id: "rpc-1", method, params: parameters })}\n`
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      socket.end();
      resolve(JSON.parse(line) as { ok: boolean; result?: unknown });
    });
    socket.once("error", reject);
  });
}

function workerHarnessSource(): string {
  const concurrencyUrl = JSON.stringify(
    new URL("../src/router/concurrency/index.ts", import.meta.url).href
  );
  const cooldownUrl = JSON.stringify(
    new URL("../src/router/cooldown/index.ts", import.meta.url).href
  );
  const sharedStateUrl = JSON.stringify(
    new URL("../src/router/shared-state-ipc.ts", import.meta.url).href
  );
  const netUrl = JSON.stringify("node:net");
  const httpUrl = JSON.stringify("node:http");

  return [
    `import { createServer as createHttpServer } from ${httpUrl};`,
    `import { createServer as createUnixServer } from ${netUrl};`,
    `import { ConcurrencyManager } from ${concurrencyUrl};`,
    `import { ProviderCooldowns } from ${cooldownUrl};`,
    `import { SharedRouterStateClient, sumCountsExcludingGeneration } from ${sharedStateUrl};`,
    `import { createAgentActivityTracker } from ${JSON.stringify(
      new URL("../src/agents/agent-activity.ts", import.meta.url).href
    )};`,
    "const id = process.env.AUTODEV_ROUTER_WORKER_GENERATION;",
    "const activity = createAgentActivityTracker();",
    "const concurrency = new ConcurrencyManager({ agentActivity: activity });",
    "const cooldowns = new ProviderCooldowns();",
    "const streams = new Set();",
    "let sharedClient = null;",
    "if (process.env.AUTODEV_ROUTER_SHARED_STATE_SOCKET) {",
    "  sharedClient = new SharedRouterStateClient({",
    "    socketPath: process.env.AUTODEV_ROUTER_SHARED_STATE_SOCKET,",
    "    generationId: id,",
    "    onSync: (snapshot) => {",
    "      cooldowns.restoreSyncState(snapshot.cooldowns);",
    "      concurrency.applySharedSyncState({",
    "        ...snapshot.concurrency,",
    "        externalSlotCounts: sumCountsExcludingGeneration(snapshot.subagentSlotsByGeneration, id)",
    "      });",
    "    }",
    "  });",
    "  await sharedClient.connectAndSync();",
    "  cooldowns.setMutationListener((snap) => sharedClient.notify('update_cooldowns', { cooldowns: snap }));",
    "  concurrency.setSharedMutator({",
    "    patchLimit: async ({ storedLimit, resetToConfigFile, expectedRevision }) =>",
    "      await sharedClient.call('set_concurrency_limit', { storedLimit, resetToConfigFile, ...(expectedRevision !== undefined && { expectedRevision }) }),",
    "    syncLocalSlots: (slotsBySession) => sharedClient.notify('set_generation_subagent_slots', { generationId: id, slotsBySession })",
    "  });",
    "}",
    "const xacpxSocket = process.env.AUTODEV_WORKER_XACPX_SOCKET;",
    "if (xacpxSocket) {",
    "  const sessions = new Set();",
    "  const ipc = createUnixServer((sock) => {",
    "    let buf = '';",
    "    sock.on('data', (c) => {",
    "      buf += c.toString('utf8');",
    "      for (;;) {",
    "        const idx = buf.indexOf('\\n');",
    "        if (idx === -1) break;",
    "        const req = JSON.parse(buf.slice(0, idx));",
    "        buf = buf.slice(idx + 1);",
    "        const cs = req.params?.coordinatorSession ?? req.params?.sourceHandle;",
    "        if (req.method === 'coordinator.register_external' && cs) sessions.add(cs);",
    "        sock.write(JSON.stringify({ id: req.id, ok: true, result: { generationId: id, coordinatorSession: cs, known: sessions.has(cs) } }) + '\\n');",
    "      }",
    "    });",
    "  });",
    "  await new Promise((r) => ipc.listen(xacpxSocket, r));",
    "}",
    "const http = createHttpServer(async (req, res) => {",
    "  if (req.url === '/health/readiness') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ status: 'ready', router: 'codex-model-router', lifecycle: { state: 'ready', draining: false } }));",
    "    return;",
    "  }",
    "  if (req.url === '/stream') {",
    "    res.writeHead(200, { 'content-type': 'text/event-stream' });",
    "    res.write('data: ' + id + '-open\\n\\n');",
    "    streams.add(res);",
    "    res.once('close', () => streams.delete(res));",
    "    return;",
    "  }",
    "  if (req.url === '/finish-streams') {",
    "    for (const s of streams) s.end('data: ' + id + '-closed\\n\\n');",
    "    res.end('ok');",
    "    return;",
    "  }",
    "  if (req.url === '/acquire-slot') {",
    "    const err = concurrency.tryAcquireSubagentSlot('sess-shared');",
    "    res.writeHead(err ? 429 : 200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ worker: id, denied: err, status: concurrency.concurrencyStatus() }));",
    "    return;",
    "  }",
    "  if (req.url === '/cool-provider') {",
    "    cooldowns.cooldownProvider('claude', { failureClass: 'rate_limit', resetsAt: new Date(Date.now() + 600_000).toISOString(), structured: true });",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ worker: id, cooled: cooldowns.isCooling('claude') }));",
    "    return;",
    "  }",
    "  if (req.url === '/control/runtime/concurrency' && req.method === 'PATCH') {",
    "    const chunks = []; for await (const c of req) chunks.push(c);",
    "    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    "    const result = await concurrency.setMaxConcurrentThreadsPerSessionShared(body.maxConcurrentThreadsPerSession, body.revision);",
    "    res.writeHead(result.ok ? 200 : 409, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ worker: id, ...result, status: concurrency.concurrencyStatus() }));",
    "    return;",
    "  }",
    "  if (req.url === '/status') {",
    "    res.writeHead(200, { 'content-type': 'application/json' });",
    "    res.end(JSON.stringify({ worker: id, claudeCooling: cooldowns.isCooling('claude'), concurrency: concurrency.concurrencyStatus() }));",
    "    return;",
    "  }",
    "  if (req.url === '/crash') { process.exit(3); }",
    "  res.writeHead(200, { 'content-type': 'application/json' });",
    "  res.end(JSON.stringify({ worker: id }));",
    "});",
    "http.listen(0, '127.0.0.1', () => {",
    "  process.send?.({ type: 'autodev-router-worker-listening', generationId: id, port: http.address().port, ...(xacpxSocket && { xacpxSocket }) });",
    "});"
  ].join("\n");
}

test("concurrent generations share concurrency limits, cooldowns, state persistence, Control API, and XACPX IPC", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "autodev-shared-state-"));
  const socketDir = await mkdtemp("/tmp/adss-");
  await chmod(socketDir, 0o700);
  const codexHome = path.join(root, "codex");
  const releases = path.join(root, "releases");
  await mkdir(codexHome, { recursive: true });
  await mkdir(releases, { recursive: true });
  const entryA = path.join(releases, "gen-a.mts");
  const entryB = path.join(releases, "gen-b.mts");
  await writeFile(entryA, workerHarnessSource());
  await writeFile(entryB, workerHarnessSource());

  const token = "shared-state-test-token-0123456789abcdef0123456789";
  const controlSocket = path.join(socketDir, "control.sock");
  const xacpxSocket = path.join(socketDir, "xacpx.sock");
  const stateFile = path.join(codexHome, "codex-router-state.json");

  const prevStateFile = process.env.CODEX_ROUTER_STATE_FILE;
  process.env.CODEX_ROUTER_STATE_FILE = stateFile;

  const handle = await startRouterIngressProcess({
    AUTODEV_ROUTER_INGRESS_CONTROL_SOCKET: controlSocket,
    AUTODEV_ROUTER_INGRESS_CONTROL_TOKEN: token,
    AUTODEV_ROUTER_RELEASES_DIRECTORY: releases,
    CODEX_HOME: codexHome,
    CODEX_MODEL_ROUTER_HOST: "127.0.0.1",
    CODEX_MODEL_ROUTER_PORT: "0",
    AUTODEV_CONTROL_API_LISTEN_HOST: "127.0.0.1",
    AUTODEV_CONTROL_API_LISTEN_PORT: "0",
    AUTODEV_XACPX_ORCHESTRATION_SOCKET: xacpxSocket,
    AUTODEV_ROUTER_INGRESS_DRAIN_MS: "10000"
  });

  try {
    const routerAddr = handle.ingress.server.address();
    const controlAddr = handle.controlApiServer?.address();
    assert.ok(routerAddr && typeof routerAddr !== "string");
    assert.ok(controlAddr && typeof controlAddr !== "string");
    const routerBase = `http://127.0.0.1:${routerAddr.port}`;
    const controlBase = `http://127.0.0.1:${controlAddr.port}`;

    // 1. Activate Generation A.
    const actA = await controlCall(controlSocket, token, "POST", "/v1/generations", {
      id: "gen-a",
      entry: entryA
    });
    assert.equal(actA.status, 200);

    // Register coordinator session on A via single public XACPX socket + open SSE stream + acquire 1 slot on A.
    const xacpxRegA = await xacpxRpc(xacpxSocket, "coordinator.register_external", {
      coordinatorSession: "coord-a"
    });
    assert.equal(xacpxRegA.ok, true);
    assert.equal((xacpxRegA.result as { generationId: string }).generationId, "gen-a");

    const streamA = await fetch(`${routerBase}/stream`);
    assert.equal(streamA.status, 200);
    const readerA = streamA.body!.getReader();
    assert.match(new TextDecoder().decode((await readerA.read()).value), /gen-a-open/u);

    // Patch concurrency cap = 2 through persistent Control API port (:4101).
    const patchRes = await fetch(`${controlBase}/control/runtime/concurrency`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrentThreadsPerSession: 2, revision: 1 })
    });
    assert.equal(patchRes.status, 200);
    const patchJson = (await patchRes.json()) as { revision: number; worker: string };
    assert.equal(patchJson.worker, "gen-a");
    assert.equal(patchJson.revision, 2);

    // Acquire 1 slot via Generation A.
    const slot1 = await (await fetch(`${routerBase}/acquire-slot`)).json() as {
      worker: string;
      denied: string | null;
      status: { activeSubagentThreads: number };
    };
    assert.equal(slot1.worker, "gen-a");
    assert.equal(slot1.denied, null);
    assert.equal(slot1.status.activeSubagentThreads, 1);

    // Cool provider on A and verify persistence file was written once cleanly.
    await fetch(`${routerBase}/cool-provider`);

    // 2. Cut over to Generation B while A stays alive retiring.
    const actB = await controlCall(controlSocket, token, "POST", "/v1/generations", {
      id: "gen-b",
      entry: entryB
    });
    assert.equal(actB.status, 200);

    // Generation B immediately sees A's cooldown, A's concurrency cap (2, rev 2), and A's active slot (1).
    const statusOnB = (await (await fetch(`${controlBase}/status`)).json()) as {
      worker: string;
      claudeCooling: boolean;
      concurrency: {
        effectivePerSessionLimit: number | null;
        activeSubagentThreads: number;
        revision: number;
      };
    };
    assert.equal(statusOnB.worker, "gen-b");
    assert.equal(statusOnB.claudeCooling, true);
    assert.equal(statusOnB.concurrency.effectivePerSessionLimit, 2);
    assert.equal(statusOnB.concurrency.revision, 2);
    assert.equal(statusOnB.concurrency.activeSubagentThreads, 1);

    // Acquiring 2nd slot on B hits global total 2; 3rd slot MUST be denied globally (limit not doubled to 4!).
    const slot2 = await (await fetch(`${routerBase}/acquire-slot`)).json() as {
      worker: string;
      denied: string | null;
      status: { activeSubagentThreads: number };
    };
    assert.equal(slot2.worker, "gen-b");
    assert.equal(slot2.denied, null);
    assert.equal(slot2.status.activeSubagentThreads, 2);

    const slot3 = await fetch(`${routerBase}/acquire-slot`);
    assert.equal(slot3.status, 429);

    // Persistent Control API :4101 now routes to B and rejects stale revision 1.
    const conflictRes = await fetch(`${controlBase}/control/runtime/concurrency`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxConcurrentThreadsPerSession: 5, revision: 1 })
    });
    assert.equal(conflictRes.status, 409);

    // XACPX IPC routes existing `coord-a` to gen-a (not split) while new `coord-b` hits gen-b.
    const xacpxWatchA = await xacpxRpc(xacpxSocket, "task.get", {
      coordinatorSession: "coord-a",
      taskId: "t-1"
    });
    assert.equal((xacpxWatchA.result as { generationId: string; known: boolean }).generationId, "gen-a");
    assert.equal((xacpxWatchA.result as { generationId: string; known: boolean }).known, true);

    const xacpxRegB = await xacpxRpc(xacpxSocket, "coordinator.register_external", {
      coordinatorSession: "coord-b"
    });
    assert.equal((xacpxRegB.result as { generationId: string }).generationId, "gen-b");

    // 3. A's HTTP request is done, but its live XACPX coordinator must
    // retain the predecessor until the generation drain deadline.
    await readerA.cancel();
    assert.equal(
      (await controlCall(controlSocket, token, "GET", "/v1/generations/gen-a/retirement")).status,
      202
    );
    const afterStream = await xacpxRpc(xacpxSocket, "task.get", {
      coordinatorSession: "coord-a",
      taskId: "t-1"
    });
    assert.deepEqual(afterStream.result, {
      generationId: "gen-a", coordinatorSession: "coord-a", known: true
    });
    // The IPC protocol has no coordinator-close RPC, so the bounded drain
    // deadline is the explicit termination boundary.
    const deadline = performance.now() + 15_000;
    let retired = false;
    while (performance.now() < deadline) {
      const retire = await controlCall(
        controlSocket,
        token,
        "GET",
        "/v1/generations/gen-a/retirement"
      );
      if (retire.status === 200) {
        retired = true;
        break;
      }
      assert.equal(retire.status, 202);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(retired, true, "predecessor must retire at its bounded deadline");
    const postRetireStatus = (await (await fetch(`${controlBase}/status`)).json()) as {
      concurrency: { activeSubagentThreads: number };
    };
    assert.equal(
      postRetireStatus.concurrency.activeSubagentThreads,
      1,
      "gen-a retirement must purge only gen-a slots while preserving gen-b's active slot"
    );

    // Single authoritative persistence file on disk holds the committed limit & hard cooldown.
    const persisted = JSON.parse(await readFile(stateFile, "utf8")) as {
      concurrency?: { storedLimit?: number; revision?: number };
      providerCooldowns?: Array<{ provider: string }>;
    };
    assert.equal(persisted.concurrency?.storedLimit, 2);
    assert.equal(persisted.concurrency?.revision, 2);
    assert.ok(persisted.providerCooldowns?.some((entry) => entry.provider === "claude"));
    void REPO_ROOT;
  } finally {
    if (prevStateFile === undefined) delete process.env.CODEX_ROUTER_STATE_FILE;
    else process.env.CODEX_ROUTER_STATE_FILE = prevStateFile;
    await handle.close();
    await rm(root, { recursive: true, force: true });
    await rm(socketDir, { recursive: true, force: true });
  }
});
