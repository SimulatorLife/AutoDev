import assert from "node:assert/strict";
import test from "node:test";

import type {
  AgentDefinition,
  ControlApiLiveAgentCounts,
  ControlApiModelsResponse,
  ControlApiProviderRecord,
  ControlApiProvidersResponse,
  ControlApiRuntimeResponse
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  LIVE_COUNT_REFRESH_EVENT,
  LIVE_COUNT_REFRESH_INTERVAL_MS,
  registerLiveCountRefresh,
  startLiveCountRefresh
} from "../src/components/navigation/live-count-refresh.ts";
import { LiveCountRefresh } from "../src/components/navigation/LiveCountRefresh.ts";
import { AgentDetailView } from "../src/features/agents/AgentDetailView.ts";
import { AgentsView } from "../src/features/agents/AgentsView.ts";
import { liveAgentCount } from "../src/features/live-agent-count.ts";
import { ProviderDetailView } from "../src/features/providers/ProviderDetailView.ts";
import { ProvidersView } from "../src/features/providers/ProvidersView.ts";

const NO_CONVERGENCE = {
  convergence: "not-observed" as const,
  desiredGeneration: null,
  observedGeneration: null,
  lastApplyAt: null,
  lastObservationAt: null,
  lastError: null,
  explanation: "Not observed."
};

const PROVIDER: ControlApiProviderRecord = {
  id: "provider-fixture",
  links: { usage: null, documentation: null },
  route: null,
  credential: { envKey: null, configured: false },
  disabled: false,
  roles: {
    default: {
      priority: "disabled",
      model: null,
      mutable: false,
      convergence: NO_CONVERGENCE
    },
    smart: {
      priority: "disabled",
      model: null,
      mutable: false,
      convergence: NO_CONVERGENCE
    },
    orchestrator: {
      priority: "disabled",
      model: null,
      mutable: false,
      convergence: NO_CONVERGENCE
    },
    subagent: {
      priority: "disabled",
      model: null,
      mutable: false,
      convergence: NO_CONVERGENCE
    }
  },
  agentLimits: null,
  models: [],
  priorities: [],
  orchestratorReasoningEffort: null,
  health: {
    cooldown: null,
    failureStreak: 0,
    probeFailureStreak: 0,
    inFlightRequests: 0,
    activeAgents: 99,
    attempts: 0,
    successes: 0,
    failures: 0,
    lastSuccessAt: null,
    lastFailure: null
  }
};

const ACTIVE_COUNTS: ControlApiLiveAgentCounts = {
  count: 3,
  byRole: { "role-fixture": 2 },
  byProvider: { "provider-fixture": 2 },
  byModel: { "provider-fixture/model-fixture": 1 },
  missingProvider: 1,
  missingModel: 2
};

function runtime(
  liveAgents: ControlApiLiveAgentCounts | null
): ControlApiRuntimeResponse {
  return {
    schema: "autodev-control-runtime-v2",
    routerInstanceId: "router-fixture",
    lifecycle: {
      state: "ready",
      draining: false,
      changedAt: "2026-10-10T12:00:00.000Z",
      activeResponseRequests: 0
    },
    concurrency: {},
    inFlightRequestCount: 0,
    liveAgents
  };
}

test("live-count lookup distinguishes unavailable data from observed zero", () => {
  assert.equal(
    liveAgentCount(null, "byModel", "provider/model"),
    "Not observed"
  );
  assert.equal(
    liveAgentCount(
      {
        count: 0,
        byRole: {},
        byProvider: {},
        byModel: {},
        missingProvider: 0,
        missingModel: 0
      },
      "byModel",
      "provider/model"
    ),
    "0"
  );
  assert.equal(
    liveAgentCount(ACTIVE_COUNTS, "byModel", "provider-fixture/model-fixture"),
    "1"
  );
});

test("agent, provider, and model views render counts from one Runtime projection", () => {
  const agent: AgentDefinition = {
    id: "agent-fixture",
    role: "role-fixture",
    kind: "leaf",
    readOnly: true,
    configured: true,
    valid: null,
    status: "configured",
    convergence: "not-observed",
    primaryModel: "configured-model",
    models: [],
    providers: [],
    tools: [],
    toolNames: []
  };
  const agentsMarkup = renderToStaticMarkup(
    React.createElement(AgentsView, {
      agents: [agent],
      runtime: runtime(ACTIVE_COUNTS)
    })
  );
  assert.match(agentsMarkup, /Active instances: 2/);
  assert.match(agentsMarkup, /Active Agent Instances/);
  assert.match(agentsMarkup, />3</);

  const agentDetailMarkup = renderToStaticMarkup(
    React.createElement(AgentDetailView, {
      agent,
      reconciliation: { status: NO_CONVERGENCE, history: [] },
      runtime: runtime(ACTIVE_COUNTS)
    })
  );
  assert.match(agentDetailMarkup, /data-live-agent-role="role-fixture"/);
  assert.match(agentDetailMarkup, /Active instances<\/dt><dd[^>]*>2/);

  const model: ControlApiModelsResponse["models"][number] = {
    id: "model-fixture",
    provider: "provider-fixture",
    tiers: [],
    displayName: null,
    enablement: {
      enabled: true,
      mutable: true,
      convergence: {
        convergence: "not-observed",
        desiredGeneration: null,
        observedGeneration: null,
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: "Not observed."
      }
    }
  };
  const providers: ControlApiProvidersResponse = {
    schema: "autodev-control-providers-v2",
    orchestratorTier: "root",
    tiers: [],
    providers: [PROVIDER]
  };
  const models: ControlApiModelsResponse = {
    schema: "autodev-control-models-v2",
    source: "fixture",
    models: [model]
  };
  const modelsMarkup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers,
      models: { status: "available", data: models },
      runtime: runtime(ACTIVE_COUNTS),
      activeTab: "models"
    })
  );
  assert.match(modelsMarkup, /data-live-agent-model="model-fixture"[^>]*>1</);

  const providerDetailMarkup = renderToStaticMarkup(
    React.createElement(ProviderDetailView, {
      provider: PROVIDER,
      tiers: [],
      orchestratorTier: "root",
      models: [],
      runtime: runtime(ACTIVE_COUNTS)
    })
  );
  assert.match(
    providerDetailMarkup,
    /data-live-agent-provider="provider-fixture"/
  );
  assert.match(providerDetailMarkup, /Active agents<\/dt><dd[^>]*>2/);
});

test("live-count refresh schedules and clears a five-second server refresh", () => {
  let scheduled: (() => void) | undefined;
  let interval = 0;
  let cleared: unknown;
  const handle = {};
  const scheduler = {
    setInterval: (callback: () => void, delay: number) => {
      scheduled = callback;
      interval = delay;
      return handle;
    },
    clearInterval: (value: unknown) => {
      cleared = value;
    }
  } as unknown as Pick<typeof globalThis, "setInterval" | "clearInterval">;
  let refreshes = 0;
  const cleanup = startLiveCountRefresh(() => refreshes++, scheduler);
  assert.equal(interval, LIVE_COUNT_REFRESH_INTERVAL_MS);
  scheduled?.();
  assert.equal(refreshes, 1);
  cleanup();
  assert.equal(cleared, handle);

  const target = new EventTarget();
  let routerRefreshes = 0;
  const unregister = registerLiveCountRefresh(() => routerRefreshes++, target);
  target.dispatchEvent(new Event(LIVE_COUNT_REFRESH_EVENT));
  assert.equal(routerRefreshes, 1);
  unregister();
  target.dispatchEvent(new Event(LIVE_COUNT_REFRESH_EVENT));
  assert.equal(routerRefreshes, 1);

  const marker = renderToStaticMarkup(React.createElement(LiveCountRefresh));
  assert.match(marker, /Live counts refresh every 5 seconds/);
});
