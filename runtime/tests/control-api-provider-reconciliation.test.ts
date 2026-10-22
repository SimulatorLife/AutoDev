import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  handleControlApiRequest,
  resetOperationHistoryForTests
} from "../src/control-api/index.ts";
import {
  getDefaultPersistenceManager,
  type RouterPersistence,
  setDefaultPersistenceManager
} from "../src/router/persistence/index.ts";
import { ROUTING_POLICY } from "../src/router/routing.ts";
import { responseRecorder } from "./support/control-api-harness.ts";

const SERVICE_TOKEN = "provider-reconciliation-secret-token-0123456789abcdef";
const OPERATOR_ACTOR = "provider-operator";
const VIEWER_ACTOR = "provider-viewer";
const PROVIDER = "claude";

interface ProviderReconciliation {
  readonly status: {
    readonly convergence: string;
    readonly desiredGeneration: string | null;
    readonly observedGeneration: string | null;
    readonly lastApplyAt: string | null;
    readonly lastObservationAt: string | null;
    readonly lastError: string | null;
  };
  readonly history: readonly {
    readonly action: string;
    readonly resource: string;
    readonly outcome: string;
  }[];
}

interface ProviderRecord {
  readonly id: string;
  readonly reconciliation: ProviderReconciliation;
}

function request(
  method: string,
  url: string,
  body?: Record<string, unknown>,
  actor: string = OPERATOR_ACTOR
): IncomingMessage {
  const headers: Record<string, string> = {
    host: "127.0.0.1",
    authorization: `Bearer ${SERVICE_TOKEN}`,
    "x-autodev-actor": actor
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
    body?: Record<string, unknown>,
    actor?: string
  ) => Promise<{ status: number; body: Record<string, unknown> | null }>;
} {
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  const previousOperators = process.env.AUTODEV_CONTROL_OPERATORS;
  const previousViewers = process.env.AUTODEV_CONTROL_VIEWERS;
  process.env.AUTODEV_CONTROL_API_TOKEN = SERVICE_TOKEN;
  process.env.AUTODEV_CONTROL_OPERATORS = OPERATOR_ACTOR;
  process.env.AUTODEV_CONTROL_VIEWERS = VIEWER_ACTOR;

  // The provider's routing state is persisted to the router's state file. The
  // test exercises what the runtime reports, not where it stores it, so the
  // persistence is replaced with a manager that reports success: the mutation
  // then lands in the live routing policy exactly as it does in production.
  const originalPersistence = getDefaultPersistenceManager();
  setDefaultPersistenceManager({
    async persistNow() {
      return true;
    }
  } as unknown as RouterPersistence);

  const restoreEnv = (name: string, previous: string | undefined): void => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };

  return {
    restore: () => {
      setDefaultPersistenceManager(originalPersistence);
      restoreEnv("AUTODEV_CONTROL_API_TOKEN", previousToken);
      restoreEnv("AUTODEV_CONTROL_OPERATORS", previousOperators);
      restoreEnv("AUTODEV_CONTROL_VIEWERS", previousViewers);
    },
    call: async (method, pathname, body, actor) => {
      const response = responseRecorder();
      await handleControlApiRequest(
        request(method, pathname, body, actor),
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

async function readProvider(
  call: (
    method: string,
    pathname: string
  ) => Promise<{
    body: Record<string, unknown> | null;
  }>,
  id: string = PROVIDER
): Promise<ProviderRecord> {
  const read = await call("GET", "/control/providers");
  const providers = read.body?.providers as ProviderRecord[] | undefined;
  const provider = providers?.find((entry) => entry.id === id);
  assert.ok(provider, `the providers read must carry ${id}`);
  return provider;
}

test("the providers read carries each provider's own reconciliation view", async () => {
  // The audit ring is process-wide, so an earlier spec's operation for the
  // same provider would otherwise decide what this one observes.
  resetOperationHistoryForTests();
  const h = harness();
  try {
    const read = await h.call("GET", "/control/providers");
    assert.equal(read.status, 200);
    assert.equal(read.body?.schema, "autodev-control-providers-v3");
    const providers = read.body?.providers as ProviderRecord[];
    assert.ok(providers.length > 0);
    for (const provider of providers) {
      const status = provider.reconciliation.status;
      // Nobody has written to this provider yet, so the runtime has observed
      // nothing: the verdict is "not observed" rather than a synthesized
      // convergence.
      assert.equal(status.convergence, "not-observed");
      assert.equal(status.observedGeneration, null);
      assert.equal(status.lastApplyAt, null);
      // The desired generation is the identity of the provider's configured
      // routing state, so it is present even before anything is applied.
      assert.match(String(status.desiredGeneration), /^[0-9a-f]{64}$/u);
      assert.deepEqual(provider.reconciliation.history, []);
    }
  } finally {
    h.restore();
  }
});

test("a refused provider write is recorded but is not an apply", async () => {
  resetOperationHistoryForTests();
  const h = harness();
  try {
    const denied = await h.call(
      "PATCH",
      `/control/providers/${PROVIDER}`,
      { disabled: true },
      VIEWER_ACTOR
    );
    assert.equal(denied.status, 403);

    const provider = await readProvider(h.call);
    const status = provider.reconciliation.status;
    // A refusal changed nothing, so it is not evidence that the provider's
    // configuration has been applied.
    assert.equal(status.convergence, "not-observed");
    assert.equal(status.observedGeneration, null);
    // The refusal is still the operator's most recent operation.
    assert.equal(provider.reconciliation.history.length, 1);
    assert.equal(provider.reconciliation.history[0]?.outcome, "denied");
  } finally {
    h.restore();
  }
});

test("an applied provider write is observed on the next read", async () => {
  resetOperationHistoryForTests();
  const h = harness();
  try {
    const before = await readProvider(h.call);
    const applied = await h.call(
      "PATCH",
      `/control/providers/${PROVIDER}/limits`,
      { perSession: 3, acrossSessions: 8 }
    );
    assert.equal(applied.status, 200);

    const after = await readProvider(h.call);
    const status = after.reconciliation.status;
    // The provider's configuration changed, so its desired generation changed
    // with it: the generation identifies the configuration, not the provider.
    assert.notEqual(
      status.desiredGeneration,
      before.reconciliation.status.desiredGeneration
    );
    // The router serves the live routing policy, so the configuration it
    // serves is the one the runtime holds: the two generations agree.
    assert.equal(status.convergence, "converged");
    assert.equal(status.observedGeneration, status.desiredGeneration);
    assert.ok(status.lastApplyAt);
    assert.equal(status.lastError, null);
    assert.equal(after.reconciliation.history.length, 1);
    assert.equal(
      after.reconciliation.history[0]?.action,
      "patch_provider_limits"
    );
    assert.equal(
      after.reconciliation.history[0]?.resource,
      `/control/providers/${PROVIDER}/limits`
    );
  } finally {
    h.restore();
    ROUTING_POLICY.clearProviderLimits(PROVIDER);
  }
});
