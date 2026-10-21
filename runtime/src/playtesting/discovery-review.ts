import { createHash } from "node:crypto";

import {
  assertPlaytestDiscoveryEvidencePacket,
  buildPlaytestDiscoveryEvidencePacket,
  canonicalPlaytestJson,
  type PlaytestArtifactReference,
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
    const rawPrediction = row.preActionPrediction;
    const prediction =
      isRecord(rawPrediction) &&
      typeof rawPrediction.intention === "string" &&
      typeof rawPrediction.predictedVisibleEffect === "string"
        ? {
            intention: rawPrediction.intention,
            predictedVisibleEffect: rawPrediction.predictedVisibleEffect
          }
        : null;
    const actionId =
      typeof row.selectedActionId === "string" ? row.selectedActionId : null;
    const legalActionIds = Array.isArray(row.legalActionIds)
      ? row.legalActionIds.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    const phaseId =
      typeof row.phaseId === "string"
        ? row.phaseId
        : typeof visibleObservation.phase === "string"
          ? visibleObservation.phase
          : null;
    const warnings = Array.isArray(visibleObservation.warnings)
      ? visibleObservation.warnings.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    const step = row.step;
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
    const receivedAt =
      outcome && isoTimestamp(outcome.dispatchedAt)
        ? outcome.dispatchedAt
        : outcome && isoTimestamp(outcome.receiptAt)
          ? outcome.receiptAt
          : isoTimestamp(visibleObservation.capturedAt)
            ? visibleObservation.capturedAt
            : null;
    let actionReceipt: PlaytestDiscoveryStepEvidence["actionReceipt"] = null;
    if (
      driverActionKind !== null &&
      receiptStatus !== null &&
      observationId !== null &&
      receivedAt !== null
    ) {
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
      const inputKind =
        driverActionKind === "activate-control"
          ? "semantic-control"
          : driverActionKind === "pointer-click"
            ? "screenshot-coordinate"
            : driverActionKind === "key-press"
              ? "safe-key"
              : "no-input";
      actionReceipt = {
        receiptId: input.episode.episodeId + ":step-" + String(step) + ":input",
        step,
        observationId,
        status: receiptStatus,
        refusalReason:
          outcome && typeof outcome.refusalReason === "string"
            ? outcome.refusalReason
            : null,
        selectedActionId: actionId,
        inputKind,
        controlId,
        safeKey,
        coordinates,
        intention: prediction?.intention ?? "No action intention was recorded.",
        predictedVisibleEffect:
          prediction?.predictedVisibleEffect ??
          "No predicted visible effect was recorded.",
        visibleConsequence:
          receiptStatus === "dispatched"
            ? { gameAcknowledgement: "not-observed" }
            : { status: "input-refused" },
        receivedAt
      };
    }
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

export function preparePlaytestDiscoveryEvidencePacket(input: {
  readonly workspaceId: string;
  readonly episode: PlaytestEpisode;
  readonly batch: PlaytestVisualBatch;
  readonly artifacts: PlaytestArtifactStore;
}): PreparedPlaytestDiscoveryPacket {
  const { workspaceId, episode, batch, artifacts } = input;
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
  const frameIdsByStep = new Map<number, string[]>();
  const frameHashes: Record<string, string> = {};
  const frames: PlaytestDiscoveryEvidenceFrame[] = [];
  const omittedFrames: {
    frameId: string;
    step: number;
    reason: PlaytestDiscoveryOmissionReason;
  }[] = [];
  const omittedArtifacts: PlaytestEvidenceOmittedArtifact[] = [];
  const traceRowsByStep = new Map(trace.rows.map((row) => [row.step, row]));
  for (const episodeFrame of episode.frames) {
    if (episodeFrame.kind !== "frame" || episodeFrame.step === undefined)
      continue;
    const reference = artifacts.referenceForId(episodeFrame.id);
    let bytes: Uint8Array | null = null;
    let omitReason: PlaytestDiscoveryOmissionReason | null = null;
    if (!reference) {
      omitReason = "missing";
    } else if (
      ["image/png", "image/jpeg", "image/webp"].includes(reference.mediaType)
    ) {
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
    const traceRow = traceRowsByStep.get(episodeFrame.step);
    const visibleObservation =
      traceRow && isRecord(traceRow.visibleObservation)
        ? traceRow.visibleObservation
        : null;
    const viewport =
      visibleObservation && isRecord(visibleObservation.viewport)
        ? visibleObservation.viewport
        : null;
    const capturedAt =
      visibleObservation && isoTimestamp(visibleObservation.capturedAt)
        ? visibleObservation.capturedAt
        : null;
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
      omitReason ??= "invalid-reference";
      omittedFrames.push({
        frameId: episodeFrame.id,
        step: episodeFrame.step,
        reason: omitReason
      });
      omittedArtifacts.push({
        kind: "frame",
        artifactId: episodeFrame.id,
        step: episodeFrame.step,
        reason: omitReason
      });
      continue;
    }
    const observation = visibleObservation;
    if (!observation) continue;
    const frame: PlaytestDiscoveryEvidenceFrame = {
      frameId: episodeFrame.id,
      step: episodeFrame.step,
      frameIndex: episodeFrame.frameIndex ?? episodeFrame.step,
      sha256: reference.sha256,
      capturedAt,
      captureWidthPx: Math.round(viewport.width * viewport.deviceScaleFactor),
      captureHeightPx: Math.round(viewport.height * viewport.deviceScaleFactor),
      visibleStateRef: null,
      reason: observation.privacyState === "redacted" ? "redacted" : "captured",
      redactedSurfaces:
        observation.privacyState === "redacted" ? ["form surfaces"] : []
    };
    frames.push(frame);
    frameHashes[frame.frameId] = frame.sha256;
    const ids = frameIdsByStep.get(frame.step) ?? [];
    ids.push(frame.frameId);
    frameIdsByStep.set(frame.step, ids);
  }
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
