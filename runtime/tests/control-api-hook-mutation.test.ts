import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { handleControlApiRequest } from "../src/control-api/request-handler.ts";
import {
  errorCode,
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";
import { sha256 } from "./support/hash.ts";

const SERVICE_TOKEN = "h".repeat(64);
const OPERATOR_ACTOR = "hook-mutation-operator";
const VIEWER_ACTOR = "hook-mutation-viewer";

/**
 * The canonical declaration the write starts from.
 *
 * It declares one event for every target and one event for Codex alone, so a
 * write that lands in the wrong place is visible: an event the target
 * inherits and an event the target declares are written to different parts of
 * the document, and the write says which one it chose.
 */
const DECLARATION = `{
  // The shared declaration.
  "hooks": {
    "sessionStart": [
      {
        "type": "command",
        "matcher": ".*",
        "command": "node session-start.ts"
      }
    ]
  },
  "codexcli": {
    "hooks": {
      "sessionEnd": [
        {
          "type": "command",
          "command": "node session-end.ts"
        }
      ]
    }
  }
}`;

function request(
  method: string,
  url: string,
  body?: unknown,
  actor: string = OPERATOR_ACTOR
): IncomingMessage {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return Object.assign(Readable.from([payload]), {
    method,
    url,
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "x-autodev-actor": actor,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload))
    }
  }) as unknown as IncomingMessage;
}

/**
 * Isolated repository and applied-state directories. No generation is required.
 */
function fixture(): {
  readonly repositoryRoot: string;
  readonly codexHome: string;
  readonly root: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-hook-mutation-"));
  const repositoryRoot = path.join(root, "repo");
  const codexHome = path.join(root, "codex");
  mkdirSync(path.join(repositoryRoot, ".rulesync"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, ".rulesync", "hooks.jsonc"),
    DECLARATION,
    "utf8"
  );
  mkdirSync(codexHome);
  return { repositoryRoot, codexHome, root };
}

/**
 * The credential the Control API requires, installed for the duration of the
 * request and removed again afterwards.
 */
async function withControlApiCredential<T>(run: () => Promise<T>): Promise<T> {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  const previousViewers = process.env.AUTODEV_CONTROL_VIEWERS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  process.env.AUTODEV_CONTROL_VIEWERS = VIEWER_ACTOR;
  return run().finally(() => {
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
    if (previousViewers === undefined)
      delete process.env.AUTODEV_CONTROL_VIEWERS;
    else process.env.AUTODEV_CONTROL_VIEWERS = previousViewers;
  });
}

async function call(
  method: string,
  url: string,
  options: {
    readonly repositoryRoot: string;
    readonly codexHome: string;
  },
  body?: unknown,
  actor: string = OPERATOR_ACTOR
): Promise<{
  statusCode: number;
  headers: Record<string, string | number>;
  body: Record<string, unknown> | null;
}> {
  const response = responseRecorder();
  await withControlApiCredential(async () => {
    await handleControlApiRequest(
      request(method, url, body, actor),
      response,
      url,
      options
    );
  });
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: responseBody(response) as Record<string, unknown> | null
  };
}

test("the hook declaration publishes the target's effective events and observed revision", async () => {
  const options = fixture();
  const result = await call("GET", "/control/hooks", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-hooks-v2");
  assert.equal(result.body?.target, "codexcli");
  assert.equal(result.body?.readOnly, true);
  assert.match(String(result.body?.revision), /^[a-f0-9]{64}$/u);

  const events = result.body?.events as readonly {
    event: string;
    origin: string;
    actions: readonly { command: string }[];
  }[];
  assert.deepEqual(
    events.map((event) => event.event),
    ["sessionStart", "sessionEnd"]
  );
  // The event every target inherits and the event Codex alone declares are
  // told apart, because that is what decides who else an edit reaches.
  assert.equal(events[0]?.origin, "shared");
  assert.equal(events[1]?.origin, "target");
  assert.equal(events[0]?.actions[0]?.command, "node session-start.ts");
});

test("the hook declaration publishes the canonical source beside the events", async (t) => {
  const options = fixture();
  t.after(() => rmSync(options.root, { recursive: true, force: true }));
  const result = await call("GET", "/control/hooks", options);
  assert.equal(result.statusCode, 200);

  // The source is published as the repository holds it, comments included: a
  // raw view that lost them would be a serialization of the declaration
  // rather than its source.
  assert.equal(result.body?.sourceText, DECLARATION);
  // The revision names the bytes the source text and the events came from,
  // so the two views of the declaration cannot describe different
  // declarations.
  assert.equal(result.body?.revision, sha256(DECLARATION));
});

test("hook collections are GET-only and former event mutation paths are absent", async (t) => {
  const options = fixture();
  t.after(() => rmSync(options.root, { recursive: true, force: true }));
  const declarationPath = path.join(
    options.repositoryRoot,
    ".rulesync",
    "hooks.jsonc"
  );
  const appliedPath = path.join(options.codexHome, "hooks.json");
  const applied = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: ".*",
          hooks: [{ type: "command", command: "node session-start.ts" }]
        }
      ]
    }
  });
  writeFileSync(appliedPath, applied);
  for (const actor of [OPERATOR_ACTOR, VIEWER_ACTOR]) {
    const read = await call("GET", "/control/hooks", options, undefined, actor);
    assert.equal(read.statusCode, 200);
    assert.equal(read.body?.readOnly, true);
    const body = {
      expectedRevision: read.body?.revision,
      actions: [{ type: "command", command: "node changed.ts" }]
    };
    for (const resource of ["/control/hooks", "/control/hooks-applied"]) {
      assert.equal(
        (await call("GET", resource, options, undefined, actor)).statusCode,
        200
      );
      for (const method of [
        "PATCH",
        "POST",
        "PUT",
        "DELETE",
        "HEAD",
        "OPTIONS"
      ]) {
        const denied = await call(method, resource, options, body, actor);
        assert.equal(denied.statusCode, 405, `${actor} ${method} ${resource}`);
        assert.equal(denied.headers.allow, "GET");
        assert.equal(
          errorCode(denied.body),
          "autodev_control_api_method_not_allowed"
        );
      }
    }
    for (const resource of [
      "/control/hooks/sessionStart",
      "/control/hooks/sessionStartt"
    ]) {
      for (const method of ["GET", "PATCH", "POST", "DELETE"]) {
        const removed = await call(method, resource, options, body, actor);
        assert.equal(removed.statusCode, 404, `${actor} ${method} ${resource}`);
        assert.equal(
          errorCode(removed.body),
          "autodev_control_api_unknown_path"
        );
      }
    }
    assert.equal(readFileSync(declarationPath, "utf8"), DECLARATION);
    assert.equal(readFileSync(appliedPath, "utf8"), applied);
  }
});

test("external hook changes update the declared side without generating a projection", async (t) => {
  const options = fixture();
  t.after(() => rmSync(options.root, { recursive: true, force: true }));
  const before = await call("GET", "/control/hooks", options);
  const changed = DECLARATION.replace(
    "node session-start.ts",
    "node changed.ts"
  );
  writeFileSync(
    path.join(options.repositoryRoot, ".rulesync", "hooks.jsonc"),
    changed
  );
  const after = await call("GET", "/control/hooks", options);
  assert.equal(after.statusCode, 200);
  assert.notEqual(after.body?.revision, before.body?.revision);
  const events = after.body?.events as readonly {
    actions: readonly { command: string }[];
  }[];
  assert.equal(events[0]?.actions[0]?.command, "node changed.ts");
  const applied = await call("GET", "/control/hooks-applied", options);
  assert.equal(applied.body?.available, false);
  assert.deepEqual(applied.body?.events, []);
});

test("hook reads and retired writes require authentication", async (t) => {
  const options = fixture();
  t.after(() => rmSync(options.root, { recursive: true, force: true }));
  await withControlApiCredential(async () => {
    for (const [method, resource] of [
      ["GET", "/control/hooks"],
      ["GET", "/control/hooks-applied"],
      ["PATCH", "/control/hooks/sessionStart"]
    ] as const) {
      const response = responseRecorder();
      await handleControlApiRequest(
        makeRequest(method, resource),
        response,
        resource,
        options
      );
      assert.equal(response.statusCode, 401);
    }
  });
});

test("the applied hook read publishes the projection beside the declared side", async () => {
  const options = fixture();
  const result = await call("GET", "/control/hooks-applied", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-hooks-applied-v1");
  assert.equal(result.body?.target, "codexcli");
  assert.equal(result.body?.available, false);
  // Nothing has been applied yet, so the declared side is published and the
  // observed side is empty rather than a claim that they agree.
  assert.deepEqual(result.body?.events, []);
  const declared = result.body?.declaredEvents as readonly { event: string }[];
  assert.deepEqual(
    declared.map((event) => event.event),
    ["sessionStart", "sessionEnd"]
  );
});
