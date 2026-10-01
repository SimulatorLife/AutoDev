import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_EMBEDDING_DIMENSIONS } from "@simulatorlife/autodev-data";

import { OpenAICompatibleMemoryEmbeddingProvider } from "../src/memory/openai-compatible-embedding.ts";
import {
  MemoryEmbeddingUnavailableError,
  MemoryValidationError
} from "../src/memory/service.ts";

function embeddingResponse(
  vector: readonly number[] = new Array(MEMORY_EMBEDDING_DIMENSIONS).fill(0.125)
): Response {
  return Response.json({ data: [{ embedding: vector }] }, {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

test("embedding adapter reuses a configured endpoint and returns its fixed vector", async () => {
  let requestUrl = "";
  let request: RequestInit | undefined;
  const provider = new OpenAICompatibleMemoryEmbeddingProvider({
    endpoint: "https://embedding.example/v1/",
    model: "embed-small",
    apiKey: "test-provider-key",
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      request = init;
      return embeddingResponse();
    }
  });

  const embedding = await provider.embed("A bounded test claim.");

  assert.equal(requestUrl, "https://embedding.example/v1/embeddings");
  assert.equal(request?.method, "POST");
  assert.equal(
    (request?.headers as Record<string, string>).authorization,
    "Bearer test-provider-key"
  );
  assert.deepEqual(JSON.parse(String(request?.body)), {
    model: "embed-small",
    input: "A bounded test claim.",
    encoding_format: "float"
  });
  assert.equal(embedding.length, MEMORY_EMBEDDING_DIMENSIONS);
  assert.equal(embedding[0], 0.125);
});

test("provider and transport failures report an optional embedding outage", async () => {
  for (const fetchImpl of [
    async () => new Response("unavailable", { status: 503 }),
    async () => {
      throw new TypeError("connection refused");
    }
  ]) {
    const provider = new OpenAICompatibleMemoryEmbeddingProvider({
      endpoint: "http://127.0.0.1:4000/v1",
      model: "embed-small",
      fetchImpl
    });
    await assert.rejects(
      provider.embed("A bounded test claim."),
      MemoryEmbeddingUnavailableError
    );
  }
});

test("invalid vectors and unsafe endpoint settings fail closed", async () => {
  const invalidVector = new OpenAICompatibleMemoryEmbeddingProvider({
    endpoint: "http://127.0.0.1:4000/v1",
    model: "embed-small",
    fetchImpl: async () => embeddingResponse([Number.NaN])
  });
  await assert.rejects(
    invalidVector.embed("A bounded test claim."),
    MemoryValidationError
  );
  assert.throws(
    () =>
      new OpenAICompatibleMemoryEmbeddingProvider({
        endpoint: "https://user:password@embedding.example/v1",
        model: "embed-small"
      }),
    TypeError
  );
  await assert.rejects(invalidVector.embed(" "), MemoryValidationError);
});
