import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { codexState } from "@simulatorlife/autodev-runtime/router/http";

test("control-only listener exposes only authenticated Control API routes", async () => {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousViewers = process.env.AUTODEV_CONTROL_VIEWERS;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN =
    "control-listener-test-token-0123456789abcdef";
  process.env.AUTODEV_CONTROL_VIEWERS = "control-viewer";
  process.env.AUTODEV_CONTROL_OPERATORS = "";
  const { createControlApiServer } =
    await import("@simulatorlife/autodev-runtime/router/server");
  const server = createControlApiServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const rejected = await fetch(`${baseUrl}/control/providers`);
    assert.equal(rejected.status, 401);
    const allowed = await fetch(`${baseUrl}/control/providers`, {
      headers: {
        authorization: "Bearer control-listener-test-token-0123456789abcdef",
        "x-autodev-actor": "control-viewer"
      }
    });
    assert.equal(allowed.status, 200);
    const body = (await allowed.json()) as { schema?: string };
    assert.equal(body.schema, "autodev-control-providers-v2");
    const nonControl = await fetch(`${baseUrl}/v1/responses`);
    assert.equal(nonControl.status, 404);
  } finally {
    if (server.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousViewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = previousViewers;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
  }
});

test("OpenLIT mode starts a separate listener that cannot serve model routes", async () => {
  const prior = {
    host: process.env.AUTODEV_CONTROL_API_LISTEN_HOST,
    port: process.env.AUTODEV_CONTROL_API_LISTEN_PORT,
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    viewers: process.env.AUTODEV_CONTROL_VIEWERS,
    operators: process.env.AUTODEV_CONTROL_OPERATORS
  };
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const reservationAddress = reservation.address();
  assert.ok(reservationAddress && typeof reservationAddress === "object");
  const controlPort = reservationAddress.port;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });

  process.env.AUTODEV_CONTROL_API_LISTEN_HOST = "127.0.0.1";
  process.env.AUTODEV_CONTROL_API_LISTEN_PORT = String(controlPort);
  process.env.AUTODEV_CONTROL_API_TOKEN =
    "integrated-control-listener-token-0123456789";
  process.env.AUTODEV_CONTROL_VIEWERS = "control-viewer";
  process.env.AUTODEV_CONTROL_OPERATORS = "";
  let server: Server | undefined;
  try {
    const { startRouterServer } =
      await import("@simulatorlife/autodev-runtime/router/server");
    server = startRouterServer(0, "127.0.0.1");
    await once(server, "listening");

    const baseUrl = `http://127.0.0.1:${controlPort}`;
    const authorized = await fetch(`${baseUrl}/control/providers`, {
      headers: {
        authorization: "Bearer integrated-control-listener-token-0123456789",
        "x-autodev-actor": "control-viewer"
      }
    });
    assert.equal(authorized.status, 200);
    const excluded = await fetch(`${baseUrl}/v1/responses`);
    assert.equal(excluded.status, 404);
  } finally {
    if (server?.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
    for (const [key, value] of Object.entries({
      AUTODEV_CONTROL_API_LISTEN_HOST: prior.host,
      AUTODEV_CONTROL_API_LISTEN_PORT: prior.port,
      AUTODEV_CONTROL_API_TOKEN: prior.token,
      AUTODEV_CONTROL_VIEWERS: prior.viewers,
      AUTODEV_CONTROL_OPERATORS: prior.operators
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("router server removes its process handlers with the listener", async () => {
  const processEvents = [
    "uncaughtException",
    "unhandledRejection",
    "SIGINT",
    "SIGTERM"
  ] as const;
  const listenerCounts = new Map(
    processEvents.map((event) => [event, process.listenerCount(event)])
  );
  const previousLivePollStarted = codexState.livePollStarted;
  let server: Server | undefined;

  try {
    const { startRouterServer } =
      await import("@simulatorlife/autodev-runtime/router/server");
    server = startRouterServer(0, "127.0.0.1");
    await once(server, "listening");
    assert.equal(codexState.livePollStarted, true);

    const closed = once(server, "close");
    server.close();
    await closed;
    assert.equal(codexState.livePollStarted, false);
    for (const event of processEvents)
      assert.equal(process.listenerCount(event), listenerCounts.get(event));
  } finally {
    if (server?.listening) {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
    codexState.collector.stopLivePoll();
    codexState.livePollStarted = previousLivePollStarted;
  }
});
