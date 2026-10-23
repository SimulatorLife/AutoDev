import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { handleControlApiRequest } from "../src/control-api/index.ts";
import {
  makeRequest,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVICE_TOKEN = "h".repeat(64);
const OPERATOR_ACTOR = "hook-mutation-operator";

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

/**
 * The projection configuration the write generates against.
 *
 * Only the Codex target is configured, because the Runtime installs one hook
 * projection and a projection for a target it does not install would be a
 * second thing to keep in step.
 */
const PROJECTION_CONFIG = `{
  "targets": ["codexcli"],
  "features": ["hooks"],
  "outputRoots": ["."]
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
 * A repository root and a Codex home.
 *
 * The projection is generated from the declaration by RuleSync, so the
 * fixture carries the repository's own copy of RuleSync.
 */
function fixture(): {
  readonly repositoryRoot: string;
  readonly codexHome: string;
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
  writeFileSync(
    path.join(repositoryRoot, "rulesync.jsonc"),
    PROJECTION_CONFIG,
    "utf8"
  );
  symlinkSync(
    path.join(REPOSITORY_ROOT, "node_modules"),
    path.join(repositoryRoot, "node_modules"),
    "dir"
  );
  return { repositoryRoot, codexHome };
}

/**
 * The credential the Control API requires, installed for the duration of the
 * request and removed again afterwards.
 */
async function withControlApiCredential<T>(run: () => Promise<T>): Promise<T> {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  return run().finally(() => {
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    if (previousOperators === undefined)
      delete process.env.AUTODEV_CONTROL_OPERATORS;
    else process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
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
): Promise<{ statusCode: number; body: Record<string, unknown> | null }> {
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
    body: responseBody(response) as Record<string, unknown> | null
  };
}

test("the hook declaration publishes the target's effective events and the revision a write compares against", async () => {
  const options = fixture();
  const result = await call("GET", "/control/hooks", options);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-hooks-v2");
  assert.equal(result.body?.target, "codexcli");
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

test("a canonical hook write changes the declaration and the applied projection", async () => {
  const options = fixture();
  const declaration = await call("GET", "/control/hooks", options);
  const revision = String(declaration.body?.revision);

  const result = await call("PATCH", "/control/hooks/sessionStart", options, {
    expectedRevision: revision,
    actions: [
      { type: "command", command: "node other-session-start.ts" },
      { type: "command", matcher: ".*", command: "node extra.ts" }
    ]
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body?.schema, "autodev-control-hook-event-patch-v1");
  assert.equal(result.body?.event, "sessionStart");
  assert.equal(result.body?.target, "codexcli");
  assert.equal(result.body?.changed, true);
  assert.notEqual(result.body?.revision, revision);

  // The canonical declaration carries the new action list, and the comment
  // outside the edited event is still there.
  const written = readFileSync(
    path.join(options.repositoryRoot, ".rulesync", "hooks.jsonc"),
    "utf8"
  );
  assert.match(written, /node other-session-start\.ts/u);
  assert.match(written, /node extra\.ts/u);
  assert.match(written, /The shared declaration\./u);
  // The event the target declares alone is not touched by a write to the
  // event it inherits.
  assert.match(written, /node session-end\.ts/u);

  // The applied projection is the new one, and the Runtime observed it.
  const projection = JSON.parse(
    readFileSync(path.join(options.codexHome, "hooks.json"), "utf8")
  ) as {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
  };
  assert.equal(
    projection.hooks.SessionStart?.[0]?.hooks[0]?.command,
    "node other-session-start.ts"
  );
  const reconciliation = result.body?.reconciliation as {
    status: { convergence: string };
  };
  assert.equal(reconciliation.status.convergence, "converged");
});

test("a canonical hook write is refused when the declaration changed since it was read", async () => {
  const options = fixture();
  const declaration = await call("GET", "/control/hooks", options);
  const revision = String(declaration.body?.revision);

  // Another writer changes the declaration first.
  const declarationPath = path.join(
    options.repositoryRoot,
    ".rulesync",
    "hooks.jsonc"
  );
  writeFileSync(declarationPath, `${DECLARATION}\n`, "utf8");

  const result = await call("PATCH", "/control/hooks/sessionStart", options, {
    expectedRevision: revision,
    actions: [{ type: "command", command: "node other.ts" }]
  });
  assert.equal(result.statusCode, 409);
  assert.equal(
    (result.body?.error as { code?: string } | undefined)?.code,
    "autodev_control_hook_revision_conflict"
  );
  // The declaration the other writer left is untouched.
  assert.match(
    readFileSync(declarationPath, "utf8"),
    /node session-start\.ts/u
  );
});

test("a canonical hook write is refused for a body that is not an action list", async () => {
  const options = fixture();
  const declaration = await call("GET", "/control/hooks", options);
  const result = await call("PATCH", "/control/hooks/sessionStart", options, {
    expectedRevision: String(declaration.body?.revision),
    actions: [{ type: "script", command: "node other.ts" }]
  });
  assert.equal(result.statusCode, 400);
  assert.equal(
    (result.body?.error as { code?: string } | undefined)?.code,
    "autodev_control_api_invalid_body"
  );
});

test("a canonical hook write is refused for an event the Runtime does not run", async () => {
  const options = fixture();
  const declaration = await call("GET", "/control/hooks", options);
  const result = await call("PATCH", "/control/hooks/sessionStartt", options, {
    expectedRevision: String(declaration.body?.revision),
    actions: [{ type: "command", command: "node other.ts" }]
  });
  // The event is refused by name, because "that is not a hook event" and
  // "that body is not an action list" are different facts.
  assert.equal(result.statusCode, 400);
  assert.equal(
    (result.body?.error as { code?: string } | undefined)?.code,
    "autodev_control_hook_unknown_event"
  );
});

test("a canonical hook write is refused without the operator credential", async () => {
  const options = fixture();
  const response = responseRecorder();
  await handleControlApiRequest(
    makeRequest("PATCH", "/control/hooks/sessionStart"),
    response,
    "/control/hooks/sessionStart",
    options
  );
  assert.notEqual(response.statusCode, 200);
  // The declaration is unchanged, because the request was never authorized.
  assert.match(
    readFileSync(
      path.join(options.repositoryRoot, ".rulesync", "hooks.jsonc"),
      "utf8"
    ),
    /node session-start\.ts/u
  );

  // A caller that may read the declaration but may not write it is refused as
  // well, and the refusal says that the write needs an operator.
  const declaration = await call("GET", "/control/hooks", options);
  const viewer = await call(
    "PATCH",
    "/control/hooks/sessionStart",
    options,
    {
      expectedRevision: String(declaration.body?.revision),
      actions: [{ type: "command", command: "node viewer.ts" }]
    },
    "hook-mutation-viewer"
  );
  assert.equal(viewer.statusCode, 403);
  // The actor is refused by the authorization layer before the write is
  // reached, so the declaration is never touched.
  assert.equal(
    (viewer.body?.error as { code?: string } | undefined)?.code,
    "autodev_control_api_actor_forbidden"
  );
  assert.match(
    readFileSync(
      path.join(options.repositoryRoot, ".rulesync", "hooks.jsonc"),
      "utf8"
    ),
    /node session-start\.ts/u
  );
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
