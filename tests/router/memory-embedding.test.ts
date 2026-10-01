import assert from "node:assert/strict";
import test from "node:test";

import { OpenAICompatibleMemoryEmbeddingProvider } from "@simulatorlife/autodev-runtime/memory";
import { configuredMemoryEmbeddingProvider } from "@simulatorlife/autodev-runtime/router/memory-embedding";
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
