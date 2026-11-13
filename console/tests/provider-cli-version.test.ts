import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiProviderRecord,
  ControlApiProvidersResponse,
  ControlApiProviderVersionsResponse
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  providerCliVersionLabel,
  type ProviderCliVersionState,
  providerCliVersionView
} from "../src/features/providers/provider-cli-version.ts";
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

function provider(id: string): ControlApiProviderRecord {
  return {
    id,
    links: { usage: null, documentation: null },
    route: null,
    credential: { envKey: null, configured: false },
    disabled: false,
    roles: {
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
    agentModels: [],
    models: [],
    priorities: [],
    orchestratorReasoningEffort: null,
    health: null,
    reconciliation: { status: NO_CONVERGENCE, history: [] }
  };
}

const PROVIDERS: ControlApiProvidersResponse = {
  schema: "autodev-control-providers-v5",
  quotaAxi: null,
  orchestratorTier: "orchestrator",
  tiers: [{ tier: "default", groups: [["claude"]] }],
  providers: [provider("claude")]
};

const VERSIONS: ControlApiProviderVersionsResponse = {
  schema: "autodev-control-provider-versions-v1",
  source: "runtime-provider-cli-versions",
  providers: [
    {
      provider: "claude",
      cli: {
        status: "observed",
        command: "claude",
        version: "2.1.280",
        observedAt: "2026-11-09T12:00:00.000Z"
      }
    }
  ]
};

const AVAILABLE: ProviderCliVersionState = {
  status: "available",
  data: VERSIONS
};

test("the version reads as the CLI's name and the release it reported", () => {
  const view = providerCliVersionView(AVAILABLE, "claude");
  assert.equal(view.status, "observed");
  assert.equal(providerCliVersionLabel(view), "claude 2.1.280");
});

test("a CLI that is not installed is not a version of zero", () => {
  const state: ProviderCliVersionState = {
    status: "available",
    data: {
      ...VERSIONS,
      providers: [
        {
          provider: "claude",
          cli: {
            status: "unavailable",
            kind: "not-installed",
            command: "claude",
            reason: "The Claude Code CLI (claude) is not installed.",
            lastAttemptAt: "2026-11-09T12:00:00.000Z"
          }
        }
      ]
    }
  };
  const view = providerCliVersionView(state, "claude");
  assert.equal(view.status, "not-installed");
  assert.equal(providerCliVersionLabel(view), "claude · Not installed");
});

test("a CLI that is installed but unreadable says so differently", () => {
  const state: ProviderCliVersionState = {
    status: "available",
    data: {
      ...VERSIONS,
      providers: [
        {
          provider: "claude",
          cli: {
            status: "unavailable",
            kind: "not-readable",
            command: "claude",
            reason: "Reading the claude CLI's version timed out.",
            lastAttemptAt: "2026-11-09T12:00:00.000Z"
          }
        }
      ]
    }
  };
  const view = providerCliVersionView(state, "claude");
  assert.equal(view.status, "not-readable");
  assert.equal(providerCliVersionLabel(view), "claude · Not read");
});

test("a Runtime that did not report a version says the version was not observed", () => {
  const view = providerCliVersionView(
    { status: "unavailable", message: "Provider versions were not read." },
    "claude"
  );
  assert.equal(view.status, "not-observed");
  assert.equal(providerCliVersionLabel(view), "Not observed");
});

test("the providers table shows the CLI version under the provider's name", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      modelDiscovery: { status: "unavailable", message: "Not read." },
      cliVersions: AVAILABLE,
      providers: PROVIDERS,
      models: { status: "unavailable", message: "Not read." }
    })
  );
  // The version is attached to the provider it belongs to, and it says which
  // CLI it is the version of.
  assert.match(markup, /data-provider-cli-version="observed"/u);
  assert.match(markup, /claude 2\.1\.280/u);
});

test("a providers table with no versions read says so rather than showing none", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProvidersView, {
      modelDiscovery: { status: "unavailable", message: "Not read." },
      providers: PROVIDERS,
      models: { status: "unavailable", message: "Not read." }
    })
  );
  assert.match(markup, /data-provider-cli-version="not-observed"/u);
  assert.doesNotMatch(markup, /data-provider-cli-version="observed"/u);
});

test("the provider's own page shows the CLI version", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderDetailView, {
      provider: PROVIDERS.providers[0]!,
      tiers: PROVIDERS.tiers,
      orchestratorTier: PROVIDERS.orchestratorTier,
      models: [],
      modelDiscovery: { status: "unavailable", message: "Not read." },
      cliVersions: AVAILABLE,
      usagePanel: null
    })
  );
  assert.match(markup, /CLI version/u);
  assert.match(markup, /claude 2\.1\.280/u);
});
