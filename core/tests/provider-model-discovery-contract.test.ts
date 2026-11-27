import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_API_PROVIDER_MODEL_DISCOVERY_SCHEMA_ID,
  controlApiProviderModelsResponseSchema
} from "../src/control-api/provider-model-discovery.ts";

/**
The provider model discovery contract.

The Runtime produces this response, the Console reads it, and the Console's
startup preflight checks that the Runtime it is about to talk to speaks the
same contract. All three used to spell it between them, and the two
spellings did not agree. One schema, owned by Core, now answers for all of
them -- so these tests are the contract, and a reader that accepts a
response a preflight would refuse is a bug in the reader.
*/
const OBSERVED_AT = "2026-11-26T12:00:00.000Z";

const GPT_5 = {
  id: "gpt-5",
  displayName: null,
  routeability: { status: "supported" }
};

function discovery(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    status: "observed",
    source: "codex-account-models",
    observedAt: OBSERVED_AT,
    lastAttemptAt: OBSERVED_AT,
    models: [GPT_5],
    ...overrides
  };
}

function entry(
  provider: string,
  value: Record<string, unknown> = discovery()
): Record<string, unknown> {
  return { provider, discovery: value };
}

function response(providers: readonly unknown[] = []): Record<string, unknown> {
  return {
    schema: CONTROL_API_PROVIDER_MODEL_DISCOVERY_SCHEMA_ID,
    source: "runtime-provider-discovery",
    providers
  };
}

function isAccepted(value: unknown): boolean {
  return controlApiProviderModelsResponseSchema.safeParse(value).success;
}

const UNAVAILABLE_DISCOVERY = {
  status: "unavailable",
  source: null,
  lastAttemptAt: null,
  reason: "The provider's own model list could not be read."
};

const DUPLICATE_MODELS = discovery({ models: [GPT_5, GPT_5] });

const NOT_A_MODEL_ID = discovery({
  models: [{ ...GPT_5, id: "not a model id" }]
});

const NOT_CANONICAL = discovery({ observedAt: "2026-11-26T12:00:00Z" });

const STALE_WITHOUT_A_REASON = { ...discovery(), status: "stale" };

const STALE_WITH_A_REASON = {
  ...discovery(),
  status: "stale",
  reason: "The provider's own model list could not be re-read."
};

const ONLY_WHITESPACE = {
  status: "unavailable",
  source: null,
  lastAttemptAt: null,
  reason: " ".repeat(3)
};

const PRODUCED = response([
  entry("codex"),
  entry("claude", UNAVAILABLE_DISCOVERY)
]);
const ANOTHER_CONTRACT = { ...response(), schema: "some-other-contract-v9" };
const A_PROVIDER_TWICE = response([entry("codex"), entry("codex")]);
const ONE_MODEL_TWICE = response([entry("codex", DUPLICATE_MODELS)]);
const TWO_PROVIDERS_SAME_MODEL = response([entry("codex"), entry("openai")]);
const NOT_A_ROUTING_ID = response([entry("not a routing id")]);
const NOT_A_MODEL = response([entry("codex", NOT_A_MODEL_ID)]);
const NOT_CANONICAL_TIMESTAMP = response([entry("codex", NOT_CANONICAL)]);
const STALE_SILENTLY = response([entry("codex", STALE_WITHOUT_A_REASON)]);
const STALE_SPEAKING = response([entry("codex", STALE_WITH_A_REASON)]);
const SAYING_NOTHING = response([entry("claude", ONLY_WHITESPACE)]);

test("a discovery response the Runtime produces is accepted", () => {
  assert.equal(isAccepted(PRODUCED), true);
});

test("a response carrying another contract's schema id is refused", () => {
  assert.equal(isAccepted(ANOTHER_CONTRACT), false);
});

test("a provider that answers twice is refused", () => {
  assert.equal(isAccepted(A_PROVIDER_TWICE), false);
});

test("a provider that lists one model twice is refused", () => {
  assert.equal(isAccepted(ONE_MODEL_TWICE), false);
});

test("two providers may each list the same model", () => {
  // The rule is per provider: two providers can both serve a model with the
  // same id, and refusing that would refuse a real listing.
  assert.equal(isAccepted(TWO_PROVIDERS_SAME_MODEL), true);
});

test("a provider id that is not a routing id is refused", () => {
  assert.equal(isAccepted(NOT_A_ROUTING_ID), false);
});

test("a model id that is not a model id is refused", () => {
  assert.equal(isAccepted(NOT_A_MODEL), false);
});

test("a timestamp that is not canonical is refused", () => {
  assert.equal(
    isAccepted(NOT_CANONICAL_TIMESTAMP),
    false,
    "a timestamp that only parses is not the timestamp that was written down"
  );
});

test("a stale listing must say why it is stale", () => {
  assert.equal(isAccepted(STALE_SILENTLY), false);
  assert.equal(isAccepted(STALE_SPEAKING), true);
});

test("a reason that is only whitespace says nothing", () => {
  assert.equal(isAccepted(SAYING_NOTHING), false);
});
