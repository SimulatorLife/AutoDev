import {
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer
} from "@opentelemetry/api";
import { MEMORY_EMBEDDING_DIMENSIONS } from "@simulatorlife/autodev-data";

import {
  type MemoryEmbeddingProvider,
  MemoryEmbeddingUnavailableError,
  MemoryValidationError
} from "./service.ts";

const MAX_EMBEDDING_INPUT_CHARACTERS = 16_000;
const MAX_EMBEDDING_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 5000;
/**
 * The adapter's accepted timeout range.
 *
 * These are the bounds the constructor enforces, and the same two values the
 * router's configuration wiring reads when it validates
 * `AUTODEV_MEMORY_EMBEDDING_TIMEOUT_MS`. One owner for both, so an operator can
 * only be offered the range the adapter will actually accept.
 */
export const MIN_EMBEDDING_TIMEOUT_MS = 100;
export const MAX_EMBEDDING_TIMEOUT_MS = 30_000;
const EMBEDDING_PATH_SUFFIX = /\/+$/u;
const LOCAL_EMBEDDING_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface OpenAICompatibleMemoryEmbeddingOptions {
  readonly endpoint: string;
  readonly model: string;
  readonly provider?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly tracer?: Tracer;
}

/**
 * Calls an embedding-capable model already selected by the host's provider
 * router. This adapter owns only the common embeddings wire format.
 */
export class OpenAICompatibleMemoryEmbeddingProvider implements MemoryEmbeddingProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly provider: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly tracer: Tracer;

  constructor(options: OpenAICompatibleMemoryEmbeddingOptions) {
    const endpoint = new URL(options.endpoint);
    const model = options.model.trim();
    if (
      (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
      (endpoint.protocol === "http:" &&
        !LOCAL_EMBEDDING_HOSTS.has(endpoint.hostname)) ||
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
      timeoutMs < MIN_EMBEDDING_TIMEOUT_MS ||
      timeoutMs > MAX_EMBEDDING_TIMEOUT_MS
    ) {
      throw new TypeError("Memory embedding timeout is outside its bound.");
    }
    const basePath = endpoint.pathname.replace(EMBEDDING_PATH_SUFFIX, "");
    endpoint.pathname = basePath + "/embeddings";

    this.endpoint = endpoint.toString();
    this.model = model;
    this.provider = options.provider?.trim() || undefined;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.tracer =
      options.tracer ?? trace.getTracer("autodev.memory.embedding", "1.0.0");
  }

  embed(text: string): Promise<readonly number[]> {
    return this.tracer.startActiveSpan(
      "gen_ai.client_operation",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "gen_ai.operation.name": "embeddings",
          "gen_ai.request.model": this.model,
          ...(this.provider ? { "gen_ai.provider.name": this.provider } : {})
        }
      },
      async (span) => {
        try {
          if (!text.trim() || text.length > MAX_EMBEDDING_INPUT_CHARACTERS) {
            throw new MemoryValidationError(
              "Memory embedding input is empty or exceeds its bound."
            );
          }
          return await this.requestEmbedding(text, span);
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute(
            "error.type",
            error instanceof MemoryEmbeddingUnavailableError
              ? "provider_unavailable"
              : error instanceof MemoryValidationError
                ? "invalid_response"
                : "operation_failed"
          );
          throw error;
        } finally {
          span.end();
        }
      }
    );
  }

  private async requestEmbedding(
    text: string,
    span: Span
  ): Promise<readonly number[]> {
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
      const inputTokens = embeddingInputTokens(payload);
      if (inputTokens !== undefined) {
        span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
      }
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
      // eslint-disable-next-line no-await-in-loop -- sequential reads enforce the response byte bound
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      byteLength += value.byteLength;
      if (byteLength > MAX_EMBEDDING_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
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

function embeddingInputTokens(payload: unknown): number | undefined {
  let tokenCount: number | undefined;
  if (isRecord(payload) && isRecord(payload.usage)) {
    const tokens = payload.usage.prompt_tokens ?? payload.usage.input_tokens;
    if (
      typeof tokens === "number" &&
      Number.isSafeInteger(tokens) &&
      tokens >= 0
    ) {
      tokenCount = tokens;
    }
  }
  return tokenCount;
}

function embeddingVector(payload: unknown): readonly number[] {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.data) ||
    payload.data.length !== 1
  ) {
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
