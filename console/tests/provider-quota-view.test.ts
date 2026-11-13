import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiProvidersResponse } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProviderModelDiscoveryState } from "../src/features/providers/provider-model-discovery.ts";
import { ProvidersView } from "../src/features/providers/ProvidersView.ts";
import { fetchProviders } from "../src/lib/server/control-api.ts";

const emptyDiscovery: ProviderModelDiscoveryState = {
  status: "unavailable",
  message: "No provider model discovery was observed."
};

function renderReport(
  quotaAxi: NonNullable<ControlApiProvidersResponse["quotaAxi"]> | null
): string {
  const response = {
    schema: "autodev-control-providers-v5",
    orchestratorTier: "orchestrator",
    tiers: [],
    providers: [],
    quotaAxi
  } as unknown as ControlApiProvidersResponse;
  return renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: response,
      models: { status: "unavailable", message: "Not observed" },
      modelDiscovery: emptyDiscovery
    })
  );
}

test("quota overview preserves package provider identity, state, windows, resets and unknown semantics", () => {
  const markup = renderReport({
    generatedAt: "2026-11-13T12:00:00.000Z",
    schemaVersion: 6,
    providers: [
      {
        provider: "agy",
        windows: [
          {
            id: "session",
            label: "Session",
            kind: "session",
            percentUsed: 141.25,
            resetsAt: "2026-11-13T18:00:00.000Z"
          }
        ],
        quotaSemantics: {
          status: "unknown",
          effectiveAvailability: [
            { scope: "account", status: "unknown", boundedBy: ["session"] }
          ]
        },
        state: {
          status: "stale",
          stale: true,
          refreshedAt: "2026-11-13T11:00:00.000Z"
        }
      }
    ]
  });
  assert.match(markup, /data-quota-provider="agy"/u);
  assert.match(
    markup,
    /Status: stale · Stale: true · Refreshed: 2026-11-13T11:00:00\.000Z/u
  );
  assert.match(markup, /141\.25%/u);
  assert.match(markup, /2026-11-13T18:00:00\.000Z/u);
  assert.match(markup, /Quota semantics: unknown/u);
  assert.match(markup, /account: unknown/u);
  assert.doesNotMatch(markup, /JSON.stringify/u);
});

test("quota overview distinguishes omitted values from unknown statuses", () => {
  const markup = renderReport({
    generatedAt: "2026-11-13T12:00:00.000Z",
    schemaVersion: 6,
    providers: [
      {
        provider: "codex",
        windows: [{ id: "weekly", label: "Weekly", kind: "weekly" }],
        quotaSemantics: {
          status: "unknown",
          effectiveAvailability: [
            { scope: "model", status: "unknown", boundedBy: [] }
          ]
        },
        state: { status: "unavailable", stale: false }
      }
    ]
  });
  assert.match(
    markup,
    /Pace: Not reported · Used: Not reported · Remaining: Not reported/u
  );
  assert.match(markup, /Resets: Not reported/u);
  assert.match(
    markup,
    /Status: unavailable · Stale: false · Refreshed: Not reported/u
  );
  assert.match(markup, /model: unknown/u);
});

test("fetchProviders passes the quota-axi report through without reshaping it", async () => {
  const quotaAxi: NonNullable<ControlApiProvidersResponse["quotaAxi"]> = {
    generatedAt: "2026-11-13T12:00:00.000Z",
    schemaVersion: 6,
    providers: [
      {
        provider: "agy",
        windows: [{ id: "unknown", label: "Unknown", kind: "unknown" }],
        quotaSemantics: {
          status: "unknown",
          effectiveAvailability: [
            { scope: "account", status: "unknown", boundedBy: [] }
          ]
        },
        state: { status: "stale", stale: true }
      }
    ]
  };
  const response: ControlApiProvidersResponse = {
    schema: "autodev-control-providers-v5",
    orchestratorTier: "orchestrator",
    tiers: [],
    providers: [],
    quotaAxi
  };

  const result = await fetchProviders(
    { baseUrl: "http://control-api.test", serviceToken: "test-token" },
    { fetchImpl: async () => Response.json(response) }
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.data.quotaAxi, quotaAxi);
});
