import { createHash } from "node:crypto";

import { normalizeTranscript } from "@letta-ai/trajectory";

import { sanitizeEvidenceReference } from "./privacy.ts";

export const NATIVE_TRAJECTORY_SOURCES = [
  "codex",
  "claude-code",
  "copilot-cli",
  "gemini-cli"
] as const;

export type NativeTrajectorySource = (typeof NATIVE_TRAJECTORY_SOURCES)[number];

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

export interface NormalizedTrajectorySummary {
  readonly format: "letta-trajectory-v1";
  readonly source: NativeTrajectorySource;
  readonly uri: string;
  readonly digest: string;
  readonly recordCount: number;
  readonly diagnosticCount: number;
  readonly roleCounts: Readonly<Partial<Record<string, number>>>;
  readonly firstTimestamp?: string;
  readonly lastTimestamp?: string;
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
  if (Buffer.byteLength(input.transcript, "utf8") > MAX_TRANSCRIPT_BYTES)
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
  return {
    format: "letta-trajectory-v1",
    source: input.source,
    uri: safeReference.uri,
    digest: createHash("sha256").update(input.transcript, "utf8").digest("hex"),
    recordCount: normalized.records.length,
    diagnosticCount: normalized.diagnostics.length,
    roleCounts,
    ...(firstTimestamp ? { firstTimestamp } : {}),
    ...(lastTimestamp ? { lastTimestamp } : {})
  };
}
