/**
 * Runtime-owned bounded, content-addressed Playtesting artifact store.
 *
 * Implements the storage primitive described in
 * `docs/playtesting-target-state.md` sections 3-4 and 9, and
 * `docs/playtesting-measurement-contract.md` sections 3, 6 and 10. The
 * store keeps large trace bytes and bounded indexed step/event JSONL
 * windows out of ClickHouse and OTLP, and never produces a second
 * evaluation/feed backend or a duplicate whole-trace cache.
 *
 * Boundaries enforced at this layer:
 *
 * - Local-only storage under a configured rootDirectory
 *   ($CODEX_HOME/playtesting/artifacts by default; tests inject a tmp root).
 * - Content-addressed by SHA-256; writes are atomic, idempotent and verify
 *   the hash on read. The returned PlaytestArtifactReference never carries
 *   a filesystem path: only an opaque artifact id, the verified SHA-256, the
 *   byte length, the media type and (for windows) the bounded line count.
 * - Owner-only permissions on every directory (0o700) and file (0o600). New
 *   files default to that mode regardless of the host umask.
 * - Strict root / realpath / symlink / path-traversal enforcement: the root
 *   must canonicalize without symlinks, the workspace is bound from
 *   trusted server-side context, and every internal path is verified to stay
 *   inside the canonical root.
 * - Bounded payload size, bounded JSONL line size (1 MiB) and bounded window
 *   total bytes / step count.
 * - Retention / expiry cleanup with explicit present, expired, missing and
 *   not-authorized states.
 * - Partial evidence preservation: failed window writes keep their .tmp
 *   scratch file so the operator can recover what was streamed before the
 *   failure.
 *
 * This module does not trust a caller-supplied URI/path: the workspace is
 * bound at construction time and a reference is only authorized when its
 * metadata file resolves under that workspace. Human survey responses and
 * withdrawal flows are explicitly out of scope for this generic LLM
 * artifact store; they are routed through a separate, consent-owned path
 * per the measurement contract.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { PlaytestArtifactReference } from "@simulatorlife/autodev-core";

function encodeWindowEntries(
  entries: readonly unknown[],
  maxLineBytes: number,
  maxWindowBytes: number,
  preservePartial: (bytes: Uint8Array) => void
): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (const [index, entry] of entries.entries()) {
      assertNotHumanEntry(entry);
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(entry);
      } catch (error) {
        throw new PlaytestArtifactFormatError(
          `Window entry at index ${index} is not JSON-serializable: ${(error as Error).message}`
        );
      }
      if (serialized === undefined) {
        throw new PlaytestArtifactFormatError(
          `Window entry at index ${index} serialized to undefined.`
        );
      }
      const line = encoder.encode(serialized + "\n");
      if (line.byteLength > maxLineBytes) {
        throw new PlaytestArtifactOversizedError("line", line.byteLength);
      }
      totalBytes += line.byteLength;
      if (totalBytes > maxWindowBytes) {
        throw new PlaytestArtifactOversizedError("window", totalBytes);
      }
      chunks.push(line);
    }
  } catch (error) {
    if (chunks.length > 0) {
      try {
        preservePartial(concatBytes(chunks));
      } catch {
        // Keep the original validation/size error authoritative.
      }
    }
    throw error;
  }
  return concatBytes(chunks);
}

function writeAtomicWindow(
  file: string,
  bytes: Uint8Array,
  fileSystem: PlaytestArtifactFileSystem,
  randomToken: () => string
): void {
  const pending = `${file}${TMP_SUFFIX}.${mintToken(randomToken)}`;
  try {
    fileSystem.writeFileSync(pending, bytes, FILE_MODE);
    fileSystem.chmodSync(pending, FILE_MODE);
    fileSystem.renameSync(pending, file);
  } catch (error) {
    if (fileSystem.existsSync(pending)) {
      try {
        fileSystem.chmodSync(pending, FILE_MODE);
      } catch {
        // The partial file remains recoverable even if chmod also fails.
      }
    }
    throw error;
  }
}

function existingWindowResult(input: {
  readonly artifactId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly lineCount: number;
  readonly workspaceId: string;
  readonly windowFile: string;
  readonly metadataFile: string;
  readonly fileSystem: PlaytestArtifactFileSystem;
}): PlaytestArtifactWriteResult | null {
  if (
    !input.fileSystem.existsSync(input.windowFile) ||
    !input.fileSystem.existsSync(input.metadataFile)
  ) {
    return null;
  }
  const existing = readMetadata(input.metadataFile, input.fileSystem);
  if (
    existing.workspaceId !== input.workspaceId ||
    existing.kind !== "window" ||
    existing.sha256 !== input.sha256 ||
    existing.bytes !== input.bytes ||
    existing.mediaType !== input.mediaType ||
    existing.lineCount !== input.lineCount
  ) {
    throw new PlaytestArtifactIntegrityError(
      input.artifactId,
      input.sha256,
      existing.sha256
    );
  }
  return {
    reference: {
      artifactId: input.artifactId,
      sha256: input.sha256,
      bytes: input.bytes,
      mediaType: input.mediaType
    },
    lineCount: input.lineCount,
    createdAt: existing.createdAt,
    expiresAt: existing.expiresAt
  };
}

/** Upper bound on a single artifact payload. Anything larger is rejected. */
export const PLAYTESTS_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;

/** Hard v1 JSONL line ceiling, matching the v1 adapter transport cap. */
export const PLAYTESTS_ARTIFACT_MAX_LINE_BYTES = 1_048_576;

/** Default upper bound on a single indexed JSONL window payload. */
export const PLAYTESTS_ARTIFACT_MAX_WINDOW_BYTES = 8 * 1024 * 1024;

/** Default upper bound on the number of step/event entries in one window. */
export const PLAYESTS_ARTIFACT_MAX_WINDOW_STEPS = 4096;

/** Default retention duration when none is supplied. */
export const PLAYTESTS_ARTIFACT_DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Default media type for indexed step/event windows. */
export const PLAYTESTS_ARTIFACT_WINDOW_MEDIA_TYPE =
  "application/x-ndjson" as const;

/** Canonical owner-only permission bits. */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

/** Atomic-write scratch suffix. */
const TMP_SUFFIX = ".tmp";

/** Canonical workspace identity pattern (matches the Core validator). */
const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;

const SHA256_HEX_PATTERN = /^[a-f\d]{64}$/iu;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/u;
const NON_ALPHANUMERIC_PATTERN = /[^A-Za-z0-9]/gu;
const MEDIA_TYPE_TOKEN_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+$/u;

/** Pure helper: bounded SHA-256 over a byte buffer. */
function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Returns the default root directory for playtesting artifacts under CODEX_HOME.
 */
export function defaultPlaytestArtifactsRoot(): string {
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(codexHome, "playtesting", "artifacts");
}

/**
 * Minimal filesystem surface the store depends on. Defaults to the real
 * node:fs module; tests inject a custom surface to exercise permission
 * failures or alternate storage without subclassing.
 */
export interface PlaytestArtifactFileSystem {
  readonly existsSync: (path: string) => boolean;
  readonly realpathSync?: (path: string) => string;
  readonly lstatSync: (path: string) => {
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
    mode: number;
  };
  readonly statSync: (path: string) => {
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    isFile(): boolean;
    size: number;
    mode: number;
  };
  readonly mkdirSync: (
    path: string,
    options: { readonly recursive: boolean; readonly mode?: number }
  ) => void;
  readonly chmodSync: (path: string, mode: number) => void;
  readonly writeFileSync: (
    path: string,
    data: Uint8Array,
    mode: number
  ) => void;
  readonly readFileSync: (path: string) => Uint8Array;
  readonly renameSync: (from: string, to: string) => void;
  readonly unlinkSync: (path: string) => void;
  readonly rmSync: (path: string, options: { readonly force: boolean }) => void;
  readonly readdirSync: (
    path: string,
    options: { readonly withFileTypes: true }
  ) => ReadonlyArray<{
    readonly name: string;
    isFile(): boolean;
    isDirectory?(): boolean;
  }>;
}

const defaultFileSystem: PlaytestArtifactFileSystem = {
  existsSync: (filePath: string) => existsSync(filePath),
  realpathSync: (filePath: string) => realpathSync(filePath),
  lstatSync: (filePath: string) => {
    const result = lstatSync(filePath);
    return {
      isSymbolicLink: () => result.isSymbolicLink(),
      isDirectory: () => result.isDirectory(),
      isFile: () => result.isFile(),
      mode: result.mode
    };
  },
  statSync: (filePath: string) => {
    const result = statSync(filePath);
    return {
      isSymbolicLink: () => result.isSymbolicLink(),
      isDirectory: () => result.isDirectory(),
      isFile: () => result.isFile(),
      size: result.size,
      mode: result.mode
    };
  },
  mkdirSync: (filePath: string, options) => mkdirSync(filePath, options),
  chmodSync: (filePath: string, mode: number) => chmodSync(filePath, mode),
  writeFileSync: (filePath: string, data: Uint8Array, mode: number) =>
    writeFileSync(filePath, data, { mode, flag: "wx" }),
  readFileSync: (filePath: string) => readFileSync(filePath),
  renameSync: (from: string, to: string) => renameSync(from, to),
  unlinkSync: (filePath: string) => unlinkSync(filePath),
  rmSync: (filePath: string, options) => rmSync(filePath, options),
  readdirSync: (filePath: string, options) => {
    const entries = readdirSync(filePath, options);
    return entries.map((entry) => ({
      name: entry.name,
      isFile: () => entry.isFile(),
      isDirectory: () => entry.isDirectory()
    }));
  }
};

/** Bounded construction options for the store. */
export interface PlaytestArtifactStoreOptions {
  /**
   * Filesystem root for the artifact store. Resolved to its canonical real
   * path on construction; symbolic links in the root are rejected.
   * Defaults to $CODEX_HOME/playtesting/artifacts.
   */
  readonly rootDirectory?: string;
  /**
   * Canonical workspace id (owner/repository) bound from trusted
   * server-side context. The store never reads a workspace id off a
   * caller-supplied URI or path.
   */
  readonly workspaceId: string;
  /** Upper bound on a single artifact payload. Defaults to the v1 cap. */
  readonly maxBytes?: number;
  /** Hard ceiling on one JSONL line. Defaults to the v1 transport cap. */
  readonly maxWindowLineBytes?: number;
  /** Upper bound on a single window payload. Defaults to the v1 cap. */
  readonly maxWindowBytes?: number;
  /** Upper bound on the number of entries in one window. */
  readonly maxWindowSteps?: number;
  /** Retention window applied to every artifact. */
  readonly retentionMs?: number;
  /** Deterministic clock override (tests). */
  readonly now?: () => number;
  /** Override the random token mint (tests / forced collisions). */
  readonly randomToken?: () => string;
  /** Override the file system surface (tests). */
  readonly fileSystem?: PlaytestArtifactFileSystem;
  /** Override the SHA-256 helper (tests / pinning). */
  readonly hash?: (bytes: Uint8Array) => string;
}

/** Canonical lifecycle state of an artifact reference. */
export type PlaytestArtifactState =
  "present" | "expired" | "missing" | "not-authorized" | "corrupted";

/** Opaque on-disk metadata for one artifact (blob or window). */
interface PlaytestArtifactMetadata {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly kind: "blob" | "window";
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly lineCount: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Request payload for writeArtifact. */
export interface PlaytestArtifactWriteRequest {
  readonly artifactId?: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** Request payload for writeWindow. */
export interface PlaytestArtifactWindowWriteRequest {
  readonly artifactId?: string;
  readonly mediaType?: string;
  readonly entries: readonly unknown[];
}

/** Result returned by every write call. */
export interface PlaytestArtifactWriteResult {
  readonly reference: PlaytestArtifactReference;
  readonly lineCount: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** Window read result with the raw bounded JSONL bytes. */
export interface PlaytestArtifactWindowReadResult {
  readonly reference: PlaytestArtifactReference;
  readonly bytes: Uint8Array;
  readonly lineCount: number;
}

/** Cleanup summary returned by cleanup. */
export interface PlaytestArtifactCleanupResult {
  readonly removedRefs: number;
  readonly removedBlobs: number;
  readonly removedWindows: number;
  readonly expiredRefs: readonly string[];
}

/** Configuration errors surface as a distinct error type. */
export class PlaytestArtifactConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestArtifactConfigurationError";
  }
}

/** Payload or window exceeds the configured bounds. */
export class PlaytestArtifactOversizedError extends Error {
  readonly limit: number;
  readonly actual: number;
  constructor(kind: "blob" | "line" | "window" | "steps", actual: number) {
    super(
      kind === "blob"
        ? `Artifact payload of ${actual} bytes exceeds the bound.`
        : kind === "line"
          ? `Window line of ${actual} bytes exceeds the 1 MiB cap.`
          : kind === "window"
            ? `Window payload of ${actual} bytes exceeds the bound.`
            : `Window of ${actual} entries exceeds the step bound.`
    );
    this.name = "PlaytestArtifactOversizedError";
    this.limit =
      kind === "blob"
        ? PLAYTESTS_ARTIFACT_MAX_BYTES
        : kind === "line"
          ? PLAYTESTS_ARTIFACT_MAX_LINE_BYTES
          : kind === "window"
            ? PLAYTESTS_ARTIFACT_MAX_WINDOW_BYTES
            : PLAYESTS_ARTIFACT_MAX_WINDOW_STEPS;
    this.actual = actual;
  }
}

/** Stored bytes do not match their declared SHA-256 (tamper / corruption). */
export class PlaytestArtifactIntegrityError extends Error {
  readonly artifactId: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  constructor(
    artifactId: string,
    expectedSha256: string,
    actualSha256: string
  ) {
    super(
      `Artifact ${artifactId} failed integrity verification (expected ${expectedSha256}, got ${actualSha256}).`
    );
    this.name = "PlaytestArtifactIntegrityError";
    this.artifactId = artifactId;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

/** Reference is not registered for this workspace (cross-workspace leakage). */
export class PlaytestArtifactNotAuthorizedError extends Error {
  readonly artifactId: string;
  constructor(artifactId: string, workspaceId: string) {
    super(
      `Artifact ${artifactId} is not authorized for workspace ${workspaceId}.`
    );
    this.name = "PlaytestArtifactNotAuthorizedError";
    this.artifactId = artifactId;
  }
}

/** Reference exists but has passed its configured retention window. */
export class PlaytestArtifactExpiredError extends Error {
  readonly artifactId: string;
  readonly expiresAt: number;
  constructor(artifactId: string, expiresAt: number) {
    super(`Artifact ${artifactId} has expired.`);
    this.name = "PlaytestArtifactExpiredError";
    this.artifactId = artifactId;
    this.expiresAt = expiresAt;
  }
}

/** Backing file is missing from local storage. */
export class PlaytestArtifactMissingError extends Error {
  readonly artifactId: string;
  constructor(artifactId: string) {
    super(`Artifact ${artifactId} is missing from storage.`);
    this.name = "PlaytestArtifactMissingError";
    this.artifactId = artifactId;
  }
}

/** Reference metadata or payload is malformed. */
export class PlaytestArtifactFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestArtifactFormatError";
  }
}

function assertWorkspaceId(value: string): void {
  if (typeof value !== "string" || !WORKSPACE_ID_PATTERN.test(value)) {
    throw new PlaytestArtifactConfigurationError(
      `Workspace id must be a canonical owner/repository id; received ${JSON.stringify(value)}.`
    );
  }
  const [owner, repo] = value.split("/");
  if (owner === ".." || owner === "." || repo === ".." || repo === ".") {
    throw new PlaytestArtifactConfigurationError(
      `Workspace id must not contain traversal segments; received ${JSON.stringify(value)}.`
    );
  }
}

function assertMediaType(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new PlaytestArtifactFormatError(
      `Media type ${JSON.stringify(value)} is not a valid token.`
    );
  }
  const separator = value.indexOf("/");
  const parameterSeparator = value.indexOf(";");
  const essenceEnd =
    parameterSeparator === -1 ? value.length : parameterSeparator;
  const essence = value.slice(0, essenceEnd);
  const slash = essence.indexOf("/");
  const parameters =
    parameterSeparator === -1 ? "" : value.slice(parameterSeparator + 1);
  const validEssence =
    slash > 0 &&
    slash === essence.lastIndexOf("/") &&
    MEDIA_TYPE_TOKEN_PATTERN.test(essence.slice(0, slash)) &&
    MEDIA_TYPE_TOKEN_PATTERN.test(essence.slice(slash + 1));
  const validParameters = [...parameters].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code <= 126;
  });
  if (separator !== slash || !validEssence || !validParameters) {
    throw new PlaytestArtifactFormatError(
      `Media type ${JSON.stringify(value)} is not a valid token.`
    );
  }
}

function assertNotHumanResponse(mediaType: string): void {
  const lower = mediaType.toLowerCase();
  if (
    lower.includes("human-response") ||
    lower.includes("human-experience") ||
    lower.includes("human-study")
  ) {
    throw new PlaytestArtifactFormatError(
      "Human responses must not enter this generic LLM artifact store; participant data is governed by a separate consent-scoped store."
    );
  }
}

function assertNotHumanEntry(entry: unknown): void {
  if (
    isPlainObject(entry) &&
    ("pseudonymousParticipantId" in entry ||
      entry.schema === "autodev-human-experience-response-v1" ||
      entry.schema === "autodev-human-playtest-study-v1" ||
      "participantId" in entry ||
      "surveyResponses" in entry)
  ) {
    throw new PlaytestArtifactFormatError(
      "Human responses must not enter this generic LLM artifact store; participant data is governed by a separate consent-scoped store."
    );
  }
}

function isPlainObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedParent === resolvedChild) return true;
  const relative = path.relative(resolvedParent, resolvedChild);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".."
  );
}

function resolveCanonicalRoot(
  rootDirectory: string,
  fileSystem: PlaytestArtifactFileSystem
): string {
  if (typeof rootDirectory !== "string" || rootDirectory.trim().length === 0) {
    throw new PlaytestArtifactConfigurationError(
      "Root directory must be a non-empty string."
    );
  }
  if (!path.isAbsolute(rootDirectory)) {
    throw new PlaytestArtifactConfigurationError(
      "Root directory must be an absolute path."
    );
  }
  if (!fileSystem.existsSync(rootDirectory)) {
    throw new PlaytestArtifactConfigurationError(
      "Root directory does not exist."
    );
  }
  let lstat;
  try {
    lstat = fileSystem.lstatSync(rootDirectory);
  } catch (error) {
    throw new PlaytestArtifactConfigurationError(
      `Root directory is not readable: ${(error as Error).message}`
    );
  }
  if (lstat.isSymbolicLink()) {
    throw new PlaytestArtifactConfigurationError(
      "Root directory must not be a symbolic link."
    );
  }
  let stat;
  try {
    stat = fileSystem.statSync(rootDirectory);
  } catch (error) {
    throw new PlaytestArtifactConfigurationError(
      `Root directory is not readable: ${(error as Error).message}`
    );
  }
  if (!stat.isDirectory()) {
    throw new PlaytestArtifactConfigurationError(
      "Root directory must be a directory."
    );
  }
  let canonical: string;
  try {
    canonical = fileSystem.realpathSync
      ? fileSystem.realpathSync(rootDirectory)
      : realpathSync(rootDirectory);
  } catch (error) {
    throw new PlaytestArtifactConfigurationError(
      `Root directory failed to canonicalize: ${(error as Error).message}`
    );
  }
  return canonical;
}

function ensureOwnedDirectory(
  directory: string,
  root: string,
  fileSystem: PlaytestArtifactFileSystem
): void {
  if (!isWithin(root, directory)) {
    throw new PlaytestArtifactConfigurationError(
      `Path ${directory} escapes the canonical root.`
    );
  }
  if (fileSystem.existsSync(directory)) {
    const lstat = fileSystem.lstatSync(directory);
    if (lstat.isSymbolicLink()) {
      throw new PlaytestArtifactConfigurationError(
        `Directory ${directory} must not be a symbolic link.`
      );
    }
    if (!lstat.isDirectory()) {
      throw new PlaytestArtifactConfigurationError(
        `Path ${directory} is not a directory.`
      );
    }
    return;
  }
  fileSystem.mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  fileSystem.chmodSync(directory, DIRECTORY_MODE);
}

function appendSeparator(value: string): string {
  return value.endsWith(path.sep) ? value : value + path.sep;
}

function safeJoin(root: string, ...segments: readonly string[]): string {
  for (const segment of segments) {
    const parts = segment.split(path.sep);
    if (parts.includes("..") || parts.includes("")) {
      throw new PlaytestArtifactConfigurationError(
        `Path segment ${JSON.stringify(segment)} contains a traversal token.`
      );
    }
  }
  const joined = path.join(root, ...segments);
  if (!isWithin(root, joined)) {
    throw new PlaytestArtifactConfigurationError(
      `Path ${joined} escapes the canonical root.`
    );
  }
  return joined;
}

function mintToken(randomToken: () => string): string {
  // 96 bits of entropy encoded as hex; opaque to the caller.
  return randomToken().replaceAll(NON_ALPHANUMERIC_PATTERN, "");
}

function metadataPath(
  root: string,
  workspaceId: string,
  artifactId: string
): string {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new PlaytestArtifactFormatError(
      `Artifact id ${JSON.stringify(artifactId)} is not a valid opaque token.`
    );
  }
  return safeJoin(root, workspaceId, "refs", `${artifactId}.json`);
}

function blobPath(root: string, workspaceId: string, sha256: string): string {
  if (!SHA256_HEX_PATTERN.test(sha256)) {
    throw new PlaytestArtifactFormatError(
      `SHA-256 ${JSON.stringify(sha256)} is not a valid hex digest.`
    );
  }
  const prefix = sha256.slice(0, 2);
  return safeJoin(root, workspaceId, "blobs", prefix, sha256);
}

function windowPath(
  root: string,
  workspaceId: string,
  artifactId: string
): string {
  return safeJoin(root, workspaceId, "windows", `${artifactId}.jsonl`);
}

function readMetadata(
  metadataFile: string,
  fileSystem: PlaytestArtifactFileSystem
): PlaytestArtifactMetadata {
  const lstat = fileSystem.lstatSync(metadataFile);
  if (lstat.isSymbolicLink()) {
    throw new PlaytestArtifactConfigurationError(
      `Metadata file ${metadataFile} must not be a symbolic link.`
    );
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    fileSystem.readFileSync(metadataFile)
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PlaytestArtifactFormatError(
      `Artifact metadata at ${metadataFile} is not valid JSON: ${(error as Error).message}`
    );
  }
  if (!isPlainObject(parsed)) {
    throw new PlaytestArtifactFormatError(
      "Artifact metadata must be a JSON object."
    );
  }
  const requiredStrings = [
    "artifactId",
    "workspaceId",
    "kind",
    "sha256",
    "mediaType"
  ] as const;
  for (const field of requiredStrings) {
    if (typeof parsed[field] !== "string" || !parsed[field]) {
      throw new PlaytestArtifactFormatError(
        `Artifact metadata field ${field} must be a non-empty string.`
      );
    }
  }
  if (parsed.kind !== "blob" && parsed.kind !== "window") {
    throw new PlaytestArtifactFormatError(
      `Artifact metadata kind must be "blob" or "window".`
    );
  }
  if (!SHA256_HEX_PATTERN.test(parsed.sha256 as string)) {
    throw new PlaytestArtifactFormatError(
      "Artifact metadata sha256 must be a SHA-256 hex digest."
    );
  }
  if (!Number.isSafeInteger(parsed.bytes) || (parsed.bytes as number) < 0) {
    throw new PlaytestArtifactFormatError(
      "Artifact metadata bytes must be a non-negative integer."
    );
  }
  if (
    !Number.isSafeInteger(parsed.lineCount) ||
    (parsed.lineCount as number) < 0
  ) {
    throw new PlaytestArtifactFormatError(
      "Artifact metadata lineCount must be a non-negative integer."
    );
  }
  if (
    !Number.isFinite(parsed.createdAt) ||
    !Number.isFinite(parsed.expiresAt)
  ) {
    throw new PlaytestArtifactFormatError(
      "Artifact metadata timestamps must be finite numbers."
    );
  }
  return {
    artifactId: parsed.artifactId as string,
    workspaceId: parsed.workspaceId as string,
    kind: parsed.kind,
    sha256: parsed.sha256 as string,
    bytes: parsed.bytes as number,
    mediaType: parsed.mediaType as string,
    lineCount: parsed.lineCount as number,
    createdAt: parsed.createdAt as number,
    expiresAt: parsed.expiresAt as number
  };
}

function writeMetadata(
  metadataFile: string,
  metadata: PlaytestArtifactMetadata,
  fileSystem: PlaytestArtifactFileSystem
): void {
  const json = JSON.stringify(metadata);
  const tmp = `${metadataFile}${TMP_SUFFIX}.${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
  fileSystem.writeFileSync(tmp, new TextEncoder().encode(json), FILE_MODE);
  fileSystem.chmodSync(tmp, FILE_MODE);
  fileSystem.renameSync(tmp, metadataFile);
}

/**
 * Runtime-owned bounded, content-addressed Playtesting artifact store.
 *
 * A store is constructed once per workspace and bound to the workspace id
 * supplied by trusted server-side context. The workspace id never comes
 * from the caller; every read/write is authorized against that binding.
 */
export class PlaytestArtifactStore {
  private readonly root: string;
  private readonly workspaceId: string;
  private readonly maxBytes: number;
  private readonly maxWindowLineBytes: number;
  private readonly maxWindowBytes: number;
  private readonly maxWindowSteps: number;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly fileSystem: PlaytestArtifactFileSystem;
  private readonly hash: (bytes: Uint8Array) => string;

  constructor(options: PlaytestArtifactStoreOptions) {
    assertWorkspaceId(options.workspaceId);
    const fs = options.fileSystem ?? defaultFileSystem;
    const rawRoot = options.rootDirectory ?? defaultPlaytestArtifactsRoot();
    if (!options.rootDirectory && !fs.existsSync(rawRoot)) {
      fs.mkdirSync(rawRoot, { recursive: true, mode: DIRECTORY_MODE });
      fs.chmodSync(rawRoot, DIRECTORY_MODE);
    }
    this.root = resolveCanonicalRoot(rawRoot, fs);
    this.workspaceId = options.workspaceId;
    this.maxBytes = options.maxBytes ?? PLAYTESTS_ARTIFACT_MAX_BYTES;
    this.maxWindowLineBytes =
      options.maxWindowLineBytes ?? PLAYTESTS_ARTIFACT_MAX_LINE_BYTES;
    this.maxWindowBytes =
      options.maxWindowBytes ?? PLAYTESTS_ARTIFACT_MAX_WINDOW_BYTES;
    this.maxWindowSteps =
      options.maxWindowSteps ?? PLAYESTS_ARTIFACT_MAX_WINDOW_STEPS;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > Number.MAX_SAFE_INTEGER
    ) {
      throw new PlaytestArtifactConfigurationError(
        "maxBytes is outside the supported range."
      );
    }
    if (
      !Number.isSafeInteger(this.maxWindowLineBytes) ||
      this.maxWindowLineBytes < 1 ||
      this.maxWindowLineBytes > PLAYTESTS_ARTIFACT_MAX_LINE_BYTES
    ) {
      throw new PlaytestArtifactConfigurationError(
        "maxWindowLineBytes must be <= 1 MiB."
      );
    }
    if (!Number.isSafeInteger(this.maxWindowBytes) || this.maxWindowBytes < 1) {
      throw new PlaytestArtifactConfigurationError(
        "maxWindowBytes is outside the supported range."
      );
    }
    if (!Number.isSafeInteger(this.maxWindowSteps) || this.maxWindowSteps < 1) {
      throw new PlaytestArtifactConfigurationError(
        "maxWindowSteps is outside the supported range."
      );
    }
    this.retentionMs =
      options.retentionMs ?? PLAYTESTS_ARTIFACT_DEFAULT_RETENTION_MS;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 1) {
      throw new PlaytestArtifactConfigurationError(
        "retentionMs is outside the supported range."
      );
    }
    this.now = options.now ?? Date.now;
    this.randomToken =
      options.randomToken ?? (() => randomBytes(12).toString("hex"));
    this.fileSystem = fs;
    this.hash = options.hash ?? sha256Hex;
    ensureOwnedDirectory(
      safeJoin(this.root, this.workspaceId),
      this.root,
      this.fileSystem
    );
  }

  /** Returns the canonical, real-path root the store was bound to. */
  rootDirectory(): string {
    return this.root;
  }

  /** Returns the workspace id the store was bound to. */
  boundWorkspaceId(): string {
    return this.workspaceId;
  }

  /**
   * Resolve a workspace-local opaque ID to its integrity metadata without
   * revealing a filesystem path. Reads must still go through `readWindow` or
   * `readArtifact`, which enforce expiry and verify the bytes.
   */
  referenceForId(artifactId: string): PlaytestArtifactReference | null {
    let file: string;
    try {
      file = metadataPath(this.root, this.workspaceId, artifactId);
    } catch {
      return null;
    }
    if (!this.fileSystem.existsSync(file)) return null;
    const metadata = readMetadata(file, this.fileSystem);
    if (
      metadata.workspaceId !== this.workspaceId ||
      metadata.artifactId !== artifactId
    ) {
      return null;
    }
    return {
      artifactId: metadata.artifactId,
      sha256: metadata.sha256,
      bytes: metadata.bytes,
      mediaType: metadata.mediaType
    };
  }

  /**
   * Write an opaque artifact payload (frame, snapshot, trace, media).
   * Same content + same media type yields the same artifact id; writes
   * are content-deduplicated. Returns the opaque reference plus
   * metadata timestamps.
   */
  writeArtifact(
    request: PlaytestArtifactWriteRequest
  ): PlaytestArtifactWriteResult {
    assertMediaType(request.mediaType);
    assertNotHumanResponse(request.mediaType);
    if (!(request.bytes instanceof Uint8Array)) {
      throw new PlaytestArtifactFormatError(
        "Artifact payload must be a Uint8Array."
      );
    }
    if (request.bytes.byteLength > this.maxBytes) {
      throw new PlaytestArtifactOversizedError(
        "blob",
        request.bytes.byteLength
      );
    }
    const sha256 = this.hash(request.bytes);
    const now = this.now();
    const expiresAt = now + this.retentionMs;
    const blobFile = blobPath(this.root, this.workspaceId, sha256);
    const refsDirectory = safeJoin(this.root, this.workspaceId, "refs");
    const blobsDirectory = safeJoin(
      this.root,
      this.workspaceId,
      "blobs",
      sha256.slice(0, 2)
    );
    ensureOwnedDirectory(refsDirectory, this.root, this.fileSystem);
    ensureOwnedDirectory(blobsDirectory, this.root, this.fileSystem);
    // Atomic write for the blob: write to a temp file in the same shard
    // directory, then rename. If a blob with this hash already exists
    // we skip the write (idempotent dedup) and only mint the reference.
    if (!this.fileSystem.existsSync(blobFile)) {
      const blobTmp = `${blobFile}${TMP_SUFFIX}.${mintToken(this.randomToken)}`;
      try {
        this.fileSystem.writeFileSync(blobTmp, request.bytes, FILE_MODE);
        this.fileSystem.chmodSync(blobTmp, FILE_MODE);
        this.fileSystem.renameSync(blobTmp, blobFile);
      } catch (error) {
        if (this.fileSystem.existsSync(blobTmp)) {
          // Preserve partial evidence for diagnostics; do not auto-delete.
          try {
            this.fileSystem.chmodSync(blobTmp, FILE_MODE);
          } catch {
            // Ignore secondary chmod error
          }
        }
        throw error;
      }
    }
    const artifactId = request.artifactId ?? sha256;
    const metadataFile = metadataPath(this.root, this.workspaceId, artifactId);
    if (this.fileSystem.existsSync(metadataFile)) {
      const existing = readMetadata(metadataFile, this.fileSystem);
      if (
        existing.workspaceId !== this.workspaceId ||
        existing.kind !== "blob" ||
        existing.sha256 !== sha256 ||
        existing.bytes !== request.bytes.byteLength ||
        existing.mediaType !== request.mediaType
      ) {
        throw new PlaytestArtifactIntegrityError(
          artifactId,
          sha256,
          existing.sha256
        );
      }
    } else {
      const metadata: PlaytestArtifactMetadata = {
        artifactId,
        workspaceId: this.workspaceId,
        kind: "blob",
        sha256,
        bytes: request.bytes.byteLength,
        mediaType: request.mediaType,
        lineCount: 0,
        createdAt: now,
        expiresAt
      };
      writeMetadata(metadataFile, metadata, this.fileSystem);
    }
    return {
      reference: {
        artifactId,
        sha256,
        bytes: request.bytes.byteLength,
        mediaType: request.mediaType
      },
      lineCount: 0,
      createdAt: now,
      expiresAt
    };
  }

  /**
   * Write a bounded indexed JSONL step/event window. Each entry is
   * JSON-serialized on a single line; every line is rejected when it
   * exceeds the configured line cap (1 MiB by default). The whole window
   * is rejected when it exceeds the configured total byte or step bound.
   * A failed write preserves the partial .tmp scratch file so the
   * operator can recover what was streamed before the failure.
   */
  writeWindow(
    request: PlaytestArtifactWindowWriteRequest
  ): PlaytestArtifactWriteResult {
    const mediaType = request.mediaType ?? PLAYTESTS_ARTIFACT_WINDOW_MEDIA_TYPE;
    assertMediaType(mediaType);
    assertNotHumanResponse(mediaType);
    if (!Array.isArray(request.entries)) {
      throw new PlaytestArtifactFormatError("Window entries must be an array.");
    }
    if (request.entries.length > this.maxWindowSteps) {
      throw new PlaytestArtifactOversizedError("steps", request.entries.length);
    }

    const pendingFile = windowPath(
      this.root,
      this.workspaceId,
      request.artifactId ?? "pending-window-hash"
    );
    const pendingPath = `${pendingFile}${TMP_SUFFIX}.${mintToken(this.randomToken)}`;
    const windowsDirectory = safeJoin(this.root, this.workspaceId, "windows");
    const merged = encodeWindowEntries(
      request.entries,
      this.maxWindowLineBytes,
      this.maxWindowBytes,
      (bytes) => {
        ensureOwnedDirectory(windowsDirectory, this.root, this.fileSystem);
        this.fileSystem.writeFileSync(pendingPath, bytes, FILE_MODE);
        this.fileSystem.chmodSync(pendingPath, FILE_MODE);
      }
    );
    const sha256 = this.hash(merged);
    const now = this.now();
    const expiresAt = now + this.retentionMs;
    const artifactId = request.artifactId ?? sha256;
    const windowFile = windowPath(this.root, this.workspaceId, artifactId);
    const refsDirectory = safeJoin(this.root, this.workspaceId, "refs");
    ensureOwnedDirectory(refsDirectory, this.root, this.fileSystem);
    ensureOwnedDirectory(windowsDirectory, this.root, this.fileSystem);
    const metadataFile = metadataPath(this.root, this.workspaceId, artifactId);
    const existing = existingWindowResult({
      artifactId,
      sha256,
      bytes: merged.byteLength,
      mediaType,
      lineCount: request.entries.length,
      workspaceId: this.workspaceId,
      windowFile,
      metadataFile,
      fileSystem: this.fileSystem
    });
    if (existing !== null) return existing;

    writeAtomicWindow(windowFile, merged, this.fileSystem, this.randomToken);
    writeMetadata(
      metadataFile,
      {
        artifactId,
        workspaceId: this.workspaceId,
        kind: "window",
        sha256,
        bytes: merged.byteLength,
        mediaType,
        lineCount: request.entries.length,
        createdAt: now,
        expiresAt
      },
      this.fileSystem
    );
    return {
      reference: { artifactId, sha256, bytes: merged.byteLength, mediaType },
      lineCount: request.entries.length,
      createdAt: now,
      expiresAt
    };
  }

  /**
   * Resolve the canonical lifecycle state of a reference under the
   * bound workspace. The returned state never depends on the caller's
   * view of the file system: it is computed against the bound workspace
   * and the canonical root.
   */
  state(reference: PlaytestArtifactReference): PlaytestArtifactState {
    const auth = this.authorize(reference);
    if (!auth.metadata) return "not-authorized";
    if (this.now() >= auth.metadata.expiresAt) return "expired";
    const targetFile =
      auth.metadata.kind === "blob"
        ? blobPath(this.root, this.workspaceId, auth.metadata.sha256)
        : windowPath(this.root, this.workspaceId, auth.metadata.artifactId);
    if (!this.fileSystem.existsSync(targetFile)) return "missing";
    try {
      const lstat = this.fileSystem.lstatSync(targetFile);
      if (lstat.isSymbolicLink()) return "corrupted";
      const bytes = this.fileSystem.readFileSync(targetFile);
      if (
        bytes.byteLength !== auth.metadata.bytes ||
        this.hash(bytes) !== auth.metadata.sha256
      ) {
        return "corrupted";
      }
    } catch {
      return "missing";
    }
    return "present";
  }

  /**
   * Read a blob artifact and verify its content hash. Throws when the
   * reference is not authorized for the bound workspace, when the
   * artifact has expired, or when the on-disk bytes do not match the
   * declared SHA-256.
   */
  readArtifact(reference: PlaytestArtifactReference): {
    readonly bytes: Uint8Array;
    readonly reference: PlaytestArtifactReference;
    readonly createdAt: number;
    readonly expiresAt: number;
  } {
    const auth = this.authorize(reference);
    if (!auth.metadata) {
      throw new PlaytestArtifactNotAuthorizedError(
        reference.artifactId,
        this.workspaceId
      );
    }
    if (auth.metadata.kind !== "blob") {
      throw new PlaytestArtifactFormatError(
        "Reference does not point at a blob artifact."
      );
    }
    if (this.now() >= auth.metadata.expiresAt) {
      throw new PlaytestArtifactExpiredError(
        auth.metadata.artifactId,
        auth.metadata.expiresAt
      );
    }
    const blobFile = blobPath(
      this.root,
      this.workspaceId,
      auth.metadata.sha256
    );
    if (!this.fileSystem.existsSync(blobFile)) {
      throw new PlaytestArtifactMissingError(auth.metadata.artifactId);
    }
    const lstat = this.fileSystem.lstatSync(blobFile);
    if (lstat.isSymbolicLink()) {
      throw new PlaytestArtifactConfigurationError(
        `Artifact file ${blobFile} must not be a symbolic link.`
      );
    }
    const raw = this.fileSystem.readFileSync(blobFile);
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (bytes.byteLength !== auth.metadata.bytes) {
      throw new PlaytestArtifactIntegrityError(
        auth.metadata.artifactId,
        auth.metadata.sha256,
        `size-mismatch:${bytes.byteLength}`
      );
    }
    const actual = this.hash(bytes);
    if (actual !== auth.metadata.sha256) {
      throw new PlaytestArtifactIntegrityError(
        auth.metadata.artifactId,
        auth.metadata.sha256,
        actual
      );
    }
    return {
      bytes,
      reference,
      createdAt: auth.metadata.createdAt,
      expiresAt: auth.metadata.expiresAt
    };
  }

  /**
   * Read a bounded JSONL window and verify its content hash.
   * Same authorization / expiry / integrity guarantees as readArtifact.
   */
  readWindow(
    reference: PlaytestArtifactReference
  ): PlaytestArtifactWindowReadResult {
    const auth = this.authorize(reference);
    if (!auth.metadata) {
      throw new PlaytestArtifactNotAuthorizedError(
        reference.artifactId,
        this.workspaceId
      );
    }
    if (auth.metadata.kind !== "window") {
      throw new PlaytestArtifactFormatError(
        "Reference does not point at a window artifact."
      );
    }
    if (this.now() >= auth.metadata.expiresAt) {
      throw new PlaytestArtifactExpiredError(
        auth.metadata.artifactId,
        auth.metadata.expiresAt
      );
    }
    const windowFile = windowPath(
      this.root,
      this.workspaceId,
      auth.metadata.artifactId
    );
    if (!this.fileSystem.existsSync(windowFile)) {
      throw new PlaytestArtifactMissingError(auth.metadata.artifactId);
    }
    const lstat = this.fileSystem.lstatSync(windowFile);
    if (lstat.isSymbolicLink()) {
      throw new PlaytestArtifactConfigurationError(
        `Window file ${windowFile} must not be a symbolic link.`
      );
    }
    const raw = this.fileSystem.readFileSync(windowFile);
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (bytes.byteLength !== auth.metadata.bytes) {
      throw new PlaytestArtifactIntegrityError(
        auth.metadata.artifactId,
        auth.metadata.sha256,
        `size-mismatch:${bytes.byteLength}`
      );
    }
    const actual = this.hash(bytes);
    if (actual !== auth.metadata.sha256) {
      throw new PlaytestArtifactIntegrityError(
        auth.metadata.artifactId,
        auth.metadata.sha256,
        actual
      );
    }
    return {
      reference,
      bytes,
      lineCount: auth.metadata.lineCount
    };
  }

  /**
   * Remove every reference whose expiresAt is at or before now, along
   * with their underlying blobs / windows when no other reference still
   * points at the same content hash. Returns a structured summary so
   * callers can report retention work without reading internal paths.
   */
  private collectRetainedReferences(
    refsDirectory: string,
    now: number
  ): {
    readonly removedRefs: number;
    readonly expiredRefs: readonly string[];
    readonly blobHashes: ReadonlySet<string>;
    readonly windowIds: ReadonlySet<string>;
  } {
    const expiredRefs: string[] = [];
    const blobHashes = new Set<string>();
    const windowIds = new Set<string>();
    let removedRefs = 0;
    const entries = this.fileSystem.readdirSync(refsDirectory, {
      withFileTypes: true
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const metadataFile = safeJoin(refsDirectory, entry.name);
      let metadata: PlaytestArtifactMetadata;
      try {
        metadata = readMetadata(metadataFile, this.fileSystem);
      } catch {
        this.removeOwnedFile(metadataFile);
        removedRefs += 1;
        continue;
      }
      if (metadata.expiresAt > now) {
        if (metadata.kind === "blob") blobHashes.add(metadata.sha256);
        else windowIds.add(metadata.artifactId);
        continue;
      }
      expiredRefs.push(metadata.artifactId);
      this.removeOwnedFile(metadataFile);
      removedRefs += 1;
    }
    return { removedRefs, expiredRefs, blobHashes, windowIds };
  }

  private removeUnreferencedBlobs(
    blobsDirectory: string,
    referencedHashes: ReadonlySet<string>
  ): number {
    if (!this.fileSystem.existsSync(blobsDirectory)) return 0;
    let removed = 0;
    const entries = this.fileSystem.readdirSync(blobsDirectory, {
      withFileTypes: true
    });
    for (const entry of entries) {
      const entryPath = safeJoin(blobsDirectory, entry.name);
      if (!this.fileSystem.existsSync(entryPath)) continue;
      const lstat = this.fileSystem.lstatSync(entryPath);
      if (lstat.isFile()) {
        if (!referencedHashes.has(entry.name)) {
          this.removeOwnedFile(entryPath);
          removed += 1;
        }
        continue;
      }
      if (!lstat.isDirectory()) continue;
      const shardFiles = this.fileSystem.readdirSync(entryPath, {
        withFileTypes: true
      });
      for (const shardFile of shardFiles) {
        if (!shardFile.isFile() || referencedHashes.has(shardFile.name))
          continue;
        this.removeOwnedFile(safeJoin(entryPath, shardFile.name));
        removed += 1;
      }
    }
    return removed;
  }

  private removeUnreferencedWindows(
    windowsDirectory: string,
    referencedIds: ReadonlySet<string>
  ): number {
    if (!this.fileSystem.existsSync(windowsDirectory)) return 0;
    let removed = 0;
    const windows = this.fileSystem.readdirSync(windowsDirectory, {
      withFileTypes: true
    });
    for (const window of windows) {
      const fileName = window.name.endsWith(".jsonl")
        ? window.name.slice(0, -".jsonl".length)
        : null;
      if (
        !window.isFile() ||
        fileName === null ||
        referencedIds.has(fileName)
      ) {
        continue;
      }
      this.removeOwnedFile(safeJoin(windowsDirectory, window.name));
      removed += 1;
    }
    return removed;
  }

  /**
   * Remove expired references and garbage-collect unreferenced content while
   * preserving active content-addressed blobs shared by multiple references.
   */
  cleanup(now: number = this.now()): PlaytestArtifactCleanupResult {
    const refsDirectory = safeJoin(this.root, this.workspaceId, "refs");
    if (!this.fileSystem.existsSync(refsDirectory)) {
      return {
        removedRefs: 0,
        removedBlobs: 0,
        removedWindows: 0,
        expiredRefs: []
      };
    }
    const retained = this.collectRetainedReferences(refsDirectory, now);
    return {
      removedRefs: retained.removedRefs,
      removedBlobs: this.removeUnreferencedBlobs(
        safeJoin(this.root, this.workspaceId, "blobs"),
        retained.blobHashes
      ),
      removedWindows: this.removeUnreferencedWindows(
        safeJoin(this.root, this.workspaceId, "windows"),
        retained.windowIds
      ),
      expiredRefs: retained.expiredRefs
    };
  }

  /**
   * Remove a single artifact reference (and its backing file when no
   * other reference still hashes to the same content). Idempotent: a
   * reference that is already missing or expired is reported back as a
   * no-op rather than throwing.
   */
  remove(reference: PlaytestArtifactReference): {
    readonly removed: boolean;
    readonly reason: PlaytestArtifactState;
  } {
    const auth = this.authorize(reference);
    if (!auth.metadata) {
      return { removed: false, reason: "not-authorized" };
    }
    const priorState = this.state(reference);
    const metadataFile = metadataPath(
      this.root,
      this.workspaceId,
      auth.metadata.artifactId
    );
    this.removeOwnedFile(metadataFile);
    if (
      auth.metadata.kind === "blob" &&
      !this.hasOtherBlobReference(
        auth.metadata.sha256,
        auth.metadata.artifactId
      )
    ) {
      const targetFile = blobPath(
        this.root,
        this.workspaceId,
        auth.metadata.sha256
      );
      this.removeOwnedFile(targetFile);
    }
    if (auth.metadata.kind === "window") {
      const targetFile = windowPath(
        this.root,
        this.workspaceId,
        auth.metadata.artifactId
      );
      this.removeOwnedFile(targetFile);
    }
    return {
      removed: true,
      reason: priorState
    };
  }

  /**
   * Authorize a reference: returns the stored metadata when the reference
   * resolves under the bound workspace, otherwise null. The reference
   * is never resolved against any other workspace; cross-workspace
   * references always return null so the caller can report
   * not-authorized without learning anything about the other workspace.
   */
  private authorize(reference: PlaytestArtifactReference): {
    readonly metadata: PlaytestArtifactMetadata | null;
  } {
    if (
      !reference ||
      typeof reference.artifactId !== "string" ||
      reference.artifactId.length === 0
    ) {
      return { metadata: null };
    }
    let metadataFile: string;
    try {
      metadataFile = metadataPath(
        this.root,
        this.workspaceId,
        reference.artifactId
      );
    } catch {
      return { metadata: null };
    }
    if (!this.fileSystem.existsSync(metadataFile)) {
      return { metadata: null };
    }
    let metadata: PlaytestArtifactMetadata;
    try {
      metadata = readMetadata(metadataFile, this.fileSystem);
    } catch {
      return { metadata: null };
    }
    if (
      metadata.workspaceId !== this.workspaceId ||
      metadata.artifactId !== reference.artifactId ||
      (reference.sha256 && metadata.sha256 !== reference.sha256) ||
      (reference.bytes !== undefined && metadata.bytes !== reference.bytes)
    ) {
      return { metadata: null };
    }
    return { metadata };
  }

  private hasOtherBlobReference(
    sha256: string,
    excludeArtifactId: string
  ): boolean {
    const refsDirectory = safeJoin(this.root, this.workspaceId, "refs");
    if (!this.fileSystem.existsSync(refsDirectory)) return false;
    const entries = this.fileSystem.readdirSync(refsDirectory, {
      withFileTypes: true
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const metadataFile = safeJoin(refsDirectory, entry.name);
      let metadata: PlaytestArtifactMetadata;
      try {
        metadata = readMetadata(metadataFile, this.fileSystem);
      } catch {
        continue;
      }
      if (
        metadata.artifactId !== excludeArtifactId &&
        metadata.kind === "blob" &&
        metadata.sha256 === sha256
      ) {
        return true;
      }
    }
    return false;
  }

  private removeOwnedFile(target: string): void {
    if (!isWithin(appendSeparator(this.root), target)) {
      throw new PlaytestArtifactConfigurationError(
        `Refusing to remove path ${target} outside the canonical root.`
      );
    }
    if (!this.fileSystem.existsSync(target)) return;
    const lstat = this.fileSystem.lstatSync(target);
    if (lstat.isSymbolicLink()) {
      // A symbolic link under the root is never a managed artifact and
      // must never be unlinked via the artifact store API.
      return;
    }
    try {
      this.fileSystem.unlinkSync(target);
    } catch (error) {
      this.fileSystem.rmSync(target, { force: true });
      if (this.fileSystem.existsSync(target)) {
        throw error;
      }
    }
  }
}

/** Concatenate a sequence of Uint8Array chunks into one fresh Uint8Array. */
function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
