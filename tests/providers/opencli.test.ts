import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  createOpencliHealthServer,
  processRunner,
  routedSiteTabs
} from "@simulatorlife/autodev-runtime/providers/opencli";
import {
  type OpencliBrowser,
  type OpencliRunOptions,
  OpencliSitePageNotOpenError
} from "@simulatorlife/autodev-runtime/providers/opencli-browser";
import {
  CHATGPT_MODELS,
  geminiConversationId,
  geminiModelLimit,
  OpencliCommandError,
  parseOpencliOutput,
  replyFromRow
} from "@simulatorlife/autodev-runtime/providers/opencli-turn";
import { ROUTES } from "@simulatorlife/autodev-runtime/router/routing";

test("opencli health server reports liveliness, browser errors, and discovered models without /v1/responses", async () => {
  let isBrowserReady = true;
  const health = createOpencliHealthServer({
    browserHealth: () =>
      isBrowserReady
        ? { ready: true, error: null }
        : { ready: false, error: "dedicated Chrome missing" },
    run: async ({ args }) => {
      if (args[0] === "gemini" && args[1] === "models") {
        return [{ model: "3.1-pro" }, { model: "3.1-flash" }];
      }
      return [];
    }
  });
  const server = createServer((request, res) => {
    void health.handle(request, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const liveOk = await fetch(`http://127.0.0.1:${port}/health/liveliness`);
    assert.equal(liveOk.status, 200);

    const modelsResp = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(modelsResp.status, 200);
    const modelsJson = (await modelsResp.json()) as {
      data: { id: string }[];
    };
    assert.ok(
      modelsJson.data.some((entry) => entry.id === "opencli-gemini-3.1-pro")
    );
    assert.ok(
      modelsJson.data.some((entry) => entry.id === "opencli-chatgpt-balanced")
    );

    isBrowserReady = false;
    const liveFail = await fetch(`http://127.0.0.1:${port}/health/liveliness`);
    assert.equal(liveFail.status, 503);

    const responsesResp = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: "POST",
      body: "{}"
    });
    assert.equal(responsesResp.status, 404);
  } finally {
    server.close();
  }
});

test("model discovery reads Gemini only from an open page and never opens one", async () => {
  const requests: {
    args: readonly string[];
    existingPageOnly: boolean | undefined;
  }[] = [];
  let isGeminiOpen = false;
  const health = createOpencliHealthServer({
    run: async ({ args, existingPageOnly }) => {
      requests.push({ args, existingPageOnly });
      if (!isGeminiOpen) throw new OpencliSitePageNotOpenError("gemini");
      return [{ model: "3.1-pro" }];
    }
  });
  const server = createServer((request, response) => {
    void health.handle(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as AddressInfo).port;
    const list = async (): Promise<string[]> => {
      const response = await fetch(
        `http://127.0.0.1:${port}/v1/models?provider=opencli-gemini`
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: { id: string }[] };
      return body.data.map((entry) => entry.id);
    };
    // No Gemini page: the listing is empty (the Runtime keeps its last list).
    assert.deepEqual(await list(), []);
    isGeminiOpen = true;
    assert.deepEqual(await list(), ["opencli-gemini-3.1-pro"]);
    assert.ok(requests.length === 2);
    assert.ok(requests.every((request) => request.existingPageOnly === true));
  } finally {
    server.close();
  }
});

test("the process runner opens site pages for turns but not for probes", async () => {
  const calls: OpencliRunOptions[] = [];
  const browser = {
    run: async (
      _site: string,
      _signal: AbortSignal,
      _command: unknown,
      options: OpencliRunOptions
    ) => {
      calls.push(options);
      return [];
    },
    close: async () => undefined
  } as unknown as OpencliBrowser;
  const run = processRunner(
    () => ({ command: "opencli", args: [] }),
    { chatgpt: 1, gemini: 1 },
    new Set(),
    browser
  );
  await run({
    args: ["gemini", "ask", "hi"],
    signal: AbortSignal.timeout(1000)
  });
  await run({
    args: ["gemini", "models"],
    signal: AbortSignal.timeout(1000),
    existingPageOnly: true
  });
  assert.equal(calls[0]?.shouldOpenPage, true);
  assert.equal(calls[1]?.shouldOpenPage, false);
});

test("routedSiteTabs derive from ROUTES", () => {
  const tabs = routedSiteTabs(ROUTES);
  assert.ok(tabs.chatgpt >= 1);
  assert.ok(tabs.gemini >= 1);
});

test("opencli output parsing, conversation id extraction, and limit helpers behave deterministically", () => {
  assert.deepEqual(
    parseOpencliOutput('{"ok":true,"data":[{"response":"hello"}]}', 0),
    [{ response: "hello" }]
  );
  assert.throws(
    () =>
      parseOpencliOutput(
        '{"ok":false,"error":{"code":"AUTH_REQUIRED","message":"Sign in"}}',
        1
      ),
    (error: unknown) =>
      error instanceof OpencliCommandError && error.code === "AUTH_REQUIRED"
  );
  assert.deepEqual(
    replyFromRow({ response: "done", conversationId: "conv-1" }),
    { response: "done", conversationId: "conv-1" }
  );
  assert.equal(
    geminiConversationId("https://gemini.google.com/app/abc123def"),
    "abc123def"
  );
  assert.ok(CHATGPT_MODELS.includes("balanced"));
  const limited = geminiModelLimit(
    new OpencliCommandError(
      'Gemini model "3.1-pro" is out of usage: Limit resets Nov 9, 9:26 PM',
      "MODEL_LIMIT",
      1
    ),
    Date.UTC(2026, 10, 1, 12, 0, 0)
  );
  assert.ok(limited);
  assert.match(limited.message, /Gemini usage limit reached for 3\.1-pro/u);
  assert.equal(typeof processRunner, "function");
});
