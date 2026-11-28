import { request as httpRequest } from "node:http";
import path from "node:path";

export interface IngressStatusResponse {
  readonly ready: boolean;
  readonly activeGenerationId: string | null;
  readonly rollbackGenerationId: string | null;
  readonly generations: ReadonlyArray<{
    readonly id: string;
    readonly state: "active" | "retiring" | "retired";
    readonly inFlight: number;
  }>;
}

export interface IngressActivationResponse {
  readonly activeGenerationId: string;
  readonly retiringGenerationId: string | null;
}

function controlRequest<T>(options: {
  controlSocket: string;
  controlToken: string;
  method: "GET" | "POST";
  pathname: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<{ status: number; body: T }> {
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise<{ status: number; body: T }>((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath: options.controlSocket,
        path: options.pathname,
        method: options.method,
        headers: {
          authorization: `Bearer ${options.controlToken}`,
          accept: "application/json",
          ...(payload !== undefined && {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload)
          })
        },
        timeout: options.timeoutMs ?? 15_000
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        response.once("end", () => {
          try {
            const parsed = JSON.parse(
              Buffer.concat(chunks).toString("utf8")
            ) as T;
            resolve({ status: response.statusCode ?? 500, body: parsed });
          } catch (error) {
            reject(
              new Error(
                `Invalid JSON response from ingress ${options.pathname}: ${
                  error instanceof Error ? error.message : String(error)
                }`
              )
            );
          }
        });
        response.once("error", reject);
      }
    );
    request.once("timeout", () => {
      request.destroy(
        new Error(`Ingress request timed out: ${options.pathname}`)
      );
    });
    request.once("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

export async function queryIngressStatus(
  controlSocket: string,
  controlToken: string,
  timeoutMs = 3000
): Promise<IngressStatusResponse | null> {
  try {
    const result = await controlRequest<IngressStatusResponse>({
      controlSocket,
      controlToken,
      method: "GET",
      pathname: "/v1/status",
      timeoutMs
    });
    return result.status === 200 ? result.body : null;
  } catch {
    return null;
  }
}

export async function activateIngressGeneration(
  controlSocket: string,
  controlToken: string,
  id: string,
  entry: string,
  timeoutMs = 20_000
): Promise<IngressActivationResponse> {
  const result = await controlRequest<
    IngressActivationResponse & { error?: string; message?: string }
  >({
    controlSocket,
    controlToken,
    method: "POST",
    pathname: "/v1/generations",
    body: { id, entry },
    timeoutMs
  });
  if (result.status !== 200) {
    throw new Error(
      result.body?.message ??
        result.body?.error ??
        `Ingress activation failed (${result.status})`
    );
  }
  return result.body;
}

export async function rollbackIngressGeneration(
  controlSocket: string,
  controlToken: string,
  id: string,
  timeoutMs = 20_000
): Promise<IngressActivationResponse> {
  const result = await controlRequest<
    IngressActivationResponse & { error?: string; message?: string }
  >({
    controlSocket,
    controlToken,
    method: "POST",
    pathname: "/v1/rollback",
    body: { id },
    timeoutMs
  });
  if (result.status !== 200) {
    throw new Error(
      result.body?.message ??
        result.body?.error ??
        `Ingress rollback failed (${result.status})`
    );
  }
  return result.body;
}

const GENERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,110}$/u;
const LEADING_DOTS = /^\.+/u;

/**
Derive a valid ingress generation ID (`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)
from `base` that no generation in `status` already uses. A base outside the
ID grammar becomes `release`; a used one gains the first free `.<n>` suffix.
*/
export function uniqueGenerationId(
  base: string,
  status: IngressStatusResponse | null
): string {
  const candidate = GENERATION_ID_PATTERN.test(base) ? base : "release";
  const used = new Set(status?.generations.map((item) => item.id));
  if (!used.has(candidate)) return candidate;
  let counter = 2;
  while (used.has(`${candidate}.${counter}`)) counter += 1;
  return `${candidate}.${counter}`;
}

/**
Derive a unique ingress generation ID for a content-addressed `.src-<hash>`
release entry.
*/
export function generationIdForRelease(
  workerEntryPath: string,
  status: IngressStatusResponse | null
): string {
  const releaseDirectory = path.dirname(path.dirname(workerEntryPath));
  return uniqueGenerationId(
    path.basename(releaseDirectory).replace(LEADING_DOTS, ""),
    status
  );
}
