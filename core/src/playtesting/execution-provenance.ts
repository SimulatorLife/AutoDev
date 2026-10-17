import {
  PLAYTEST_EXECUTION_MODES,
  type PlaytestExecutionMode
} from "./launch-request.ts";
import type {
  PlaytestBranchLineage,
  PlaytestEpisodeIdentity
} from "./artifacts.ts";

export const PLAYTEST_EPISODE_EXECUTION_MODES = [
  ...PLAYTEST_EXECUTION_MODES,
  "legacy-unknown"
] as const;
export type PlaytestEpisodeExecutionMode =
  PlaytestExecutionMode | "legacy-unknown";

export const PLAYTEST_EXECUTION_SOURCE_KINDS = [
  "repo-checkout",
  "deployed-build",
  "URL-only",
  "native-install",
  "unknown"
] as const;
export type PlaytestExecutionSourceKind =
  (typeof PLAYTEST_EXECUTION_SOURCE_KINDS)[number];

export const PLAYTEST_EXECUTION_REVISION_CONFIDENCE = [
  "verified",
  "unknown",
  "not-applicable"
] as const;
export type PlaytestExecutionRevisionConfidence =
  (typeof PLAYTEST_EXECUTION_REVISION_CONFIDENCE)[number];

export const PLAYTEST_EXECUTION_CHECKOUT_STATES = [
  "clean",
  "dirty",
  "untracked",
  "mixed",
  "unknown",
  "not-applicable"
] as const;
export type PlaytestExecutionCheckoutState =
  (typeof PLAYTEST_EXECUTION_CHECKOUT_STATES)[number];

export const PLAYTEST_EXECUTION_OBSERVATION_SOURCES = [
  "engine-adapter",
  "browser-ui",
  "recorded-trace",
  "unknown"
] as const;
export type PlaytestExecutionObservationSource =
  (typeof PLAYTEST_EXECUTION_OBSERVATION_SOURCES)[number];

export const PLAYTEST_EXECUTION_ACTION_SOURCES = [
  "engine-policy",
  "browser-input",
  "scripted-control",
  "unknown"
] as const;
export type PlaytestExecutionActionSource =
  (typeof PLAYTEST_EXECUTION_ACTION_SOURCES)[number];

/** Exact execution mode and the evidence supporting its source/build identity. */
export interface PlaytestExecutionProvenance {
  readonly mode: PlaytestEpisodeExecutionMode;
  readonly source: {
    readonly kind: PlaytestExecutionSourceKind;
    readonly repository: string | null;
    readonly revision: string | null;
    readonly revisionConfidence: PlaytestExecutionRevisionConfidence;
    readonly checkoutState: PlaytestExecutionCheckoutState;
    readonly artifactFingerprint: string | null;
    readonly targetId: string | null;
    readonly targetOrigin: string | null;
  };
  readonly observationSource: PlaytestExecutionObservationSource;
  readonly actionSource: PlaytestExecutionActionSource;
  readonly derivedFrom: {
    readonly episodeId: string;
    readonly stepId: number;
    readonly stateDigest: string | null;
  } | null;
}

const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const COMMIT_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const ORIGIN_PATTERN = /^https?:\/\/[^/\s]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate source facts without inferring a mode from the game outcome. */
export function assertPlaytestExecutionProvenance(
  value: unknown
): asserts value is PlaytestExecutionProvenance {
  if (!isRecord(value)) {
    throw new TypeError("Execution provenance must be an object.");
  }
  const source = value.source;
  if (
    !PLAYTEST_EPISODE_EXECUTION_MODES.includes(
      value.mode as PlaytestEpisodeExecutionMode
    ) ||
    !isRecord(source) ||
    !PLAYTEST_EXECUTION_SOURCE_KINDS.includes(
      source.kind as PlaytestExecutionSourceKind
    ) ||
    !PLAYTEST_EXECUTION_REVISION_CONFIDENCE.includes(
      source.revisionConfidence as PlaytestExecutionRevisionConfidence
    ) ||
    !PLAYTEST_EXECUTION_CHECKOUT_STATES.includes(
      source.checkoutState as PlaytestExecutionCheckoutState
    ) ||
    !PLAYTEST_EXECUTION_OBSERVATION_SOURCES.includes(
      value.observationSource as PlaytestExecutionObservationSource
    ) ||
    !PLAYTEST_EXECUTION_ACTION_SOURCES.includes(
      value.actionSource as PlaytestExecutionActionSource
    )
  ) {
    throw new TypeError("Execution provenance contains an unsupported value.");
  }
  for (const [field, sourceValue] of [
    ["repository", source.repository],
    ["revision", source.revision],
    ["artifactFingerprint", source.artifactFingerprint],
    ["targetId", source.targetId],
    ["targetOrigin", source.targetOrigin]
  ] as const) {
    if (
      sourceValue !== null &&
      (typeof sourceValue !== "string" ||
        sourceValue.trim().length === 0 ||
        sourceValue.length > 2048)
    ) {
      throw new TypeError(`Execution provenance ${field} is invalid.`);
    }
  }
  if (
    source.revisionConfidence === "verified" &&
    source.revision === null &&
    source.artifactFingerprint === null
  ) {
    throw new TypeError(
      "Verified execution provenance requires a revision or artifact fingerprint."
    );
  }
  if (
    source.revisionConfidence === "not-applicable" &&
    (source.revision !== null || source.artifactFingerprint !== null)
  ) {
    throw new TypeError(
      "Not-applicable execution revisions cannot carry a revision or fingerprint."
    );
  }
  if (
    source.kind === "repo-checkout" &&
    source.revisionConfidence === "verified" &&
    (typeof source.repository !== "string" ||
      typeof source.revision !== "string" ||
      !COMMIT_PATTERN.test(source.revision))
  ) {
    throw new TypeError(
      "A verified checkout source requires its repository and exact commit."
    );
  }
  if (
    source.kind === "URL-only" &&
    (source.revisionConfidence !== "not-applicable" ||
      source.revision !== null ||
      source.repository !== null)
  ) {
    throw new TypeError(
      "URL-only sources cannot claim a repository commit revision."
    );
  }
  const targetOrigin = source.targetOrigin;
  if (
    targetOrigin !== null &&
    (typeof targetOrigin !== "string" ||
      targetOrigin.length > 2048 ||
      !ORIGIN_PATTERN.test(targetOrigin))
  ) {
    throw new TypeError("Execution provenance target origin is invalid.");
  }
  if (value.mode === "legacy-unknown") {
    if (
      value.observationSource !== "unknown" ||
      value.actionSource !== "unknown" ||
      source.kind !== "unknown"
    ) {
      throw new TypeError(
        "Unknown legacy execution cannot claim a source or action channel."
      );
    }
  }
  if (value.mode === "adapter-accelerated") {
    if (
      value.observationSource !== "engine-adapter" ||
      value.actionSource !== "engine-policy"
    ) {
      throw new TypeError(
        "Adapter-accelerated episodes require engine observation and policy action sources."
      );
    }
  }
  if (value.mode === "autonomous-visual") {
    if (
      value.observationSource !== "browser-ui" ||
      value.actionSource !== "browser-input" ||
      typeof source.targetId !== "string" ||
      typeof source.targetOrigin !== "string"
    ) {
      throw new TypeError(
        "Autonomous visual provenance requires its approved browser target and input channels."
      );
    }
  }
  if (value.mode === "scripted-regression") {
    if (
      value.observationSource !== "recorded-trace" ||
      value.actionSource !== "scripted-control"
    ) {
      throw new TypeError(
        "Scripted regression provenance requires recorded observations and scripted controls."
      );
    }
  }
  if (value.derivedFrom !== null) {
    if (
      !isRecord(value.derivedFrom) ||
      typeof value.derivedFrom.episodeId !== "string" ||
      !RECORD_ID_PATTERN.test(value.derivedFrom.episodeId) ||
      !Number.isSafeInteger(value.derivedFrom.stepId) ||
      (value.derivedFrom.stepId as number) < 0 ||
      (value.derivedFrom.stateDigest !== null &&
        (typeof value.derivedFrom.stateDigest !== "string" ||
          !SHA256_PATTERN.test(value.derivedFrom.stateDigest)))
    ) {
      throw new TypeError("Execution provenance hand-off identity is invalid.");
    }
  }
}

/**
 * Assign historical provenance only when the old episode itself proves the
 * adapter protocol. Other historical modes remain explicitly unknown.
 */
export function legacyPlaytestExecutionProvenance(input: {
  readonly identity: PlaytestEpisodeIdentity;
  readonly branchLineage: PlaytestBranchLineage | null;
}): PlaytestExecutionProvenance {
  const identity = input.identity as Partial<PlaytestEpisodeIdentity>;
  const repository =
    typeof identity.repository === "string" &&
    identity.repository.trim().length > 0
      ? identity.repository
      : null;
  const buildSha =
    typeof identity.buildSha === "string" ? identity.buildSha : null;
  const adapterEvidence =
    identity.protocolVersion === 1 &&
    typeof identity.gameBuild === "string" &&
    identity.gameBuild.trim().length > 0 &&
    typeof identity.configHash === "string" &&
    SHA256_PATTERN.test(identity.configHash) &&
    typeof identity.observationSchemaHash === "string" &&
    SHA256_PATTERN.test(identity.observationSchemaHash) &&
    typeof identity.actionSchemaHash === "string" &&
    SHA256_PATTERN.test(identity.actionSchemaHash) &&
    typeof identity.eventSchemaHash === "string" &&
    SHA256_PATTERN.test(identity.eventSchemaHash);
  const verifiedCheckout =
    adapterEvidence &&
    repository !== null &&
    buildSha !== null &&
    COMMIT_PATTERN.test(buildSha);
  const mode = adapterEvidence ? "adapter-accelerated" : "legacy-unknown";
  const sourceKind = verifiedCheckout ? "repo-checkout" : "unknown";
  const provenance: PlaytestExecutionProvenance = {
    mode,
    source: {
      kind: sourceKind,
      repository,
      revision: verifiedCheckout ? buildSha : null,
      revisionConfidence: verifiedCheckout ? "verified" : "unknown",
      checkoutState: "unknown",
      artifactFingerprint: null,
      targetId: null,
      targetOrigin: null
    },
    observationSource: adapterEvidence ? "engine-adapter" : "unknown",
    actionSource: adapterEvidence ? "engine-policy" : "unknown",
    derivedFrom:
      input.branchLineage === null
        ? null
        : {
            episodeId: input.branchLineage.parentEpisodeId,
            stepId: input.branchLineage.branchStep,
            stateDigest: input.branchLineage.forkStateHash
          }
  };
  assertPlaytestExecutionProvenance(provenance);
  return provenance;
}
