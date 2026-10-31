import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiProviderRecord,
  ReconciliationView
} from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST } from "../app/api/providers/[provider]/roles/[role]/route.ts";
import { AutoSubmitSelectField } from "../src/components/forms/AutoSubmitSelectField.ts";
import { NOT_OBSERVED_LABEL } from "../src/components/status/StatusBadge.ts";
import type { ProviderModelDiscoveryState } from "../src/features/providers/provider-model-discovery.ts";
import { ProviderRoleControls } from "../src/features/providers/ProviderRoleControls.ts";
import {
  type ControlRefusalReason,
  readControlRefusal
} from "../src/lib/control-failure.ts";

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

/**
 * The provider-level reconciliation the Runtime reports on the providers read.
 *
 * These fixtures exercise the role controls, so the provider's own view is a
 * fixed converged state: the role panels carry their own per-role convergence.
 */
const providerReconciliation: ReconciliationView = {
  status: {
    convergence: "converged",
    desiredGeneration: "provider:claude",
    observedGeneration: "provider:claude",
    lastApplyAt: "2026-10-16T12:00:00.000Z",
    lastObservationAt: "2026-10-16T12:00:00.000Z",
    lastError: null,
    explanation: "Converged."
  },
  history: []
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
  reconciliation: providerReconciliation,
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
  reconciliation: providerReconciliation,
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

/**
 * The Claude provider's orchestrator role as the Runtime reports it when the
 * role holds no model of its own.
 *
 * The effort is the provider's configured orchestrator effort, and no catalog
 * states which efforts the model the role will run supports: the levels are
 * unobserved, which is a different fact from "this model supports no effort".
 */
const mockClaudeUnobservedProvider: ControlApiProviderRecord = {
  ...mockClaudeProvider,
  roles: {
    ...mockClaudeProvider.roles,
    orchestrator: {
      ...mockClaudeProvider.roles.orchestrator,
      priority: 1,
      model: null,
      reasoningEffort: "medium",
      effectiveReasoningEffort: "medium",
      reasoningEffortInForce: true,
      supportedReasoningLevels: []
    }
  }
};

/** The markup of one role's form, so an assertion can name the role it means. */
function roleForm(markup: string, provider: string, role: string): string {
  const marker = `data-role-form="${provider}-${role}"`;
  const start = markup.indexOf(marker);
  assert.notEqual(start, -1, `the ${provider} ${role} row must be rendered`);
  const next = markup.indexOf('data-role-form="', start + marker.length);
  return markup.slice(start, next === -1 ? markup.length : next);
}

test("ProviderRoleControls shows the effort in force when the supported levels are unobserved", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      provider: mockClaudeUnobservedProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // The effort the role runs with is known even when the levels are not, so the
  // cell says so instead of claiming that nothing is observed.
  const form = roleForm(markup, "claude", "orchestrator");
  assert.match(form, /data-role-effort-unobserved="claude-orchestrator"/);
  assert.match(form, />medium</);
  assert.doesNotMatch(form, new RegExp(NOT_OBSERVED_LABEL, "u"));
});

test("ProviderRoleControls submits no effort for a role that holds no model", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      provider: mockClaudeUnobservedProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // An effort names the model it applies to, and the Runtime refuses one that
  // has no model to check it against. Submitting the inherited effort with no
  // model was what left this row unable to change anything at all.
  const form = roleForm(markup, "claude", "orchestrator");
  assert.match(form, /name="reasoningEffort" value=""/);
  assert.doesNotMatch(form, /name="reasoningEffort" value="medium"/);
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

/**
 * The refusal the operator is shown for each code the Runtime answers a
 * provider-role mutation with.
 *
 * The Runtime states its reasons with machine-readable codes, and each asks for
 * a different next move, so a code the route drops on the floor leaves the
 * operator with a notice that says only "could not be confirmed". A code this
 * build does not know keeps the generic notice: the generic notice makes no
 * claim about the Runtime's reason, which is the only honest thing to say
 * about a reason this build has not read.
 */
async function refusalForCode(
  status: number,
  code: string
): Promise<string | undefined> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "p".repeat(64);
  globalThis.fetch = (async () =>
    Response.json(
      { error: { message: "Runtime said so.", code, type: "t" } },
      { status }
    )) as typeof fetch;
  try {
    const body = new URLSearchParams({
      provider: "claude",
      role: "orchestrator",
      priority: "1",
      model: "sonnet",
      reasoningEffort: "medium",
      returnTo: "/providers"
    }).toString();
    const request = new NextRequest(
      "http://127.0.0.1:3000/api/providers/claude/roles/orchestrator",
      {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded"
        },
        body
      }
    );
    const response = await POST(request, {
      params: Promise.resolve({ provider: "claude", role: "orchestrator" })
    });
    const location = response.headers.get("location") ?? "";
    return readControlRefusal(
      new URL(location, "http://127.0.0.1:3000").searchParams.get("refusal") ??
        undefined
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
  }
}

test("each Runtime code reaches the refusal that describes it", async () => {
  const codes: readonly [number, string, ControlRefusalReason][] = [
    [400, "autodev_control_api_bad_body", "request_invalid"],
    [400, "autodev_control_api_invalid_body", "request_invalid"],
    [404, "autodev_control_api_unknown_provider", "not_found"],
    [403, "autodev_control_api_viewer_forbidden", "forbidden"],
    [500, "autodev_control_api_persistence_failed", "operation_failed"]
  ];

  for (const [status, code, expected] of codes) {
    assert.equal(
      await refusalForCode(status, code),
      expected,
      `${code} (${status}) was reported as the wrong reason`
    );
  }
});

test("an unrecognised Runtime code keeps the generic notice rather than guessing", async () => {
  assert.equal(
    await refusalForCode(400, "autodev_control_api_some_future_thing"),
    undefined
  );
});
