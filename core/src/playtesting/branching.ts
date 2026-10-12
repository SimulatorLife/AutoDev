import type { PlaytestBranchLineage, PlaytestEpisode } from "./artifacts.ts";
import type {
  GameRngCheckpoint,
  PlaytestCheckpointDigest
} from "./protocol-types.ts";
import {
  type PlaytestAssignmentBranch,
  PLAYTESTS_RNG_POLICY_VERSION
} from "./types.ts";

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertText(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256 ||
    [...value].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 31 || code === 127;
    })
  ) {
    throw new TypeError(field + " must be bounded non-empty text.");
  }
}

function assertSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(field + " must be a SHA-256 digest.");
  }
}

function assertArtifactReference(
  value: unknown,
  field: string,
  expectedMediaType?: string
): asserts value is {
  readonly artifactId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly revision?: number;
} {
  if (!isRecord(value))
    throw new TypeError(field + " must be an artifact reference.");
  const allowed = ["artifactId", "sha256", "bytes", "mediaType", "revision"];
  if (
    Object.keys(value).length < 4 ||
    Object.keys(value).length > allowed.length ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw new TypeError(field + " is malformed.");
  }
  assertText(value.artifactId, field + ".artifactId");
  assertSha(value.sha256, field + ".sha256");
  if (
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 1 ||
    (value.bytes as number) > 64 * 1024 * 1024
  ) {
    throw new TypeError(
      field + ".bytes is outside the artifact storage bound."
    );
  }
  assertText(value.mediaType, field + ".mediaType");
  if (
    expectedMediaType !== undefined &&
    value.mediaType !== expectedMediaType
  ) {
    throw new TypeError(field + ".mediaType is unsupported.");
  }
  if (
    value.revision !== undefined &&
    (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
  ) {
    throw new TypeError(field + ".revision must be a non-negative integer.");
  }
}

export function assertPlaytestRngCheckpoint(
  value: unknown,
  field = "rngCheckpoint"
): asserts value is GameRngCheckpoint {
  if (!isRecord(value)) throw new TypeError(field + " must be an object.");
  const expected = ["algorithm", "version", "stateHash", "reproducible"];
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new TypeError(field + " contains unsupported fields.");
  }
  assertText(value.algorithm, field + ".algorithm");
  assertText(value.version, field + ".version");
  assertSha(value.stateHash, field + ".stateHash");
  if (value.reproducible !== true) {
    throw new TypeError(field + " must identify a reproducible stream.");
  }
}

export function assertPlaytestCheckpointDigest(
  value: unknown,
  field = "checkpoint"
): asserts value is PlaytestCheckpointDigest {
  if (!isRecord(value)) throw new TypeError(field + " must be an object.");
  const expected = ["stateHash", "rngCheckpoint"];
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new TypeError(field + " contains unsupported fields.");
  }
  assertSha(value.stateHash, field + ".stateHash");
  assertPlaytestRngCheckpoint(value.rngCheckpoint, field + ".rngCheckpoint");
}

export function samePlaytestRngCheckpoint(
  left: GameRngCheckpoint,
  right: GameRngCheckpoint
): boolean {
  return (
    left.reproducible === true &&
    right.reproducible === true &&
    left.algorithm === right.algorithm &&
    left.version === right.version &&
    left.stateHash !== null &&
    left.stateHash === right.stateHash
  );
}

export function samePlaytestCheckpoint(
  left: PlaytestCheckpointDigest,
  right: PlaytestCheckpointDigest
): boolean {
  return (
    left.stateHash === right.stateHash &&
    samePlaytestRngCheckpoint(left.rngCheckpoint, right.rngCheckpoint)
  );
}

/** Validate a branch source before it is frozen into a Data assignment. */
export function assertPlaytestAssignmentBranch(
  value: unknown
): asserts value is PlaytestAssignmentBranch {
  if (!isRecord(value)) throw new TypeError("Branch source must be an object.");
  const expected = [
    "parentEpisodeId",
    "parentEpisodeRevision",
    "parentBatchId",
    "branchStep",
    "parentTrace",
    "parentCheckpoint",
    "alternativeActionId",
    "rngPolicy",
    "rngPolicyVersion"
  ];
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new TypeError("Branch source contains unsupported fields.");
  }
  assertText(value.parentEpisodeId, "branch.parentEpisodeId");
  assertText(value.parentBatchId, "branch.parentBatchId");
  if (
    !Number.isSafeInteger(value.parentEpisodeRevision) ||
    (value.parentEpisodeRevision as number) < 1
  ) {
    throw new TypeError("branch.parentEpisodeRevision must be positive.");
  }
  if (
    !Number.isSafeInteger(value.branchStep) ||
    (value.branchStep as number) < 0 ||
    (value.branchStep as number) > 99_999
  ) {
    throw new TypeError(
      "branch.branchStep must be a bounded non-negative integer."
    );
  }
  assertText(value.alternativeActionId, "branch.alternativeActionId");
  if (value.rngPolicy !== "same-stream") {
    throw new TypeError(
      "Only the verified same-stream branch policy is supported."
    );
  }
  if (value.rngPolicyVersion !== PLAYTESTS_RNG_POLICY_VERSION) {
    throw new TypeError("Branch RNG policy version is unsupported.");
  }
  assertArtifactReference(
    value.parentTrace,
    "branch.parentTrace",
    "application/x-ndjson"
  );
  assertPlaytestCheckpointDigest(
    value.parentCheckpoint,
    "branch.parentCheckpoint"
  );
}

/** Validate the persisted proof chain of a completed or partial branch episode. */
export function assertPlaytestBranchLineage(
  value: unknown,
  episode?: Pick<PlaytestEpisode, "completeness" | "missingReasons">
): asserts value is PlaytestBranchLineage {
  if (!isRecord(value))
    throw new TypeError("Branch lineage must be an object.");
  const expected = [
    "parentEpisodeId",
    "parentEpisodeRevision",
    "parentBatchId",
    "branchStep",
    "parentTrace",
    "parentCheckpoint",
    "alternativeActionId",
    "rngPolicy",
    "rngPolicyVersion",
    "replayTransitionHash",
    "snapshotArtifact",
    "snapshotIntegrityHash",
    "forkStateHash",
    "forkRngCheckpoint",
    "continuationPolicyId",
    "continuationPolicyVersion"
  ];
  if (
    Object.keys(value).length !== expected.length ||
    Object.keys(value).some((key) => !expected.includes(key))
  ) {
    throw new TypeError("Branch lineage contains unsupported fields.");
  }
  const source = {
    parentEpisodeId: value.parentEpisodeId,
    parentEpisodeRevision: value.parentEpisodeRevision,
    parentBatchId: value.parentBatchId,
    branchStep: value.branchStep,
    parentTrace: value.parentTrace,
    parentCheckpoint: value.parentCheckpoint,
    alternativeActionId: value.alternativeActionId,
    rngPolicy: value.rngPolicy,
    rngPolicyVersion: value.rngPolicyVersion
  };
  assertPlaytestAssignmentBranch(source);
  assertSha(value.replayTransitionHash, "branch.replayTransitionHash");
  assertSha(value.snapshotIntegrityHash, "branch.snapshotIntegrityHash");
  assertSha(value.forkStateHash, "branch.forkStateHash");
  assertPlaytestRngCheckpoint(
    value.forkRngCheckpoint,
    "branch.forkRngCheckpoint"
  );
  assertText(value.continuationPolicyId, "branch.continuationPolicyId");
  assertText(
    value.continuationPolicyVersion,
    "branch.continuationPolicyVersion"
  );
  const checkpoint = value.parentCheckpoint as PlaytestCheckpointDigest;
  if (
    value.forkStateHash !== checkpoint.stateHash ||
    !samePlaytestRngCheckpoint(
      value.forkRngCheckpoint as GameRngCheckpoint,
      checkpoint.rngCheckpoint
    )
  ) {
    throw new TypeError(
      "Branch state or RNG lineage does not match its source checkpoint."
    );
  }
  if (value.snapshotArtifact === null) {
    if (
      episode?.completeness === "complete" ||
      !episode?.missingReasons.includes("infrastructure-failed")
    ) {
      throw new TypeError(
        "A branch without its retained snapshot must be explicitly incomplete."
      );
    }
  } else {
    assertArtifactReference(value.snapshotArtifact, "branch.snapshotArtifact");
    const snapshot = value.snapshotArtifact as {
      readonly sha256: string;
    };
    if (
      snapshot.sha256.toLowerCase() !==
      (value.snapshotIntegrityHash as string).toLowerCase()
    ) {
      throw new TypeError(
        "Branch snapshot artifact integrity does not match its lineage."
      );
    }
  }
}
