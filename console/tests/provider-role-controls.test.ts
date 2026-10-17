import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiProviderRecord } from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST } from "../app/api/providers/[provider]/roles/[role]/route.ts";
import { AutoSubmitSelectField } from "../src/components/forms/AutoSubmitSelectField.ts";
import { NOT_OBSERVED_LABEL } from "../src/components/status/StatusBadge.ts";
import type { ProviderModelDiscoveryState } from "../src/features/providers/provider-model-discovery.ts";
import { ProviderRoleControls } from "../src/features/providers/ProviderRoleControls.ts";

const mockDiscovery: ProviderModelDiscoveryState = {
  status: "available",
  data: {
    schema: "autodev-control-provider-model-discovery-v1",
    source: "runtime-provider-discovery",
    providers: [
      {
        provider: "claude",
        discovery: {
          status: "observed",
          source: "fixture",
          observedAt: "2026-10-16T12:00:00.000Z",
          lastAttemptAt: "2026-10-16T12:00:00.000Z",
          models: [
            {
              id: "sonnet",
              displayName: "Claude Sonnet",
              routeability: { status: "supported" }
            }
          ]
        }
      },
      {
        provider: "antigravity",
        discovery: {
          status: "observed",
          source: "fixture",
          observedAt: "2026-10-16T12:00:00.000Z",
          lastAttemptAt: "2026-10-16T12:00:00.000Z",
          models: [
            {
              id: "gemini-3.8-flash-high",
              displayName: "Gemini Flash High",
              routeability: { status: "supported" }
            }
          ]
        }
      }
    ]
  }
};

const mockClaudeProvider: ControlApiProviderRecord = {
  id: "claude",
  links: { usage: null, documentation: null },
  route: null,
  credential: { envKey: "ANTHROPIC_API_KEY", configured: true },
  disabled: false,
  agentLimits: null,
  models: [{ tier: "smart", model: "sonnet" }],
  priorities: [],
  orchestratorReasoningEffort: null,
  health: null,
  roles: {
    default: {
      priority: 1,
      model: null,
      reasoningEffort: null,
      effectiveReasoningEffort: null,
      reasoningEffortInForce: true,
      supportedReasoningLevels: [],
      mutable: true,
      convergence: {
        convergence: "converged",
        desiredGeneration: "default:enabled=true",
        observedGeneration: "default:enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: ""
      }
    },
    smart: {
      priority: 1,
      model: "sonnet",
      reasoningEffort: "high",
      effectiveReasoningEffort: "high",
      reasoningEffortInForce: true,
      supportedReasoningLevels: ["low", "medium", "high"],
      mutable: true,
      convergence: {
        convergence: "converged",
        desiredGeneration: "smart:enabled=true",
        observedGeneration: "smart:enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: ""
      }
    },
    orchestrator: {
      priority: "disabled",
      model: "sonnet",
      reasoningEffort: "low",
      effectiveReasoningEffort: "low",
      reasoningEffortInForce: true,
      supportedReasoningLevels: ["low", "medium", "high"],
      mutable: true,
      convergence: {
        convergence: "converged",
        desiredGeneration: "orchestrator:enabled=false",
        observedGeneration: "orchestrator:enabled=false",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: ""
      }
    },
    subagent: {
      priority: 2,
      model: "sonnet",
      reasoningEffort: null,
      effectiveReasoningEffort: "medium",
      reasoningEffortInForce: true,
      supportedReasoningLevels: ["low", "medium", "high"],
      mutable: true,
      convergence: {
        convergence: "converged",
        desiredGeneration: "subagent:enabled=true",
        observedGeneration: "subagent:enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: ""
      }
    }
  }
};

const mockAgyProvider: ControlApiProviderRecord = {
  id: "antigravity",
  links: { usage: null, documentation: null },
  route: null,
  credential: { envKey: null, configured: true },
  disabled: false,
  agentLimits: null,
  models: [{ tier: "default", model: "gemini-3.8-flash-high" }],
  priorities: [],
  orchestratorReasoningEffort: null,
  health: null,
  roles: {
    default: {
      priority: 1,
      model: "gemini-3.8-flash-high",
      reasoningEffort: "low",
      effectiveReasoningEffort: "high",
      reasoningEffortInForce: false,
      supportedReasoningLevels: ["low", "medium", "high"],
      mutable: true,
      convergence: {
        convergence: "converged",
        desiredGeneration: "default:enabled=true",
        observedGeneration: "default:enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: ""
      }
    },
    smart: {
      priority: 1,
      model: null,
      mutable: true,
      convergence: {
        convergence: "converged",
        desiredGeneration: "smart:enabled=true",
        observedGeneration: "smart:enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: ""
      }
    },
    orchestrator: {
      priority: 1,
      model: null,
      mutable: true,
      convergence: {
        convergence: "converged",
        desiredGeneration: "orchestrator:enabled=true",
        observedGeneration: "orchestrator:enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: ""
      }
    },
    subagent: {
      priority: 1,
      model: null,
      mutable: true,
      convergence: {
        convergence: "converged",
        desiredGeneration: "subagent:enabled=true",
        observedGeneration: "subagent:enabled=true",
        lastApplyAt: null,
        lastObservationAt: null,
        lastError: null,
        explanation: ""
      }
    }
  }
};

test("ProviderRoleControls renders reasoning effort dropdown when supported", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      provider: mockClaudeProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // smart role has sonnet with ["low", "medium", "high"], reasoningEffort="high"
  assert.match(markup, /data-role-effort="smart"/);
  assert.match(markup, /id="select-effort-claude-smart"/);
  assert.match(markup, /<option value="high" selected=""/);
  assert.match(markup, /<option value="">Default<\/option>/);
  assert.match(markup, /<option value="low">Low<\/option>/);
  assert.match(markup, /<option value="medium">Medium<\/option>/);
  assert.match(markup, /<option value="high">High<\/option>/);
});

test("ProviderRoleControls renders placeholder when model does not support reasoning levels", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      provider: mockClaudeProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // default role has model=null, supportedReasoningLevels=[]
  assert.match(markup, /data-role-effort-placeholder="claude-default"/);
  assert.ok(markup.includes(`>${NOT_OBSERVED_LABEL}</span>`));
});

test("ProviderRoleControls renders fixed indicator for Antigravity model slug suffix", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      provider: mockAgyProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // antigravity default role has gemini-3.8-flash-high
  assert.match(markup, /data-role-effort-fixed="antigravity-default"/);
  assert.match(markup, />high<\/span>/);
});

test("ProviderRoleControls carries preserved reasoningEffort hidden input when role is disabled", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      provider: mockClaudeProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // orchestrator role is disabled
  assert.match(markup, /name="reasoningEffort" value="low"/);
  assert.match(
    markup,
    /title="This role is set to Disabled\. Choose a priority to change its reasoning effort\."/
  );
});

test("ProviderRoleControls effort select auto-submits on change", () => {
  const controls = ProviderRoleControls({
    provider: mockClaudeProvider,
    modelDiscovery: mockDiscovery,
    returnTo: "/providers"
  });

  const listItems = React.Children.toArray(
    controls.props.children
  ) as React.ReactElement<{ readonly children?: React.ReactNode }>[];

  // smart role is index 1
  const smartRowElement = listItems[1]!.props.children as React.ReactElement<{
    readonly children?: React.ReactNode;
  }>;
  const smartRowFn = smartRowElement.type as (
    props: typeof smartRowElement.props
  ) => React.ReactElement<{ readonly children?: React.ReactNode }>;
  const smartRow = smartRowFn(smartRowElement.props);

  const formChildren = React.Children.toArray(
    smartRow.props.children
  ) as React.ReactElement<{ readonly name?: string; readonly role?: string }>[];

  // Find RoleEffortSelect by role and props
  const effortElement = formChildren.find(
    (child) =>
      typeof child.type === "function" &&
      child.props?.role === "smart" &&
      !("models" in child.props) &&
      "disabledReason" in child.props
  );
  assert.ok(effortElement, "Must find RoleEffortSelect for smart role");

  const effortSelectFn = effortElement.type as (
    props: unknown
  ) => React.ReactElement<React.ComponentProps<typeof AutoSubmitSelectField>>;
  const renderedSelectField = effortSelectFn(effortElement.props);
  assert.equal(renderedSelectField.type, AutoSubmitSelectField);

  let submitted = 0;
  const renderedField = AutoSubmitSelectField(renderedSelectField.props);
  renderedField.props.onChange?.({
    currentTarget: {
      form: { requestSubmit: () => submitted++ }
    }
  } as unknown as React.ChangeEvent<HTMLSelectElement>);

  assert.equal(submitted, 1, "Effort change must call requestSubmit");
});

test("POST /api/providers/[provider]/roles/[role] rejects non-same-origin requests", async () => {
  const req = new NextRequest(
    "http://127.0.0.1:3000/api/providers/claude/roles/smart",
    {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://evil.com"
      }
    }
  );
  const res = await POST(req, {
    params: Promise.resolve({ provider: "claude", role: "smart" })
  });
  assert.equal(res.status, 303);
  const location = res.headers.get("location");
  assert.ok(location?.includes("control=failed"));
});

test("POST /api/providers/[provider]/roles/[role] rejects invalid field count", async () => {
  const body = new URLSearchParams({
    provider: "claude",
    role: "smart",
    priority: "1",
    model: "sonnet",
    reasoningEffort: "high",
    returnTo: "/providers",
    extraField: "bad"
  }).toString();

  const req = new NextRequest(
    "http://127.0.0.1:3000/api/providers/claude/roles/smart",
    {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    }
  );
  const res = await POST(req, {
    params: Promise.resolve({ provider: "claude", role: "smart" })
  });
  assert.equal(res.status, 303);
  const location = res.headers.get("location");
  assert.ok(location?.includes("control=failed"));
});
