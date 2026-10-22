import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverClaudeModels,
  parseAnthropicModelList,
  parseCodexModelList
} from "@simulatorlife/autodev-runtime/providers/model-discovery";

/**
 * The Anthropic listing reports the models the signed-in Claude account can
 * run. A model the account cannot run is not a choice an operator may assign
 * to a role, so the Runtime has to observe the account's own list.
 */
test("the Claude model list reports the account's models", () => {
  const models = parseAnthropicModelList({
    data: [
      { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
      { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }
    ]
  });
  assert.deepEqual(models, [
    { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
    { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" }
  ]);
});

test("the Claude model list rejects a duplicate model ID", () => {
  assert.throws(
    () =>
      parseAnthropicModelList({
        data: [{ id: "claude-opus-5-5" }, { id: "claude-opus-5-5" }]
      }),
    /invalid or duplicate model ID/
  );
});

test("the Claude model list rejects a payload that is not a model list", () => {
  assert.throws(
    () => parseAnthropicModelList({ models: [] }),
    /did not contain a bounded models array/
  );
});

test("Claude discovery authenticates with the account's own OAuth token", async () => {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const models = await discoverClaudeModels(
    { CLAUDE_CODE_OAUTH_TOKEN: "account-oauth-token" },
    (async (url: string, init: { headers: Record<string, string> }) => {
      requests.push({ url: String(url), headers: init.headers });
      return Response.json({
        data: [{ id: "claude-opus-5-5", display_name: "Opus" }]
      });
    }) as unknown as typeof fetch
  );

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.headers.Authorization,
    "Bearer account-oauth-token"
  );
  assert.equal(requests[0]?.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(models, [{ id: "claude-opus-5-5", displayName: "Opus" }]);
});

test("Claude discovery reports a missing account credential instead of guessing", async () => {
  await assert.rejects(
    discoverClaudeModels(
      { CLAUDE_CODE_OAUTH_TOKEN: "" },
      (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch,
      undefined,
      () => ""
    ),
    /Claude Code OAuth token is not configured/
  );
});

/**
 * The Codex account listing carries each model's base instructions, tool
 * descriptors and message payloads. A six-model account response is already
 * around 310 KB, so a bound that only fits a compact ID list rejects every
 * refresh and leaves the Runtime with a stale Codex model list.
 */
test("the Codex model list tolerates an account-sized metadata payload", () => {
  const filler = "x".repeat(60_000);
  const models = parseCodexModelList({
    models: Array.from({ length: 6 }, (_, index) => ({
      slug: `gpt-6-model-${index}`,
      display_name: `GPT 6 Model ${index}`,
      visibility: "list",
      supported_in_api: true,
      base_instructions: filler,
      model_messages: filler
    }))
  });
  assert.equal(models.length, 6);
  assert.equal(models[0]?.id, "gpt-6-model-0");
});
