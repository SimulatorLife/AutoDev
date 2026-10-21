/**
 * Game-neutral, read-only discovery evidence packets for autonomous-visual
 * episodes.
 *
 * A discovery packet is the only legal analyst input for a session that does
 * not have a rubric, a coverage plan or confirmed engine identity. It
 * preserves exactly what the player actually saw (visible observations,
 * selected/rejected actions, pre-action predictions, frame references and
 * missingness); it intentionally omits every scored/confirmatory field
 * (rubric hashes, metric definitions, coverage cells, cross-session numeric
 * aggregates, complete confirmatory episode comparisons). It is refused by
 * any scored/confirmatory path.
 *
 * The packet is content-addressed (sha256 over canonical JSON) and reuses
 * the same trace-step, window-selection, locator-index and supplied/omitted
 * artifact mechanics as the confirmatory packet so an analyst can cite
 * observations by {kind,id} across packet families.
 */
import {
  type PlaytestDiscoverySessionReview,
  type PlaytestEpisode,
  type PlaytestEvidenceOmittedArtifact,
  type PlaytestEvidenceSelectionReason,
  type PlaytestEvidenceSuppliedArtifact,
  type PlaytestEvidenceTraceEvent,
  type PlaytestEvidenceTraceStep,
  type PlaytestEvidenceWindow,
  type PlaytestGameOutcomeKind,
  type PlaytestOmittedEvidenceWindow,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_GAME_OUTCOMES,
  type PlaytestVisualEpisode
} from "./artifacts.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";
import {
  assertOmittedPacketArtifacts,
  assertPacketArtifactProvenance,
  assertPlaytestEvidenceLocatorsWithinPacket,
  assertTraceStep,
  assertUniqueSelectedEventIds,
  buildBoundedEvidenceWindows,
  EVIDENCE_SHA256_PATTERN,
  type EvidenceWindowLimits,
  isCount,
  isJson,
  isPlaytestEvidencePacketId,
  isRecord,
  isText,
  packetContentBytes,
  type PlaytestEvidencePacketArtifactView,
  type PlaytestEvidencePacketLocatorView,
  type PlaytestEvidencePacketOmittedArtifactView,
  resolveEvidenceWindowLimits,
  suppliedArtifactsFor
} from "./evidence-trace-selection.ts";
import { assertPlaytestVisualEpisode } from "./execution-provenance.ts";
import {
  isPlaytestVisualPolicyId,
  type PlaytestVisualPolicyId
} from "./visual-decision.ts";
import {
  assertPlaytestPlayerDebrief,
  type PlaytestPlayerDebriefV1
} from "./player-debrief.ts";
import { assertPlaytestEvidenceLocator } from "./protocol.ts";
import { sha256Hex } from "./sha256.ts";
import {
  type PlaytestEvidenceLocator,
  type PlaytestMissingReason,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V2,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V3,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EPISODE_STATES,
  PLAYTESTS_EPISODE_TERMINATION_REASONS,
  PLAYTESTS_GAME_MODES,
  PLAYTESTS_MISSING_REASONS,
  PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA,
  type PlaytestVisualAssignmentManifest
} from "./types.ts";

export const PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS = 32_768;
const MAX_SUMMARY_TEXT = 4096;
/**
 * Maximum length of a visible control's accessible name in the packet.
 *
 * A game puts a sentence into every control's accessible name, and the
 * player's visible state is the analyst's evidence. The name is capped so
 * that one game's verbose names cannot decide how many steps of a session
 * the analyst can read; a capped name ends in an ellipsis and the step
 * records how many names were capped.
 */
export const PLAYTESTS_DISCOVERY_CONTROL_NAME_MAX_LENGTH = 120;
/**
 * Maximum number of visible controls the packet carries for one step.
 *
 * The game decides how many controls it shows; the packet decides how many
 * it can carry. A step that shows more controls than this keeps the control
 * the player acted on plus the first controls in their recorded order, and
 * the step records how many controls it did not carry.
 */
export const PLAYTESTS_DISCOVERY_MAX_CONTROLS_PER_STEP = 32;
/**
 * Upper bound (in UTF-16 code units) for the operator-requested focus
 * context copied from the frozen visual assignment manifest. Mirrors the
 * manifest's own validation in batch-run.ts and Smart-direct's contract,
 * so a packet can never widen the focus budget the launch request allowed.
 */
export const PLAYTESTS_DISCOVERY_AREAS_OF_FOCUS_MAX_LENGTH = 2000;

export const PLAYTESTS_DISCOVERY_HYPOTHESIS_STATUSES = [
  "hypothesis",
  "not-observed"
] as const;

export type PlaytestDiscoveryHypothesisStatus =
  (typeof PLAYTESTS_DISCOVERY_HYPOTHESIS_STATUSES)[number];

export const PLAYTESTS_DISCOVERY_OMISSION_REASONS = [
  "missing",
  "expired",
  "invalid-reference",
  "unsupported-media",
  "redacted",
  "capture-budget-exhausted",
  "step-not-selected"
] as const;

export type PlaytestDiscoveryOmissionReason =
  (typeof PLAYTESTS_DISCOVERY_OMISSION_REASONS)[number];

export interface PlaytestDiscoveryObservationNote {
  readonly noteId: string;
  readonly step: number;
  readonly label: string;
  readonly detail: string;
}

/**
 * One visible affordance of a step.
 *
 * The note is the flat index of the visible affordances: a stable id for
 * citation and the control it points at. The control's name, role and
 * enabled state live in the step's visible observation, under the same
 * control id, and repeating them here would put the visible state of every
 * step into the packet a second time.
 */
export interface PlaytestDiscoveryAffordanceNote {
  readonly noteId: string;
  readonly step: number;
  readonly controlId: string;
}

export interface PlaytestDiscoveryActionReceipt {
  readonly receiptId: string;
  readonly step: number;
  readonly observationId: string;
  readonly status: "dispatched" | "refused";
  readonly refusalReason: string | null;
  readonly selectedActionId: string | null;
  readonly inputKind:
    "semantic-control" | "screenshot-coordinate" | "safe-key" | "no-input";
  readonly controlId: string | null;
  readonly safeKey: string | null;
  readonly coordinates: { readonly x: number; readonly y: number } | null;
  readonly intention: string;
  readonly predictedVisibleEffect: string;
  readonly visibleConsequence: unknown;
  readonly receivedAt: string;
}

export interface PlaytestDiscoveryEvidenceFrame {
  readonly frameId: string;
  readonly step: number;
  readonly frameIndex: number;
  readonly sha256: string;
  readonly capturedAt: string;
  readonly captureWidthPx: number;
  readonly captureHeightPx: number;
  readonly visibleStateRef: string | null;
  readonly reason: "captured" | "redacted" | "expired";
  readonly redactedSurfaces: readonly string[];
}

/**
 * One visible affordance, in the bounded form the packet carries.
 *
 * The control keeps its identity, its role, its enabled state and the
 * accessible name the player saw. The on-screen geometry is not carried:
 * the captured frame is the record of where the control was.
 */
export interface PlaytestDiscoveryVisibleControl {
  readonly controlId: string;
  readonly role: string;
  readonly name: string;
  readonly enabled: boolean;
}

/**
 * The player's visible state for one step, in bounded form.
 *
 * This is a projection of the recorded observation, never the recording
 * itself: the trace artifact stays the full record. The projection is
 * explicit about what it condensed -- how many controls the player saw,
 * how many the packet did not carry and how many names it capped -- so an
 * analyst never reads a bounded state as the whole screen.
 */
export interface PlaytestDiscoveryVisibleState {
  readonly capturedAt: string;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: number;
  } | null;
  readonly privacyState: "clear" | "redacted";
  readonly phase: string | null;
  readonly progress: unknown;
  readonly warnings: readonly string[];
  readonly controls: readonly PlaytestDiscoveryVisibleControl[];
  /** How many controls the player actually saw. */
  readonly observedControlCount: number;
  /** How many of those controls the packet did not carry. */
  readonly omittedControlCount: number;
  /** How many carried names the packet capped. */
  readonly truncatedNameCount: number;
}

export interface PlaytestDiscoveryStepEvidence {
  readonly step: number;
  readonly phaseId: string | null;
  readonly observationVisibility: "structured" | "visual-only";
  readonly visibleObservation: PlaytestDiscoveryVisibleState;
  readonly selectedActionId: string | null;
  readonly legalActionIds: readonly string[];
  readonly preActionPrediction: {
    readonly intention: string;
    readonly predictedVisibleEffect: string;
  } | null;
  readonly authoritativeOutcome: unknown;
  readonly actionReceipt: PlaytestDiscoveryActionReceipt | null;
  readonly observationNotes: readonly PlaytestDiscoveryObservationNote[];
  readonly frameIds: readonly string[];
}

/**
 * The v1/v2 step record: the recorded visible observation as it was, plus
 * the per-control affordance index. Historical packets keep this shape and
 * stay readable; a builder no longer emits it.
 */
export interface PlaytestDiscoveryStepEvidenceV2 {
  readonly step: number;
  readonly phaseId: string | null;
  readonly observationVisibility: "structured" | "visual-only";
  readonly visibleObservation: unknown;
  readonly selectedActionId: string | null;
  readonly legalActionIds: readonly string[];
  readonly preActionPrediction: {
    readonly intention: string;
    readonly predictedVisibleEffect: string;
  } | null;
  readonly authoritativeOutcome: unknown;
  readonly actionReceipt: PlaytestDiscoveryActionReceipt | null;
  readonly observationNotes: readonly PlaytestDiscoveryObservationNote[];
  readonly affordanceNotes: readonly PlaytestDiscoveryAffordanceNote[];
  readonly frameIds: readonly string[];
}

/**
 * One step inside a selected window.
 *
 * The step's evidence is carried once, in the packet's step evidence. A
 * window repeats only what the selection needs: which step it covers, which
 * events that step recorded and which frames it captured. Repeating the
 * observation as well would put every step's visible state into the packet
 * twice, and a session of a real game does not fit the analyst's packet
 * budget when it is counted twice.
 */
export interface PlaytestDiscoveryEvidenceWindowStep {
  readonly step: number;
  readonly phaseId: string | null;
  readonly events: readonly PlaytestEvidenceTraceEvent[];
  readonly frameRefs: readonly PlaytestEvidenceLocator[];
}

/** The selection record of one selected window of the source trace. */
export interface PlaytestDiscoveryEvidenceWindow {
  readonly startStep: number;
  readonly endStep: number;
  readonly selectionReasons: readonly PlaytestEvidenceSelectionReason[];
  readonly steps: readonly PlaytestDiscoveryEvidenceWindowStep[];
}

export interface PlaytestDiscoveryEvidenceSessionContext {
  readonly status: "visual-discovery-session-level";
  readonly reason: "visual-discovery-session-level";
  readonly batchId: string;
  readonly reviewSelection: {
    readonly status: "unavailable";
    readonly reason: "visual-discovery-session-level";
  };
}

export interface PlaytestDiscoveryEvidencePacketV1 {
  readonly schema: typeof PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA;
  readonly packetId: string;
  readonly packetHash: string;
  readonly analysisKind: "discovery";
  readonly workspaceId: string;
  readonly batchId: string;
  readonly episodeId: string;
  readonly episodeRevision: number;
  readonly assignmentId: string;
  /**
   * Operator-requested focus context copied verbatim from the frozen
   * autonomous-visual assignment manifest. This is author intent for what
   * the autonomous player should look at; it is NOT evidence that any
   * visual objective, hypothesis, or finding was actually achieved. The
   * packet never derives scored/confirmatory claims from it.
   */
  readonly areasOfFocus: string | null;
  readonly target: {
    readonly targetId: string;
    readonly targetApprovalId: string;
    readonly targetRevision: number;
    readonly targetOrigin: string;
  };
  readonly policy: {
    readonly policyId: PlaytestVisualPolicyId;
    readonly policyVersion: string;
    readonly cohortId: string | null;
  };
  readonly model: {
    readonly modelId: string | null;
    readonly modelRevision: string | null;
    readonly promptHash: string | null;
  };
  readonly observationMode: "browser";
  readonly executionProvenance: PlaytestVisualEpisode["executionProvenance"];
  readonly outcome: PlaytestGameOutcomeKind;
  readonly episodeStatus: PlaytestEpisode["status"];
  readonly termination: PlaytestEpisode["termination"];
  readonly completeness: PlaytestEpisode["completeness"];
  readonly missingReasons: PlaytestEpisode["missingReasons"];
  readonly sourceStepCount: number;
  readonly sessionContext: PlaytestDiscoveryEvidenceSessionContext;
  readonly chronologicalSummary: string;
  readonly traceArtifactId: string;
  readonly stepEvidence: readonly PlaytestDiscoveryStepEvidenceV2[];
  readonly frames: readonly PlaytestDiscoveryEvidenceFrame[];
  readonly omittedFrames: readonly {
    readonly frameId: string;
    readonly step: number;
    readonly reason: PlaytestDiscoveryOmissionReason;
  }[];
  readonly selectedWindows: readonly PlaytestDiscoveryEvidenceWindow[];
  readonly omittedWindows: readonly PlaytestOmittedEvidenceWindow[];
  readonly omittedArtifacts: readonly PlaytestEvidenceOmittedArtifact[];
  readonly suppliedArtifacts: readonly PlaytestEvidenceSuppliedArtifact[];
  readonly visibleEvidenceOnly: true;
  readonly measurementVersion: string;
  readonly tokenBudget: number;
  readonly generatedAt: string;
}

/** Historical v1 packets predate the operator-focus context field. */
export type PlaytestDiscoveryEvidencePacketV1Historical = Omit<
  PlaytestDiscoveryEvidencePacketV1,
  "areasOfFocus"
>;

export interface PlaytestDiscoveryEvidencePacketV2 extends Omit<
  PlaytestDiscoveryEvidencePacketV1,
  "schema"
> {
  readonly schema: typeof PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V2;
  readonly playerSelfReport: PlaytestPlayerDebriefV1;
}

/**
 * v3 of the discovery evidence packet.
 *
 * v3 carries the bounded visible state and the selected steps; the top-level
 * fields are unchanged from v2, so a v3 packet differs from a v2 packet in
 * what it says about the session, not in what it is about.
 */
export interface PlaytestDiscoveryEvidencePacketV3 extends Omit<
  PlaytestDiscoveryEvidencePacketV2,
  "schema" | "stepEvidence"
> {
  readonly schema: typeof PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V3;
  readonly stepEvidence: readonly PlaytestDiscoveryStepEvidence[];
}

export type PlaytestDiscoveryEvidencePacket =
  | PlaytestDiscoveryEvidencePacketV1Historical
  | PlaytestDiscoveryEvidencePacketV1
  | PlaytestDiscoveryEvidencePacketV2
  | PlaytestDiscoveryEvidencePacketV3;

export interface PlaytestDiscoveryHypothesis {
  readonly hypothesisId: string;
  readonly status: PlaytestDiscoveryHypothesisStatus;
  readonly text: string;
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
}

export interface PlaytestDiscoveryReviewExperiment {
  readonly hypothesis: string;
  readonly falsifier: string;
  readonly controls: readonly string[];
  readonly budget: string;
  readonly evidenceRefs: readonly PlaytestEvidenceLocator[];
}

export interface PlaytestDiscoveryReviewDraft {
  readonly reviewId: string;
  readonly packetId: string;
  readonly chronologicalSummary: string;
  readonly observations: readonly PlaytestDiscoveryHypothesis[];
  readonly interpretations: readonly PlaytestDiscoveryHypothesis[];
  readonly alternativeExplanations: readonly PlaytestDiscoveryHypothesis[];
  readonly experiments: readonly PlaytestDiscoveryReviewExperiment[];
  readonly authorRole: "playtest-analyst";
}

export interface BuildPlaytestDiscoveryEvidencePacketInput {
  readonly packetId: string;
  readonly episode: PlaytestEpisode;
  readonly visualBatch: {
    readonly batchId: string;
    readonly workspaceId: string;
    readonly assignmentManifest: PlaytestVisualAssignmentManifest;
  };
  readonly stepEvidence: readonly PlaytestDiscoveryStepEvidence[];
  readonly frames: readonly PlaytestDiscoveryEvidenceFrame[];
  readonly omittedFrames?: readonly {
    readonly frameId: string;
    readonly step: number;
    readonly reason: PlaytestDiscoveryOmissionReason;
  }[];
  readonly omittedArtifacts?: readonly PlaytestEvidenceOmittedArtifact[];
  readonly frameHashes: Readonly<Record<string, string>>;
  readonly traceHash: string;
  readonly measurementVersion: string;
  readonly modelId: string | null;
  readonly modelRevision: string | null;
  readonly promptHash: string | null;
  readonly tokenBudget: number;
  readonly chronologicalSummary: string;
  readonly generatedAt: string;
  readonly maxWindows?: number;
  readonly maxSelectedSteps?: number;
  readonly windowRadius?: number;
  readonly maxPacketBytes?: number;
}

const VISUAL_MODE = "autonomous-visual" as const;
const TARGET_REASON_REDACTED = "redacted" as const;

function assertVisualBatchContract(input: {
  readonly batchId: string;
  readonly workspaceId: string;
  readonly assignmentManifest: PlaytestVisualAssignmentManifest;
}): void {
  const manifest = input.assignmentManifest;
  if (
    manifest.schema !== PLAYTESTS_VISUAL_ASSIGNMENT_MANIFEST_SCHEMA ||
    manifest.mode !== "autonomous-visual" ||
    manifest.batchId !== input.batchId ||
    manifest.workspaceId !== input.workspaceId
  ) {
    throw new TypeError(
      "Discovery packets require a frozen autonomous-visual batch inventory."
    );
  }
  if (!isPlaytestVisualPolicyId(manifest.policyId)) {
    throw new TypeError(
      "Discovery packets require a known visual policy identity."
    );
  }
}

function assertDiscoveryEpisodeBinding(input: {
  readonly episode: PlaytestEpisode;
  readonly assignmentManifest: PlaytestVisualAssignmentManifest;
}): void {
  assertPlaytestVisualEpisode(input.episode);
  const { episode, assignmentManifest } = input;
  if (
    episode.batchId !== assignmentManifest.batchId ||
    episode.identity.workspaceId !== assignmentManifest.workspaceId ||
    episode.executionProvenance.source.targetId !==
      assignmentManifest.targetId ||
    episode.executionProvenance.source.targetOrigin !==
      assignmentManifest.targetOrigin
  ) {
    throw new TypeError(
      "Discovery packet episode does not match the frozen manifest's target binding."
    );
  }
  if (assignmentManifest.assignments.length !== 1) {
    throw new TypeError(
      "Discovery packets currently bind exactly one frozen visual assignment per packet."
    );
  }
  const assignment = assignmentManifest.assignments[0];
  if (
    !assignment ||
    episode.assignmentId !== assignment.assignmentId ||
    episode.identity.policyId !== assignmentManifest.policyId ||
    episode.identity.policyVersion !== assignmentManifest.policyVersion ||
    episode.policyCohort !== assignmentManifest.cohortId
  ) {
    throw new TypeError(
      "Discovery packet episode does not match its frozen visual assignment identity."
    );
  }
  if (
    episode.executionProvenance.mode !== VISUAL_MODE ||
    episode.executionProvenance.actionSource !== "browser-input" ||
    episode.executionProvenance.observationSource !== "browser-ui"
  ) {
    throw new TypeError(
      "Visual discovery packets require a browser-observed, browser-input episode."
    );
  }
  if (
    typeof episode.executionProvenance.source.targetId !== "string" ||
    typeof episode.executionProvenance.source.targetOrigin !== "string"
  ) {
    throw new TypeError(
      "Visual discovery packets require an approved target origin and id."
    );
  }
}

function assertFrameHashBinding(input: {
  readonly frames: readonly PlaytestDiscoveryEvidenceFrame[];
  readonly frameHashes: Readonly<Record<string, string>>;
}): void {
  const frameIds = new Set<string>();
  for (const frame of input.frames) {
    if (frameIds.has(frame.frameId)) {
      throw new TypeError("Discovery packet frame identifiers must be unique.");
    }
    frameIds.add(frame.frameId);
    if (
      !isText(frame.frameId) ||
      !isCount(frame.step) ||
      !isCount(frame.frameIndex) ||
      !EVIDENCE_SHA256_PATTERN.test(frame.sha256) ||
      !isText(frame.capturedAt) ||
      !isCount(frame.captureWidthPx) ||
      !isCount(frame.captureHeightPx) ||
      !["captured", "redacted", "expired"].includes(frame.reason as string)
    ) {
      throw new TypeError("Discovery packet frame metadata is malformed.");
    }
    if (input.frameHashes[frame.frameId] !== frame.sha256) {
      throw new TypeError(
        "Discovery packet frame sha256 contradicts Runtime's recorded frame hash."
      );
    }
  }
}

/**
 * The packet's frames and the packet's step records must describe the same
 * evidence: every carried frame is cited by a step record, and every frame a
 * step record cites is carried.
 */
function assertFrameCitationBinding(input: {
  readonly stepEvidence: readonly PlaytestDiscoveryStepEvidence[];
  readonly frames: readonly PlaytestDiscoveryEvidenceFrame[];
}): void {
  const frameIds = new Set<string>();
  for (const frame of input.frames) {
    frameIds.add(frame.frameId);
  }
  const stepFrameIds = new Set<string>();
  for (const step of input.stepEvidence) {
    for (const frameId of step.frameIds) {
      if (!frameIds.has(frameId)) {
        throw new TypeError(
          "Discovery packet step cites a frame that is not bound by the packet."
        );
      }
      stepFrameIds.add(frameId);
    }
  }
  for (const frame of input.frames) {
    if (!stepFrameIds.has(frame.frameId)) {
      throw new TypeError(
        "Discovery packet frame is not cited by any player-visible step."
      );
    }
  }
}

function assertOmittedFrameBookkeeping(input: {
  readonly frames: readonly PlaytestDiscoveryEvidenceFrame[];
  readonly omittedFrames: ReadonlyArray<{
    readonly frameId: string;
    readonly step: number;
    readonly reason: PlaytestDiscoveryOmissionReason;
  }>;
  readonly suppliedFrameIds: ReadonlySet<string>;
}): void {
  const seen = new Set<string>();
  for (const omitted of input.omittedFrames) {
    if (
      !isText(omitted.frameId) ||
      !isCount(omitted.step) ||
      !PLAYTESTS_DISCOVERY_OMISSION_REASONS.includes(
        omitted.reason as PlaytestDiscoveryOmissionReason
      ) ||
      input.suppliedFrameIds.has(omitted.frameId) ||
      seen.has(omitted.frameId)
    ) {
      throw new TypeError(
        "Discovery packet omitted-frame record is malformed."
      );
    }
    const stillCaptured = input.frames.some(
      (frame) => frame.frameId === omitted.frameId
    );
    if (stillCaptured) {
      throw new TypeError(
        "Discovery packet omitted-frame record conflicts with a captured frame."
      );
    }
    seen.add(omitted.frameId);
  }
}

function discoveryPacketContentBytes(packet: object): number {
  return packetContentBytes(packet);
}

function buildDiscoveryPacketValue(input: {
  readonly data: BuildPlaytestDiscoveryEvidencePacketInput;
  readonly packetHash: string;
  readonly windows: readonly PlaytestEvidenceWindow[];
  readonly omitted: readonly PlaytestOmittedEvidenceWindow[];
  readonly suppliedArtifacts: readonly PlaytestEvidenceSuppliedArtifact[];
  readonly traceArtifactId: string;
  readonly stepEvidence: readonly PlaytestDiscoveryStepEvidence[];
  readonly frames: readonly PlaytestDiscoveryEvidenceFrame[];
  readonly omittedFrames: readonly {
    readonly frameId: string;
    readonly step: number;
    readonly reason: PlaytestDiscoveryOmissionReason;
  }[];
  readonly omittedArtifacts: readonly PlaytestEvidenceOmittedArtifact[];
}): PlaytestDiscoveryEvidencePacketV3 {
  const { data, packetHash, windows, omitted, suppliedArtifacts } = input;
  const manifest = data.visualBatch.assignmentManifest;
  const assignment = manifest.assignments[0];
  if (!assignment) {
    throw new TypeError(
      "Discovery packets currently bind exactly one frozen visual assignment per packet."
    );
  }
  assertPlaytestVisualEpisode(data.episode);
  return {
    schema: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V3,
    packetId: data.packetId,
    packetHash,
    analysisKind: "discovery",
    workspaceId: manifest.workspaceId,
    batchId: manifest.batchId,
    episodeId: data.episode.episodeId,
    episodeRevision: data.episode.revision,
    assignmentId: assignment.assignmentId,
    playerSelfReport: data.episode.playerDebrief,
    areasOfFocus: manifest.areasOfFocus,
    target: {
      targetId: manifest.targetId,
      targetApprovalId: manifest.targetApprovalId,
      targetRevision: manifest.targetRevision,
      targetOrigin: manifest.targetOrigin
    },
    policy: {
      policyId: manifest.policyId,
      policyVersion: manifest.policyVersion,
      cohortId: manifest.cohortId
    },
    model: {
      modelId: data.modelId,
      modelRevision: data.modelRevision,
      promptHash: data.promptHash
    },
    observationMode: "browser",
    executionProvenance: data.episode.executionProvenance,
    outcome: data.episode.outcome,
    episodeStatus: data.episode.status,
    termination: data.episode.termination,
    completeness: data.episode.completeness,
    missingReasons: data.episode.missingReasons,
    sourceStepCount: data.episode.stepCount,
    sessionContext: {
      status: "visual-discovery-session-level",
      reason: "visual-discovery-session-level",
      batchId: manifest.batchId,
      reviewSelection: {
        status: "unavailable",
        reason: "visual-discovery-session-level"
      }
    },
    chronologicalSummary: data.chronologicalSummary.trim(),
    traceArtifactId: input.traceArtifactId,
    stepEvidence: input.stepEvidence,
    frames: input.frames,
    omittedFrames: input.omittedFrames,
    selectedWindows: windows.map(discoveryWindowValue),
    omittedWindows: omitted,
    omittedArtifacts: input.omittedArtifacts,
    suppliedArtifacts,
    visibleEvidenceOnly: true,
    measurementVersion: data.measurementVersion,
    tokenBudget: data.tokenBudget,
    generatedAt: new Date(data.generatedAt).toISOString()
  };
}

/**
 * The selection record of a window.
 *
 * The packet carries each step's visible evidence once, in its step
 * evidence. A window says which steps it covers and which frames and events
 * those steps recorded, and nothing more: repeating the observation here
 * would put every step's visible state into the packet a second time, and a
 * session of a real game does not fit the analyst's packet budget when it is
 * counted twice.
 */
function discoveryWindowValue(
  window: PlaytestEvidenceWindow
): PlaytestDiscoveryEvidenceWindow {
  return {
    startStep: window.startStep,
    endStep: window.endStep,
    selectionReasons: window.selectionReasons,
    steps: window.steps.map((step) => ({
      step: step.step,
      phaseId: step.phaseId,
      events: step.events,
      frameRefs: step.frameRefs
    }))
  };
}

function resolveDiscoveryWindowLimits(input: {
  readonly maxWindows?: number;
  readonly maxSelectedSteps?: number;
  readonly windowRadius?: number;
}): EvidenceWindowLimits {
  return resolveEvidenceWindowLimits(input);
}

function assertDiscoveryEpisodeIdentity(episode: PlaytestEpisode): void {
  assertPlaytestVisualEpisode(episode);
  if (episode.schema !== PLAYTESTS_EPISODE_SCHEMA) {
    throw new TypeError(
      "Discovery packets require the canonical Episode schema."
    );
  }
  if (
    ![
      "completed",
      "started",
      "budget-truncated",
      "cancelled",
      "crashed",
      "infrastructure-failed"
    ].includes(episode.status)
  ) {
    throw new TypeError(
      "Discovery packets require a recorded visual episode state."
    );
  }
  if (
    typeof episode.trace !== "object" ||
    episode.trace === null ||
    episode.trace.kind !== "replay-segment"
  ) {
    throw new TypeError(
      "Discovery packets require a trace artifact locator for the visual trace."
    );
  }
}

export function buildPlaytestDiscoveryEvidencePacket(
  input: BuildPlaytestDiscoveryEvidencePacketInput
): PlaytestDiscoveryEvidencePacketV3 {
  const limits = resolveDiscoveryWindowLimits(input);
  assertDiscoveryEpisodeIdentity(input.episode);
  assertVisualBatchContract({
    batchId: input.visualBatch.batchId,
    workspaceId: input.visualBatch.workspaceId,
    assignmentManifest: input.visualBatch.assignmentManifest
  });
  assertDiscoveryEpisodeBinding({
    episode: input.episode,
    assignmentManifest: input.visualBatch.assignmentManifest
  });
  if (
    !isPlaytestEvidencePacketId(input.packetId) ||
    !EVIDENCE_SHA256_PATTERN.test(input.traceHash) ||
    !isText(input.measurementVersion) ||
    !PLAYTESTS_GAME_OUTCOMES.includes(
      input.episode.outcome as PlaytestGameOutcomeKind
    ) ||
    !PLAYTESTS_GAME_MODES.includes("browser") ||
    !isCount(
      input.tokenBudget,
      PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS
    ) ||
    input.tokenBudget === 0 ||
    !isRecord(input.frameHashes)
  ) {
    throw new TypeError("Discovery packet identity or budget is invalid.");
  }
  if (
    Object.values(input.frameHashes).some(
      (hash) => typeof hash !== "string" || !EVIDENCE_SHA256_PATTERN.test(hash)
    )
  ) {
    throw new TypeError("Discovery packet frame hash is invalid.");
  }
  if (
    input.episode.stepCount < 1 ||
    input.stepEvidence.length !== input.episode.stepCount
  ) {
    throw new RangeError(
      "Discovery packet requires one step record per persisted step."
    );
  }
  for (const [index, step] of input.stepEvidence.entries()) {
    if (!isCount(step.step) || step.step !== index) {
      throw new RangeError(
        "Discovery packet step record index must match the persisted step ordinal."
      );
    }
    if (step.phaseId !== null && !isText(step.phaseId)) {
      throw new TypeError("Discovery packet step evidence phaseId is invalid.");
    }
    assertPlaytestDiscoveryVisibleState(step.visibleObservation);
  }
  assertFrameHashBinding({
    frames: input.frames,
    frameHashes: input.frameHashes
  });
  const suppliedFrameIds = new Set(input.frames.map((frame) => frame.frameId));
  assertOmittedFrameBookkeeping({
    frames: input.frames,
    omittedFrames: input.omittedFrames ?? [],
    suppliedFrameIds
  });
  for (const step of input.stepEvidence) {
    for (const frame of step.frameIds) {
      if (!suppliedFrameIds.has(frame)) {
        throw new TypeError(
          "Discovery packet step cites a frame outside the supplied artifact set."
        );
      }
    }
  }
  if (!isText(input.chronologicalSummary)) {
    throw new TypeError("Discovery packet chronological summary is invalid.");
  }
  const packetByteBudget =
    input.maxPacketBytes ?? PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS;
  const traceSteps: readonly PlaytestEvidenceTraceStep[] =
    input.stepEvidence.map((step) => ({
      step: step.step,
      phaseId: step.phaseId,
      revisionBefore: step.step,
      revisionAfter: step.step + 1,
      observationVisibility:
        step.observationVisibility === "structured"
          ? "structured"
          : "visual-only",
      visibleObservation: step.visibleObservation as never,
      legalActionIds: step.legalActionIds,
      selectedActionId: step.selectedActionId,
      preActionPrediction: step.preActionPrediction as never,
      authoritativeOutcome: step.authoritativeOutcome as never,
      events: [],
      frameRefs: step.frameIds.map((id, frameIndex) => ({
        kind: "frame",
        id,
        frameIndex,
        step: step.step
      }))
    }));
  for (const [index, step] of traceSteps.entries()) {
    assertTraceStep(step, index);
  }
  const provisional = buildBoundedEvidenceWindows({
    traceSteps,
    limits,
    packetByteBudget,
    tokenBudget: input.tokenBudget,
    buildValue: (windows, omitted) => {
      const selectedSteps = new Set<number>();
      for (const window of windows) {
        for (const step of window.steps) selectedSteps.add(step.step);
      }
      // The packet carries the steps it selected, not every persisted step:
      // the selection is what its windows cite, and it is what lets the
      // packet's byte budget shed ordinary-sample steps instead of failing.
      const stepEvidence = input.stepEvidence.filter((step) =>
        selectedSteps.has(step.step)
      );
      const frames = input.frames.filter((frame) =>
        selectedSteps.has(frame.step)
      );
      const unselectedFrames = input.frames.filter(
        (frame) => !selectedSteps.has(frame.step)
      );
      const suppliedArtifacts = suppliedArtifactsFor({
        windows,
        hashes: input.frameHashes,
        traceArtifactId:
          input.episode.trace?.id ?? "discovery-trace-" + input.packetId,
        traceHash: input.traceHash
      });
      return buildDiscoveryPacketValue({
        data: input,
        packetHash: "0".repeat(64),
        windows,
        omitted,
        suppliedArtifacts,
        traceArtifactId:
          input.episode.trace?.id ?? "discovery-trace-" + input.packetId,
        stepEvidence,
        frames,
        omittedFrames: [
          ...(input.omittedFrames ?? []),
          ...unselectedFrames.map((frame) => ({
            frameId: frame.frameId,
            step: frame.step,
            reason: "step-not-selected" as const
          }))
        ],
        omittedArtifacts: [
          ...(input.omittedArtifacts ?? []),
          ...unselectedFrames.map((frame) => ({
            kind: "frame" as const,
            artifactId: frame.frameId,
            step: frame.step,
            reason: "step-not-selected" as const
          }))
        ]
      });
    }
  });
  const provisionalHash = sha256Hex(
    canonicalPlaytestJson({
      ...provisional,
      packetHash: "0".repeat(64)
    })
  );
  const finalPacket = {
    ...provisional,
    packetHash: provisionalHash
  } as PlaytestDiscoveryEvidencePacketV3;
  const finalBytes = packetContentBytes(finalPacket);
  if (
    finalBytes > Math.min(input.tokenBudget, 262_144) ||
    finalBytes > packetByteBudget
  ) {
    throw new RangeError(
      "Discovery evidence packet exceeds its window/token budget."
    );
  }
  return finalPacket;
}

export function discoveryEvidencePacketContentBytes(
  packet: PlaytestDiscoveryEvidencePacket
): number {
  return discoveryPacketContentBytes(packet);
}

const DISCOVERY_PACKET_V1_KEYS = new Set([
  "schema",
  "packetId",
  "packetHash",
  "analysisKind",
  "workspaceId",
  "batchId",
  "episodeId",
  "episodeRevision",
  "assignmentId",
  "areasOfFocus",
  "target",
  "policy",
  "model",
  "observationMode",
  "executionProvenance",
  "outcome",
  "episodeStatus",
  "termination",
  "completeness",
  "missingReasons",
  "sourceStepCount",
  "sessionContext",
  "chronologicalSummary",
  "traceArtifactId",
  "stepEvidence",
  "frames",
  "omittedFrames",
  "selectedWindows",
  "omittedWindows",
  "omittedArtifacts",
  "suppliedArtifacts",
  "visibleEvidenceOnly",
  "measurementVersion",
  "tokenBudget",
  "generatedAt"
]);

const DISCOVERY_PACKET_V1_HISTORICAL_KEYS = new Set(
  [...DISCOVERY_PACKET_V1_KEYS].filter((key) => key !== "areasOfFocus")
);
const DISCOVERY_PACKET_V2_KEYS = new Set([
  ...DISCOVERY_PACKET_V1_KEYS,
  "playerSelfReport"
]);

export function assertPlaytestDiscoveryEvidencePacket(
  value: unknown
): asserts value is PlaytestDiscoveryEvidencePacket {
  const isV3 =
    isRecord(value) &&
    value.schema === PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V3;
  const isV2 =
    isRecord(value) &&
    value.schema === PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA_V2;
  const hasAreasOfFocus = isRecord(value) && "areasOfFocus" in value;
  const packetKeys =
    isV3 || isV2
      ? DISCOVERY_PACKET_V2_KEYS
      : hasAreasOfFocus
        ? DISCOVERY_PACKET_V1_KEYS
        : DISCOVERY_PACKET_V1_HISTORICAL_KEYS;
  if (
    !isRecord(value) ||
    (value.schema !== PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_SCHEMA &&
      !isV2 &&
      !isV3) ||
    Object.keys(value).length !== packetKeys.size ||
    Object.keys(value).some((key) => !packetKeys.has(key))
  ) {
    throw new TypeError(
      "Discovery evidence packet has unknown or missing fields."
    );
  }
  if (value.analysisKind !== "discovery") {
    throw new TypeError(
      'Discovery evidence packet must declare analysisKind="discovery".'
    );
  }
  if (value.visibleEvidenceOnly !== true) {
    throw new TypeError(
      "Discovery evidence packet must keep player-visible evidence only."
    );
  }
  if (
    !isPlaytestEvidencePacketId(value.packetId) ||
    !isText(value.packetHash) ||
    !EVIDENCE_SHA256_PATTERN.test(value.packetHash) ||
    !isText(value.workspaceId) ||
    !isText(value.batchId) ||
    !isText(value.episodeId) ||
    !isCount(value.episodeRevision) ||
    !isText(value.assignmentId) ||
    !PLAYTESTS_GAME_OUTCOMES.includes(
      value.outcome as PlaytestGameOutcomeKind
    ) ||
    !PLAYTESTS_EPISODE_STATES.includes(
      value.episodeStatus as PlaytestEpisode["status"]
    ) ||
    !isRecord(value.termination) ||
    !PLAYTESTS_EPISODE_TERMINATION_REASONS.includes(
      value.termination.reason as PlaytestEpisode["termination"]["reason"]
    ) ||
    (value.termination.step !== null && !isCount(value.termination.step)) ||
    !["complete", "partial", "unknown"].includes(
      value.completeness as string
    ) ||
    !Array.isArray(value.missingReasons) ||
    value.missingReasons.some(
      (reason) =>
        !PLAYTESTS_MISSING_REASONS.includes(reason as PlaytestMissingReason)
    ) ||
    !isCount(value.sourceStepCount) ||
    value.sourceStepCount === 0 ||
    value.observationMode !== "browser" ||
    !isText(value.chronologicalSummary, MAX_SUMMARY_TEXT) ||
    !isText(value.traceArtifactId) ||
    !isText(value.measurementVersion) ||
    !isCount(
      value.tokenBudget,
      PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS
    ) ||
    value.tokenBudget === 0 ||
    !Number.isFinite(Date.parse(String(value.generatedAt)))
  ) {
    throw new TypeError(
      "Discovery evidence packet identity or budget is invalid."
    );
  }
  if (isV2 || isV3) {
    assertPlaytestPlayerDebrief(value.playerSelfReport);
    assertPlayerSelfReportFrameReferences(
      value.playerSelfReport as PlaytestPlayerDebriefV1,
      value.frames as PlaytestDiscoveryEvidenceFrame[],
      value.omittedFrames as PlaytestDiscoveryEvidencePacketV1["omittedFrames"]
    );
  }
  assertTarget(value.target);
  assertPolicy(value.policy);
  assertModel(value.model);
  assertSessionContext(value.sessionContext, value.batchId);
  if (
    "areasOfFocus" in value &&
    value.areasOfFocus !== null &&
    !isText(value.areasOfFocus, PLAYTESTS_DISCOVERY_AREAS_OF_FOCUS_MAX_LENGTH)
  ) {
    throw new TypeError(
      "Discovery evidence packet areasOfFocus is outside its bounded focus contract."
    );
  }
  if (
    !Array.isArray(value.stepEvidence) ||
    !Array.isArray(value.frames) ||
    !Array.isArray(value.omittedFrames)
  ) {
    throw new TypeError(
      "Discovery evidence packet step/frame/omitted arrays are malformed."
    );
  }
  const stepIds = new Set<number>();
  for (const step of value.stepEvidence) {
    if (isV3) {
      assertStepEvidence(step);
    } else {
      assertStepEvidenceV2(step);
    }
    if (stepIds.has(step.step)) {
      throw new TypeError(
        "Discovery evidence packet step evidence contains a duplicate step ordinal."
      );
    }
    stepIds.add(step.step);
  }
  if (!isV3 && value.stepEvidence.length !== value.sourceStepCount) {
    throw new RangeError(
      "Discovery evidence packet step record count does not equal sourceStepCount."
    );
  }
  const frameIds = new Set<string>();
  for (const frame of value.frames) {
    assertFrame(frame);
    if (frameIds.has(frame.frameId)) {
      throw new TypeError(
        "Discovery evidence packet frames contain a duplicate frameId."
      );
    }
    frameIds.add(frame.frameId);
  }
  for (const omitted of value.omittedFrames) {
    if (
      !isRecord(omitted) ||
      Object.keys(omitted).length !== 3 ||
      Object.keys(omitted).some(
        (key) => !["frameId", "step", "reason"].includes(key)
      ) ||
      !isText(omitted.frameId) ||
      !isCount(omitted.step) ||
      !PLAYTESTS_DISCOVERY_OMISSION_REASONS.includes(
        omitted.reason as PlaytestDiscoveryOmissionReason
      ) ||
      frameIds.has(omitted.frameId)
    ) {
      throw new TypeError(
        "Discovery evidence packet omitted-frame record is malformed."
      );
    }
  }
  assertPacketArtifactProvenance(
    value as unknown as PlaytestEvidencePacketArtifactView
  );
  assertOmittedPacketArtifacts(
    value as unknown as PlaytestEvidencePacketOmittedArtifactView
  );
  if (isV3) {
    assertFrameCitationBinding({
      stepEvidence:
        value.stepEvidence as readonly PlaytestDiscoveryStepEvidence[],
      frames: value.frames as readonly PlaytestDiscoveryEvidenceFrame[]
    });
  }
  if (
    !Array.isArray(value.selectedWindows) ||
    !Array.isArray(value.omittedWindows)
  ) {
    throw new TypeError(
      "Discovery evidence packet window arrays are malformed."
    );
  }
  const selectedWindows =
    value.selectedWindows as readonly PlaytestDiscoveryEvidenceWindow[];
  const omittedWindows =
    value.omittedWindows as readonly PlaytestOmittedEvidenceWindow[];
  for (const window of selectedWindows) {
    assertSelectedWindow(window);
  }
  for (const window of omittedWindows) {
    if (
      !isRecord(window) ||
      Object.keys(window).length !== 3 ||
      Object.keys(window).some(
        (key) => !["startStep", "endStep", "reason"].includes(key)
      ) ||
      !isCount(window.startStep) ||
      !isCount(window.endStep) ||
      window.endStep < window.startStep ||
      !["ordinary-sampling", "packet-budget"].includes(window.reason as string)
    ) {
      throw new TypeError(
        "Discovery evidence packet omitted-window record is malformed."
      );
    }
  }
  const partition = [
    ...selectedWindows.map((window) => ({
      kind: "selected" as const,
      startStep: window.startStep,
      endStep: window.endStep
    })),
    ...omittedWindows.map((window) => ({
      kind: "omitted" as const,
      startStep: window.startStep,
      endStep: window.endStep
    }))
  ].sort((left, right) => left.startStep - right.startStep);
  let cursor = 0;
  for (const range of partition) {
    if (
      range.startStep !== cursor ||
      range.endStep >= (value.sourceStepCount as number)
    ) {
      throw new TypeError(
        "Discovery evidence packet selected and omitted windows do not partition the source trace."
      );
    }
    cursor = range.endStep + 1;
  }
  if (cursor !== value.sourceStepCount) {
    throw new TypeError(
      "Discovery evidence packet leaves source steps unaccounted."
    );
  }
  if (isV3) {
    // A v3 packet carries the steps it selected: the step records and the
    // windows cite the same evidence, and the steps the packet left out stay
    // recorded in the omitted windows.
    const selectedSteps = selectedWindows.flatMap((window) =>
      window.steps.map((step) => step.step)
    );
    const recordedSteps = value.stepEvidence.map((step) => step.step);
    if (
      recordedSteps.length !== selectedSteps.length ||
      recordedSteps.some((step, index) => step !== selectedSteps[index])
    ) {
      throw new TypeError(
        "Discovery evidence packet step records do not match the selected windows."
      );
    }
  }
  assertUniqueSelectedEventIds(selectedWindows);
  const finalBytes = packetContentBytes(value);
  if (finalBytes > Math.min(value.tokenBudget, 262_144)) {
    throw new RangeError(
      "Discovery evidence packet exceeds its window/token budget."
    );
  }
}

function assertPlayerSelfReportFrameReferences(
  report: PlaytestPlayerDebriefV1,
  frames: readonly PlaytestDiscoveryEvidenceFrame[],
  omittedFrames: readonly { readonly frameId: string; readonly step: number }[]
): void {
  const refs =
    report.status === "complete"
      ? report.focusInterpretation.evidence
      : report.status === "partial"
        ? [report.checkpoint.evidence]
        : [];
  for (const ref of refs) {
    const included = frames.some(
      (frame) =>
        frame.frameId === ref.id &&
        frame.step === ref.step &&
        frame.frameIndex === ref.frameIndex
    );
    const omitted = omittedFrames.some(
      (frame) => frame.frameId === ref.id && frame.step === ref.step
    );
    if (!included && !omitted) {
      throw new TypeError(
        "Player self-report frame reference does not resolve to packet frame evidence or omission receipt."
      );
    }
  }
}

function assertTarget(
  value: unknown
): asserts value is PlaytestDiscoveryEvidencePacket["target"] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some(
      (key) =>
        ![
          "targetId",
          "targetApprovalId",
          "targetRevision",
          "targetOrigin"
        ].includes(key)
    ) ||
    !isText(value.targetId) ||
    !isText(value.targetApprovalId) ||
    !isCount(value.targetRevision) ||
    !isText(value.targetOrigin)
  ) {
    throw new TypeError(
      "Discovery evidence packet target binding is malformed."
    );
  }
}

function assertPolicy(
  value: unknown
): asserts value is PlaytestDiscoveryEvidencePacket["policy"] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some(
      (key) => !["policyId", "policyVersion", "cohortId"].includes(key)
    ) ||
    !isPlaytestVisualPolicyId(value.policyId) ||
    !isText(value.policyVersion) ||
    (value.cohortId !== null && !isText(value.cohortId))
  ) {
    throw new TypeError(
      "Discovery evidence packet policy binding is malformed."
    );
  }
}

function assertModel(
  value: unknown
): asserts value is PlaytestDiscoveryEvidencePacket["model"] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some(
      (key) => !["modelId", "modelRevision", "promptHash"].includes(key)
    ) ||
    (value.modelId !== null && !isText(value.modelId)) ||
    (value.modelRevision !== null && !isText(value.modelRevision)) ||
    (value.promptHash !== null &&
      (typeof value.promptHash !== "string" ||
        !EVIDENCE_SHA256_PATTERN.test(value.promptHash)))
  ) {
    throw new TypeError(
      "Discovery evidence packet model identity is malformed."
    );
  }
}

function assertSessionContext(
  value: unknown,
  expectedBatchId: unknown
): asserts value is PlaytestDiscoveryEvidencePacket["sessionContext"] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some(
      (key) => !["status", "reason", "batchId", "reviewSelection"].includes(key)
    ) ||
    value.status !== "visual-discovery-session-level" ||
    value.reason !== "visual-discovery-session-level" ||
    value.batchId !== expectedBatchId
  ) {
    throw new TypeError(
      "Discovery evidence packet session context is malformed."
    );
  }
  const review = value.reviewSelection;
  if (
    !isRecord(review) ||
    Object.keys(review).length !== 2 ||
    review.status !== "unavailable" ||
    review.reason !== "visual-discovery-session-level"
  ) {
    throw new TypeError(
      "Discovery evidence packet review selection is malformed."
    );
  }
}

function assertFrame(
  value: unknown
): asserts value is PlaytestDiscoveryEvidenceFrame {
  if (
    !isRecord(value) ||
    !isText(value.frameId) ||
    !isCount(value.step) ||
    !isCount(value.frameIndex) ||
    typeof value.sha256 !== "string" ||
    !EVIDENCE_SHA256_PATTERN.test(value.sha256) ||
    !isText(value.capturedAt) ||
    !isCount(value.captureWidthPx) ||
    !isCount(value.captureHeightPx) ||
    !["captured", "redacted", "expired"].includes(value.reason as string) ||
    !Array.isArray(value.redactedSurfaces) ||
    value.redactedSurfaces.some((surface) => !isText(surface)) ||
    (value.visibleStateRef !== null && !isText(value.visibleStateRef))
  ) {
    throw new TypeError(
      "Discovery evidence packet frame metadata is malformed."
    );
  }
}

function assertSelectedWindow(
  value: unknown
): asserts value is PlaytestDiscoveryEvidenceWindow {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some(
      (key) =>
        !["startStep", "endStep", "selectionReasons", "steps"].includes(key)
    ) ||
    !isCount(value.startStep) ||
    !isCount(value.endStep) ||
    value.endStep < value.startStep ||
    !Array.isArray(value.selectionReasons) ||
    value.selectionReasons.length === 0 ||
    !value.selectionReasons.every((reason) =>
      ["event-bearing-step", "terminal", "ordinary-sample"].includes(
        String(reason)
      )
    ) ||
    !Array.isArray(value.steps)
  ) {
    throw new TypeError(
      "Discovery evidence packet selected window is malformed."
    );
  }
  const steps = value.steps;
  if (
    steps.length !==
    (value.endStep as number) - (value.startStep as number) + 1
  ) {
    throw new TypeError(
      "Discovery evidence packet window step length does not match its range."
    );
  }
  for (const [index, step] of steps.entries()) {
    assertDiscoveryWindowStep(step, (value.startStep as number) + index);
  }
}

function assertDiscoveryWindowStep(
  value: unknown,
  expectedStep: number
): asserts value is PlaytestDiscoveryEvidenceWindowStep {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 4 ||
    Object.keys(value).some(
      (key) => !["step", "phaseId", "events", "frameRefs"].includes(key)
    ) ||
    !isCount(value.step) ||
    value.step !== expectedStep ||
    (value.phaseId !== null && !isText(value.phaseId)) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.frameRefs)
  ) {
    throw new TypeError(
      "Discovery evidence packet selected window step is malformed."
    );
  }
  for (const frame of value.frameRefs) {
    assertPlaytestEvidenceLocator(frame);
  }
}

/** The v1/v2 step record: the recorded observation plus the affordance index. */
function assertStepEvidenceV2(
  value: unknown
): asserts value is PlaytestDiscoveryStepEvidenceV2 {
  if (
    !isRecord(value) ||
    !isCount(value.step) ||
    !["structured", "visual-only"].includes(
      value.observationVisibility as string
    ) ||
    (value.phaseId !== null && !isText(value.phaseId)) ||
    !Array.isArray(value.legalActionIds) ||
    value.legalActionIds.some((id: unknown) => !isText(id)) ||
    (value.selectedActionId !== null && !isText(value.selectedActionId)) ||
    !Array.isArray(value.frameIds) ||
    value.frameIds.some((id: unknown) => !isText(id))
  ) {
    throw new TypeError(
      "Discovery evidence packet step evidence is malformed."
    );
  }
  if (
    value.selectedActionId !== null &&
    !value.legalActionIds.includes(value.selectedActionId)
  ) {
    throw new TypeError(
      "Discovery packet selected action must belong to the legal action set."
    );
  }
  if (
    value.preActionPrediction !== null &&
    (!isRecord(value.preActionPrediction) ||
      !isText(
        (value.preActionPrediction as Record<string, unknown>).intention
      ) ||
      !isText(
        (value.preActionPrediction as Record<string, unknown>)
          .predictedVisibleEffect
      ))
  ) {
    throw new TypeError(
      "Discovery packet pre-action prediction must carry intention and predictedVisibleEffect."
    );
  }
  if (value.actionReceipt !== null) {
    assertActionReceipt(value.actionReceipt);
  }
  if (!Array.isArray(value.observationNotes)) {
    throw new TypeError(
      "Discovery packet observation notes array is malformed."
    );
  }
  for (const note of value.observationNotes) {
    if (
      !isRecord(note) ||
      !isText(note.noteId) ||
      !isCount(note.step) ||
      !isText(note.label) ||
      !isText(note.detail, MAX_SUMMARY_TEXT)
    ) {
      throw new TypeError("Discovery packet observation note is malformed.");
    }
  }
  if (!Array.isArray(value.affordanceNotes)) {
    throw new TypeError(
      "Discovery packet affordance notes array is malformed."
    );
  }
  for (const affordance of value.affordanceNotes) {
    if (
      !isRecord(affordance) ||
      !isText(affordance.noteId) ||
      !isCount(affordance.step) ||
      !isText(affordance.controlId)
    ) {
      throw new TypeError("Discovery packet affordance note is malformed.");
    }
  }
}

/**
 * The v3 step record: the bounded visible state, the action the player took
 * and the evidence around it. There is no affordance index any more: the
 * visible state indexes the affordances by control id, and the note ids were
 * never citable.
 */
function assertStepEvidence(
  value: unknown
): asserts value is PlaytestDiscoveryStepEvidence {
  if (
    !isRecord(value) ||
    !isCount(value.step) ||
    !["structured", "visual-only"].includes(
      value.observationVisibility as string
    ) ||
    (value.phaseId !== null && !isText(value.phaseId)) ||
    !Array.isArray(value.legalActionIds) ||
    value.legalActionIds.some((id: unknown) => !isText(id)) ||
    (value.selectedActionId !== null && !isText(value.selectedActionId)) ||
    !Array.isArray(value.frameIds) ||
    value.frameIds.some((id: unknown) => !isText(id))
  ) {
    throw new TypeError(
      "Discovery evidence packet step evidence is malformed."
    );
  }
  if (
    value.selectedActionId !== null &&
    !value.legalActionIds.includes(value.selectedActionId)
  ) {
    throw new TypeError(
      "Discovery packet selected action must belong to the legal action set."
    );
  }
  if (
    value.preActionPrediction !== null &&
    (!isRecord(value.preActionPrediction) ||
      !isText(
        (value.preActionPrediction as Record<string, unknown>).intention
      ) ||
      !isText(
        (value.preActionPrediction as Record<string, unknown>)
          .predictedVisibleEffect
      ))
  ) {
    throw new TypeError(
      "Discovery packet pre-action prediction must carry intention and predictedVisibleEffect."
    );
  }
  if (value.actionReceipt !== null) {
    assertActionReceipt(value.actionReceipt);
  }
  if (!Array.isArray(value.observationNotes)) {
    throw new TypeError(
      "Discovery packet observation notes array is malformed."
    );
  }
  for (const note of value.observationNotes) {
    if (
      !isRecord(note) ||
      !isText(note.noteId) ||
      !isCount(note.step) ||
      !isText(note.label) ||
      !isText(note.detail, MAX_SUMMARY_TEXT)
    ) {
      throw new TypeError("Discovery packet observation note is malformed.");
    }
  }
  assertPlaytestDiscoveryVisibleState(value.visibleObservation);
}

/**
 * The bounded visible state of one step.
 *
 * The bounds are the contract: a capped name, a capped control count and an
 * explicit record of what the projection condensed. A state that carries
 * more than the contract allows is refused rather than silently shipped.
 */
export function assertPlaytestDiscoveryVisibleState(
  value: unknown
): asserts value is PlaytestDiscoveryVisibleState {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 10 ||
    Object.keys(value).some(
      (key) =>
        ![
          "capturedAt",
          "viewport",
          "privacyState",
          "phase",
          "progress",
          "warnings",
          "controls",
          "observedControlCount",
          "omittedControlCount",
          "truncatedNameCount"
        ].includes(key)
    ) ||
    !isText(value.capturedAt) ||
    !Number.isFinite(Date.parse(String(value.capturedAt))) ||
    (value.viewport !== null &&
      (!isRecord(value.viewport) ||
        Object.keys(value.viewport).length !== 3 ||
        !isCount(value.viewport.width) ||
        !isCount(value.viewport.height) ||
        !isCount(value.viewport.deviceScaleFactor) ||
        value.viewport.width <= 0 ||
        value.viewport.height <= 0 ||
        value.viewport.deviceScaleFactor <= 0)) ||
    !["clear", "redacted"].includes(value.privacyState as string) ||
    (value.phase !== null && !isText(value.phase)) ||
    !isJson(value.progress) ||
    !Array.isArray(value.warnings) ||
    value.warnings.some((warning: unknown) => !isText(warning)) ||
    !Array.isArray(value.controls) ||
    value.controls.length > PLAYTESTS_DISCOVERY_MAX_CONTROLS_PER_STEP ||
    !isCount(value.observedControlCount) ||
    !isCount(value.omittedControlCount) ||
    !isCount(value.truncatedNameCount)
  ) {
    throw new TypeError(
      "Discovery packet visible state is malformed or outside its bounded contract."
    );
  }
  for (const control of value.controls) {
    if (
      !isRecord(control) ||
      Object.keys(control).length !== 4 ||
      Object.keys(control).some(
        (key) => !["controlId", "role", "name", "enabled"].includes(key)
      ) ||
      !isText(control.controlId) ||
      !isText(control.role) ||
      !isText(control.name, PLAYTESTS_DISCOVERY_CONTROL_NAME_MAX_LENGTH) ||
      typeof control.enabled !== "boolean"
    ) {
      throw new TypeError(
        "Discovery packet visible control is malformed or outside its bounded contract."
      );
    }
  }
  if (
    value.observedControlCount !==
    value.controls.length + value.omittedControlCount
  ) {
    throw new TypeError(
      "Discovery packet visible state does not account for every observed control."
    );
  }
}

function assertActionReceipt(
  value: unknown
): asserts value is PlaytestDiscoveryActionReceipt {
  if (
    !isRecord(value) ||
    !isText(value.receiptId) ||
    !isCount(value.step) ||
    !isText(value.observationId) ||
    (value.status !== "dispatched" && value.status !== "refused") ||
    (value.refusalReason !== null && !isText(value.refusalReason)) ||
    (value.selectedActionId !== null && !isText(value.selectedActionId)) ||
    ![
      "semantic-control",
      "screenshot-coordinate",
      "safe-key",
      "no-input"
    ].includes(value.inputKind as string) ||
    (value.controlId !== null && !isText(value.controlId)) ||
    (value.safeKey !== null && !isText(value.safeKey)) ||
    (value.coordinates !== null &&
      (!isRecord(value.coordinates) ||
        !Number.isFinite(value.coordinates.x) ||
        !Number.isFinite(value.coordinates.y) ||
        (value.coordinates.x as number) < 0 ||
        (value.coordinates.y as number) < 0)) ||
    !isText(value.intention) ||
    !isText(value.predictedVisibleEffect, MAX_SUMMARY_TEXT) ||
    !isText(value.receivedAt)
  ) {
    throw new TypeError("Discovery packet action receipt is malformed.");
  }
}

function isHypothesis(value: unknown): value is PlaytestDiscoveryHypothesis {
  return (
    isRecord(value) &&
    isText(value.hypothesisId) &&
    PLAYTESTS_DISCOVERY_HYPOTHESIS_STATUSES.includes(
      value.status as PlaytestDiscoveryHypothesisStatus
    ) &&
    isText(value.text, MAX_SUMMARY_TEXT) &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.length > 0
  );
}

function assertHypotheses(
  value: unknown
): asserts value is readonly PlaytestDiscoveryHypothesis[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Discovery review hypothesis list must be an array.");
  }
  const seen = new Set<string>();
  for (const hypothesis of value) {
    if (!isHypothesis(hypothesis) || seen.has(hypothesis.hypothesisId)) {
      throw new TypeError(
        "Discovery review hypothesis is malformed or duplicated."
      );
    }
    seen.add(hypothesis.hypothesisId);
  }
}

function isExperiment(
  value: unknown
): value is PlaytestDiscoveryReviewExperiment {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    Object.keys(value).every((key) =>
      [
        "hypothesis",
        "falsifier",
        "controls",
        "budget",
        "evidenceRefs"
      ].includes(key)
    ) &&
    isText(value.hypothesis, MAX_SUMMARY_TEXT) &&
    isText(value.falsifier, MAX_SUMMARY_TEXT) &&
    Array.isArray(value.controls) &&
    value.controls.length > 0 &&
    value.controls.every((control) => isText(control)) &&
    isText(value.budget, MAX_SUMMARY_TEXT) &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.length > 0 &&
    value.evidenceRefs.every((reference) => {
      try {
        assertPlaytestEvidenceLocator(reference);
        return true;
      } catch {
        return false;
      }
    })
  );
}

export function assertPlaytestDiscoveryReviewGroundedInPacket(
  draft: PlaytestDiscoveryReviewDraft,
  packet: PlaytestDiscoveryEvidencePacket
): void {
  assertPlaytestDiscoveryEvidencePacket(packet);
  if (
    !isText(draft.reviewId) ||
    !isText(draft.packetId) ||
    draft.packetId !== packet.packetId ||
    !isText(draft.chronologicalSummary, MAX_SUMMARY_TEXT) ||
    draft.authorRole !== "playtest-analyst"
  ) {
    throw new TypeError(
      "Discovery review draft identity fields are malformed."
    );
  }
  assertHypotheses(draft.observations);
  assertHypotheses(draft.interpretations);
  assertHypotheses(draft.alternativeExplanations);
  for (const experiment of draft.experiments) {
    if (!isExperiment(experiment)) {
      throw new TypeError("Discovery review experiment is malformed.");
    }
  }
  assertPlaytestEvidenceLocatorsWithinPacket(
    [
      ...draft.observations.flatMap((hypothesis) => hypothesis.evidenceRefs),
      ...draft.interpretations.flatMap((hypothesis) => hypothesis.evidenceRefs),
      ...draft.alternativeExplanations.flatMap(
        (hypothesis) => hypothesis.evidenceRefs
      ),
      ...draft.experiments.flatMap((experiment) => experiment.evidenceRefs)
    ],
    packet as unknown as PlaytestEvidencePacketLocatorView
  );
}

export const PLAYTESTS_DISCOVERY_REVIEW_DRAFT_KEYS = new Set([
  "reviewId",
  "packetId",
  "chronologicalSummary",
  "observations",
  "interpretations",
  "alternativeExplanations",
  "experiments",
  "authorRole"
]);

export function assertPlaytestDiscoveryReviewDraft(
  value: unknown
): asserts value is PlaytestDiscoveryReviewDraft {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== PLAYTESTS_DISCOVERY_REVIEW_DRAFT_KEYS.size ||
    Object.keys(value).some(
      (key) => !PLAYTESTS_DISCOVERY_REVIEW_DRAFT_KEYS.has(key)
    )
  ) {
    throw new TypeError(
      "Discovery review draft has unknown or missing fields."
    );
  }
  if (
    !isText(value.reviewId) ||
    !isText(value.packetId) ||
    !isText(value.chronologicalSummary, MAX_SUMMARY_TEXT) ||
    value.authorRole !== "playtest-analyst"
  ) {
    throw new TypeError(
      "Discovery review draft identity fields are malformed."
    );
  }
  assertHypotheses(value.observations);
  assertHypotheses(value.interpretations);
  assertHypotheses(value.alternativeExplanations);
  if (!Array.isArray(value.experiments)) {
    throw new TypeError("Discovery review draft experiments must be an array.");
  }
  for (const experiment of value.experiments) {
    if (!isExperiment(experiment)) {
      throw new TypeError("Discovery review draft experiment is malformed.");
    }
  }
}

const DISCOVERY_SESSION_REVIEW_KEYS = new Set([
  "schema",
  "analysisKind",
  "reviewId",
  "version",
  "workspaceId",
  "batchId",
  "episodeId",
  "supersedes",
  "evidencePacket",
  "authorRole",
  "authorId",
  "measurementVersion",
  "chronologicalSummary",
  "observations",
  "interpretations",
  "alternativeExplanations",
  "experiments",
  "evidenceRefs",
  "createdAt",
  "status"
]);

/** Strict stored discovery review codec guard; metric/rubric fields are forbidden. */
export function assertPlaytestDiscoverySessionReview(
  value: unknown
): asserts value is PlaytestDiscoverySessionReview {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== DISCOVERY_SESSION_REVIEW_KEYS.size ||
    Object.keys(value).some((key) => !DISCOVERY_SESSION_REVIEW_KEYS.has(key))
  ) {
    throw new TypeError(
      "Discovery session review has unknown or missing fields."
    );
  }
  const packetReference = value.evidencePacket;
  if (
    value.schema !== PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA ||
    value.analysisKind !== "discovery" ||
    !isText(value.reviewId) ||
    !isCount(value.version) ||
    value.version < 1 ||
    !isText(value.workspaceId) ||
    !isText(value.batchId) ||
    !isText(value.episodeId) ||
    (value.supersedes !== null && !isText(value.supersedes)) ||
    value.authorRole !== "playtest-analyst" ||
    !isText(value.authorId) ||
    !isText(value.measurementVersion) ||
    !isText(value.chronologicalSummary, MAX_SUMMARY_TEXT) ||
    (value.status !== "hypothesis" && value.status !== "not observed") ||
    !isText(value.createdAt) ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !isRecord(packetReference) ||
    Object.keys(packetReference).length !== 2 ||
    !isText(packetReference.packetId) ||
    !isRecord(packetReference.artifact) ||
    Object.keys(packetReference.artifact).length !== 4 ||
    !isText(packetReference.artifact.artifactId) ||
    !EVIDENCE_SHA256_PATTERN.test(String(packetReference.artifact.sha256)) ||
    !isCount(packetReference.artifact.bytes) ||
    packetReference.artifact.bytes < 1 ||
    packetReference.artifact.mediaType !==
      PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE
  ) {
    throw new TypeError(
      "Discovery session review identity or packet reference is malformed."
    );
  }
  const draft = {
    reviewId: value.reviewId,
    packetId: packetReference.packetId,
    chronologicalSummary: value.chronologicalSummary,
    observations: value.observations,
    interpretations: value.interpretations,
    alternativeExplanations: value.alternativeExplanations,
    experiments: value.experiments,
    authorRole: value.authorRole
  };
  assertPlaytestDiscoveryReviewDraft(draft);
  if (
    !Array.isArray(value.evidenceRefs) ||
    value.evidenceRefs.length === 0 ||
    value.evidenceRefs.some((reference) => {
      try {
        assertPlaytestEvidenceLocator(reference);
        return false;
      } catch {
        return true;
      }
    })
  ) {
    throw new TypeError(
      "Discovery session review requires structurally valid evidence locators."
    );
  }
}

export function playtestDiscoveryEvidencePacketHashInput(
  packet: PlaytestDiscoveryEvidencePacket
): string {
  return canonicalPlaytestJson({ ...packet, packetHash: "0".repeat(64) });
}

export const REDACTED_TARGET_REASON: typeof TARGET_REASON_REDACTED =
  TARGET_REASON_REDACTED;
