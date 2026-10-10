/** Workspaces-owned local approval boundary for running a target game. */
export const WORKSPACE_PLAYTEST_APPROVAL_SCHEMA =
  "autodev-workspace-playtest-approval-v1" as const;

export interface WorkspacePlaytestLimits {
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly processCount: number;
  readonly wallTimeMs: number;
  readonly artifactBytes: number;
  readonly workerCount: number;
  readonly episodeCount: number;
  readonly maxStepsPerEpisode: number;
  readonly critiqueCount: number;
}

/**
 * Operator-authored approval stored by Workspaces, not by a game adapter.
 * Model-controlled requests may select only a scenario/seed/policy within this
 * record; they cannot change the checkout, command, image, budgets or grants.
 */
export interface WorkspacePlaytestApproval {
  readonly schema: typeof WORKSPACE_PLAYTEST_APPROVAL_SCHEMA;
  readonly workspaceId: string;
  readonly revision: number;
  readonly approvalId: string;
  /** Canonical local real path, resolved when the operator approves it. */
  readonly checkoutRoot: string;
  readonly buildSha: string;
  readonly gameBuild: string;
  readonly playtestConfigHash: string;
  readonly adapterImageDigest: string;
  readonly workingDirectory: string;
  readonly adapterCommand: readonly string[];
  readonly allowedScenarios: readonly string[];
  readonly allowedPolicies: readonly string[];
  readonly limits: WorkspacePlaytestLimits;
  readonly retentionDays: number;
  readonly issueReporting: "disabled" | "review";
  readonly humanStudyAllowed: boolean;
  readonly approvedAt: string;
  readonly approvedBy: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revocationReason: string | null;
}

const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const GIT_REVISION_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const IMAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9._/:+-]{0,254}$/u;
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const IMAGE_DIGEST_MARKER = "@sha256:";
const WORKSPACE_PATH_SEPARATOR_PATTERN = /[\\/]/u;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u;
const DRIVE_PATH_PREFIX_PATTERN = /^[A-Za-z]:/u;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

function assertWorkingDirectory(dir: unknown): void {
  if (
    typeof dir !== "string" ||
    dir.trim().length === 0 ||
    ABSOLUTE_PATH_PATTERN.test(dir) ||
    DRIVE_PATH_PREFIX_PATTERN.test(dir) ||
    dir.split(WORKSPACE_PATH_SEPARATOR_PATTERN).includes("..")
  ) {
    throw new TypeError(
      "Workspace approval workingDirectory must remain inside checkout."
    );
  }
}

function assertAdapterCommand(command: unknown): void {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 128 ||
    command.some(
      (arg) =>
        typeof arg !== "string" ||
        arg.length === 0 ||
        arg.length > 4096 ||
        arg.includes("\0")
    )
  ) {
    throw new TypeError(
      "Workspace approval adapterCommand is invalid or too large."
    );
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[]
): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertRevocationMetadata(
  revokedAt: unknown,
  revokedBy: unknown,
  revocationReason: unknown
): void {
  if (
    revokedAt !== null &&
    (!nonEmpty(revokedAt) || !Number.isFinite(Date.parse(revokedAt)))
  ) {
    throw new TypeError(
      "Workspace approval revokedAt must be a timestamp or null."
    );
  }
  if (revokedAt === null) {
    if (revokedBy !== null || revocationReason !== null) {
      throw new TypeError(
        "Active workspace approvals cannot carry revocation metadata."
      );
    }
    return;
  }
  if (
    !nonEmpty(revokedBy) ||
    revokedBy.length > 128 ||
    hasControlCharacters(revokedBy) ||
    !nonEmpty(revocationReason) ||
    revocationReason.length > 1024 ||
    hasControlCharacters(revocationReason)
  ) {
    throw new TypeError(
      "Revoked workspace approvals require a bounded actor and reason."
    );
  }
}

function uniqueStrings(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every(nonEmpty) &&
    new Set(value).size === value.length
  );
}

export function isWorkspacePlaytestImageDigest(
  value: unknown
): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  if (value.startsWith("sha256:")) return SHA256_PATTERN.test(value.slice(7));
  const marker = value.lastIndexOf(IMAGE_DIGEST_MARKER);
  if (marker <= 0) return false;
  return (
    IMAGE_NAME_PATTERN.test(value.slice(0, marker)) &&
    SHA256_PATTERN.test(value.slice(marker + IMAGE_DIGEST_MARKER.length))
  );
}

function assertLimits(
  value: unknown
): asserts value is WorkspacePlaytestLimits {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "cpuCores",
      "memoryBytes",
      "processCount",
      "wallTimeMs",
      "artifactBytes",
      "workerCount",
      "episodeCount",
      "maxStepsPerEpisode",
      "critiqueCount"
    ])
  ) {
    throw new TypeError(
      "Playtest resource limits must match the workspace schema."
    );
  }
  const bounds = [
    ["memoryBytes", 64 * 1024 * 1024, MAX_MEMORY_BYTES],
    ["processCount", 1, 1024],
    ["wallTimeMs", 1000, 3_600_000],
    ["artifactBytes", 1024, MAX_ARTIFACT_BYTES],
    ["workerCount", 1, 32],
    ["episodeCount", 1, 1_000_000],
    ["maxStepsPerEpisode", 1, 100_000],
    ["critiqueCount", 0, 1000]
  ] as const;
  for (const [field, minimum, maximum] of bounds) {
    const count = value[field];
    if (
      !Number.isSafeInteger(count) ||
      (count as number) < minimum ||
      (count as number) > maximum
    ) {
      throw new TypeError(
        "Playtest resource limit " + field + " is out of range."
      );
    }
  }
  if (
    typeof value.cpuCores !== "number" ||
    !Number.isFinite(value.cpuCores) ||
    value.cpuCores <= 0 ||
    value.cpuCores > 16
  ) {
    throw new TypeError("Playtest resource limit cpuCores is out of range.");
  }
}

/** Validate a Workspaces approval before any Runtime process can start. */
export function assertWorkspacePlaytestApproval(
  value: unknown
): asserts value is WorkspacePlaytestApproval {
  if (!isRecord(value))
    throw new TypeError("Workspace playtest approval must be an object.");
  const fields = [
    "schema",
    "workspaceId",
    "revision",
    "approvalId",
    "checkoutRoot",
    "buildSha",
    "gameBuild",
    "playtestConfigHash",
    "adapterImageDigest",
    "workingDirectory",
    "adapterCommand",
    "allowedScenarios",
    "allowedPolicies",
    "limits",
    "retentionDays",
    "issueReporting",
    "humanStudyAllowed",
    "approvedAt",
    "approvedBy",
    "revokedAt",
    "revokedBy",
    "revocationReason"
  ];
  if (!onlyKeys(value, fields))
    throw new TypeError("Workspace playtest approval has an unknown field.");
  if (value.schema !== WORKSPACE_PLAYTEST_APPROVAL_SCHEMA) {
    throw new TypeError("Workspace playtest approval schema is unsupported.");
  }
  if (
    !nonEmpty(value.workspaceId) ||
    !WORKSPACE_ID_PATTERN.test(value.workspaceId)
  ) {
    throw new TypeError(
      "Workspace approval id must be a canonical owner/repository."
    );
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw new TypeError("Workspace approval revision must be positive.");
  }
  for (const field of ["approvalId", "gameBuild", "approvedBy"] as const) {
    if (!nonEmpty(value[field]))
      throw new TypeError(
        "Workspace approval " + field + " must be non-empty."
      );
  }
  if (
    typeof value.checkoutRoot !== "string" ||
    !ABSOLUTE_PATH_PATTERN.test(value.checkoutRoot)
  ) {
    throw new TypeError(
      "Workspace approval checkoutRoot must be an absolute local path."
    );
  }
  if (!GIT_REVISION_PATTERN.test(String(value.buildSha))) {
    throw new TypeError("Workspace approval buildSha must be a Git SHA.");
  }
  if (!SHA256_PATTERN.test(String(value.playtestConfigHash))) {
    throw new TypeError("Workspace approval config hash must be SHA-256.");
  }
  if (!isWorkspacePlaytestImageDigest(value.adapterImageDigest)) {
    throw new TypeError(
      "Workspace approval image must be pinned by SHA-256 digest."
    );
  }
  assertWorkingDirectory(value.workingDirectory);
  assertAdapterCommand(value.adapterCommand);
  if (
    !uniqueStrings(value.allowedScenarios) ||
    !uniqueStrings(value.allowedPolicies)
  ) {
    throw new TypeError(
      "Workspace approval scenarios and policies must be unique names."
    );
  }
  assertLimits(value.limits);
  if (
    !Number.isSafeInteger(value.retentionDays) ||
    (value.retentionDays as number) < 1 ||
    (value.retentionDays as number) > 3650
  ) {
    throw new TypeError("Workspace approval retentionDays is out of range.");
  }
  if (
    value.issueReporting !== "disabled" &&
    value.issueReporting !== "review"
  ) {
    throw new TypeError("Workspace approval issueReporting is invalid.");
  }
  if (typeof value.humanStudyAllowed !== "boolean") {
    throw new TypeError(
      "Workspace approval humanStudyAllowed must be a boolean."
    );
  }
  if (
    !nonEmpty(value.approvedAt) ||
    !Number.isFinite(Date.parse(value.approvedAt))
  ) {
    throw new TypeError("Workspace approval approvedAt must be a timestamp.");
  }
  assertRevocationMetadata(
    value.revokedAt,
    value.revokedBy,
    value.revocationReason
  );
}
