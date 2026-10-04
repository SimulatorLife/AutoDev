import { createHash } from "node:crypto";

import {
  NORMALIZER_VERSION,
  normalizeTranscript,
  type TranscriptTrajectorySource
} from "@letta-ai/trajectory";

import { sanitizeEvidenceReference } from "./privacy.ts";

export const NATIVE_TRAJECTORY_SOURCES = [
  "codex",
  "claude-code",
  "copilot-cli",
  "gemini-cli",
  "openhands",
  "letta-code",
  "opencode",
  "cursor"
] as const satisfies readonly TranscriptTrajectorySource[];

export type NativeTrajectorySource = (typeof NATIVE_TRAJECTORY_SOURCES)[number];

export const MAX_NATIVE_TRAJECTORY_BYTES = 32 * 1024 * 1024;

/**
 * Vendor-neutral identifier Runtime persists for this normalizer. Core has
 * no dependency on this value; it is an opaque string to every layer above
 * Runtime.
 */
export const LETTA_TRAJECTORY_NORMALIZER_ID = "@letta-ai/trajectory";

export interface NormalizedTrajectorySummary {
  readonly format: "letta-trajectory-v1";
  readonly source: NativeTrajectorySource;
  readonly uri: string;
  readonly digest: string;
  readonly recordCount: number;
  readonly diagnosticCount: number;
  /**
   * Distinct, lexicographically sorted diagnostic codes emitted during
   * normalization. Codes only; diagnostic free-text `message` detail and
   * transcript content are never retained here or anywhere downstream.
   */
  readonly diagnosticCodes: readonly string[];
  readonly timestampsInferred: boolean;
  readonly roleCounts: Readonly<Partial<Record<string, number>>>;
  readonly firstTimestamp?: string;
  readonly lastTimestamp?: string;
  /** Vendor-neutral normalizer package identifier; see `LETTA_TRAJECTORY_NORMALIZER_ID`. */
  readonly normalizerId: string;
  /** Exact normalizer package version, sourced from the official `NORMALIZER_VERSION` export. */
  readonly normalizerVersion: string;
}

/**
 * Validate a native transcript with Letta's shared adapter but retain only
 * non-content metadata here. The transcript itself stays in its source system;
 * normalized prompts, reasoning, tool arguments/results are never returned or
 * persisted by this adapter.
 */
export function normalizeNativeTrajectory(input: {
  readonly source: NativeTrajectorySource;
  readonly transcript: string;
  readonly uri: string;
}): NormalizedTrajectorySummary {
  if (Buffer.byteLength(input.transcript, "utf8") > MAX_NATIVE_TRAJECTORY_BYTES)
    throw new RangeError(
      "Native trajectory exceeds the 32 MiB normalization limit."
    );
  if (!input.uri.trim())
    throw new TypeError("A source trajectory URI is required.");

  const normalized = normalizeTranscript({
    source: input.source,
    transcript: input.transcript
  });
  const roleCounts: Record<string, number> = {};
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  for (const record of normalized.records) {
    roleCounts[record.role] = (roleCounts[record.role] ?? 0) + 1;
    if ("timestamp" in record && record.timestamp) {
      if (firstTimestamp === undefined || record.timestamp < firstTimestamp)
        firstTimestamp = record.timestamp;
      if (lastTimestamp === undefined || record.timestamp > lastTimestamp)
        lastTimestamp = record.timestamp;
    }
  }

  const safeReference = sanitizeEvidenceReference({
    kind: "trajectory",
    uri: input.uri
  });
  const diagnosticCodes = [
    ...new Set(normalized.diagnostics.map(({ code }) => code))
  ].sort();

  return {
    format: "letta-trajectory-v1",
    source: input.source,
    uri: safeReference.uri,
    digest: createHash("sha256").update(input.transcript, "utf8").digest("hex"),
    recordCount: normalized.records.length,
    diagnosticCount: normalized.diagnostics.length,
    diagnosticCodes,
    timestampsInferred: normalized.diagnostics.some(
      ({ code }) =>
        code === "timestamps_synthesized" || code === "timestamps_interpolated"
    ),
    roleCounts,
    ...(firstTimestamp ? { firstTimestamp } : {}),
    ...(lastTimestamp ? { lastTimestamp } : {}),
    normalizerId: LETTA_TRAJECTORY_NORMALIZER_ID,
    normalizerVersion: NORMALIZER_VERSION
  };
}
