/** Core-owned, versioned player-authored report contracts. */
export const PLAYTEST_PLAYER_DEBRIEF_SCHEMA =
  "autodev-playtest-player-debrief-v1" as const;
export const PLAYTEST_PLAYER_FOCUS_INTERPRETATION_SCHEMA =
  "autodev-playtest-focus-interpretation-v1" as const;
export const PLAYTEST_PLAYER_CHECKPOINT_SCHEMA =
  "autodev-playtest-player-checkpoint-v1" as const;
export const PLAYTEST_PLAYER_DEBRIEF_NOT_APPLICABLE_STATUS =
  "not-applicable" as const;

export const PLAYTEST_PLAYER_DEBRIEF_STATUSES = [
  "absent",
  "pending",
  "complete",
  "partial",
  PLAYTEST_PLAYER_DEBRIEF_NOT_APPLICABLE_STATUS,
  "unavailable"
] as const;
export type PlaytestPlayerDebriefStatus =
  (typeof PLAYTEST_PLAYER_DEBRIEF_STATUSES)[number];

export const PLAYTEST_PLAYER_DEBRIEF_AUTHOR_ROLES = [
  "player",
  "supervising-director"
] as const;
export type PlaytestPlayerDebriefAuthorRole =
  (typeof PLAYTEST_PLAYER_DEBRIEF_AUTHOR_ROLES)[number];

export const PLAYTEST_PLAYER_FOCUS_OUTCOMES = [
  "achieved",
  "partial",
  "blocked",
  "unattempted",
  "unknown"
] as const;
export type PlaytestPlayerFocusOutcome =
  (typeof PLAYTEST_PLAYER_FOCUS_OUTCOMES)[number];

export const PLAYTEST_PLAYER_DEBRIEF_ABSENT_REASONS = [
  "legacy-no-report"
] as const;
export type PlaytestPlayerDebriefAbsentReason =
  (typeof PLAYTEST_PLAYER_DEBRIEF_ABSENT_REASONS)[number];

export const PLAYTEST_PLAYER_DEBRIEF_PENDING_REASONS = [
  "episode-in-progress"
] as const;
export type PlaytestPlayerDebriefPendingReason =
  (typeof PLAYTEST_PLAYER_DEBRIEF_PENDING_REASONS)[number];

export const PLAYTEST_PLAYER_DEBRIEF_UNAVAILABLE_REASONS = [
  "player-report-not-authored",
  "model-response-invalid",
  "interrupted-before-checkpoint"
] as const;
export type PlaytestPlayerDebriefUnavailableReason =
  (typeof PLAYTEST_PLAYER_DEBRIEF_UNAVAILABLE_REASONS)[number];

export const PLAYTEST_PLAYER_DEBRIEF_PARTIAL_REASONS = [
  "checkpoint-only",
  "episode-interrupted",
  "budget-truncated",
  "action-refused"
] as const;
export type PlaytestPlayerDebriefPartialReason =
  (typeof PLAYTEST_PLAYER_DEBRIEF_PARTIAL_REASONS)[number];

/** Exact frame locator supporting one self-reported claim. */
export interface PlaytestPlayerEvidenceReference {
  readonly kind: "frame";
  readonly id: string;
  readonly step: number;
  readonly frameIndex: number;
}

/** Smart-direct's interpretation of operator-requested prose, not game truth. */
export interface PlaytestPlayerFocusInterpretationV1 {
  readonly schema: typeof PLAYTEST_PLAYER_FOCUS_INTERPRETATION_SCHEMA;
  /** Exact operator text frozen into the run, or null when no focus was requested. */
  readonly requestedFocus: string | null;
  readonly objective: string | null;
  readonly inScope: readonly string[];
  readonly forbiddenScope: readonly string[];
  readonly stopCriteria: readonly string[];
  /** A model self-report; never a verified game outcome. */
  readonly outcome: PlaytestPlayerFocusOutcome;
  readonly assessmentSource: "smart-direct-self-report";
  readonly evidence: readonly PlaytestPlayerEvidenceReference[];
}

export interface PlaytestPlayerDebriefSource {
  readonly authorRole: PlaytestPlayerDebriefAuthorRole;
  readonly policyId: "smart-direct";
  readonly policyVersion: string;
  readonly modelId: string;
  /** Null when the router does not report a separately pinned model revision. */
  readonly modelVersion: string | null;
}

/** One bounded pre-action checkpoint retained when a run is interrupted. */
export interface PlaytestPlayerCheckpointV1 {
  readonly schema: typeof PLAYTEST_PLAYER_CHECKPOINT_SCHEMA;
  readonly intention: string;
  readonly predictedVisibleEffect: string;
  readonly evidence: PlaytestPlayerEvidenceReference;
}

export type PlaytestPlayerDebriefV1 =
  | {
      readonly schema: typeof PLAYTEST_PLAYER_DEBRIEF_SCHEMA;
      readonly status: "absent";
      readonly reason: PlaytestPlayerDebriefAbsentReason;
    }
  | {
      readonly schema: typeof PLAYTEST_PLAYER_DEBRIEF_SCHEMA;
      readonly status: "pending";
      readonly reason: PlaytestPlayerDebriefPendingReason;
    }
  | {
      readonly schema: typeof PLAYTEST_PLAYER_DEBRIEF_SCHEMA;
      readonly status: typeof PLAYTEST_PLAYER_DEBRIEF_NOT_APPLICABLE_STATUS;
      readonly reason: "non-reflective-policy";
    }
  | {
      readonly schema: typeof PLAYTEST_PLAYER_DEBRIEF_SCHEMA;
      readonly status: "unavailable";
      readonly reason: PlaytestPlayerDebriefUnavailableReason;
    }
  | {
      readonly schema: typeof PLAYTEST_PLAYER_DEBRIEF_SCHEMA;
      readonly status: "partial";
      readonly reason: PlaytestPlayerDebriefPartialReason;
      readonly source: PlaytestPlayerDebriefSource;
      readonly checkpoint: PlaytestPlayerCheckpointV1;
    }
  | {
      readonly schema: typeof PLAYTEST_PLAYER_DEBRIEF_SCHEMA;
      readonly status: "complete";
      readonly source: PlaytestPlayerDebriefSource;
      readonly focusInterpretation: PlaytestPlayerFocusInterpretationV1;
      readonly summary: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  );
}

function assertTextList(
  value: unknown,
  label: string
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 3 ||
    !value.every((item) => isBoundedText(item, 64))
  ) {
    throw new TypeError(`Player debrief ${label} is invalid.`);
  }
}

function assertEvidenceReference(
  value: unknown
): asserts value is PlaytestPlayerEvidenceReference {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["kind", "id", "step", "frameIndex"]) ||
    value.kind !== "frame" ||
    !isBoundedText(value.id, 256) ||
    !Number.isSafeInteger(value.step) ||
    typeof value.step !== "number" ||
    value.step < 0 ||
    !Number.isSafeInteger(value.frameIndex) ||
    typeof value.frameIndex !== "number" ||
    value.frameIndex < 0
  ) {
    throw new TypeError("Player debrief evidence reference is invalid.");
  }
}

function assertSource(
  value: unknown
): asserts value is PlaytestPlayerDebriefSource {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "authorRole",
      "policyId",
      "policyVersion",
      "modelId",
      "modelVersion"
    ]) ||
    !(PLAYTEST_PLAYER_DEBRIEF_AUTHOR_ROLES as readonly unknown[]).includes(
      value.authorRole
    ) ||
    value.policyId !== "smart-direct" ||
    !isBoundedText(value.policyVersion, 128) ||
    !isBoundedText(value.modelId, 256) ||
    (value.modelVersion !== null && !isBoundedText(value.modelVersion, 256))
  ) {
    throw new TypeError("Player debrief source is invalid.");
  }
}

export function assertPlaytestPlayerFocusInterpretation(
  value: unknown
): asserts value is PlaytestPlayerFocusInterpretationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema",
      "requestedFocus",
      "objective",
      "inScope",
      "forbiddenScope",
      "stopCriteria",
      "outcome",
      "assessmentSource",
      "evidence"
    ]) ||
    value.schema !== PLAYTEST_PLAYER_FOCUS_INTERPRETATION_SCHEMA ||
    (value.requestedFocus !== null &&
      !isBoundedText(value.requestedFocus, 2000)) ||
    (value.objective !== null && !isBoundedText(value.objective, 200)) ||
    !(PLAYTEST_PLAYER_FOCUS_OUTCOMES as readonly unknown[]).includes(
      value.outcome
    ) ||
    value.assessmentSource !== "smart-direct-self-report" ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 3
  ) {
    throw new TypeError("Player focus interpretation is invalid.");
  }
  const inScope = value.inScope;
  const forbiddenScope = value.forbiddenScope;
  const stopCriteria = value.stopCriteria;
  assertTextList(inScope, "in-scope items");
  assertTextList(forbiddenScope, "forbidden-scope items");
  assertTextList(stopCriteria, "stop criteria");
  value.evidence.forEach(assertEvidenceReference);
  if (
    value.requestedFocus === null &&
    (value.objective !== null ||
      inScope.length > 0 ||
      forbiddenScope.length > 0 ||
      stopCriteria.length > 0 ||
      value.outcome !== "unattempted")
  ) {
    throw new TypeError(
      "A player focus interpretation without operator focus must remain unattempted."
    );
  }
  if (value.evidence.length === 0) {
    throw new TypeError(
      "A complete player focus interpretation requires resolvable player-visible evidence."
    );
  }
}

function assertCheckpoint(
  value: unknown
): asserts value is PlaytestPlayerCheckpointV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schema",
      "intention",
      "predictedVisibleEffect",
      "evidence"
    ]) ||
    value.schema !== PLAYTEST_PLAYER_CHECKPOINT_SCHEMA ||
    !isBoundedText(value.intention, 512) ||
    !isBoundedText(value.predictedVisibleEffect, 512)
  ) {
    throw new TypeError("Player debrief checkpoint is invalid.");
  }
  assertEvidenceReference(value.evidence);
}

function assertStatusReason(
  value: Record<string, unknown>,
  status: string,
  reasons: readonly string[],
  label: string
): void {
  if (
    !hasExactKeys(value, ["schema", "status", "reason"]) ||
    value.status !== status ||
    !reasons.includes(String(value.reason))
  ) {
    throw new TypeError(`${label} player debrief is invalid.`);
  }
}

function assertPartialDebrief(
  value: Record<string, unknown>
): asserts value is Extract<
  PlaytestPlayerDebriefV1,
  { readonly status: "partial" }
> {
  if (
    !hasExactKeys(value, [
      "schema",
      "status",
      "reason",
      "source",
      "checkpoint"
    ]) ||
    value.status !== "partial" ||
    !(PLAYTEST_PLAYER_DEBRIEF_PARTIAL_REASONS as readonly unknown[]).includes(
      value.reason
    )
  ) {
    throw new TypeError("Partial player debrief is invalid.");
  }
  assertSource(value.source);
  assertCheckpoint(value.checkpoint);
}

function assertCompleteDebrief(
  value: Record<string, unknown>
): asserts value is Extract<
  PlaytestPlayerDebriefV1,
  { readonly status: "complete" }
> {
  if (
    !hasExactKeys(value, [
      "schema",
      "status",
      "source",
      "focusInterpretation",
      "summary"
    ]) ||
    value.status !== "complete" ||
    !isBoundedText(value.summary, 200)
  ) {
    throw new TypeError("Complete player debrief is invalid.");
  }
  assertSource(value.source);
  assertPlaytestPlayerFocusInterpretation(value.focusInterpretation);
}

/** Strict validator for persisted and API-facing player report payloads. */
export function assertPlaytestPlayerDebrief(
  value: unknown
): asserts value is PlaytestPlayerDebriefV1 {
  if (
    !isRecord(value) ||
    value.schema !== PLAYTEST_PLAYER_DEBRIEF_SCHEMA ||
    typeof value.status !== "string"
  ) {
    throw new TypeError("Player debrief envelope is invalid.");
  }
  switch (value.status) {
    case "absent": {
      assertStatusReason(
        value,
        "absent",
        PLAYTEST_PLAYER_DEBRIEF_ABSENT_REASONS,
        "Absent"
      );
      return;
    }
    case "pending": {
      assertStatusReason(
        value,
        "pending",
        PLAYTEST_PLAYER_DEBRIEF_PENDING_REASONS,
        "Pending"
      );
      return;
    }
    case PLAYTEST_PLAYER_DEBRIEF_NOT_APPLICABLE_STATUS: {
      assertStatusReason(
        value,
        PLAYTEST_PLAYER_DEBRIEF_NOT_APPLICABLE_STATUS,
        ["non-reflective-policy"],
        "Not-applicable"
      );
      return;
    }
    case "unavailable": {
      assertStatusReason(
        value,
        "unavailable",
        PLAYTEST_PLAYER_DEBRIEF_UNAVAILABLE_REASONS,
        "Unavailable"
      );
      return;
    }
    case "partial": {
      assertPartialDebrief(value);
      return;
    }
    case "complete": {
      assertCompleteDebrief(value);
      return;
    }
    default: {
      throw new TypeError("Player debrief status is unsupported.");
    }
  }
}

/** Enforce report-author/mode provenance and resolve refs against stored frames. */
export function assertPlaytestPlayerDebriefForEpisode(input: {
  readonly executionMode: string;
  readonly policyId: string;
  readonly episodeStatus: string;
  readonly playerDebrief: PlaytestPlayerDebriefV1;
  readonly frames: readonly {
    readonly id: string;
    readonly kind: string;
    readonly step?: number;
    readonly frameIndex?: number;
  }[];
}): void {
  assertPlaytestPlayerDebrief(input.playerDebrief);
  assertDebriefStatusMatchesEpisode(
    input.playerDebrief,
    input.executionMode,
    input.episodeStatus,
    input.policyId
  );
  const evidence = playerDebriefEvidence(input.playerDebrief);
  for (const reference of evidence) {
    assertStoredPlayerFrame(reference, input.frames);
  }
}

function assertDebriefStatusMatchesEpisode(
  report: PlaytestPlayerDebriefV1,
  executionMode: string,
  episodeStatus: string,
  policyId: string
): void {
  switch (report.status) {
    case "absent": {
      return;
    }
    case PLAYTEST_PLAYER_DEBRIEF_NOT_APPLICABLE_STATUS: {
      if (
        executionMode !== "adapter-accelerated" &&
        executionMode !== "scripted-regression"
      ) {
        throw new TypeError(
          "Player debrief not-applicable status requires a non-reflective policy."
        );
      }
      return;
    }
    case "pending": {
      if (
        executionMode !== "autonomous-visual" ||
        policyId !== "smart-direct" ||
        (episodeStatus !== "assigned" && episodeStatus !== "started")
      ) {
        throw new TypeError(
          "Pending player debrief status requires an active Smart-direct visual episode."
        );
      }
      return;
    }
    case "unavailable": {
      if (
        executionMode !== "autonomous-visual" &&
        executionMode !== "legacy-unknown"
      ) {
        throw new TypeError(
          "Unavailable player debrief status requires a reflective or unknown episode."
        );
      }
      return;
    }
    case "partial":
    case "complete": {
      if (executionMode !== "autonomous-visual") {
        throw new TypeError(
          "Player-authored reports require an autonomous visual episode."
        );
      }
      if (report.source.policyId !== policyId) {
        throw new TypeError(
          "Player debrief policy identity does not match its episode."
        );
      }
      if (
        report.source.authorRole === "player" &&
        policyId !== "smart-direct"
      ) {
        throw new TypeError(
          "Player authorship requires the approved Smart-direct policy."
        );
      }
      if (
        report.status === "complete" &&
        (episodeStatus === "assigned" || episodeStatus === "started")
      ) {
        throw new TypeError(
          "A complete player debrief requires a terminal visual episode."
        );
      }
    }
  }
}

function playerDebriefEvidence(
  report: PlaytestPlayerDebriefV1
): readonly PlaytestPlayerEvidenceReference[] {
  if (report.status === "complete") return report.focusInterpretation.evidence;
  if (report.status === "partial") return [report.checkpoint.evidence];
  return [];
}

function assertStoredPlayerFrame(
  reference: PlaytestPlayerEvidenceReference,
  frames: readonly {
    readonly id: string;
    readonly kind: string;
    readonly step?: number;
    readonly frameIndex?: number;
  }[]
): void {
  const matchesFrame = frames.some(
    (frame) =>
      frame.id === reference.id &&
      frame.kind === reference.kind &&
      frame.step === reference.step &&
      frame.frameIndex === reference.frameIndex
  );
  if (!matchesFrame) {
    throw new TypeError(
      "Player debrief evidence reference does not resolve to a stored episode frame."
    );
  }
}
