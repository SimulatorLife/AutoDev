import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";

import { warmupDefaultPlaytestingRepository } from "../src/control-api/index.ts";
import { handlePlaytestingControlApiRequest } from "../src/control-api/playtesting.ts";
import { codexState } from "../src/router/http.ts";
import { startRouterServer } from "../src/router/server.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

test("GET-only Playtesting readiness drains a rejected request body", async () => {
  const requestBody = makeRequest(
    "POST",
    "/control/playtesting/readiness?workspaceId=fixture/game",
    { ignored: "body" }
  );
  const bodyConsumed = once(requestBody, "end");
  const response = responseRecorder();
  await handlePlaytestingControlApiRequest(
    requestBody,
    response,
    "/control/playtesting/readiness",
    { actor: "warmup-viewer", role: "viewer" }
  );
  await bodyConsumed;
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "GET");
});

test("GET-only Playtesting routes drain rejected request bodies", async () => {
  for (const pathname of [
    "/control/playtesting/readiness",
    "/control/playtesting/batches"
  ]) {
    const url = `${pathname}?workspaceId=fixture%2Fgame`;
    const incoming = makeRequest("POST", url, { ignored: "body" });
    const drained = once(incoming, "end");
    const response = responseRecorder();
    await handlePlaytestingControlApiRequest(incoming, response, pathname, {
      actor: "warmup-viewer",
      role: "viewer"
    });
    await drained;
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, "GET");
  }
});

test(
  "router startup warms the shared Playtesting schema without blocking other routes",
  { timeout: 10_000 },
  async () => {
    const env = {
      CLICKHOUSE_URL: process.env.CLICKHOUSE_URL,
      AUTODEV_CONTROL_API_TOKEN: process.env.AUTODEV_CONTROL_API_TOKEN,
      AUTODEV_CONTROL_VIEWERS: process.env.AUTODEV_CONTROL_VIEWERS,
      AUTODEV_CONTROL_OPERATORS: process.env.AUTODEV_CONTROL_OPERATORS,
      AUTODEV_CONTROL_API_LISTEN_HOST:
        process.env.AUTODEV_CONTROL_API_LISTEN_HOST,
      AUTODEV_CONTROL_API_LISTEN_PORT:
        process.env.AUTODEV_CONTROL_API_LISTEN_PORT
    };
    const nativeFetch = globalThis.fetch;
    const nativeStderrWrite = process.stderr.write;
    const stderrChunks: string[] = [];
    const clickhouseQueries: string[] = [];
    let releaseSchema!: () => void;
    let signalFirstQuery!: () => void;
    let schemaReleased = false;
    const schemaGate = new Promise<void>((resolve) => {
      releaseSchema = resolve;
    });
    const firstQueryStarted = new Promise<void>((resolve) => {
      signalFirstQuery = resolve;
    });
    let router: Server | undefined;

    process.env.CLICKHOUSE_URL = "http://clickhouse.test:8123";
    process.env.AUTODEV_CONTROL_API_TOKEN = "";
    process.env.AUTODEV_CONTROL_VIEWERS = "";
    process.env.AUTODEV_CONTROL_OPERATORS = "warmup-operator";
    delete process.env.AUTODEV_CONTROL_API_LISTEN_HOST;
    delete process.env.AUTODEV_CONTROL_API_LISTEN_PORT;
    globalThis.fetch = async (input, init) => {
      const url =
        input instanceof URL
          ? input
          : new URL(typeof input === "string" ? input : input.url);
      if (url.hostname === "clickhouse.test") {
        const query = url.searchParams.get("query") ?? "";
        const schemaSucceeds = schemaReleased;
        clickhouseQueries.push(query);
        if (clickhouseQueries.length === 1) signalFirstQuery();
        if (!schemaSucceeds) {
          await schemaGate;
          throw new Error("sensitive ClickHouse response details");
        }
        return query.includes("count() AS total")
          ? new Response('{"total":"0"}\n', { status: 200 })
          : new Response("", { status: 200 });
      }
      return nativeFetch(input, init);
    };
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      );
      return true;
    }) as typeof process.stderr.write;

    const readOptions = {
      readWorkspaceCatalog: () => ({
        status: "valid" as const,
        workspaces: [
          {
            id: "fixture/game",
            baseBranch: "main",
            enabled: true,
            agentRoles: null
          }
        ]
      })
    };

    try {
      router = startRouterServer(0, "127.0.0.1");
      await once(router, "listening");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        clickhouseQueries.length,
        0,
        "a Runtime without its Control API must not initialize Playtesting Data"
      );
      const disabledRouter = router;
      const disabledRouterClosed = once(disabledRouter, "close");
      disabledRouter.close();
      await disabledRouterClosed;
      router = undefined;
      codexState.collector.stopLivePoll();
      codexState.livePollStarted = false;

      process.env.AUTODEV_CONTROL_API_TOKEN =
        "playtesting-warmup-control-token-0123456789";
      process.env.AUTODEV_CONTROL_VIEWERS = "warmup-viewer";
      process.env.AUTODEV_CONTROL_OPERATORS = "warmup-operator";
      router = startRouterServer(0, "127.0.0.1");
      await once(router, "listening");
      await firstQueryStarted;

      const startupInitialization = warmupDefaultPlaytestingRepository();
      assert.strictEqual(
        warmupDefaultPlaytestingRepository(),
        startupInitialization,
        "startup and later callers must observe the same in-flight initialization"
      );
      const startupDdlCount = clickhouseQueries.length;
      assert.ok(startupDdlCount > 0, "router startup must begin schema DDL");

      const routerAddress = router.address();
      assert.ok(routerAddress && typeof routerAddress === "object");
      const providersResponse = await nativeFetch(
        `http://127.0.0.1:${routerAddress.port}/control/providers`,
        {
          headers: {
            authorization: "Bearer playtesting-warmup-control-token-0123456789",
            "x-autodev-actor": "warmup-viewer"
          }
        }
      );
      assert.equal(providersResponse.status, 200);

      const pendingReadinessResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          "/control/playtesting/readiness?workspaceId=fixture/game"
        ),
        pendingReadinessResponse,
        "/control/playtesting/readiness",
        { actor: "warmup-viewer", role: "viewer" },
        readOptions
      );
      assert.equal(pendingReadinessResponse.statusCode, 200);
      assert.equal(
        (responseBody(pendingReadinessResponse) as { status: string }).status,
        "initializing"
      );

      const pendingReadResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          "/control/playtesting/batches?workspaceId=fixture/game"
        ),
        pendingReadResponse,
        "/control/playtesting/batches",
        { actor: "warmup-viewer", role: "viewer" },
        readOptions
      );
      assert.equal(pendingReadResponse.statusCode, 503);
      assert.equal(
        (responseBody(pendingReadResponse)?.error as { code: string }).code,
        "autodev_control_playtesting_source_initializing"
      );
      assert.equal(pendingReadResponse.headers["retry-after"], "1");
      assert.equal(
        clickhouseQueries.length,
        startupDdlCount,
        "the pending-read response must not start duplicate schema work"
      );

      schemaReleased = true;
      releaseSchema();
      await startupInitialization.catch(() => undefined);

      const failedReadinessResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          "/control/playtesting/readiness?workspaceId=fixture/game"
        ),
        failedReadinessResponse,
        "/control/playtesting/readiness",
        { actor: "warmup-viewer", role: "viewer" },
        readOptions
      );
      assert.equal(failedReadinessResponse.statusCode, 503);
      assert.equal(
        (responseBody(failedReadinessResponse)?.error as { code: string }).code,
        "autodev_control_playtesting_source_unavailable"
      );

      const failedAttemptQueryCount = clickhouseQueries.length;
      const readRoutePostResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "POST",
          "/control/playtesting/readiness?workspaceId=fixture/game"
        ),
        readRoutePostResponse,
        "/control/playtesting/readiness",
        { actor: "warmup-operator", role: "operator" },
        readOptions
      );
      assert.equal(readRoutePostResponse.statusCode, 405);
      assert.equal(clickhouseQueries.length, failedAttemptQueryCount);

      const viewerRetryResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "POST",
          "/control/playtesting/initialize?workspaceId=fixture/game"
        ),
        viewerRetryResponse,
        "/control/playtesting/initialize",
        { actor: "warmup-viewer", role: "viewer" },
        readOptions
      );
      assert.equal(viewerRetryResponse.statusCode, 403);
      assert.equal(clickhouseQueries.length, failedAttemptQueryCount);

      const retryResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "POST",
          "/control/playtesting/initialize?workspaceId=fixture/game"
        ),
        retryResponse,
        "/control/playtesting/initialize",
        { actor: "warmup-operator", role: "operator" },
        readOptions
      );
      assert.equal(retryResponse.statusCode, 200);
      assert.equal(
        (responseBody(retryResponse) as { status: string }).status,
        "initializing"
      );
      await warmupDefaultPlaytestingRepository();
      assert.ok(
        clickhouseQueries.length > failedAttemptQueryCount,
        "an explicit operator retry must repeat Data's schema initialization"
      );
      assert.equal(
        clickhouseQueries[failedAttemptQueryCount],
        clickhouseQueries[0],
        "the retry must repeat Data's schema initialization"
      );

      const readyResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          "/control/playtesting/readiness?workspaceId=fixture/game"
        ),
        readyResponse,
        "/control/playtesting/readiness",
        { actor: "warmup-viewer", role: "viewer" },
        readOptions
      );
      assert.equal(readyResponse.statusCode, 200);
      assert.equal(
        (responseBody(readyResponse) as { status: string }).status,
        "ready"
      );
      const retryReadResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          "/control/playtesting/batches?workspaceId=fixture/game"
        ),
        retryReadResponse,
        "/control/playtesting/batches",
        { actor: "warmup-viewer", role: "viewer" },
        readOptions
      );
      assert.equal(retryReadResponse.statusCode, 200);
      assert.equal(
        (responseBody(retryReadResponse)?.page as { total: number }).total,
        0
      );

      const providersAfterFailure = await nativeFetch(
        `http://127.0.0.1:${routerAddress.port}/control/providers`,
        {
          headers: {
            authorization: "Bearer playtesting-warmup-control-token-0123456789",
            "x-autodev-actor": "warmup-viewer"
          }
        }
      );
      assert.equal(providersAfterFailure.status, 200);

      await new Promise<void>((resolve) => setImmediate(resolve));
      const startupLog = stderrChunks.join("");
      assert.match(startupLog, /Playtesting schema startup warmup failed/u);
      assert.doesNotMatch(startupLog, /sensitive ClickHouse response details/u);
    } finally {
      if (!schemaReleased) releaseSchema();
      if (router?.listening) {
        const closed = once(router, "close");
        router.close();
        await closed;
      }
      codexState.collector.stopLivePoll();
      codexState.livePollStarted = false;
      globalThis.fetch = nativeFetch;
      process.stderr.write = nativeStderrWrite;
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
);
