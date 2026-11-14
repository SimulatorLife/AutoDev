import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiProviderRecord,
  ReconciliationView
} from "@simulatorlife/autodev-core";
import { NextRequest } from "next/server.js";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { POST as postAgentModel } from "../app/api/providers/[provider]/agents/[role]/route.ts";
import { POST } from "../app/api/providers/[provider]/roles/[role]/route.ts";
import { NOT_OBSERVED_LABEL } from "../src/components/status/StatusBadge.ts";
import type { ProviderModelDiscoveryState } from "../src/features/providers/provider-model-discovery.ts";
import { ProviderRoleControls } from "../src/features/providers/ProviderRoleControls.ts";
import {
  type ControlRefusalReason,
  readControlRefusal
} from "../src/lib/control-failure.ts";
import { MUTATION_REJECTION_SCHEMA } from "../src/lib/server/mutation-rejection.ts";

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
        provider: "antigravity-gemini",
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
  agentModels: [],
  models: [{ tier: "smart", model: "sonnet" }],
  priorities: [],
  orchestratorReasoningEffort: null,
  health: null,
  reconciliation: providerReconciliation,
  roles: {
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
      reasoningEffort: "high",
      effectiveReasoningEffort: "high",
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
  id: "antigravity-gemini",
  links: { usage: null, documentation: null },
  route: null,
  credential: { envKey: null, configured: true },
  disabled: false,
  agentLimits: null,
  agentModels: [],
  models: [{ tier: "default", model: "gemini-3.8-flash-high" }],
  priorities: [],
  orchestratorReasoningEffort: null,
  health: null,
  reconciliation: providerReconciliation,
  roles: {
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
      model: "gemini-3.8-flash-high",
      effectiveReasoningEffort: "high",
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
      subagentLayout: "hierarchical",
      provider: mockClaudeProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // subagent role has sonnet with ["low", "medium", "high"], reasoningEffort="high"
  assert.match(markup, /data-role-effort="subagent"/);
  assert.match(markup, /id="select-effort-claude-subagent"/);
  assert.match(markup, /<option value="high" selected=""/);
  assert.match(markup, /<option value="">Default<\/option>/);
  assert.match(markup, /<option value="low">Low<\/option>/);
  assert.match(markup, /<option value="medium">Medium<\/option>/);
  assert.match(markup, /<option value="high">High<\/option>/);
});

test("ProviderRoleControls renders placeholder when model does not support reasoning levels", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      subagentLayout: "hierarchical",
      provider: mockAgyProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // antigravity orchestrator role has model=null and no supported levels
  assert.match(
    markup,
    /data-role-effort-placeholder="antigravity-gemini-orchestrator"/
  );
  assert.ok(markup.includes(`>${NOT_OBSERVED_LABEL}</span>`));
});

test("ProviderRoleControls renders fixed indicator for Antigravity model slug suffix", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      subagentLayout: "hierarchical",
      provider: mockAgyProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );

  // antigravity subagent role has gemini-3.8-flash-high
  assert.match(markup, /data-role-effort-fixed="antigravity-gemini-subagent"/);
  assert.match(markup, />high<\/span>/);
});

test("ProviderRoleControls carries preserved reasoningEffort hidden input when role is disabled", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      subagentLayout: "hierarchical",
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
      subagentLayout: "hierarchical",
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
      subagentLayout: "hierarchical",
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

test("every role select is submitted by the page-level listener and shows the Runtime's value", () => {
  const markup = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      subagentLayout: "hierarchical",
      provider: mockClaudeProvider,
      modelDiscovery: mockDiscovery,
      returnTo: "/providers"
    })
  );
  const subagent = roleForm(markup, "claude", "subagent");
  for (const control of ["priority", "effort"]) {
    const select = new RegExp(
      `<select id="select-${control}-claude-subagent"[^>]*data-submit-on-change="true"`,
      "u"
    );
    assert.match(subagent, select, `the ${control} select submits on change`);
  }
  // The rendered selection is the Runtime's assignment for the role.
  assert.match(subagent, /<option value="high" selected="">High<\/option>/u);
});

test("POST /api/providers/[provider]/roles/[role] rejects non-same-origin requests", async () => {
  const req = new NextRequest(
    "http://127.0.0.1:3000/api/providers/claude/roles/subagent",
    {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://evil.com"
      }
    }
  );
  const res = await POST(req, {
    params: Promise.resolve({ provider: "claude", role: "subagent" })
  });
  assert.equal(res.status, 303);
  const location = res.headers.get("location");
  assert.ok(location?.includes("control=failed"));
});

test("POST /api/providers/[provider]/roles/[role] rejects invalid field count", async () => {
  const body = new URLSearchParams({
    provider: "claude",
    role: "subagent",
    priority: "1",
    model: "sonnet",
    reasoningEffort: "high",
    returnTo: "/providers",
    extraField: "bad"
  }).toString();

  const req = new NextRequest(
    "http://127.0.0.1:3000/api/providers/claude/roles/subagent",
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
    params: Promise.resolve({ provider: "claude", role: "subagent" })
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

/**
 * The rejection lines a mutation route wrote to stderr while `run` ran.
 *
 * A change the Console turned away never reached the Runtime's audit, so an
 * operator's Disabled orchestrator role left no trace anywhere when it did
 * not land; these lines are that trace.
 */
async function rejectionLines(
  run: () => Promise<unknown>
): Promise<Array<Record<string, unknown>>> {
  const written: string[] = [];
  const previousWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = previousWrite;
  }
  return written
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.includes(MUTATION_REJECTION_SCHEMA))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function orchestratorRoleRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest(
    "http://127.0.0.1:3000/api/providers/claude/roles/orchestrator",
    {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "sec-fetch-site": "same-origin",
        "content-type": "application/x-www-form-urlencoded",
        ...headers
      },
      body: new URLSearchParams(fields).toString()
    }
  );
}

const DISABLE_ORCHESTRATOR = {
  provider: "claude",
  role: "orchestrator",
  priority: "disabled",
  model: "claude-opus-5-5",
  reasoningEffort: "medium",
  returnTo: "/providers"
};

test("a role change the Console turns away is logged with its cause", async () => {
  // A rejected change must not reach any Control API, least of all the
  // Runtime this machine runs: the Console falls back to the real service
  // credential in CODEX_HOME when the variable is unset.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("a rejected change must not reach the Control API");
  }) as typeof fetch;
  try {
    const params = {
      params: Promise.resolve({ provider: "claude", role: "orchestrator" })
    };
    const crossOrigin = await rejectionLines(() =>
      POST(
        orchestratorRoleRequest(DISABLE_ORCHESTRATOR, {
          origin: "http://evil.example"
        }),
        params
      )
    );
    assert.equal(crossOrigin.length, 1);
    assert.equal(
      crossOrigin[0]!.route,
      "/api/providers/[provider]/roles/[role]"
    );
    assert.equal(crossOrigin[0]!.cause, "cross_origin");

    const { model: _dropped, ...withoutModel } = DISABLE_ORCHESTRATOR;
    const missingField = await rejectionLines(() =>
      POST(orchestratorRoleRequest(withoutModel), params)
    );
    assert.deepEqual(
      missingField.map(({ cause, resource }) => ({ cause, resource })),
      [
        {
          cause: "invalid_fields",
          resource: "providers/claude/roles/orchestrator"
        }
      ]
    );
    // Codes and the resource only: no submitted value is echoed into the log.
    assert.doesNotMatch(
      JSON.stringify(missingField),
      /claude-opus-5-5|disabled/u
    );

    // No credential anywhere: neither the variable nor the secret file the
    // Console falls back to. A fetch that is reached anyway fails the test
    // rather than writing to whatever Runtime this machine runs.
    const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
    const previousSecretFile = process.env.AUTODEV_OPENLIT_SECRET_FILE;
    const previousFetch = globalThis.fetch;
    delete process.env.AUTODEV_CONTROL_API_TOKEN;
    process.env.AUTODEV_OPENLIT_SECRET_FILE =
      "/nonexistent/autodev-test-secrets.env";
    globalThis.fetch = (async () => {
      throw new Error("an unconfigured Console must not call the Control API");
    }) as typeof fetch;
    try {
      const unconfigured = await rejectionLines(() =>
        POST(orchestratorRoleRequest(DISABLE_ORCHESTRATOR), params)
      );
      assert.equal(unconfigured[0]?.cause, "control_api_unconfigured");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousToken !== undefined)
        process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
      if (previousSecretFile === undefined)
        delete process.env.AUTODEV_OPENLIT_SECRET_FILE;
      else process.env.AUTODEV_OPENLIT_SECRET_FILE = previousSecretFile;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a role change the Runtime refuses is logged with its status and code", async () => {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "p".repeat(64);
  globalThis.fetch = (async () =>
    Response.json(
      {
        error: {
          message: "no",
          code: "autodev_control_api_invalid_body",
          type: "t"
        }
      },
      { status: 400 }
    )) as typeof fetch;
  try {
    const lines = await rejectionLines(() =>
      POST(orchestratorRoleRequest(DISABLE_ORCHESTRATOR), {
        params: Promise.resolve({ provider: "claude", role: "orchestrator" })
      })
    );
    assert.deepEqual(
      lines.map(({ cause, status, code }) => ({ cause, status, code })),
      [
        {
          cause: "runtime_rejected",
          status: 400,
          code: "autodev_control_api_invalid_body"
        }
      ]
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined)
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    else process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
  }
});

test("the closed Subagent model defers its levels but preserves their native forms", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      subagentLayout: "hierarchical",
      provider: {
        ...mockClaudeProvider,
        agentModels: [
          {
            role: "explorer",
            tier: "default",
            model: "sonnet",
            tierModel: "opus"
          },
          { role: "smart", tier: "smart", model: null, tierModel: "opus" }
        ]
      },
      modelDiscovery: mockDiscovery,
      returnTo: "/providers/claude"
    })
  );
  // The closed control names the Subagent model and how many roles have
  // their own, in the shared select chrome.
  assert.match(
    html,
    /<span id="select-model-claude-subagent" title="sonnet \+1"[^>]*appearance-none/u
  );
  // The closed menu keeps its target data out of the initial DOM. The
  // browser acceptance opens the control and checks the levels and choices.
  assert.match(html, /aria-expanded="false"/u);
  assert.doesNotMatch(html, /data-hierarchical-level=/u);
  assert.doesNotMatch(html, /<button[^>]+form="select-model-claude-subagent-/u);
  // Each level's native form is still rendered outside the role's form, ready
  // for the lazily mounted option buttons to target when opened.
  const roleFormStart = html.indexOf('data-role-form="claude-subagent"');
  for (const [level, action] of [
    ["subagent", "/api/providers/claude/roles/subagent"],
    ["explorer", "/api/providers/claude/agents/explorer"],
    ["smart", "/api/providers/claude/agents/smart"]
  ] as const) {
    const formAt = html.indexOf(
      `id="select-model-claude-subagent-${level}-form"`
    );
    assert.ok(formAt !== -1 && formAt < roleFormStart, level);
    assert.match(
      html.slice(formAt),
      new RegExp(
        `^[^>]*action="${action.replaceAll("/", String.raw`\/`)}"`,
        "u"
      )
    );
    assert.match(
      html.slice(formAt),
      /<input type="hidden" name="provider" value="claude"\/>/u
    );
  }
  // The role's own form still carries the current model for its other fields.
  assert.match(
    html.slice(roleFormStart),
    /<input type="hidden" name="model" value="sonnet"\/>/u
  );
});

test("the rows layout gives each agent role its own model row under Subagent", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      subagentLayout: "rows",
      provider: {
        ...mockClaudeProvider,
        agentModels: [
          {
            role: "explorer",
            tier: "default",
            model: "sonnet",
            tierModel: "opus"
          },
          { role: "smart", tier: "smart", model: null, tierModel: "opus" }
        ]
      },
      modelDiscovery: mockDiscovery,
      returnTo: "/providers/claude"
    })
  );
  // No hierarchical select: Subagent's model is a plain select in its form.
  assert.doesNotMatch(html, /data-hierarchical-/u);
  const subagentForm = html.indexOf('data-role-form="claude-subagent"');
  const explorerForm = html.indexOf('data-agent-model-form="claude-explorer"');
  const smartForm = html.indexOf('data-agent-model-form="claude-smart"');
  assert.ok(subagentForm !== -1 && subagentForm < explorerForm);
  assert.ok(explorerForm < smartForm);
  assert.match(
    html.slice(subagentForm, explorerForm),
    /<select[^>]*id="select-model-claude-subagent"[^>]*name="model"/u
  );
  // Each agent role posts its model to its own agent route.
  for (const [role, action] of [
    ["explorer", "/api/providers/claude/agents/explorer"],
    ["smart", "/api/providers/claude/agents/smart"]
  ] as const) {
    const formAt = html.lastIndexOf(
      "<form",
      html.indexOf(`data-agent-model-form="claude-${role}"`)
    );
    assert.match(
      html.slice(formAt),
      new RegExp(
        `^<form[^>]*action="${action.replaceAll("/", String.raw`\/`)}"`,
        "u"
      )
    );
    assert.match(
      html,
      new RegExp(`<input type="hidden" name="role" value="${role}"/>`, "u")
    );
  }
  // The explorer's own model is selected; smart's Auto names its tier model.
  assert.match(
    html,
    /id="select-agent-model-claude-explorer"[\s\S]*?<option value="sonnet" selected="">/u
  );
  assert.match(
    html,
    /id="select-agent-model-claude-smart"[\s\S]*?<option value="" selected="">Auto \(opus\)<\/option>/u
  );
});

test("the rows layout blocks agent model rows while the Subagent role is disabled", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      subagentLayout: "rows",
      provider: {
        ...mockClaudeProvider,
        roles: {
          ...mockClaudeProvider.roles,
          subagent: {
            ...mockClaudeProvider.roles.subagent,
            priority: "disabled"
          }
        },
        agentModels: [
          {
            role: "explorer",
            tier: "default",
            model: "sonnet",
            tierModel: null
          }
        ]
      },
      modelDiscovery: mockDiscovery,
      returnTo: "/providers/claude"
    })
  );
  assert.match(
    html,
    /<select[^>]*id="select-agent-model-claude-explorer"[^>]*disabled=""/u
  );
  // The route requires `model`, so the blocked row still carries its choice.
  const formAt = html.indexOf('data-agent-model-form="claude-explorer"');
  assert.match(
    html.slice(formAt),
    /<input type="hidden" name="model" value="sonnet"\/>/u
  );
});

test("a disabled provider keeps its Subagent models but does not offer to change them", () => {
  const html = renderToStaticMarkup(
    React.createElement(ProviderRoleControls, {
      subagentLayout: "hierarchical",
      provider: {
        ...mockClaudeProvider,
        disabled: true,
        roles: {
          ...mockClaudeProvider.roles,
          subagent: { ...mockClaudeProvider.roles.subagent, mutable: false }
        },
        agentModels: [
          {
            role: "explorer",
            tier: "default",
            model: "sonnet",
            tierModel: null
          }
        ]
      },
      modelDiscovery: mockDiscovery,
      returnTo: "/providers/claude"
    })
  );
  assert.match(
    html,
    /id="select-model-claude-subagent" role="button" aria-disabled="true"/u
  );
  assert.doesNotMatch(html, /data-hierarchical-form=/u);
});

function agentModelRequest(fields: Record<string, string>): NextRequest {
  return new NextRequest(
    "http://127.0.0.1:3000/api/providers/claude/agents/explorer",
    {
      method: "POST",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://127.0.0.1:3000",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams(fields).toString()
    }
  );
}

test("POST /api/providers/[provider]/agents/[role] refuses forms it did not render", async () => {
  const params = {
    params: Promise.resolve({ provider: "claude", role: "explorer" })
  };
  const valid = {
    provider: "claude",
    role: "explorer",
    model: "sonnet",
    returnTo: "/providers/claude"
  };
  for (const fields of [
    { ...valid, extra: "x" },
    { ...valid, role: "worker" },
    { provider: "claude", role: "explorer", returnTo: "/providers/claude" }
  ]) {
    const response = await postAgentModel(agentModelRequest(fields), params);
    assert.equal(response.status, 303);
    assert.match(response.headers.get("location") ?? "", /control=failed/u);
  }
  const crossOrigin = new NextRequest(
    "http://127.0.0.1:3000/api/providers/claude/agents/explorer",
    {
      method: "POST",
      headers: { host: "127.0.0.1:3000", origin: "http://evil.com" }
    }
  );
  const refused = await postAgentModel(crossOrigin, params);
  assert.match(refused.headers.get("location") ?? "", /control=failed/u);
});
