import assert from "node:assert/strict";
import test from "node:test";

import type { Tracer } from "@opentelemetry/api";
import { MEMORY_EMBEDDING_DIMENSIONS } from "@simulatorlife/autodev-data";

import { OpenAICompatibleMemoryEmbeddingProvider } from "../src/memory/openai-compatible-embedding.ts";
import {
  MemoryEmbeddingUnavailableError,
  MemoryValidationError
} from "../src/memory/service.ts";

function embeddingResponse(
  vector: readonly number[] = Array.from<number>({
    length: MEMORY_EMBEDDING_DIMENSIONS
  }).fill(0.125)
): Response {
  return Response.json(
    { data: [{ embedding: vector }], usage: { prompt_tokens: 12 } },
    {
      status: 200,
      headers: { "content-type": "application/json" }
    }
  );
}

test("embedding adapter reuses a configured endpoint and returns its fixed vector", async () => {
  let requestUrl = "";
  let request: RequestInit | undefined;
  const spans: Array<{ name: string; attributes: Map<string, unknown> }> = [];
  const tracer = {
    startActiveSpan(
      name: string,
      options: { attributes?: Record<string, unknown> },
      callback: (span: never) => Promise<unknown>
    ) {
      const attributes = new Map(Object.entries(options.attributes ?? {}));
      spans.push({ name, attributes });
      return callback({
        setAttribute: (key: string, value: unknown) =>
          attributes.set(key, value),
        setStatus: () => undefined,
        end: () => undefined
      } as never);
    }
  } as unknown as Tracer;
  const provider = new OpenAICompatibleMemoryEmbeddingProvider({
    endpoint: "https://embedding.example/v1/",
    model: "embed-small",
    provider: "test-provider",
    apiKey: "test-provider-key",
    tracer,
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
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.name, "gen_ai.client_operation");
  assert.equal(spans[0]?.attributes.get("gen_ai.operation.name"), "embeddings");
  assert.equal(
    spans[0]?.attributes.get("gen_ai.provider.name"),
    "test-provider"
  );
  assert.equal(spans[0]?.attributes.get("gen_ai.request.model"), "embed-small");
  assert.equal(spans[0]?.attributes.get("gen_ai.usage.input_tokens"), 12);
  assert.doesNotMatch(
    JSON.stringify([...spans[0]!.attributes]),
    /test-provider-key|bounded test claim/
  );
});

test("provider and transport failures report an optional embedding outage", async () => {
  for (const fetchImpl of [
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("rate limited", { status: 429 }),
    async () => new Response("x".repeat(64 * 1024 + 1), { status: 200 }),
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
    fetchImpl: async () =>
      embeddingResponse(
        Array.from<number>({ length: MEMORY_EMBEDDING_DIMENSIONS }).fill(
          Number.NaN
        )
      )
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
  assert.throws(
    () =>
      new OpenAICompatibleMemoryEmbeddingProvider({
        endpoint: "http://embedding.example/v1",
        model: "embed-small",
        apiKey: "test-provider-key"
      }),
    TypeError
  );
  await assert.rejects(invalidVector.embed(" "), MemoryValidationError);
  await assert.rejects(
    invalidVector.embed("x".repeat(16_001)),
    MemoryValidationError
  );
});
