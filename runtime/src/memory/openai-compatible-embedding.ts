import { context, propagation } from "@opentelemetry/api";
import { MEMORY_EMBEDDING_DIMENSIONS } from "@simulatorlife/autodev-data";

import {
  type MemoryEmbeddingProvider,
  MemoryEmbeddingUnavailableError,
  MemoryValidationError} from "./service.ts";

const MAX_EMBEDDING_INPUT_CHARACTERS = 16_000;
const MAX_EMBEDDING_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 5000;
const MAX_EMBEDDING_TIMEOUT_MS = 30_000;
const EMBEDDING_PATH_SUFFIX = /\/+$/u;

export interface OpenAICompatibleMemoryEmbeddingOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Calls an embedding-capable model already selected by the host's provider
 * router. This adapter owns only the common embeddings wire format.
 */
export class OpenAICompatibleMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleMemoryEmbeddingOptions) {
    const endpoint = new URL(options.endpoint);
    const model = options.model.trim();
    if (
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !model ||
      model.length > 256
    ) {
      throw new TypeError("Memory embedding endpoint or model is invalid.");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 100 ||
      timeoutMs > MAX_EMBEDDING_TIMEOUT_MS
    ) {
      throw new TypeError("Memory embedding timeout is outside its bound.");
    }
    const basePath = endpoint.pathname.replace(EMBEDDING_PATH_SUFFIX, "");
    endpoint.pathname = basePath + "/embeddings";

    this.endpoint = endpoint.toString();
    this.model = model;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async embed(text: string): Promise<readonly number[]> {
    if (!text.trim() || text.length > MAX_EMBEDDING_INPUT_CHARACTERS) {
      throw new MemoryValidationError(
        "Memory embedding input is empty or exceeds its bound."
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json"
      };
      if (this.apiKey) headers.authorization = "Bearer " + this.apiKey;
      const traceCarrier: Record<string, string> = {};
      propagation.inject(context.active(), traceCarrier);
      for (const header of ["traceparent", "tracestate"] as const) {
        const value = traceCarrier[header];
        if (value) headers[header] = value;
      }

      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: this.model,
            input: text,
            encoding_format: "float"
          }),
          redirect: "error",
          signal: controller.signal
        });
      } catch {
        throw new MemoryEmbeddingUnavailableError();
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new MemoryEmbeddingUnavailableError();
      }

      const payload = await readBoundedJson(response);
      return embeddingVector(payload);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new MemoryEmbeddingUnavailableError();

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > MAX_EMBEDDING_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new MemoryEmbeddingUnavailableError();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MemoryEmbeddingUnavailableError) throw error;
    throw new MemoryEmbeddingUnavailableError();
  }

  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new MemoryEmbeddingUnavailableError();
  }
}

function embeddingVector(payload: unknown): readonly number[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new MemoryEmbeddingUnavailableError();
  }
  const first = payload.data[0];
  if (!isRecord(first) || !Array.isArray(first.embedding)) {
    throw new MemoryEmbeddingUnavailableError();
  }
  if (
    first.embedding.length !== MEMORY_EMBEDDING_DIMENSIONS ||
    first.embedding.some(
      (value) => typeof value !== "number" || !Number.isFinite(value)
    )
  ) {
    throw new MemoryValidationError(
      "Memory embeddings must contain " +
        MEMORY_EMBEDDING_DIMENSIONS +
        " finite values."
    );
  }
  return first.embedding as number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
