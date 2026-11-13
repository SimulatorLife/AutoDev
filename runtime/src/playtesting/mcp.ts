/** Runtime-hosted Playtesting MCP server implementation. */
import { createHash, randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertPlaytestAdapterEpisode,
  assertPlaytestCrossSessionMetricAggregation,
  assertPlaytestCrossSessionSynthesis,
  assertPlaytestDiscoveryReviewDraft,
  assertPlaytestDiscoveryReviewGroundedInPacket,
  assertPlaytestDiscoverySessionReview,
  assertPlaytestEvidenceLocatorsWithinPacket,
  assertPlaytestFindingEvidenceStatusConsistent,
  assertPlaytestReviewNarrativeGroundedInPacket,
  assertPlaytestReviewNarrativeMinimums,
  assertPlaytestSessionReviewHasEvidence,
  buildPlaytestFindingIdentity,
  buildPlaytestIssueDrafts,
  canonicalPlaytestJson,
  type PlaytestAdapterBatch,
  type PlaytestBenchmark,
  type PlaytestCrossSessionClaim,
  type PlaytestCrossSessionExperiment,
  type PlaytestCrossSessionSynthesis,
  type PlaytestDimensionAnchor,
  type PlaytestDiscoveryReviewDraft,
  type PlaytestDiscoverySessionReview,
  type PlaytestEpisode,
  type PlaytestEvidenceLocator,
  type PlaytestEvidencePacket,
  type PlaytestFinding,
  type PlaytestFindingIdentity,
  playtestFindingIdentityHashInput,
  playtestFindingIdFromFingerprint,
  type PlaytestIssueDraft,
  playtestIssueReportingRefusal,
  type PlaytestKnownEvidenceIndex,
  type PlaytestReviewCompleteness,
  type PlaytestReviewReceipt,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EPISODE_STATES,
  PLAYTESTS_FINDING_STATUSES,
  PLAYTESTS_GAME_OUTCOMES,
  PLAYTESTS_MAX_ANALYSIS_SESSIONS,
  PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS,
  PLAYTESTS_MEASUREMENT_VERSION,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_SEVERITIES,
  PLAYTESTS_VERIFICATION_STAGES,
  type PlaytestSessionReview,
  scorePlaytestDimensionAnchor,
  triagePlaytestFindings
} from "@simulatorlife/autodev-core";
import { z } from "zod/v4";

import { mapConcurrentOrdered } from "../shared/map-concurrent-ordered.ts";
import { writeErrorLine } from "../shared/output.ts";
import {
  type PlaytestArtifactStore,
  type PlaytestArtifactWindowReadResult
} from "./artifact-store.ts";
import { standardizePlaytestCohorts } from "./cohort-standardization-run.ts";
import { preparePlaytestSandbox } from "./docker-sandbox.ts";
import {
  playtestBranchLaunchRequestSchema,
  playtestLaunchRequestSchema
} from "./launch-request-schema.ts";
import { derivePlaytestPolicyValidity } from "./policy-validity-run.ts";
import {
  ANALYSIS_READER_ROLES,
  assertPlaytestToolRole,
  authorizeWorkspace,
  CROSS_SESSION_PACKET_READER_ROLES,
  LAUNCH_INTENT_REQUEST_ID_PATTERN,
  OWNER_DECISION_ROLES,
  PLAYTEST_ADAPTER_MODE,
  PLAYTEST_REPLAY_SEGMENT_KIND,
  type PlaytestingRepositoryOps,
  PlaytestMcpAuthorizationError,
  PlaytestMcpConflictError,
  playtestMcpErrorDetails,
  type PlaytestMcpSession,
  PlaytestMcpUnavailableError,
  PlaytestMcpValidationError,
  PlaytestReviewGroundingValidationError,
  PlaytestReviewNarrativeValidationError,
  type PlaytestRunControl,
  type PlaytestRunControlOptions,
  readPreparedReviewPacket,
  requiredRunRepository,
  REVIEWER_ROLE,
  RUN_STATUS_READER_ROLES,
  RUNTIME_VERSION,
  SHA256_PATTERN,
  withAssignmentLock
} from "./run-control.ts";

function preparedAnalystPacketCacheKey(
  session: PlaytestMcpSession,
  workspaceId: string,
  episodeId: string
): string | null {
  return session.role === REVIEWER_ROLE && session.analysisId
    ? JSON.stringify([workspaceId, session.analysisId, episodeId])
    : null;
}

export interface PlaytestMcpSessionProvider {
  current(): Promise<PlaytestMcpSession> | PlaytestMcpSession;
}

export type PlaytestMcpServer = McpServer & {
  readonly playtestRunControl: PlaytestRunControl | null;
};

export interface PlaytestMcpOptions extends PlaytestRunControlOptions {
  readonly sessionProvider: PlaytestMcpSessionProvider;
  /**
   * Process-shared Runtime owner; the MCP facade never creates another
   * scheduler. Null only for the analyst, whose allowlisted packet/review tools
   * use the workspace-bound repository and do not call run control.
   */
  readonly playtestRunControl: PlaytestRunControl | null;
}

function requirePlaytestRunControl(
  control: PlaytestRunControl | null
): PlaytestRunControl {
  if (!control) {
    throw new PlaytestMcpUnavailableError(
      "The Runtime Playtesting run owner is unavailable to this MCP role."
    );
  }
  return control;
}
const FINDING_READER_ROLES = new Set([
  "root",
  "orchestrator",
  "validator",
  "operator"
]);
const MAX_FINDINGS_PER_REVIEW = 64;
const FINDING_APPEND_CONCURRENCY = 4;
const REVIEW_NARRATIVE_WORD_SEPARATOR_PATTERN = /\s+/u;
const REVIEWABLE_STATUSES = ["hypothesis", "not observed"] as const;

function isReviewerRole(role: string): role is typeof REVIEWER_ROLE {
  return role === REVIEWER_ROLE;
}

function assertAnalystEpisodeSelected(
  session: PlaytestMcpSession,
  episodeId: string,
  toolName: string
): void {
  if (!isReviewerRole(session.role)) return;
  if (!session.selectedEpisodeIds?.includes(episodeId)) {
    throw new PlaytestMcpAuthorizationError(
      `${toolName} is limited to the sessions selected by Runtime for this analyst task.`
    );
  }
}

const evidenceLocatorSchema = z.strictObject({
  kind: z.enum([
    "episode",
    "event",
    "frame",
    "review",
    "finding",
    "comparison",
    PLAYTEST_REPLAY_SEGMENT_KIND
  ]),
  id: z.string().min(1).max(256),
  step: z.number().int().min(0).optional(),
  revision: z.number().int().min(0).optional(),
  frameIndex: z.number().int().min(0).optional(),
  phaseId: z.string().max(256).optional()
});

/**
 * Strict finding input. Caller-supplied event types, episode scope, IDs,
 * fingerprints, and revisions are rejected: Runtime derives event types
 * from cited persisted trace entries and derives scope from the stored
 * episode. Only the proposed mechanic/action/witness and descriptive
 * finding content cross this boundary. Workflow state, prevalence,
 * cohorts, external links and verification dates are supplied only by their
 * source-owning Runtime/Data workflows.
 */
const findingIdentityFailureSignatureSchema = z.strictObject({
  action: z.string().min(1).max(200).nullable().optional(),
  witness: z.string().min(1).max(200)
});

const findingIdentityInputSchema = z.strictObject({
  mechanicKey: z.string().min(1).max(200),
  failureSignature: findingIdentityFailureSignatureSchema
});

const findingSchema = z.strictObject({
  identity: findingIdentityInputSchema,
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(10_000),
  evidenceStatus: z.literal("hypothesis"),
  evidenceRefs: z.array(evidenceLocatorSchema)
});

const reviewDimensionEvidenceSchema = z.strictObject({
  dimensionId: z.string().min(1).max(128),
  rationale: z.string().min(1).max(4000),
  evidenceRefs: z.array(evidenceLocatorSchema).max(64).default([]),
  counterexampleId: z.string().min(1).max(256).optional()
});

const reviewClaimSchema = z.strictObject({
  text: z.string().min(1).max(4000),
  evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
});

const crossSessionEvidenceRefSchema = z.strictObject({
  episodeId: z.string().min(1).max(256),
  packetId: z.string().min(1).max(128),
  locator: evidenceLocatorSchema
});

const crossSessionClaimSchema = z.strictObject({
  kind: z.enum(["pattern", "counterexample", "confounder"]),
  text: z.string().min(1).max(8000),
  evidenceRefs: z.array(crossSessionEvidenceRefSchema).min(1).max(64)
});

const crossSessionExperimentSchema = z.strictObject({
  hypothesis: z.string().min(1).max(4000),
  falsifier: z.string().min(1).max(4000),
  metricId: z.string().min(1).max(256),
  controls: z.array(z.string().min(1).max(4000)).min(1).max(16),
  budget: z.string().min(1).max(4000),
  evidenceRefs: z.array(crossSessionEvidenceRefSchema).min(1).max(64)
});

const reviewCompletenessSchema = z.strictObject({
  crossSessionContext: z.union([
    z.strictObject({
      status: z.literal("available"),
      evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(4)
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: z.string().min(1).max(2000)
    })
  ]),
  alternatives: z.union([
    z.strictObject({ status: z.literal("provided") }),
    z.strictObject({
      status: z.literal("none-identified"),
      reason: z.string().min(1).max(2000)
    })
  ]),
  experiments: z.union([
    z.strictObject({ status: z.literal("proposed") }),
    z.strictObject({
      status: z.literal("none-recommended"),
      reason: z.string().min(1).max(2000)
    })
  ]),
  followUp: z.union([
    z.strictObject({
      status: z.literal("proposed"),
      text: z.string().min(1).max(4000)
    }),
    z.strictObject({
      status: z.literal("none"),
      reason: z.string().min(1).max(2000)
    })
  ])
});

function playtestEvidenceLocatorFromInput(
  locator: z.infer<typeof evidenceLocatorSchema>
): PlaytestEvidenceLocator {
  return {
    kind: locator.kind,
    id: locator.id,
    ...(locator.step === undefined ? {} : { step: locator.step }),
    ...(locator.revision === undefined ? {} : { revision: locator.revision }),
    ...(locator.frameIndex === undefined
      ? {}
      : { frameIndex: locator.frameIndex }),
    ...(locator.phaseId === undefined ? {} : { phaseId: locator.phaseId })
  };
}

const reviewExperimentSchema = z.strictObject({
  hypothesis: z.string().min(1).max(4000),
  falsifier: z.string().min(1).max(4000),
  metricId: z.string().min(1).max(256),
  controls: z.array(z.string().min(1).max(1000)).min(1).max(32),
  budget: z.string().min(1).max(1000)
});

/**
 * §11's missed-known-issue / duplicate-flood gate lives here: the stable
 * `findingId` is derived from the SHA-256 fingerprint of the canonical
 * identity (not from anything a caller controls), so the same underlying
 * defect across builds/policies/seed/batches deterministically produces the
 * same finding ID. Prefix is fixed so Data/Console can recognize the
 * namespace without parsing the hash.
 */
function deriveStableFindingId(fingerprint: string): string {
  if (!SHA256_PATTERN.test(fingerprint)) {
    throw new PlaytestMcpValidationError(
      "Computed fingerprint is not a SHA-256 hexadecimal digest."
    );
  }
  return playtestFindingIdFromFingerprint(fingerprint);
}

/**
 * Compute the SHA-256 fingerprint over `playtestFindingIdentityHashInput`.
 * Runtime owns the actual hashing; Core never computes the digest itself,
 * matching the division of responsibility used by `playtestBenchmarkHashInput`
 * in `core/src/playtesting/benchmark.ts`.
 */
function computeFindingFingerprint(identity: PlaytestFindingIdentity): string {
  return createHash("sha256")
    .update(playtestFindingIdentityHashInput(identity))
    .digest("hex");
}

/** JSON-stable key for a locator used by the duplicate-flood merge. */
function evidenceLocatorKey(locator: PlaytestEvidenceLocator): string {
  const parts = [
    locator.kind,
    locator.id,
    locator.step ?? "",
    locator.frameIndex ?? "",
    locator.phaseId ?? "",
    "stepIndex" in locator ? String(locator.stepIndex ?? "") : "",
    "frameIndex" in locator ? String(locator.frameIndex ?? "") : ""
  ];
  return JSON.stringify(parts);
}

function unionEvidenceRefs(
  a: readonly PlaytestEvidenceLocator[],
  b: readonly PlaytestEvidenceLocator[]
): readonly PlaytestEvidenceLocator[] {
  const seen = new Map<string, PlaytestEvidenceLocator>();
  for (const locator of a) seen.set(evidenceLocatorKey(locator), locator);
  for (const locator of b) seen.set(evidenceLocatorKey(locator), locator);
  // Filter out any locator-derived artifacts whose `frameIndex` is set to
  // `undefined` (allowed in zod's input, forbidden by
  // exactOptionalPropertyTypes in the canonical type).
  return [...seen.values()].filter(
    (locator) =>
      !("frameIndex" in locator) || typeof locator.frameIndex === "number"
  );
}

function unionStringSet(
  a: readonly string[],
  b: readonly string[]
): readonly string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Per-(workspace, fingerprint) in-process serialization point for finding
 * writes. The MCP server reads the latest revision and persists the
 * resulting append inside the SAME critical section keyed by
 * `workspaceId::fingerprint`, so two concurrent submitReview calls that
 * resolve to the same identity can never both observe the same "latest
 * version" and race to insert a colliding revision. ClickHouse does NOT
 * enforce cross-process uniqueness of `(workspace_id, fingerprint,
 * version)` -- a distributed Runtime would still need a coordinating
 * store (e.g. a lease table or a single-writer queue) to guarantee it;
 * this in-process map only guarantees ordering within one Runtime
 * process. Completed chains are removed from the map once settled so it
 * never grows unbounded across the process lifetime.
 */
const findingAppendLocks = new Map<string, Promise<unknown>>();
const batchReviewLocks = new Map<string, Promise<unknown>>();
const crossSessionSynthesisLocks = new Map<string, Promise<void>>();

function serializeBatchReview<T>(
  workspaceId: string,
  batchId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([workspaceId, batchId]);
  const previous = batchReviewLocks.get(key) ?? Promise.resolve();
  const settled = previous.catch(() => undefined).then(operation);
  const tracked = settled.then(
    () => undefined,
    () => undefined
  );
  batchReviewLocks.set(key, tracked);
  void tracked.then(() => {
    if (batchReviewLocks.get(key) === tracked) batchReviewLocks.delete(key);
    return undefined;
  });
  return settled;
}

type PlaytestReviewReceiptInput = Omit<PlaytestReviewReceipt, "status">;

function assertReviewReceiptMatchesBatch(
  batch: PlaytestAdapterBatch,
  receipt: PlaytestReviewReceiptInput
): void {
  if (batch.reviewSelection.status !== "selected") {
    throw new PlaytestMcpValidationError(
      "The batch has no frozen critique selection."
    );
  }
  if (
    !batch.reviewPackets.some(
      (packet) =>
        packet.status === "prepared" &&
        packet.packetId === receipt.packetId &&
        packet.assignmentId === receipt.assignmentId &&
        packet.episodeId === receipt.episodeId
    )
  ) {
    throw new PlaytestMcpUnavailableError(
      "The review receipt has no matching persisted evidence packet."
    );
  }
  if (
    !batch.reviewSelection.selected.some(
      (selected) =>
        selected.assignmentId === receipt.assignmentId &&
        selected.episodeId === receipt.episodeId
    )
  ) {
    throw new PlaytestMcpAuthorizationError(
      "The review receipt does not match a selected session."
    );
  }
}

async function reserveBatchReviewReceipt(
  batch: PlaytestAdapterBatch,
  receipt: PlaytestReviewReceiptInput,
  repository: PlaytestingRepositoryOps
): Promise<PlaytestAdapterBatch> {
  const existing = batch.reviewReceipts.find(
    (entry) => entry.reviewId === receipt.reviewId
  );
  if (existing) {
    if (
      existing.packetId !== receipt.packetId ||
      existing.assignmentId !== receipt.assignmentId ||
      existing.episodeId !== receipt.episodeId
    ) {
      throw new PlaytestMcpUnavailableError(
        "The review id already has a conflicting packet receipt."
      );
    }
    return batch;
  }
  if (batch.reviewSelection.status !== "selected") {
    throw new PlaytestMcpValidationError(
      "The batch has no frozen critique selection."
    );
  }
  assertReviewReceiptMatchesBatch(batch, receipt);
  const reserved = batch.reviewReceipts.filter(
    (entry) => entry.status === "reserved"
  ).length;
  if (
    batch.budget.actualCritiques + reserved >=
    batch.reviewSelection.reviewCap
  ) {
    throw new PlaytestMcpValidationError(
      "The frozen batch critique budget is exhausted."
    );
  }
  const updated: PlaytestAdapterBatch = {
    ...batch,
    revision: batch.revision + 1,
    reviewReceipts: [
      ...batch.reviewReceipts,
      { ...receipt, status: "reserved" }
    ]
  };
  await repository.insertBatch(updated);
  return updated;
}

async function persistBatchReviewReceipt(
  batch: PlaytestAdapterBatch,
  reviewId: string,
  repository: PlaytestingRepositoryOps
): Promise<PlaytestAdapterBatch> {
  const existing = batch.reviewReceipts.find(
    (receipt) => receipt.reviewId === reviewId
  );
  if (!existing) {
    throw new PlaytestMcpUnavailableError(
      "The review has no durable critique reservation."
    );
  }
  if (existing.status === "persisted") return batch;
  assertReviewReceiptMatchesBatch(batch, existing);
  const reviewReceipts = batch.reviewReceipts.map((receipt) =>
    receipt.reviewId === reviewId
      ? { ...receipt, status: "persisted" as const }
      : receipt
  );
  const persisted = reviewReceipts.filter(
    (receipt) => receipt.status === "persisted"
  );
  const reviewedAssignments = new Set(
    persisted.map((receipt) => receipt.assignmentId)
  );
  const updated: PlaytestAdapterBatch = {
    ...batch,
    revision: batch.revision + 1,
    reviewReceipts,
    counts: { ...batch.counts, reviewed: reviewedAssignments.size },
    budget: { ...batch.budget, actualCritiques: persisted.length }
  };
  await repository.insertBatch(updated);
  return updated;
}

function serializeFindingAppend<T>(
  workspaceId: string,
  fingerprint: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([workspaceId, fingerprint]);
  const previous = findingAppendLocks.get(key) ?? Promise.resolve();
  const settled = previous.catch(() => undefined).then(operation);
  // Track the chain so later callers queue behind it, but never surface
  // this tracked promise's rejection itself (the caller's own awaited
  // `settled` promise still rejects normally).
  const tracked = settled.then(
    () => undefined,
    () => undefined
  );
  findingAppendLocks.set(key, tracked);
  void tracked.then(() => {
    // Clean up the completed lock so it does not leak, but only if no
    // newer waiter has already replaced it.
    if (findingAppendLocks.get(key) === tracked) {
      findingAppendLocks.delete(key);
    }
    return undefined;
  });
  return settled;
}
function selectWindowRange(input: {
  readonly result: PlaytestArtifactWindowReadResult;
  readonly fromStep: number;
  readonly toStep: number;
  readonly maxBytes: number | undefined;
}): { readonly bytes: Uint8Array; readonly lineCount: number } {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    input.result.bytes
  );
  const matchedLines: string[] = [];
  const seenSteps = new Set<number>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new PlaytestMcpValidationError(
        "The linked episode trace contains malformed JSON evidence."
      );
    }
    const step =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as { step?: unknown }).step
        : undefined;
    if (typeof step !== "number" || !Number.isSafeInteger(step) || step < 0) {
      throw new PlaytestMcpValidationError(
        "The linked episode trace contains an invalid step record."
      );
    }
    if (seenSteps.has(step)) {
      throw new PlaytestMcpValidationError(
        "The linked episode trace contains duplicate step records."
      );
    }
    seenSteps.add(step);
    if (step >= input.fromStep && step <= input.toStep) {
      matchedLines.push(trimmed);
    }
  }
  if (matchedLines.length !== input.toStep - input.fromStep + 1) {
    throw new PlaytestMcpValidationError(
      "The linked episode trace does not contain the exact requested step range."
    );
  }
  const bytes = new TextEncoder().encode(matchedLines.join("\n") + "\n");
  if (input.maxBytes !== undefined && bytes.byteLength > input.maxBytes) {
    throw new PlaytestMcpValidationError(
      "The requested step range exceeds maxBytes."
    );
  }
  return { bytes, lineCount: matchedLines.length };
}

/**
 * Build the known-evidence index from real stored records -- never from the
 * locators the caller is simultaneously trying to get verified. Episode
 * identity and frames come from the indexed episode row; event identity
 * comes from parsing the episode's own persisted trace artifact; review,
 * finding and comparison identity come from the real repository.
 */
interface PlaytestTraceEvent {
  readonly eventId: string;
  readonly type: string;
  readonly phaseId: string | null;
  readonly step: number | null;
}

interface PlaytestEpisodeTraceFacts {
  readonly eventEpisodeOf: ReadonlyMap<string, string>;
  readonly events: readonly PlaytestTraceEvent[];
  readonly selectedActionIds: ReadonlySet<string>;
}

/** Parse one JSONL line into a structured trace entry, or null if it is not one. */
function parseTraceLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** Normalize a trace entry's selectedActionId to its lower-cased NFKC form, or null. */
function normalizeTraceSelectedActionId(
  entry: Record<string, unknown>
): string | null {
  if (typeof entry.selectedActionId !== "string") return null;
  return entry.selectedActionId.normalize("NFKC").trim().toLowerCase();
}

/** Build a PlaytestTraceEvent from a raw event payload, or null if invalid. */
function tryCreateTraceEvent(
  rawEvent: unknown,
  step: number | null,
  episodeId: string
): { readonly fact: PlaytestTraceEvent; readonly episodeId: string } | null {
  if (
    rawEvent === null ||
    typeof rawEvent !== "object" ||
    Array.isArray(rawEvent)
  ) {
    return null;
  }
  const event = rawEvent as Record<string, unknown>;
  if (
    typeof event.eventId !== "string" ||
    event.eventId.length === 0 ||
    typeof event.type !== "string" ||
    event.type.length === 0
  ) {
    return null;
  }
  return {
    fact: {
      eventId: event.eventId,
      type: event.type,
      phaseId: typeof event.phaseId === "string" ? event.phaseId : null,
      step
    },
    episodeId
  };
}

/** Decode the trace artifact window as UTF-8 text, or null if it cannot be authorized/read. */
function readEpisodeTraceWindow(
  episode: PlaytestEpisode,
  artifacts: PlaytestArtifactStore
): string | null {
  if (!episode.trace) return null;
  try {
    const traceReference = artifacts.referenceForId(episode.trace.id);
    if (!traceReference) throw new Error("trace artifact not authorized");
    const window = artifacts.readWindow(traceReference);
    return new TextDecoder("utf-8", { fatal: true }).decode(window.bytes);
  } catch {
    // Unreadable/expired trace means no event/action identity can be proven.
    return null;
  }
}

/** Parse an episode's persisted JSONL trace as authoritative event/action facts. */
function readEpisodeTraceFacts(
  episode: PlaytestEpisode,
  artifacts: PlaytestArtifactStore
): PlaytestEpisodeTraceFacts {
  const eventEpisodeOf = new Map<string, string>();
  const events: PlaytestTraceEvent[] = [];
  const selectedActionIds = new Set<string>();
  const text = readEpisodeTraceWindow(episode, artifacts);
  if (text === null) {
    return { eventEpisodeOf, events, selectedActionIds };
  }
  for (const line of text.split("\n")) {
    const entry = parseTraceLine(line);
    if (!entry) continue;
    const step = Number.isSafeInteger(entry.step)
      ? (entry.step as number)
      : null;
    const selectedActionId = normalizeTraceSelectedActionId(entry);
    if (selectedActionId !== null) {
      selectedActionIds.add(selectedActionId);
    }
    const rawEvents = entry.events;
    if (!Array.isArray(rawEvents)) continue;
    for (const rawEvent of rawEvents) {
      const created = tryCreateTraceEvent(rawEvent, step, episode.episodeId);
      if (created === null) continue;
      events.push(created.fact);
      eventEpisodeOf.set(created.fact.eventId, created.episodeId);
    }
  }
  return { eventEpisodeOf, events, selectedActionIds };
}

/**
 * Shape accepted by `resolveSubmittedFinding`. Mirrors `findingSchema`
 * but is structurally typed so we can keep callers strictly typed through
 * zod while passing the resolved shape to the helper.
 */
type SubmittedFinding = z.infer<typeof findingSchema>;

function normalizeEvidenceRefs(
  locators: SubmittedFinding["evidenceRefs"]
): readonly PlaytestEvidenceLocator[] {
  // Strip zod-output `undefined`s from optional numeric fields so the
  // resulting objects satisfy PlaytestEvidenceLocator under
  // exactOptionalPropertyTypes. Anything not actually set is dropped.
  return locators.map((locator) => {
    const out: PlaytestEvidenceLocator = {
      kind: locator.kind,
      id: locator.id
    };
    if ("step" in locator && typeof locator.step === "number") {
      (out as { step?: number }).step = locator.step;
    }
    if ("revision" in locator && typeof locator.revision === "number") {
      (out as { revision?: number }).revision = locator.revision;
    }
    if ("frameIndex" in locator && typeof locator.frameIndex === "number") {
      (out as { frameIndex?: number }).frameIndex = locator.frameIndex;
    }
    if ("phaseId" in locator && typeof locator.phaseId === "string") {
      (out as { phaseId?: string }).phaseId = locator.phaseId;
    }
    return out;
  });
}

/** Derive finding scope/events from the stored episode and cited trace, never caller claims. */
function buildSubmittedFindingIdentity(
  episode: PlaytestEpisode,
  traceFacts: PlaytestEpisodeTraceFacts,
  submitted: SubmittedFinding
): {
  readonly identity: PlaytestFindingIdentity;
  readonly fingerprint: string;
} {
  assertPlaytestAdapterEpisode(episode);
  const citedEventIds = new Set(
    submitted.evidenceRefs
      .filter((reference) => reference.kind === "event")
      .map((reference) => reference.id)
  );
  const events = traceFacts.events
    .filter((event) => citedEventIds.has(event.eventId))
    .map((event) => event.type);
  if (events.length === 0) {
    throw new PlaytestMcpValidationError(
      "A finding identity requires at least one cited event from the stored episode trace."
    );
  }
  const requestedAction = submitted.identity.failureSignature.action;
  if (requestedAction !== undefined && requestedAction !== null) {
    const normalizedAction = requestedAction
      .normalize("NFKC")
      .trim()
      .toLowerCase();
    if (!traceFacts.selectedActionIds.has(normalizedAction)) {
      throw new PlaytestMcpValidationError(
        "Finding identity action must match a selected action recorded in the stored episode trace."
      );
    }
  }
  const identity = buildPlaytestFindingIdentity({
    workspaceId: episode.identity.workspaceId,
    mechanicKey: submitted.identity.mechanicKey,
    failureSignature: {
      events,
      ...(requestedAction === undefined ? {} : { action: requestedAction }),
      witness: submitted.identity.failureSignature.witness
    },
    scope: {
      // These fields are deliberately server-derived. Phase and modality
      // remain null until the stored evidence contains a verified mapping.
      scenarioFamily: episode.scenarioFamily,
      phase: null,
      modality: null
    }
  });
  return { identity, fingerprint: computeFindingFingerprint(identity) };
}

interface SubmittedFindingGroup {
  readonly identity: PlaytestFindingIdentity;
  readonly fingerprint: string;
  readonly submitted: SubmittedFinding;
  readonly affectedCohorts: readonly string[];
}

/**
 * Collapse findings within ONE submitted review that resolve to the same
 * stable identity fingerprint before any Data read/append happens, so a
 * single review can never create two persisted revisions -- or two
 * entries in its own findings array -- for the same underlying defect.
 * The first occurrence in review order keeps its severity/title/description;
 * later in-review duplicates only contribute additional validated evidence.
 * Cohort is derived from the stored episode. Workflow state, prevalence,
 * external links and verification dates are owned by separate workflows.
 */
function collapseInReviewDuplicateFindings(
  episode: PlaytestEpisode,
  traceFacts: PlaytestEpisodeTraceFacts,
  findings: readonly SubmittedFinding[]
): readonly SubmittedFindingGroup[] {
  assertPlaytestAdapterEpisode(episode);
  const order: string[] = [];
  const byFingerprint = new Map<string, SubmittedFindingGroup>();
  for (const submitted of findings) {
    const { identity, fingerprint } = buildSubmittedFindingIdentity(
      episode,
      traceFacts,
      submitted
    );
    const group = byFingerprint.get(fingerprint);
    if (!group) {
      byFingerprint.set(fingerprint, {
        identity,
        fingerprint,
        submitted,
        affectedCohorts: [episode.policyCohort]
      });
      order.push(fingerprint);
      continue;
    }
    byFingerprint.set(fingerprint, {
      identity: group.identity,
      fingerprint,
      submitted: {
        ...group.submitted,
        evidenceRefs: [
          ...group.submitted.evidenceRefs,
          ...submitted.evidenceRefs
        ]
      },
      affectedCohorts: [
        ...unionStringSet(group.affectedCohorts, [episode.policyCohort])
      ]
    });
  }
  return order.map((fingerprint) => byFingerprint.get(fingerprint)!);
}

/** Resolve the finding revision from the latest workspace-owned fingerprint. */
interface PreparedSubmittedFinding {
  readonly finding: PlaytestFinding;
  readonly shouldInsert: boolean;
}

function resolveSubmittedFinding(
  group: SubmittedFindingGroup,
  existing: PlaytestFinding | null
): PreparedSubmittedFinding {
  const { identity, fingerprint, submitted } = group;
  const findingId = deriveStableFindingId(fingerprint);
  if (existing) {
    const evidenceRefs = unionEvidenceRefs(
      existing.evidenceRefs,
      normalizeEvidenceRefs(submitted.evidenceRefs)
    );
    const affectedCohorts = unionStringSet(
      existing.affectedCohorts,
      group.affectedCohorts
    );
    if (
      canonicalPlaytestJson(evidenceRefs) ===
        canonicalPlaytestJson(existing.evidenceRefs) &&
      canonicalPlaytestJson(affectedCohorts) ===
        canonicalPlaytestJson(existing.affectedCohorts)
    ) {
      return { finding: existing, shouldInsert: false };
    }
    return {
      shouldInsert: true,
      finding: {
        // Keep source-owned workflow state and merge only newly cited evidence.
        identity: existing.identity,
        fingerprint: existing.fingerprint,
        findingId: existing.findingId,
        version: existing.version + 1,
        title: existing.title,
        description: existing.description,
        severity: existing.severity,
        status: existing.status,
        verificationStage: existing.verificationStage,
        evidenceStatus: existing.evidenceStatus,
        affectedEpisodes: existing.affectedEpisodes,
        totalEligibleEpisodes: existing.totalEligibleEpisodes,
        affectedOpportunities: existing.affectedOpportunities,
        totalEligibleOpportunities: existing.totalEligibleOpportunities,
        affectedCohorts,
        evidenceRefs,
        experimentIds: existing.experimentIds,
        issueRefs: existing.issueRefs,
        lastVerifiedBuild: existing.lastVerifiedBuild,
        nextReviewAt: existing.nextReviewAt
      }
    };
  }
  return {
    shouldInsert: true,
    finding: {
      identity,
      fingerprint,
      findingId,
      version: 1,
      title: submitted.title,
      description: submitted.description,
      severity: "informational",
      status: "open",
      verificationStage: "not-yet-validated",
      evidenceStatus: "hypothesis",
      affectedEpisodes: null,
      totalEligibleEpisodes: null,
      affectedOpportunities: null,
      totalEligibleOpportunities: null,
      affectedCohorts: [...group.affectedCohorts],
      evidenceRefs: normalizeEvidenceRefs(submitted.evidenceRefs),
      experimentIds: [],
      issueRefs: [],
      lastVerifiedBuild: null,
      nextReviewAt: null
    }
  };
}

function assertSubmittedFindingEvidenceStatus(
  finding: PlaytestFinding,
  group: SubmittedFindingGroup,
  evidenceIndex: PlaytestKnownEvidenceIndex
): void {
  try {
    // Prior revisions may cite other episodes and were validated when they
    // were recorded. Validate this submission against this episode's index.
    assertPlaytestFindingEvidenceStatusConsistent(
      {
        ...finding,
        evidenceRefs: normalizeEvidenceRefs(group.submitted.evidenceRefs)
      },
      evidenceIndex
    );
  } catch {
    throw new PlaytestMcpValidationError(
      "A submitted finding conflicts with its existing evidence status."
    );
  }
}

async function resolveAndValidateSubmittedFinding(
  workspaceId: string,
  group: SubmittedFindingGroup,
  evidenceIndex: PlaytestKnownEvidenceIndex,
  playtestRepository: PlaytestingRepositoryOps
): Promise<PreparedSubmittedFinding> {
  const existing = await playtestRepository.getLatestFindingByFingerprint(
    workspaceId,
    group.fingerprint
  );
  const resolved = resolveSubmittedFinding(group, existing);
  assertSubmittedFindingEvidenceStatus(resolved.finding, group, evidenceIndex);
  return resolved;
}

async function preflightSubmittedFindingGroups(
  workspaceId: string,
  groups: readonly SubmittedFindingGroup[],
  evidenceIndex: PlaytestKnownEvidenceIndex,
  playtestRepository: PlaytestingRepositoryOps
): Promise<void> {
  await mapConcurrentOrdered(groups, FINDING_APPEND_CONCURRENCY, (group) =>
    resolveAndValidateSubmittedFinding(
      workspaceId,
      group,
      evidenceIndex,
      playtestRepository
    )
  );
}

/** Persist one already preflight-validated finding under its fingerprint lock. */
async function appendSubmittedFindingGroup(
  workspaceId: string,
  group: SubmittedFindingGroup,
  evidenceIndex: PlaytestKnownEvidenceIndex,
  playtestRepository: PlaytestingRepositoryOps
): Promise<PlaytestFinding> {
  const resolved = await resolveAndValidateSubmittedFinding(
    workspaceId,
    group,
    evidenceIndex,
    playtestRepository
  );
  if (resolved.shouldInsert) {
    await playtestRepository.insertFinding(workspaceId, resolved.finding);
  }
  return resolved.finding;
}

async function buildKnownPlaytestEvidenceIndex(
  workspaceId: string,
  episode: PlaytestEpisode,
  evidenceRefs: readonly PlaytestEvidenceLocator[],
  traceFacts: PlaytestEpisodeTraceFacts,
  playtestRepository: PlaytestingRepositoryOps
): Promise<PlaytestKnownEvidenceIndex> {
  const episodeIds = new Set<string>([episode.episodeId]);

  const frameEpisodeOf = new Map<string, string>();
  for (const frame of episode.frames) {
    frameEpisodeOf.set(frame.id, episode.episodeId);
  }

  const eventEpisodeOf = traceFacts.eventEpisodeOf;

  const reviewIds = new Set<string>();
  const latestReview = await playtestRepository.getLatestReviewForEpisode(
    workspaceId,
    episode.episodeId
  );
  if (latestReview) reviewIds.add(latestReview.reviewId);

  const findingIds = new Set<string>();
  const findingRefs = new Set(
    evidenceRefs
      .filter((reference) => reference.kind === "finding")
      .map((ref) => ref.id)
  );
  const findings = await Promise.all(
    Array.from(findingRefs, (findingId) =>
      playtestRepository.getFinding(workspaceId, findingId)
    )
  );
  for (const finding of findings) {
    if (finding) findingIds.add(finding.findingId);
  }

  const comparisonIds = new Set<string>();
  const comparisonRefs = new Set(
    evidenceRefs
      .filter((reference) => reference.kind === "comparison")
      .map((ref) => ref.id)
  );
  const comparisons = await Promise.all(
    Array.from(comparisonRefs, (comparisonId) =>
      playtestRepository.getLatestComparison(workspaceId, comparisonId)
    )
  );
  for (const comparison of comparisons) {
    if (comparison) comparisonIds.add(comparison.comparisonId);
  }

  return {
    episodeIds,
    eventEpisodeOf,
    eventRelevantRuleOf: new Map(),
    reviewIds,
    findingIds,
    comparisonIds,
    frameEpisodeOf
  };
}

function assertKnownEvidenceLocators(
  references: readonly PlaytestEvidenceLocator[],
  index: PlaytestKnownEvidenceIndex
): void {
  for (const reference of references) {
    if (!knownEvidenceLocatorExists(reference, index)) {
      throw new PlaytestMcpValidationError(
        "Every review locator must resolve to evidence stored by Runtime or Data."
      );
    }
  }
}

function knownEvidenceLocatorExists(
  reference: PlaytestEvidenceLocator,
  index: PlaytestKnownEvidenceIndex
): boolean {
  switch (reference.kind) {
    case "episode":
    case PLAYTEST_REPLAY_SEGMENT_KIND: {
      return index.episodeIds.has(reference.id);
    }
    case "event": {
      return index.eventEpisodeOf.has(reference.id);
    }
    case "frame": {
      return index.frameEpisodeOf.has(reference.id);
    }
    case "review": {
      return index.reviewIds.has(reference.id);
    }
    case "finding": {
      return index.findingIds.has(reference.id);
    }
    case "comparison": {
      return index.comparisonIds.has(reference.id);
    }
    default: {
      return false;
    }
  }
}

type ReviewDimensionEvidence = z.infer<typeof reviewDimensionEvidenceSchema>;
type ReviewExperiment = z.infer<typeof reviewExperimentSchema>;

function anchorsForReview(
  packet: PlaytestEvidencePacket,
  evidence: readonly ReviewDimensionEvidence[]
): readonly PlaytestDimensionAnchor[] {
  const notes = new Map<string, ReviewDimensionEvidence>();
  const rubricIds = new Set(
    packet.dimensionRubrics.map((rubric) => rubric.dimensionId)
  );
  for (const item of evidence) {
    if (!rubricIds.has(item.dimensionId) || notes.has(item.dimensionId)) {
      throw new PlaytestMcpValidationError(
        "Dimension evidence must refer to one unique rubric dimension in the prepared packet."
      );
    }
    notes.set(item.dimensionId, item);
  }

  return packet.dimensionRubrics.map((rubric) => {
    const note = notes.get(rubric.dimensionId);
    const evidenceRefs = note ? normalizeEvidenceRefs(note.evidenceRefs) : [];
    const matchingMetrics = packet.metrics.filter(
      (metric) =>
        rubric.indicator ===
        `${metric.metricId}@${String(metric.metricVersion)}`
    );
    const metric =
      matchingMetrics.length === 1 &&
      evidenceRefs.length > 0 &&
      rubric.modality === packet.observationMode
        ? matchingMetrics[0]!
        : null;
    const anchor = scorePlaytestDimensionAnchor(rubric, {
      dimensionId: rubric.dimensionId,
      ratio: metric?.estimate ?? null,
      independentUnits: metric?.independentUnits ?? null,
      eligibleOpportunities: metric?.opportunityCount ?? null,
      evidenceRefs,
      ...(note?.counterexampleId === undefined
        ? {}
        : { counterexampleId: note.counterexampleId })
    });
    return {
      ...anchor,
      rationale: note?.rationale ?? anchor.rationale,
      ...(metric === null && rubric.modality !== packet.observationMode
        ? { insufficientReason: "unsupported-modality" as const }
        : {})
    };
  });
}

function assertReviewExperimentMetrics(
  packet: PlaytestEvidencePacket,
  experiments: readonly ReviewExperiment[]
): void {
  const metricIds = new Set([
    ...packet.metrics.map((metric) => metric.metricId),
    ...packet.metricIntent.map((metric) => metric.metricId)
  ]);
  if (experiments.some((experiment) => !metricIds.has(experiment.metricId))) {
    throw new PlaytestMcpValidationError(
      "Review experiments must target a metric declared by the prepared packet."
    );
  }
}

export function createPlaytestMcpServer(
  options: PlaytestMcpOptions & {
    readonly playtestRunControl: PlaytestRunControl;
  }
): McpServer & { readonly playtestRunControl: PlaytestRunControl };
export function createPlaytestMcpServer(
  options: PlaytestMcpOptions
): PlaytestMcpServer;
export function createPlaytestMcpServer(
  options: PlaytestMcpOptions
): PlaytestMcpServer {
  const mcp = new McpServer(
    { name: "playtest", version: RUNTIME_VERSION },
    { capabilities: { tools: {} } }
  );

  const {
    sessionProvider,
    artifactStoreForWorkspace,
    playtestRepository,
    approvalRepository,
    playtestRunControl,
    prepareSandboxHandler = preparePlaytestSandbox
  } = options;
  const preparedAnalystPackets = new Map<string, PlaytestEvidencePacket>();

  // 1. playtest.capabilities
  mcp.registerTool(
    "playtest.capabilities",
    {
      description:
        "Inspect playtesting capabilities, budget limits, allowed scenarios and policies for an approved workspace.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional()
      }
    },
    ({ workspaceId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return requirePlaytestRunControl(playtestRunControl).getCapabilities(
          session,
          targetWorkspaceId
        );
      })
  );

  // 2. playtest.run
  mcp.registerTool(
    "playtest.run",
    {
      description:
        "Start one versioned PlaytestLaunchRequest with a capabilityRevision from playtest.capabilities and a unique client requestId that remains stable across uncertain retries. mode=adapter-accelerated with operation.kind=batch runs an ordered approved assignment set; mode=autonomous-visual requires a Workspaces-approved target and policyId=smart-direct; mode=scripted-regression requires an approved replay recipe. Runtime refuses unavailable modes and never substitutes another mode.",
      inputSchema: z.strictObject({
        launchRequest: playtestLaunchRequestSchema
      })
    },
    ({ launchRequest }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return requirePlaytestRunControl(playtestRunControl).startRun(
          session,
          launchRequest
        );
      })
  );

  // The run tool returns the server-generated batch ID as soon as the active
  // operation is registered; these tools poll, wait for, or cancel that run.
  mcp.registerTool(
    "playtest.activeRuns",
    {
      description:
        "List active run identifiers in the caller's authorized workspace.",
      inputSchema: { workspaceId: z.string().min(1).max(256).optional() }
    },
    ({ workspaceId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return {
          runs: await requirePlaytestRunControl(
            playtestRunControl
          ).listActiveRuns(session, targetWorkspaceId)
        };
      })
  );

  mcp.registerTool(
    "playtest.lookupRequest",
    {
      description:
        "Recover a launch with its original requestId after an uncertain POST; lookup is scoped to the trusted actor and workspace and never starts a new run.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        requestId: z.string().regex(LAUNCH_INTENT_REQUEST_ID_PATTERN)
      })
    },
    ({ workspaceId, requestId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return requirePlaytestRunControl(playtestRunControl).lookupRunByRequest(
          session,
          targetWorkspaceId,
          requestId
        );
      })
  );

  mcp.registerTool(
    "playtest.wait",
    {
      description:
        "Read run status immediately or wait a bounded duration for its result.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        batchId: z.string().min(1).max(256),
        waitMs: z.number().int().min(0).max(30_000).default(0)
      })
    },
    ({ workspaceId, batchId, waitMs }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return requirePlaytestRunControl(playtestRunControl).waitForRun(
          session,
          targetWorkspaceId,
          batchId,
          waitMs
        );
      })
  );

  mcp.registerTool(
    "playtest.cancel",
    {
      description:
        "Cancel one active batch by its server-generated immutable batch id; every in-flight assignment stops.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        batchId: z.string().min(1).max(256)
      })
    },
    ({ workspaceId, batchId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return requirePlaytestRunControl(playtestRunControl).cancelRun(
          session,
          targetWorkspaceId,
          batchId
        );
      })
  );

  // 3. playtest.listEpisodes
  mcp.registerTool(
    "playtest.listEpisodes",
    {
      description:
        "List indexed playtest episodes with validated filtering and keyset pagination.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        batchId: z.string().max(256).optional(),
        buildSha: z.string().max(256).optional(),
        scenario: z.string().max(256).optional(),
        policy: z.string().max(256).optional(),
        cohort: z.string().max(256).optional(),
        status: z.enum([...PLAYTESTS_EPISODE_STATES]).optional(),
        gameOutcome: z.enum([...PLAYTESTS_GAME_OUTCOMES]).optional(),
        reviewStatus: z.enum(["reviewed", "unreviewed"]).optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          RUN_STATUS_READER_ROLES,
          "playtest.listEpisodes"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for episode listing."
          );
        }

        const page = await playtestRepository.listEpisodes(
          {
            workspaceId: targetWorkspaceId,
            ...(args.batchId ? { batchId: args.batchId } : {}),
            ...(args.buildSha ? { buildSha: args.buildSha } : {}),
            ...(args.scenario ? { scenario: args.scenario } : {}),
            ...(args.policy ? { policy: args.policy } : {}),
            ...(args.cohort ? { cohort: args.cohort } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.gameOutcome ? { gameOutcome: args.gameOutcome } : {}),
            ...(args.reviewStatus ? { reviewStatus: args.reviewStatus } : {})
          },
          {
            limit: args.limit,
            ...(args.cursor ? { cursor: args.cursor } : {})
          }
        );

        return {
          rows: page.rows,
          total: page.total,
          nextCursor: page.nextCursor
        };
      })
  );

  // 4. playtest.readEpisode
  mcp.registerTool(
    "playtest.readEpisode",
    {
      description:
        "Read an indexed playtest episode record and its latest review.",
      inputSchema: {
        episodeId: z.string().min(1).max(256),
        workspaceId: z.string().min(1).max(256).optional()
      }
    },
    ({ episodeId, workspaceId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          RUN_STATUS_READER_ROLES,
          "playtest.readEpisode"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for reading episodes."
          );
        }

        const episode = await playtestRepository.getEpisode(
          targetWorkspaceId,
          episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            'Playtest episode "' +
              episodeId +
              '" was not found in workspace "' +
              targetWorkspaceId +
              '".'
          );
        }

        const review = await playtestRepository.getLatestReviewForEpisode(
          targetWorkspaceId,
          episodeId
        );

        return { episode, review };
      })
  );

  // 5. playtest.readWindow
  mcp.registerTool(
    "playtest.readWindow",
    {
      description:
        "Read a bounded step window from an episode artifact, filtered to the requested step range.",
      inputSchema: {
        episodeId: z.string().min(1).max(256),
        artifactId: z.string().min(1).max(256),
        fromStep: z.number().int().min(0),
        toStep: z.number().int().min(0),
        maxBytes: z.number().int().min(1).max(10_000_000).optional(),
        workspaceId: z.string().min(1).max(256).optional()
      }
    },
    ({ episodeId, artifactId, fromStep, toStep, maxBytes, workspaceId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          RUN_STATUS_READER_ROLES,
          "playtest.readWindow"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);

        if (
          toStep < fromStep ||
          toStep - fromStep > 4095 ||
          toStep >= 100_000
        ) {
          throw new PlaytestMcpValidationError(
            "The requested step range must be ordered and bounded to at most 4096 steps."
          );
        }
        const artifacts = artifactStoreForWorkspace(targetWorkspaceId);
        if (artifacts.boundWorkspaceId() !== targetWorkspaceId) {
          throw new PlaytestMcpAuthorizationError(
            "The artifact store is not bound to the authorized workspace."
          );
        }
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest Data storage is unavailable for episode ownership checks."
          );
        }
        const episode = await playtestRepository.getEpisode(
          targetWorkspaceId,
          episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            "The requested episode does not exist in the authorized workspace."
          );
        }
        if (toStep >= episode.stepCount) {
          throw new PlaytestMcpValidationError(
            "The requested step range extends beyond the episode."
          );
        }
        if (episode.trace?.id !== artifactId) {
          throw new PlaytestMcpAuthorizationError(
            "The requested window artifact is not linked to this episode."
          );
        }
        const reference = artifacts.referenceForId(artifactId);
        if (!reference) {
          throw new PlaytestMcpValidationError(
            "The linked episode trace is unavailable in the artifact store."
          );
        }
        const windowResult: PlaytestArtifactWindowReadResult =
          artifacts.readWindow(reference);

        const filtered = selectWindowRange({
          result: windowResult,
          fromStep,
          toStep,
          maxBytes
        });

        return {
          artifactId: windowResult.reference.artifactId,
          sourceSha256: windowResult.reference.sha256,
          contentSha256: createHash("sha256")
            .update(filtered.bytes)
            .digest("hex"),
          bytes: filtered.bytes.byteLength,
          fromStep,
          toStep,
          lineCount: filtered.lineCount,
          bytesBase64: Buffer.from(filtered.bytes).toString("base64")
        };
      })
  );

  // 6. playtest.metrics
  mcp.registerTool(
    "playtest.metrics",
    {
      description:
        "Calculate or retrieve deterministic playtest metrics for an episode or batch.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().max(256).optional(),
        batchId: z.string().max(256).optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    ({ workspaceId, episodeId, batchId, cursor, limit }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          ANALYSIS_READER_ROLES,
          "playtest.metrics"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        if (Boolean(episodeId) === Boolean(batchId)) {
          throw new PlaytestMcpValidationError(
            "Provide exactly one episodeId or batchId."
          );
        }
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for metrics."
          );
        }

        if (episodeId) {
          const episode = await playtestRepository.getEpisode(
            targetWorkspaceId,
            episodeId
          );
          if (!episode) {
            throw new PlaytestMcpValidationError(
              'Episode "' +
                episodeId +
                '" not found in workspace "' +
                targetWorkspaceId +
                '".'
            );
          }
          return {
            episodeId,
            outcome: episode.outcome,
            numericResults: episode.metrics
          };
        }

        if (batchId) {
          const page = await playtestRepository.listEpisodes(
            { workspaceId: targetWorkspaceId, batchId },
            { limit: limit ?? 50, ...(cursor ? { cursor } : {}) }
          );
          return {
            kind: "per-episode-metrics",
            batchId,
            rows: page.rows.map((episode) => ({
              episodeId: episode.episodeId,
              metrics: episode.metrics
            })),
            total: page.total,
            nextCursor: page.nextCursor
          };
        }
        throw new PlaytestMcpValidationError(
          "A metric identifier is required."
        );
      })
  );

  // 7. playtest.compare
  mcp.registerTool(
    "playtest.compare",
    {
      description:
        "Return the latest code-owned PlaytestComparison stored for a benchmark/experiment pair. Never computes or fabricates a comparison inline.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        benchmarkId: z.string().min(1).max(256),
        experimentId: z.string().min(1).max(256)
      }
    },
    ({ workspaceId, benchmarkId, experimentId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          ANALYSIS_READER_ROLES,
          "playtest.compare"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for comparisons."
          );
        }

        const page = await playtestRepository.listComparisons(
          {
            workspaceId: targetWorkspaceId,
            benchmarkId,
            experimentId
          },
          { limit: 1 }
        );

        const latest = page.rows[0];
        if (!latest) {
          throw new PlaytestMcpValidationError(
            'No stored comparison exists for benchmark "' +
              benchmarkId +
              '" and experiment "' +
              experimentId +
              '". A comparison must be computed and persisted by the owning analysis pipeline before it can be read here.'
          );
        }

        return latest;
      })
  );

  mcp.registerTool(
    "playtest.decideComparison",
    {
      description:
        "Append a root/operator-authored promote-or-hold decision to the exact current stored comparison revision. Promotion records eligibility only; this tool never deploys, merges, or changes a workspace approval.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        comparisonId: z.string().min(1).max(256),
        expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        disposition: z.enum(["promote", "hold"]),
        reason: z.string().min(1).max(4000)
      })
    },
    ({ workspaceId, comparisonId, expectedVersion, disposition, reason }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          OWNER_DECISION_ROLES,
          "playtest.decideComparison"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        return requirePlaytestRunControl(
          playtestRunControl
        ).recordComparisonDecision(
          session,
          targetWorkspaceId,
          comparisonId,
          expectedVersion,
          disposition,
          reason
        );
      })
  );

  // 8. playtest.prepareReview
  mcp.registerTool(
    "playtest.prepareReview",
    {
      description:
        "Return the frozen, prebuilt and bounded evidence packet for one preselected completed session. The packet's omitted-window reasons and artifact hashes are authoritative; do not substitute ad hoc trace reads.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().min(1).max(256)
      }
    },
    ({ workspaceId, episodeId }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        if (!isReviewerRole(session.role)) {
          throw new PlaytestMcpAuthorizationError(
            "playtest.prepareReview requires the read-only playtest analyst role."
          );
        }
        assertAnalystEpisodeSelected(
          session,
          episodeId,
          "playtest.prepareReview"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest Data storage is unavailable for analyst packet retrieval."
          );
        }
        const episode = await playtestRepository.getEpisode(
          targetWorkspaceId,
          episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            "The requested episode does not exist in the authorized workspace."
          );
        }
        const packet = await readPreparedReviewPacket({
          workspaceId: targetWorkspaceId,
          episode,
          repository: playtestRepository,
          artifacts: artifactStoreForWorkspace(targetWorkspaceId)
        });
        const cacheKey = preparedAnalystPacketCacheKey(
          session,
          targetWorkspaceId,
          episodeId
        );
        if (cacheKey !== null && packet.analysisKind === "confirmatory") {
          preparedAnalystPackets.set(cacheKey, packet.packet);
        }
        return {
          analysisKind: packet.analysisKind,
          packet: packet.packet,
          packetArtifact: packet.artifact
        };
      })
  );

  // 8b. playtest.prepareCrossSessionReview
  mcp.registerTool(
    "playtest.prepareCrossSessionReview",
    {
      description:
        "Prepare bounded evidence packets for an explicit selection of persisted sessions. Runtime owns eligibility, the per-batch critique cap, and a named receipt for every selected session that contributed no packet. This tool does not invoke a model. Each packet belongs to exactly one session, so later cross-session synthesis must cite each contributing session's own packet and be reported as cross-session.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeIds: z
          .array(z.string().min(1).max(256))
          .min(1)
          .max(PLAYTESTS_MAX_CROSS_SESSION_PACKET_SESSIONS)
      }
    },
    ({ workspaceId, episodeIds }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          CROSS_SESSION_PACKET_READER_ROLES,
          "playtest.prepareCrossSessionReview"
        );
        const targetWorkspaceId = authorizeWorkspace(workspaceId, session);
        const result = await requirePlaytestRunControl(
          playtestRunControl
        ).prepareCrossSessionReview(session, targetWorkspaceId, episodeIds);
        // Every requested session appears exactly once, in packets or receipts,
        // so a silent drop is structurally impossible.
        return {
          schema: "autodev-playtest-cross-session-v1" as const,
          requested: episodeIds.length,
          packets: result.packets,
          receipts: result.receipts,
          budget: result.budget
        };
      })
  );

  // Discovery reviews are a separate unscored write contract; the confirmatory
  // submitReview DTO stays adapter/rubric-bound.
  mcp.registerTool(
    "playtest.submitDiscoveryReview",
    {
      description:
        "Persist one unscored, evidence-cited hypothesis review for an autonomous visual discovery packet. This tool cannot score a session, assert a verified bug, or produce a finding.",
      inputSchema: z.strictObject({
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().min(1).max(256),
        packetId: z.string().min(1).max(128),
        packetArtifactId: z.string().min(1).max(128),
        packetSha256: z.string().regex(SHA256_PATTERN),
        chronologicalSummary: z.string().min(1).max(4096),
        observations: z
          .array(
            z.strictObject({
              hypothesisId: z.string().min(1).max(256),
              status: z.enum(["hypothesis", "not-observed"]),
              text: z.string().min(1).max(4096),
              evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
            })
          )
          .min(1)
          .max(64),
        interpretations: z
          .array(
            z.strictObject({
              hypothesisId: z.string().min(1).max(256),
              status: z.enum(["hypothesis", "not-observed"]),
              text: z.string().min(1).max(4096),
              evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
            })
          )
          .min(1)
          .max(64),
        alternativeExplanations: z
          .array(
            z.strictObject({
              hypothesisId: z.string().min(1).max(256),
              status: z.enum(["hypothesis", "not-observed"]),
              text: z.string().min(1).max(4096),
              evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
            })
          )
          .max(32),
        experiments: z
          .array(
            z.strictObject({
              hypothesis: z.string().min(1).max(4096),
              falsifier: z.string().min(1).max(4096),
              controls: z.array(z.string().min(1).max(1024)).min(1).max(16),
              budget: z.string().min(1).max(1024),
              evidenceRefs: z.array(evidenceLocatorSchema).min(1).max(64)
            })
          )
          .max(32)
      })
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        if (!isReviewerRole(session.role)) {
          throw new PlaytestMcpAuthorizationError(
            "playtest.submitDiscoveryReview requires the read-only playtest analyst role."
          );
        }
        if (session.analysisKind !== "discovery") {
          throw new PlaytestMcpAuthorizationError(
            "Discovery reviews may only be submitted from a Runtime-bound discovery analysis."
          );
        }
        assertAnalystEpisodeSelected(
          session,
          args.episodeId,
          "playtest.submitDiscoveryReview"
        );
        const workspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository?.insertDiscoveryReview) {
          throw new PlaytestMcpUnavailableError(
            "Playtest Data storage does not support discovery review persistence."
          );
        }
        const episode = await playtestRepository.getEpisode(
          workspaceId,
          args.episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            "The requested visual discovery episode does not exist in the authorized workspace."
          );
        }
        const prepared = await readPreparedReviewPacket({
          workspaceId,
          episode,
          repository: playtestRepository,
          artifacts: artifactStoreForWorkspace(workspaceId)
        });
        if (prepared.analysisKind !== "discovery") {
          throw new PlaytestMcpAuthorizationError(
            "The requested episode has a confirmatory packet, not a discovery packet."
          );
        }
        if (
          prepared.packet.packetId !== args.packetId ||
          prepared.artifact.artifactId !== args.packetArtifactId ||
          prepared.artifact.sha256.toLowerCase() !==
            args.packetSha256.toLowerCase()
        ) {
          throw new PlaytestMcpValidationError(
            "The submitted discovery review does not match the exact persisted packet artifact."
          );
        }
        const observations: PlaytestDiscoveryReviewDraft["observations"] =
          args.observations.map((claim) => ({
            hypothesisId: claim.hypothesisId,
            status: claim.status,
            text: claim.text,
            evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
          }));
        const interpretations: PlaytestDiscoveryReviewDraft["interpretations"] =
          args.interpretations.map((claim) => ({
            hypothesisId: claim.hypothesisId,
            status: claim.status,
            text: claim.text,
            evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
          }));
        const alternativeExplanations: PlaytestDiscoveryReviewDraft["alternativeExplanations"] =
          args.alternativeExplanations.map((claim) => ({
            hypothesisId: claim.hypothesisId,
            status: claim.status,
            text: claim.text,
            evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
          }));
        const experiments: PlaytestDiscoveryReviewDraft["experiments"] =
          args.experiments.map((experiment) => ({
            ...experiment,
            evidenceRefs: normalizeEvidenceRefs(experiment.evidenceRefs)
          }));
        const draftCore: PlaytestDiscoveryReviewDraft = {
          reviewId: "discovery-pending",
          packetId: prepared.packet.packetId,
          chronologicalSummary: args.chronologicalSummary,
          observations,
          interpretations,
          alternativeExplanations,
          experiments,
          authorRole: "playtest-analyst"
        };
        try {
          assertPlaytestDiscoveryReviewDraft(draftCore);
          assertPlaytestDiscoveryReviewGroundedInPacket(
            draftCore,
            prepared.packet
          );
        } catch (error) {
          throw new PlaytestMcpValidationError(
            error instanceof Error
              ? "The discovery review is not grounded in its exact packet: " +
                  error.message
              : "The discovery review is not grounded in its exact packet."
          );
        }
        const allClaims = [
          ...observations,
          ...interpretations,
          ...alternativeExplanations
        ];
        const allWords = [
          args.chronologicalSummary,
          ...allClaims.map((claim) => claim.text),
          ...alternativeExplanations.map((claim) => claim.text),
          ...experiments.flatMap((experiment) => [
            experiment.hypothesis,
            experiment.falsifier
          ])
        ];
        if (
          allWords.some(
            (text) =>
              text
                .trim()
                .split(REVIEW_NARRATIVE_WORD_SEPARATOR_PATTERN)
                .filter(Boolean).length < 5
          )
        ) {
          throw new PlaytestReviewNarrativeValidationError();
        }
        const evidenceRefs = [
          ...new Map(
            [
              ...allClaims.flatMap((claim) => claim.evidenceRefs),
              ...experiments.flatMap((experiment) => experiment.evidenceRefs)
            ].map((reference) => [JSON.stringify(reference), reference])
          ).values()
        ] as PlaytestEvidenceLocator[];
        const status = allClaims.some((claim) => claim.status === "hypothesis")
          ? "hypothesis"
          : "not observed";
        const reviewId =
          "discovery-review-" +
          createHash("sha256")
            .update(
              canonicalPlaytestJson({
                workspaceId,
                episodeId: episode.episodeId,
                packetId: prepared.packet.packetId,
                packetSha256: prepared.artifact.sha256,
                chronologicalSummary: args.chronologicalSummary,
                observations,
                interpretations,
                alternativeExplanations,
                experiments
              })
            )
            .digest("hex");
        const existing =
          await playtestRepository.getLatestDiscoveryReviewForEpisode(
            workspaceId,
            episode.episodeId
          );
        if (existing) {
          if (
            existing.reviewId === reviewId &&
            existing.evidencePacket.packetId === prepared.packet.packetId &&
            existing.evidencePacket.artifact.sha256 === prepared.artifact.sha256
          ) {
            return existing;
          }
          throw new PlaytestMcpConflictError(
            "This visual discovery episode already has a persisted analyst review."
          );
        }
        const record: PlaytestDiscoverySessionReview = {
          schema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
          analysisKind: "discovery",
          reviewId,
          version: 1,
          workspaceId,
          batchId: episode.batchId,
          episodeId: episode.episodeId,
          supersedes: null,
          evidencePacket: {
            packetId: prepared.packet.packetId,
            artifact: prepared.artifact
          },
          authorRole: "playtest-analyst",
          authorId: session.actor,
          measurementVersion: prepared.packet.measurementVersion,
          chronologicalSummary: args.chronologicalSummary,
          observations,
          interpretations,
          alternativeExplanations,
          experiments,
          evidenceRefs,
          createdAt: new Date().toISOString(),
          status
        };
        assertPlaytestDiscoverySessionReview(record);
        await playtestRepository.insertDiscoveryReview(record);
        return record;
      })
  );

  // 9. playtest.submitReview
  mcp.registerTool(
    "playtest.submitReview",
    {
      description:
        "Submit an immutable playtest review for an episode with evidence locator validation against the real stored evidence index.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        episodeId: z.string().min(1).max(256),
        packetId: z.string().min(1).max(128),
        packetArtifactId: z.string().min(1).max(128),
        packetSha256: z.string().regex(SHA256_PATTERN),
        chronologicalSummary: z.string().min(1).max(10_000),
        status: z.enum(REVIEWABLE_STATUSES),
        evidenceRefs: z.array(evidenceLocatorSchema).min(1),
        observations: z.array(reviewClaimSchema).min(1).max(64),
        interpretations: z.array(reviewClaimSchema).min(1).max(64),
        dimensionEvidence: z
          .array(reviewDimensionEvidenceSchema)
          .max(32)
          .default([]),
        alternativeExplanations: z.array(z.string().min(1).max(4000)).max(32),
        reportCompleteness: reviewCompletenessSchema,
        experiments: z.array(reviewExperimentSchema).max(32),
        findings: z
          .array(findingSchema)
          .max(MAX_FINDINGS_PER_REVIEW)
          .default([]),
        rubricHash: z.string().min(1).max(256),
        notes: z.string().max(4000).optional()
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const reviewerRole = session.role;
        if (!isReviewerRole(reviewerRole)) {
          throw new PlaytestMcpAuthorizationError(
            "playtest.submitReview requires an authorized reviewer role."
          );
        }
        assertAnalystEpisodeSelected(
          session,
          args.episodeId,
          "playtest.submitReview"
        );
        if (
          !Array.isArray(args.observations) ||
          args.observations.length === 0 ||
          !Array.isArray(args.interpretations) ||
          args.interpretations.length === 0 ||
          !Array.isArray(args.alternativeExplanations) ||
          !Array.isArray(args.experiments)
        ) {
          throw new PlaytestMcpValidationError(
            "A review must include observed and interpreted claims, alternatives, and an explicit experiment list."
          );
        }
        const evidenceRefs = normalizeEvidenceRefs(args.evidenceRefs ?? []);
        const observations = (args.observations ?? []).map((claim) => ({
          text: claim.text,
          evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
        }));
        const interpretations = (args.interpretations ?? []).map((claim) => ({
          text: claim.text,
          evidenceRefs: normalizeEvidenceRefs(claim.evidenceRefs)
        }));
        const submittedFindings = args.findings ?? [];
        if (submittedFindings.length > MAX_FINDINGS_PER_REVIEW) {
          throw new PlaytestMcpValidationError(
            `A review may include at most ${String(MAX_FINDINGS_PER_REVIEW)} findings.`
          );
        }
        let findings: SubmittedFinding[];
        try {
          findings = submittedFindings.map((finding) =>
            findingSchema.parse(finding)
          );
        } catch {
          throw new PlaytestMcpValidationError(
            "Submitted finding does not satisfy the finding schema."
          );
        }
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured; the review cannot be recorded."
          );
        }
        if (!playtestRepository.insertReview) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository does not support review persistence."
          );
        }
        if (args.status !== "hypothesis" && args.status !== "not observed") {
          throw new PlaytestMcpValidationError(
            "Reviewer conclusions remain hypothesis or not-observed until independent validation is available."
          );
        }
        const episode = await playtestRepository.getEpisode(
          targetWorkspaceId,
          args.episodeId
        );
        if (!episode) {
          throw new PlaytestMcpValidationError(
            'Playtest episode "' +
              args.episodeId +
              '" was not found in workspace "' +
              targetWorkspaceId +
              '".'
          );
        }
        const assignmentId = episode.assignmentId;
        if (!assignmentId) {
          throw new PlaytestMcpValidationError(
            "Historical episodes without assignment identity cannot receive batch-budgeted reviews."
          );
        }
        const packet = await readPreparedReviewPacket({
          workspaceId: targetWorkspaceId,
          episode,
          repository: playtestRepository,
          artifacts: artifactStoreForWorkspace(targetWorkspaceId)
        });
        if (packet.analysisKind !== "confirmatory") {
          throw new PlaytestMcpValidationError(
            "Autonomous visual episodes require playtest.submitDiscoveryReview; scored confirmatory review is unavailable."
          );
        }
        if (
          packet.packet.packetId !== args.packetId ||
          packet.artifact.artifactId !== args.packetArtifactId ||
          packet.artifact.sha256.toLowerCase() !==
            args.packetSha256.toLowerCase() ||
          args.rubricHash !== packet.packet.rubricHash
        ) {
          throw new PlaytestMcpValidationError(
            "The submitted review does not match the frozen evidence packet."
          );
        }
        const dimensionEvidence = args.dimensionEvidence ?? [];
        const alternativeExplanations = args.alternativeExplanations ?? [];
        const experiments = args.experiments ?? [];
        const reportCompleteness =
          args.reportCompleteness as PlaytestReviewCompleteness;
        assertReviewExperimentMetrics(packet.packet, experiments);
        const anchors = anchorsForReview(packet.packet, dimensionEvidence);
        const packetEvidenceRefs = [
          ...evidenceRefs,
          ...(reportCompleteness.crossSessionContext.status === "available"
            ? reportCompleteness.crossSessionContext.evidenceRefs
            : []),
          ...findings.flatMap((finding) => finding.evidenceRefs),
          ...observations.flatMap((claim) => claim.evidenceRefs),
          ...interpretations.flatMap((claim) => claim.evidenceRefs),
          ...dimensionEvidence.flatMap((dimension) => dimension.evidenceRefs)
        ] as PlaytestEvidenceLocator[];
        try {
          assertPlaytestEvidenceLocatorsWithinPacket(
            packetEvidenceRefs,
            packet.packet
          );
        } catch {
          throw new PlaytestMcpValidationError(
            "Review citations include evidence that was not supplied in the frozen analyst packet."
          );
        }
        const reviewId =
          "review-" +
          createHash("sha256")
            .update(
              canonicalPlaytestJson({
                workspaceId: targetWorkspaceId,
                batchId: episode.batchId,
                episodeId: episode.episodeId,
                chronologicalSummary: args.chronologicalSummary,
                status: args.status,
                evidenceRefs,
                observations,
                interpretations,
                dimensionEvidence,
                alternativeExplanations,
                reportCompleteness,
                experiments,
                findings,
                rubricHash: args.rubricHash,
                packetId: packet.packet.packetId,
                packetSha256: packet.artifact.sha256,
                notes: args.notes ?? ""
              })
            )
            .digest("hex");

        return serializeBatchReview(
          targetWorkspaceId,
          episode.batchId,
          async () => {
            const batch = await playtestRepository.getBatch(
              targetWorkspaceId,
              episode.batchId
            );
            if (
              !batch ||
              batch.executionMode !== PLAYTEST_ADAPTER_MODE ||
              batch.assignmentInventory.status !== "frozen" ||
              batch.reviewSelection.status !== "selected"
            ) {
              throw new PlaytestMcpValidationError(
                "This episode has no frozen, completed batch review selection."
              );
            }
            const assignment =
              batch.assignmentInventory.manifest.assignments.find(
                (candidate) => candidate.assignmentId === assignmentId
              );
            const selected = batch.reviewSelection.selected.find(
              (candidate) =>
                candidate.assignmentId === assignmentId &&
                candidate.episodeId === episode.episodeId
            );
            if (
              !assignment ||
              assignment.scenarioId !== episode.identity.scenarioId ||
              assignment.policyId !== episode.identity.policyId ||
              assignment.seed !== episode.identity.seed ||
              !selected
            ) {
              throw new PlaytestMcpAuthorizationError(
                "The episode was not selected for this batch's bounded analyst review."
              );
            }
            const storedPacketReceipt = batch.reviewPackets.find(
              (receipt) =>
                receipt.status === "prepared" &&
                receipt.packetId === packet.packet.packetId &&
                receipt.assignmentId === assignmentId &&
                receipt.episodeId === episode.episodeId &&
                receipt.artifact.artifactId === packet.artifact.artifactId &&
                receipt.artifact.sha256 === packet.artifact.sha256
            );
            if (!storedPacketReceipt) {
              throw new PlaytestMcpAuthorizationError(
                "The evidence packet is not a durable packet receipt for this selected assignment."
              );
            }
            const receiptInput: PlaytestReviewReceiptInput = {
              reviewId,
              assignmentId,
              episodeId: episode.episodeId,
              packetId: packet.packet.packetId
            };
            const existing = await playtestRepository.getLatestReview(
              targetWorkspaceId,
              episode.episodeId,
              reviewId
            );
            if (existing) {
              if (
                existing.evidencePacket === null ||
                existing.evidencePacket.packetId !== packet.packet.packetId ||
                existing.evidencePacket.artifact.sha256 !==
                  packet.artifact.sha256
              ) {
                throw new PlaytestMcpUnavailableError(
                  "The persisted review does not match the selected evidence packet."
                );
              }
              const reservedBatch = await reserveBatchReviewReceipt(
                batch,
                receiptInput,
                playtestRepository
              );
              await persistBatchReviewReceipt(
                reservedBatch,
                reviewId,
                playtestRepository
              );
              return existing;
            }
            const priorReceipt = batch.reviewReceipts.find(
              (receipt) => receipt.reviewId === reviewId
            );
            if (priorReceipt?.status === "persisted") {
              throw new PlaytestMcpUnavailableError(
                "A persisted batch review receipt has no matching review record."
              );
            }

            const allEvidenceRefs = [
              ...evidenceRefs,
              ...findings.flatMap((finding) => finding.evidenceRefs),
              ...observations.flatMap((claim) => claim.evidenceRefs),
              ...interpretations.flatMap((claim) => claim.evidenceRefs)
            ] as PlaytestEvidenceLocator[];
            const traceFacts = readEpisodeTraceFacts(
              episode,
              artifactStoreForWorkspace(targetWorkspaceId)
            );
            const knownIndex = await buildKnownPlaytestEvidenceIndex(
              targetWorkspaceId,
              episode,
              allEvidenceRefs,
              traceFacts,
              playtestRepository
            );

            try {
              assertKnownEvidenceLocators(allEvidenceRefs, knownIndex);
              assertPlaytestSessionReviewHasEvidence({
                reviewId: "review-precheck",
                evidenceRefs,
                observations,
                interpretations,
                alternativeExplanations,
                experiments,
                reportCompleteness,
                findings: findings.map((finding, index) => ({
                  findingId: "review-precheck-finding-" + String(index + 1),
                  evidenceRefs: normalizeEvidenceRefs(finding.evidenceRefs)
                }))
              });
            } catch {
              throw new PlaytestMcpValidationError(
                "Review evidence references do not satisfy the stored-evidence contract."
              );
            }

            try {
              assertPlaytestReviewNarrativeMinimums({
                reviewId: "review-precheck",
                chronologicalSummary: args.chronologicalSummary,
                observations,
                interpretations,
                alternativeExplanations,
                experiments,
                reportCompleteness,
                anchors
              });
            } catch {
              throw new PlaytestReviewNarrativeValidationError();
            }
            try {
              assertPlaytestReviewNarrativeGroundedInPacket(
                {
                  chronologicalSummary: args.chronologicalSummary,
                  observations,
                  interpretations,
                  alternativeExplanations,
                  experiments,
                  reportCompleteness
                },
                packet.packet
              );
            } catch (error) {
              throw new PlaytestReviewGroundingValidationError(
                error instanceof Error
                  ? error.message
                  : "include a packet-specific fact with its citation."
              );
            }

            // §11 missed-known-issue / duplicate-flood gate. Collapse any
            // findings in THIS review that resolve to the same stable
            // identity fingerprint (so one review can never persist two
            // revisions of the same defect), then, per distinct fingerprint,
            // read the latest persisted revision and append the merged
            // result inside one serialized (workspace, fingerprint) critical
            // section so a concurrent submitReview on the same identity
            // cannot race to the same version number.
            const findingGroups = collapseInReviewDuplicateFindings(
              episode,
              traceFacts,
              findings
            );
            await preflightSubmittedFindingGroups(
              targetWorkspaceId,
              findingGroups,
              knownIndex,
              playtestRepository
            );
            const reservedBatch = await reserveBatchReviewReceipt(
              batch,
              receiptInput,
              playtestRepository
            );
            const resolvedFindings = await mapConcurrentOrdered(
              findingGroups,
              FINDING_APPEND_CONCURRENCY,
              (group) =>
                serializeFindingAppend(
                  targetWorkspaceId,
                  group.fingerprint,
                  () =>
                    appendSubmittedFindingGroup(
                      targetWorkspaceId,
                      group,
                      knownIndex,
                      playtestRepository
                    )
                )
            );

            const review: PlaytestSessionReview = {
              schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
              reviewId,
              version: 1,
              episodeId: args.episodeId,
              supersedes: null,
              evidencePacket: {
                packetId: packet.packet.packetId,
                artifact: packet.artifact
              },
              authorRole: reviewerRole,
              authorId: session.actor,
              rubricHash: args.rubricHash,
              measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
              provenance: {
                workspaceId: targetWorkspaceId,
                measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
                generatedAt: new Date().toISOString()
              },
              chronologicalSummary: args.chronologicalSummary,
              authoritativeMetrics: packet.packet.metrics,
              observations,
              interpretations,
              anchors,
              alternativeExplanations,
              reportCompleteness,
              experiments,
              status: args.status,
              findings: resolvedFindings,
              evidenceRefs,
              createdAt: new Date().toISOString(),
              notes: args.notes ?? ""
            };

            await playtestRepository.insertReview(review);
            await persistBatchReviewReceipt(
              reservedBatch,
              reviewId,
              playtestRepository
            );
            return review;
          }
        );
      })
  );

  // 9b. playtest.submitCrossSessionSynthesis
  mcp.registerTool(
    "playtest.submitCrossSessionSynthesis",
    {
      description:
        "Persist one hypothesis-only batch synthesis. Every cited locator must belong to the exact Runtime-selected packet for that episode; this artifact is distinct from all per-session reviews.",
      inputSchema: z.strictObject({
        summary: z.string().min(1).max(16_000),
        claims: z.array(crossSessionClaimSchema).min(1).max(64),
        experiments: z.array(crossSessionExperimentSchema).max(32)
      })
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        if (session.role !== REVIEWER_ROLE) {
          throw new PlaytestMcpAuthorizationError(
            "Cross-session synthesis is only available to Runtime-dispatched playtest analysts."
          );
        }
        const analysisId = session.analysisId;
        const selectedEpisodeIds = session.selectedEpisodeIds;
        const metricAggregation = session.metricAggregation;
        if (
          !analysisId ||
          !metricAggregation ||
          !selectedEpisodeIds ||
          selectedEpisodeIds.length < 2 ||
          selectedEpisodeIds.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS ||
          new Set(selectedEpisodeIds).size !== selectedEpisodeIds.length
        ) {
          throw new PlaytestMcpAuthorizationError(
            "The trusted Runtime analysis identity, metric aggregation, or multi-session selection is missing."
          );
        }
        const workspaceId = authorizeWorkspace(undefined, session);
        try {
          assertPlaytestCrossSessionMetricAggregation(
            metricAggregation,
            workspaceId,
            analysisId,
            selectedEpisodeIds
          );
        } catch {
          throw new PlaytestMcpAuthorizationError(
            "The Runtime metric aggregation is not bound to this analysis selection."
          );
        }
        const repository = requiredRunRepository(playtestRepository);
        const lockKey = JSON.stringify([workspaceId, analysisId]);
        return withAssignmentLock(
          crossSessionSynthesisLocks,
          lockKey,
          async () => {
            const existing =
              await repository.getCrossSessionSynthesisForAnalysis(
                workspaceId,
                analysisId
              );
            if (existing) return existing;

            const packetsByEpisode = new Map<
              string,
              {
                readonly episodeId: string;
                readonly batchId: string;
                readonly packet: PlaytestEvidencePacket;
              }
            >();
            for (const episodeId of selectedEpisodeIds) {
              const cacheKey = preparedAnalystPacketCacheKey(
                session,
                workspaceId,
                episodeId
              );
              const packet =
                cacheKey === null
                  ? undefined
                  : preparedAnalystPackets.get(cacheKey);
              if (packet) {
                packetsByEpisode.set(episodeId, {
                  episodeId,
                  batchId: packet.batchId,
                  packet
                });
              }
            }
            const referencedEpisodes = new Set<string>();
            const normalizedClaims: PlaytestCrossSessionClaim[] = [];
            const normalizedExperiments: PlaytestCrossSessionExperiment[] = [];
            const validateReferences = (
              references: readonly z.infer<
                typeof crossSessionEvidenceRefSchema
              >[]
            ): void => {
              for (const reference of references) {
                assertAnalystEpisodeSelected(
                  session,
                  reference.episodeId,
                  "playtest.submitCrossSessionSynthesis"
                );
                const packet = packetsByEpisode.get(reference.episodeId);
                if (!packet || packet.packet.packetId !== reference.packetId) {
                  throw new PlaytestMcpAuthorizationError(
                    "Every synthesis citation must match the frozen packet for its selected episode."
                  );
                }
                try {
                  assertPlaytestEvidenceLocatorsWithinPacket(
                    [playtestEvidenceLocatorFromInput(reference.locator)],
                    packet.packet
                  );
                } catch {
                  throw new PlaytestMcpValidationError(
                    "Every synthesis locator must resolve inside its cited frozen packet."
                  );
                }
                referencedEpisodes.add(reference.episodeId);
              }
            };
            for (const claim of args.claims) {
              validateReferences(claim.evidenceRefs);
              normalizedClaims.push({
                ...claim,
                evidenceRefs: claim.evidenceRefs.map((reference) => ({
                  episodeId: reference.episodeId,
                  packetId: reference.packetId,
                  locator: playtestEvidenceLocatorFromInput(reference.locator)
                }))
              });
            }
            for (const experiment of args.experiments) {
              validateReferences(experiment.evidenceRefs);
              normalizedExperiments.push({
                ...experiment,
                evidenceRefs: experiment.evidenceRefs.map((reference) => ({
                  episodeId: reference.episodeId,
                  packetId: reference.packetId,
                  locator: playtestEvidenceLocatorFromInput(reference.locator)
                }))
              });
            }
            if (referencedEpisodes.size < 2) {
              throw new PlaytestMcpValidationError(
                "A batch synthesis must cite evidence from at least two distinct selected sessions."
              );
            }
            const contributors = selectedEpisodeIds.flatMap((episodeId) => {
              const packet = packetsByEpisode.get(episodeId);
              return packet && referencedEpisodes.has(episodeId)
                ? [
                    {
                      episodeId,
                      batchId: packet.batchId,
                      packetId: packet.packet.packetId
                    }
                  ]
                : [];
            });
            const synthesis: PlaytestCrossSessionSynthesis = {
              schema: PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
              synthesisId: randomUUID(),
              version: 1,
              analysisId,
              workspaceId,
              authorRole: REVIEWER_ROLE,
              authorId: session.actor,
              modelId: null,
              modelRevision: null,
              promptHash: null,
              generatedAt: new Date().toISOString(),
              status: "hypothesis",
              summary: args.summary,
              contributors,
              packetEligibleEpisodeIds: [...selectedEpisodeIds],
              metricAggregation,
              claims: normalizedClaims,
              experiments: normalizedExperiments
            };
            assertPlaytestCrossSessionSynthesis(synthesis);
            await repository.insertCrossSessionSynthesis(synthesis);
            return synthesis;
          }
        );
      })
  );

  // 9. playtest.findings
  mcp.registerTool(
    "playtest.findings",
    {
      description:
        "List verified or hypothesized playtest findings with filter and pagination.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        severity: z.enum([...PLAYTESTS_SEVERITIES]).optional(),
        status: z.enum([...PLAYTESTS_FINDING_STATUSES]).optional(),
        verificationStage: z
          .enum([...PLAYTESTS_VERIFICATION_STAGES])
          .optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          FINDING_READER_ROLES,
          "playtest.findings"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for listing findings."
          );
        }

        const page = await playtestRepository.listFindings(
          {
            workspaceId: targetWorkspaceId,
            ...(args.severity ? { severity: args.severity } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.verificationStage
              ? { verificationStage: args.verificationStage }
              : {})
          },
          {
            limit: args.limit,
            ...(args.cursor ? { cursor: args.cursor } : {})
          }
        );

        return {
          rows: page.rows,
          total: page.total,
          nextCursor: page.nextCursor
        };
      })
  );

  // 10. playtest.issueDrafts
  mcp.registerTool(
    "playtest.issueDrafts",
    {
      description:
        "Propose review-gated issue drafts for a workspace's findings. AutoDev never publishes: drafts are returned for an operator to read, and every draft carries requiresOperatorAction.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        severity: z.enum([...PLAYTESTS_SEVERITIES]).optional(),
        status: z.enum([...PLAYTESTS_FINDING_STATUSES]).optional(),
        verificationStage: z
          .enum([...PLAYTESTS_VERIFICATION_STAGES])
          .optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          FINDING_READER_ROLES,
          "playtest.issueDrafts"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for drafting issues."
          );
        }
        // Both gates come from the owner's capabilities view, which already
        // resolves the operator's grant and the game's checked-in declaration.
        // Reading either from anywhere else would give the gate two answers.
        const capabilities = await requirePlaytestRunControl(
          playtestRunControl
        ).getCapabilities(session, targetWorkspaceId);
        const gates = {
          configuredReporting: capabilities.configuredIssueReporting,
          approvedReporting: capabilities.issueReporting
        };
        const page = await playtestRepository.listFindings(
          {
            workspaceId: targetWorkspaceId,
            ...(args.severity ? { severity: args.severity } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.verificationStage
              ? { verificationStage: args.verificationStage }
              : {})
          },
          {
            limit: args.limit,
            ...(args.cursor ? { cursor: args.cursor } : {})
          }
        );
        const drafts: readonly PlaytestIssueDraft[] = buildPlaytestIssueDrafts({
          ...gates,
          findings: page.rows
        });
        return {
          drafts,
          // A non-null refusal names the gate that withheld authority, so a
          // caller can explain an empty result instead of guessing.
          refusal: playtestIssueReportingRefusal({
            ...gates,
            findings: page.rows
          }),
          // Explicit about the window examined: a truncated page must not read
          // as "these were all the issues worth filing".
          examinedFindings: page.total,
          nextCursor: page.nextCursor,
          published: false as const,
          requiresOperatorAction: true as const
        };
      })
  );

  // 10b. playtest.policyValidity
  mcp.registerTool(
    "playtest.policyValidity",
    {
      description:
        "Derive PlayerPolicyValidity for the policies a batch actually ran, per measurement contract §6. Reports a validity record plus the sentence a caller must carry when a policy may not stand in for a human player. This tool takes no human-evidence input: the held-out decision states and acceptance bounds are the project's preregistration, so with none registered every record is unvalidated-synthetic.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        batchId: z.string().min(1).max(256)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          ANALYSIS_READER_ROLES,
          "playtest.policyValidity"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        const repository = requiredRunRepository(playtestRepository);
        const batch = await repository.getBatch(
          targetWorkspaceId,
          args.batchId
        );
        if (!batch) {
          throw new PlaytestMcpValidationError(
            `No batch '${args.batchId}' exists in this workspace.`
          );
        }

        // Policy versions come from the approved benchmark rather than from
        // this call: an id means whatever the approval said it means, and a
        // validity record pinned to a guessed version would look checkable
        // without being checkable. An unreadable approval is reported as an
        // absent basis rather than silently substituted.
        let policyVersions: Readonly<Record<string, string>> = {};
        let policyVersionsBasis: string | null = null;
        try {
          const approval = approvalRepository?.read(targetWorkspaceId);
          if (approval && approval.revokedAt === null) {
            const prepared = prepareSandboxHandler(approval);
            if (prepared.benchmark) {
              policyVersions = prepared.benchmark.policyVersions;
              policyVersionsBasis = prepared.benchmarkHash;
            }
          }
        } catch {
          policyVersions = {};
          policyVersionsBasis = null;
        }

        const derived = derivePlaytestPolicyValidity({
          batch,
          policyVersions,
          createdAt: new Date().toISOString()
        });

        return {
          batchId: batch.batchId,
          batchStatus: batch.status,
          buildSha: batch.buildSha,
          // The content address of the frozen manifest the records rest on, so
          // a reader can verify the basis rather than trust this summary.
          coverageManifestHash: batch.coverageManifest?.contentHash ?? null,
          policyVersionsBasis,
          records: derived.records,
          unmeasurable: derived.unmeasurable,
          // No human-evidence source is wired yet; stating it keeps an absent
          // preregistration from reading as an omitted field.
          preregisteredHumanEvidence: false as const
        };
      })
  );

  // 10c. playtest.triageFindings
  mcp.registerTool(
    "playtest.triageFindings",
    {
      description:
        "Rank a workspace's findings by the measurement contract §9 triage order and say why each one landed where it did. Findings whose exposure was never measured are reported as unmeasured rather than as zero exposure. Operator overrides are supplied per call, are carried with their author and reason, and are never persisted here.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        severity: z.enum([...PLAYTESTS_SEVERITIES]).optional(),
        status: z.enum([...PLAYTESTS_FINDING_STATUSES]).optional(),
        verificationStage: z
          .enum([...PLAYTESTS_VERIFICATION_STAGES])
          .optional(),
        overrides: z
          .array(
            z.object({
              findingId: z.string().min(1).max(256),
              author: z.string().min(1).max(256),
              reason: z.string().min(1).max(1024),
              forcedSeverity: z.enum([...PLAYTESTS_SEVERITIES])
            })
          )
          .max(200)
          .optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.number().int().min(1).max(500).default(50)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          FINDING_READER_ROLES,
          "playtest.triageFindings"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        if (!playtestRepository) {
          throw new PlaytestMcpUnavailableError(
            "Playtest data repository is not configured for triage."
          );
        }
        const page = await playtestRepository.listFindings(
          {
            workspaceId: targetWorkspaceId,
            ...(args.severity ? { severity: args.severity } : {}),
            ...(args.status ? { status: args.status } : {}),
            ...(args.verificationStage
              ? { verificationStage: args.verificationStage }
              : {})
          },
          {
            limit: args.limit,
            ...(args.cursor ? { cursor: args.cursor } : {})
          }
        );
        const overrides = args.overrides ?? [];
        const ranked = triagePlaytestFindings(page.rows, overrides);
        const examined = new Set(page.rows.map((finding) => finding.findingId));
        return {
          ranked,
          // A truncated page must not read as "these are the findings worth
          // working on": the ranking is exactly as complete as the page.
          examinedFindings: page.total,
          rankedFindings: ranked.length,
          nextCursor: page.nextCursor,
          // An override naming a finding that is not in the examined page is
          // inert. Naming it beats applying it silently or failing the call.
          overridesNotInPage: overrides
            .filter((override) => !examined.has(override.findingId))
            .map((override) => override.findingId),
          // Overrides rank a reading; this tool records nothing.
          persisted: false as const
        };
      })
  );

  // 10d. playtest.cohortMixShift
  mcp.registerTool(
    "playtest.cohortMixShift",
    {
      description:
        "Standardize per-cohort observation counts across runs against the approved benchmark's frozen cohort weights (§10/§11 mix-shift gate). This is a comparison, so it takes a reference and a candidate batch: a cohort mix can only have shifted between two builds. Refuses rather than padding: if the benchmark weights a cohort any supplied build never observed, or a build observed a cohort the benchmark does not weight, it names those cohorts and returns no result, because a zero-filled cohort would claim the run looked and observed nothing.",
      inputSchema: {
        workspaceId: z.string().min(1).max(256).optional(),
        referenceBatchId: z.string().min(1).max(256),
        candidateBatchId: z.string().min(1).max(256),
        metricId: z.string().min(1).max(256)
      }
    },
    (args) =>
      safely(async () => {
        const session = await sessionProvider.current();
        assertPlaytestToolRole(
          session.role,
          ANALYSIS_READER_ROLES,
          "playtest.cohortMixShift"
        );
        const targetWorkspaceId = authorizeWorkspace(args.workspaceId, session);
        const repository = requiredRunRepository(playtestRepository);
        const reference = await repository.getBatch(
          targetWorkspaceId,
          args.referenceBatchId
        );
        if (!reference) {
          throw new PlaytestMcpValidationError(
            `No batch '${args.referenceBatchId}' exists in this workspace.`
          );
        }
        const candidate = await repository.getBatch(
          targetWorkspaceId,
          args.candidateBatchId
        );
        if (!candidate) {
          throw new PlaytestMcpValidationError(
            `No batch '${args.candidateBatchId}' exists in this workspace.`
          );
        }
        if (
          reference.executionMode !== PLAYTEST_ADAPTER_MODE ||
          candidate.executionMode !== PLAYTEST_ADAPTER_MODE
        ) {
          throw new PlaytestMcpValidationError(
            "Cohort mix-shift standardization requires adapter batches with verified builds; visual batches are not comparable on that axis."
          );
        }

        // The weights are the approved benchmark's, so the gate is judged
        // against the frozen distribution rather than this build's sample mix.
        let benchmark: PlaytestBenchmark | null = null;
        let benchmarkHash: string | null = null;
        try {
          const approval = approvalRepository?.read(targetWorkspaceId);
          if (approval && approval.revokedAt === null) {
            const prepared = prepareSandboxHandler(approval);
            if (prepared.benchmark) {
              benchmark = prepared.benchmark;
              benchmarkHash = prepared.benchmarkHash;
            }
          }
        } catch {
          benchmark = null;
          benchmarkHash = null;
        }
        if (!benchmark) {
          throw new PlaytestMcpValidationError(
            "No approved benchmark declares cohort weights for this workspace."
          );
        }

        const pages = await Promise.all(
          [reference, candidate].map((run) =>
            repository.listEpisodes({
              workspaceId: targetWorkspaceId,
              batchId: run.batchId
            })
          )
        );
        const outcome = standardizePlaytestCohorts({
          benchmark,
          runs: [
            { batch: reference, episodes: pages[0]!.rows },
            { batch: candidate, episodes: pages[1]!.rows }
          ],
          metricId: args.metricId
        });

        return {
          referenceBatchId: reference.batchId,
          candidateBatchId: candidate.batchId,
          referenceBuildSha: reference.buildSha,
          candidateBuildSha: candidate.buildSha,
          metricId: args.metricId,
          benchmarkId: benchmark.benchmarkId,
          benchmarkContentHash: benchmarkHash,
          standardized: outcome.result !== null,
          result: outcome.result,
          buildObservations: outcome.buildObservations,
          contributingEpisodesByBuild: outcome.contributingEpisodesByBuild,
          skippedRowsByBuild: outcome.skippedRowsByBuild,
          // Named rather than folded into the result, because a non-empty list
          // is the whole reason there is no result.
          refusals: outcome.refusals,
          // Explicit about the window: a truncated episode page undercounts
          // every cohort, so the counts must not read as complete.
          examinedEpisodes: pages.map((page) => page.total),
          scoredEpisodes: pages.map((page) => page.rows.length),
          nextCursor: pages.map((page) => page.nextCursor)
        };
      })
  );

  // 11. playtest.branch
  mcp.registerTool(
    "playtest.branch",
    {
      description:
        "Accept `{launchRequest}` using the same Core PlaytestLaunchRequest schema as playtest.run, including its current capabilityRevision and unique client requestId, with mode=adapter-accelerated and operation.kind=branch. Runtime requires a complete source episode, verified full-state/RNG checkpoint, an alternate legal action, and exact approved build/config provenance.",
      inputSchema: z.strictObject({
        launchRequest: playtestBranchLaunchRequestSchema
      })
    },
    ({ launchRequest }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return requirePlaytestRunControl(playtestRunControl).startRun(
          session,
          launchRequest
        );
      })
  );

  return Object.assign(mcp, { playtestRunControl });
}

async function safely<T>(operation: () => Promise<T>) {
  try {
    const result = await operation();
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) }
      ]
    };
  } catch (error) {
    const safeError = playtestMcpErrorDetails(error);
    if (safeError.code === "playtest_internal_error") {
      // Keep a breadcrumb without serializing stacks that can contain
      // checkout paths or untrusted adapter/Data error text.
      writeErrorLine("playtest-mcp: internal operation failure.");
    }
    return {
      isError: true,
      content: [
        { type: "text" as const, text: JSON.stringify({ error: safeError }) }
      ]
    };
  }
}
