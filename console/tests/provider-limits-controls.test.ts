import assert from "node:assert/strict";
import test from "node:test";

import type { ControlApiProviderRecord } from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderLimitsControls } from "../src/features/providers/ProviderLimitsControls.ts";

function createMockProvider(
  overrides?: Partial<ControlApiProviderRecord>
): ControlApiProviderRecord {
  return {
    id: "anthropic",
    links: { usage: null, documentation: null },
    disabled: false,
    agentLimits: { perSession: 4, acrossSessions: 12 },
    route: {
      pattern: "^claude",
      baseUrl: "http://127.0.0.1:4000/v1",
      healthUrl: "http://127.0.0.1:4000/health"
    },
    credential: { envKey: "ANTHROPIC_API_KEY", configured: true },
    roles: {
      default: {
        priority: 1,
        model: "claude-3-5-sonnet",
        mutable: true,
        convergence: {
          convergence: "converged",
          desiredGeneration: "default:1/claude-3-5-sonnet",
          observedGeneration: "default:1/claude-3-5-sonnet",
          lastApplyAt: "2026-10-07T00:00:00.000Z",
          lastObservationAt: "2026-10-07T00:00:00.000Z",
          lastError: null,
          explanation: "Converged."
        }
      },
      smart: {
        priority: 1,
        model: "claude-opus-5-5",
        mutable: true,
        convergence: {
          convergence: "converged",
          desiredGeneration: "smart:1/claude-opus-5-5",
          observedGeneration: "smart:1/claude-opus-5-5",
          lastApplyAt: "2026-10-07T00:00:00.000Z",
          lastObservationAt: "2026-10-07T00:00:00.000Z",
          lastError: null,
          explanation: "Converged."
        }
      },
      orchestrator: {
        priority: 1,
        model: "claude-opus-5-5",
        mutable: true,
        convergence: {
          convergence: "converged",
          desiredGeneration: "orchestrator:1/claude-opus-5-5",
          observedGeneration: "orchestrator:1/claude-opus-5-5",
          lastApplyAt: "2026-10-07T00:00:00.000Z",
          lastObservationAt: "2026-10-07T00:00:00.000Z",
          lastError: null,
          explanation: "Converged."
        }
      },
      subagent: {
        priority: 2,
        model: "claude-3-5-haiku",
        mutable: true,
        convergence: {
          convergence: "converged",
          desiredGeneration: "subagent:2/claude-3-5-haiku",
          observedGeneration: "subagent:2/claude-3-5-haiku",
          lastApplyAt: "2026-10-07T00:00:00.000Z",
          lastObservationAt: "2026-10-07T00:00:00.000Z",
          lastError: null,
          explanation: "Converged."
        }
      }
    },
    models: [
      {
        tier: "default",
        model: "claude-3-5-sonnet"
      }
    ],
    priorities: [
      {
        tier: "default",
        group: 1
      }
    ],
    orchestratorReasoningEffort: null,
    health: null,
    ...overrides
  };
}

test("ProviderLimitsControls renders steppers with truthful labels, step values, and display", () => {
  const provider = createMockProvider({
    agentLimits: { perSession: 5, acrossSessions: 20 }
  });
  const markup = renderToStaticMarkup(
    React.createElement(ProviderLimitsControls, {
      provider,
      returnTo: "/providers"
    })
  );

  // Axis labels
  assert.match(markup, /Per session/u);
  assert.match(markup, /Across sessions/u);

  // Stepper container & data attributes
  assert.match(markup, /data-limit-stepper="anthropic-perSession"/u);
  assert.match(markup, /data-limit-stepper="anthropic-acrossSessions"/u);

  // Values rendered
  assert.match(
    markup,
    /data-limit-value="anthropic-perSession"[^>]*>5<\/span>/u
  );
  assert.match(
    markup,
    /data-limit-value="anthropic-acrossSessions"[^>]*>20<\/span>/u
  );

  // Step buttons: decrement & increment values
  // perSession: 5 -> decrement 4, increment 6
  assert.match(
    markup,
    /<button\b(?=[^>]*name="setPerSession")(?=[^>]*value="4")[^>]*data-step="anthropic-perSession-minus"/u
  );
  assert.match(
    markup,
    /<button\b(?=[^>]*name="setPerSession")(?=[^>]*value="6")[^>]*data-step="anthropic-perSession-plus"/u
  );

  // acrossSessions: 20 -> decrement 19, increment 21
  assert.match(
    markup,
    /<button\b(?=[^>]*name="setAcrossSessions")(?=[^>]*value="19")[^>]*data-step="anthropic-acrossSessions-minus"/u
  );
  assert.match(
    markup,
    /<button\b(?=[^>]*name="setAcrossSessions")(?=[^>]*value="21")[^>]*data-step="anthropic-acrossSessions-plus"/u
  );

  // Stepper buttons accessible titles and labels
  assert.match(markup, /aria-label="Decrease per session for anthropic"/u);
  assert.match(markup, /aria-label="Increase per session for anthropic"/u);
  assert.match(markup, /aria-label="Decrease across sessions for anthropic"/u);
  assert.match(markup, /aria-label="Increase across sessions for anthropic"/u);
});

test("ProviderLimitsControls renders infinity symbol and clamped step when unlimited", () => {
  const unlimitedProvider = createMockProvider({ agentLimits: null });
  const markup = renderToStaticMarkup(
    React.createElement(ProviderLimitsControls, {
      provider: unlimitedProvider,
      returnTo: "/providers"
    })
  );

  // Steppers display ∞ with title "Unlimited"
  assert.match(
    markup,
    /data-limit-value="anthropic-perSession"[^>]*title="Unlimited"[^>]*>∞<\/span>/u
  );
  assert.match(
    markup,
    /data-limit-value="anthropic-acrossSessions"[^>]*title="Unlimited"[^>]*>∞<\/span>/u
  );

  // Stepping an unlimited axis starts from minimum (1)
  assert.match(
    markup,
    /<button\b(?=[^>]*name="setPerSession")(?=[^>]*value="1")[^>]*data-step="anthropic-perSession-minus"/u
  );
  assert.match(
    markup,
    /<button\b(?=[^>]*name="setPerSession")(?=[^>]*value="2")[^>]*data-step="anthropic-perSession-plus"/u
  );

  // Unlimited button state is checked
  assert.match(
    markup,
    /data-limit-unlimited="anthropic"[^>]*data-checked="true"/u
  );
  assert.match(markup, /✓<\/span>/u);

  // No contradictory empty state
  assert.doesNotMatch(markup, /No limits configured/u);
  assert.doesNotMatch(markup, /data-testid="limits-unconfigured/u);
});

test("ProviderLimitsControls keeps hidden inputs synchronized with wire contract", () => {
  const provider = createMockProvider({
    agentLimits: { perSession: 8, acrossSessions: 16 }
  });
  const markup = renderToStaticMarkup(
    React.createElement(ProviderLimitsControls, {
      provider,
      returnTo: "/providers?tab=providers"
    })
  );

  assert.match(
    markup,
    /<input type="hidden" name="provider" value="anthropic"\/>/u
  );
  assert.match(
    markup,
    /<input type="hidden" name="returnTo" value="\/providers\?tab=providers"\/>/u
  );
  assert.match(markup, /<input type="hidden" name="perSession" value="8"\/>/u);
  assert.match(
    markup,
    /<input type="hidden" name="acrossSessions" value="16"\/>/u
  );
});

test("ProviderLimitsControls satisfies responsive layout class contracts", () => {
  const provider = createMockProvider();
  const markup = renderToStaticMarkup(
    React.createElement(ProviderLimitsControls, {
      provider,
      returnTo: "/providers"
    })
  );

  // The cell stays a single vertical stack; no equal-width action columns.
  assert.match(
    markup,
    /class="flex min-w-0 flex-col gap-2" data-provider-limits="anthropic"/u
  );

  // Limits retain a normal POST form while its children stack at every width.
  assert.match(
    markup,
    /<form\b[^>]*class="flex min-w-0 flex-col gap-2"[^>]*data-limit-form="anthropic"[^>]*action="\/api\/providers\/anthropic\/limits"[^>]*method="POST"/u
  );

  // Stepper labels remain above their controls at desktop and phone widths.
  assert.match(
    markup,
    /class="flex min-w-0 flex-col items-start gap-1"[^>]*data-limit-stepper="anthropic-perSession"/u
  );
  assert.match(
    markup,
    /data-limit-stepper="anthropic-perSession">[\s\S]*?<span class="flex shrink-0 items-center gap-1">/u
  );
  assert.doesNotMatch(markup, /truncate|sm:flex-row|grid-cols-2/u);

  // Stepper icon buttons have a single 24px sizing source, not conflicting padding.
  const stepperButton = markup.match(
    /<button\b(?=[^>]*data-step="anthropic-perSession-minus")[^>]*>/u
  )?.[0];
  assert.ok(stepperButton);
  assert.match(stepperButton, /h-6 w-6 p-0/u);
  assert.doesNotMatch(stepperButton, /px-3|py-1\.5/u);

  // Stepper display contract: tabular nums, 32px width, centered.
  assert.match(
    markup,
    /class="[^"]*inline-flex h-7 w-8 shrink-0 items-center justify-center text-center font-mono text-xs tabular-nums text-fg[^"]*"[^>]*data-limit-value="anthropic-perSession"/u
  );

  // Both actions use an explicit compact Button size and stack in the same cell.
  const unlimited = markup.match(
    /<button\b(?=[^>]*data-limit-unlimited="anthropic")[^>]*>/u
  )?.[0];
  const disabled = markup.match(
    /<button\b(?=[^>]*data-provider-disabled="anthropic")[^>]*>/u
  )?.[0];
  assert.ok(unlimited);
  assert.ok(disabled);
  assert.match(unlimited, /px-2 py-1 text-xs font-medium/u);
  assert.match(unlimited, /inline-flex shrink-0 items-center gap-1\.5/u);
  assert.match(disabled, /px-2 py-1 text-xs font-medium/u);
  assert.match(disabled, /inline-flex shrink-0 items-center gap-1\.5/u);
  assert.doesNotMatch(unlimited, /px-3|py-1\.5/u);
  assert.doesNotMatch(disabled, /px-3|py-1\.5/u);
  assert.match(
    markup,
    /<form\b[^>]*class="flex min-w-0 flex-col items-start gap-1"[^>]*data-provider-toggle-form="anthropic"/u
  );
});

test("ProviderLimitsControls describes disabled state truthfully and handles toggle forms", () => {
  const enabledProvider = createMockProvider({ disabled: false });
  const disabledProvider = createMockProvider({ disabled: true });

  const enabledMarkup = renderToStaticMarkup(
    React.createElement(ProviderLimitsControls, {
      provider: enabledProvider,
      returnTo: "/providers"
    })
  );
  const disabledMarkup = renderToStaticMarkup(
    React.createElement(ProviderLimitsControls, {
      provider: disabledProvider,
      returnTo: "/providers"
    })
  );

  // Enabled provider: button says Disable, data-checked is false, no "Provider disabled" text
  assert.match(
    enabledMarkup,
    /data-provider-disabled="anthropic"[^>]*data-checked="false"[^>]*>[\s\S]*?Disable<\/button>/u
  );
  assert.match(enabledMarkup, /aria-label="Disable provider anthropic"/u);
  assert.equal(enabledMarkup.includes("Provider disabled"), false);

  // Disabled provider: button says Enable, data-checked is true, "Provider disabled" text is present
  assert.match(
    disabledMarkup,
    /data-provider-disabled="anthropic"[^>]*data-checked="true"[^>]*>[\s\S]*?Enable<\/button>/u
  );
  assert.match(disabledMarkup, /aria-label="Enable provider anthropic"/u);
  assert.ok(disabledMarkup.includes("Provider disabled"));
  assert.match(
    disabledMarkup,
    /<span class="[^"]*text-warning font-medium[^"]*">Provider disabled<\/span>/u
  );
});
