import { assertPlaytestCapabilityAdvertisement } from "./protocol.ts";
import type {
  GameCaptureEvent,
  PlaytestArtifactReference,
  PlaytestJsonValue
} from "./protocol-types.ts";
import type { PlaytestAdapterMethod } from "./types.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const GAME_METHOD = {
  capabilities: "game.capabilities",
  reset: "game.reset",
  observe: "game.observe",
  legalActions: "game.legalActions",
  step: "game.step",
  outcome: "game.outcome",
  invariants: "game.invariants",
  snapshot: "game.snapshot",
  replay: "game.replay",
  fork: "game.fork",
  captureEvents: "game.captureEvents",
  captureFrame: "game.captureFrame",
  cancel: "game.cancel"
} as const;
const REVISION_BOUND_METHODS: ReadonlySet<PlaytestAdapterMethod> = new Set([
  GAME_METHOD.observe,
  GAME_METHOD.legalActions,
  GAME_METHOD.step,
  GAME_METHOD.outcome,
  GAME_METHOD.invariants,
  GAME_METHOD.snapshot,
  GAME_METHOD.captureEvents,
  GAME_METHOD.captureFrame
]);
const CAPTURE_RANGE_METHODS: ReadonlySet<PlaytestAdapterMethod> = new Set([
  GAME_METHOD.captureEvents,
  GAME_METHOD.captureFrame
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  field: string
): void {
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(field + " contains an unsupported field.");
  }
}

function objectWithKeys(
  value: unknown,
  keys: readonly string[],
  field: string
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(field + " must be an object.");
  exactKeys(value, keys, field);
  return value;
}

function nonEmptyString(
  value: unknown,
  field: string
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(field + " must be a non-empty string.");
  }
}

function nonNegativeInteger(
  value: unknown,
  field: string
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(field + " must be a non-negative integer.");
  }
}

function stringArray(
  value: unknown,
  field: string
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new TypeError(field + " must be an array of non-empty strings.");
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(field + " entries must be unique.");
  }
}

function assertRevisionParams(
  params: unknown,
  extraKeys: readonly string[],
  field: string
): Readonly<Record<string, unknown>> {
  const fields = ["episodeId", "expectedRevision", ...extraKeys];
  const value = objectWithKeys(params, fields, field);
  nonEmptyString(value.episodeId, field + ".episodeId");
  nonNegativeInteger(value.expectedRevision, field + ".expectedRevision");
  return value;
}

function assertArtifactReference(
  value: unknown,
  field: string
): asserts value is PlaytestArtifactReference {
  const ref = objectWithKeys(
    value,
    ["artifactId", "sha256", "bytes", "mediaType", "revision"],
    field
  );
  nonEmptyString(ref.artifactId, field + ".artifactId");
  if (typeof ref.sha256 !== "string" || !SHA256_PATTERN.test(ref.sha256)) {
    throw new TypeError(field + ".sha256 must be a SHA-256 digest.");
  }
  nonNegativeInteger(ref.bytes, field + ".bytes");
  nonEmptyString(ref.mediaType, field + ".mediaType");
  if (ref.revision !== undefined)
    nonNegativeInteger(ref.revision, field + ".revision");
}

function assertGameEvent(
  value: unknown,
  field: string
): asserts value is GameCaptureEvent {
  const event = objectWithKeys(
    value,
    ["eventId", "type", "phaseId", "step", "revision", "actor", "fields"],
    field
  );
  nonEmptyString(event.eventId, field + ".eventId");
  nonEmptyString(event.type, field + ".type");
  if (event.phaseId !== null) nonEmptyString(event.phaseId, field + ".phaseId");
  nonNegativeInteger(event.step, field + ".step");
  nonNegativeInteger(event.revision, field + ".revision");
  if (event.actor !== null) nonEmptyString(event.actor, field + ".actor");
  if (!isRecord(event.fields))
    throw new TypeError(field + ".fields must be an object.");
}

/** Validate method-specific outbound params beyond the generic JSON-RPC envelope. */
export function assertPlaytestAdapterParams(
  method: PlaytestAdapterMethod,
  params: Readonly<Record<string, unknown>>
): void {
  if (REVISION_BOUND_METHODS.has(method)) {
    const extraKeys =
      method === GAME_METHOD.step
        ? ["actionId"]
        : CAPTURE_RANGE_METHODS.has(method)
          ? ["startStep", "endStep"]
          : [];
    const value = assertRevisionParams(params, extraKeys, method);
    if (method === GAME_METHOD.step) {
      nonEmptyString(value.actionId, "game.step.actionId");
    }
    if (CAPTURE_RANGE_METHODS.has(method)) {
      nonNegativeInteger(value.startStep, method + ".startStep");
      nonNegativeInteger(value.endStep, method + ".endStep");
      if ((value.endStep as number) < (value.startStep as number)) {
        throw new TypeError(method + " range must be ordered.");
      }
    }
    return;
  }
  switch (method) {
    case GAME_METHOD.capabilities: {
      const value = objectWithKeys(params, ["protocolVersion"], method);
      if (value.protocolVersion !== 1) {
        throw new TypeError("game.capabilities requires protocolVersion 1.");
      }
      return;
    }
    case GAME_METHOD.reset: {
      const value = objectWithKeys(
        params,
        ["seed", "scenarioId", "approvedVariantHash"],
        method
      );
      nonEmptyString(value.seed, "game.reset.seed");
      nonEmptyString(value.scenarioId, "game.reset.scenarioId");
      nonEmptyString(
        value.approvedVariantHash,
        "game.reset.approvedVariantHash"
      );
      return;
    }
    case GAME_METHOD.replay: {
      const value = objectWithKeys(
        params,
        ["trace", "expectedBuildSha"],
        method
      );
      assertArtifactReference(value.trace, "game.replay.trace");
      nonEmptyString(value.expectedBuildSha, "game.replay.expectedBuildSha");
      return;
    }
    case GAME_METHOD.fork: {
      const value = objectWithKeys(
        params,
        ["snapshot", "alternativeActionId", "rngPolicy", "rngPolicyVersion"],
        method
      );
      assertArtifactReference(value.snapshot, "game.fork.snapshot");
      nonEmptyString(
        value.alternativeActionId,
        "game.fork.alternativeActionId"
      );
      if (
        value.rngPolicy !== "same-stream" &&
        value.rngPolicy !== "independent-stream" &&
        value.rngPolicy !== "declared-policy"
      ) {
        throw new TypeError("game.fork.rngPolicy is unsupported.");
      }
      nonEmptyString(value.rngPolicyVersion, "game.fork.rngPolicyVersion");
      return;
    }
    case GAME_METHOD.cancel: {
      const value = objectWithKeys(params, ["requestId"], method);
      nonEmptyString(value.requestId, "game.cancel.requestId");
      return;
    }
    default: {
      throw new TypeError("Unsupported adapter method params: " + method);
    }
  }
}

function assertResetResult(result: unknown): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "rngProvenance"],
    GAME_METHOD.reset
  );
  nonEmptyString(value.episodeId, "game.reset.episodeId");
  nonNegativeInteger(value.revision, "game.reset.revision");
  assertRngProvenance(value.rngProvenance, "game.reset.rngProvenance");
}

function assertRngProvenance(value: unknown, field: string): void {
  const rng = objectWithKeys(
    value,
    ["algorithm", "version", "initialStateHash", "reproducible"],
    field
  );
  nonEmptyString(rng.algorithm, field + ".algorithm");
  nonEmptyString(rng.version, field + ".version");
  if (
    rng.initialStateHash !== null &&
    (typeof rng.initialStateHash !== "string" ||
      !SHA256_PATTERN.test(rng.initialStateHash))
  ) {
    throw new TypeError(field + ".initialStateHash must be SHA-256 or null.");
  }
  if (typeof rng.reproducible !== "boolean")
    throw new TypeError(field + ".reproducible must be a boolean.");
}

function assertObserveResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "observation", "turnContext", "frame"],
    GAME_METHOD.observe
  );
  assertEpisodeRevision(value, params, GAME_METHOD.observe);
  if (
    !isJsonValue(value.observation) ||
    (value.turnContext !== null && !isJsonValue(value.turnContext))
  ) {
    throw new TypeError(
      "game.observe observation and turnContext must be JSON data."
    );
  }
  if (value.frame !== null)
    assertArtifactReference(value.frame, "game.observe.frame");
}

function assertLegalActionsResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "actions"],
    GAME_METHOD.legalActions
  );
  assertEpisodeRevision(value, params, GAME_METHOD.legalActions);
  if (!Array.isArray(value.actions))
    throw new TypeError("game.legalActions actions must be an array.");
  const ids = new Set<string>();
  for (const action of value.actions) {
    const item = objectWithKeys(
      action,
      ["actionId", "description", "features"],
      "game.legalActions action"
    );
    nonEmptyString(item.actionId, "game.legalActions.actionId");
    if (ids.has(item.actionId))
      throw new TypeError("game.legalActions action ids must be unique.");
    ids.add(item.actionId);
    if (
      item.description !== undefined &&
      typeof item.description !== "string"
    ) {
      throw new TypeError(
        "game.legalActions action description must be a string."
      );
    }
    if (item.features !== undefined && !isRecord(item.features)) {
      throw new TypeError(
        "game.legalActions action features must be an object."
      );
    }
  }
}

function assertStepResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "acceptedActionId", "eventIds", "terminal"],
    GAME_METHOD.step
  );
  assertEpisodeId(value, params, GAME_METHOD.step);
  nonNegativeInteger(value.revision, "game.step.revision");
  if (value.revision <= (params.expectedRevision as number)) {
    throw new TypeError(
      "game.step result revision must advance past expectedRevision."
    );
  }
  if (value.acceptedActionId !== params.actionId) {
    throw new TypeError(
      "game.step acceptedActionId must equal the requested legal action."
    );
  }
  stringArray(value.eventIds, "game.step.eventIds");
  if (typeof value.terminal !== "boolean")
    throw new TypeError("game.step terminal must be a boolean.");
}

function assertOutcomeResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "state", "outcome", "metrics", "missingReasons"],
    GAME_METHOD.outcome
  );
  assertEpisodeRevision(value, params, GAME_METHOD.outcome);
  if (value.state !== "terminal" && value.state !== "partial") {
    throw new TypeError("game.outcome state must be terminal or partial.");
  }
  if (value.outcome !== null && !isJsonValue(value.outcome)) {
    throw new TypeError("game.outcome outcome must be JSON data or null.");
  }
  if (
    !isRecord(value.metrics) ||
    Object.values(value.metrics).some(
      (metric) =>
        metric !== null &&
        (typeof metric !== "number" || !Number.isFinite(metric))
    )
  ) {
    throw new TypeError("game.outcome metrics must be finite numbers or null.");
  }
  stringArray(value.missingReasons, "game.outcome.missingReasons");
}

function assertInvariantsResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "witnesses"],
    GAME_METHOD.invariants
  );
  assertEpisodeRevision(value, params, GAME_METHOD.invariants);
  if (!Array.isArray(value.witnesses))
    throw new TypeError("game.invariants witnesses must be an array.");
  const ids = new Set<string>();
  for (const witness of value.witnesses) {
    const item = objectWithKeys(
      witness,
      ["invariantId", "result", "witness", "diagnostic"],
      "game.invariants witness"
    );
    nonEmptyString(item.invariantId, "game.invariants.invariantId");
    if (ids.has(item.invariantId))
      throw new TypeError("game.invariants invariant IDs must be unique.");
    ids.add(item.invariantId);
    if (
      item.result !== "passed" &&
      item.result !== "failed" &&
      item.result !== "not-observed"
    ) {
      throw new TypeError("game.invariants result is invalid.");
    }
    if (item.witness !== null && !isJsonValue(item.witness))
      throw new TypeError("Invariant witness must be JSON data or null.");
    if (item.diagnostic !== null && typeof item.diagnostic !== "string")
      throw new TypeError("Invariant diagnostic must be a string or null.");
  }
}

function assertSnapshotResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "snapshot", "integrityHash"],
    GAME_METHOD.snapshot
  );
  assertEpisodeRevision(value, params, GAME_METHOD.snapshot);
  assertArtifactReference(value.snapshot, "game.snapshot.snapshot");
  if (
    typeof value.integrityHash !== "string" ||
    !SHA256_PATTERN.test(value.integrityHash)
  ) {
    throw new TypeError("game.snapshot integrityHash must be SHA-256.");
  }
}

function assertReplayResult(result: unknown): void {
  const value = objectWithKeys(
    result,
    [
      "episodeId",
      "revision",
      "replayStatus",
      "transitionHash",
      "firstDivergentStep",
      "diagnostics"
    ],
    GAME_METHOD.replay
  );
  nonEmptyString(value.episodeId, "game.replay.episodeId");
  nonNegativeInteger(value.revision, "game.replay.revision");
  if (
    value.replayStatus !== "verified" &&
    value.replayStatus !== "diverged" &&
    value.replayStatus !== "unavailable"
  ) {
    throw new TypeError("game.replay replayStatus is invalid.");
  }
  if (
    value.transitionHash !== null &&
    (typeof value.transitionHash !== "string" ||
      !SHA256_PATTERN.test(value.transitionHash))
  ) {
    throw new TypeError("game.replay transitionHash must be SHA-256 or null.");
  }
  if (value.firstDivergentStep !== null)
    nonNegativeInteger(
      value.firstDivergentStep,
      "game.replay.firstDivergentStep"
    );
  stringArray(value.diagnostics, "game.replay.diagnostics");
}

function assertForkResult(result: unknown): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "initialStateHash", "rngProvenance"],
    GAME_METHOD.fork
  );
  nonEmptyString(value.episodeId, "game.fork.episodeId");
  nonNegativeInteger(value.revision, "game.fork.revision");
  if (
    typeof value.initialStateHash !== "string" ||
    !SHA256_PATTERN.test(value.initialStateHash)
  ) {
    throw new TypeError("game.fork initialStateHash must be SHA-256.");
  }
  assertRngProvenance(value.rngProvenance, "game.fork.rngProvenance");
}

function assertCaptureEventsResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "events", "omittedCount"],
    GAME_METHOD.captureEvents
  );
  assertEpisodeRevision(value, params, GAME_METHOD.captureEvents);
  if (!Array.isArray(value.events))
    throw new TypeError("game.captureEvents events must be an array.");
  nonNegativeInteger(value.omittedCount, "game.captureEvents.omittedCount");
  for (const event of value.events)
    assertGameEvent(event, "game.captureEvents event");
}

function assertCaptureFrameResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["episodeId", "revision", "step", "capturedAt", "artifact"],
    GAME_METHOD.captureFrame
  );
  assertEpisodeRevision(value, params, GAME_METHOD.captureFrame);
  nonNegativeInteger(value.step, "game.captureFrame.step");
  nonEmptyString(value.capturedAt, "game.captureFrame.capturedAt");
  assertArtifactReference(value.artifact, "game.captureFrame.artifact");
}

function assertCancelResult(
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  const value = objectWithKeys(
    result,
    ["requestId", "acknowledged", "episodeDisposition"],
    GAME_METHOD.cancel
  );
  if (value.requestId !== params.requestId)
    throw new TypeError(
      "game.cancel result requestId must match the canceled request."
    );
  if (typeof value.acknowledged !== "boolean")
    throw new TypeError("game.cancel acknowledged must be a boolean.");
  if (
    value.episodeDisposition !== "unchanged" &&
    value.episodeDisposition !== "aborted" &&
    value.episodeDisposition !== "unknown"
  ) {
    throw new TypeError("game.cancel episodeDisposition is invalid.");
  }
}

/** Validate a successful result against its method request. */
export function assertPlaytestAdapterResult(
  method: PlaytestAdapterMethod,
  params: Readonly<Record<string, unknown>>,
  result: unknown
): void {
  switch (method) {
    case GAME_METHOD.capabilities: {
      assertPlaytestCapabilityAdvertisement(result);
      return;
    }
    case GAME_METHOD.reset: {
      assertResetResult(result);
      return;
    }
    case GAME_METHOD.observe: {
      assertObserveResult(params, result);
      return;
    }
    case GAME_METHOD.legalActions: {
      assertLegalActionsResult(params, result);
      return;
    }
    case GAME_METHOD.step: {
      assertStepResult(params, result);
      return;
    }
    case GAME_METHOD.outcome: {
      assertOutcomeResult(params, result);
      return;
    }
    case GAME_METHOD.invariants: {
      assertInvariantsResult(params, result);
      return;
    }
    case GAME_METHOD.snapshot: {
      assertSnapshotResult(params, result);
      return;
    }
    case GAME_METHOD.replay: {
      assertReplayResult(result);
      return;
    }
    case GAME_METHOD.fork: {
      assertForkResult(result);
      return;
    }
    case GAME_METHOD.captureEvents: {
      assertCaptureEventsResult(params, result);
      return;
    }
    case GAME_METHOD.captureFrame: {
      assertCaptureFrameResult(params, result);
      return;
    }
    case GAME_METHOD.cancel: {
      assertCancelResult(params, result);
      return;
    }
    default: {
      const exhaustive: never = method;
      throw new TypeError(
        "Unsupported adapter method result: " + String(exhaustive)
      );
    }
  }
}

function assertEpisodeId(
  result: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
  method: string
): void {
  nonEmptyString(result.episodeId, method + ".result.episodeId");
  if (result.episodeId !== params.episodeId)
    throw new TypeError(
      method + " result episodeId does not match the request."
    );
}

function assertEpisodeRevision(
  result: Readonly<Record<string, unknown>>,
  params: Readonly<Record<string, unknown>>,
  method: string
): void {
  assertEpisodeId(result, params, method);
  nonNegativeInteger(result.revision, method + ".result.revision");
  if (result.revision !== params.expectedRevision) {
    throw new TypeError(
      method + " result revision does not match expectedRevision."
    );
  }
}

function isJsonValue(value: unknown, depth = 0): value is PlaytestJsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => isJsonValue(entry, depth + 1));
}
