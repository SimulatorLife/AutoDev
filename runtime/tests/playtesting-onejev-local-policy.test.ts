import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAYTEST_VISUAL_ACTION_SCHEMA,
  PLAYTESTS_VISUAL_PROGRESS_VERSION,
  PLAYTESTS_VISUAL_STUCK_POLICY_VERSION,
  type PlaytestVisualCandidate,
  type PlaytestVisualDecisionRequest,
  type PlaytestVisualObservation,
  playtestVisualProgressPolicy,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

import {
  isOneJevLocalVisualPolicyAvailable,
  OneJevLocalPolicyError,
  OneJevLocalVisualPolicy,
  resetOneJevLocalPolicyAvailabilityCache
} from "../src/playtesting/onejev-local-policy.ts";

const WORKSPACE_ID = "fixture/racing-game";
const ORIGIN = "http://127.0.0.1:5173";
const FRAME_BYTES = new TextEncoder().encode("bounded fixture frame bytes");
/** The model the upstream serves, named by its literal id in the contract. */
const UPSTREAM_MODEL_ID = "Qwen/Qwen3.5-2B";
/** The model the upstream reports in its answer. */
const UPSTREAM_ANSWER_MODEL = "veyra-qwen3.5-2b";
/** The model revision the upstream's backbone is pinned to. */
const UPSTREAM_MODEL_REVISION = "15852e8c16360a2fea060d615a32b45270f8a8fc";

// The upstream reads the frame from a directory it was started with, so the
// Runtime has to write into a real one. The fixture uses a real directory for
// the same reason.
const IMAGE_ROOT = mkdtempSync(
  path.join(tmpdir(), "autodev-onejev-image-root-")
);
test.after(() => {
  rmSync(IMAGE_ROOT, { recursive: true, force: true });
});

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
    readonly state: {
      readonly text: string;
      readonly images: ReadonlyArray<{
        readonly path: string;
      }>;
    };
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

/**
 * The upstream's own answer, in the shape it publishes.
 *
 * The upstream reports whether it stood behind its own winner, so the answer
 * carries the abstention; a response that leaves it out is not the upstream's
 * response and is refused.
 */
function systemOneResponse(
  options: {
    readonly choice?: string;
    readonly confidence?: number;
    readonly model?: string;
    readonly usage?: Record<string, number> | null;
    readonly omitAnswers?: boolean;
    readonly abstained?: boolean;
    readonly omitAbstained?: boolean;
  } = {}
): Response {
  const body: Record<string, unknown> = {
    model: options.model ?? UPSTREAM_ANSWER_MODEL,
    backbone: {
      model_id: UPSTREAM_MODEL_ID,
      revision: UPSTREAM_MODEL_REVISION
    }
  };
  if (!options.omitAnswers) {
    const answer: Record<string, unknown> = {
      type: "choice",
      choice: options.choice ?? "candidate-start",
      probabilities: {
        "candidate-start": 0.61,
        "candidate-left": 0.39
      },
      confidence: options.confidence ?? 0.61,
      confidence_definition: "maximum_candidate_probability",
      calibrated: false,
      abstention_policy_fitted: false
    };
    if (!options.omitAbstained) {
      answer.abstained = options.abstained ?? false;
    }
    body.answers = { action: answer };
  }
  if (options.usage !== null) {
    body.usage = options.usage ?? { input_tokens: 120, output_tokens: 8 };
  }
  return Response.json(body);
}

function scenario(options: {
  readonly fetchImpl: typeof fetch;
  readonly limits?: Partial<WorkspaceVisualPlaytestTargetApproval["limits"]>;
  readonly endpoint?: string;
  readonly imageRoot?: string;
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
    imageRoot: options.imageRoot ?? IMAGE_ROOT,
    fetchImpl: options.fetchImpl,
    now: options.now ?? (() => 0)
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
    progress: {
      version: PLAYTESTS_VISUAL_PROGRESS_VERSION,
      stuckPolicyVersion: PLAYTESTS_VISUAL_STUCK_POLICY_VERSION,
      advanced: true,
      loading: false,
      unchangedSteps: 0,
      unchangedMs: 0,
      policy: playtestVisualProgressPolicy(approved)
    },
    ...overrides
  });
  return { policy, makeRequest };
}

const forbiddenFetch: typeof fetch = async () => {
  throw new Error("the policy must not call the OneJev server");
};

test("OneJev-local asks the upstream's own question: the model id, the evidence text and the frame's path", async () => {
  const captured: CapturedRequest[] = [];
  let frameOnDisk: Buffer | null = null;
  const { policy, makeRequest } = scenario({
    fetchImpl: async (input, init) => {
      captured.push({
        url: String(input),
        method: init?.method ?? "",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as CapturedRequest["body"]
      });
      // The upstream opens the frame itself, so the file has to be there
      // when it is asked.
      frameOnDisk = readFileSync(
        path.join(IMAGE_ROOT, "autodev", "episode-1-observation-1.png")
      );
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
  // The upstream's contract names one model literally; an alias is refused
  // before the frame is read.
  assert.equal(request.body.model, UPSTREAM_MODEL_ID);
  assert.equal(request.body.state.images.length, 1);
  assert.equal(
    request.body.state.images[0]!.path,
    "autodev/episode-1-observation-1.png"
  );
  assert.deepEqual(Buffer.from(frameOnDisk!), Buffer.from(FRAME_BYTES));
  assert.ok(
    request.body.state.text.includes("screen: the attached frame"),
    request.body.state.text
  );
  assert.ok(
    request.body.state.text.includes(
      "progress: advanced=true loading=false unchangedSteps=0 unchangedMs=0 limit=no limit set"
    ),
    request.body.state.text
  );
  const question = request.body.questions.action;
  assert.ok(question);
  assert.equal(question.type, "choice");
  assert.ok(
    question.instructions.includes("Which action should the player take next?")
  );
  assert.ok(question.instructions.includes("progress reading"));
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

test("OneJev-local removes its working copy of the frame once the upstream has answered", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () => systemOneResponse()
  });

  await policy.decide(makeRequest());

  assert.equal(
    existsSync(path.join(IMAGE_ROOT, "autodev", "episode-1-observation-1.png")),
    false
  );
});

test("OneJev-local carries the runtime's progress reading and the decisions already taken", async () => {
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

  const decision = await policy.decide(
    makeRequest({
      progress: {
        version: PLAYTESTS_VISUAL_PROGRESS_VERSION,
        stuckPolicyVersion: PLAYTESTS_VISUAL_STUCK_POLICY_VERSION,
        advanced: false,
        loading: false,
        unchangedSteps: 2,
        unchangedMs: 15_672,
        policy: { maxUnchangedDecisions: 2, maxUnchangedMs: 20_000 }
      },
      history: [
        {
          step: 1,
          action: JSON.stringify(activateControl("control-start")),
          observation: "phase null",
          outcome: "dispatched"
        }
      ]
    })
  );

  assert.equal(decision.status, "act");
  const request = captured[0]!;
  // A backend that is told the game has not advanced can choose differently;
  // one that is not told keeps proposing the action that does nothing.
  assert.ok(
    request.body.state.text.includes(
      "progress: advanced=false loading=false unchangedSteps=2 unchangedMs=15672 limit=2 decisions or 20000 ms without an advance"
    ),
    request.body.state.text
  );
  // The decisions already taken are what make a different choice a different
  // one rather than the same one again.
  assert.ok(
    request.body.state.text.includes(
      "recentActions: step 1: activate-control control-start (dispatched)"
    ),
    request.body.state.text
  );
  const question = request.body.questions.action;
  assert.ok(question);
  assert.ok(question.instructions.includes("advanced is false"));
  assert.ok(
    question.instructions.includes(
      "do not repeat an action that recentActions shows as already dispatched"
    )
  );
});

test("OneJev-local tells a loading page apart from a game that did not advance", async () => {
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

  const decision = await policy.decide(
    makeRequest({
      progress: {
        version: PLAYTESTS_VISUAL_PROGRESS_VERSION,
        stuckPolicyVersion: PLAYTESTS_VISUAL_STUCK_POLICY_VERSION,
        advanced: false,
        loading: true,
        unchangedSteps: 0,
        unchangedMs: 0,
        policy: null
      }
    })
  );

  assert.equal(decision.status, "act");
  const request = captured[0]!;
  // A page that is still loading has not had the chance to advance, so the
  // reading says so rather than reporting an unchanged screen.
  assert.ok(
    request.body.state.text.includes(
      "progress: advanced=false loading=true unchangedSteps=0 unchangedMs=0 limit=no limit set"
    ),
    request.body.state.text
  );
  const question = request.body.questions.action;
  assert.ok(question);
  assert.ok(
    question.instructions.includes("your approach should not change to it")
  );
});

test("OneJev-local tells two controls with one name apart, because the upstream refuses a repeated description", async () => {
  const captured: CapturedRequest[] = [];
  const { policy, makeRequest } = scenario({
    fetchImpl: async (input, init) => {
      captured.push({
        url: String(input),
        method: init?.method ?? "",
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body)) as CapturedRequest["body"]
      });
      return systemOneResponse({ choice: "candidate-driver-1" });
    }
  });

  await policy.decide(
    makeRequest({
      observation: observation({
        controls: [
          {
            controlId: "control-driver-1",
            role: "button",
            name: "Lewis",
            enabled: true,
            focused: false,
            inputKind: "none",
            bounds: { x: 20, y: 20, width: 100, height: 40 }
          },
          {
            controlId: "control-driver-2",
            role: "button",
            name: "Lewis",
            enabled: true,
            focused: false,
            inputKind: "none",
            bounds: { x: 20, y: 70, width: 100, height: 40 }
          }
        ]
      }),
      candidates: [
        {
          id: "candidate-driver-1",
          description: 'Activate the button "Lewis".',
          action: activateControl("control-driver-1")
        },
        {
          id: "candidate-driver-2",
          description: 'Activate the button "Lewis".',
          action: activateControl("control-driver-2")
        }
      ]
    })
  );

  const criteria = captured[0]!.body.questions.action!.criteria;
  assert.equal(criteria["candidate-driver-1"], 'Activate the button "Lewis".');
  assert.equal(
    criteria["candidate-driver-2"],
    'Activate the button "Lewis". (control candidate-driver-2)'
  );
  assert.equal(new Set(Object.values(criteria)).size, 2);
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
  // The model the upstream names in its answer is the model that answered.
  assert.equal(decision.modelId, UPSTREAM_ANSWER_MODEL);
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

test("OneJev-local stops when the upstream abstains instead of acting on its own winner", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () =>
      systemOneResponse({ choice: "candidate-start", abstained: true })
  });

  const decision = await policy.decide(makeRequest());

  assert.equal(decision.status, "stop");
  if (decision.status !== "stop") return;
  assert.equal(decision.action, null);
  assert.equal(decision.stopReason, "onejev-abstained");
  assert.equal(decision.reasonCode, "onejev-abstained");
  // What the upstream said is part of what the episode ended on.
  assert.equal(decision.modelId, UPSTREAM_ANSWER_MODEL);
  assert.equal(decision.confidence, 0.61);
  assert.equal(policy.usage().decisionsReturned, 1);
});

test("OneJev-local refuses an answer that does not say whether it abstained", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () => systemOneResponse({ omitAbstained: true })
  });

  await assert.rejects(
    policy.decide(makeRequest()),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-protocol-error"
  );
  assert.equal(policy.usage().decisionsReturned, 0);
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

test("OneJev-local refuses a chosen action that is not grounded in the observation", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: async () => systemOneResponse({ choice: "candidate-start" })
  });

  await assert.rejects(
    policy.decide(
      makeRequest({
        candidates: [
          {
            id: "candidate-start",
            description: "Press a control that is not on screen.",
            action: activateControl("control-not-visible")
          },
          {
            id: "candidate-left",
            description: "Steer the car to the left.",
            action: keyPress("ArrowLeft")
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

test("OneJev-local takes the only option on offer without asking, because one option is not a choice", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: forbiddenFetch
  });

  const decision = await policy.decide(
    makeRequest({
      candidates: [
        {
          id: "candidate-start",
          description: "Press the Start button to begin the race.",
          action: activateControl("control-start")
        }
      ]
    })
  );

  assert.equal(decision.status, "act");
  if (decision.status !== "act") return;
  assert.deepEqual(decision.action, activateControl("control-start"));
  // The decision says that no model chose it.
  assert.equal(decision.reasonCode, "onejev-single-option");
  assert.equal(decision.modelId, null);
  assert.equal(decision.confidence, null);
  assert.equal(decision.capabilities.reportsConfidence, false);
  assert.equal(policy.usage().providerAttempts, 0);
  assert.equal(policy.usage().decisionsReturned, 1);
});

test("OneJev-local refuses an offer the upstream's choice question cannot carry", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: forbiddenFetch
  });
  const tooMany = Array.from({ length: 17 }, (_, index) => ({
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

test("OneJev-local refuses to decide when the upstream's image root is not configured", async () => {
  const { policy, makeRequest } = scenario({
    fetchImpl: forbiddenFetch,
    imageRoot: ""
  });

  await assert.rejects(
    policy.decide(makeRequest()),
    (error: unknown) =>
      error instanceof OneJevLocalPolicyError &&
      error.code === "onejev-image-root-unavailable"
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
        imageRoot: IMAGE_ROOT,
        fetchImpl: forbiddenFetch
      }),
    TypeError
  );
  assert.throws(
    () =>
      new OneJevLocalVisualPolicy(target(), {
        endpoint: "https://127.0.0.1:8000",
        imageRoot: IMAGE_ROOT,
        fetchImpl: forbiddenFetch
      }),
    TypeError
  );
  assert.throws(
    () =>
      new OneJevLocalVisualPolicy(target(), {
        endpoint: "http://user:secret@127.0.0.1:8000",
        imageRoot: IMAGE_ROOT,
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

test("OneJev-local reports the upstream's own readiness, and refuses a route with no image root", async () => {
  resetOneJevLocalPolicyAvailabilityCache();
  const statuses: string[] = [];
  const probe: typeof fetch = async () => {
    const status = statuses.shift() ?? "ready";
    return Response.json({ status, trained: true });
  };

  assert.equal(
    await isOneJevLocalVisualPolicyAvailable({
      endpoint: "http://127.0.0.1:8000",
      imageRoot: IMAGE_ROOT,
      fetchImpl: probe
    }),
    true
  );
  resetOneJevLocalPolicyAvailabilityCache();
  // The upstream answers "ready" once it is serving; a word it never uses is
  // not its answer.
  assert.equal(
    await isOneJevLocalVisualPolicyAvailable({
      endpoint: "http://127.0.0.1:8000",
      imageRoot: IMAGE_ROOT,
      fetchImpl: async () => Response.json({ status: "ok" })
    }),
    false
  );
  resetOneJevLocalPolicyAvailabilityCache();
  // Without the directory the upstream reads its frames from, the route
  // cannot serve a decision at all.
  assert.equal(
    await isOneJevLocalVisualPolicyAvailable({
      endpoint: "http://127.0.0.1:8000",
      imageRoot: "",
      fetchImpl: forbiddenFetch
    }),
    false
  );
});
