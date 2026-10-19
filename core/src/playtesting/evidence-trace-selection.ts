/**
 * Game-neutral trace-window selection, budget enforcement, and evidence-
 * citation mechanics shared by every analyst evidence packet contract
 * (confirmatory adapter packets and discovery visual packets). This module
 * understands only trace steps, selection windows, and supplied/omitted
 * artifact bookkeeping; packet-kind-specific fields (rubric/metrics/
 * cross-session context) stay owned by their respective packet modules.
 */
import {
  type PlaytestEvidenceOmittedArtifact,
  type PlaytestEvidenceSuppliedArtifact,
  type PlaytestEvidenceTraceStep,
  type PlaytestEvidenceWindow,
  type PlaytestOmittedEvidenceWindow
} from "./artifacts.ts";
import { canonicalPlaytestJson } from "./canonical-json.ts";
import type { PlaytestEvidenceLocator } from "./types.ts";

export const EVIDENCE_SHA256_PATTERN = /^[a-f\d]{64}$/iu;
export const PLAYTEST_EVIDENCE_PACKET_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const MAX_EVIDENCE_PACKET_WINDOWS = 32;
export const MAX_EVIDENCE_PACKET_STEPS = 256;
export const MAX_EVIDENCE_PACKET_BYTES = 262_144;
const MAX_STEP_EVENTS = 256;
const SAMPLEABLE_ACTION_EVENT_TYPES = new Set([
  "decision_applied",
  "card_played",
  "race_started",
  "reward_claimed"
]);
const TRACE_STEP_KEYS = new Set([
  "step",
  "phaseId",
  "revisionBefore",
  "revisionAfter",
  "observationVisibility",
  "visibleObservation",
  "legalActionIds",
  "selectedActionId",
  "preActionPrediction",
  "authoritativeOutcome",
  "events",
  "frameRefs"
]);

/** Core-owned packet ID syntax shared by every packet, receipt and review. */
export function isPlaytestEvidencePacketId(value: unknown): value is string {
  return (
    typeof value === "string" && PLAYTEST_EVIDENCE_PACKET_ID_PATTERN.test(value)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isText(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    ![...value].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    })
  );
}

export function isCount(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  );
}

export function isJson(value: unknown, depth = 0): boolean {
  if (depth > 48) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((entry) => isJson(entry, depth + 1));
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isJson(entry, depth + 1))
  );
}

export function assertTraceStep(
  value: unknown,
  expectedStep: number
): asserts value is PlaytestEvidenceTraceStep {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== TRACE_STEP_KEYS.size ||
    Object.keys(value).some((key) => !TRACE_STEP_KEYS.has(key)) ||
    value.step !== expectedStep ||
    (value.phaseId !== null && !isText(value.phaseId)) ||
    !isCount(value.revisionBefore) ||
    (value.revisionAfter !== null && !isCount(value.revisionAfter)) ||
    (value.observationVisibility !== "structured" &&
      value.observationVisibility !== "visual-only") ||
    !isJson(value.visibleObservation) ||
    !Array.isArray(value.legalActionIds) ||
    value.legalActionIds.length > 256 ||
    value.legalActionIds.some((action) => !isText(action)) ||
    (value.selectedActionId !== null && !isText(value.selectedActionId)) ||
    (value.selectedActionId !== null &&
      !value.legalActionIds.includes(value.selectedActionId)) ||
    (value.preActionPrediction !== null &&
      !isJson(value.preActionPrediction)) ||
    (value.authoritativeOutcome !== null &&
      !isJson(value.authoritativeOutcome)) ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_STEP_EVENTS ||
    !Array.isArray(value.frameRefs)
  ) {
    throw new TypeError(
      "Evidence packet trace step is malformed or not player-visible."
    );
  }
  const eventIds = new Set<string>();
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      Object.keys(event).length !== 4 ||
      Object.keys(event).some(
        (key) => !["eventId", "type", "phaseId", "revision"].includes(key)
      ) ||
      !isText(event.eventId) ||
      !isText(event.type) ||
      (event.phaseId !== null && !isText(event.phaseId)) ||
      !isCount(event.revision) ||
      eventIds.has(event.eventId)
    ) {
      throw new TypeError(
        "Evidence packet trace event is malformed or duplicated."
      );
    }
    eventIds.add(event.eventId);
  }
  for (const reference of value.frameRefs) {
    if (
      !isRecord(reference) ||
      reference.kind !== "frame" ||
      !isText(reference.id) ||
      (reference.step !== undefined && reference.step !== expectedStep)
    ) {
      throw new TypeError(
        "Evidence packet contains an invalid frame reference."
      );
    }
  }
}

export interface SelectionRange {
  readonly startStep: number;
  readonly endStep: number;
  readonly reasons: ReadonlySet<
    "event-bearing-step" | "terminal" | "ordinary-sample"
  >;
  readonly mandatory: boolean;
}

export function mergeRanges(
  ranges: readonly SelectionRange[]
): SelectionRange[] {
  const sorted = [...ranges].sort(
    (left, right) =>
      left.startStep - right.startStep || left.endStep - right.endStep
  );
  const merged: SelectionRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (!last || range.startStep > last.endStep + 1) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = {
      startStep: last.startStep,
      endStep: Math.max(last.endStep, range.endStep),
      reasons: new Set([...last.reasons, ...range.reasons]),
      mandatory: last.mandatory || range.mandatory
    };
  }
  return merged;
}

export function rangeStepCount(ranges: readonly SelectionRange[]): number {
  return ranges.reduce(
    (total, range) => total + range.endStep - range.startStep + 1,
    0
  );
}

export function rangeAround(
  step: number,
  lastStep: number,
  radius: number,
  reason: "event-bearing-step" | "terminal" | "ordinary-sample",
  mandatory: boolean
): SelectionRange {
  return {
    startStep: Math.max(0, step - radius),
    endStep: Math.min(lastStep, step + radius),
    reasons: new Set([reason]),
    mandatory
  };
}

/**
 * Generic decision/card-play events and checked-in lifecycle transitions
 * repeat actions/state changes already carried by trace steps. Keep those
 * lines sampleable; outcome events and other game-specific events remain
 * packet anchors because they carry evidence not represented by the action.
 */
export function hasMandatoryEventEvidence(
  entry: PlaytestEvidenceTraceStep
): boolean {
  return entry.events.some(
    (event) => !SAMPLEABLE_ACTION_EVENT_TYPES.has(event.type)
  );
}

export function hasMandatoryEventEvidenceValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.events) &&
    value.events.some(
      (event) =>
        isRecord(event) &&
        !SAMPLEABLE_ACTION_EVENT_TYPES.has(String(event.type))
    )
  );
}

export function initiallySelectedRanges(
  trace: readonly PlaytestEvidenceTraceStep[],
  limits: {
    readonly maxWindows: number;
    readonly maxSteps: number;
    readonly radius: number;
  }
): SelectionRange[] {
  const lastStep = trace.at(-1)!.step;
  const mandatoryAnchors = trace
    .filter(hasMandatoryEventEvidence)
    .map((entry) =>
      rangeAround(entry.step, lastStep, 0, "event-bearing-step", true)
    );
  mandatoryAnchors.push(
    rangeAround(lastStep, lastStep, limits.radius, "terminal", true)
  );
  let selected = mergeRanges(mandatoryAnchors);
  if (
    selected.length > limits.maxWindows ||
    rangeStepCount(selected) > limits.maxSteps
  ) {
    throw new RangeError(
      "Mandatory event and terminal evidence exceeds the packet budget."
    );
  }

  const covered = new Set<number>();
  for (const range of selected) {
    for (let step = range.startStep; step <= range.endStep; step += 1)
      covered.add(step);
  }
  const ordinary = trace.filter(
    (entry) => !hasMandatoryEventEvidence(entry) && !covered.has(entry.step)
  );
  const remainingSlots = Math.max(0, limits.maxWindows - selected.length);
  const candidateCount = Math.min(ordinary.length, remainingSlots);
  for (let index = 0; index < candidateCount; index += 1) {
    const position = Math.floor(
      ((index + 0.5) * ordinary.length) / candidateCount
    );
    const candidate = ordinary[position];
    if (!candidate) continue;
    const ordinaryRange = rangeAround(
      candidate.step,
      lastStep,
      limits.radius,
      "ordinary-sample",
      false
    );
    if (
      selected.some(
        (range) =>
          ordinaryRange.startStep <= range.endStep &&
          ordinaryRange.endStep >= range.startStep
      )
    ) {
      continue;
    }
    const proposed = mergeRanges([...selected, ordinaryRange]);
    if (
      proposed.length <= limits.maxWindows &&
      rangeStepCount(proposed) <= limits.maxSteps
    ) {
      selected = proposed;
    }
  }
  return selected;
}

export function omittedWindowsFor(input: {
  readonly trace: readonly PlaytestEvidenceTraceStep[];
  readonly ranges: readonly SelectionRange[];
  readonly packetBudgetOmissions: ReadonlySet<number>;
}): readonly PlaytestOmittedEvidenceWindow[] {
  const selected = new Set<number>();
  for (const range of input.ranges) {
    for (let step = range.startStep; step <= range.endStep; step += 1)
      selected.add(step);
  }
  const omitted: PlaytestOmittedEvidenceWindow[] = [];
  for (const entry of input.trace) {
    if (selected.has(entry.step)) continue;
    const reason = input.packetBudgetOmissions.has(entry.step)
      ? "packet-budget"
      : "ordinary-sampling";
    const previous = omitted.at(-1);
    if (
      previous &&
      previous.endStep + 1 === entry.step &&
      previous.reason === reason
    ) {
      omitted[omitted.length - 1] = { ...previous, endStep: entry.step };
    } else {
      omitted.push({ startStep: entry.step, endStep: entry.step, reason });
    }
  }
  return omitted;
}

export function selectedWindowsFrom(
  trace: readonly PlaytestEvidenceTraceStep[],
  ranges: readonly SelectionRange[]
): readonly PlaytestEvidenceWindow[] {
  return ranges.map((range) => ({
    startStep: range.startStep,
    endStep: range.endStep,
    selectionReasons: [...range.reasons].sort(),
    steps: trace.slice(range.startStep, range.endStep + 1)
  }));
}

export function suppliedArtifactsFor(input: {
  readonly windows: readonly PlaytestEvidenceWindow[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly traceArtifactId: string;
  readonly traceHash: string;
}): readonly PlaytestEvidenceSuppliedArtifact[] {
  const artifacts = new Map<string, PlaytestEvidenceSuppliedArtifact>([
    [
      "trace:" + input.traceArtifactId,
      {
        kind: "trace",
        artifactId: input.traceArtifactId,
        sha256: input.traceHash.toLowerCase()
      }
    ]
  ]);
  for (const window of input.windows) {
    for (const step of window.steps) {
      for (const reference of step.frameRefs) {
        const hash = input.hashes[reference.id];
        if (hash !== undefined) {
          artifacts.set("frame:" + reference.id, {
            kind: "frame",
            artifactId: reference.id,
            sha256: hash.toLowerCase()
          });
        }
      }
    }
  }
  return [...artifacts.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    if (left.artifactId === right.artifactId) return 0;
    return left.artifactId < right.artifactId ? -1 : 1;
  });
}

/** Conservative UTF-8 byte length of any canonical Playtest JSON value. */
export function packetContentBytes(value: object): number {
  return new TextEncoder().encode(canonicalPlaytestJson(value)).byteLength;
}

export interface EvidenceWindowLimits {
  readonly maxWindows: number;
  readonly maxSelectedSteps: number;
  readonly radius: number;
}

/** Shared bound/default resolution for every packet builder's selection knobs. */
export function resolveEvidenceWindowLimits(input: {
  readonly maxWindows?: number;
  readonly maxSelectedSteps?: number;
  readonly windowRadius?: number;
}): EvidenceWindowLimits {
  const maxWindows = input.maxWindows ?? 16;
  const maxSelectedSteps = input.maxSelectedSteps ?? 128;
  const radius = input.windowRadius ?? 1;
  if (
    !isCount(maxWindows, MAX_EVIDENCE_PACKET_WINDOWS) ||
    maxWindows < 1 ||
    !isCount(maxSelectedSteps, MAX_EVIDENCE_PACKET_STEPS) ||
    maxSelectedSteps < 1 ||
    !isCount(radius, 4)
  ) {
    throw new RangeError(
      "Evidence packet selection limits are outside their approved bounds."
    );
  }
  return { maxWindows, maxSelectedSteps, radius };
}

/**
 * Shared window-selection/budget loop: builds the smallest packet value that
 * fits the byte/token budget by shrinking non-mandatory ordinary-sample
 * windows first. Mandatory event-bearing and terminal evidence is never
 * dropped; if it alone exceeds the budget, this throws.
 */
export function buildBoundedEvidenceWindows<TPacket extends object>(input: {
  readonly traceSteps: readonly PlaytestEvidenceTraceStep[];
  readonly limits: EvidenceWindowLimits;
  readonly packetByteBudget: number;
  readonly tokenBudget: number;
  readonly buildValue: (
    windows: readonly PlaytestEvidenceWindow[],
    omitted: readonly PlaytestOmittedEvidenceWindow[]
  ) => TPacket;
}): TPacket {
  let ranges = initiallySelectedRanges(input.traceSteps, {
    maxWindows: input.limits.maxWindows,
    maxSteps: input.limits.maxSelectedSteps,
    radius: input.limits.radius
  });
  const packetBudgetOmissions = new Set<number>();
  let omitted = omittedWindowsFor({
    trace: input.traceSteps,
    ranges,
    packetBudgetOmissions
  });
  while (true) {
    const windows = selectedWindowsFrom(input.traceSteps, ranges);
    const packet = input.buildValue(windows, omitted);
    const bytes = packetContentBytes(packet);
    if (bytes <= input.packetByteBudget && bytes <= input.tokenBudget) {
      return packet;
    }
    const removable = [...ranges]
      .reverse()
      .find(
        (range) => !range.mandatory && range.reasons.has("ordinary-sample")
      );
    if (!removable) {
      throw new RangeError(
        "Mandatory event and terminal evidence exceeds the analyst packet byte/token budget."
      );
    }
    for (let step = removable.startStep; step <= removable.endStep; step += 1) {
      packetBudgetOmissions.add(step);
    }
    ranges = ranges.filter((range) => range !== removable);
    omitted = omittedWindowsFor({
      trace: input.traceSteps,
      ranges,
      packetBudgetOmissions
    });
  }
}

export function assertUniqueTraceEventIds(
  steps: readonly PlaytestEvidenceTraceStep[],
  eventIds = new Set<string>()
): void {
  for (const step of steps) {
    for (const event of step.events) {
      if (eventIds.has(event.eventId)) {
        throw new TypeError(
          "Playtest evidence packet contains a duplicate event ID."
        );
      }
      eventIds.add(event.eventId);
    }
  }
}

export function assertUniqueSelectedEventIds(
  windows: readonly PlaytestEvidenceWindow[]
): void {
  const eventIds = new Set<string>();
  for (const window of windows) {
    assertUniqueTraceEventIds(window.steps, eventIds);
  }
}

/** Structural view shared by every packet kind that supports evidence citation. */
export interface PlaytestEvidencePacketLocatorView {
  readonly episodeId: string;
  readonly traceArtifactId: string;
  readonly selectedWindows: readonly PlaytestEvidenceWindow[];
  readonly crossSessionContext?: {
    readonly status: "included" | "unavailable";
    readonly sessions?: readonly { readonly episodeId: string }[];
  };
}

interface EvidencePacketLocatorIndex {
  readonly selectedSteps: ReadonlySet<number>;
  readonly events: ReadonlyMap<
    string,
    {
      readonly event: PlaytestEvidenceTraceStep["events"][number];
      readonly step: number;
    }
  >;
  readonly frames: ReadonlyMap<string, PlaytestEvidenceLocator>;
}

function evidencePacketLocatorIndex(
  packet: PlaytestEvidencePacketLocatorView
): EvidencePacketLocatorIndex {
  const selectedSteps = new Set<number>();
  const events = new Map<
    string,
    {
      readonly event: PlaytestEvidenceTraceStep["events"][number];
      readonly step: number;
    }
  >();
  const frames = new Map<string, PlaytestEvidenceLocator>();
  for (const window of packet.selectedWindows) {
    for (const step of window.steps) {
      selectedSteps.add(step.step);
      for (const event of step.events) {
        events.set(event.eventId, { event, step: step.step });
      }
      for (const frame of step.frameRefs) frames.set(frame.id, frame);
    }
  }
  return { selectedSteps, events, frames };
}

function assertEpisodeLocatorWithinPacket(
  locator: PlaytestEvidenceLocator,
  packet: PlaytestEvidencePacketLocatorView,
  selectedSteps: ReadonlySet<number>
): void {
  if (locator.id === packet.episodeId) {
    if (locator.step !== undefined && !selectedSteps.has(locator.step)) {
      throw new TypeError(
        "Review episode locator points outside the selected evidence packet."
      );
    }
    return;
  }
  const siblingEpisodes =
    packet.crossSessionContext !== undefined &&
    packet.crossSessionContext.status === "included"
      ? (packet.crossSessionContext.sessions ?? [])
      : [];
  if (
    !siblingEpisodes.some((episode) => episode.episodeId === locator.id) ||
    locator.step !== undefined ||
    locator.revision !== undefined ||
    locator.frameIndex !== undefined ||
    locator.phaseId !== undefined
  ) {
    throw new TypeError(
      "Review episode locator points outside the selected evidence packet or cites a sibling at unsupported granularity."
    );
  }
}

function assertReplayLocatorWithinPacket(
  locator: PlaytestEvidenceLocator,
  packet: PlaytestEvidencePacketLocatorView,
  selectedSteps: ReadonlySet<number>
): void {
  if (
    locator.id !== packet.traceArtifactId ||
    (locator.step !== undefined && !selectedSteps.has(locator.step))
  ) {
    throw new TypeError(
      "Review replay locator points outside the selected evidence packet."
    );
  }
}

function assertEventLocatorWithinPacket(
  locator: PlaytestEvidenceLocator,
  events: EvidencePacketLocatorIndex["events"]
): void {
  if (locator.kind !== "event") return;
  const event = events.get(locator.id);
  if (
    !event ||
    (locator.step !== undefined && locator.step !== event.step) ||
    (locator.revision !== undefined &&
      locator.revision !== event.event.revision) ||
    (locator.phaseId !== undefined && locator.phaseId !== event.event.phaseId)
  ) {
    throw new TypeError(
      "Review event locator is absent from the selected evidence packet."
    );
  }
}

function assertFrameLocatorWithinPacket(
  locator: PlaytestEvidenceLocator,
  frames: EvidencePacketLocatorIndex["frames"]
): void {
  if (locator.kind !== "frame") return;
  const frame = frames.get(locator.id);
  if (
    !frame ||
    (locator.step !== undefined && locator.step !== frame.step) ||
    (locator.frameIndex !== undefined &&
      locator.frameIndex !== frame.frameIndex)
  ) {
    throw new TypeError(
      "Review frame locator is absent from the selected evidence packet."
    );
  }
}

/** Keep analyst citations within the exact packet delivered for this review. */
export function assertPlaytestEvidenceLocatorsWithinPacket(
  values: readonly PlaytestEvidenceLocator[],
  packet: PlaytestEvidencePacketLocatorView
): void {
  const index = evidencePacketLocatorIndex(packet);
  for (const locator of values) {
    switch (locator.kind) {
      case "episode": {
        assertEpisodeLocatorWithinPacket(locator, packet, index.selectedSteps);
        break;
      }
      case "replay-segment": {
        assertReplayLocatorWithinPacket(locator, packet, index.selectedSteps);
        break;
      }
      case "event": {
        assertEventLocatorWithinPacket(locator, index.events);
        break;
      }
      case "frame": {
        assertFrameLocatorWithinPacket(locator, index.frames);
        break;
      }
      default: {
        throw new TypeError(
          "Review packet citations may reference only the delivered episode, replay, event and frame evidence."
        );
      }
    }
  }
}

/** Structural view used by supplied/omitted artifact provenance checks. */
export interface PlaytestEvidencePacketArtifactView {
  readonly traceArtifactId: string;
  readonly selectedWindows: readonly PlaytestEvidenceWindow[];
  readonly suppliedArtifacts: readonly PlaytestEvidenceSuppliedArtifact[];
}

export function assertPacketArtifactProvenance(
  packet: PlaytestEvidencePacketArtifactView
): void {
  const expectedFrames = new Set<string>();
  for (const window of packet.selectedWindows) {
    for (const step of window.steps) {
      for (const reference of step.frameRefs) expectedFrames.add(reference.id);
    }
  }
  const frameIds = new Set<string>();
  let traceCount = 0;
  for (const artifact of packet.suppliedArtifacts) {
    if (
      !isRecord(artifact) ||
      Object.keys(artifact).length !== 3 ||
      Object.keys(artifact).some(
        (key) => !["kind", "artifactId", "sha256"].includes(key)
      ) ||
      !isText(artifact.artifactId) ||
      typeof artifact.sha256 !== "string" ||
      !EVIDENCE_SHA256_PATTERN.test(artifact.sha256)
    ) {
      throw new TypeError(
        "Evidence packet supplied-artifact provenance is invalid."
      );
    }
    if (artifact.kind === "trace") {
      traceCount += 1;
      if (artifact.artifactId !== packet.traceArtifactId) {
        throw new TypeError(
          "Evidence packet trace artifact identity is inconsistent."
        );
      }
    } else if (artifact.kind === "frame") {
      if (
        !expectedFrames.has(artifact.artifactId) ||
        frameIds.has(artifact.artifactId)
      ) {
        throw new TypeError(
          "Evidence packet frame artifact identity is inconsistent."
        );
      }
      frameIds.add(artifact.artifactId);
    } else {
      throw new TypeError(
        "Evidence packet supplied artifact kind is unsupported."
      );
    }
  }
  if (
    traceCount !== 1 ||
    frameIds.size !== expectedFrames.size ||
    [...expectedFrames].some((frameId) => !frameIds.has(frameId))
  ) {
    throw new TypeError(
      "Evidence packet does not bind every supplied trace and frame."
    );
  }
}

/** Structural view used by the omitted-artifact provenance check. */
export interface PlaytestEvidencePacketOmittedArtifactView {
  readonly suppliedArtifacts: readonly PlaytestEvidenceSuppliedArtifact[];
  readonly omittedArtifacts: readonly PlaytestEvidenceOmittedArtifact[];
}

export function assertOmittedPacketArtifacts(
  packet: PlaytestEvidencePacketOmittedArtifactView
): void {
  const suppliedFrameIds = new Set(
    packet.suppliedArtifacts
      .filter((artifact) => artifact.kind === "frame")
      .map((artifact) => artifact.artifactId)
  );
  const omittedIds = new Set<string>();
  for (const artifact of packet.omittedArtifacts) {
    if (
      artifact.kind !== "frame" ||
      !isText(artifact.artifactId) ||
      !isCount(artifact.step) ||
      ![
        "missing",
        "expired",
        "invalid-reference",
        "unsupported-media"
      ].includes(artifact.reason) ||
      suppliedFrameIds.has(artifact.artifactId) ||
      omittedIds.has(artifact.artifactId)
    ) {
      throw new TypeError(
        "Evidence packet omitted-artifact record is malformed."
      );
    }
    omittedIds.add(artifact.artifactId);
  }
}
