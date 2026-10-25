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
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
  type PlaytestVisualDecisionProgress,
  type PlaytestVisualDecisionRequest,
  type PlaytestVisualHistoryEntry,
  type PlaytestVisualPolicy,
  type PlaytestVisualPolicyUsage,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

/** The upstream `qev` server's System One endpoint, relative to the base. */
const SYSTEMONE_PATH = "/v1/systemone";
/**
 * The model the upstream serves.
 *
 * The upstream's request contract names one model literally -- the served
 * checkpoint's id -- and it is a `Literal`: a request that asks for anything
 * else is refused before the frame is read. A portable alias is not resolved
 * for it, so the alias the Runtime used to send was refused by the very
 * server it was written for.
 */
const UPSTREAM_MODEL_ID = "Qwen/Qwen3.5-2B";
const DEFAULT_ENDPOINT = "http://127.0.0.1:8000";
/**
 * The status the upstream's health endpoint reports once it is serving.
 *
 * The upstream answers `{"status":"ready","trained":true}`. A probe that
 * waited for a different word reported a server that was up as one that was
 * not, and the Console read that as an unavailable route.
 */
const UPSTREAM_HEALTH_STATUS = "ready";
/** The question id the action choice is asked and answered under. */
const ACTION_QUESTION_ID = "action";
/**
 * The upstream's own cap on the options one choice question may carry.
 *
 * A request with more options is refused by the upstream, so it is refused
 * here where the reason can be named and the episode can end honestly.
 */
const MAX_CHOICE_OPTIONS = 16;
/**
 * The upstream's own floor on a choice question's options.
 *
 * One option is not a choice, and the upstream refuses a question that
 * carries one. The Runtime therefore does not ask in that case: the single
 * option on offer is the only action there is, and it is taken without
 * pretending the model chose it.
 */
const MIN_CHOICE_OPTIONS = 2;
/**
 * The upstream's bound on the evidence text one request may carry.
 *
 * The upstream packs the text as the data half of its prompt, so a request
 * that carries more is refused. The Runtime's own bound is the smaller of
 * the two: a screen's state is a summary, not a transcript.
 */
const MAX_STATE_TEXT_LENGTH = 100_000;
const MAX_DECISION_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
/**
 * The upstream's own bound on a request body.
 *
 * The server refuses a body larger than this before it reads it, so the
 * Runtime's bound is the server's: a request the server will refuse is a
 * request the Runtime has no reason to send.
 */
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FOCUS_LENGTH = 2000;
const MAX_CANDIDATE_ID_LENGTH = 128;
const MAX_CANDIDATE_DESCRIPTION_LENGTH = 512;
/**
 * How many past decisions the local server is told about.
 *
 * A small local model spends its context on what it is asked about, and the
 * decisions that bear on the next choice are the last few.
 */
const MAX_RECENT_ACTIONS = 4;
/** The bound on one past decision's summary. */
const MAX_RECENT_ACTION_LENGTH = 200;
/**
 * One logical decision may be attempted twice. A retry is another attempt at
 * the same decision, so it is counted as a provider attempt and never as a
 * second logical request.
 */
const MAX_PROVIDER_ATTEMPTS = 2;
const LOCAL_ONEJEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);
const REASON_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

/**
 * The directory the upstream `qev serve --image-root` was started with.
 *
 * The upstream resolves the frame path it is given against this directory and
 * refuses a path that leaves it, so the Runtime has to write the frame where
 * the server will look for it. The operator names the same directory in both
 * places: the server's `--image-root` and this variable.
 */
const ONEJEV_IMAGE_ROOT_ENV = "AUTODEV_ONEJEV_IMAGE_ROOT";
/**
 * The directory under the image root where the Runtime writes its frames.
 *
 * The Runtime's frames are its own working files, so they live in a
 * directory of their own rather than loose in the operator's image root.
 */
const FRAME_DIRECTORY = "autodev";

const CHOICE_REASON_CODE = "onejev-choice";
const NO_CANDIDATES_REASON_CODE = "no-candidates";
/**
 * The reason a decision carries when only one action was on offer.
 *
 * The upstream's choice question needs two options, so a lone option is not
 * asked about. The decision says so rather than reporting a model choice
 * that never happened.
 */
const SINGLE_OPTION_REASON_CODE = "onejev-single-option";
/** The reason a decision carries when the model declined to commit. */
const ABSTAINED_REASON_CODE = "onejev-abstained";

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
  | "onejev-image-root-unavailable"
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
 *
 * Version 2 is the upstream's own request contract: the model is named by
 * its literal id, the frame is a file under the server's image root, the
 * state is the evidence text and that one frame, and the answer reports
 * whether the model abstained.
 */
export const ONEJEV_LOCAL_POLICY_VERSION = "2" as const;

export interface OneJevLocalPolicyOptions {
  /**
   * Base URL of the local `qev` server. It must be a credential-free loopback
   * HTTP origin; anything else is refused before a frame can leave the process.
   */
  readonly endpoint?: string;
  /**
   * The directory the upstream `qev serve --image-root` was started with.
   *
   * The upstream resolves the frame path it is given against this directory
   * and refuses a path that leaves it, so the Runtime writes the frame here
   * and names it relative to this root. Defaults to the operator's
   * `AUTODEV_ONEJEV_IMAGE_ROOT`.
   */
  readonly imageRoot?: string;
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
  readonly imageRoot?: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
}

/**
 * The failure codes this policy raises more than once.
 *
 * A code is the machine-readable half of a failure, so the same failure must
 * always carry the same code; spelling it out at each throw is how two
 * failures drift apart.
 */
const ONEJEV_INVALID_REQUEST_CODE = "onejev-invalid-request";
const ONEJEV_PROTOCOL_ERROR_CODE = "onejev-protocol-error";

const ONEJEV_AVAILABILITY_TIMEOUT_MS = 2000;
const ONEJEV_AVAILABILITY_CACHE_MS = 5000;

/**
 * The cached reachability answer, per endpoint.
 *
 * The cache is keyed by the endpoint it answers for, so a probe for one
 * server never reads another's answer, and a probe that overlaps another
 * probe writes its own entry rather than reassigning a shared binding.
 */
const oneJevAvailabilityCache = new Map<
  string,
  {
    readonly available: boolean;
    readonly expiresAt: number;
  }
>();

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
  // The upstream reads the frame from a directory it was started with, so a
  // route with no image root named cannot serve a decision at all.
  if (
    resolveImageRoot(
      options.imageRoot ?? process.env[ONEJEV_IMAGE_ROOT_ENV]
    ) === null
  ) {
    return false;
  }
  try {
    assertLocalOneJevEndpoint(endpoint);
  } catch {
    return false;
  }
  const now = options.now ?? Date.now;
  const current = now();
  const cached = oneJevAvailabilityCache.get(endpoint);
  if (cached && cached.expiresAt > current) {
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
        (body as { status?: unknown }).status === UPSTREAM_HEALTH_STATUS;
    }
  } catch {
    available = false;
  } finally {
    clearTimeout(timer);
  }
  oneJevAvailabilityCache.set(endpoint, {
    available,
    expiresAt: current + (options.cacheMs ?? ONEJEV_AVAILABILITY_CACHE_MS)
  });
  return available;
}

/** Test seam to isolate readiness probe cache lifetimes. */
export function resetOneJevLocalPolicyAvailabilityCache(): void {
  oneJevAvailabilityCache.clear();
}

/** The upstream answer, after it has been checked against what was asked. */
interface OneJevAnswer {
  readonly model: string;
  readonly candidate: PlaytestVisualCandidate;
  readonly confidence: number;
  /**
   * Whether the upstream declined to commit to its own winner.
   *
   * The upstream reports it beside the choice it would have made: a model
   * whose confidence falls below the abstention threshold it was calibrated
   * with answers that it does not know. Acting on its winner anyway would
   * dispatch an action the backend explicitly disowned.
   */
  readonly abstained: boolean;
}

type DecisionPlan =
  | { readonly kind: "stop"; readonly reasonCode: string }
  | {
      readonly kind: "single";
      readonly candidate: PlaytestVisualCandidate;
    }
  | {
      readonly kind: "ask";
      readonly body: string;
      readonly timeoutMs: number;
      readonly candidates: readonly PlaytestVisualCandidate[];
      /** The frame's path under the image root, as the upstream resolves it. */
      readonly framePath: string;
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

/**
 * The image root the Runtime writes frames into, or null when none is named.
 *
 * The upstream resolves the frame path it is given against the directory it
 * was started with and refuses a path that leaves it, so the Runtime has to
 * know that directory to write into. When the operator has named none there
 * is nowhere to write, and the decision says so instead of sending a request
 * the server cannot serve.
 */
function resolveImageRoot(value: string | undefined): string | null {
  const named = (value ?? "").trim();
  return named.length === 0 ? null : path.resolve(named);
}

/**
 * The Runtime's progress reading as the local server reads it.
 *
 * The upstream takes its state as a flat map of strings, so the reading is
 * written in the words the Runtime measured it in. A backend that is told the
 * game has not advanced can choose differently; a backend that is not told
 * cannot, and keeps proposing the action that does nothing.
 */
function progressState(progress: PlaytestVisualDecisionProgress): string {
  const limit =
    progress.policy === null
      ? "no limit set"
      : `${String(progress.policy.maxUnchangedDecisions)} decisions or ${String(
          progress.policy.maxUnchangedMs
        )} ms without an advance`;
  return [
    `advanced=${String(progress.advanced)}`,
    `loading=${String(progress.loading)}`,
    `unchangedSteps=${String(progress.unchangedSteps)}`,
    `unchangedMs=${String(progress.unchangedMs)}`,
    `limit=${limit}`
  ].join(" ");
}

/**
 * The choice question's options, named so that each one means something
 * different.
 *
 * The upstream refuses a choice question whose options share a description:
 * two options that read the same are one option to it, and the answer it
 * gives names one of them at random. A game can and does put two controls
 * with the same accessible name on one screen -- the RacingGame screen has
 * thirteen driver-row buttons over six drivers -- so the name that repeats
 * is qualified by the control it belongs to. That is what the control id is
 * for, and the model is told which control each option is.
 */
function distinctCriteria(
  candidates: readonly PlaytestVisualCandidate[]
): Record<string, string> {
  const criteria: Record<string, string> = {};
  const used = new Map<string, number>();
  for (const candidate of candidates) {
    const seen = used.get(candidate.description) ?? 0;
    used.set(candidate.description, seen + 1);
    criteria[candidate.id] =
      seen === 0
        ? candidate.description
        : `${candidate.description} (control ${candidate.id})`;
  }
  return criteria;
}

/**
 * A frame file name the upstream's image root can hold.
 *
 * The name comes from the observation the frame belongs to, so two frames of
 * the same step never overwrite one another, and it is reduced to characters
 * that are safe in a path.
 */
function safeFrameFileName(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9._-]/gu, "_");
  return cleaned.length > 0 && cleaned.length <= 128 ? cleaned : "frame";
}

/**
 * The decisions the episode already took, as the local server reads them.
 *
 * The reading is only actionable when the backend can see what it already
 * did: told that the game did not advance and given nothing else, the model
 * picks the same control again. Each entry says what was attempted and what
 * became of it, not the whole action.
 */
function recentActionsState(
  history: readonly PlaytestVisualHistoryEntry[]
): string {
  return history
    .slice(-MAX_RECENT_ACTIONS)
    .map(
      (entry) =>
        `step ${String(entry.step)}: ${describeAction(entry.action)} (${entry.outcome.trim()})`
    )
    .join("; ");
}

/**
 * One past action, in the fewest words that still identify it.
 *
 * The action is stored as the JSON the Runtime dispatched, and that JSON is
 * mostly identifiers the model cannot use: truncated at the control id, it
 * names nothing. The kind and the control it acted on are what a model needs
 * in order not to repeat itself.
 */
function describeAction(action: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(action);
  } catch {
    return boundedSummary(action);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return boundedSummary(action);
  }
  const record = parsed as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "action";
  const identifier =
    typeof record.controlId === "string"
      ? record.controlId
      : typeof record.key === "string"
        ? record.key
        : null;
  return boundedSummary(identifier === null ? kind : `${kind} ${identifier}`);
}

/**
 * One summary, bounded so a long value cannot crowd out the rest of the
 * state.
 */
function boundedSummary(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= MAX_RECENT_ACTION_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_RECENT_ACTION_LENGTH - 3)}...`;
}

/**
 * The instructions the action question is asked under.
 *
 * The reading's meaning lives here and its values live in the state, the same
 * split the Smart-directed route uses: the upstream passes both to the model,
 * and a number the model cannot interpret is a number it ignores.
 */
function actionQuestionInstructions(): string {
  return [
    "Which action should the player take next?",
    "The state carries the runtime's progress reading. advanced is false when the game has shown the player exactly what it showed before. loading is true when the page reports that it is still loading: the game has not had the chance to advance yet, so an unchanged screen behind it is not the game refusing to respond, and your approach should not change to it.",
    "When advanced is false and loading is false, the game is not responding to what you did: choose a different control or a different way to reach the same effect, and do not repeat an action that recentActions shows as already dispatched against an unchanged screen.",
    "The limit in the reading is the operator's own, and it says how many attempts remain before the episode ends and reports that the game did not advance."
  ].join(" ");
}

export class OneJevLocalVisualPolicy implements PlaytestVisualPolicy {
  readonly backendId = "onejev-local";
  private readonly target: WorkspaceVisualPlaytestTargetApproval;
  private readonly endpoint: string;
  private readonly imageRoot: string | null;
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
    this.imageRoot = resolveImageRoot(
      options.imageRoot ?? process.env[ONEJEV_IMAGE_ROOT_ENV]
    );
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
    const plan = await this.prepare(request);
    this.logicalRequests += 1;
    const startedAt = this.now();
    try {
      if (plan.kind === "stop") {
        this.decisionsReturned += 1;
        return this.stopDecision(plan.reasonCode);
      }
      if (plan.kind === "single") {
        // One option is not a choice the upstream can be asked about, so the
        // action is taken and the decision says that no model chose it.
        const action = this.groundAction(request, plan.candidate);
        this.decisionsReturned += 1;
        return {
          status: "act",
          action,
          stopReason: null,
          intention: null,
          predictedVisibleEffect: null,
          selfReport: null,
          reasonCode: stableReasonCode(SINGLE_OPTION_REASON_CODE),
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
      try {
        const answer = await this.ask(request, plan);
        if (answer.abstained) {
          // The model answered and disowned its own winner. Dispatching it
          // would perform an action the backend explicitly declined to
          // commit to, so the episode ends with that reason recorded.
          this.decisionsReturned += 1;
          return this.stopDecision(
            ABSTAINED_REASON_CODE,
            answer.model,
            answer.confidence
          );
        }
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
        // The upstream has read the frame by the time it answers, so the
        // Runtime's working copy has served its purpose.
        await this.removeFrame(plan.framePath);
      }
    } finally {
      this.lastLatencyMs = Math.max(0, this.now() - startedAt);
    }
  }

  /**
   * Validate everything that can be validated before the frame leaves the
   * process, so a request that cannot be served or cannot be afforded is
   * refused without spending a provider attempt.
   */
  private async prepare(
    request: PlaytestVisualDecisionRequest
  ): Promise<DecisionPlan> {
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
        ONEJEV_INVALID_REQUEST_CODE,
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
    if (candidates.length < MIN_CHOICE_OPTIONS) {
      // The upstream refuses a choice question that carries one option, and
      // there is nothing to choose between. The only action on offer is
      // taken, and the decision records that the model was not asked.
      return { kind: "single", candidate: candidates[0]! };
    }
    const remainingTimeMs = request.deadlineMonotonicMs - this.now();
    if (remainingTimeMs <= 0) {
      throw new OneJevLocalPolicyError(
        "onejev-deadline-exceeded",
        "The visual session deadline elapsed before OneJev could decide."
      );
    }
    const framePath = this.framePath(request);
    const body = JSON.stringify(
      this.buildRequestBody(request, candidates, framePath)
    );
    if (new TextEncoder().encode(body).byteLength > this.maxRequestBytes) {
      throw new OneJevLocalPolicyError(
        ONEJEV_INVALID_REQUEST_CODE,
        "The bounded OneJev request exceeded its Runtime input size limit."
      );
    }
    await this.writeFrame(request, framePath);
    return {
      kind: "ask",
      body,
      timeoutMs: Math.min(this.timeoutMs, remainingTimeMs),
      candidates,
      framePath
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
          ONEJEV_INVALID_REQUEST_CODE,
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
          ONEJEV_INVALID_REQUEST_CODE,
          "A OneJev candidate description is outside its bounded text contract."
        );
      }
      try {
        assertPlaytestVisualAction(candidate.action);
      } catch {
        throw new OneJevLocalPolicyError(
          ONEJEV_INVALID_REQUEST_CODE,
          "A OneJev candidate carries a malformed action."
        );
      }
    }
    return candidates;
  }

  /**
   * The frame's path under the image root, as the upstream resolves it.
   *
   * The upstream joins the path it is given to its own image root and
   * refuses anything that leaves it, so the path is relative and names the
   * file the Runtime is about to write.
   */
  private framePath(request: PlaytestVisualDecisionRequest): string {
    const name = `${safeFrameFileName(
      request.observation.episodeId
    )}-${safeFrameFileName(request.observation.observationId)}.png`;
    return `${FRAME_DIRECTORY}/${name}`;
  }

  /**
   * Write the frame where the upstream will look for it.
   *
   * The upstream opens the frame itself -- it takes a path, not bytes -- so
   * the Runtime's copy has to exist on disk under the image root the server
   * was started with.
   */
  private async writeFrame(
    request: PlaytestVisualDecisionRequest,
    framePath: string
  ): Promise<void> {
    const root = this.imageRoot;
    if (root === null) {
      throw new OneJevLocalPolicyError(
        "onejev-image-root-unavailable",
        "The local OneJev server's image root is not configured."
      );
    }
    const stats = await stat(root).catch(() => null);
    if (stats === null || !stats.isDirectory()) {
      throw new OneJevLocalPolicyError(
        "onejev-image-root-unavailable",
        "The local OneJev server's image root is not a directory."
      );
    }
    const absolute = path.join(root, framePath);
    try {
      await mkdir(path.join(root, FRAME_DIRECTORY), { recursive: true });
      await writeFile(absolute, request.frameBytes);
    } catch (error) {
      // A half-written frame would be read by the upstream as the screen.
      await rm(absolute, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Remove the Runtime's working copy of the frame.
   *
   * The upstream has read the frame by the time it answers, and the image
   * root is the operator's directory: the Runtime's copies do not stay in it.
   */
  private async removeFrame(framePath: string): Promise<void> {
    const root = this.imageRoot;
    if (root === null) return;
    // A frame that cannot be removed is litter in the operator's directory,
    // not a failure of the decision that already succeeded.
    await rm(path.join(root, framePath), { force: true }).catch(
      () => undefined
    );
  }

  private buildRequestBody(
    request: PlaytestVisualDecisionRequest,
    candidates: readonly PlaytestVisualCandidate[],
    framePath: string
  ): Record<string, unknown> {
    // The upstream's state is a strict pair: the evidence text and, at most,
    // one image named by a path under the directory the server was started
    // with. It does not accept a map of extra keys, and it does not accept
    // image bytes: it opens the file itself.
    const evidence: string[] = ["screen: the attached frame"];
    if (request.areasOfFocus !== null) {
      evidence.push(`focus: ${request.areasOfFocus}`);
    }
    // What the Runtime measured, and what the episode already tried. The
    // reading is the fact that lets the local backend answer differently when
    // the game is not advancing; the decisions are what make that answer a
    // different one rather than the same one again.
    evidence.push(`progress: ${progressState(request.progress)}`);
    const recentActions = recentActionsState(request.history);
    if (recentActions.length > 0) {
      evidence.push(`recentActions: ${recentActions}`);
    }
    const stateText = evidence.join("\n");
    if (stateText.length > MAX_STATE_TEXT_LENGTH) {
      throw new OneJevLocalPolicyError(
        ONEJEV_INVALID_REQUEST_CODE,
        "The bounded OneJev evidence text exceeded the server's own limit."
      );
    }
    return {
      model: UPSTREAM_MODEL_ID,
      state: {
        text: stateText,
        images: [{ path: framePath }]
      },
      questions: {
        [ACTION_QUESTION_ID]: {
          type: "choice",
          instructions: actionQuestionInstructions(),
          criteria: distinctCriteria(candidates)
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
        // eslint-disable-next-line no-await-in-loop -- each attempt waits for the one before it: a retry must not race the request it is replacing
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
        // eslint-disable-next-line no-await-in-loop -- the body is drained before the next attempt, so the connection is not reused while it is still open
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      if (!response.ok) {
        throw new OneJevLocalPolicyError(
          "onejev-http-error",
          `The local OneJev server rejected the decision with status ${String(response.status)}.`
        );
      }
      // eslint-disable-next-line no-await-in-loop -- the answer is read from the response that this attempt got, not from any other
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
        ONEJEV_PROTOCOL_ERROR_CODE,
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
        ONEJEV_PROTOCOL_ERROR_CODE,
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
        ONEJEV_PROTOCOL_ERROR_CODE,
        "The OneJev server returned an unsupported response body."
      );
    }
    if (typeof body.model !== "string" || body.model.trim().length === 0) {
      throw new OneJevLocalPolicyError(
        ONEJEV_PROTOCOL_ERROR_CODE,
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
        ONEJEV_PROTOCOL_ERROR_CODE,
        "The OneJev response did not report a calibrated confidence."
      );
    }
    // The upstream reports whether it stood behind its own winner. An answer
    // that leaves the question open is not an answer the Runtime may act on,
    // and an answer that does not say whether it stood behind it is not an
    // answer the Runtime may read as a commitment either.
    const abstained = answer.abstained;
    if (typeof abstained !== "boolean") {
      throw new OneJevLocalPolicyError(
        ONEJEV_PROTOCOL_ERROR_CODE,
        "The OneJev response did not report whether it abstained."
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
      confidence,
      abstained
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
      default: {
        // Every action kind is a case above, so this is unreachable with the
        // kinds this policy knows. It is here because a policy that grows a
        // kind must refuse the action it does not implement rather than fall
        // out of the function with nothing to return.
        return this.rejectGrounding(
          "OneJev selected an action kind this policy does not implement."
        );
      }
    }
  }

  private rejectGrounding(message: string): never {
    this.groundingRejections += 1;
    throw new OneJevLocalPolicyError("onejev-action-not-grounded", message);
  }

  /**
   * The decision that ends the episode.
   *
   * A stop is not a blank: when the upstream answered and then declined to
   * commit, the model it named and the confidence it reported are part of
   * what the episode ended on, and they are recorded.
   */
  private stopDecision(
    reasonCode: string,
    modelId: string | null = null,
    confidence: number | null = null
  ): PlaytestVisualDecision {
    return {
      status: "stop",
      selfReport: null,
      action: null,
      stopReason: reasonCode,
      intention: null,
      predictedVisibleEffect: null,
      reasonCode: stableReasonCode(reasonCode),
      backendId: this.backendId,
      modelId,
      modelRevision: null,
      fallback: false,
      fallbackReason: null,
      confidence,
      capabilities: oneJevCapabilities(confidence),
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
