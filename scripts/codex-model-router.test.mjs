import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { catalogModelIds, clearProviderCooldown, cooldownProvider, fallbackable, isProviderCoolingDown, replaceModelFields, responseTextFromSse, roleCandidates, roleForModel, routeForModel, transformSseEvent, validateRoutingConfig } from "./codex-model-router.mjs";

test("loads editable provider and role models from JSON routing config", async () => {
  const config = JSON.parse(await readFile(new URL("./codex/model-routing.json", import.meta.url), "utf8"));
  assert.equal(config.providers.claude.models.smart, "claude-opus-4-8");
  assert.equal(config.providers.codex.models.smart, "gpt-5.6-sol");
  assert.equal(config.providers.minimax.models.smart, undefined);
  assert.equal(config.providers.copilot.models.smart, undefined);
  assert.deepEqual(config.providerGroups.default, [["claude", "antigravity", "minimax"], ["copilot"], ["codex"]]);
  assert.deepEqual(config.providerGroups.smart, [["claude", "antigravity"], ["codex"]]);
  assert.equal(config.roles.worker.tier, "default");
  assert.equal(config.roles.smart.tier, "smart");
});

test("validates routing config and requires default model for providers", () => {
  const validConfig = {
    providerGroups: {
      default: [["testProvider"], ["fallbackProvider"]],
      smart: [["testProvider"], ["fallbackProvider"]],
    },
    providers: {
      testProvider: { models: { default: "test-model" } },
      fallbackProvider: { models: { default: "fallback-model" } },
    },
    roles: {
      default: { tier: "default" },
      "docs-researcher": { tier: "default" },
      "browser-tester": { tier: "default" },
      explorer: { tier: "default" },
      worker: { tier: "default" },
      validator: { tier: "default" },
      smart: { tier: "smart" },
    },
  };
  assert.doesNotThrow(() => validateRoutingConfig(validConfig));

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, providers: { testProvider: { models: {} } } }),
    /Routing config provider testProvider must define a default model/
  );

  assert.throws(
    () => validateRoutingConfig({ ...validConfig, providerGroups: { default: [[]], smart: [["testProvider"]] } }),
    /Routing config tier default contains an invalid provider group/
  );
});

test("routes supported model families without provider aliases", () => {
  assert.equal(routeForModel("gpt-5.6-luna")?.provider, "codex");
  assert.equal(routeForModel("sonnet")?.provider, "claude");
  assert.equal(routeForModel("MiniMax-M3")?.provider, "minimax");
  assert.equal(routeForModel("gemini-3.6-flash-medium")?.provider, "antigravity");
  assert.equal(routeForModel("unknown-model"), null);
});

test("resolves role aliases through tier-specific randomized provider groups with smart model fallback", () => {
  assert.equal(roleForModel("autodev/explorer"), "explorer");

  const explorerCandidates = roleCandidates("explorer", () => 0.5);
  const explorerProviders = explorerCandidates.map((c) => c.provider);
  assert.deepEqual(explorerProviders.slice(0, 3).sort(), ["antigravity", "claude", "minimax"]);
  assert.deepEqual(explorerProviders.slice(3), ["copilot", "codex"]);

  const smartCandidates = roleCandidates("smart", () => 0.5);
  const smartProviders = smartCandidates.map((c) => c.provider);
  assert.deepEqual(smartProviders.slice(0, 2).sort(), ["antigravity", "claude"]);
  assert.deepEqual(smartProviders.slice(2), ["codex"]);

  const smartModelMap = Object.fromEntries(smartCandidates.map((c) => [c.provider, c.model]));
  assert.equal(smartModelMap.antigravity, "gemini-3.6-flash-high");
  assert.equal(smartModelMap.claude, "claude-opus-4-8");
  assert.equal(smartModelMap.codex, "gpt-5.6-sol");

  assert.notDeepEqual(
    roleCandidates("smart", () => 0).slice(0, 2).map((candidate) => candidate.provider),
    roleCandidates("smart", () => 0.999).slice(0, 2).map((candidate) => candidate.provider),
  );
});

test("classifies provider exhaustion and transient responses for fallback", () => {
  assert.equal(fallbackable(429, "session limit reached"), true);
  assert.equal(fallbackable(503, "unavailable"), true);
  assert.equal(fallbackable(400, "Invalid model name passed in model=gemini-3.6-flash-high"), true);
  assert.equal(fallbackable(400, "malformed request"), false);
});

test("temporarily omits providers after a fallbackable limit or outage", () => {
  const now = 1000;
  cooldownProvider("minimax", now);
  assert.equal(isProviderCoolingDown("minimax", now + 1), true);
  assert.equal(isProviderCoolingDown("minimax", now + 30_000), false);
  clearProviderCooldown("minimax");
  assert.equal(isProviderCoolingDown("minimax", now), false);
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


test("deduplicates catalog models and keeps role aliases visible", () => {
  const ids = catalogModelIds([{ slug: "gpt-5.6-luna" }, { slug: "gpt-5.6-luna" }], ["autodev/explorer"]);
  assert.deepEqual(ids, ["gpt-5.6-luna", "autodev/explorer"]);
});

test("rewrites the routed provider model back to the public role alias", () => {
  const value = replaceModelFields({ model: "gemini-3.6-flash-medium", nested: [{ model: "gemini-3.6-flash-medium" }] }, "autodev/explorer");
  assert.deepEqual(value, { model: "autodev/explorer", nested: [{ model: "autodev/explorer" }] });

  const event = transformSseEvent('data: {"type":"response.completed","response":{"model":"gemini-3.6-flash-medium"},"model":"gemini-3.6-flash-medium"}\n\n', "autodev/explorer");
  assert.match(event, /autodev\/explorer/);
  assert.equal((event.match(/autodev\/explorer/g) ?? []).length, 2);
});
