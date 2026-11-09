import assert from "node:assert/strict";
import test from "node:test";

import {
  type ControlApiModelsResponse,
  type ControlApiProviderRecord,
  type ControlApiProvidersResponse,
  PROVIDER_ROLES,
  type ReconciliationStatus
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelDetailView } from "../src/features/providers/ModelDetailView.ts";
import type { ProviderModelDiscoveryState } from "../src/features/providers/provider-model-discovery.ts";
import { ProviderDetailView } from "../src/features/providers/ProviderDetailView.ts";
import { ProvidersView } from "../src/features/providers/ProvidersView.ts";
import { fetchProviders } from "../src/lib/server/control-api.ts";

const CONVERGED_STATUS: ReconciliationStatus = {
  convergence: "converged",
  desiredGeneration: "gen-1",
  observedGeneration: "gen-1",
  lastApplyAt: "2026-11-09T15:00:00.000Z",
  lastObservationAt: "2026-11-09T15:00:00.000Z",
  lastError: null,
  explanation: "Converged"
};

function buildRoleAssignments(
  modelByRole: Partial<Record<(typeof PROVIDER_ROLES)[number], string>>
): ControlApiProviderRecord["roles"] {
  return Object.fromEntries(
    PROVIDER_ROLES.map((role) => [
      role,
      {
        priority: modelByRole[role] ? 1 : "disabled",
        model: modelByRole[role] ?? null,
        mutable: true,
        convergence: CONVERGED_STATUS,
        canServe: true,
        cannotServeReason: null
      }
    ])
  ) as ControlApiProviderRecord["roles"];
}

function buildProvidersResponseFixture(): ControlApiProvidersResponse {
  const antigravityQuota: NonNullable<ControlApiProviderRecord["quota"]> = {
    provider: "antigravity",
    status: "ok",
    source: "antigravity-cloudcode-api",
    updatedAt: "2026-11-09T15:00:00.000Z",
    summaryStatus: "available",
    windows: [
      {
        id: "antigravity-pool-first_party",
        label: "Gemini (First-Party) quota",
        kind: "five_hour",
        status: "available",
        usedPercent: 18,
        remainingPercent: 82,
        resetsAt: "2026-11-09T19:30:00.000Z"
      },
      {
        id: "antigravity-pool-third_party",
        label: "Claude (Third-Party) quota",
        kind: "weekly",
        status: "exhausted",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: "2026-11-11T18:06:00.000Z"
      }
    ],
    pools: [
      {
        pool: "first_party",
        label: "Gemini (First-Party)",
        status: "available",
        usedPercent: 18,
        remainingPercent: 82,
        resetsAt: "2026-11-09T19:30:00.000Z",
        windows: [
          {
            id: "antigravity-pool-first_party",
            label: "Gemini (First-Party) quota",
            kind: "five_hour",
            status: "available",
            usedPercent: 18,
            remainingPercent: 82,
            resetsAt: "2026-11-09T19:30:00.000Z"
          }
        ],
        models: ["gemini-3.8-flash-high", "gemini-3.8-flash-medium"]
      },
      {
        pool: "third_party",
        label: "Claude (Third-Party)",
        status: "exhausted",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: "2026-11-11T18:06:00.000Z",
        windows: [
          {
            id: "antigravity-pool-third_party",
            label: "Claude (Third-Party) quota",
            kind: "weekly",
            status: "exhausted",
            usedPercent: 100,
            remainingPercent: 0,
            resetsAt: "2026-11-11T18:06:00.000Z"
          }
        ],
        models: ["claude-opus-5-5-high", "claude-sonnet-5-5-medium"],
        cooldown: {
          kind: "hard",
          failureClass: "quota_exhausted",
          until: "2026-11-09T21:00:00.000Z",
          resetsAt: "2026-11-11T18:06:00.000Z",
          lastResortEligible: false,
          scope: "pool",
          pool: "third_party"
        }
      }
    ],
    models: [
      {
        model: "gemini-3.8-flash-high",
        displayName: "Gemini 3.8 Flash (High)",
        pool: "first_party",
        status: "available",
        usedPercent: 18,
        remainingPercent: 82,
        resetsAt: "2026-11-09T19:30:00.000Z",
        windows: [
          {
            id: "antigravity-gemini-3.8-flash-high",
            label: "5-hour limit",
            kind: "five_hour",
            status: "available",
            usedPercent: 18,
            remainingPercent: 82,
            resetsAt: "2026-11-09T19:30:00.000Z"
          }
        ]
      },
      {
        model: "claude-opus-5-5-high",
        displayName: "Claude Opus 5.5 (High)",
        pool: "third_party",
        status: "exhausted",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: "2026-11-11T18:06:00.000Z",
        windows: [
          {
            id: "antigravity-claude-opus-5-5-high",
            label: "Pool limit",
            kind: "weekly",
            status: "exhausted",
            usedPercent: 100,
            remainingPercent: 0,
            resetsAt: "2026-11-11T18:06:00.000Z"
          }
        ]
      }
    ]
  };

  const minimaxQuota: NonNullable<ControlApiProviderRecord["quota"]> = {
    provider: "minimax",
    status: "ok",
    source: "mmx quota --output json",
    updatedAt: "2026-11-09T15:00:00.000Z",
    plan: "Coding Plan",
    summaryStatus: "available",
    windows: [
      {
        id: "minimax-5h",
        label: "5-hour limit",
        kind: "five_hour",
        status: "available",
        usedPercent: 13.5,
        remainingPercent: 86.5,
        used: 202,
        limit: 1500,
        windowSeconds: 18_000,
        resetsAt: "2026-11-09T19:00:00.000Z"
      },
      {
        id: "minimax-weekly",
        label: "Weekly limit",
        kind: "weekly",
        status: "available",
        usedPercent: 25,
        remainingPercent: 75,
        windowSeconds: 604_800,
        resetsAt: "2026-11-15T00:00:00.000Z"
      }
    ]
  };

  return {
    schema: "autodev-control-providers-v3",
    orchestratorTier: "orchestrator",
    tiers: [
      {
        tier: "orchestrator",
        groups: [["antigravity"]]
      },
      {
        tier: "default",
        groups: [["antigravity", "minimax"]]
      }
    ],
    providers: [
      {
        id: "antigravity",
        links: {
          usage: "https://gemini.google.com/u/1/usage?pli=1",
          documentation: "https://ai.google.dev/gemini-api/docs"
        },
        route: {
          pattern: "^(gemini-|claude-)",
          baseUrl: "http://127.0.0.1:4002/v1",
          healthUrl: "http://127.0.0.1:4002/health/liveliness"
        },
        credential: {
          envKey: "LITELLM_API_KEY",
          configured: true
        },
        disabled: false,
        roles: buildRoleAssignments({
          orchestrator: "gemini-3.8-flash-high",
          worker: "gemini-3.8-flash-medium"
        }),
        agentLimits: {
          perSession: null,
          acrossSessions: 8
        },
        models: [
          { tier: "orchestrator", model: "gemini-3.8-flash-high" },
          { tier: "default", model: "gemini-3.8-flash-medium" },
          { tier: "claude-opus", model: "claude-opus-5-5-high" }
        ],
        priorities: [
          { tier: "orchestrator", group: 1 },
          { tier: "default", group: 1 }
        ],
        orchestratorReasoningEffort: "high",
        health: {
          cooldown: null,
          poolCooldowns: {
            third_party: {
              kind: "hard",
              failureClass: "quota_exhausted",
              until: "2026-11-09T21:00:00.000Z",
              resetsAt: "2026-11-11T18:06:00.000Z",
              lastResortEligible: false,
              scope: "pool",
              pool: "third_party"
            }
          },
          failureStreak: 0,
          probeFailureStreak: 0,
          inFlightRequests: 0,
          activeAgents: 1,
          attempts: 10,
          successes: 9,
          failures: 1,
          lastSuccessAt: "2026-11-09T14:58:00.000Z",
          lastFailure: {
            at: "2026-11-09T14:50:00.000Z",
            failureClass: "quota_exhausted",
            status: 429,
            pool: "third_party",
            model: "claude-opus-5-5-high"
          },
          lastCheck: null,
          quota: antigravityQuota
        },
        quota: antigravityQuota,
        reconciliation: {
          status: CONVERGED_STATUS,
          history: []
        }
      },
      {
        id: "minimax",
        links: {
          usage: "https://platform.minimax.io",
          documentation: "https://platform.minimax.io/docs"
        },
        route: {
          pattern: "^MiniMax-",
          baseUrl: "http://127.0.0.1:18765/v1",
          healthUrl: "http://127.0.0.1:18765/health"
        },
        credential: {
          envKey: "MINIMAX_API_KEY",
          configured: true
        },
        disabled: false,
        roles: buildRoleAssignments({
          worker: "MiniMax-M2.7"
        }),
        agentLimits: null,
        models: [{ tier: "default", model: "MiniMax-M2.7" }],
        priorities: [{ tier: "default", group: 1 }],
        orchestratorReasoningEffort: null,
        health: {
          cooldown: null,
          failureStreak: 0,
          probeFailureStreak: 0,
          inFlightRequests: 0,
          activeAgents: 0,
          attempts: 5,
          successes: 5,
          failures: 0,
          lastSuccessAt: "2026-11-09T14:59:00.000Z",
          lastFailure: null,
          lastCheck: null,
          quota: minimaxQuota
        },
        quota: minimaxQuota,
        reconciliation: {
          status: CONVERGED_STATUS,
          history: []
        }
      }
    ]
  };
}

function buildModelsResponseFixture(): ControlApiModelsResponse {
  return {
    schema: "autodev-control-models-v2",
    source: "config/model-routing.json",
    models: [
      {
        id: "gemini-3.8-flash-high",
        displayName: "Gemini 3.8 Flash (High)",
        provider: "antigravity",
        tiers: ["orchestrator", "smart"],
        enablement: {
          kind: "observed",
          enabled: true,
          mutable: true,
          revision: "rev-1",
          convergence: CONVERGED_STATUS
        }
      },
      {
        id: "claude-opus-5-5-high",
        displayName: "Claude Opus 5.5 (High)",
        provider: "antigravity",
        tiers: ["claude-opus"],
        enablement: {
          kind: "observed",
          enabled: true,
          mutable: true,
          revision: "rev-1",
          convergence: CONVERGED_STATUS
        }
      },
      {
        id: "MiniMax-M2.7",
        displayName: "MiniMax M2.7",
        provider: "minimax",
        tiers: ["default"],
        enablement: {
          kind: "observed",
          enabled: true,
          mutable: true,
          revision: "rev-1",
          convergence: CONVERGED_STATUS
        }
      }
    ]
  };
}

const DISCOVERY_FIXTURE: ProviderModelDiscoveryState = {
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
          observedAt: "2026-11-09T15:00:00.000Z",
          lastAttemptAt: "2026-11-09T15:00:00.000Z",
          models: [
            {
              id: "gemini-3.8-flash-high",
              displayName: "Gemini 3.8 Flash (High)",
              routeability: { status: "supported" }
            },
            {
              id: "claude-opus-5-5-high",
              displayName: "Claude Opus 5.5 (High)",
              routeability: { status: "supported" }
            }
          ]
        }
      },
      {
        provider: "minimax",
        discovery: {
          status: "observed",
          source: "mmx models",
          observedAt: "2026-11-09T15:00:00.000Z",
          lastAttemptAt: "2026-11-09T15:00:00.000Z",
          models: [
            {
              id: "MiniMax-M2.7",
              displayName: "MiniMax M2.7",
              routeability: { status: "supported" }
            }
          ]
        }
      }
    ]
  }
};

test("ProvidersView renders inline provider quota windows and subprovider pools while keeping Antigravity Ready", () => {
  const providersData = buildProvidersResponseFixture();
  const modelsData = buildModelsResponseFixture();

  const providersMarkup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: providersData,
      models: { status: "available", data: modelsData },
      modelDiscovery: DISCOVERY_FIXTURE,
      activeTab: "providers"
    })
  );

  // Both providers have remaining quota (Antigravity's first_party Gemini pool has 82% left), so both show Ready.
  assert.equal((providersMarkup.match(/data-status="ready"/gu) ?? []).length, 2);
  assert.match(providersMarkup, /data-provider-quota="antigravity"/u);
  assert.match(providersMarkup, /Gemini: 18% used/u);
  assert.match(providersMarkup, /Claude: 100% used/u);
  assert.match(providersMarkup, /data-provider-quota="minimax"/u);
  assert.match(providersMarkup, /5h: 14% used/u);
  assert.match(providersMarkup, /7d: 25% used/u);

  const modelsMarkup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: providersData,
      models: { status: "available", data: modelsData },
      modelDiscovery: DISCOVERY_FIXTURE,
      activeTab: "models"
    })
  );
  assert.match(
    modelsMarkup,
    /data-model-quota="gemini-3\.8-flash-high"/u
  );
  assert.match(
    modelsMarkup,
    /data-model-quota="claude-opus-5-5-high"/u
  );
});

test("ProviderDetailView and ModelDetailView render dedicated quota & usage limits sections", () => {
  const providersData = buildProvidersResponseFixture();
  const modelsData = buildModelsResponseFixture();
  const antigravity = providersData.providers[0]!;

  const detailMarkup = renderToStaticMarkup(
    React.createElement(ProviderDetailView, {
      provider: antigravity,
      tiers: providersData.tiers,
      orchestratorTier: providersData.orchestratorTier,
      models: modelsData.models.filter((m) => m.provider === "antigravity"),
      modelDiscovery: DISCOVERY_FIXTURE,
      usagePanel: null
    })
  );

  assert.match(detailMarkup, /data-section="provider-quota-limits"/u);
  assert.match(detailMarkup, /Subprovider quota pools/u);
  assert.match(detailMarkup, /data-quota-pool="first_party"/u);
  assert.match(detailMarkup, /data-quota-pool="third_party"/u);
  assert.match(detailMarkup, /18% used/u);
  assert.match(detailMarkup, /100% used/u);

  const modelMarkup = renderToStaticMarkup(
    React.createElement(ModelDetailView, {
      model: modelsData.models[1]!,
      provider: antigravity,
      modelDiscovery: DISCOVERY_FIXTURE
    })
  );

  assert.match(modelMarkup, /data-section="model-quota-limits"/u);
  assert.match(modelMarkup, /third_party/u);
  assert.match(modelMarkup, /100% used/u);
});

test("fetchProviders accepts provider quota and poolCooldowns payloads from Control API", async () => {
  const fixture = buildProvidersResponseFixture();
  const envelope = await fetchProviders(
    {
      baseUrl: "http://127.0.0.1:4100",
      token: "test-token"
    },
    {
      fetchImpl: async () =>
        new Response(JSON.stringify(fixture), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    }
  );
  assert.equal(envelope.kind, "ok");
  if (envelope.kind !== "ok") return;
  assert.equal(
    envelope.data.providers[0]?.quota?.pools?.[0]?.usedPercent,
    18
  );
  assert.equal(
    envelope.data.providers[0]?.health?.poolCooldowns?.third_party?.pool,
    "third_party"
  );
  assert.equal(
    envelope.data.providers[1]?.quota?.windows[0]?.usedPercent,
    13.5
  );
});
