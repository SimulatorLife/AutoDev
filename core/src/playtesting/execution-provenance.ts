import type {
  PlaytestAdapterEpisode,
  PlaytestBranchLineage,
  PlaytestEpisode,
  PlaytestEpisodeIdentity
} from "./artifacts.ts";
import {
  PLAYTEST_EXECUTION_MODES,
  type PlaytestExecutionMode
} from "./launch-request.ts";

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
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const ADAPTER_MODE = "adapter-accelerated" as const;
const VISUAL_MODE = "autonomous-visual" as const;
const SCRIPTED_MODE = "scripted-regression" as const;
const UNKNOWN_VALUE = "unknown" as const;
const NOT_APPLICABLE = "not-applicable" as const;
const ENGINE_ADAPTER = "engine-adapter" as const;
const ENGINE_POLICY = "engine-policy" as const;
const BROWSER_UI = "browser-ui" as const;
const BROWSER_INPUT = "browser-input" as const;
const RECORDED_TRACE = "recorded-trace" as const;
const SCRIPTED_CONTROL = "scripted-control" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || isNonEmptyText(value);
}

function assertSourceRevision(source: Record<string, unknown>): void {
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
    source.revisionConfidence === NOT_APPLICABLE &&
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
    (source.revisionConfidence !== NOT_APPLICABLE ||
      source.revision !== null ||
      source.repository !== null)
  ) {
    throw new TypeError(
      "URL-only sources cannot claim a repository commit revision."
    );
  }
}

function assertModeChannels(
  provenance: Record<string, unknown>,
  source: Record<string, unknown>
): void {
  switch (provenance.mode) {
    case "legacy-unknown": {
      if (
        provenance.observationSource !== UNKNOWN_VALUE ||
        provenance.actionSource !== UNKNOWN_VALUE ||
        source.kind !== UNKNOWN_VALUE
      ) {
        throw new TypeError(
          "Unknown legacy execution cannot claim a source or action channel."
        );
      }
      return;
    }
    case ADAPTER_MODE: {
      if (
        provenance.observationSource !== ENGINE_ADAPTER ||
        provenance.actionSource !== ENGINE_POLICY
      ) {
        throw new TypeError(
          "Adapter-accelerated episodes require engine observation and policy action sources."
        );
      }
      return;
    }
    case VISUAL_MODE: {
      if (
        provenance.observationSource !== BROWSER_UI ||
        provenance.actionSource !== BROWSER_INPUT ||
        typeof source.targetId !== "string" ||
        typeof source.targetOrigin !== "string"
      ) {
        throw new TypeError(
          "Autonomous visual provenance requires its approved browser target and input channels."
        );
      }
      return;
    }
    case SCRIPTED_MODE: {
      if (
        provenance.observationSource !== RECORDED_TRACE ||
        provenance.actionSource !== SCRIPTED_CONTROL
      ) {
        throw new TypeError(
          "Scripted regression provenance requires recorded observations and scripted controls."
        );
      }
    }
  }
}

function assertDerivedFrom(value: unknown): void {
  if (value === null) return;
  if (
    !isRecord(value) ||
    typeof value.episodeId !== "string" ||
    !RECORD_ID_PATTERN.test(value.episodeId) ||
    !Number.isSafeInteger(value.stepId) ||
    (value.stepId as number) < 0 ||
    (value.stateDigest !== null &&
      (typeof value.stateDigest !== "string" ||
        !SHA256_PATTERN.test(value.stateDigest)))
  ) {
    throw new TypeError("Execution provenance hand-off identity is invalid.");
  }
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
      (!isNonEmptyText(sourceValue) || sourceValue.length > 2048)
    ) {
      throw new TypeError(`Execution provenance ${field} is invalid.`);
    }
  }
  if (
    source.targetOrigin !== null &&
    (typeof source.targetOrigin !== "string" ||
      source.targetOrigin.length > 2048 ||
      !ORIGIN_PATTERN.test(source.targetOrigin))
  ) {
    throw new TypeError("Execution provenance target origin is invalid.");
  }
  assertSourceRevision(source);
  assertModeChannels(value, source);
  assertDerivedFrom(value.derivedFrom);
}

/**
 * Validate source/build identity according to the frozen execution mode.
 * Visual URL sessions may carry null build/engine facts; adapter sessions may
 * not downgrade those exact replay requirements to unknown.
 */
export function assertPlaytestEpisodeIdentityForMode(
  identity: unknown,
  provenance: PlaytestExecutionProvenance
): asserts identity is PlaytestEpisodeIdentity {
  if (!isRecord(identity)) {
    throw new TypeError("Playtest episode identity must be an object.");
  }
  const workspaceId = identity.workspaceId;
  const nullableTextFields = [
    "repository",
    "gameBuild",
    "scenarioId",
    "seed",
    "modelId",
    "modelRevision",
    "rngAlgorithm",
    "rngVersion"
  ] as const;
  if (
    typeof workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(workspaceId) ||
    nullableTextFields.some((field) => !isNullableText(identity[field])) ||
    (identity.buildSha !== null &&
      (typeof identity.buildSha !== "string" ||
        !COMMIT_PATTERN.test(identity.buildSha))) ||
    (identity.configHash !== null &&
      (typeof identity.configHash !== "string" ||
        !SHA256_PATTERN.test(identity.configHash))) ||
    (identity.protocolVersion !== null && identity.protocolVersion !== 1) ||
    !RECORD_ID_PATTERN.test(String(identity.policyId)) ||
    !isNonEmptyText(identity.policyVersion) ||
    (identity.rngInitialStateHash !== null &&
      (typeof identity.rngInitialStateHash !== "string" ||
        !SHA256_PATTERN.test(identity.rngInitialStateHash)))
  ) {
    throw new TypeError("Playtest episode identity contains invalid fields.");
  }
  assertIdentitySchemaHashes(identity);
  if (
    !isNonEmptyText(identity.runtimeVersion) ||
    !isNonEmptyText(identity.environmentHash)
  ) {
    throw new TypeError("Playtest episode runtime identity is invalid.");
  }
  if (provenance.mode === ADAPTER_MODE) {
    assertAdapterIdentity(identity);
  } else if (provenance.mode === VISUAL_MODE) {
    assertVisualIdentity(identity, provenance);
  }
}

function assertIdentitySchemaHashes(identity: Record<string, unknown>): void {
  for (const field of [
    "observationSchemaHash",
    "actionSchemaHash",
    "eventSchemaHash"
  ] as const) {
    const value = identity[field];
    if (
      value !== null &&
      (typeof value !== "string" || !SHA256_PATTERN.test(value))
    ) {
      throw new TypeError(`Playtest episode identity ${field} is invalid.`);
    }
  }
}

function assertAdapterIdentity(identity: Record<string, unknown>): void {
  if (
    typeof identity.repository !== "string" ||
    typeof identity.buildSha !== "string" ||
    typeof identity.gameBuild !== "string" ||
    typeof identity.scenarioId !== "string" ||
    typeof identity.configHash !== "string" ||
    typeof identity.seed !== "string" ||
    identity.protocolVersion !== 1 ||
    typeof identity.observationSchemaHash !== "string" ||
    typeof identity.actionSchemaHash !== "string" ||
    typeof identity.eventSchemaHash !== "string"
  ) {
    throw new TypeError(
      "Adapter episodes require their exact build, scenario, seed, and protocol identity."
    );
  }
}

function assertVisualIdentity(
  identity: Record<string, unknown>,
  provenance: PlaytestExecutionProvenance
): void {
  const expectedBuildSha =
    provenance.source.revisionConfidence === "verified"
      ? provenance.source.revision
      : null;
  if (
    identity.repository !== provenance.source.repository ||
    identity.buildSha !== expectedBuildSha ||
    identity.gameBuild !== null ||
    identity.scenarioId !== null ||
    identity.configHash !== null ||
    identity.seed !== null ||
    identity.protocolVersion !== null ||
    identity.rngInitialStateHash !== null ||
    identity.rngAlgorithm !== null ||
    identity.rngVersion !== null ||
    typeof identity.observationSchemaHash !== "string" ||
    typeof identity.actionSchemaHash !== "string" ||
    typeof identity.eventSchemaHash !== "string"
  ) {
    throw new TypeError(
      "Visual episodes cannot claim unobserved adapter config, scenario, seed, RNG, or protocol facts."
    );
  }
}

/** Validate mode-specific scenario-family/cohort facts outside EpisodeIdentity. */
export function assertPlaytestEpisodeModeFacts(input: {
  readonly executionProvenance: PlaytestExecutionProvenance;
  readonly scenarioFamily: string | null;
  readonly policyCohort: string | null;
}): void {
  assertPlaytestExecutionProvenance(input.executionProvenance);
  for (const [field, value] of [
    ["scenarioFamily", input.scenarioFamily],
    ["policyCohort", input.policyCohort]
  ] as const) {
    if (value !== null && (!isNonEmptyText(value) || value.length > 256)) {
      throw new TypeError(`Playtest episode ${field} is invalid.`);
    }
  }
  if (input.executionProvenance.mode === VISUAL_MODE) {
    if (input.scenarioFamily !== null) {
      throw new TypeError(
        "Visual exploration cannot claim an unobserved engine scenario family."
      );
    }
    return;
  }
  if (
    input.executionProvenance.mode === ADAPTER_MODE &&
    (input.scenarioFamily === null || input.policyCohort === null)
  ) {
    throw new TypeError(
      "Adapter episodes require their declared scenario family and player cohort."
    );
  }
}

/** Narrow an episode to facts that the adapter measurement path requires. */
export function assertPlaytestAdapterEpisode(
  episode: PlaytestEpisode
): asserts episode is PlaytestAdapterEpisode {
  assertPlaytestEpisodeModeFacts(episode);
  if (episode.executionProvenance.mode !== ADAPTER_MODE) {
    throw new TypeError(
      "This operation requires an adapter-accelerated episode."
    );
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
