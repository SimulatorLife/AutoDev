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
  const geminiQuota: NonNullable<ControlApiProviderRecord["quota"]> = {
    provider: "antigravity-gemini",
    status: "ok",
    source: "antigravity-cloudcode-api",
    updatedAt: "2026-11-09T15:00:00.000Z",
    summaryStatus: "available",
    windows: [
      {
        id: "antigravity-gemini-five_hour",
        label: "5-hour limit",
        kind: "five_hour",
        status: "available",
        usedPercent: 18,
        remainingPercent: 82,
        resetsAt: "2026-11-09T19:30:00.000Z"
      },
      // A limit the provider has but did not report this read.
      {
        id: "antigravity-gemini-weekly",
        label: "Weekly limit",
        kind: "weekly",
        status: "unavailable",
        usedPercent: null,
        remainingPercent: null,
        resetsAt: null
      }
    ],
    models: [
      {
        model: "gemini-3.8-flash-high",
        displayName: "Gemini 3.8 Flash (High)",
        status: "available",
        usedPercent: 18,
        remainingPercent: 82,
        resetsAt: "2026-11-09T19:30:00.000Z",
        windows: [
          {
            id: "antigravity-gemini-gemini-3.8-flash-high",
            label: "5-hour limit",
            kind: "five_hour",
            status: "available",
            usedPercent: 18,
            remainingPercent: 82,
            resetsAt: "2026-11-09T19:30:00.000Z"
          }
        ]
      }
    ]
  };

  const claudeGptQuota: NonNullable<ControlApiProviderRecord["quota"]> = {
    provider: "antigravity-claude-gpt",
    status: "ok",
    source: "antigravity-cloudcode-api",
    updatedAt: "2026-11-09T15:00:00.000Z",
    summaryStatus: "exhausted",
    windows: [
      {
        id: "antigravity-claude-gpt-five_hour",
        label: "5-hour limit",
        kind: "five_hour",
        status: "available",
        usedPercent: 40,
        remainingPercent: 60,
        resetsAt: "2026-11-09T18:00:00.000Z"
      },
      {
        id: "antigravity-claude-gpt-weekly",
        label: "Weekly limit",
        kind: "weekly",
        status: "exhausted",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: "2026-11-11T18:06:00.000Z"
      }
    ],
    models: [
      {
        model: "claude-opus-5-5-high",
        displayName: "Claude Opus 5.5 (High)",
        status: "exhausted",
        usedPercent: 100,
        remainingPercent: 0,
        resetsAt: "2026-11-11T18:06:00.000Z",
        windows: [
          {
            id: "antigravity-claude-gpt-claude-opus-5-5-high",
            label: "Weekly limit",
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

  const antigravityProvider = (
    id: string,
    quota: NonNullable<ControlApiProviderRecord["quota"]>,
    models: ControlApiProviderRecord["models"],
    roles: ControlApiProviderRecord["roles"],
    health: Partial<NonNullable<ControlApiProviderRecord["health"]>>
  ): ControlApiProviderRecord => ({
    id,
    links: {
      usage: "https://gemini.google.com/u/1/usage?pli=1",
      documentation: "https://ai.google.dev/gemini-api/docs"
    },
    route: {
      pattern: "^gemini-",
      baseUrl: "http://127.0.0.1:4002/v1",
      healthUrl: "http://127.0.0.1:4002/health/liveliness"
    },
    credential: {
      envKey: "LITELLM_API_KEY",
      configured: true
    },
    disabled: false,
    roles,
    agentLimits: {
      perSession: null,
      acrossSessions: 8
    },
    agentModels: [],
    models,
    priorities: [
      { tier: "orchestrator", group: 1 },
      { tier: "default", group: 1 }
    ],
    orchestratorReasoningEffort: "high",
    health: {
      cooldown: null,
      failureStreak: 0,
      probeFailureStreak: 0,
      inFlightRequests: 0,
      activeAgents: 1,
      attempts: 10,
      successes: 9,
      failures: 1,
      lastSuccessAt: "2026-11-09T14:58:00.000Z",
      lastFailure: null,
      lastCheck: null,
      quota,
      ...health
    },
    quota,
    reconciliation: {
      status: CONVERGED_STATUS,
      history: []
    }
  });

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
    schema: "autodev-control-providers-v4",
    orchestratorTier: "orchestrator",
    tiers: [
      {
        tier: "orchestrator",
        groups: [["antigravity-gemini", "antigravity-claude-gpt"]]
      },
      {
        tier: "default",
        groups: [["antigravity-gemini", "antigravity-claude-gpt", "minimax"]]
      }
    ],
    providers: [
      antigravityProvider(
        "antigravity-gemini",
        geminiQuota,
        [
          { tier: "orchestrator", model: "gemini-3.8-flash-high" },
          { tier: "default", model: "gemini-3.8-flash-medium" }
        ],
        buildRoleAssignments({
          orchestrator: "gemini-3.8-flash-high",
          subagent: "gemini-3.8-flash-medium"
        }),
        {}
      ),
      antigravityProvider(
        "antigravity-claude-gpt",
        claudeGptQuota,
        [{ tier: "default", model: "claude-opus-5-5-high" }],
        buildRoleAssignments({ subagent: "claude-opus-5-5-high" }),
        {
          cooldown: {
            kind: "hard",
            failureClass: "quota_exhausted",
            until: "2026-11-09T21:00:00.000Z",
            resetsAt: "2026-11-11T18:06:00.000Z",
            lastResortEligible: false
          },
          lastFailure: {
            at: "2026-11-09T14:50:00.000Z",
            failureClass: "quota_exhausted",
            status: 429,
            model: "claude-opus-5-5-high"
          }
        }
      ),
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
          subagent: "MiniMax-M2.7"
        }),
        agentLimits: null,
        agentModels: [],
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
        provider: "antigravity-gemini",
        tiers: ["orchestrator", "smart"],
        enablement: {
          enabled: true,
          mutable: true,
          convergence: CONVERGED_STATUS
        }
      },
      {
        id: "claude-opus-5-5-high",
        displayName: "Claude Opus 5.5 (High)",
        provider: "antigravity-claude-gpt",
        tiers: ["default"],
        enablement: {
          enabled: true,
          mutable: true,
          convergence: CONVERGED_STATUS
        }
      },
      {
        id: "MiniMax-M2.7",
        displayName: "MiniMax M2.7",
        provider: "minimax",
        tiers: ["default"],
        enablement: {
          enabled: true,
          mutable: true,
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
        provider: "antigravity-gemini",
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
            }
          ]
        }
      },
      {
        provider: "antigravity-claude-gpt",
        discovery: {
          status: "observed",
          source: "agy models",
          observedAt: "2026-11-09T15:00:00.000Z",
          lastAttemptAt: "2026-11-09T15:00:00.000Z",
          models: [
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

test("ProvidersView renders each Antigravity provider's own quota windows and verdict", () => {
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

  // Gemini and MiniMax have remaining quota; Claude/GPT-OSS is out for the
  // week, and that no longer takes Gemini down with it.
  assert.equal(
    (providersMarkup.match(/data-status="ready"/gu) ?? []).length,
    2
  );
  assert.match(providersMarkup, /data-provider-quota="antigravity-gemini"/u);
  assert.match(
    providersMarkup,
    /data-provider-quota-window="antigravity-gemini:antigravity-gemini-five_hour"/u
  );
  assert.match(
    providersMarkup,
    /data-provider-quota="antigravity-claude-gpt"/u
  );
  assert.match(providersMarkup, /5h: 18% used/u);
  assert.match(providersMarkup, /7d: not reported/u);
  assert.match(providersMarkup, /5h: 40% used/u);
  assert.match(providersMarkup, /7d: 100% used/u);
  assert.match(providersMarkup, /data-provider-quota="minimax"/u);
  assert.match(providersMarkup, /5h: 14% used/u);
  assert.match(providersMarkup, /7d: 25% used/u);
  assert.doesNotMatch(providersMarkup, /quota-pool/u);

  const modelsMarkup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: providersData,
      models: { status: "available", data: modelsData },
      modelDiscovery: DISCOVERY_FIXTURE,
      activeTab: "models"
    })
  );
  assert.match(modelsMarkup, /data-model-quota="gemini-3\.8-flash-high"/u);
  assert.match(modelsMarkup, /data-model-quota="claude-opus-5-5-high"/u);
});

test("ProviderDetailView and ModelDetailView render dedicated quota & usage limits sections", () => {
  const providersData = buildProvidersResponseFixture();
  const modelsData = buildModelsResponseFixture();
  const claudeGpt = providersData.providers[1]!;

  const detailMarkup = renderToStaticMarkup(
    React.createElement(ProviderDetailView, {
      provider: claudeGpt,
      tiers: providersData.tiers,
      orchestratorTier: providersData.orchestratorTier,
      models: modelsData.models.filter(
        (m) => m.provider === "antigravity-claude-gpt"
      ),
      modelDiscovery: DISCOVERY_FIXTURE,
      usagePanel: null
    })
  );

  assert.match(detailMarkup, /data-section="provider-quota-limits"/u);
  assert.doesNotMatch(detailMarkup, /quota-pool/u);
  assert.match(detailMarkup, /40% used/u);
  assert.match(detailMarkup, /100% used/u);

  const modelMarkup = renderToStaticMarkup(
    React.createElement(ModelDetailView, {
      model: modelsData.models[1]!,
      provider: claudeGpt,
      modelDiscovery: DISCOVERY_FIXTURE
    })
  );

  assert.match(modelMarkup, /data-section="model-quota-limits"/u);
  assert.match(modelMarkup, /100% used/u);
});

test("fetchProviders accepts each Antigravity provider's quota from the Control API", async () => {
  const fixture = buildProvidersResponseFixture();
  const envelope = await fetchProviders(
    {
      baseUrl: "http://127.0.0.1:4100",
      serviceToken: "test-token"
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
  assert.equal(envelope.data.providers[0]?.quota?.windows[0]?.usedPercent, 18);
  assert.equal(
    envelope.data.providers[1]?.health?.cooldown?.failureClass,
    "quota_exhausted"
  );
  assert.equal(
    envelope.data.providers[2]?.quota?.windows[0]?.usedPercent,
    13.5
  );
});
