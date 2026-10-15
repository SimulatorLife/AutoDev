import type {
  PlaytestCrossSessionEvidenceRef,
  PlaytestCrossSessionMetricAggregation,
  PlaytestCrossSessionSynthesis
} from "./artifacts.ts";
import { PLAYTESTS_MAX_ANALYSIS_SESSIONS } from "./batch-run.ts";
import { assertPlaytestCrossSessionMetricAggregation } from "./cross-session-metric-aggregation.ts";
import { assertPlaytestEvidenceLocator } from "./protocol.ts";
import {
  PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
  PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA_V1
} from "./types.ts";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9@._:-]{1,256}$/u;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const MAX_SUMMARY_LENGTH = 16_000;
const PROMPT_HASH_PATTERN = /^[a-f\d]{64}$/iu;
const MAX_CLAIMS = 64;
const MAX_CLAIM_LENGTH = 8000;
const MAX_EVIDENCE_REFS_PER_CLAIM = 64;
const MAX_EXPERIMENTS = 32;
const MAX_EXPERIMENT_TEXT = 4000;
const MAX_CONTROLS = 16;
const MAX_SYNTHESIS_PAYLOAD_BYTES = 64 * 1024;
const SYNTHESIS_KEYS = new Set([
  "schema",
  "synthesisId",
  "version",
  "analysisId",
  "workspaceId",
  "authorRole",
  "authorId",
  "modelId",
  "modelRevision",
  "promptHash",
  "generatedAt",
  "status",
  "summary",
  "contributors",
  "packetEligibleEpisodeIds",
  "metricAggregation",
  "claims",
  "experiments"
]);
const SYNTHESIS_V1_KEYS = new Set(
  [...SYNTHESIS_KEYS].filter((key) => key !== "metricAggregation")
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function assertText(value: unknown, maxLength: number, label: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new TypeError(`Cross-session synthesis ${label} is invalid.`);
  }
}

function assertEvidenceReferences(
  value: unknown,
  contributors: ReadonlyMap<string, string>,
  citedEpisodes: Set<string>
): asserts value is readonly PlaytestCrossSessionEvidenceRef[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_EVIDENCE_REFS_PER_CLAIM
  ) {
    throw new TypeError(
      "Cross-session synthesis claims require bounded packet citations."
    );
  }
  for (const reference of value) {
    if (
      !isRecord(reference) ||
      !isIdentifier(reference.episodeId) ||
      !isIdentifier(reference.packetId) ||
      contributors.get(reference.episodeId) !== reference.packetId
    ) {
      throw new TypeError(
        "Cross-session synthesis citations must name a contributing episode and its exact packet."
      );
    }
    assertPlaytestEvidenceLocator(reference.locator);
    citedEpisodes.add(reference.episodeId);
    if (
      reference.locator.kind !== "episode" &&
      reference.locator.kind !== "replay-segment" &&
      reference.locator.kind !== "event" &&
      reference.locator.kind !== "frame"
    ) {
      throw new TypeError(
        "Cross-session synthesis citations may reference only packet-supplied session evidence."
      );
    }
  }
}

/**
 * Validate the structural invariants of a durable batch synthesis. Runtime
 * additionally verifies every locator against the exact frozen packet bytes.
 */
export function assertPlaytestCrossSessionSynthesis(
  value: unknown
): asserts value is PlaytestCrossSessionSynthesis {
  assertSynthesisIdentity(value);
  assertText(value.summary, MAX_SUMMARY_LENGTH, "summary");
  const packetEligibleEpisodeIds = assertPacketEligibleEpisodeIds(
    value.packetEligibleEpisodeIds
  );
  const contributors = assertSynthesisContributors(
    value.contributors,
    packetEligibleEpisodeIds
  );
  assertPlaytestCrossSessionMetricAggregation(
    value.metricAggregation,
    value.workspaceId as string,
    value.analysisId as string,
    [...packetEligibleEpisodeIds],
    { allowNotRecorded: true }
  );
  assertSynthesisMetricAggregationSources(
    value.metricAggregation as PlaytestCrossSessionMetricAggregation,
    contributors
  );
  const citedEpisodes = new Set<string>();
  assertSynthesisClaims(value.claims, contributors, citedEpisodes);
  assertSynthesisExperiments(value.experiments, contributors, citedEpisodes);
  if (
    citedEpisodes.size < 2 ||
    contributors.size !== citedEpisodes.size ||
    [...contributors.keys()].some((episodeId) => !citedEpisodes.has(episodeId))
  ) {
    throw new TypeError(
      "Cross-session synthesis must cite every contributing packet and at least two distinct sessions."
    );
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    MAX_SYNTHESIS_PAYLOAD_BYTES
  ) {
    throw new RangeError(
      "Cross-session synthesis exceeds the 64 KiB bounded artifact limit."
    );
  }
}

function assertSynthesisMetricAggregationSources(
  aggregation: PlaytestCrossSessionMetricAggregation,
  contributors: ReadonlyMap<string, string>
): void {
  if (aggregation.status === "not-recorded") return;
  const packetForEpisode = new Map(
    aggregation.sourcePackets.map((source) => [
      source.episodeId,
      source.packetId
    ])
  );
  for (const [episodeId, packetId] of contributors) {
    if (packetForEpisode.get(episodeId) !== packetId) {
      throw new TypeError(
        "Cross-session aggregation must include each cited contributor's exact packet."
      );
    }
  }
}

/** One-way migration for persisted v1 synthesis rows; no metric is inferred. */
export function migratePlaytestCrossSessionSynthesisV1(
  value: unknown
): PlaytestCrossSessionSynthesis {
  if (
    !isRecord(value) ||
    value.schema !== PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA_V1 ||
    Object.keys(value).length !== SYNTHESIS_V1_KEYS.size ||
    Object.keys(value).some((key) => !SYNTHESIS_V1_KEYS.has(key))
  ) {
    throw new TypeError("Historical cross-session synthesis v1 is malformed.");
  }
  const migrated: PlaytestCrossSessionSynthesis = {
    ...value,
    schema: PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA,
    metricAggregation: {
      schema: PLAYTESTS_CROSS_SESSION_METRIC_AGGREGATION_SCHEMA,
      workspaceId: value.workspaceId as string,
      analysisId: value.analysisId as string,
      status: "not-recorded",
      method: "ratio-of-sums-within-identical-stratum-v1",
      sourcePackets: [],
      rows: [],
      omittedMetrics: [],
      reason: "historical-synthesis-predates-aggregation"
    }
  } as unknown as PlaytestCrossSessionSynthesis;
  assertPlaytestCrossSessionSynthesis(migrated);
  return migrated;
}

function assertSynthesisIdentity(
  value: unknown
): asserts value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !SYNTHESIS_KEYS.has(key)) ||
    value.schema !== PLAYTESTS_CROSS_SESSION_SYNTHESIS_SCHEMA ||
    !isIdentifier(value.synthesisId) ||
    value.version !== 1 ||
    !isIdentifier(value.analysisId) ||
    !isIdentifier(value.authorId) ||
    typeof value.workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(value.workspaceId) ||
    value.authorRole !== "playtest-analyst" ||
    value.status !== "hypothesis" ||
    (value.modelId !== null &&
      (typeof value.modelId !== "string" || value.modelId.length > 256)) ||
    (value.modelRevision !== null &&
      (typeof value.modelRevision !== "string" ||
        value.modelRevision.length > 256)) ||
    (value.promptHash !== null &&
      (typeof value.promptHash !== "string" ||
        !PROMPT_HASH_PATTERN.test(value.promptHash))) ||
    typeof value.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.generatedAt))
  ) {
    throw new TypeError("Cross-session synthesis identity is invalid.");
  }
  if (value.modelId !== null) assertText(value.modelId, 256, "model identity");
  if (value.modelRevision !== null) {
    assertText(value.modelRevision, 256, "model revision");
  }
}

function assertPacketEligibleEpisodeIds(value: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS
  ) {
    throw new TypeError(
      "Cross-session synthesis requires a bounded set of packet-eligible sessions."
    );
  }
  const episodeIds = new Set<string>();
  for (const episodeId of value) {
    if (!isIdentifier(episodeId) || episodeIds.has(episodeId)) {
      throw new TypeError(
        "Cross-session synthesis packet-eligible session IDs must be distinct bounded identifiers."
      );
    }
    episodeIds.add(episodeId);
  }
  return episodeIds;
}

function assertSynthesisContributors(
  value: unknown,
  packetEligibleEpisodeIds: ReadonlySet<string>
): ReadonlyMap<string, string> {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > PLAYTESTS_MAX_ANALYSIS_SESSIONS
  ) {
    throw new TypeError(
      "Cross-session synthesis requires 2–40 distinct contributing sessions."
    );
  }
  const contributors = new Map<string, string>();
  for (const contributor of value) {
    if (
      !isRecord(contributor) ||
      !isIdentifier(contributor.episodeId) ||
      !isIdentifier(contributor.batchId) ||
      !isIdentifier(contributor.packetId) ||
      !packetEligibleEpisodeIds.has(contributor.episodeId) ||
      contributors.has(contributor.episodeId)
    ) {
      throw new TypeError(
        "Cross-session synthesis contributors must be distinct bounded packet identities."
      );
    }
    contributors.set(contributor.episodeId, contributor.packetId);
  }
  return contributors;
}

function assertSynthesisClaims(
  value: unknown,
  contributors: ReadonlyMap<string, string>,
  citedEpisodes: Set<string>
): void {
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) {
    throw new TypeError("Cross-session synthesis claims exceed their bound.");
  }
  for (const claim of value) {
    if (
      !isRecord(claim) ||
      !["pattern", "counterexample", "confounder"].includes(String(claim.kind))
    ) {
      throw new TypeError("Cross-session synthesis claim kind is invalid.");
    }
    assertText(claim.text, MAX_CLAIM_LENGTH, "claim");
    assertEvidenceReferences(claim.evidenceRefs, contributors, citedEpisodes);
    if (
      claim.kind === "pattern" &&
      new Set(claim.evidenceRefs.map((reference) => reference.episodeId)).size <
        2
    ) {
      throw new TypeError(
        "Cross-session patterns must cite at least two distinct contributing sessions."
      );
    }
  }
}

function assertSynthesisExperiments(
  value: unknown,
  contributors: ReadonlyMap<string, string>,
  citedEpisodes: Set<string>
): void {
  if (!Array.isArray(value) || value.length > MAX_EXPERIMENTS) {
    throw new TypeError(
      "Cross-session synthesis experiments exceed their bound."
    );
  }
  for (const experiment of value) {
    if (!isRecord(experiment) || !Array.isArray(experiment.controls)) {
      throw new TypeError("Cross-session synthesis experiment is malformed.");
    }
    assertText(
      experiment.hypothesis,
      MAX_EXPERIMENT_TEXT,
      "experiment hypothesis"
    );
    assertText(
      experiment.falsifier,
      MAX_EXPERIMENT_TEXT,
      "experiment falsifier"
    );
    assertText(experiment.metricId, 256, "experiment metric");
    assertText(experiment.budget, MAX_EXPERIMENT_TEXT, "experiment budget");
    if (
      experiment.controls.length === 0 ||
      experiment.controls.length > MAX_CONTROLS
    ) {
      throw new TypeError(
        "Cross-session synthesis experiments require bounded controls."
      );
    }
    for (const control of experiment.controls) {
      assertText(control, MAX_EXPERIMENT_TEXT, "experiment control");
    }
    assertEvidenceReferences(
      experiment.evidenceRefs,
      contributors,
      citedEpisodes
    );
  }
}
