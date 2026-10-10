import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * The slice of `ServerResponse` a route actually touches, captured so a test can
 * assert on status, headers and body without binding a socket.
 */
export interface RecordedResponse extends ServerResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | number>;
  readonly body: string;
}

/**
 * A minimal writable stand-in for `ServerResponse`. Only the four members the
 * JSON sender uses are implemented; anything else a route starts calling shows
 * up here as a missing method, which is the point — a silent no-op would let a
 * broken route pass.
 */
class ResponseRecorder {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  private readonly chunks: Buffer[] = [];

  setHeader(name: string, value: string | number): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  writeHead(status: number, headers?: Record<string, string | number>): this {
    this.statusCode = status;
    if (headers) Object.assign(this.headers, headers);
    this.headersSent = true;
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Buffer): this {
    if (chunk) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.body = Buffer.concat(this.chunks).toString("utf8");
    this.writableEnded = true;
    return this;
  }
}

export function responseRecorder(): RecordedResponse {
  return new ResponseRecorder() as unknown as RecordedResponse;
}

/** The parsed JSON body, or `null` for an empty body or a non-JSON one. */
export function responseBody(
  response: RecordedResponse
): Record<string, unknown> | null {
  if (!response.body) return null;
  try {
    return JSON.parse(response.body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A request the route can read without a socket; a `body` is sent as JSON. */
export function makeRequest(
  method: string,
  url: string,
  body?: Record<string, unknown>
): IncomingMessage {
  const stream = Readable.from(body ? [JSON.stringify(body)] : []);
  return Object.assign(stream, {
    method,
    url,
    headers: body ? { "content-type": "application/json" } : {}
  }) as IncomingMessage;
}
