/**
 * Stable `PlaytestFinding` identity/fingerprint contract
 * (measurement-contract §11's missed-known-issue/duplicate-flood gate;
 * normative design in docs/playtesting-target-state.md, "Finding identity
 * and ownership").
 *
 * The identity is the dedup/correlation key that lets Root recognize a new
 * report as the *same* previously known issue across builds and policies
 * (the missed-known-issue gate) and refuses to let many superficially
 * distinct reports of one underlying defect masquerade as many unrelated
 * findings (the duplicate-flood gate). Per the target-state design, the
 * identity is built only from:
 *
 * - the target workspace/game (`workspaceId`);
 * - the game-owned invariant or design-mechanic key (`mechanicKey`);
 * - a normalized failure signature (observed events, the triggering
 *   action if any, and a reproducible witness key); and
 * - the reproducible scope the failure was observed in (scenario family,
 *   phase, modality, each "as applicable").
 *
 * Seed, batch, episode/run ID, build SHA, policy ID, model ID, timestamps
 * and incidental free-form prose are explicitly *provenance*, not identity
 * (target-state: "omit incidental seed, batch, model, run ID and source
 * build SHA from the stable dedup key while preserving them as
 * evidence/provenance"). This module enforces that boundary structurally:
 * `PlaytestFindingIdentityInput` has no field slot for any excluded
 * value, and every normalizer below rejects unknown fields outright rather
 * than silently ignoring them, so an excluded field can never enter the
 * contract -- not even by accident.
 *
 * Normalization is deliberately narrow. Every identity field is a stable,
 * workspace/game-owned identifier (mechanic keys, event labels, scenario
 * families, phase/modality names), never free prose, so this module:
 *
 * - Unicode-NFKC-normalizes and trims the raw string (compatibility-width or presentation
 *   variant forms such as fullwidth Latin letters, and composed vs.
 *   decomposed input must not change identity), then case-folds to
 *   lowercase (case is not semantic for these identifiers, matching the
 *   lowercase-kebab convention used by every other identifier in this
 *   package, e.g. scenario/metric ids in `benchmark.ts`);
 * - then requires the result to fully match a closed identifier charset
 *   (lowercase ASCII letters/digits separated by `-`, `_`, `.`, `:`
 *   or `/`). Embedded whitespace, punctuation, sentences or non-ASCII
 *   glyphs are rejected rather than silently collapsed -- a value that
 *   needs lossy rewriting to look like an identifier is not actually a
 *   stable identifier.
 *
 * This module only builds and canonically serializes the identity payload.
 * Runtime, not Core, computes the actual SHA-256 fingerprint over the
 * canonical JSON this module returns, exactly as `benchmark.ts` leaves
 * `contentHash` computation to its caller.
 */

import { canonicalPlaytestJson } from "./canonical-json.ts";
import {
  PLAYTESTS_COVERAGE_MODALITIES,
  type PlaytestCoverageModality
} from "./types.ts";

/** Bumping this constant deliberately invalidates every prior fingerprint; it is part of the hashed payload, not a free-standing version field callers can set. */
export const PLAYTESTS_FINDING_IDENTITY_SCHEMA =
  "autodev-playtest-finding-identity-v1" as const;

/** Canonical public ID namespace for a SHA-256 finding fingerprint. */
export const PLAYTESTS_FINDING_ID_PREFIX = "finding-" as const;
const FINDING_FINGERPRINT_PATTERN = /^[a-f\d]{64}$/u;

/** Build the only supported persisted finding ID from a canonical digest. */
export function playtestFindingIdFromFingerprint(fingerprint: string): string {
  if (!FINDING_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new TypeError(
      "Finding fingerprint must be a lowercase SHA-256 digest."
    );
  }
  return PLAYTESTS_FINDING_ID_PREFIX + fingerprint;
}

/** Whether a value is a canonical full-hash finding ID. */
export function isPlaytestFindingId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(PLAYTESTS_FINDING_ID_PREFIX) &&
    FINDING_FINGERPRINT_PATTERN.test(
      value.slice(PLAYTESTS_FINDING_ID_PREFIX.length)
    )
  );
}

/** Closed identifier charset: lowercase ASCII letters/digits with single-character separators. No whitespace, sentence punctuation or non-ASCII glyphs. */
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:[-_.:/][a-z0-9]+)*$/u;
const MAX_IDENTIFIER_LENGTH = 200;

/**
 * Named provenance fields the measurement contract explicitly bars from
 * the identity payload. Present for documentation and test enumeration
 * only -- `PlaytestFindingIdentityInput` has no field slot for any of
 * these, so listing them here does not grant them one.
 */
export const PLAYTESTS_FINDING_IDENTITY_EXCLUDED_FIELDS = [
  "seed",
  "batchId",
  "episodeId",
  "runId",
  "buildSha",
  "policyId",
  "modelId",
  "generatedAt",
  "timestamp",
  "notes",
  "description"
] as const;

/** Normalized failure signature: events/action/witness, never free prose. */
export interface PlaytestFindingFailureSignature {
  readonly events: readonly string[];
  readonly action: string | null;
  readonly witness: string;
}

/** Reproducible scope the failure was observed in; each field "as applicable". */
export interface PlaytestFindingScope {
  readonly scenarioFamily: string;
  readonly phase: string | null;
  readonly modality: PlaytestCoverageModality | null;
}

/** The frozen, canonically-serializable identity Runtime hashes with SHA-256. */
export interface PlaytestFindingIdentity {
  readonly identitySchema: typeof PLAYTESTS_FINDING_IDENTITY_SCHEMA;
  readonly workspaceId: string;
  readonly mechanicKey: string;
  readonly failureSignature: PlaytestFindingFailureSignature;
  readonly scope: PlaytestFindingScope;
}

/** Strict, unknown-field-rejecting input shape for `buildPlaytestFindingIdentity`. */
export interface PlaytestFindingIdentityInput {
  readonly workspaceId: string;
  readonly mechanicKey: string;
  readonly failureSignature: {
    readonly events: readonly string[];
    readonly action?: string | null;
    readonly witness: string;
  };
  readonly scope: {
    readonly scenarioFamily: string;
    readonly phase?: string | null;
    readonly modality?: PlaytestCoverageModality | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string
): void {
  const allowed = new Set<string>(keys);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new TypeError(
      label +
        " contains unsupported field(s): " +
        extra.join(", ") +
        ". Provenance such as seed/batch/episode/run ID/build SHA/policy ID/model ID/timestamps must never enter the identity contract."
    );
  }
}

/** Unicode-NFKC-normalize, trim, case-fold, then require a closed identifier charset. */
function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(label + " must be a string.");
  }
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (normalized.length === 0) {
    throw new TypeError(label + " must not be empty.");
  }
  if (normalized.length > MAX_IDENTIFIER_LENGTH) {
    throw new TypeError(label + " exceeds the maximum identifier length.");
  }
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new TypeError(
      label +
        " must be a stable identifier (lowercase ASCII letters/digits separated by -, _, ., : or /), not free-form prose."
    );
  }
  return normalized;
}

function normalizeOptionalIdentifier(
  value: unknown,
  label: string
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeIdentifier(value, label);
}

function normalizeEvents(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(label + " must be an array.");
  }
  // Order is semantic (e.g. "jump then fall then clip" differs from "fall
  // then jump"), so entries are normalized in place, not sorted or
  // deduplicated.
  return value.map((entry, index) =>
    normalizeIdentifier(entry, label + "[" + String(index) + "]")
  );
}

function normalizeModality(
  value: unknown,
  label: string
): PlaytestCoverageModality | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(label + " must be a string or null.");
  }
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (
    !(PLAYTESTS_COVERAGE_MODALITIES as readonly string[]).includes(normalized)
  ) {
    throw new TypeError(
      label +
        " must be one of " +
        PLAYTESTS_COVERAGE_MODALITIES.join(", ") +
        ", or null."
    );
  }
  return normalized as PlaytestCoverageModality;
}

const TOP_LEVEL_KEYS = [
  "workspaceId",
  "mechanicKey",
  "failureSignature",
  "scope"
] as const;
const FAILURE_SIGNATURE_KEYS = ["events", "action", "witness"] as const;
const SCOPE_KEYS = ["scenarioFamily", "phase", "modality"] as const;

/**
 * Build the frozen, normalized identity payload from a strict input. Any
 * field outside the declared shape -- including every name in
 * `PLAYTESTS_FINDING_IDENTITY_EXCLUDED_FIELDS` -- throws rather than being
 * silently dropped, so excluded provenance cannot enter the contract even
 * when a caller mixes it into the same object by mistake.
 */
export function buildPlaytestFindingIdentity(
  input: PlaytestFindingIdentityInput
): PlaytestFindingIdentity {
  if (!isRecord(input)) {
    throw new TypeError("Finding identity input must be an object.");
  }
  assertOnlyKeys(input, TOP_LEVEL_KEYS, "Finding identity");
  if (!isRecord(input.failureSignature)) {
    throw new TypeError("Finding identity failureSignature must be an object.");
  }
  assertOnlyKeys(
    input.failureSignature,
    FAILURE_SIGNATURE_KEYS,
    "Finding identity failureSignature"
  );
  if (!isRecord(input.scope)) {
    throw new TypeError("Finding identity scope must be an object.");
  }
  assertOnlyKeys(input.scope, SCOPE_KEYS, "Finding identity scope");

  const workspaceId = normalizeIdentifier(
    input.workspaceId,
    "Finding identity workspaceId"
  );
  const mechanicKey = normalizeIdentifier(
    input.mechanicKey,
    "Finding identity mechanicKey"
  );
  const events = normalizeEvents(
    input.failureSignature.events,
    "Finding identity failureSignature.events"
  );
  const action = normalizeOptionalIdentifier(
    input.failureSignature.action,
    "Finding identity failureSignature.action"
  );
  const witness = normalizeIdentifier(
    input.failureSignature.witness,
    "Finding identity failureSignature.witness"
  );
  const scenarioFamily = normalizeIdentifier(
    input.scope.scenarioFamily,
    "Finding identity scope.scenarioFamily"
  );
  const phase = normalizeOptionalIdentifier(
    input.scope.phase,
    "Finding identity scope.phase"
  );
  const modality = normalizeModality(
    input.scope.modality,
    "Finding identity scope.modality"
  );

  return {
    identitySchema: PLAYTESTS_FINDING_IDENTITY_SCHEMA,
    workspaceId,
    mechanicKey,
    failureSignature: { events, action, witness },
    scope: { scenarioFamily, phase, modality }
  };
}

/**
 * Canonical, key-order-independent JSON for an already-built identity.
 * Runtime hashes this string with SHA-256 to produce the actual finding
 * fingerprint; Core never computes the digest itself (same division of
 * responsibility as `playtestBenchmarkHashInput` in `benchmark.ts`).
 */
export function playtestFindingIdentityHashInput(
  identity: PlaytestFindingIdentity
): string {
  return canonicalPlaytestJson(identity);
}
