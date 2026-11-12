import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import test from "node:test";

import { setRouterAuthTokenForTests } from "@simulatorlife/autodev-runtime/router/auth";
import {
  getRouterStatus,
  handle,
  resetRouterTelemetry
} from "@simulatorlife/autodev-runtime/router/http";
import { ROUTING_POLICY as routing } from "@simulatorlife/autodev-runtime/router/routing";

import { useNonDelegatingContract } from "./non-delegating-contract.ts";

/**
 * A provider that cannot delegate is not an orchestrator provider.
 *
 * The orchestrator's whole job is creating child agents, so a provider with no
 * delegation path cannot serve the orchestrator tier however it is enabled and
 * ranked. Every surface that reported enablement used to say otherwise: the
 * Console showed the provider at P1 for the orchestrator, and an operator who
 * believed it disabled every other provider -- and was then told that no
 * provider was enabled, when the one that was enabled could never have served.
 *
 * These tests pin the two halves of the fix: the router names the real cause,
 * and the surfaces that report a provider's role participation agree with the
 * router about whether it can serve that role at all.
 */

// Every shipped provider can delegate, so this file runs against a contract
// in which MiniMax declares no delegation path.
const NON_DELEGATING = "minimax";
const restoreContract = useNonDelegatingContract(NON_DELEGATING);
test.after(restoreContract);
const NON_DELEGATING_ROLES = ["subagent"] as const;

// The launcher publishes CODEX_ROUTER_AUTH_TOKEN into the launchd user
// domain, so a maintainer's shell normally carries it. Without pinning, the
// module would arm the auth gate and the request below -- which sends no
// Authorization header -- would 401 on a correctly configured machine.
setRouterAuthTokenForTests("");

function listenServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("a provider with no delegation path is reported as unable to serve the orchestrator", () => {
  assert.equal(
    routing.providerRoleCapabilityReason(NON_DELEGATING, "orchestrator"),
    "provider_cannot_delegate"
  );
  assert.equal(
    routing.providerRoleCapabilityReason(NON_DELEGATING, "subagent"),
    null,
    "only the orchestrator needs a delegation path"
  );
  assert.equal(
    routing.providerRoleCapabilityReason("claude", "orchestrator"),
    null,
    "a provider with a delegation path can serve the orchestrator"
  );

  // The explanation names the provider and the cause, because it is the text
  // the operator reads on the Console and in the router's refusal.
  const explanation = routing.providerRoleCapabilityExplanation(
    NON_DELEGATING,
    "orchestrator"
  );
  assert.ok(explanation);
  assert.match(explanation, /minimax cannot serve the orchestrator role/u);
  assert.match(explanation, /no delegation path/u);
  assert.equal(
    routing.providerRoleCapabilityExplanation("claude", "orchestrator"),
    null
  );
});

test("enablement and the ability to serve are separate facts", () => {
  const previous =
    routing.assignmentFor(NON_DELEGATING, "orchestrator") ?? null;
  try {
    routing.setProviderAssignment(NON_DELEGATING, "orchestrator", {
      priority: 1,
      model: "MiniMax-M3"
    });

    // Enabled for the role: the operator's switch, and the answer the Console
    // used to give on its own.
    assert.equal(
      routing.isProviderEnabledForRole(NON_DELEGATING, "orchestrator"),
      true
    );
    // Cannot serve it: the router's own filter, which the surface above has to
    // agree with.
    assert.equal(
      routing.canProviderServeRole(NON_DELEGATING, "orchestrator"),
      false
    );
    assert.equal(
      routing.routeDisabledReason(
        { provider: NON_DELEGATING, model: "MiniMax-M3" },
        "orchestrator"
      ),
      "provider_cannot_delegate"
    );

    // A role with no delegation requirement is unaffected.
    for (const role of NON_DELEGATING_ROLES) {
      assert.equal(
        routing.providerRoleCapabilityReason(NON_DELEGATING, role),
        null,
        `${role} needs no delegation path`
      );
    }
  } finally {
    if (previous)
      routing.setProviderAssignment(NON_DELEGATING, "orchestrator", previous);
    else routing.clearProviderAssignment(NON_DELEGATING, "orchestrator");
  }
});

test("an empty tier says which cause emptied it: switched off, or unable to delegate", () => {
  const previous =
    routing.assignmentFor(NON_DELEGATING, "orchestrator") ?? null;
  try {
    routing.setProviderAssignment(NON_DELEGATING, "orchestrator", {
      priority: 1,
      model: "MiniMax-M3"
    });

    const blockers = routing.tierServingBlockers(
      routing.config.orchestrator.tier,
      "orchestrator"
    );
    assert.ok(
      blockers.cannotDelegate.includes(NON_DELEGATING),
      "an enabled provider with no delegation path is named as the blocker"
    );
    assert.ok(
      !blockers.servable.includes(NON_DELEGATING),
      "and it is not counted as able to serve"
    );
    for (const provider of blockers.disabled) {
      assert.notEqual(provider, NON_DELEGATING);
    }
  } finally {
    if (previous)
      routing.setProviderAssignment(NON_DELEGATING, "orchestrator", previous);
    else routing.clearProviderAssignment(NON_DELEGATING, "orchestrator");
  }
});

test("an orchestrator request with only a non-delegating provider names the cause", async () => {
  resetRouterTelemetry();
  routing.resetRoleAssignment("orchestrator");
  routing.resetRoleAssignment("subagent");
  const providers = routing.providerIds();
  const previousAssignments = providers.map((provider) => ({
    provider,
    assignment: routing.assignmentFor(provider, "orchestrator") ?? null
  }));
  const previousEnabled = providers.map((provider) => ({
    provider,
    enabled: routing.isProviderEnabled(provider)
  }));
  try {
    // Only MiniMax is enabled, and it is enabled for every role: the state the
    // Console produced and the operator believed.
    for (const provider of providers) {
      routing.setProviderEnabled(provider, provider === NON_DELEGATING);
    }
    for (const provider of providers) {
      routing.setProviderAssignment(provider, "orchestrator", {
        priority: provider === NON_DELEGATING ? 1 : ("disabled" as const),
        model: provider === NON_DELEGATING ? "MiniMax-M3" : null
      });
    }

    const server = createServer((request, response) => {
      void handle(request, response);
    });
    await listenServer(server);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "autodev/orchestrator", stream: false })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error?.code, "router_provider_exhausted");
      assert.equal(body.error?.retryable, false);
      // The cause is the provider's capability, not an enable switch: the
      // provider was enabled, and no switch would have served the request.
      assert.equal(body.error?.failureClass, "provider_cannot_delegate");
      assert.match(
        body.error?.message,
        /minimax cannot serve the orchestrator/u
      );
      assert.doesNotMatch(
        body.error?.message,
        /No enabled providers/u,
        "the old message blamed the enable switches for a capability gap"
      );

      // The router status agrees with the router: MiniMax is enabled for the
      // orchestrator and cannot serve it.
      const status = getRouterStatus();
      assert.equal(status.routing.enabledOrchestratorProviders.length, 0);
      assert.deepEqual(status.routing.incapableOrchestratorProviders, [
        NON_DELEGATING
      ]);
      assert.equal(
        status.providers[NON_DELEGATING]?.orchestratorEnabled,
        true,
        "the operator's switch is still reported as it is"
      );
      assert.equal(
        status.providers[NON_DELEGATING]?.orchestratorCapable,
        false,
        "and the capability is reported next to it"
      );
      assert.equal(
        status.providers[NON_DELEGATING]?.orchestratorStatus,
        "cannot_delegate"
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    for (const { provider, assignment } of previousAssignments) {
      if (assignment)
        routing.setProviderAssignment(provider, "orchestrator", assignment);
      else routing.clearProviderAssignment(provider, "orchestrator");
    }
    for (const { provider, enabled } of previousEnabled) {
      routing.setProviderEnabled(provider, enabled);
    }
    resetRouterTelemetry();
  }
});
