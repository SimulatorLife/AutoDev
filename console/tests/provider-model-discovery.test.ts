import assert from "node:assert/strict";
import test from "node:test";

import {
  type ControlApiModelRecord,
  LOCAL_CONTROL_API_ACTOR
} from "@simulatorlife/autodev-core";

import {
  providerDiscoverySummaries,
  providerModelAvailability,
  providerModelChoices,
  type ProviderModelDiscoveryState,
  providerModelDiscoveryView,
  providerModelRows,
  unsupportedProviderModels
} from "../src/features/providers/provider-model-discovery.ts";
import { fetchProviderModelDiscovery } from "../src/lib/server/control-api.ts";

const config = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "server-only-fixture-token"
};

function response(discovery: unknown): Response {
  return Response.json({
    schema: "autodev-control-provider-model-discovery-v1",
    source: "runtime-provider-discovery",
    providers: [
      { provider: "antigravity", discovery },
      {
        provider: "copilot",
        discovery: {
          status: "unavailable",
          source: null,
          lastAttemptAt: null,
          reason: "No machine-readable model listing is configured."
        }
      }
    ]
  });
}

test("provider model discovery reads the authenticated Runtime projection", async () => {
  const requests: Array<{ url: string; method: string; headers: Headers }> = [];
  const result = await fetchProviderModelDiscovery(config, {
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers)
      });
      return response({
        status: "observed",
        source: "agy models",
        observedAt: "2026-10-14T12:00:00.000Z",
        lastAttemptAt: "2026-10-14T12:00:00.000Z",
        models: [
          {
            id: "gemini-3.8-flash-low",
            displayName: "Gemini Flash Low",
            routeability: { status: "supported" }
          },
          {
            id: "gpt-oss-120b-medium",
            displayName: "GPT OSS Medium",
            routeability: {
              status: "unsupported",
              reason: "Runtime has no route for this model ID."
            }
          }
        ]
      });
    }
  });

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.data.providers[0]?.discovery.status, "observed");
  assert.equal(result.data.providers[1]?.discovery.status, "unavailable");
  assert.deepEqual(requests, [
    {
      url: "http://127.0.0.1:4101/control/provider-models",
      method: "GET",
      headers: new Headers({
        authorization: `Bearer ${config.serviceToken}`,
        "x-autodev-actor": LOCAL_CONTROL_API_ACTOR,
        accept: "application/json"
      })
    }
  ]);
});

test("provider discovery preserves stale state instead of treating it as current", async () => {
  const result = await fetchProviderModelDiscovery(config, {
    fetchImpl: async () =>
      response({
        status: "stale",
        source: "agy models",
        observedAt: "2026-10-14T11:00:00.000Z",
        lastAttemptAt: "2026-10-14T12:00:00.000Z",
        reason: "Provider listing timed out.",
        models: [
          {
            id: "gemini-3.8-flash-low",
            displayName: null,
            routeability: { status: "supported" }
          }
        ]
      })
  });

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  const discovery = result.data.providers[0]?.discovery;
  assert.equal(discovery?.status, "stale");
  if (discovery?.status === "stale") {
    assert.equal(discovery.reason, "Provider listing timed out.");
    assert.equal(discovery.models[0]?.id, "gemini-3.8-flash-low");
  }
});

test("provider discovery rejects malformed states and duplicate IDs as one invalid response", async () => {
  const invalidSnapshots = [
    {
      status: "observed",
      source: "agy models",
      observedAt: "2026-10-14T12:00:00.000Z",
      lastAttemptAt: "2026-10-14T12:00:00.000Z",
      models: [
        {
          id: "gemini-3.8-flash-low",
          displayName: null,
          routeability: { status: "unsupported", reason: " " }
        }
      ]
    },
    {
      status: "observed",
      source: "agy models",
      observedAt: "2026-10-14T12:00:00.000Z",
      lastAttemptAt: "2026-10-14T12:00:00.000Z",
      models: [
        {
          id: "gemini-3.8-flash-low",
          displayName: null,
          routeability: { status: "supported" }
        },
        {
          id: "gemini-3.8-flash-low",
          displayName: "duplicate",
          routeability: { status: "supported" }
        }
      ]
    },
    {
      status: "observed",
      source: "agy models",
      observedAt: "not-a-timestamp",
      lastAttemptAt: "2026-10-14T12:00:00.000Z",
      models: []
    }
  ];

  for (const snapshot of invalidSnapshots) {
    const result = await fetchProviderModelDiscovery(config, {
      fetchImpl: async () => response(snapshot)
    });
    assert.equal(result.kind, "invalid-response");
    if (result.kind === "invalid-response") {
      assert.equal(
        result.code,
        "autodev_control_api_invalid_provider_model_discovery_response"
      );
    }
  }
});

test("provider availability keeps observed, stale, unsupported, and unavailable distinct", () => {
  const discovery: ProviderModelDiscoveryState = {
    status: "available",
    data: {
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [
        {
          provider: "antigravity",
          discovery: {
            status: "observed",
            source: "agy models",
            observedAt: "2026-10-14T12:00:00.000Z",
            lastAttemptAt: "2026-10-14T12:00:00.000Z",
            models: [
              {
                id: "gemini-3.8-flash-low",
                displayName: null,
                routeability: { status: "supported" }
              },
              {
                id: "gpt-oss-120b-medium",
                displayName: "GPT OSS Medium",
                routeability: {
                  status: "unsupported",
                  reason: "Runtime has no route for this model ID."
                }
              }
            ]
          }
        },
        {
          provider: "minimax",
          discovery: {
            status: "stale",
            source: "MiniMax model list",
            observedAt: "2026-10-14T11:00:00.000Z",
            lastAttemptAt: "2026-10-14T12:00:00.000Z",
            reason: "The provider model request timed out.",
            models: [
              {
                id: "MiniMax-M3.1-Flash-Preview",
                displayName: null,
                routeability: { status: "supported" }
              }
            ]
          }
        },
        {
          provider: "copilot",
          discovery: {
            status: "unavailable",
            source: null,
            lastAttemptAt: null,
            reason: "No machine-readable model listing is configured."
          }
        }
      ]
    }
  };

  assert.deepEqual(
    providerModelChoices(discovery, "antigravity").map(({ id }) => id),
    ["gemini-3.8-flash-low"]
  );
  assert.deepEqual(unsupportedProviderModels(discovery), [
    {
      provider: "antigravity",
      id: "gpt-oss-120b-medium",
      displayName: "GPT OSS Medium",
      reason: "Runtime has no route for this model ID.",
      discoveryStatus: "observed"
    }
  ]);
  assert.deepEqual(
    providerModelAvailability(discovery, "antigravity", "gemini-3.8-flash-low"),
    { status: "observed", source: "agy models" }
  );
  assert.deepEqual(
    providerModelAvailability(discovery, "antigravity", "gpt-oss-120b-medium"),
    {
      status: "unsupported",
      reason: "Runtime has no route for this model ID.",
      discoveryStatus: "observed"
    }
  );
  assert.deepEqual(
    providerModelAvailability(discovery, "antigravity", "no-longer-listed"),
    {
      status: "not-listed",
      reason: "The current provider listing does not include this model."
    }
  );
  assert.deepEqual(
    providerModelAvailability(
      discovery,
      "minimax",
      "MiniMax-M3.1-Flash-Preview"
    ),
    { status: "stale", reason: "The provider model request timed out." }
  );
  assert.deepEqual(
    providerModelAvailability(discovery, "copilot", "copilot-new-model"),
    {
      status: "unavailable",
      reason: "No machine-readable model listing is configured."
    }
  );
  assert.equal(
    providerDiscoverySummaries(discovery)[0]?.modelCount,
    2,
    "an observed listing retains its actual total, including unsupported IDs"
  );
  assert.equal(
    providerModelDiscoveryView(
      {
        status: "available",
        data: {
          schema: "autodev-control-provider-model-discovery-v1",
          source: "runtime-provider-discovery",
          providers: [
            {
              provider: "empty",
              discovery: {
                status: "observed",
                source: "empty fixture",
                observedAt: "2026-10-14T12:00:00.000Z",
                lastAttemptAt: "2026-10-14T12:00:00.000Z",
                models: []
              }
            }
          ]
        }
      },
      "empty"
    ).status,
    "observed",
    "an observed-empty listing is not rendered as unavailable"
  );
});

test("model rows keep routing assignment separate from provider availability", () => {
  const configuredUnsupported: ControlApiModelRecord = {
    id: "gpt-oss-120b-medium",
    provider: "antigravity",
    tiers: ["default"],
    displayName: "Configured static name",
    enablement: {
      enabled: true,
      mutable: false,
      convergence: {
        convergence: "not-observed",
        desiredGeneration: "enabled=true",
        observedGeneration: "enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: "Not observed."
      }
    }
  };
  const discovery: ProviderModelDiscoveryState = {
    status: "available",
    data: {
      schema: "autodev-control-provider-model-discovery-v1",
      source: "runtime-provider-discovery",
      providers: [
        {
          provider: "antigravity",
          discovery: {
            status: "observed",
            source: "agy models",
            observedAt: "2026-10-14T12:00:00.000Z",
            lastAttemptAt: "2026-10-14T12:00:00.000Z",
            models: [
              {
                id: "gemini-3.8-flash-low",
                displayName: "Gemini Flash Low",
                routeability: { status: "supported" }
              },
              {
                id: configuredUnsupported.id,
                displayName: null,
                routeability: {
                  status: "unsupported",
                  reason: "Runtime has no route for this model ID."
                }
              }
            ]
          }
        }
      ]
    }
  };
  const rows = providerModelRows([configuredUnsupported], discovery);
  assert.deepEqual(
    rows.map(({ id, enablement, tiers, availability }) => ({
      id,
      enablement,
      tiers,
      availability: availability.status
    })),
    [
      {
        id: "gemini-3.8-flash-low",
        enablement: null,
        tiers: [],
        availability: "observed"
      }
    ],
    "current provider discovery adds routeable IDs and does not pass unsupported IDs through the routing catalog"
  );

  const discoveryUnavailable: ProviderModelDiscoveryState = {
    status: "unavailable",
    message: "Control API discovery could not be read."
  };
  const configuredRows = providerModelRows(
    [configuredUnsupported],
    discoveryUnavailable
  );
  assert.equal(configuredRows.length, 1);
  assert.equal(configuredRows[0]?.availability.status, "not-observed");
  assert.equal(
    configuredRows[0]?.enablement,
    configuredUnsupported.enablement,
    "an unavailable discovery read does not erase independent routing state"
  );
});
