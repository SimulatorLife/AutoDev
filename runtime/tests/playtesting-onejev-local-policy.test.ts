import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PLAYTEST_VISUAL_ACTION_SCHEMA,
  type PlaytestVisualCandidate,
  type PlaytestVisualDecisionRequest,
  type PlaytestVisualObservation,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

import {
  OneJevLocalPolicyError,
  OneJevLocalVisualPolicy
} from "../src/playtesting/onejev-local-policy.ts";

const WORKSPACE_ID = "fixture/racing-game";
const ORIGIN = "http://127.0.0.1:5173";
const FRAME_BYTES = new TextEncoder().encode("bounded fixture frame bytes");
const DATA_URI_PREFIX = "data:image/png;base64,";

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

function activateControl(controlId: string): PlaytestVisualCandidate["action"] {
  return {
    schema: PLAYTEST_VISUAL_ACTION_SCHEMA,
    workspaceId: WORKSPACE_ID,
    targetId: "racing-target",
    episodeId: "episode-1",
    observationId: "observation-1",
    kind: "activate-control",
    controlId
  };
}

function keyPress(key: "ArrowLeft"): PlaytestVisualCandidate["action"] {
  return {
    schema: PLAYTEST_VISUAL_ACTION_SCHEMA,
    workspaceId: WORKSPACE_ID,
    targetId: "racing-target",
    episodeId: "episode-1",
    observationId: "observation-1",
    kind: "key-press",
    key
  };
}

function candidates(): PlaytestVisualCandidate[] {
  return [
    {
      id: "candidate-start",
      description: "Press the Start button to begin the race.",
      action: activateControl("control-start")
    },
    {
      id: "candidate-left",
      description: "Steer the car to the left.",
      action: keyPress("ArrowLeft")
    }
  ];
}

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly model: string;
    readonly state: Record<string, string>;
    readonly media: ReadonlyArray<{
      readonly type: string;
      readonly data: string;
    }>;
    readonly questions: Record<
      string,
      {
        readonly type: string;
        readonly instructions: string;
        readonly criteria: Record<string, string>;
      }
    >;
  };
}

function systemOneResponse(
  options: {
    readonly choice?: string;
    readonly confidence?: number;
    readonly model?: string;
    readonly usage?: Record<string, number> | null;
    readonly omitAnswers?: boolean;
  } = {}
): Response {
  const body: Record<string, unknown> = {
    model: options.model ?? "jev-latest"
  };
  if (!options.omitAnswers) {
    body.answers = {
      action: {
        type: "choice",
        choice: options.choice ?? "candidate-start",
        probabilities: {
          "candidate-start": 0.61,
          "candidate-left": 0.39
        },
        confidence: options.confidence ?? 0.61
      }
    };
  }
  if (options.usage !== null) {
    body.usage = options.usage ?? { input_tokens: 120, output_tokens: 8 };
  }
  // The upstream attaches server-side timing metadata. It must not break the
  // answer, and it must not be mistaken for the answer.
  body.qev = { server_time_ms: 12, model: "jev-latest", prompt_version: "v3" };
  return Response.json(body);
}

function scenario(options: {
  readonly fetchImpl: typeof fetch;
  readonly limits?: Partial<WorkspaceVisualPlaytestTargetApproval["limits"]>;
  readonly endpoint?: string;
  readonly model?: string;
  readonly now?: () => number;
}): {
  readonly policy: OneJevLocalVisualPolicy;
  readonly makeRequest: (
    overrides?: Partial<PlaytestVisualDecisionRequest>
  ) => PlaytestVisualDecisionRequest;
} {
  const approved = target({
    limits: { ...target().limits, ...options.limits }
  });
  const policy = new OneJevLocalVisualPolicy(approved, {
    endpoint: options.endpoint ?? "http://127.0.0.1:8000",
    fetchImpl: options.fetchImpl,
    now: options.now ?? (() => 0),
    ...(options.model === undefined ? {} : { model: options.model })
  });
  const makeRequest = (
    overrides: Partial<PlaytestVisualDecisionRequest> = {}
  ): PlaytestVisualDecisionRequest => ({
    target: approved,
    observation: observation(),
    frameBytes: FRAME_BYTES,
    areasOfFocus: null,
    history: [],
    deadlineMonotonicMs: 5000,
    candidates: candidates(),
    ...overrides
  });
  return { policy, makeRequest };
}

const forbiddenFetch: typeof fetch = async () => {
  throw new Error("the policy must not call the OneJev server");
};

test("OneJev-local sends the frame inline as a PNG data URI and the candidates as choice criteria", async () => {
  const captured: CapturedRequest[] = [];
  const { policy, makeRequest } = scenario({
    fetchImpl: async (input, init) => {
      captured.push({
        url: String(input),
        method: init?.method ?? "",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as CapturedRequest["body"]
      });
      return systemOneResponse();
    }
  });

  const decision = await policy.decide(makeRequest());

  assert.equal(decision.status, "act");
  assert.equal(captured.length, 1);
  const request = captured[0]!;
  assert.equal(request.url, "http://127.0.0.1:8000/v1/systemone");
  assert.equal(request.method, "POST");
  assert.equal(
    typeof request.headers["x-typesafe-request-id"] === "string" &&
      request.headers["x-typesafe-request-id"].length > 0,
    true
  );
  assert.equal(request.body.model, "jev-latest");
  assert.deepEqual(request.body.state, { screen: "<image:1>" });
  assert.equal(request.body.media.length, 1);
  assert.equal(request.body.media[0]!.type, "image");
  assert.ok(request.body.media[0]!.data.startsWith(DATA_URI_PREFIX));
  assert.deepEqual(
    Buffer.from(
      request.body.media[0]!.data.slice(DATA_URI_PREFIX.length),
      "base64"
    ),
    Buffer.from(FRAME_BYTES)
  );
  const question = request.body.questions.action;
  assert.ok(question);
  assert.equal(question.type, "choice");
  assert.equal(
    question.instructions,
    "Which action should the player take next?"
  );
  assert.deepEqual(Object.keys(question.criteria), [
    "candidate-start",
    "candidate-left"
  ]);
  assert.equal(
    question.criteria["candidate-start"],
    "Press the Start button to begin the race."
  );
  assert.equal(
    question.criteria["candidate-left"],
    "Steer the car to the left."
  );
});

test("OneJev-local maps a well-formed answer to the chosen candidate's action", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () =>
      systemOneResponse({ choice: "candidate-start", confidence: 0.61 })
  });

  const decision = await policy.decide(makeRequest());

  assert.equal(decision.status, "act");
  if (decision.status !== "act") return;
  assert.equal(decision.backendId, "onejev-local");
  assert.equal(decision.fallback, false);
  assert.equal(decision.fallbackReason, null);
  assert.equal(decision.modelId, "jev-latest");
  assert.equal(decision.modelRevision, null);
  assert.equal(decision.confidence, 0.61);
  assert.equal(decision.intention, null);
  assert.equal(decision.predictedVisibleEffect, null);
  assert.equal(decision.reasonCode, "onejev-choice");
  assert.equal(decision.capabilities.emitsIntent, false);
  assert.equal(decision.capabilities.emitsPrediction, false);
  assert.equal(decision.capabilities.reflective, false);
  assert.equal(decision.capabilities.reportsConfidence, true);
  assert.deepEqual(decision.action, candidates()[0]!.action);
  assert.equal(decision.counters.decisionsReturned, 1);
  assert.equal(decision.counters.providerAttempts, 1);
  assert.equal(decision.counters.tokensUsed, 128);
});

test("OneJev-local refuses a choice that was never offered", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () => systemOneResponse({ choice: "candidate-invented" })
  });

  await assert.rejects(
    policy.decide(makeRequest()),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-choice-unknown"
  );
  assert.equal(policy.usage().decisionsReturned, 0);
  assert.equal(policy.usage().providerAttempts, 1);
});

test("OneJev-local refuses a response with no answer for the action question", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () => systemOneResponse({ omitAnswers: true })
  });

  await assert.rejects(
    policy.decide(makeRequest()),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-choice-missing"
  );
  assert.equal(policy.usage().decisionsReturned, 0);
});

test("OneJev-local refuses a candidate whose action is not grounded in the observation", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () => systemOneResponse()
  });

  await assert.rejects(
    policy.decide(
      makeRequest({
        candidates: [
          {
            id: "candidate-start",
            description: "Press a control that is not on screen.",
            action: activateControl("control-not-visible")
          }
        ]
      })
    ),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-action-not-grounded"
  );
  assert.equal(policy.usage().groundingRejections, 1);
  assert.equal(policy.usage().decisionsReturned, 0);
  assert.equal(policy.usage().logicalRequests, 1);
});

test("OneJev-local stops instead of asking when no candidate is on offer", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: forbiddenFetch
  });

  const decision = await policy.decide(makeRequest({ candidates: [] }));

  assert.equal(decision.status, "stop");
  if (decision.status !== "stop") return;
  assert.equal(decision.action, null);
  assert.equal(decision.reasonCode, "no-candidates");
  assert.equal(decision.stopReason, "no-candidates");
  assert.equal(decision.backendId, "onejev-local");
  assert.equal(decision.fallback, false);
  assert.equal(decision.confidence, null);
  assert.equal(decision.capabilities.reportsConfidence, false);
  assert.equal(policy.usage().providerAttempts, 0);
  assert.equal(policy.usage().decisionsReturned, 1);
});

test("OneJev-local refuses more than 255 candidates without calling the server", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: forbiddenFetch
  });
  const tooMany = Array.from({ length: 256 }, (_, index) => ({
    id: `candidate-${String(index)}`,
    description: `Candidate ${String(index)}.`,
    action: activateControl("control-start")
  }));

  await assert.rejects(
    policy.decide(makeRequest({ candidates: tooMany })),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-too-many-candidates"
  );
  assert.equal(policy.usage().providerAttempts, 0);
  assert.equal(policy.usage().logicalRequests, 0);
});

test("OneJev-local enforces the approved request budget", async () => {
  let calls = 0;
  const { policy, makeRequest } = scenario({
    limits: { smartRequestsPerEpisode: 1 },
    fetchImpl: async () => {
      calls += 1;
      return systemOneResponse();
    }
  });

  const first = await policy.decide(makeRequest());
  assert.equal(first.status, "act");

  await assert.rejects(
    policy.decide(makeRequest()),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-request-budget-exhausted"
  );
  assert.equal(calls, 1);
  assert.equal(policy.usage().logicalRequests, 1);
  assert.equal(policy.usage().providerAttempts, 1);
});

test("OneJev-local enforces the approved token budget from the reported usage", async () => {
  const { policy, makeRequest } = scenario({
    limits: { smartTokensPerEpisode: 100 },
    fetchImpl: async () =>
      systemOneResponse({ usage: { input_tokens: 120, output_tokens: 8 } })
  });

  await assert.rejects(
    policy.decide(makeRequest()),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-token-budget-exhausted"
  );
  assert.equal(policy.usage().tokensUsed, 128);
  assert.equal(policy.usage().decisionsReturned, 0);
  assert.equal(policy.usage().providerAttempts, 1);
});

test("OneJev-local refuses an endpoint that is not the local OneJev server", async () => {
  assert.throws(
    () =>
      new OneJevLocalVisualPolicy(target(), {
        endpoint: "http://example.com:8000",
        fetchImpl: forbiddenFetch
      }),
    TypeError
  );
  assert.throws(
    () =>
      new OneJevLocalVisualPolicy(target(), {
        endpoint: "https://127.0.0.1:8000",
        fetchImpl: forbiddenFetch
      }),
    TypeError
  );
  assert.throws(
    () =>
      new OneJevLocalVisualPolicy(target(), {
        endpoint: "http://user:secret@127.0.0.1:8000",
        fetchImpl: forbiddenFetch
      }),
    TypeError
  );
});

test("OneJev-local counts a retried attempt as a provider attempt, not a logical request", async () => {
  let calls = 0;
  const { policy, makeRequest } = scenario({
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("connection reset");
      }
      return systemOneResponse();
    }
  });

  const decision = await policy.decide(makeRequest());

  assert.equal(decision.status, "act");
  assert.equal(calls, 2);
  assert.equal(policy.usage().logicalRequests, 1);
  assert.equal(policy.usage().providerAttempts, 2);
  assert.equal(policy.usage().decisionsReturned, 1);
});

test("OneJev-local usage reports the counters of the episode it served", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () => systemOneResponse()
  });

  const before = policy.usage();
  assert.deepEqual(before, {
    logicalRequests: 0,
    providerAttempts: 0,
    decisionsReturned: 0,
    tokensUsed: 0,
    tokenUsageComplete: true,
    groundingRejections: 0,
    lastLatencyMs: 0
  });

  await policy.decide(makeRequest());

  assert.deepEqual(policy.usage(), {
    logicalRequests: 1,
    providerAttempts: 1,
    decisionsReturned: 1,
    tokensUsed: 128,
    tokenUsageComplete: true,
    groundingRejections: 0,
    lastLatencyMs: 0
  });
});

test("OneJev-local refuses to ask after the visual session deadline has passed", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: forbiddenFetch,
    now: () => 10_000
  });

  await assert.rejects(
    policy.decide(makeRequest({ deadlineMonotonicMs: 5000 })),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-deadline-exceeded"
  );
  assert.equal(policy.usage().providerAttempts, 0);
});

test("OneJev-local reports a server rejection as an HTTP failure, never as a decision", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () =>
      new Response("nope", {
        status: 500,
        headers: { "content-type": "text/plain" }
      })
  });

  await assert.rejects(
    policy.decide(makeRequest()),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-http-error"
  );
  assert.equal(policy.usage().decisionsReturned, 0);
  assert.equal(policy.usage().logicalRequests, 1);
});
