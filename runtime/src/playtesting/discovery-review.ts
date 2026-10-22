import { createHash } from "node:crypto";

import {
  assertPlaytestDiscoveryEvidencePacket,
  buildPlaytestDiscoveryEvidencePacket,
  canonicalPlaytestJson,
  type PlaytestArtifactReference,
  type PlaytestDiscoveryActionReceipt,
  type PlaytestDiscoveryEvidenceFrame,
  type PlaytestDiscoveryEvidencePacketV3,
  type PlaytestDiscoveryOmissionReason,
  type PlaytestDiscoveryStepEvidence,
  type PlaytestDiscoveryVisibleState,
  type PlaytestEpisode,
  type PlaytestEvidenceOmittedArtifact,
  PLAYTESTS_DISCOVERY_CONTROL_NAME_MAX_LENGTH,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS,
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_MAX_CONTROLS_PER_STEP,
  type PlaytestVisualBatch
} from "@simulatorlife/autodev-core";

import {
  type PlaytestArtifactStore,
  PLAYTESTS_ARTIFACT_WINDOW_MEDIA_TYPE
} from "./artifact-store.ts";

export interface PreparedPlaytestDiscoveryPacket {
  readonly packet: PlaytestDiscoveryEvidencePacketV3;
  readonly artifact: PlaytestArtifactReference;
}

interface TraceRow extends Record<string, unknown> {
  readonly step: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return (
    bytes.length >= signature.length &&
    signature.every((value, index) => bytes[index] === value)
  );
}

function isoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    value.endsWith("Z")
  );
}

function readTrace(input: {
  readonly episode: PlaytestEpisode;
  readonly artifacts: PlaytestArtifactStore;
}): {
  readonly reference: PlaytestArtifactReference;
  readonly rows: readonly TraceRow[];
} {
  const locator = input.episode.trace;
  if (!locator || locator.kind !== "replay-segment") {
    throw new TypeError(
      "Visual discovery requires the exact replay trace artifact."
    );
  }
  const reference = input.artifacts.referenceForId(locator.id);
  if (
    !reference ||
    reference.mediaType !== PLAYTESTS_ARTIFACT_WINDOW_MEDIA_TYPE ||
    input.artifacts.boundWorkspaceId() !== input.episode.identity.workspaceId
  ) {
    throw new TypeError(
      "Visual discovery trace is unavailable in the authorized workspace."
    );
  }
  const read = input.artifacts.readWindow(reference);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  const rows: TraceRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (
      !isRecord(parsed) ||
      !Number.isSafeInteger(parsed.step) ||
      (parsed.step as number) !== rows.length
    ) {
      throw new TypeError(
        "Visual discovery trace is malformed or non-contiguous."
      );
    }
    rows.push(parsed as TraceRow);
  }
  if (rows.length !== input.episode.stepCount || rows.length === 0) {
    throw new TypeError(
      "Visual discovery trace does not match the persisted episode step count."
    );
  }
  return { reference: read.reference, rows };
}

/**
 * The bounded visible state of one step.
 *
 * The recorded observation is the trace's full record; the analyst's packet
 * carries a bounded projection of it. Every visible control keeps its
 * identity, its role, its enabled state and its accessible name (capped),
 * the on-screen geometry is not carried -- the captured frame is the record
 * of the layout -- and the projection records what it condensed.
 */
function boundedVisibleState(input: {
  readonly observation: Record<string, unknown>;
  readonly selectedActionId: string | null;
}): PlaytestDiscoveryVisibleState {
  const observation = input.observation;
  const capturedAt = observation.capturedAt;
  if (typeof capturedAt !== "string" || capturedAt.length === 0) {
    throw new TypeError(
      "Visual discovery trace step has no recorded visible observation timestamp."
    );
  }
  const rawViewport = observation.viewport;
  const viewport =
    isRecord(rawViewport) &&
    typeof rawViewport.width === "number" &&
    typeof rawViewport.height === "number" &&
    typeof rawViewport.deviceScaleFactor === "number"
      ? {
          width: rawViewport.width,
          height: rawViewport.height,
          deviceScaleFactor: rawViewport.deviceScaleFactor
        }
      : null;
  const warnings = Array.isArray(observation.warnings)
    ? observation.warnings.filter(
        (warning): warning is string => typeof warning === "string"
      )
    : [];
  const recordedControls = Array.isArray(observation.controls)
    ? observation.controls
    : [];
  const wellFormed = recordedControls.filter(
    (control): control is Record<string, unknown> =>
      isRecord(control) &&
      typeof control.controlId === "string" &&
      typeof control.role === "string" &&
      typeof control.name === "string" &&
      typeof control.enabled === "boolean"
  );
  // The control the player acted on is the one the analyst cannot do without:
  // it leads, and the rest follow in the order the page recorded them.
  const selected = input.selectedActionId;
  const ordered = selected
    ? [
        ...wellFormed.filter((control) => control.controlId === selected),
        ...wellFormed.filter((control) => control.controlId !== selected)
      ]
    : wellFormed;
  const carried = ordered.slice(0, PLAYTESTS_DISCOVERY_MAX_CONTROLS_PER_STEP);
  let truncatedNameCount = 0;
  const controls = carried.map((control) => {
    const name = control.name as string;
    const truncated = name.length > PLAYTESTS_DISCOVERY_CONTROL_NAME_MAX_LENGTH;
    if (truncated) truncatedNameCount += 1;
    return {
      controlId: control.controlId as string,
      role: control.role as string,
      name: truncated
        ? name.slice(0, PLAYTESTS_DISCOVERY_CONTROL_NAME_MAX_LENGTH - 1) + "…"
        : name,
      enabled: control.enabled as boolean
    };
  });
  return {
    capturedAt,
    viewport,
    privacyState:
      observation.privacyState === "redacted" ? "redacted" : "clear",
    phase: typeof observation.phase === "string" ? observation.phase : null,
    progress: observation.progress ?? null,
    warnings,
    controls,
    observedControlCount: recordedControls.length,
    omittedControlCount: recordedControls.length - controls.length,
    truncatedNameCount
  };
}

const FRAME_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const DRIVER_ACTION_INPUT_KINDS = new Map<
  string,
  PlaytestDiscoveryActionReceipt["inputKind"]
>([
  ["activate-control", "semantic-control"],
  ["pointer-click", "screenshot-coordinate"],
  ["key-press", "safe-key"]
]);

interface StepOutcomeParts {
  readonly outcome: Record<string, unknown> | null;
  readonly driverActionKind: string | null;
  readonly actionDetail: Record<string, unknown> | null;
  readonly receiptStatus: "dispatched" | "refused" | null;
  readonly observationId: string | null;
}

/** The string entries of a recorded list, in the order the trace stored them. */
function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** The prediction the player recorded before acting, when it is well formed. */
function readPrediction(
  rawPrediction: unknown
): PlaytestDiscoveryStepEvidence["preActionPrediction"] {
  if (
    !isRecord(rawPrediction) ||
    typeof rawPrediction.intention !== "string" ||
    typeof rawPrediction.predictedVisibleEffect !== "string"
  ) {
    return null;
  }
  return {
    intention: rawPrediction.intention,
    predictedVisibleEffect: rawPrediction.predictedVisibleEffect
  };
}

/** The phase the trace recorded, falling back to the visible observation. */
function readPhaseId(
  row: TraceRow,
  visibleObservation: Record<string, unknown>
): string | null {
  return typeof row.phaseId === "string"
    ? row.phaseId
    : typeof visibleObservation.phase === "string"
      ? visibleObservation.phase
      : null;
}

/** The authoritative outcome the driver recorded for one step. */
function readStepOutcome(row: TraceRow): StepOutcomeParts {
  const outcome = isRecord(row.authoritativeOutcome)
    ? row.authoritativeOutcome
    : null;
  const driverActionKind =
    outcome && typeof outcome.actionKind === "string"
      ? outcome.actionKind
      : null;
  const actionDetail =
    outcome && isRecord(outcome.actionDetail) ? outcome.actionDetail : null;
  const receiptStatus =
    outcome?.status === "dispatched" || outcome?.status === "refused"
      ? outcome.status
      : null;
  const observationId =
    outcome && typeof outcome.observationId === "string"
      ? outcome.observationId
      : null;
  return {
    outcome,
    driverActionKind,
    actionDetail,
    receiptStatus,
    observationId
  };
}

/** When the input was received: the dispatch, then the receipt, then the frame. */
function readReceivedAt(
  outcome: Record<string, unknown> | null,
  fallbackCapturedAt: unknown
): string | null {
  return outcome && isoTimestamp(outcome.dispatchedAt)
    ? outcome.dispatchedAt
    : outcome && isoTimestamp(outcome.receiptAt)
      ? outcome.receiptAt
      : isoTimestamp(fallbackCapturedAt)
        ? fallbackCapturedAt
        : null;
}

/** How the driver carried out the action, as the analyst sees it. */
function readInputKind(
  driverActionKind: string
): PlaytestDiscoveryActionReceipt["inputKind"] {
  return DRIVER_ACTION_INPUT_KINDS.get(driverActionKind) ?? "no-input";
}

/** The receipt of one admitted input, as the analyst reads it. */
function buildActionReceipt(input: {
  readonly episodeId: string;
  readonly step: number;
  readonly actionId: string | null;
  readonly prediction: PlaytestDiscoveryStepEvidence["preActionPrediction"];
  readonly outcome: Record<string, unknown> | null;
  readonly driverActionKind: string;
  readonly actionDetail: Record<string, unknown> | null;
  readonly receiptStatus: "dispatched" | "refused";
  readonly observationId: string;
  readonly receivedAt: string;
}): PlaytestDiscoveryActionReceipt {
  const { actionDetail } = input;
  const controlId =
    actionDetail && typeof actionDetail.controlId === "string"
      ? actionDetail.controlId
      : null;
  const safeKey =
    actionDetail && typeof actionDetail.key === "string"
      ? actionDetail.key
      : null;
  const coordinates =
    actionDetail &&
    typeof actionDetail.x === "number" &&
    typeof actionDetail.y === "number"
      ? { x: actionDetail.x, y: actionDetail.y }
      : null;
  const refusalReason =
    input.outcome && typeof input.outcome.refusalReason === "string"
      ? input.outcome.refusalReason
      : null;
  return {
    receiptId: input.episodeId + ":step-" + String(input.step) + ":input",
    step: input.step,
    observationId: input.observationId,
    status: input.receiptStatus,
    refusalReason,
    selectedActionId: input.actionId,
    inputKind: readInputKind(input.driverActionKind),
    controlId,
    safeKey,
    coordinates,
    intention:
      input.prediction?.intention ?? "No action intention was recorded.",
    predictedVisibleEffect:
      input.prediction?.predictedVisibleEffect ??
      "No predicted visible effect was recorded.",
    visibleConsequence:
      input.receiptStatus === "dispatched"
        ? { gameAcknowledgement: "not-observed" }
        : { status: "input-refused" },
    receivedAt: input.receivedAt
  };
}

function makeStepEvidence(input: {
  readonly episode: PlaytestEpisode;
  readonly rows: readonly TraceRow[];
  readonly frameIdsByStep: ReadonlyMap<number, readonly string[]>;
}): readonly PlaytestDiscoveryStepEvidence[] {
  return input.rows.map((row) => {
    const visibleObservation = row.visibleObservation;
    if (!isRecord(visibleObservation)) {
      throw new TypeError(
        "Visual discovery trace step has no recorded visible observation."
      );
    }
    const prediction = readPrediction(row.preActionPrediction);
    const actionId =
      typeof row.selectedActionId === "string" ? row.selectedActionId : null;
    const legalActionIds = readStringArray(row.legalActionIds);
    const phaseId = readPhaseId(row, visibleObservation);
    const warnings = readStringArray(visibleObservation.warnings);
    const step = row.step;
    const outcome = readStepOutcome(row);
    const receivedAt = readReceivedAt(
      outcome.outcome,
      visibleObservation.capturedAt
    );
    const actionReceipt =
      outcome.driverActionKind !== null &&
      outcome.receiptStatus !== null &&
      outcome.observationId !== null &&
      receivedAt !== null
        ? buildActionReceipt({
            episodeId: input.episode.episodeId,
            step,
            actionId,
            prediction,
            outcome: outcome.outcome,
            driverActionKind: outcome.driverActionKind,
            actionDetail: outcome.actionDetail,
            receiptStatus: outcome.receiptStatus,
            observationId: outcome.observationId,
            receivedAt
          })
        : null;
    const observationNotes = warnings.map((warning, index) => ({
      noteId:
        input.episode.episodeId +
        ":warning-" +
        String(step) +
        "-" +
        String(index),
      step,
      label: "Visible warning",
      detail: warning
    }));
    const visibleFrames = input.frameIdsByStep.get(step) ?? [];
    return {
      step,
      phaseId,
      observationVisibility: "visual-only",
      visibleObservation: boundedVisibleState({
        observation: visibleObservation,
        selectedActionId: actionId
      }),
      selectedActionId: actionId,
      legalActionIds,
      preActionPrediction: prediction,
      authoritativeOutcome: row.authoritativeOutcome ?? null,
      actionReceipt,
      observationNotes,
      frameIds: visibleFrames
    };
  });
}

/** The frames one episode recorded, and the frames it could not carry. */
interface FrameEvidence {
  readonly frames: PlaytestDiscoveryEvidenceFrame[];
  readonly frameHashes: Record<string, string>;
  readonly frameIdsByStep: Map<number, string[]>;
  readonly omittedFrames: {
    frameId: string;
    step: number;
    reason: PlaytestDiscoveryOmissionReason;
  }[];
  readonly omittedArtifacts: PlaytestEvidenceOmittedArtifact[];
}

/** The reasons a single frame can be dropped from the packet. */
type FrameOmitReason = "missing" | "invalid-reference" | "unsupported-media";

/** The bytes behind one frame locator, or why the frame cannot be carried. */
function readFrameArtifact(
  artifacts: PlaytestArtifactStore,
  reference: PlaytestArtifactReference | null
): {
  readonly bytes: Uint8Array | null;
  readonly omitReason: FrameOmitReason | null;
} {
  let bytes: Uint8Array | null = null;
  let omitReason: FrameOmitReason | null = null;
  if (!reference) {
    omitReason = "missing";
  } else if (FRAME_MEDIA_TYPES.has(reference.mediaType)) {
    try {
      bytes = artifacts.readArtifact(reference).bytes;
      if (reference.mediaType === "image/png" && !isPng(bytes)) {
        omitReason = "invalid-reference";
        bytes = null;
      }
    } catch {
      omitReason = "invalid-reference";
    }
  } else {
    omitReason = "unsupported-media";
  }
  return { bytes, omitReason };
}

/** The visible observation the trace recorded for one step. */
function readVisibleObservation(
  traceRow: TraceRow | undefined
): Record<string, unknown> | null {
  return traceRow && isRecord(traceRow.visibleObservation)
    ? traceRow.visibleObservation
    : null;
}

/** The viewport the trace recorded for one step. */
function readViewport(
  visibleObservation: Record<string, unknown> | null
): Record<string, unknown> | null {
  return visibleObservation && isRecord(visibleObservation.viewport)
    ? visibleObservation.viewport
    : null;
}

/** The capture timestamp the trace recorded for one step. */
function readCapturedAt(
  visibleObservation: Record<string, unknown> | null
): string | null {
  return visibleObservation && isoTimestamp(visibleObservation.capturedAt)
    ? visibleObservation.capturedAt
    : null;
}

/** Whether the recorded frame carries a redacted surface. */
function readFramePrivacy(observation: Record<string, unknown>): {
  readonly reason: PlaytestDiscoveryEvidenceFrame["reason"];
  readonly redactedSurfaces: readonly string[];
} {
  return observation.privacyState === "redacted"
    ? { reason: "redacted", redactedSurfaces: ["form surfaces"] }
    : { reason: "captured", redactedSurfaces: [] };
}

/** Every frame the episode recorded, in the order the episode recorded them. */
function collectFrameEvidence(input: {
  readonly episode: PlaytestEpisode;
  readonly artifacts: PlaytestArtifactStore;
  readonly traceRowsByStep: ReadonlyMap<number, TraceRow>;
}): FrameEvidence {
  const frameIdsByStep = new Map<number, string[]>();
  const frameHashes: Record<string, string> = {};
  const frames: PlaytestDiscoveryEvidenceFrame[] = [];
  const omittedFrames: {
    frameId: string;
    step: number;
    reason: PlaytestDiscoveryOmissionReason;
  }[] = [];
  const omittedArtifacts: PlaytestEvidenceOmittedArtifact[] = [];
  for (const episodeFrame of input.episode.frames) {
    if (episodeFrame.kind !== "frame" || episodeFrame.step === undefined)
      continue;
    const reference = input.artifacts.referenceForId(episodeFrame.id);
    const { bytes, omitReason } = readFrameArtifact(input.artifacts, reference);
    const traceRow = input.traceRowsByStep.get(episodeFrame.step);
    const visibleObservation = readVisibleObservation(traceRow);
    const viewport = readViewport(visibleObservation);
    const capturedAt = readCapturedAt(visibleObservation);
    if (
      bytes === null ||
      reference === null ||
      viewport === null ||
      capturedAt === null ||
      typeof viewport.width !== "number" ||
      typeof viewport.height !== "number" ||
      typeof viewport.deviceScaleFactor !== "number" ||
      viewport.width <= 0 ||
      viewport.height <= 0 ||
      viewport.deviceScaleFactor <= 0
    ) {
      const reason = omitReason ?? "invalid-reference";
      omittedFrames.push({
        frameId: episodeFrame.id,
        step: episodeFrame.step,
        reason
      });
      omittedArtifacts.push({
        kind: "frame",
        artifactId: episodeFrame.id,
        step: episodeFrame.step,
        reason
      });
      continue;
    }
    const observation = visibleObservation;
    if (!observation) continue;
    const privacy = readFramePrivacy(observation);
    const frame: PlaytestDiscoveryEvidenceFrame = {
      frameId: episodeFrame.id,
      step: episodeFrame.step,
      frameIndex: episodeFrame.frameIndex ?? episodeFrame.step,
      sha256: reference.sha256,
      capturedAt,
      captureWidthPx: Math.round(viewport.width * viewport.deviceScaleFactor),
      captureHeightPx: Math.round(viewport.height * viewport.deviceScaleFactor),
      visibleStateRef: null,
      reason: privacy.reason,
      redactedSurfaces: privacy.redactedSurfaces
    };
    frames.push(frame);
    frameHashes[frame.frameId] = frame.sha256;
    const ids = frameIdsByStep.get(frame.step) ?? [];
    ids.push(frame.frameId);
    frameIdsByStep.set(frame.step, ids);
  }
  return {
    frames,
    frameHashes,
    frameIdsByStep,
    omittedFrames,
    omittedArtifacts
  };
}

/** Only one terminal, persisted visual session can be reviewed. */
function assertTerminalVisualSession(input: {
  readonly workspaceId: string;
  readonly episode: PlaytestEpisode;
  readonly batch: PlaytestVisualBatch;
}): void {
  const { workspaceId, episode, batch } = input;
  if (
    batch.executionMode !== "autonomous-visual" ||
    batch.workspaceId !== workspaceId ||
    batch.assignmentInventory.status !== "frozen-visual" ||
    batch.reviewSelection.status !== "unavailable" ||
    batch.reviewSelection.reason !== "visual-discovery-session-level" ||
    batch.assignmentInventory.manifest.workspaceId !== workspaceId ||
    batch.assignmentInventory.manifest.batchId !== batch.batchId ||
    episode.identity.workspaceId !== workspaceId ||
    episode.batchId !== batch.batchId ||
    !episode.assignmentId ||
    episode.stepCount < 1 ||
    episode.status === "assigned" ||
    episode.status === "started"
  ) {
    throw new TypeError(
      "Visual discovery review requires one terminal, persisted visual session."
    );
  }
}

export function preparePlaytestDiscoveryEvidencePacket(input: {
  readonly workspaceId: string;
  readonly episode: PlaytestEpisode;
  readonly batch: PlaytestVisualBatch;
  readonly artifacts: PlaytestArtifactStore;
}): PreparedPlaytestDiscoveryPacket {
  const { workspaceId, episode, batch, artifacts } = input;
  assertTerminalVisualSession({ workspaceId, episode, batch });
  const manifest = batch.assignmentInventory.manifest;
  const assignment = manifest.assignments.find(
    (candidate) => candidate.assignmentId === episode.assignmentId
  );
  if (!assignment) {
    throw new TypeError(
      "Visual discovery episode is absent from its frozen assignment inventory."
    );
  }
  const trace = readTrace({ episode, artifacts });
  const traceRowsByStep = new Map(trace.rows.map((row) => [row.step, row]));
  const frameEvidence = collectFrameEvidence({
    episode,
    artifacts,
    traceRowsByStep
  });
  const { frames, frameHashes, frameIdsByStep } = frameEvidence;
  const { omittedFrames, omittedArtifacts } = frameEvidence;
  const stepEvidence = makeStepEvidence({
    episode,
    rows: trace.rows,
    frameIdsByStep
  });
  const packetId =
    "discovery-" +
    createHash("sha256")
      .update(
        canonicalPlaytestJson({
          episodeId: episode.episodeId,
          episodeRevision: episode.revision,
          batchId: batch.batchId,
          assignmentManifestHash: manifest.contentHash,
          traceHash: trace.reference.sha256,
          frameHashes
        })
      )
      .digest("hex");
  const generatedAt =
    episode.completedAt ?? episode.startedAt ?? episode.assignedAt;
  const packet = buildPlaytestDiscoveryEvidencePacket({
    packetId,
    episode,
    visualBatch: {
      batchId: batch.batchId,
      workspaceId,
      assignmentManifest: manifest
    },
    stepEvidence,
    frames,
    omittedFrames,
    omittedArtifacts,
    frameHashes,
    traceHash: trace.reference.sha256,
    measurementVersion: batch.measurementVersion,
    modelId: episode.identity.modelId,
    modelRevision: episode.identity.modelRevision,
    promptHash: null,
    tokenBudget: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MAX_TOKENS,
    chronologicalSummary:
      "Unscored visual discovery record for " +
      episode.episodeId +
      ": " +
      String(episode.stepCount) +
      " observed steps; terminal status " +
      episode.status +
      ".",
    generatedAt,
    maxPacketBytes: 262_144
  });
  assertPlaytestDiscoveryEvidencePacket(packet);
  const bytes = new TextEncoder().encode(canonicalPlaytestJson(packet));
  const artifact = artifacts.writeArtifact({
    artifactId: packet.packetId,
    mediaType: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
    bytes
  }).reference;
  const resolved = artifacts.referenceForId(artifact.artifactId);
  if (
    !resolved ||
    resolved.sha256 !== artifact.sha256 ||
    resolved.bytes !== artifact.bytes ||
    resolved.mediaType !== PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE
  ) {
    throw new TypeError(
      "Persisted discovery packet artifact failed integrity verification."
    );
  }
  return { packet, artifact };
}
