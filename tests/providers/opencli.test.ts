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
  CHATGPT_MODELS,
  geminiConversationId,
  geminiModelLimit,
  OpencliCommandError,
  parseOpencliOutput,
  replyFromRow
} from "@simulatorlife/autodev-runtime/providers/opencli-turn";
import { ROUTES } from "@simulatorlife/autodev-runtime/router/routing";

test("opencli health server reports liveliness, browser errors, and discovered models without /v1/responses", async () => {
  let browserReady = true;
  const health = createOpencliHealthServer({
    browserHealth: () =>
      browserReady
        ? { ready: true, error: null }
        : { ready: false, error: "dedicated Chrome missing" },
    run: async ({ args }) => {
      if (args[0] === "gemini" && args[1] === "models") {
        return [{ model: "3.1-pro" }, { model: "3.1-flash" }];
      }
      return [];
    }
  });
  const server = createServer((req, res) => {
    void health.handle(req, res);
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

    browserReady = false;
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
    (err: unknown) =>
      err instanceof OpencliCommandError && err.code === "AUTH_REQUIRED"
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
