/** Workspaces-owned approval for one rendered game target. */
export const WORKSPACE_VISUAL_PLAYTEST_TARGET_SCHEMA =
  "autodev-workspace-visual-playtest-target-v1" as const;

export const WORKSPACE_VISUAL_PLAYTEST_INPUTS = [
  "keyboard",
  "pointer",
  "gamepad"
] as const;

export type WorkspaceVisualPlaytestInput =
  (typeof WORKSPACE_VISUAL_PLAYTEST_INPUTS)[number];

export const WORKSPACE_VISUAL_PLAYTEST_TIMING_CLASSES = [
  "turn-based",
  "pausable",
  "continuous"
] as const;

export type WorkspaceVisualPlaytestTimingClass =
  (typeof WORKSPACE_VISUAL_PLAYTEST_TIMING_CLASSES)[number];

export const WORKSPACE_VISUAL_PLAYTEST_ENTRY_REQUIREMENTS = [
  "none",
  "consent-or-age-screen",
  "local-account",
  "credentialed"
] as const;

export type WorkspaceVisualPlaytestEntryRequirement =
  (typeof WORKSPACE_VISUAL_PLAYTEST_ENTRY_REQUIREMENTS)[number];

export interface WorkspaceVisualPlaytestLimits {
  readonly episodeCount: number;
  readonly maxStepsPerEpisode: number;
  readonly wallTimeMs: number;
  readonly smartRequestsPerEpisode: number;
  readonly smartTokensPerEpisode: number;
  readonly screenshotCountPerEpisode: number;
  readonly artifactBytesPerEpisode: number;
}

/**
 * Operator-authored authorization for a single browser game entry point.
 * This is deliberately separate from the adapter/checkout approval: it grants
 * bounded browser input and capture, never repository or shell access.
 */
export interface WorkspaceVisualPlaytestTargetApproval {
  readonly schema: typeof WORKSPACE_VISUAL_PLAYTEST_TARGET_SCHEMA;
  readonly workspaceId: string;
  readonly targetId: string;
  readonly revision: number;
  readonly approvalId: string;
  readonly name: string;
  /** Canonical HTTP(S) entry URL without credentials, query, or fragment. */
  readonly entryUrl: string;
  /** Exact origins only; wildcards, paths, and implicit redirects are forbidden. */
  readonly allowedOrigins: readonly string[];
  readonly inputCapabilities: readonly WorkspaceVisualPlaytestInput[];
  readonly controlTimingClass: WorkspaceVisualPlaytestTimingClass;
  readonly entryRequirements: WorkspaceVisualPlaytestEntryRequirement;
  readonly sandboxProfile: "transient-browser-profile";
  readonly capturePolicy: "screenshots-only-redact-or-refuse";
  readonly limits: WorkspaceVisualPlaytestLimits;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revocationReason: string | null;
}

const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACTOR_PATTERN = /^[A-Za-z0-9@._:+-]{1,128}$/u;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[]
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyBounded(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "[::1]") return true;
  const segments = host.split(".");
  return (
    segments.length === 4 &&
    segments[0] === "127" &&
    segments.every(
      (segment) =>
        segment.length > 0 &&
        segment.length <= 3 &&
        [...segment].every((digit) => digit >= "0" && digit <= "9") &&
        Number(segment) <= 255
    )
  );
}

function parseApprovedOrigin(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.origin !== value
  ) {
    return null;
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return null;
  return url;
}

function isCanonicalEntryUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    (url.protocol !== "http:" || isLoopbackHost(url.hostname)) &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.href === value
  );
}

function isUniqueEnumList<T extends string>(
  value: unknown,
  choices: readonly T[],
  minimum: number
): value is readonly T[] {
  return (
    Array.isArray(value) &&
    value.length >= minimum &&
    value.length <= choices.length &&
    value.every((item) => choices.includes(item as T)) &&
    new Set(value).size === value.length
  );
}

export function assertWorkspaceVisualPlaytestLimits(
  value: unknown
): asserts value is WorkspaceVisualPlaytestLimits {
  const keys = [
    "episodeCount",
    "maxStepsPerEpisode",
    "wallTimeMs",
    "smartRequestsPerEpisode",
    "smartTokensPerEpisode",
    "screenshotCountPerEpisode",
    "artifactBytesPerEpisode"
  ] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) {
    throw new TypeError("Visual playtest limits have an unsupported shape.");
  }
  const bounds = [
    ["episodeCount", 1, 1000],
    ["maxStepsPerEpisode", 1, 10_000],
    ["wallTimeMs", 1000, 3_600_000],
    ["smartRequestsPerEpisode", 0, 1000],
    ["smartTokensPerEpisode", 0, 1_000_000],
    ["screenshotCountPerEpisode", 1, 2000],
    ["artifactBytesPerEpisode", 1024, MAX_ARTIFACT_BYTES]
  ] as const;
  for (const [field, minimum, maximum] of bounds) {
    const amount = value[field];
    if (
      !Number.isSafeInteger(amount) ||
      (amount as number) < minimum ||
      (amount as number) > maximum
    ) {
      throw new TypeError(`Visual playtest limit ${field} is out of range.`);
    }
  }
}

function assertRevocation(
  revokedAt: unknown,
  revokedBy: unknown,
  reason: unknown
): void {
  if (revokedAt === null) {
    if (revokedBy !== null || reason !== null) {
      throw new TypeError(
        "Active visual target approvals cannot carry revocation metadata."
      );
    }
    return;
  }
  if (
    typeof revokedAt !== "string" ||
    !Number.isFinite(Date.parse(revokedAt)) ||
    !nonEmptyBounded(revokedBy, 128) ||
    !ACTOR_PATTERN.test(revokedBy) ||
    !nonEmptyBounded(reason, 1024)
  ) {
    throw new TypeError(
      "Revoked visual target approvals require bounded actor, time, and reason."
    );
  }
}

/** Validate a visual target grant before Runtime may open a browser session. */
export function assertWorkspaceVisualPlaytestTargetApproval(
  value: unknown
): asserts value is WorkspaceVisualPlaytestTargetApproval {
  const fields = [
    "schema",
    "workspaceId",
    "targetId",
    "revision",
    "approvalId",
    "name",
    "entryUrl",
    "allowedOrigins",
    "inputCapabilities",
    "controlTimingClass",
    "entryRequirements",
    "sandboxProfile",
    "capturePolicy",
    "limits",
    "approvedAt",
    "approvedBy",
    "revokedAt",
    "revokedBy",
    "revocationReason"
  ] as const;
  if (!isRecord(value) || !hasOnlyKeys(value, fields)) {
    throw new TypeError("Visual target approval has an unsupported shape.");
  }
  if (value.schema !== WORKSPACE_VISUAL_PLAYTEST_TARGET_SCHEMA) {
    throw new TypeError("Visual target approval schema is unsupported.");
  }
  if (
    typeof value.workspaceId !== "string" ||
    !WORKSPACE_ID_PATTERN.test(value.workspaceId)
  ) {
    throw new TypeError("Visual target workspace identity is invalid.");
  }
  if (
    typeof value.targetId !== "string" ||
    !TARGET_ID_PATTERN.test(value.targetId)
  ) {
    throw new TypeError("Visual target id is invalid.");
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new TypeError("Visual target revision must be positive.");
  }
  if (!nonEmptyBounded(value.approvalId, 128)) {
    throw new TypeError("Visual target approval id is invalid.");
  }
  if (!nonEmptyBounded(value.name, 160)) {
    throw new TypeError("Visual target name is invalid.");
  }
  if (!isCanonicalEntryUrl(value.entryUrl)) {
    throw new TypeError(
      "Visual target URL must be canonical HTTP(S), loopback-only over HTTP, and contain no credentials, query, or fragment."
    );
  }
  if (
    !Array.isArray(value.allowedOrigins) ||
    value.allowedOrigins.length === 0 ||
    value.allowedOrigins.length > 16 ||
    new Set(value.allowedOrigins).size !== value.allowedOrigins.length ||
    !value.allowedOrigins.every((origin) => parseApprovedOrigin(origin)) ||
    !value.allowedOrigins.includes(new URL(value.entryUrl).origin)
  ) {
    throw new TypeError(
      "Visual target origins must be unique exact origins including the entry origin."
    );
  }
  if (
    !isUniqueEnumList(
      value.inputCapabilities,
      WORKSPACE_VISUAL_PLAYTEST_INPUTS,
      1
    )
  ) {
    throw new TypeError("Visual target input capabilities are invalid.");
  }
  if (
    !WORKSPACE_VISUAL_PLAYTEST_TIMING_CLASSES.includes(
      value.controlTimingClass as WorkspaceVisualPlaytestTimingClass
    )
  ) {
    throw new TypeError("Visual target control timing class is invalid.");
  }
  if (
    !WORKSPACE_VISUAL_PLAYTEST_ENTRY_REQUIREMENTS.includes(
      value.entryRequirements as WorkspaceVisualPlaytestEntryRequirement
    )
  ) {
    throw new TypeError("Visual target entry requirements are invalid.");
  }
  if (value.sandboxProfile !== "transient-browser-profile") {
    throw new TypeError("Visual target sandbox profile is unsupported.");
  }
  if (value.capturePolicy !== "screenshots-only-redact-or-refuse") {
    throw new TypeError("Visual target capture policy is unsupported.");
  }
  assertWorkspaceVisualPlaytestLimits(value.limits);
  if (
    typeof value.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(value.approvedAt)) ||
    typeof value.approvedBy !== "string" ||
    !ACTOR_PATTERN.test(value.approvedBy)
  ) {
    throw new TypeError("Visual target approval author or time is invalid.");
  }
  assertRevocation(value.revokedAt, value.revokedBy, value.revocationReason);
}
