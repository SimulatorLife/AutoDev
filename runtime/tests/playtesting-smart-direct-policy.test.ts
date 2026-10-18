import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  admitPlaytestVisualAction,
  type PlaytestVisualObservation,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

import {
  isSmartDirectVisualPolicyAvailable,
  isSmartDirectVisualPolicyConfigured,
  resetSmartDirectVisualPolicyAvailabilityCache,
  SmartDirectPolicyError,
  SmartDirectVisualPolicy
} from "../src/playtesting/smart-direct-policy.ts";

const WORKSPACE_ID = "fixture/racing-game";
const ORIGIN = "http://127.0.0.1:5173";
const FRAME_BYTES = new TextEncoder().encode("bounded fixture frame bytes");

function target(
  overrides: Partial<WorkspaceVisualPlaytestTargetApproval> = {}
): WorkspaceVisualPlaytestTargetApproval {
  return {
    schema: "autodev-workspace-visual-playtest-target-v1",
    workspaceId: WORKSPACE_ID,
    targetId: "racing-target",
    revision: 2,
    approvalId: "approval-racing-target",
    name: "RacingGame local UI",
    entryUrl: ORIGIN + "/",
    allowedOrigins: [ORIGIN],
    inputCapabilities: ["keyboard", "pointer"],
    controlTimingClass: "turn-based",
    entryRequirements: "none",
    sandboxProfile: "transient-browser-profile",
    capturePolicy: "screenshots-only-redact-or-refuse",
    limits: {
      episodeCount: 2,
      maxStepsPerEpisode: 20,
      wallTimeMs: 60_000,
      smartRequestsPerEpisode: 8,
      smartTokensPerEpisode: 4000,
      screenshotCountPerEpisode: 20,
      artifactBytesPerEpisode: 8 * 1024 * 1024
    },
    approvedAt: "2026-10-17T12:00:00.000Z",
    approvedBy: "operator-1",
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    ...overrides
  };
}

function observation(
  overrides: Partial<PlaytestVisualObservation> = {}
): PlaytestVisualObservation {
  return {
    schema: "autodev-playtest-visual-observation-v1",
    observationId: "observation-1",
    workspaceId: WORKSPACE_ID,
    targetId: "racing-target",
    episodeId: "episode-1",
    origin: ORIGIN,
    capturedAt: "2026-10-17T12:00:00.000Z",
    viewport: { width: 640, height: 480, deviceScaleFactor: 1 },
    frame: {
      artifactId: "frame-1",
      sha256: createHash("sha256").update(FRAME_BYTES).digest("hex"),
      bytes: FRAME_BYTES.byteLength,
      mediaType: "image/png"
    },
    privacyState: "redacted",
    controls: [
      {
        controlId: "control-start",
        role: "button",
        name: "Start race",
        enabled: true,
        focused: false,
        inputKind: "none",
        bounds: { x: 20, y: 20, width: 100, height: 40 }
      }
    ],
    visibleWarnings: [],
    phaseEvidence: null,
    progressEvidence: null,
    ...overrides
  };
}

function response(
  decision: unknown,
  usage?: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  } | null
): Response {
  const actualUsage =
    usage === undefined
      ? { input_tokens: 300, output_tokens: 40, total_tokens: 340 }
      : usage;
  return Response.json({
    model: "fixture-smart-model",
    output_text: JSON.stringify(decision),
    ...(actualUsage === null ? {} : { usage: actualUsage })
  });
}

function actDecision(action?: unknown) {
  const selectedAction = action ?? {
    kind: "activate-control",
    controlId: "control-start"
  };
  return {
    decision: "act",
    intention: "Start a race to inspect the first player-visible decision.",
    prediction: "The race screen will replace the title screen.",
    reasonCode: "begin-play",
    action: selectedAction,
    stopReason: null,
    focusReport: null
  };
}

function stopDecision(focusReport: Record<string, unknown>) {
  return {
    decision: "stop",
    intention: "The setup menu is visible.",
    prediction: "No further visible state change is expected.",
    reasonCode: "focus-observed",
    action: null,
    stopReason: "objective-achieved",
    focusReport
  };
}

function createPolicy(options: {
  readonly fetchImpl: typeof fetch;
  readonly limits?: Partial<WorkspaceVisualPlaytestTargetApproval["limits"]>;
  readonly authToken?: string;
  readonly now?: () => number;
}): SmartDirectVisualPolicy {
  return new SmartDirectVisualPolicy(
    target({
      limits: {
        ...target().limits,
        ...options.limits
      }
    }),
    {
      endpoint: "http://127.0.0.1:4100/v1/responses",
      fetchImpl: options.fetchImpl,
      ...(options.authToken === undefined
        ? {}
        : { authToken: options.authToken }),
      ...(options.now === undefined ? {} : { now: options.now })
    }
  );
}

test("Smart-direct sends only the redacted observation to the local Smart route and binds a grounded action", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const policy = createPolicy({
    authToken: "router-test-token",
    fetchImpl: async (input, init) => {
      requests.push({ url: String(input), init: init ?? {} });
      return response(actDecision());
    }
  });
  const observed = observation({
    controls: [
      {
        controlId: "control-start",
        role: "button",
        name: "Contact race@example.test",
        enabled: true,
        focused: false,
        inputKind: "none",
        bounds: { x: 20, y: 20, width: 100, height: 40 }
      }
    ]
  });

  const decision = await policy.decide({
    target: target(),
    observation: observed,
    frameBytes: FRAME_BYTES,
    areasOfFocus: "Explore the first race screen.",
    history: [],
    deadlineMonotonicMs: performance.now() + 5000
  });

  assert.equal(decision.status, "act");
  if (decision.status !== "act") return;
  assert.equal(decision.focusReport, null);
  assert.deepEqual(decision.action, {
    schema: "autodev-playtest-visual-action-v1",
    workspaceId: WORKSPACE_ID,
    targetId: "racing-target",
    episodeId: "episode-1",
    observationId: "observation-1",
    kind: "activate-control",
    controlId: "control-start"
  });
  assert.equal(decision.modelId, "fixture-smart-model");
  assert.equal(decision.totalTokens, 340);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://127.0.0.1:4100/v1/responses");
  assert.equal(
    new Headers(requests[0]?.init.headers).get("authorization"),
    "Bearer router-test-token"
  );
  const body = JSON.parse(String(requests[0]?.init.body)) as {
    readonly model: string;
    readonly tools: readonly unknown[];
    readonly input: readonly {
      readonly content: readonly Record<string, unknown>[];
    }[];
  };
  assert.equal(body.model, "autodev/smart");
  assert.deepEqual(body.tools, []);
  const text = body.input[0]?.content[0]?.text;
  assert.equal(typeof text, "string");
  assert.match(String(text), /[redacted]/u);
  assert.doesNotMatch(String(text), /race@example\.test/u);
  const imageUrl = body.input[0]?.content[1]?.image_url;
  assert.equal(typeof imageUrl, "string");
  assert.ok(String(imageUrl).startsWith("data:image/png;base64,"));
  assert.equal(policy.usage().requestsAttempted, 1);
  assert.equal(policy.usage().decisionsReturned, 1);
  assert.equal(policy.usage().tokensUsed, 340);
  assert.equal(policy.usage().tokenUsageComplete, true);
  assert.ok((policy.usage().lastLatencyMs ?? -1) >= 0);
});

test("Smart-direct stop returns a bounded self-report in the existing request and cites visible steps", async () => {
  const focusReport = {
    objective: "Inspect the setup menu.",
    inScope: ["Visible setup controls"],
    forbiddenScope: ["Starting a race"],
    stopCriteria: ["Stop when the setup menu is visible."],
    outcome: "achieved",
    summary: "The setup menu is visible; I did not start a race.",
    evidenceSteps: [0]
  };
  let requestCount = 0;
  const policy = createPolicy({
    fetchImpl: async (_input, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        readonly max_output_tokens: number;
        readonly instructions: string;
        readonly input: readonly {
          readonly content: readonly { readonly text?: string }[];
        }[];
      };
      const visibleState = JSON.parse(
        String(body.input[0]?.content[0]?.text)
      ) as { readonly currentStep: number };
      assert.equal(body.max_output_tokens, 512);
      assert.equal(visibleState.currentStep, 0);
      assert.match(
        body.instructions,
        /self-reported assessment, never a verified game outcome/u
      );
      return response(stopDecision(focusReport));
    }
  });

  const decision = await policy.decide({
    target: target(),
    observation: observation(),
    frameBytes: FRAME_BYTES,
    areasOfFocus: "Inspect the setup menu and stop before starting a race.",
    history: [],
    deadlineMonotonicMs: performance.now() + 5000
  });

  assert.equal(decision.status, "stop");
  if (decision.status !== "stop") return;
  assert.deepEqual(decision.focusReport, focusReport);
  assert.equal(policy.usage().requestsAttempted, 1);
  assert.equal(requestCount, 1);
});

test("Smart-direct no-focus stop remains unattempted and cites only the current observation", async () => {
  const policy = createPolicy({
    fetchImpl: async () =>
      response(
        stopDecision({
          objective: null,
          inScope: [],
          forbiddenScope: [],
          stopCriteria: [],
          outcome: "unattempted",
          summary: "No operator focus was requested.",
          evidenceSteps: [0]
        })
      )
  });
  const decision = await policy.decide({
    target: target(),
    observation: observation(),
    frameBytes: FRAME_BYTES,
    areasOfFocus: null,
    history: [],
    deadlineMonotonicMs: performance.now() + 5000
  });
  assert.equal(decision.status, "stop");
  if (decision.status !== "stop") return;
  assert.equal(decision.focusReport.outcome, "unattempted");
  assert.deepEqual(decision.focusReport.evidenceSteps, [0]);
});

test("Smart-direct rejects a focus report that cites a step outside the visible history", async () => {
  const policy = createPolicy({
    fetchImpl: async () =>
      response(
        stopDecision({
          objective: "Inspect the setup menu.",
          inScope: [],
          forbiddenScope: [],
          stopCriteria: [],
          outcome: "achieved",
          summary: "The menu is visible.",
          evidenceSteps: [4]
        })
      )
  });

  await assert.rejects(
    policy.decide({
      target: target(),
      observation: observation(),
      frameBytes: FRAME_BYTES,
      areasOfFocus: "Inspect the setup menu.",
      history: [],
      deadlineMonotonicMs: performance.now() + 5000
    }),
    (error: unknown) =>
      error instanceof SmartDirectPolicyError &&
      error.code === "response-invalid"
  );
  assert.equal(policy.usage().requestsAttempted, 1);
});

test("Smart-direct rejects ungrounded and sensitive controls; ActionAdmission rejects stale coordinates", async () => {
  const visibleButton = observation().controls[0]!;
  const rejectedCandidates = [
    {
      proposedControlId: "not-visible",
      control: visibleButton
    },
    {
      proposedControlId: "control-disabled",
      control: {
        ...visibleButton,
        controlId: "control-disabled",
        enabled: false
      }
    },
    {
      proposedControlId: "control-text",
      control: {
        ...visibleButton,
        controlId: "control-text",
        role: "textbox" as const,
        inputKind: "text-entry" as const
      }
    }
  ];
  for (const candidate of rejectedCandidates) {
    const policy = createPolicy({
      fetchImpl: async () =>
        response(
          actDecision({
            kind: "activate-control",
            controlId: candidate.proposedControlId
          })
        )
    });
    await assert.rejects(
      policy.decide({
        target: target(),
        observation: observation({ controls: [candidate.control] }),
        frameBytes: FRAME_BYTES,
        areasOfFocus: null,
        history: [],
        deadlineMonotonicMs: performance.now() + 5000
      }),
      SmartDirectPolicyError
    );
    assert.equal(policy.usage().requestsAttempted, 1);
    assert.equal(policy.usage().tokensUsed, 340);
    assert.equal(policy.usage().decisionsReturned, 1);
  }
  const coordinatePolicy = createPolicy({
    fetchImpl: async () =>
      response(actDecision({ kind: "pointer-click", x: 640, y: 200 }))
  });
  const currentObservation = observation();
  const proposal = await coordinatePolicy.decide({
    target: target(),
    observation: currentObservation,
    frameBytes: FRAME_BYTES,
    areasOfFocus: null,
    history: [],
    deadlineMonotonicMs: performance.now() + 5000
  });
  assert.equal(proposal.status, "act");
  if (proposal.status !== "act") return;
  const admitted = admitPlaytestVisualAction({
    target: target(),
    observation: currentObservation,
    action: proposal.action,
    runtimeSupportedInputs: ["keyboard", "pointer"],
    currentOrigin: ORIGIN,
    currentViewport: currentObservation.viewport,
    nowMs: Date.parse(currentObservation.capturedAt),
    maxObservationAgeMs: 1000
  });
  assert.deepEqual(admitted, {
    admitted: false,
    reason: "coordinate-out-of-bounds"
  });
});

test("Smart-direct enforces request/token/deadline budgets without silent fallback", async () => {
  const policy = createPolicy({
    limits: { smartRequestsPerEpisode: 1, smartTokensPerEpisode: 300 },
    fetchImpl: async () => response(actDecision())
  });
  await assert.rejects(
    policy.decide({
      target: target({
        limits: {
          ...target().limits,
          smartRequestsPerEpisode: 1,
          smartTokensPerEpisode: 300
        }
      }),
      observation: observation(),
      frameBytes: FRAME_BYTES,
      areasOfFocus: null,
      history: [],
      deadlineMonotonicMs: performance.now() + 5000
    }),
    (error: unknown) =>
      error instanceof SmartDirectPolicyError &&
      error.code === "response-usage-exceeds-budget"
  );
  assert.equal(policy.usage().requestsAttempted, 1);
  assert.equal(policy.usage().tokensUsed, 340);
  assert.equal(policy.usage().decisionsReturned, 0);

  const noCall = createPolicy({
    limits: { smartRequestsPerEpisode: 0 },
    fetchImpl: async () => {
      throw new Error("must not call provider");
    }
  });
  await assert.rejects(
    noCall.decide({
      target: target({
        limits: { ...target().limits, smartRequestsPerEpisode: 0 }
      }),
      observation: observation(),
      frameBytes: FRAME_BYTES,
      areasOfFocus: null,
      history: [],
      deadlineMonotonicMs: performance.now() + 5000
    }),
    (error: unknown) =>
      error instanceof SmartDirectPolicyError &&
      error.code === "request-budget-exhausted"
  );
  assert.equal(noCall.usage().requestsAttempted, 0);
});

test("Smart-direct fails closed when usage is absent or target/frame identity changed", async () => {
  const missingUsage = createPolicy({
    fetchImpl: async () => response(actDecision(), null)
  });
  await assert.rejects(
    missingUsage.decide({
      target: target(),
      observation: observation(),
      frameBytes: FRAME_BYTES,
      areasOfFocus: null,
      history: [],
      deadlineMonotonicMs: performance.now() + 5000
    }),
    (error: unknown) =>
      error instanceof SmartDirectPolicyError &&
      error.code === "response-usage-unavailable"
  );
  assert.equal(missingUsage.usage().tokenUsageComplete, false);

  const policy = createPolicy({
    fetchImpl: async () => response(actDecision())
  });
  await assert.rejects(
    policy.decide({
      target: target({ revision: 3 }),
      observation: observation(),
      frameBytes: FRAME_BYTES,
      areasOfFocus: null,
      history: [],
      deadlineMonotonicMs: performance.now() + 5000
    }),
    (error: unknown) =>
      error instanceof SmartDirectPolicyError &&
      error.code === "target-unavailable"
  );
  await assert.rejects(
    policy.decide({
      target: target(),
      observation: observation(),
      frameBytes: new TextEncoder().encode("wrong frame bytes"),
      areasOfFocus: null,
      history: [],
      deadlineMonotonicMs: performance.now() + 5000
    }),
    (error: unknown) =>
      error instanceof SmartDirectPolicyError &&
      error.code === "frame-unavailable"
  );
});

test("Smart-direct readiness checks auth without exposing its token", () => {
  assert.equal(isSmartDirectVisualPolicyConfigured("4100", undefined), false);
  assert.equal(isSmartDirectVisualPolicyConfigured("4100", "   "), false);
  assert.equal(isSmartDirectVisualPolicyConfigured("4100", "configured"), true);
  assert.equal(isSmartDirectVisualPolicyConfigured("", "configured"), true);
  assert.equal(
    isSmartDirectVisualPolicyConfigured("not-a-port", "configured"),
    false
  );
  assert.equal(
    isSmartDirectVisualPolicyConfigured("999999", "configured"),
    false
  );
});

test("Smart-direct availability probes the authenticated local health endpoint and caches", async () => {
  resetSmartDirectVisualPolicyAvailabilityCache();
  let fetchCount = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCount += 1;
    assert.equal(String(input), "http://127.0.0.1:4321/health");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-router-token"
    );
    return Response.json({ status: "ok", router: "codex-model-router" });
  };
  assert.equal(
    await isSmartDirectVisualPolicyAvailable({
      portValue: "4321",
      authToken: "test-router-token",
      fetchImpl,
      now: () => 1_000,
      cacheMs: 500
    }),
    true
  );
  assert.equal(
    await isSmartDirectVisualPolicyAvailable({
      portValue: "4321",
      authToken: "test-router-token",
      fetchImpl,
      now: () => 1_100,
      cacheMs: 500
    }),
    true
  );
  assert.equal(fetchCount, 1);
  resetSmartDirectVisualPolicyAvailabilityCache();
  assert.equal(
    await isSmartDirectVisualPolicyAvailable({
      portValue: "4321",
      authToken: "test-router-token",
      fetchImpl: async () =>
        Response.json({ status: "ok", router: "different-service" }),
      now: () => 2_000
    }),
    false
  );
  assert.equal(
    await isSmartDirectVisualPolicyAvailable({
      portValue: "4321",
      authToken: "",
      fetchImpl
    }),
    false
  );
  resetSmartDirectVisualPolicyAvailabilityCache();
});

test("Smart-direct refuses non-local model endpoints before sending game evidence", () => {
  assert.throws(
    () =>
      new SmartDirectVisualPolicy(target(), {
        endpoint: "https://models.example.test/v1/responses",
        fetchImpl: async () => {
          throw new Error("must not contact a remote endpoint");
        }
      }),
    /credential-free local AutoDev model router/u
  );
});
