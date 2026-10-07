import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_EMBEDDING_TIMEOUT_MS,
  MIN_EMBEDDING_TIMEOUT_MS,
  OpenAICompatibleMemoryEmbeddingProvider
} from "@simulatorlife/autodev-runtime/memory";
import {
  configuredMemoryEmbeddingProvider,
  embeddingTimeoutMs
} from "@simulatorlife/autodev-runtime/router/memory-embedding";
import type {
  ProviderRoute,
  RoutingPolicy
} from "@simulatorlife/autodev-runtime/router/routing";

const apiRoute: ProviderRoute = {
  provider: "test-provider",
  pattern: /^embed-small$/u,
  baseUrl: "http://127.0.0.1:4000/v1",
  envKey: "TEST_PROVIDER_KEY"
};

function routing(
  route: ProviderRoute | null
): Pick<RoutingPolicy, "routeForModel"> {
  return {
    routeForModel: () => route
  };
}

test("memory embedding model resolves through the existing configured provider route", () => {
  const provider = configuredMemoryEmbeddingProvider(
    {
      AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-small",
      TEST_PROVIDER_KEY: "test-provider-key"
    },
    routing(apiRoute)
  );

  assert.ok(provider instanceof OpenAICompatibleMemoryEmbeddingProvider);
});

test("memory embedding remains lexical when model routing or credentials are unavailable", () => {
  assert.equal(
    configuredMemoryEmbeddingProvider({}, routing(apiRoute)),
    undefined
  );
  assert.equal(
    configuredMemoryEmbeddingProvider(
      { AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-small" },
      routing(apiRoute)
    ),
    undefined
  );
  assert.equal(
    configuredMemoryEmbeddingProvider(
      {
        AUTODEV_MEMORY_EMBEDDING_MODEL: "unrouted-model",
        TEST_PROVIDER_KEY: "test-provider-key"
      },
      routing(null)
    ),
    undefined
  );
});

test("unauthenticated remote embedding endpoints are not selected", () => {
  const publicRemoteRoute: ProviderRoute = {
    provider: "remote",
    pattern: /^embed-small$/u,
    baseUrl: "https://embedding.example/v1",
    envKey: null
  };

  assert.equal(
    configuredMemoryEmbeddingProvider(
      { AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-small" },
      routing(publicRemoteRoute)
    ),
    undefined
  );
});

test("the embedding timeout is read from configuration and bounded", () => {
  // Unset or blank leaves the adapter on its own default.
  assert.equal(embeddingTimeoutMs({}), undefined);
  assert.equal(
    embeddingTimeoutMs({ AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: "" }),
    undefined
  );
  assert.equal(
    embeddingTimeoutMs({ AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: "   " }),
    undefined
  );

  // Inside the adapter's accepted range, including both ends.
  assert.equal(
    embeddingTimeoutMs({
      AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: String(MIN_EMBEDDING_TIMEOUT_MS)
    }),
    MIN_EMBEDDING_TIMEOUT_MS
  );
  assert.equal(
    embeddingTimeoutMs({
      AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: String(MAX_EMBEDDING_TIMEOUT_MS)
    }),
    MAX_EMBEDDING_TIMEOUT_MS
  );
  assert.equal(
    embeddingTimeoutMs({ AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: " 1500 " }),
    1500
  );
  // parseNonNegativeInteger documents `Number.parseInt` semantics, including
  // numeric-prefix acceptance, so this matches every other env integer here
  // rather than inventing a second parsing idiom for one setting.
  assert.equal(
    embeddingTimeoutMs({ AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: "5000ms" }),
    5000
  );

  // Outside it, or not a number at all: no override, not a fatal error.
  for (const value of [
    "0",
    "1",
    String(MIN_EMBEDDING_TIMEOUT_MS - 1),
    String(MAX_EMBEDDING_TIMEOUT_MS + 1),
    "-1",
    "not-a-number"
  ]) {
    assert.equal(
      embeddingTimeoutMs({ AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: value }),
      undefined,
      `${value} must not become an override`
    );
  }
});

test("a configured embedding timeout does not disable the provider", () => {
  // The regression this guards: an unusable override used to reach the
  // constructor, whose rejection is swallowed on purpose, silently turning vector
  // retrieval off instead of ignoring the bad value.
  for (const timeout of ["100", "30000", "0", "99999", "not-a-number", ""]) {
    const provider = configuredMemoryEmbeddingProvider(
      {
        AUTODEV_MEMORY_EMBEDDING_MODEL: "embed-small",
        AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS: timeout,
        TEST_PROVIDER_KEY: "test-provider-key"
      },
      routing(apiRoute)
    );
    assert.ok(
      provider instanceof OpenAICompatibleMemoryEmbeddingProvider,
      `timeout ${JSON.stringify(timeout)} must not disable embeddings`
    );
  }
});

test("the adapter enforces the same bounds the configuration wiring reads", () => {
  for (const timeoutMs of [
    MIN_EMBEDDING_TIMEOUT_MS - 1,
    MAX_EMBEDDING_TIMEOUT_MS + 1
  ]) {
    assert.throws(
      () =>
        new OpenAICompatibleMemoryEmbeddingProvider({
          endpoint: "http://127.0.0.1:4000/v1",
          model: "embed-small",
          timeoutMs
        }),
      TypeError,
      `${timeoutMs} must be outside the adapter's accepted range`
    );
  }

  // The model ceiling is the same arrangement and was not covered, despite this
  // test's name. The wiring already refused an over-long
  // `AUTODEV_MEMORY_EMBEDDING_MODEL` before routing, so the constructor's own
  // ceiling looked exercised while only one of the two was. Widening the
  // wiring's check alone would have been silent: the constructor rejects, and
  // `configuredMemoryEmbeddingProvider` swallows a constructor rejection by
  // design, so the operator's configured model would simply stop being used.
  // Both read one constant now; this pins that the constructor applies it.
  //
  // 256 and 257, written out. Asserting against the shared constant made this
  // test pass for any value it was given, which is precisely the disagreement
  // it exists to catch.
  assert.throws(
    () =>
      new OpenAICompatibleMemoryEmbeddingProvider({
        endpoint: "http://127.0.0.1:4000/v1",
        model: "m".repeat(257)
      }),
    TypeError,
    "a model past the shared ceiling must be refused by the constructor too"
  );
  // And the edge itself: a ceiling one short would refuse a model the wiring
  // has already accepted, which is the same disagreement pointing the other
  // way.
  assert.ok(
    new OpenAICompatibleMemoryEmbeddingProvider({
      endpoint: "http://127.0.0.1:4000/v1",
      model: "m".repeat(256)
    }),
    "a model exactly at the shared ceiling must still be accepted"
  );
});
