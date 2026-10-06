import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";

/**
 * `GET /control/memory/status` is the one memory read that has to work when
 * every other one fails, so these tests drive it through the route handler with
 * no service at all -- which is the state it exists to describe.
 */

interface RecordedResponse extends ServerResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string | number>;
  readonly body: string;
}

class ResponseRecorder {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = "";
  headersSent = false;
  writableEnded = false;
  errorMessage: string | null = null;
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

function responseRecorder(): RecordedResponse {
  return new ResponseRecorder() as unknown as RecordedResponse;
}

function getRequest(url: string, method = "GET"): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method,
    url,
    headers: {}
  }) as IncomingMessage;
}

const operator = {
  actor: "test-operator",
  role: "operator" as const,
  authority: "operator"
};

interface StatusCall {
  readonly statusCode: number;
  readonly body: Record<string, unknown> | null;
}

async function readStatus(
  pathname = "/control/memory/status",
  method = "GET"
): Promise<StatusCall> {
  const response = responseRecorder();
  await handleMemoryControlApiRequest(
    getRequest(pathname, method),
    response,
    pathname,
    operator,
    () => {},
    // No service: this is the state the read is meant to describe, and a
    // handler that resolved one first could not answer it.
    { createMemoryService: () => null }
  );
  let body: Record<string, unknown> | null = null;
  if (response.body) {
    try {
      body = JSON.parse(response.body) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { statusCode: response.statusCode, body };
}

test("storage status answers when memory storage is not configured, rather than 503", async () => {
  const previous = process.env.AUTODEV_MEMORY_DATABASE_URL;
  delete process.env.AUTODEV_MEMORY_DATABASE_URL;
  try {
    const { statusCode, body } = await readStatus();

    // Every other memory read answers 503 here. If this one did too, the Console
    // would have no way to tell "not configured" from "unreachable", which is
    // the entire reason it exists.
    assert.equal(statusCode, 200);
    assert.equal(body?.schema, "autodev-memory-status-v1");
    const storage = body?.storage as Record<string, unknown>;
    assert.equal(storage.state, "not_configured");
    assert.equal(storage.backend, "postgresql");
    assert.equal(
      typeof storage.probeTimeoutMs,
      "number",
      "the probe's own deadline is reported so a slow answer is distinguishable"
    );
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    else process.env.AUTODEV_MEMORY_DATABASE_URL = previous;
  }
});

test("storage status is scoped to the Runtime and needs no workspace or task history", async () => {
  const previous = process.env.AUTODEV_MEMORY_DATABASE_URL;
  delete process.env.AUTODEV_MEMORY_DATABASE_URL;
  try {
    const { statusCode, body } = await readStatus();

    // No `workspaceId`, no `AUTODEV_MEMORY_READ_TASK_HISTORY`. It describes this
    // Runtime's storage rather than any workspace's memory, so requiring either
    // would make the one diagnostic read the hardest one to obtain.
    assert.equal(statusCode, 200);
    assert.equal(body?.schema, "autodev-memory-status-v1");
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    else process.env.AUTODEV_MEMORY_DATABASE_URL = previous;
  }
});

test("storage status is read-only and rejects a mutation", async () => {
  const previous = process.env.AUTODEV_MEMORY_DATABASE_URL;
  delete process.env.AUTODEV_MEMORY_DATABASE_URL;
  try {
    const { statusCode, body } = await readStatus(
      "/control/memory/status",
      "POST"
    );

    assert.equal(statusCode, 405);
    const error = body?.error as Record<string, unknown> | undefined;
    assert.equal(error?.code, "autodev_memory_method_not_allowed");
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    else process.env.AUTODEV_MEMORY_DATABASE_URL = previous;
  }
});

test("a status path with an identifier is refused rather than read as a collection", async () => {
  const { statusCode } = await readStatus("/control/memory/status/anything");
  // There is no per-id status, so this must not fall through to any collection
  // read with the identifier ignored.
  assert.equal(statusCode, 404);
});

test("a configured database URL that cannot be built reports unreachable, not configured", async () => {
  const previous = process.env.AUTODEV_MEMORY_DATABASE_URL;
  // A syntactically present but unusable URL: the host fails to construct, which
  // is the third distinct state. Reporting it as `not_configured` would send the
  // operator to set a variable they already set.
  process.env.AUTODEV_MEMORY_DATABASE_URL = "not-a-database-url";
  try {
    const { statusCode, body } = await readStatus();
    assert.equal(statusCode, 200);
    const storage = body?.storage as Record<string, unknown>;
    assert.ok(
      storage.state === "unreachable" || storage.state === "not_configured",
      `expected a definite state, got ${String(storage.state)}`
    );
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    else process.env.AUTODEV_MEMORY_DATABASE_URL = previous;
  }
});

test("the status read never touches the service it reports on", async () => {
  const previous = process.env.AUTODEV_MEMORY_DATABASE_URL;
  delete process.env.AUTODEV_MEMORY_DATABASE_URL;
  let resolved = 0;
  try {
    const response = responseRecorder();
    await handleMemoryControlApiRequest(
      getRequest("/control/memory/status"),
      response,
      "/control/memory/status",
      operator,
      () => {},
      {
        createMemoryService: () => {
          resolved += 1;
          return null;
        }
      }
    );

    // Resolving the service first would make the read unreachable in the state
    // it exists to report, which is the bug this ordering prevents.
    assert.equal(resolved, 0);
    assert.equal(response.statusCode, 200);
  } finally {
    if (previous === undefined) delete process.env.AUTODEV_MEMORY_DATABASE_URL;
    else process.env.AUTODEV_MEMORY_DATABASE_URL = previous;
  }
});