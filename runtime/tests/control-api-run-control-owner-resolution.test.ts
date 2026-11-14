import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { PROVIDER_ROLES } from "@simulatorlife/autodev-core";

import {
  type ControlApiRequestOptions,
  handleControlApiRequest
} from "../src/control-api/request-handler.ts";
import {
  type RouterPersistence,
  setDefaultPersistenceManager
} from "../src/router/persistence/index.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "run-control-owner-secret-token-0123456789abcdef0123";
const OPERATOR_ACTOR = "run-control-operator";

function request(
  method: string,
  url: string,
  body?: Record<string, unknown>
): IncomingMessage {
  const headers: Record<string, string> = {
    host: "127.0.0.1",
    authorization: `Bearer ${SERVICE_TOKEN}`,
    "x-autodev-actor": OPERATOR_ACTOR
  };
  if (body) headers["content-type"] = "application/json";
  return Object.assign(Readable.from(body ? [JSON.stringify(body)] : []), {
    method,
    url,
    headers
  }) as IncomingMessage;
}

/**
 * Options whose run-control owner records every read. The route resolves the
 * owner with `options.playtestingRunControl ?? getDefaultPlaytestRunControl()`,
 * so a read here marks the exact point at which a request would otherwise
 * construct the default owner and its on-disk repositories.
 */
function ownerReadCounter(): {
  readonly options: ControlApiRequestOptions;
  readonly reads: () => number;
} {
  let reads = 0;
  const options = {
    get playtestingRunControl() {
      reads += 1;
      return {} as never;
    }
  } as ControlApiRequestOptions;
  return { options, reads: () => reads };
}

async function dispatch(
  method: string,
  pathname: string,
  options: ControlApiRequestOptions,
  body?: Record<string, unknown>
): Promise<void> {
  const previous = {
    token: process.env.AUTODEV_CONTROL_API_TOKEN,
    operators: process.env.AUTODEV_CONTROL_OPERATORS
  };
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  const originalPersistence = setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);
  try {
    // The stub owner is not a real run owner, so a run-control dispatch may
    // fail after resolving it; only the resolution itself is under test.
    await handleControlApiRequest(
      request(method, pathname, body),
      responseRecorder(),
      pathname,
      options
    ).catch(() => undefined);
  } finally {
    setDefaultPersistenceManager(originalPersistence);
    for (const [name, value] of [
      ["AUTODEV_CONTROL_API_TOKEN", previous.token],
      ["AUTODEV_CONTROL_OPERATORS", previous.operators]
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("a provider-role mutation never resolves the playtesting run-control owner", async () => {
  const counter = ownerReadCounter();
  await dispatch(
    "PATCH",
    `/control/providers/claude/roles/${PROVIDER_ROLES[0]}`,
    counter.options,
    { priority: 4 }
  );
  assert.equal(
    counter.reads(),
    0,
    "only run-control paths may resolve the run owner"
  );
});

test("a run-control path does resolve the playtesting run-control owner", async () => {
  const counter = ownerReadCounter();
  await dispatch("GET", "/control/playtesting/capabilities", counter.options);
  assert.ok(
    counter.reads() > 0,
    "the owner seam must observe run-control resolution, or the guard test proves nothing"
  );
});
