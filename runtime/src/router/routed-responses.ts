import { context as otelContext, propagation } from "@opentelemetry/api";

const PORT_PATTERN = /^\d{1,5}$/u;
const LOCAL_ROUTER_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_ROUTER_PORT = 4100;

type FetchImplementation = typeof fetch;

export interface RoutedResponsesClientOptions {
  readonly endpoint?: string;
  readonly authToken?: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly fetchImpl?: FetchImplementation;
}

export interface RoutedResponseMessage {
  readonly role: "user" | "developer";
  readonly text: string;
}

export interface RoutedResponseRequest {
  /** Router model id: a catalog model or an `autodev/<role>` alias. */
  readonly model: string;
  /** Omitted from the request when null. */
  readonly instructions: string | null;
  readonly input: readonly RoutedResponseMessage[];
  readonly maxOutputTokens: number;
}

export type RoutedResponseFailure =
  "http_error" | "timeout" | "unreachable" | "oversized" | "invalid_response";

export type RoutedResponseResult =
  | {
      readonly ok: true;
      readonly text: string;
      /** Model reported by the routed response; null when not reported. */
      readonly responseModel: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: RoutedResponseFailure;
      readonly status: number | null;
    };

/** Default loopback `/v1/responses` endpoint of this host's AutoDev router. */
export function defaultRoutedResponsesEndpoint(
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env.CODEX_MODEL_ROUTER_PORT;
  const port =
    raw && PORT_PATTERN.test(raw) && Number(raw) >= 1 && Number(raw) <= 65_535
      ? Number(raw)
      : DEFAULT_ROUTER_PORT;
  return `http://127.0.0.1:${port}/v1/responses`;
}

/**
 * Non-streaming client for runtime-owned model calls that must travel the
 * AutoDev router: provider policy, routing, credentials, and telemetry stay
 * with the router instead of a second model authority. The active OTel
 * context is propagated so routed spans join the caller's trace.
 */
export class RoutedResponsesClient {
  private readonly endpoint: string;
  private readonly authToken: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchImpl: FetchImplementation;

  constructor(options: RoutedResponsesClientOptions) {
    this.endpoint = options.endpoint ?? defaultRoutedResponsesEndpoint();
    this.authToken = options.authToken ?? process.env.CODEX_ROUTER_AUTH_TOKEN;
    this.timeoutMs = options.timeoutMs;
    this.maxResponseBytes = options.maxResponseBytes;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    // Parse once; the endpoint is local-only and a configured test seam
    // cannot silently downgrade TLS or use credential-bearing URLs.
    const parsed = new URL(this.endpoint);
    if (
      parsed.protocol !== "http:" ||
      !LOCAL_ROUTER_HOSTS.has(parsed.hostname) ||
      parsed.username ||
      parsed.password
    ) {
      throw new TypeError(
        "Routed responses endpoint must be a loopback HTTP URL without credentials."
      );
    }
  }

  async create(request: RoutedResponseRequest): Promise<RoutedResponseResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/json"
      };
      if (this.authToken?.trim())
        headers.authorization = `Bearer ${this.authToken.trim()}`;
      const traceCarrier: Record<string, string> = {};
      propagation.inject(otelContext.active(), traceCarrier);
      Object.assign(headers, traceCarrier);
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: request.model,
          stream: false,
          max_output_tokens: request.maxOutputTokens,
          tools: [],
          ...(request.instructions === null
            ? {}
            : { instructions: request.instructions }),
          input: request.input.map((message) => ({
            type: "message",
            role: message.role,
            content: [{ type: "input_text", text: message.text }]
          }))
        }),
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: "http_error", status: response.status };
      }
      const body = await this.readBoundedJson(response);
      if (body === OVERSIZED)
        return { ok: false, reason: "oversized", status: null };
      const text = responseText(body);
      if (text === null)
        return { ok: false, reason: "invalid_response", status: null };
      return {
        ok: true,
        text,
        responseModel:
          isRecord(body) && typeof body.model === "string" && body.model.trim()
            ? body.model.trim().slice(0, 128)
            : null
      };
    } catch {
      return {
        ok: false,
        reason: controller.signal.aborted ? "timeout" : "unreachable",
        status: null
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBoundedJson(
    response: Response
  ): Promise<unknown | typeof OVERSIZED> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let byteCount = 0;
    /* eslint-disable no-await-in-loop -- sequential reads enforce the aggregate response cap. */
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteCount += next.value.byteLength;
      if (byteCount > this.maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return OVERSIZED;
      }
      chunks.push(next.value);
    }
    /* eslint-enable no-await-in-loop */
    try {
      return JSON.parse(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
          "utf8"
        )
      ) as unknown;
    } catch {
      return null;
    }
  }
}

const OVERSIZED = Symbol("oversized");

function responseText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.output_text === "string") return value.output_text;
  if (!Array.isArray(value.output)) return null;
  const texts = value.output.flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.content)) return [];
    return item.content.flatMap((content) =>
      isRecord(content) &&
      content.type === "output_text" &&
      typeof content.text === "string"
        ? [content.text]
        : []
    );
  });
  return texts.length > 0 ? texts.join("\n") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
