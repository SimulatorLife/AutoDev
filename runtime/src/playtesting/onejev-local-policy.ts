/**
 * Local OneJev decision backend for visual playtest episodes.
 *
 * A visual episode asks one question: given the frame on screen and a finite
 * set of candidate actions, which one should happen next? This backend answers
 * it by asking a OneJev checkpoint that is served by the upstream `qev` server
 * over the TypeSafe System One HTTP API.
 *
 * The upstream runs on the operator's own machine. The frame never leaves the
 * loopback interface, and the endpoint that would receive it is validated as a
 * loopback HTTP origin before a single byte is sent. A decision backend that
 * can be pointed at an arbitrary remote host is a data-exfiltration hazard, so
 * that validation is the enforcement point rather than a convention.
 *
 * The backend reports exactly what it can report. OneJev answers with a
 * calibrated choice and its confidence; it does not name an intention, does not
 * predict a visible effect, and does not reason about its own choice. Those
 * capabilities are reported as unsupported rather than quietly absent, and a
 * failed call is thrown rather than dressed up as a decision.
 */
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  assertPlaytestVisualAction,
  assertPlaytestVisualObservation,
  assertWorkspaceVisualPlaytestTargetApproval,
  canonicalPlaytestJson,
  type PlaytestVisualAction,
  type PlaytestVisualCandidate,
  type PlaytestVisualDecision,
  type PlaytestVisualDecisionCapabilities,
  type PlaytestVisualDecisionCounters,
  type PlaytestVisualDecisionRequest,
  type PlaytestVisualPolicy,
  type PlaytestVisualPolicyUsage,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

/** The upstream `qev` server's System One endpoint, relative to the base. */
const SYSTEMONE_PATH = "/v1/systemone";
/** The portable model alias the upstream resolves to the served checkpoint. */
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8000";
/** The question id the action choice is asked and answered under. */
const ACTION_QUESTION_ID = "action";
/** The reference the upstream resolves `state` against, 1-based into media. */
const SCREEN_REFERENCE = "<image:1>";
/**
 * A choice question needs at least one option and at most 255 options. A
 * larger candidate set is refused here rather than sent as an invalid request.
 */
const MAX_CHOICE_OPTIONS = 255;
const MAX_DECISION_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FOCUS_LENGTH = 2000;
const MAX_CANDIDATE_ID_LENGTH = 128;
const MAX_CANDIDATE_DESCRIPTION_LENGTH = 512;
/**
 * One logical decision may be attempted twice. A retry is another attempt at
 * the same decision, so it is counted as a provider attempt and never as a
 * second logical request.
 */
const MAX_PROVIDER_ATTEMPTS = 2;
const LOCAL_ONEJEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);
const REASON_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

const CHOICE_REASON_CODE = "onejev-choice";
const NO_CANDIDATES_REASON_CODE = "no-candidates";

/** What a OneJev decision reports. A backend that reports no confidence is a
 * backend whose confidence is not-supported; it is never a confidence of zero.
 */
function oneJevCapabilities(
  confidence: number | null
): PlaytestVisualDecisionCapabilities {
  return {
    emitsIntent: false,
    emitsPrediction: false,
    reflective: false,
    reportsConfidence: confidence !== null
  };
}

/** A stable machine-readable reason for the choice. */
function stableReasonCode(value: string): string {
  if (!REASON_CODE_PATTERN.test(value)) {
    throw new TypeError("The OneJev reason code is outside its slug contract.");
  }
  return value;
}

export type OneJevLocalPolicyErrorCode =
  | "onejev-target-unavailable"
  | "onejev-request-budget-exhausted"
  | "onejev-token-budget-exhausted"
  | "onejev-deadline-exceeded"
  | "onejev-frame-unavailable"
  | "onejev-invalid-request"
  | "onejev-too-many-candidates"
  | "onejev-duplicate-candidates"
  | "onejev-unreachable"
  | "onejev-http-error"
  | "onejev-response-too-large"
  | "onejev-protocol-error"
  | "onejev-choice-missing"
  | "onejev-choice-unknown"
  | "onejev-action-not-grounded";

export class OneJevLocalPolicyError extends Error {
  readonly code: OneJevLocalPolicyErrorCode;

  constructor(code: OneJevLocalPolicyErrorCode, message: string) {
    super(message);
    this.name = "OneJevLocalPolicyError";
    this.code = code;
  }
}

/**
 * The recorded version of this backend's contract.
 *
 * The version names the contract the episode was run under. It is not a
 * model weight revision: the served model is named per decision, from the
 * answer the local server actually returned.
 */
export const ONEJEV_LOCAL_POLICY_VERSION = "1" as const;

export interface OneJevLocalPolicyOptions {
  /**
   * Base URL of the local `qev` server. It must be a credential-free loopback
   * HTTP origin; anything else is refused before a frame can leave the process.
   */
  readonly endpoint?: string;
  /** The model or portable alias to request. Defaults to `jev-latest`. */
  readonly model?: string;
  /**
   * An optional tighter bound on a single decision. The operative bound is the
   * caller's deadline -- the approved per-episode wall-time budget -- and this
   * only lowers it.
   */
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRequestBytes?: number;
  readonly maxFrameBytes?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * The reachability probe for the local OneJev server.
 *
 * The upstream server answers `GET /health` with `{"status":"ok"}`. This is
 * a read of the operator's own machine, so it is loopback-only and it is
 * cached briefly: a capability read must not add a network request per
 * render, and the server is either up or it is not.
 */
export interface OneJevLocalAvailabilityProbeOptions {
  readonly endpoint?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
}

const ONEJEV_AVAILABILITY_TIMEOUT_MS = 2000;
const ONEJEV_AVAILABILITY_CACHE_MS = 5000;

let oneJevAvailabilityCache: {
  readonly endpoint: string;
  readonly available: boolean;
  readonly expiresAt: number;
} | null = null;

/**
 * Whether the local OneJev server can be reached right now.
 *
 * A false answer is the honest one when the operator has not started the
 * model server: the backend is simply not available, and the readiness
 * the Console shows says so.
 */
export async function isOneJevLocalVisualPolicyAvailable(
  options: OneJevLocalAvailabilityProbeOptions = {}
): Promise<boolean> {
  const endpoint =
    options.endpoint ?? process.env.AUTODEV_ONEJEV_ENDPOINT ?? DEFAULT_ENDPOINT;
  try {
    assertLocalOneJevEndpoint(endpoint);
  } catch {
    return false;
  }
  const now = options.now ?? Date.now;
  const current = now();
  const cached = oneJevAvailabilityCache;
  if (cached && cached.endpoint === endpoint && cached.expiresAt > current) {
    return cached.available;
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? ONEJEV_AVAILABILITY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let available = false;
  try {
    const response = await fetchImpl(`${endpoint}health`, {
      method: "GET",
      signal: controller.signal
    });
    if (response.ok) {
      const body: unknown = await response.json();
      available =
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        (body as { status?: unknown }).status === "ok";
    }
  } catch {
    available = false;
  } finally {
    clearTimeout(timer);
  }
  oneJevAvailabilityCache = {
    endpoint,
    available,
    expiresAt: current + (options.cacheMs ?? ONEJEV_AVAILABILITY_CACHE_MS)
  };
  return available;
}

/** The upstream answer, after it has been checked against what was asked. */
interface OneJevAnswer {
  readonly model: string;
  readonly candidate: PlaytestVisualCandidate;
  readonly confidence: number;
}

type DecisionPlan =
  | { readonly kind: "stop"; readonly reasonCode: string }
  | {
      readonly kind: "ask";
      readonly body: string;
      readonly timeoutMs: number;
      readonly candidates: readonly PlaytestVisualCandidate[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !hasControlCharacters(value)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validPositiveInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

/**
 * The only host family that may ever receive a frame. The upstream `qev`
 * server runs on the operator's own machine, so anything else is refused.
 */
function assertLocalOneJevEndpoint(value: string): void {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "http:" ||
    !LOCAL_ONEJEV_HOSTS.has(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new TypeError(
      "OneJev-local decisions must use the credential-free local OneJev server."
    );
  }
}

export class OneJevLocalVisualPolicy implements PlaytestVisualPolicy {
  readonly backendId = "onejev-local";
  private readonly target: WorkspaceVisualPlaytestTargetApproval;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRequestBytes: number;
  private readonly maxFrameBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private logicalRequests = 0;
  private providerAttempts = 0;
  private decisionsReturned = 0;
  private tokensUsed = 0;
  private tokenUsageComplete = true;
  private groundingRejections = 0;
  private lastLatencyMs = 0;

  constructor(
    target: WorkspaceVisualPlaytestTargetApproval,
    options: OneJevLocalPolicyOptions = {}
  ) {
    assertWorkspaceVisualPlaytestTargetApproval(target);
    this.target = target;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    assertLocalOneJevEndpoint(this.endpoint);
    this.model = options.model ?? DEFAULT_MODEL;
    if (!isBoundedText(this.model, 128)) {
      throw new TypeError("The OneJev model name is invalid.");
    }
    this.timeoutMs = options.timeoutMs ?? MAX_DECISION_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.maxRequestBytes = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? (() => performance.now());
    if (
      !validPositiveInteger(this.timeoutMs, MAX_DECISION_TIMEOUT_MS) ||
      !validPositiveInteger(this.maxResponseBytes, MAX_RESPONSE_BYTES) ||
      !validPositiveInteger(this.maxRequestBytes, MAX_REQUEST_BYTES) ||
      !validPositiveInteger(this.maxFrameBytes, MAX_FRAME_BYTES)
    ) {
      throw new TypeError("OneJev-local policy bounds are invalid.");
    }
  }

  usage(): PlaytestVisualPolicyUsage {
    return {
      logicalRequests: this.logicalRequests,
      providerAttempts: this.providerAttempts,
      decisionsReturned: this.decisionsReturned,
      tokensUsed: this.tokensUsed,
      tokenUsageComplete: this.tokenUsageComplete,
      groundingRejections: this.groundingRejections,
      lastLatencyMs: this.lastLatencyMs
    };
  }

  async decide(
    request: PlaytestVisualDecisionRequest
  ): Promise<PlaytestVisualDecision> {
    const plan = this.prepare(request);
    this.logicalRequests += 1;
    const startedAt = this.now();
    try {
      if (plan.kind === "stop") {
        this.decisionsReturned += 1;
        return this.stopDecision(plan.reasonCode);
      }
      const answer = await this.ask(request, plan);
      const action = this.groundAction(request, answer.candidate);
      this.decisionsReturned += 1;
      return {
        status: "act",
        action,
        stopReason: null,
        intention: null,
        predictedVisibleEffect: null,
        // A calibrated choice is not a self-report: OneJev answers what to
        // do, not what it was trying to do.
        selfReport: null,
        reasonCode: stableReasonCode(CHOICE_REASON_CODE),
        backendId: this.backendId,
        modelId: answer.model,
        modelRevision: null,
        fallback: false,
        fallbackReason: null,
        confidence: answer.confidence,
        capabilities: oneJevCapabilities(answer.confidence),
        counters: this.counters()
      };
    } finally {
      this.lastLatencyMs = Math.max(0, this.now() - startedAt);
    }
  }

  /**
   * Validate everything that can be validated before the frame leaves the
   * process, so a request that cannot be served or cannot be afforded is
   * refused without spending a provider attempt.
   */
  private prepare(request: PlaytestVisualDecisionRequest): DecisionPlan {
    assertWorkspaceVisualPlaytestTargetApproval(this.target);
    assertWorkspaceVisualPlaytestTargetApproval(request.target);
    assertPlaytestVisualObservation(request.observation, this.target);
    if (
      this.target.revokedAt !== null ||
      request.target.revokedAt !== null ||
      request.target.targetId !== this.target.targetId ||
      request.target.revision !== this.target.revision ||
      canonicalPlaytestJson(request.target) !==
        canonicalPlaytestJson(this.target) ||
      request.observation.targetId !== this.target.targetId
    ) {
      throw new OneJevLocalPolicyError(
        "onejev-target-unavailable",
        "The approved visual target changed before the OneJev decision."
      );
    }
    if (this.logicalRequests >= this.target.limits.smartRequestsPerEpisode) {
      throw new OneJevLocalPolicyError(
        "onejev-request-budget-exhausted",
        "The approved OneJev request budget is exhausted."
      );
    }
    if (this.target.limits.smartTokensPerEpisode - this.tokensUsed < 1) {
      throw new OneJevLocalPolicyError(
        "onejev-token-budget-exhausted",
        "The approved OneJev token budget is exhausted."
      );
    }
    if (
      !(request.frameBytes instanceof Uint8Array) ||
      request.frameBytes.byteLength === 0 ||
      request.frameBytes.byteLength !== request.observation.frame.bytes ||
      request.frameBytes.byteLength > this.maxFrameBytes ||
      createHash("sha256").update(request.frameBytes).digest("hex") !==
        request.observation.frame.sha256.toLowerCase() ||
      request.observation.frame.mediaType !== "image/png"
    ) {
      throw new OneJevLocalPolicyError(
        "onejev-frame-unavailable",
        "The verified redacted PNG frame is unavailable to OneJev."
      );
    }
    if (
      request.areasOfFocus !== null &&
      !isBoundedText(request.areasOfFocus, MAX_FOCUS_LENGTH)
    ) {
      throw new OneJevLocalPolicyError(
        "onejev-invalid-request",
        "The visual focus is outside its bounded text contract."
      );
    }
    if (request.candidates.length > MAX_CHOICE_OPTIONS) {
      throw new OneJevLocalPolicyError(
        "onejev-too-many-candidates",
        "The candidate set exceeds the choice question's option limit."
      );
    }
    const candidates = this.validateCandidates(request.candidates);
    if (candidates.length === 0) {
      // A choice question needs at least one option, so there is nothing to
      // ask. Stopping is an honest answer; it is not a failure.
      return { kind: "stop", reasonCode: NO_CANDIDATES_REASON_CODE };
    }
    const remainingTimeMs = request.deadlineMonotonicMs - this.now();
    if (remainingTimeMs <= 0) {
      throw new OneJevLocalPolicyError(
        "onejev-deadline-exceeded",
        "The visual session deadline elapsed before OneJev could decide."
      );
    }
    const body = JSON.stringify(this.buildRequestBody(request, candidates));
    if (new TextEncoder().encode(body).byteLength > this.maxRequestBytes) {
      throw new OneJevLocalPolicyError(
        "onejev-invalid-request",
        "The bounded OneJev request exceeded its Runtime input size limit."
      );
    }
    return {
      kind: "ask",
      body,
      timeoutMs: Math.min(this.timeoutMs, remainingTimeMs),
      candidates
    };
  }

  private validateCandidates(
    candidates: readonly PlaytestVisualCandidate[]
  ): readonly PlaytestVisualCandidate[] {
    const optionIds = new Set<string>();
    for (const candidate of candidates) {
      if (
        !isBoundedText(candidate.id, MAX_CANDIDATE_ID_LENGTH) ||
        candidate.id.trim() !== candidate.id
      ) {
        throw new OneJevLocalPolicyError(
          "onejev-invalid-request",
          "A OneJev candidate id is outside its bounded text contract."
        );
      }
      if (optionIds.has(candidate.id)) {
        throw new OneJevLocalPolicyError(
          "onejev-duplicate-candidates",
          "Two OneJev candidates share one option id."
        );
      }
      optionIds.add(candidate.id);
      if (
        !isBoundedText(candidate.description, MAX_CANDIDATE_DESCRIPTION_LENGTH)
      ) {
        throw new OneJevLocalPolicyError(
          "onejev-invalid-request",
          "A OneJev candidate description is outside its bounded text contract."
        );
      }
      try {
        assertPlaytestVisualAction(candidate.action);
      } catch {
        throw new OneJevLocalPolicyError(
          "onejev-invalid-request",
          "A OneJev candidate carries a malformed action."
        );
      }
    }
    return candidates;
  }

  private buildRequestBody(
    request: PlaytestVisualDecisionRequest,
    candidates: readonly PlaytestVisualCandidate[]
  ): Record<string, unknown> {
    const criteria: Record<string, string> = {};
    for (const candidate of candidates) {
      criteria[candidate.id] = candidate.description;
    }
    const state: Record<string, string> = { screen: SCREEN_REFERENCE };
    if (request.areasOfFocus !== null) {
      state.focus = request.areasOfFocus;
    }
    return {
      model: this.model,
      state,
      media: [
        {
          type: "image",
          data: `data:image/png;base64,${Buffer.from(request.frameBytes).toString("base64")}`
        }
      ],
      questions: {
        [ACTION_QUESTION_ID]: {
          type: "choice",
          instructions: "Which action should the player take next?",
          criteria
        }
      }
    };
  }

  /**
   * Ask the local OneJev server, retrying a transient failure once. The retry
   * is another attempt at the same logical decision, so it is counted as a
   * provider attempt and never as a second logical request.
   */
  private async ask(
    request: PlaytestVisualDecisionRequest,
    plan: {
      readonly body: string;
      readonly timeoutMs: number;
      readonly candidates: readonly PlaytestVisualCandidate[];
    }
  ): Promise<OneJevAnswer> {
    const requestId = randomUUID();
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
      const remainingTimeMs = request.deadlineMonotonicMs - this.now();
      if (remainingTimeMs <= 0) {
        throw new OneJevLocalPolicyError(
          "onejev-deadline-exceeded",
          "The visual session deadline elapsed before OneJev could answer."
        );
      }
      this.providerAttempts += 1;
      let response: Response;
      try {
        response = await this.postRequest(
          plan.body,
          requestId,
          Math.min(plan.timeoutMs, remainingTimeMs)
        );
      } catch (error) {
        if (
          error instanceof OneJevLocalPolicyError &&
          error.code === "onejev-unreachable" &&
          attempt < MAX_PROVIDER_ATTEMPTS
        ) {
          continue;
        }
        throw error;
      }
      if (
        RETRYABLE_STATUS_CODES.has(response.status) &&
        attempt < MAX_PROVIDER_ATTEMPTS
      ) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!response.ok) {
        throw new OneJevLocalPolicyError(
          "onejev-http-error",
          `The local OneJev server rejected the decision with status ${String(response.status)}.`
        );
      }
      const body = await this.readBody(response);
      this.accountUsage(body);
      return this.parseAnswer(body, plan.candidates);
    }
    throw new OneJevLocalPolicyError(
      "onejev-unreachable",
      "The local OneJev server could not be reached."
    );
  }

  private async postRequest(
    body: string,
    requestId: string,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(
        new URL(SYSTEMONE_PATH, this.endpoint).toString(),
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-typesafe-request-id": requestId
          },
          body,
          signal: controller.signal
        }
      );
    } catch {
      if (controller.signal.aborted) {
        throw new OneJevLocalPolicyError(
          "onejev-deadline-exceeded",
          "The OneJev decision exceeded the remaining visual session deadline."
        );
      }
      throw new OneJevLocalPolicyError(
        "onejev-unreachable",
        "The local OneJev server could not be reached."
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(response: Response): Promise<unknown> {
    const stream = response.body;
    if (!stream) {
      throw new OneJevLocalPolicyError(
        "onejev-protocol-error",
        "The OneJev server returned no response body."
      );
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    for await (const value of stream) {
      totalBytes += value.byteLength;
      if (totalBytes > this.maxResponseBytes) {
        throw new OneJevLocalPolicyError(
          "onejev-response-too-large",
          "The OneJev response exceeded its Runtime size bound."
        );
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
        )
      );
    } catch {
      throw new OneJevLocalPolicyError(
        "onejev-protocol-error",
        "The OneJev server returned invalid JSON."
      );
    }
  }

  /**
   * Charge the response's reported tokens to the episode budget. A response
   * that reports no usage leaves the count a floor rather than a total, which
   * is recorded rather than assumed away.
   */
  private accountUsage(body: unknown): void {
    if (!isRecord(body) || !isRecord(body.usage)) {
      this.tokenUsageComplete = false;
      return;
    }
    const inputTokens = body.usage.input_tokens;
    const outputTokens = body.usage.output_tokens;
    if (
      !isNonNegativeInteger(inputTokens) ||
      !isNonNegativeInteger(outputTokens)
    ) {
      this.tokenUsageComplete = false;
      return;
    }
    this.tokensUsed += inputTokens + outputTokens;
    if (this.tokensUsed > this.target.limits.smartTokensPerEpisode) {
      throw new OneJevLocalPolicyError(
        "onejev-token-budget-exhausted",
        "The OneJev response usage exceeded the approved token budget; the action was not dispatched."
      );
    }
  }

  private parseAnswer(
    body: unknown,
    candidates: readonly PlaytestVisualCandidate[]
  ): OneJevAnswer {
    if (!isRecord(body)) {
      throw new OneJevLocalPolicyError(
        "onejev-protocol-error",
        "The OneJev server returned an unsupported response body."
      );
    }
    if (typeof body.model !== "string" || body.model.trim().length === 0) {
      throw new OneJevLocalPolicyError(
        "onejev-protocol-error",
        "The OneJev response did not identify the model that answered."
      );
    }
    if (!isRecord(body.answers)) {
      throw new OneJevLocalPolicyError(
        "onejev-choice-missing",
        "The OneJev response carried no answer for the action question."
      );
    }
    const answer = body.answers[ACTION_QUESTION_ID];
    if (!isRecord(answer)) {
      throw new OneJevLocalPolicyError(
        "onejev-choice-missing",
        "The OneJev response carried no answer for the action question."
      );
    }
    const choice = answer.choice;
    if (typeof choice !== "string") {
      throw new OneJevLocalPolicyError(
        "onejev-choice-missing",
        "The OneJev response carried no choice for the action question."
      );
    }
    const confidence = answer.confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new OneJevLocalPolicyError(
        "onejev-protocol-error",
        "The OneJev response did not report a calibrated confidence."
      );
    }
    const candidate = candidates.find((option) => option.id === choice);
    if (!candidate) {
      throw new OneJevLocalPolicyError(
        "onejev-choice-unknown",
        "The OneJev response chose an option that was not offered."
      );
    }
    return {
      model: body.model.trim(),
      candidate,
      confidence
    };
  }

  /**
   * Re-verify the chosen candidate against the observation. OneJev proposes an
   * action; it does not grant permission to perform one, so an action that is
   * not grounded in the frame is refused rather than dispatched.
   */
  private groundAction(
    request: PlaytestVisualDecisionRequest,
    candidate: PlaytestVisualCandidate
  ): PlaytestVisualAction {
    const observation = request.observation;
    const action = candidate.action;
    const grounded =
      action.workspaceId === observation.workspaceId &&
      action.targetId === observation.targetId &&
      action.episodeId === observation.episodeId &&
      action.observationId === observation.observationId;
    if (!grounded) {
      this.rejectGrounding(
        "OneJev selected an action that does not cite this observation."
      );
    }
    switch (action.kind) {
      case "activate-control": {
        const controlId = action.controlId;
        const control = observation.controls.find(
          (visible) => visible.controlId === controlId
        );
        if (
          !control ||
          !control.enabled ||
          control.inputKind !== "none" ||
          !this.target.inputCapabilities.includes("pointer")
        ) {
          this.rejectGrounding(
            "OneJev selected a control that is not an enabled visible pointer target."
          );
        }
        return action;
      }
      case "pointer-click": {
        if (
          !this.target.inputCapabilities.includes("pointer") ||
          action.frameArtifactId !== observation.frame.artifactId
        ) {
          this.rejectGrounding(
            "OneJev selected pointer input that is not approved for this frame."
          );
        }
        return action;
      }
      case "key-press": {
        if (!this.target.inputCapabilities.includes("keyboard")) {
          this.rejectGrounding(
            "OneJev selected keyboard input that is not approved for this target."
          );
        }
        return action;
      }
      case "gamepad-press": {
        if (!this.target.inputCapabilities.includes("gamepad")) {
          this.rejectGrounding(
            "OneJev selected gamepad input that is not approved for this target."
          );
        }
        return action;
      }
    }
  }

  private rejectGrounding(message: string): never {
    this.groundingRejections += 1;
    throw new OneJevLocalPolicyError("onejev-action-not-grounded", message);
  }

  private stopDecision(reasonCode: string): PlaytestVisualDecision {
    return {
      status: "stop",
      selfReport: null,
      action: null,
      stopReason: reasonCode,
      intention: null,
      predictedVisibleEffect: null,
      reasonCode: stableReasonCode(reasonCode),
      backendId: this.backendId,
      modelId: null,
      modelRevision: null,
      fallback: false,
      fallbackReason: null,
      confidence: null,
      capabilities: oneJevCapabilities(null),
      counters: this.counters()
    };
  }

  private counters(): PlaytestVisualDecisionCounters {
    return {
      logicalRequests: this.logicalRequests,
      providerAttempts: this.providerAttempts,
      decisionsReturned: this.decisionsReturned,
      tokensUsed: this.tokensUsed,
      tokenUsageComplete: this.tokenUsageComplete,
      groundingRejections: this.groundingRejections
    };
  }
}
