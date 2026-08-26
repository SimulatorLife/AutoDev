import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fallbackable, responseTextFromSse, roleCandidates, roleForModel, routeForModel } from "./codex-model-router.mjs";

test("loads editable provider and role models from JSON routing config", async () => {
  const config = JSON.parse(await readFile(new URL("./codex/model-routing.json", import.meta.url), "utf8"));
  assert.equal(config.providers.claude.models.smart, "claude-opus-4-8");
  assert.equal(config.providers.codex.models.smart, "gpt-5.6-sol");
  assert.deepEqual(config.providerPriority, ["antigravity", "claude", "minimax", "copilot", "codex"]);
  assert.equal(config.roles.worker.tier, "default");
  assert.equal(config.roles.smart.tier, "smart");
});

test("routes supported model families without provider aliases", () => {
  assert.equal(routeForModel("gpt-5.6-luna")?.provider, "codex");
  assert.equal(routeForModel("sonnet")?.provider, "claude");
  assert.equal(routeForModel("MiniMax-M3")?.provider, "minimax");
  assert.equal(routeForModel("gemini-3.6-flash-medium")?.provider, "antigravity");
  assert.equal(routeForModel("unknown-model"), null);
});

test("resolves role aliases through the provider priority order", () => {
  assert.equal(roleForModel("autodev/explorer"), "explorer");
  const providers = roleCandidates("explorer").map((route) => route.provider);
  assert.deepEqual(providers, ["antigravity", "claude", "minimax", "copilot", "codex"]);
  assert.equal(roleCandidates("explorer")[0].model, "gemini-3.6-flash-medium");
  assert.equal(roleCandidates("smart")[0].model, "gemini-3.7-flash-high");
});

test("classifies provider exhaustion and transient responses for fallback", () => {
  assert.equal(fallbackable(429, "session limit reached"), true);
  assert.equal(fallbackable(503, "unavailable"), true);
  assert.equal(fallbackable(400, "malformed request"), false);
});

test("extracts text from a Responses SSE completion", () => {
  const body = [
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"router"}',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"-ok"}',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output_text":"router-ok"}}',
    "data: [DONE]",
    "",
  ].join("\n");
  const response = responseTextFromSse(body);
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "router-ok");
  assert.equal(response.output[0].content[0].text, "router-ok");
});
