import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../app/api/console/search/route.ts";

async function withSearchRoute(
  token: string | null,
  respond: (url: string) => Response
): Promise<{
  readonly response: Response;
  readonly requests: readonly string[];
}> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousBase = process.env.AUTODEV_CONTROL_API_BASE_URL;
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const requests: string[] = [];
  if (token === null) {
    delete process.env.AUTODEV_CONTROL_API_TOKEN;
    process.env.HOME = "";
    delete process.env.CODEX_HOME;
  } else process.env.AUTODEV_CONTROL_API_TOKEN = token;
  process.env.AUTODEV_CONTROL_API_BASE_URL = "http://control.test";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    return respond(url);
  }) as typeof fetch;
  try {
    return { response: await GET(), requests };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousBase === undefined) {
      delete process.env.AUTODEV_CONTROL_API_BASE_URL;
    } else process.env.AUTODEV_CONTROL_API_BASE_URL = previousBase;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

test("console search API identifies partial failures and returns the available canonical source", async () => {
  const { response, requests } = await withSearchRoute(
    "search-test-token",
    (url) =>
      url.endsWith("/control/models")
        ? Response.json({
            schema: "autodev-control-models-v2",
            source: "fixture",
            models: []
          })
        : Response.json({ schema: "unrecognized" })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.unavailableSources, [
    "providers",
    "agentRoles",
    "workspaces"
  ]);
  assert.equal(body.models.schema, "autodev-control-models-v2");
  assert.deepEqual([...requests].sort(), [
    "http://control.test/control/agents",
    "http://control.test/control/models",
    "http://control.test/control/providers",
    "http://control.test/control/workspaces"
  ]);
});

test("console search API reports total source and configuration failure", async () => {
  const failedReads = await withSearchRoute("search-test-token", () =>
    Response.json({ schema: "unrecognized" })
  );
  assert.equal(failedReads.response.status, 503);
  assert.deepEqual((await failedReads.response.json()).unavailableSources, [
    "providers",
    "models",
    "agentRoles",
    "workspaces"
  ]);

  const missingConfiguration = await withSearchRoute(null, () => {
    throw new Error("configuration must prevent a request");
  });
  assert.equal(missingConfiguration.response.status, 503);
  assert.deepEqual(
    (await missingConfiguration.response.json()).unavailableSources,
    ["configuration", "providers", "models", "agentRoles", "workspaces"]
  );
  assert.deepEqual(missingConfiguration.requests, []);
});
