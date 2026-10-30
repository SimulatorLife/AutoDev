import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { createAgentActivityTracker } from "../src/agents/agent-activity.ts";
import {
  handleControlApiRequest,
  resetOperationHistoryForTests
} from "../src/control-api/index.ts";
import {
  ConcurrencyManager,
  setDefaultConcurrencyManager
} from "../src/router/concurrency/index.ts";
import {
  getDefaultPersistenceManager,
  type RouterPersistence,
  setDefaultPersistenceManager
} from "../src/router/persistence/index.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

/**
 * The concurrency limit is a mutable resource like every other one the
 * Console writes, and it was the last one whose write answered with the
 * applied value alone -- so "the write was accepted" and "the Runtime is
 * enforcing this limit" were the same claim. These tests pin the two apart:
 * the write publishes the shared reconciliation view, and the generations it
 * publishes are the limit that was asked for and the limit that is enforced.
 */

const SERVICE_TOKEN = "concurrency-reconciliation-secret-token-0123456789";
const OPERATOR_ACTOR = "concurrency-operator";
const CONCURRENCY_PATH = "/control/runtime/concurrency";
const CONFIG_FILE_LIMIT = 8;

interface ReconciliationStatus {
  readonly convergence: string;
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly lastApplyAt: string | null;
  readonly lastObservationAt: string | null;
  readonly lastError: string | null;
}

interface ReconciliationBundle {
  readonly status: ReconciliationStatus;
  readonly history: readonly {
    readonly action: string;
    readonly resource: string;
    readonly outcome: string;
  }[];
}

interface ConcurrencyPatchResponse {
  readonly schema: string;
  readonly reconciliation: ReconciliationBundle;
}

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

function harness(): {
  readonly restore: () => void;
  readonly call: (
    method: string,
    pathname: string,
    body?: Record<string, unknown>
  ) => Promise<{ status: number; body: Record<string, unknown> | null }>;
} {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;

  // The limit is persisted to the router's state file. The test exercises what
  // the runtime reports, not where it stores it, so the persistence is
  // replaced with a manager that reports success: the mutation then lands in
  // the live limit exactly as it does in production.
  const originalPersistence = getDefaultPersistenceManager();
  setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);

  // A manager of the test's own, so the config file's limit is the one the
  // test states and no other test's write is in force.
  const manager = new ConcurrencyManager({
    agentActivity: createAgentActivityTracker(),
    configFile: "/nonexistent/autodev-codex-concurrency.json",
    configSource: "config_file",
    initialConfig: {
      file: "/nonexistent/autodev-codex-concurrency.json",
      maxConcurrentThreadsPerSession: CONFIG_FILE_LIMIT
    }
  });
  setDefaultConcurrencyManager(manager);

  const restoreEnv = (name: string, previous: string | undefined): void => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };

  return {
    restore: () => {
      setDefaultConcurrencyManager(null);
      setDefaultPersistenceManager(originalPersistence);
      restoreEnv("AUTODEV_CONTROL_API_TOKEN", previousToken);
      restoreEnv("AUTODEV_CONTROL_OPERATORS", previousOperators);
    },
    call: async (method, pathname, body) => {
      const response = responseRecorder();
      await handleControlApiRequest(
        request(method, pathname, body),
        response,
        pathname
      );
      let parsed: Record<string, unknown> | null = null;
      if (response.body) {
        try {
          parsed = JSON.parse(response.body) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
      }
      return { status: response.statusCode, body: parsed };
    }
  };
}

async function patchLimit(
  call: (
    method: string,
    pathname: string,
    body?: Record<string, unknown>
  ) => Promise<{ status: number; body: Record<string, unknown> | null }>,
  body: Record<string, unknown>
): Promise<ConcurrencyPatchResponse> {
  const applied = await call("PATCH", CONCURRENCY_PATH, body);
  assert.equal(applied.status, 200);
  return applied.body as unknown as ConcurrencyPatchResponse;
}

test("the concurrency write publishes the limit it is enforcing", async () => {
  // The audit ring is process-wide, so an earlier spec's operation for the
  // same resource would otherwise decide what this one observes.
  resetOperationHistoryForTests();
  const h = harness();
  try {
    const applied = await patchLimit(h.call, {
      maxConcurrentThreadsPerSession: 12
    });

    assert.equal(applied.schema, "autodev-control-concurrency-v2");
    const status = applied.reconciliation.status;
    // The limit is enforced by the router's own concurrency manager, in the
    // process that serves this write, so the observation is immediate: the
    // generation the Runtime enforces is the one that was asked for.
    assert.equal(status.convergence, "converged");
    assert.equal(status.desiredGeneration, "limit:12");
    assert.equal(status.observedGeneration, "limit:12");
    assert.ok(status.lastApplyAt);
    assert.ok(status.lastObservationAt);
    assert.equal(status.lastError, null);
    // The history is the resource's operations *before* this one: the view is
    // built before the write is audited, so a write cannot report itself as
    // history it has not happened yet.
    assert.deepEqual(applied.reconciliation.history, []);
  } finally {
    h.restore();
  }
});

test("the next concurrency write carries the previous one as its history", async () => {
  resetOperationHistoryForTests();
  const h = harness();
  try {
    await patchLimit(h.call, { maxConcurrentThreadsPerSession: 12 });
    const second = await patchLimit(h.call, {
      maxConcurrentThreadsPerSession: 4
    });

    assert.equal(second.reconciliation.history.length, 1);
    assert.equal(
      second.reconciliation.history[0]?.action,
      "patch_runtime_concurrency"
    );
    assert.equal(second.reconciliation.history[0]?.resource, CONCURRENCY_PATH);
    assert.equal(second.reconciliation.history[0]?.outcome, "ok");
  } finally {
    h.restore();
  }
});

test("an unlimited limit is a generation of its own", async () => {
  resetOperationHistoryForTests();
  const h = harness();
  try {
    const applied = await patchLimit(h.call, {
      maxConcurrentThreadsPerSession: null
    });

    // `null` is how this Runtime says "unlimited" -- a fact about the
    // deployment, not a missing field -- so it is a generation of its own
    // rather than the absence of one.
    assert.equal(
      applied.reconciliation.status.desiredGeneration,
      "limit:unlimited"
    );
    assert.equal(
      applied.reconciliation.status.observedGeneration,
      "limit:unlimited"
    );
  } finally {
    h.restore();
  }
});

test("a reset asks for the config file's limit, not for no change", async () => {
  resetOperationHistoryForTests();
  const h = harness();
  try {
    const applied = await patchLimit(h.call, { resetToConfigFile: true });

    // The operator asked to go back to what the config file says, so the
    // desired generation is that limit. "No change" would be a generation that
    // cannot be compared with the limit the Runtime ends up enforcing.
    assert.equal(
      applied.reconciliation.status.desiredGeneration,
      `limit:${String(CONFIG_FILE_LIMIT)}`
    );
    assert.equal(
      applied.reconciliation.status.observedGeneration,
      `limit:${String(CONFIG_FILE_LIMIT)}`
    );
    assert.equal(applied.reconciliation.status.convergence, "converged");
  } finally {
    h.restore();
  }
});

test("a refused concurrency write is not an apply", async () => {
  resetOperationHistoryForTests();
  const h = harness();
  try {
    const denied = await h.call("PATCH", CONCURRENCY_PATH, {
      maxConcurrentThreadsPerSession: 12
    });
    assert.equal(denied.status, 200);

    const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
    const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
    process.env.AUTODEV_CONTROL_OPERATORS = "";
    try {
      const refused = await h.call("PATCH", CONCURRENCY_PATH, {
        maxConcurrentThreadsPerSession: 4
      });
      assert.equal(refused.status, 403);
    } finally {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
      if (previousOperators === undefined) {
        delete process.env.AUTODEV_CONTROL_OPERATORS;
      } else {
        process.env.AUTODEV_CONTROL_OPERATORS = previousOperators;
      }
    }
  } finally {
    h.restore();
  }
});
