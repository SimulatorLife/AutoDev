import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import path from "node:path";
import test from "node:test";

import {
  sendJson,
  sendWorkspaceResolutionFailure
} from "@simulatorlife/autodev-runtime/shared/provider-http";
import { WorkspaceResolutionError } from "@simulatorlife/autodev-runtime/shared/resolve-workspace";

const repositoryRoot = path.join(import.meta.dirname, "..");

interface CapturedResponse {
  readonly status: number;
  readonly headers: Record<string, string | number>;
  readonly body: string;
}

function captureSend(
  callback: (response: ServerResponse) => void
): CapturedResponse {
  let captured: CapturedResponse | undefined;
  const stub = {
    writeHead(status: number, headers: Record<string, string | number>) {
      captured = { status, headers, body: "" };
    },
    end(payload?: Buffer | string) {
      captured = { ...captured!, body: String(payload ?? "") };
    }
  } as unknown as ServerResponse;
  callback(stub);
  assert.ok(captured, "the response was never written");
  return captured;
}

function captureStderr(callback: () => void): string {
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    callback();
  } finally {
    process.stderr.write = originalWrite;
  }
  return lines.join("");
}

test("sendJson writes one JSON body with a matching content-length", () => {
  const captured = captureSend((response) => {
    sendJson(response, 200, { status: "ok" });
  });

  assert.equal(captured.status, 200);
  assert.equal(captured.body, '{"status":"ok"}');
  assert.equal(captured.headers["content-type"], "application/json");
  assert.equal(
    captured.headers["content-length"],
    Buffer.byteLength(captured.body)
  );
  assert.equal(captured.headers.connection, "close");
});

test("sendJson merges extra headers and accepts a null body", () => {
  const captured = captureSend((response) => {
    sendJson(response, 204, null, { "cache-control": "no-store", age: 3 });
  });

  assert.equal(captured.body, "null");
  assert.equal(captured.headers["cache-control"], "no-store");
  assert.equal(captured.headers.age, 3);
  // A bridge must not claim the router's identity, so the router instance id
  // that `router/proxy.ts` adds is deliberately absent here.
  assert.equal(captured.headers["x-autodev-router-instance-id"], undefined);
});

test("a workspace that cannot be resolved fails closed with a 400", () => {
  const error = new WorkspaceResolutionError("refusing to guess a workspace");

  const captured = captureSend((response) => {
    captureStderr(() =>
      sendWorkspaceResolutionFailure(response, "claude", error)
    );
  });

  assert.equal(captured.status, 400);
  assert.deepEqual(JSON.parse(captured.body), {
    error: {
      type: "invalid_request_error",
      message: "refusing to guess a workspace"
    }
  });
  assert.equal(captured.headers["content-type"], "application/json");
});

test("the fail-closed response names the bridge that rejected the request", () => {
  const error = new WorkspaceResolutionError("ambiguous workspace");

  for (const provider of ["claude", "copilot", "agy"]) {
    const logged = captureStderr(() =>
      captureSend((response) => {
        sendWorkspaceResolutionFailure(response, provider, error);
      })
    );
    assert.equal(
      logged,
      `${provider} workspace resolution failed: ambiguous workspace\n`
    );
  }
});

test("provider bridges delegate their HTTP responses to the shared owner", () => {
  // Each bridge used to carry its own `sendJson` and its own copy of the
  // fail-closed 400, which is how the contract in docs/provider-routing.md
  // drifted out of sync between them.
  for (const provider of ["claude", "copilot", "antigravity"]) {
    const source = readFileSync(
      path.join(repositoryRoot, "runtime/src/providers", `${provider}.ts`),
      "utf8"
    );

    assert.doesNotMatch(
      source,
      /function sendJson\(/u,
      `${provider}.ts defines its own sendJson`
    );
    // `invalid_request_error` is still correct for the bridges' other 400/404
    // bodies, so scope the guard to the workspace failure itself, which used to
    // be logged and answered inline in each bridge.
    assert.doesNotMatch(
      source,
      /workspace resolution failed/u,
      `${provider}.ts hand-rolls the fail-closed workspace response`
    );
    assert.match(
      source,
      /sendWorkspaceResolutionFailure/u,
      `${provider}.ts must fail closed through the shared helper`
    );
  }
});
