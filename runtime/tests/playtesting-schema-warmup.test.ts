import assert from "node:assert/strict";
import { once } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import test from "node:test";

import {
  handlePlaytestingControlApiRequest,
  warmupDefaultPlaytestingRepository
} from "../src/control-api/playtesting.ts";
import { startRouterServer } from "../src/router/server.ts";
import { codexState } from "../src/router/http.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

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
    process.env.AUTODEV_CONTROL_OPERATORS = "";
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
      process.env.AUTODEV_CONTROL_OPERATORS = "";
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

      const readResponse = responseRecorder();
      let readFinished = false;
      const firstRead = handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          "/control/playtesting/batches?workspaceId=fixture/game"
        ),
        readResponse,
        "/control/playtesting/batches",
        { actor: "warmup-viewer", role: "viewer" },
        readOptions
      ).then(() => {
        readFinished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        readFinished,
        false,
        "the read should share the pending warmup"
      );
      assert.equal(
        clickhouseQueries.length,
        startupDdlCount,
        "the overlapping read must not start duplicate DDL"
      );

      schemaReleased = true;
      releaseSchema();
      await firstRead;
      assert.equal(readResponse.statusCode, 503);
      assert.equal(
        (responseBody(readResponse)?.error as { code: string }).code,
        "autodev_control_playtesting_source_unavailable"
      );

      const failedAttemptQueryCount = clickhouseQueries.length;
      const retryResponse = responseRecorder();
      await handlePlaytestingControlApiRequest(
        makeRequest(
          "GET",
          "/control/playtesting/batches?workspaceId=fixture/game"
        ),
        retryResponse,
        "/control/playtesting/batches",
        { actor: "warmup-viewer", role: "viewer" },
        readOptions
      );
      assert.equal(retryResponse.statusCode, 200);
      assert.ok(
        clickhouseQueries.length > failedAttemptQueryCount,
        "a failed schema initialization must be reset so a later read can retry"
      );
      assert.equal(
        clickhouseQueries[failedAttemptQueryCount],
        clickhouseQueries[0],
        "the retry must repeat Data's schema initialization"
      );
      assert.equal(
        (responseBody(retryResponse)?.page as { total: number }).total,
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
