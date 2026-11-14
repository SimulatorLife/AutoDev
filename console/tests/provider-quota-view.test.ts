import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiProviderRecord,
  ControlApiProvidersResponse
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProviderModelDiscoveryState } from "../src/features/providers/provider-model-discovery.ts";
import { ProvidersView } from "../src/features/providers/ProvidersView.ts";
import { fetchProviders } from "../src/lib/server/control-api.ts";

const emptyDiscovery: ProviderModelDiscoveryState = {
  status: "unavailable",
  message: "No provider model discovery was observed."
};

const ANTIGRAVITY_ROW_IDS = [
  "antigravity-gemini",
  "antigravity-argon",
  "antigravity-claude-gpt"
] as const;

const NO_CONVERGENCE = {
  convergence: "not-observed" as const,
  desiredGeneration: null,
  observedGeneration: null,
  lastApplyAt: null,
  lastObservationAt: null,
  lastError: null,
  explanation: "Not observed."
};

function providerRecord(id: string): ControlApiProviderRecord {
  const role = {
    priority: "disabled" as const,
    model: null,
    mutable: false,
    convergence: NO_CONVERGENCE
  };
  return {
    id,
    links: { usage: null, documentation: null },
    route: null,
    credential: { envKey: null, configured: false },
    disabled: false,
    roles: { orchestrator: role, subagent: role },
    agentLimits: null,
    agentModels: [],
    models: [],
    priorities: [],
    orchestratorReasoningEffort: null,
    health: null,
    reconciliation: { status: NO_CONVERGENCE, history: [] }
  } as unknown as ControlApiProviderRecord;
}

function renderProvidersView(
  quotaAxi: NonNullable<ControlApiProvidersResponse["quotaAxi"]> | null,
  providerIds: readonly string[] = [...ANTIGRAVITY_ROW_IDS, "codex"]
): string {
  const response = {
    schema: "autodev-control-providers-v5",
    orchestratorTier: "orchestrator",
    tiers: [],
    providers: providerIds.map(providerRecord),
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

/** The table row whose provider-id link is `id`. */
function rowFor(markup: string, id: string): string {
  const rows = markup.match(/<tr[\s\S]*?<\/tr>/gu) ?? [];
  const row = rows.find((candidate) => candidate.includes(`>${id}<`));
  assert.ok(row, `no row for provider ${id}`);
  return row;
}

test("provider rows show shared quota bars, reset times and package semantics", () => {
  const markup = renderProvidersView({
    generatedAt: "2026-11-13T12:00:00.000Z",
    schemaVersion: 5,
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
      },
      {
        provider: "cursor",
        windows: [],
        state: { status: "unavailable", stale: false }
      }
    ]
  });
  assert.doesNotMatch(markup, /Quota report|quota-axi-overview/u);
  assert.doesNotMatch(markup, /data-quota-provider="cursor"/u);
  const antigravityRows = ANTIGRAVITY_ROW_IDS.map((id) => rowFor(markup, id));
  for (const row of antigravityRows) {
    assert.match(row, /data-quota-provider="agy"/u);
    assert.match(row, /Quota: agy/u);
    assert.match(row, /progressbar/u);
    assert.match(row, /Resets: (<!-- -->)?2026-11-13T18:00:00\.000Z/u);
  }
  const agyRow = antigravityRows[0]!;
  assert.doesNotMatch(rowFor(markup, "codex"), /data-quota-provider/u);
  assert.match(rowFor(markup, "codex"), /Not reported/u);
  assert.match(
    agyRow,
    /Status: stale · Stale: true · Refreshed: 2026-11-13T11:00:00\.000Z/u
  );
  // Bar sits in the matching row; text keeps the true >100 value while the
  // bar geometry and ARIA range are clamped.
  assert.match(agyRow, /<div role="progressbar"[^>]*aria-valuenow="100"/u);
  assert.match(agyRow, /aria-valuemax="100"/u);
  assert.match(agyRow, /aria-valuetext="141\.25% used"/u);
  assert.match(agyRow, /width:100%/u);
  assert.match(agyRow, /Used: (<!-- -->)?141\.25%/u);
  assert.doesNotMatch(rowFor(markup, "codex"), /progressbar/u);
  assert.doesNotMatch(agyRow, /<details/u);
  assert.match(agyRow, /Quota semantics: unknown/u);
  assert.match(agyRow, /account: unknown/u);
  assert.doesNotMatch(markup, /JSON.stringify/u);
});

test("provider rows distinguish omitted values from unknown statuses", () => {
  const markup = renderProvidersView({
    generatedAt: "2026-11-13T12:00:00.000Z",
    schemaVersion: 5,
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
  const codexRow = rowFor(markup, "codex");
  assert.match(codexRow, /Used: (<!-- -->)?Not reported/u);
  assert.match(codexRow, /Pace: (<!-- -->)?Not reported/u);
  assert.match(codexRow, /Remaining: (<!-- -->)?Not reported/u);
  assert.doesNotMatch(codexRow, /progressbar/u);
  assert.match(codexRow, /Resets: Not reported/u);
  assert.match(
    codexRow,
    /Status: unavailable · Stale: false · Refreshed: Not reported/u
  );
  assert.match(codexRow, /model: unknown/u);
});

test("fetchProviders passes the quota-axi report through without reshaping it", async () => {
  const quotaAxi: NonNullable<ControlApiProvidersResponse["quotaAxi"]> = {
    generatedAt: "2026-11-13T12:00:00.000Z",
    schemaVersion: 5,
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
