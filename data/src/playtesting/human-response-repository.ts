/**
 * Durable Data-owned owner-only human response and consent store.
 * Raw participant-linked response data never enters ClickHouse or Runtime
 * artifacts. The repository persists restricted JSON atomically in an
 * injected 0700 directory and computes all summaries from retained rows.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { performance } from "node:perf_hooks";

import {
  aggregateHumanStudyResponses,
  HUMAN_STUDY_SMALL_CELL_SUPPRESSION_THRESHOLD,
  type HumanPlaytestStudy,
  type HumanStudyConstructAggregate,
  type HumanStudyDuplicateQuarantine,
  type HumanStudyExportFormat,
  type HumanStudyExportManifest,
  type HumanStudyImportRejection,
  type HumanStudyImportValidators,
  type HumanStudyPxiItemConstructMapping,
  type HumanStudyPairedArmBuildIds,
  type HumanStudyRawRow,
  type HumanStudyResponse,
  importHumanStudyResponses,
  parseHumanStudyExportRows,
  PLAYTESTS_HUMAN_INSTRUMENTS,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_MEASUREMENT_VERSION
} from "@simulatorlife/autodev-core";

const FORMAT = "autodev-restricted-human-study-v1";
const MAX_STATE_BYTES = 20_000_000;
const SHA256_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const STAGING_FILE_PATTERN = /^[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/u;
const WRITER_LOCK_FILE = ".human-study-writer.lock";
const WRITER_LOCK_WAIT_MS = 1000;
const WRITER_LOCK_POLL_MS = 25;
const WRITER_LOCK_METADATA_MAX_BYTES = 1024;
const LOCK_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_RESTRICTED_HUMAN_STUDY_PATH = [
  "playtesting",
  "human-studies"
] as const;
let defaultRestrictedHumanResponseRepository: RestrictedHumanResponseRepository | null =
  null;

interface WriterLockOwner {
  readonly pid: number;
  readonly token: string;
}

export class RestrictedHumanStudyNotRegisteredError extends Error {
  constructor(studyId: string) {
    super("Human study " + JSON.stringify(studyId) + " is not registered.");
    this.name = "RestrictedHumanStudyNotRegisteredError";
  }
}
export class RestrictedHumanStudyStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RestrictedHumanStudyStorageError";
  }
}

interface ConsentRecord {
  readonly participantId: string;
  readonly consentVersion: string;
  readonly consentScope: string;
}
export interface HumanStudyTombstoneMetadata {
  readonly revision: number;
  readonly status: "withdrawn" | "stale";
  readonly recordedAt: string;
}
interface StudyState {
  readonly format: typeof FORMAT;
  readonly study: HumanPlaytestStudy;
  readonly withdrawalSalt: string;
  responses: HumanStudyResponse[];
  consents: ConsentRecord[];
  withdrawnTokens: string[];
  quarantines: HumanStudyDuplicateQuarantine[];
  revision: number;
  tombstones: HumanStudyTombstoneMetadata[];
}

export interface HumanResponseImportReport {
  readonly studyId: string;
  readonly revision: number;
  readonly acceptedCount: number;
  readonly unchangedCount: number;
  readonly rejected: readonly HumanStudyImportRejection[];
  readonly quarantined: readonly HumanStudyDuplicateQuarantine[];
  readonly retainedParticipants: number | null;
}
export interface HumanResponseWithdrawalReport {
  readonly studyId: string;
  readonly revision: number;
  readonly retainedParticipants: number | null;
}
export interface RestrictedHumanItemSummary {
  readonly itemId: string;
  readonly suppressionState:
    "suppressed" | "partially-suppressed" | "unsuppressed";
  readonly mean: number | null;
  readonly respondentCount: number | null;
  readonly missingCount: number | null;
  readonly categoryCounts: Readonly<Record<string, number | null>> | null;
  readonly unit: string;
}
export interface RestrictedHumanValidationSummary {
  readonly workspaceId: string;
  readonly studyId: string;
  readonly revision: number;
  readonly benchmarkId: string | null;
  readonly buildSha: string;
  readonly instrument: string;
  readonly measurementVersion: string;
  readonly suppressionState:
    "suppressed" | "partially-suppressed" | "unsuppressed";
  readonly retainedParticipants: number | null;
  readonly items: readonly RestrictedHumanItemSummary[];
  readonly constructs: readonly RestrictedHumanConstructSummary[];
  readonly createdAt: string;
}
export interface RestrictedHumanConstructSummary {
  readonly constructId: HumanStudyConstructAggregate["constructId"];
  readonly suppressionState:
    "suppressed" | "partially-suppressed" | "unsuppressed";
  readonly mean: number | null;
  readonly respondentCount: number | null;
  readonly missingCount: number | null;
  readonly unit: string;
}
export interface PlaytestHumanPairedDifferenceSummary {
  readonly workspaceId: string;
  readonly studyId: string;
  readonly revision: number;
  readonly itemId: string;
  readonly suppressionState: "suppressed" | "unsuppressed";
  readonly pairedParticipants: number | null;
  readonly meanDifference: number | null;
}

function validateStudy(study: HumanPlaytestStudy): void {
  if (
    study.schema !== PLAYTESTS_HUMAN_STUDY_SCHEMA ||
    study.approved !== true ||
    !(PLAYTESTS_HUMAN_INSTRUMENTS as readonly string[]).includes(
      study.instrument
    ) ||
    !(["A/B", "AB/BA", "single-build"] as readonly string[]).includes(
      study.orderDesign
    ) ||
    !(["participant", "participant-pair"] as readonly string[]).includes(
      study.independentUnit
    ) ||
    !(["null-construct", "item-wise"] as readonly string[]).includes(
      study.missingItemPolicy
    ) ||
    typeof study.studyId !== "string" ||
    !study.studyId.trim() ||
    study.studyId.length > 256 ||
    typeof study.workspaceId !== "string" ||
    !study.workspaceId.trim() ||
    study.workspaceId.length > 256 ||
    typeof study.benchmarkId !== "string" ||
    !study.benchmarkId.trim() ||
    !Array.isArray(study.allowedBuilds) ||
    study.allowedBuilds.length === 0 ||
    study.allowedBuilds.length > 16 ||
    study.allowedBuilds.some(
      (build) =>
        !build ||
        typeof build.id !== "string" ||
        !build.id.trim() ||
        build.id.length > 256 ||
        !(typeof build.version === "string"
          ? build.version.trim().length > 0 && build.version.length <= 128
          : Number.isSafeInteger(build.version) && build.version >= 1) ||
        (build.contentHash !== undefined &&
          !SHA256_TOKEN_PATTERN.test(build.contentHash))
    ) ||
    new Set(
      study.allowedBuilds.map((build) =>
        JSON.stringify([
          build.id,
          String(build.version),
          build.contentHash ?? null
        ])
      )
    ).size !== study.allowedBuilds.length ||
    (study.instrument === "PXI"
      ? !SHA256_TOKEN_PATTERN.test(study.pxiItemConstructMappingHash ?? "")
      : study.pxiItemConstructMappingHash !== null) ||
    study.benchmarkId.length > 256 ||
    typeof study.approvedBy !== "string" ||
    !study.approvedBy.trim() ||
    typeof study.instrumentVersion !== "string" ||
    !study.instrumentVersion.trim() ||
    typeof study.instrumentHash !== "string" ||
    !study.instrumentHash.trim() ||
    typeof study.consentVersion !== "string" ||
    !study.consentVersion.trim() ||
    typeof study.consentScope !== "string" ||
    !study.consentScope.trim() ||
    !Number.isSafeInteger(study.version) ||
    study.version < 1 ||
    !Number.isFinite(study.responseWindowMs) ||
    study.responseWindowMs <= 0 ||
    !Number.isFinite(study.minimumExposureMs) ||
    study.minimumExposureMs < 0 ||
    !Number.isSafeInteger(study.invitedCount) ||
    study.invitedCount < 0 ||
    !Number.isSafeInteger(study.eligibleCount) ||
    study.eligibleCount < 0 ||
    study.eligibleCount > study.invitedCount ||
    !Number.isSafeInteger(study.respondedCount) ||
    study.respondedCount < 0 ||
    study.respondedCount > study.eligibleCount ||
    !Number.isSafeInteger(study.withdrawnCount) ||
    study.withdrawnCount < 0 ||
    study.withdrawnCount > study.invitedCount ||
    !Number.isFinite(Date.parse(study.createdAt))
  )
    throw new TypeError(
      "Only valid, approved human studies can be registered."
    );
}
function newState(study: HumanPlaytestStudy): StudyState {
  return {
    format: FORMAT,
    study,
    withdrawalSalt: randomBytes(32).toString("hex"),
    responses: [],
    consents: [],
    withdrawnTokens: [],
    quarantines: [],
    revision: 0,
    tombstones: []
  };
}

function sameStudy(
  left: HumanPlaytestStudy,
  right: HumanPlaytestStudy
): boolean {
  const serialize = (study: HumanPlaytestStudy): string =>
    JSON.stringify(
      Object.keys(study)
        .sort()
        .map((key) => [key, study[key as keyof HumanPlaytestStudy]])
    );
  return serialize(left) === serialize(right);
}
function hashParticipant(state: StudyState, participantId: string): string {
  return createHash("sha256")
    .update(state.withdrawalSalt)
    .update("\0")
    .update(participantId)
    .digest("hex");
}
export function hashHumanStudyPxiItemConstructMapping(
  mapping: HumanStudyPxiItemConstructMapping
): string {
  const items = [...mapping.items]
    .sort((left, right) =>
      left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0
    )
    .map(({ itemId, constructId }) => ({ itemId, constructId }));
  return createHash("sha256")
    .update(JSON.stringify({ instrumentHash: mapping.instrumentHash, items }))
    .digest("hex");
}

function stateFileKey(studyId: string): string {
  return createHash("sha256").update(studyId).digest("hex") + ".json";
}
function assertPrivateFile(filePath: string): fs.Stats {
  const stat = fs.lstatSync(filePath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new RestrictedHumanStudyStorageError(
      "Restricted state must be an owner-only regular file."
    );
  }
  return stat;
}

/** rootDirectory must be a private, caller-selected durable directory. */
export class RestrictedHumanResponseRepository {
  private readonly root: string;
  private readonly threshold: number;
  private writerLockHeld = false;

  constructor(options: { readonly rootDirectory: string }) {
    if (!options.rootDirectory)
      throw new TypeError(
        "A restricted human-study root directory is required."
      );
    this.root = path.resolve(options.rootDirectory);
    this.threshold = HUMAN_STUDY_SMALL_CELL_SUPPRESSION_THRESHOLD;
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.root);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new RestrictedHumanStudyStorageError(
        "Restricted root must be a real directory owned by this user."
      );
    }
    fs.chmodSync(this.root, 0o700);
    this.withWriterLock(() => this.removeOrphanedStagingFiles());
  }

  private writerLockPath(): string {
    return path.join(this.root, WRITER_LOCK_FILE);
  }

  private readWriterLockOwner(lockFile: string): WriterLockOwner | null {
    let before: fs.Stats;
    try {
      before = assertPrivateFile(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (before.size > WRITER_LOCK_METADATA_MAX_BYTES) {
      throw new RestrictedHumanStudyStorageError(
        "Writer lock metadata exceeds its size bound."
      );
    }
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        lockFile,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.ino !== before.ino) {
        throw new RestrictedHumanStudyStorageError(
          "Writer lock metadata changed during secure open."
        );
      }
      const parsed: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !Number.isSafeInteger((parsed as WriterLockOwner).pid) ||
        (parsed as WriterLockOwner).pid <= 0 ||
        typeof (parsed as WriterLockOwner).token !== "string" ||
        (parsed as WriterLockOwner).token.length === 0
      ) {
        throw new RestrictedHumanStudyStorageError(
          "Writer lock metadata is malformed; refusing unsafe recovery."
        );
      }
      return parsed as WriterLockOwner;
    } catch (error) {
      if (error instanceof RestrictedHumanStudyStorageError) throw error;
      throw new RestrictedHumanStudyStorageError(
        "Could not safely read writer lock metadata.",
        { cause: error }
      );
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      throw new RestrictedHumanStudyStorageError(
        "Could not determine whether the writer-lock owner is alive.",
        { cause: error }
      );
    }
  }

  private sleepForWriterPoll(deadline: number): void {
    const remaining = deadline - performance.now();
    if (remaining > 0) {
      Atomics.wait(
        LOCK_SLEEP_CELL,
        0,
        0,
        Math.min(WRITER_LOCK_POLL_MS, remaining)
      );
    }
  }

  private createWriterLock(lockFile: string): WriterLockOwner {
    const owner: WriterLockOwner = {
      pid: process.pid,
      token: randomUUID()
    };
    let fd: number | undefined;
    let inode: number | undefined;
    try {
      fd = fs.openSync(
        lockFile,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      inode = fs.fstatSync(fd).ino;
      fs.writeFileSync(fd, JSON.stringify(owner), { encoding: "utf8" });
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      assertPrivateFile(lockFile);
      const rootFd = fs.openSync(this.root, fsConstants.O_RDONLY);
      try {
        fs.fsyncSync(rootFd);
      } finally {
        fs.closeSync(rootFd);
      }
      return owner;
    } catch (error) {
      if (
        fd === undefined &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        throw error;
      }
      if (fd !== undefined) fs.closeSync(fd);
      try {
        const stat = fs.lstatSync(lockFile);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.ino === inode) {
          fs.unlinkSync(lockFile);
        }
      } catch {
        /* The lock file may not have been created. */
      }
      throw new RestrictedHumanStudyStorageError(
        "Could not create a private writer lock.",
        { cause: error }
      );
    }
  }

  private readCurrentWriterOwner(lockFile: string): WriterLockOwner | null {
    try {
      return this.readWriterLockOwner(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private rejectStaleWriter(
    lockFile: string,
    owner: WriterLockOwner | null
  ): void {
    if (owner === null || this.isProcessAlive(owner.pid)) return;
    const currentOwner = this.readCurrentWriterOwner(lockFile);
    if (currentOwner?.token !== owner.token) return;
    throw new RestrictedHumanStudyStorageError(
      "A stale writer lock exists; automatic removal is unsafe. Verify its owner is stopped, then remove the lock file."
    );
  }

  private waitForExistingWriter(lockFile: string, deadline: number): void {
    const owner = this.readCurrentWriterOwner(lockFile);
    this.rejectStaleWriter(lockFile, owner);
    if (owner === null) return;
    if (performance.now() >= deadline) {
      throw new RestrictedHumanStudyStorageError(
        "Timed out waiting for the restricted human-study writer lock."
      );
    }
    this.sleepForWriterPoll(deadline);
  }

  private acquireWriterLock(): WriterLockOwner {
    const lockFile = this.writerLockPath();
    const deadline = performance.now() + WRITER_LOCK_WAIT_MS;
    while (true) {
      try {
        return this.createWriterLock(lockFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        this.waitForExistingWriter(lockFile, deadline);
      }
    }
  }

  private releaseWriterLock(owner: WriterLockOwner): void {
    const lockFile = this.writerLockPath();
    const actual = this.readWriterLockOwner(lockFile);
    if (actual?.token !== owner.token || actual.pid !== owner.pid) {
      throw new RestrictedHumanStudyStorageError(
        "Writer lock ownership changed; refusing to release another process's lock."
      );
    }
    fs.unlinkSync(lockFile);
    const dirFd = fs.openSync(this.root, fsConstants.O_RDONLY);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  private withWriterLock<Result>(operation: () => Result): Result {
    if (this.writerLockHeld) {
      throw new RestrictedHumanStudyStorageError(
        "Reentrant human-study writes are not supported."
      );
    }
    this.assertRoot();
    const owner = this.acquireWriterLock();
    this.writerLockHeld = true;
    try {
      return operation();
    } finally {
      try {
        this.releaseWriterLock(owner);
      } finally {
        this.writerLockHeld = false;
      }
    }
  }

  private removeOrphanedStagingFiles(): void {
    for (const name of fs.readdirSync(this.root)) {
      if (!STAGING_FILE_PATTERN.test(name)) continue;
      const stagingPath = path.join(this.root, name);
      assertPrivateFile(stagingPath);
      fs.unlinkSync(stagingPath);
    }
  }

  private assertRoot(): void {
    const stat = fs.lstatSync(this.root);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new RestrictedHumanStudyStorageError(
        "Restricted root permissions or type changed."
      );
    }
  }
  private pathFor(studyId: string): string {
    return path.join(this.root, stateFileKey(studyId));
  }
  private readState(studyId: string): StudyState | null {
    this.assertRoot();
    const filePath = this.pathFor(studyId);
    let before: fs.Stats;
    try {
      before = assertPrivateFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (before.size > MAX_STATE_BYTES)
      throw new RestrictedHumanStudyStorageError(
        "Restricted state exceeds size limit."
      );
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        filePath,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
      );
      const opened = fs.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.ino !== before.ino ||
        (opened.mode & 0o077) !== 0
      ) {
        throw new RestrictedHumanStudyStorageError(
          "Restricted state changed during secure open."
        );
      }
      const value: unknown = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (typeof value !== "object" || value === null)
        throw new Error("state is not an object");
      const state = value as StudyState;
      if (
        state.format !== FORMAT ||
        state.study?.studyId !== studyId ||
        typeof state.withdrawalSalt !== "string" ||
        !SHA256_TOKEN_PATTERN.test(state.withdrawalSalt) ||
        !Array.isArray(state.responses) ||
        !Array.isArray(state.consents) ||
        !Array.isArray(state.withdrawnTokens) ||
        !Array.isArray(state.quarantines) ||
        !Array.isArray(state.tombstones) ||
        !Number.isSafeInteger(state.revision)
      )
        throw new Error("state schema invalid");
      validateStudy(state.study);
      if (
        state.responses.some(
          (response) =>
            response.studyId !== studyId ||
            !response.responseId ||
            !response.pseudonymousParticipantId ||
            !Number.isSafeInteger(response.revision) ||
            typeof response.completionStatus !== "string"
        ) ||
        state.consents.some(
          (consent) =>
            !consent.participantId ||
            consent.consentVersion !== state.study.consentVersion ||
            consent.consentScope !== state.study.consentScope
        ) ||
        state.withdrawnTokens.some((token) => !SHA256_TOKEN_PATTERN.test(token))
      ) {
        throw new Error(
          "restricted response, consent, or withdrawal state invalid"
        );
      }
      return state;
    } catch (error) {
      if (error instanceof RestrictedHumanStudyStorageError) throw error;
      throw new RestrictedHumanStudyStorageError(
        "Could not read restricted state safely.",
        { cause: error }
      );
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  private writeState(state: StudyState): void {
    if (!this.writerLockHeld) {
      throw new RestrictedHumanStudyStorageError(
        "Restricted state writes require the cross-process writer lock."
      );
    }
    this.assertRoot();
    const filePath = this.pathFor(state.study.studyId);
    try {
      const stat = fs.lstatSync(filePath);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        (process.getuid && stat.uid !== process.getuid()) ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new RestrictedHumanStudyStorageError(
          "Refusing to replace unsafe restricted state."
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const content = JSON.stringify(state);
    if (Buffer.byteLength(content, "utf8") > MAX_STATE_BYTES) {
      throw new RestrictedHumanStudyStorageError(
        "Restricted state exceeds size limit."
      );
    }
    const temp = filePath + "." + randomUUID() + ".tmp";
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        temp,
        fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          fsConstants.O_WRONLY |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600
      );
      fs.writeFileSync(fd, content, { encoding: "utf8" });
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, filePath);
      fs.chmodSync(filePath, 0o600);
      const dirFd = fs.openSync(this.root, fsConstants.O_RDONLY);
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(temp);
      } catch {
        /* renamed or absent */
      }
      if (error instanceof RestrictedHumanStudyStorageError) throw error;
      throw new RestrictedHumanStudyStorageError(
        "Could not atomically persist restricted state.",
        { cause: error }
      );
    }
  }
  private requireState(studyId: string): StudyState {
    const state = this.readState(studyId);
    if (!state) throw new RestrictedHumanStudyNotRegisteredError(studyId);
    return state;
  }

  registerStudy(study: HumanPlaytestStudy): void {
    validateStudy(study);
    this.withWriterLock(() => {
      const prior = this.readState(study.studyId);
      if (prior) {
        if (!sameStudy(prior.study, study)) {
          throw new TypeError(
            "Registered study metadata cannot be silently replaced."
          );
        }
        return;
      }
      this.writeState(newState(study));
    });
  }
  recordConsent(
    studyId: string,
    participantId: string,
    consentVersion: string,
    consentScope: string
  ): void {
    this.withWriterLock(() => {
      const state = this.requireState(studyId);
      if (
        !participantId.trim() ||
        !consentVersion.trim() ||
        !consentScope.trim()
      ) {
        throw new TypeError(
          "Consent requires participant, version, and scope."
        );
      }
      if (
        state.withdrawnTokens.includes(hashParticipant(state, participantId))
      ) {
        throw new TypeError("A withdrawn participant cannot be re-consented.");
      }
      if (
        consentVersion !== state.study.consentVersion ||
        consentScope !== state.study.consentScope
      ) {
        throw new TypeError(
          "Consent version/scope must match the registered study."
        );
      }
      state.consents = state.consents.filter(
        (entry) => entry.participantId !== participantId
      );
      state.consents.push({ participantId, consentVersion, consentScope });
      this.writeState(state);
    });
  }
  getConsent(
    studyId: string,
    participantId: string
  ): Omit<ConsentRecord, "participantId"> | null {
    const record = this.requireState(studyId).consents.find(
      (entry) => entry.participantId === participantId
    );
    return record
      ? {
          consentVersion: record.consentVersion,
          consentScope: record.consentScope
        }
      : null;
  }
  isParticipantWithdrawn(studyId: string, participantId: string): boolean {
    const state = this.requireState(studyId);
    return state.withdrawnTokens.includes(
      hashParticipant(state, participantId)
    );
  }
  private activeResponses(state: StudyState): readonly HumanStudyResponse[] {
    const superseded = new Set(
      state.responses
        .map((response) => response.supersedes)
        .filter((id): id is string => id !== null)
    );
    const quarantined = new Set(
      state.quarantines.flatMap((entry) => entry.responseIds)
    );
    return state.responses.filter(
      (response) =>
        !superseded.has(response.responseId) &&
        !quarantined.has(response.responseId) &&
        !state.withdrawnTokens.includes(
          hashParticipant(state, response.pseudonymousParticipantId)
        )
    );
  }
  importExport(
    studyId: string,
    raw: string,
    format: HumanStudyExportFormat,
    manifest: HumanStudyExportManifest,
    validators: HumanStudyImportValidators,
    options: { readonly pairedArmBuildIds?: HumanStudyPairedArmBuildIds } = {}
  ): HumanResponseImportReport {
    this.requireState(studyId);
    return this.importRows(
      studyId,
      parseHumanStudyExportRows(raw, format),
      manifest,
      validators,
      options
    );
  }
  importRows(
    studyId: string,
    rows: readonly HumanStudyRawRow[],
    manifest: HumanStudyExportManifest,
    validators: HumanStudyImportValidators,
    options: { readonly pairedArmBuildIds?: HumanStudyPairedArmBuildIds } = {}
  ): HumanResponseImportReport {
    return this.withWriterLock(() =>
      this.importRowsLocked(studyId, rows, manifest, validators, options)
    );
  }

  private importRowsLocked(
    studyId: string,
    rows: readonly HumanStudyRawRow[],
    manifest: HumanStudyExportManifest,
    validators: HumanStudyImportValidators,
    _options: { readonly pairedArmBuildIds?: HumanStudyPairedArmBuildIds } = {}
  ): HumanResponseImportReport {
    const state = this.requireState(studyId);
    const quarantinedIds = new Set(
      state.quarantines.flatMap((entry) => entry.responseIds)
    );
    for (const row of rows) {
      const supersedes =
        typeof row === "object" && row !== null
          ? row[manifest.supersedesColumn]
          : undefined;
      if (typeof supersedes === "string" && quarantinedIds.has(supersedes)) {
        throw new TypeError(
          "Resolve the pending duplicate quarantine before importing an amendment."
        );
      }
    }
    const restrictedValidators: HumanStudyImportValidators = {
      ...validators,
      isApprovedStudy: (study) =>
        study.approved && validators.isApprovedStudy(study),
      isWorkspaceAllowed: (study, workspaceId) =>
        workspaceId === study.workspaceId &&
        validators.isWorkspaceAllowed(study, workspaceId),
      isBuildAllowed: (study, build) =>
        study.allowedBuilds.some(
          (allowed) =>
            allowed.id === build.id &&
            allowed.version === build.version &&
            (allowed.contentHash ?? null) === (build.contentHash ?? null)
        ) && validators.isBuildAllowed(study, build),
      isTrustedPxiItemConstructMapping: (study, mapping) =>
        study.pxiItemConstructMappingHash ===
          hashHumanStudyPxiItemConstructMapping(mapping) &&
        validators.isTrustedPxiItemConstructMapping(study, mapping),
      isParticipantWithdrawn: (study, participantId) =>
        state.withdrawnTokens.includes(hashParticipant(state, participantId)) ||
        validators.isParticipantWithdrawn(study, participantId),
      isConsentValid: (study, participantId, version, scope) => {
        const stored = state.consents.find(
          (entry) => entry.participantId === participantId
        );
        return (
          !state.withdrawnTokens.includes(
            hashParticipant(state, participantId)
          ) &&
          stored !== undefined &&
          stored.consentVersion === version &&
          stored.consentScope === scope &&
          validators.isConsentValid(study, participantId, version, scope)
        );
      }
    };
    const outcome = importHumanStudyResponses(
      state.study,
      rows,
      manifest,
      restrictedValidators,
      state.responses
    );
    const additions = [...outcome.accepted, ...outcome.quarantinedResponses];
    const known = new Set(
      state.responses.map((response) => responseGroupKey(response))
    );
    const newResponses = additions.filter(
      (response) => !known.has(responseGroupKey(response))
    );
    if (newResponses.length > 0) {
      if (state.revision > 0) {
        state.tombstones.push({
          revision: state.revision,
          status: "stale",
          recordedAt: new Date().toISOString()
        });
      }
      state.responses.push(...newResponses);
      state.quarantines.push(...outcome.quarantined);
      state.revision += 1;
      this.writeState(state);
    }
    const participants = new Set(
      this.activeResponses(state).map(
        (response) => response.pseudonymousParticipantId
      )
    ).size;
    return {
      studyId,
      revision: state.revision,
      acceptedCount: outcome.accepted.length,
      unchangedCount: outcome.unchanged.length,
      rejected: outcome.rejected,
      quarantined: outcome.quarantined,
      retainedParticipants: participants < this.threshold ? null : participants
    };
  }

  listQuarantine(studyId: string): readonly HumanStudyDuplicateQuarantine[] {
    return this.requireState(studyId).quarantines;
  }
  resolveQuarantine(studyId: string, responseIdToKeep: string): void {
    this.withWriterLock(() =>
      this.resolveQuarantineLocked(studyId, responseIdToKeep)
    );
  }

  private resolveQuarantineLocked(
    studyId: string,
    responseIdToKeep: string
  ): void {
    const state = this.requireState(studyId);
    const group = state.quarantines.find((entry) =>
      entry.responseIds.includes(responseIdToKeep)
    );
    if (!group) throw new TypeError("Response is not in a pending quarantine.");
    if (
      !state.responses.some(
        (response) => response.responseId === responseIdToKeep
      )
    ) {
      throw new TypeError(
        "Selected quarantined response is not retained in restricted storage."
      );
    }
    const discarded = new Set(
      group.responseIds.filter((id) => id !== responseIdToKeep)
    );
    state.responses = state.responses.filter(
      (response) => !discarded.has(response.responseId)
    );
    state.quarantines = state.quarantines.filter((entry) => entry !== group);
    if (state.revision > 0) {
      state.tombstones.push({
        revision: state.revision,
        status: "stale",
        recordedAt: new Date().toISOString()
      });
    }
    state.revision += 1;
    this.writeState(state);
  }
  withdrawParticipant(
    studyId: string,
    participantId: string,
    options: { readonly pairedArmBuildIds?: HumanStudyPairedArmBuildIds } = {}
  ): HumanResponseWithdrawalReport {
    return this.withWriterLock(() =>
      this.withdrawParticipantLocked(studyId, participantId, options)
    );
  }

  private withdrawParticipantLocked(
    studyId: string,
    participantId: string,
    _options: { readonly pairedArmBuildIds?: HumanStudyPairedArmBuildIds } = {}
  ): HumanResponseWithdrawalReport {
    const state = this.requireState(studyId);
    if (!participantId.trim())
      throw new TypeError("Withdrawal requires a participant pseudonym.");
    const token = hashParticipant(state, participantId);
    if (!state.withdrawnTokens.includes(token)) {
      if (state.revision > 0) {
        state.tombstones.push({
          revision: state.revision,
          status: "withdrawn",
          recordedAt: new Date().toISOString()
        });
      }
      state.responses = state.responses.filter(
        (response) => response.pseudonymousParticipantId !== participantId
      );
      state.consents = state.consents.filter(
        (record) => record.participantId !== participantId
      );
      state.quarantines = state.quarantines.filter(
        (quarantine) => quarantine.participantId !== participantId
      );
      state.withdrawnTokens.push(token);
      state.revision += 1;
      this.writeState(state);
    }
    const participants = new Set(
      this.activeResponses(state).map(
        (response) => response.pseudonymousParticipantId
      )
    ).size;
    return {
      studyId,
      revision: state.revision,
      retainedParticipants: participants < this.threshold ? null : participants
    };
  }

  getHumanValidationSummary(
    studyId: string,
    buildSha: string,
    options: { readonly pairedArmBuildIds?: HumanStudyPairedArmBuildIds } = {}
  ): RestrictedHumanValidationSummary | null {
    const state = this.requireState(studyId);
    const result = aggregateHumanStudyResponses(
      state.study,
      this.activeResponses(state),
      {
        ...(options.pairedArmBuildIds
          ? { pairedArmBuildIds: options.pairedArmBuildIds }
          : {})
      }
    );
    const arm = result.arms.filter((item) => item.armBuildId === buildSha);
    if (arm.length === 0) return null;
    const constructArm = result.constructs.filter(
      (construct) => construct.armBuildId === buildSha
    );
    const studySuppressed = result.retainedParticipants < this.threshold;
    let anySuppressed = studySuppressed;
    const items: RestrictedHumanItemSummary[] = arm.map((cell) => {
      const hasSmallCategoryCell = Object.values(cell.categoryCounts).some(
        (count) => count > 0 && count < this.threshold
      );
      const hasSmallMissingCell =
        cell.missingCount > 0 && cell.missingCount < this.threshold;
      const suppressItem =
        studySuppressed ||
        cell.respondentCount < this.threshold ||
        hasSmallCategoryCell ||
        hasSmallMissingCell;
      if (suppressItem) {
        anySuppressed = true;
        return {
          itemId: cell.itemId,
          suppressionState: "suppressed",
          mean: null,
          respondentCount: null,
          missingCount: null,
          categoryCounts: null,
          unit: cell.unit
        };
      }
      return {
        itemId: cell.itemId,
        suppressionState: "unsuppressed",
        mean: cell.mean,
        respondentCount: cell.respondentCount,
        missingCount: cell.missingCount,
        categoryCounts: cell.categoryCounts,
        unit: cell.unit
      };
    });
    const constructs: RestrictedHumanConstructSummary[] = constructArm.map(
      (cell) => {
        const smallMissingCell =
          cell.missingCount > 0 && cell.missingCount < this.threshold;
        const suppressConstruct =
          studySuppressed ||
          cell.respondentCount < this.threshold ||
          smallMissingCell;
        if (suppressConstruct) anySuppressed = true;
        return {
          constructId: cell.constructId,
          suppressionState: suppressConstruct ? "suppressed" : "unsuppressed",
          mean: suppressConstruct ? null : cell.mean,
          respondentCount: suppressConstruct ? null : cell.respondentCount,
          missingCount: suppressConstruct ? null : cell.missingCount,
          unit: cell.unit
        };
      }
    );
    if (studySuppressed) {
      return {
        workspaceId: state.study.workspaceId,
        studyId,
        revision: state.revision,
        benchmarkId: state.study.benchmarkId,
        buildSha,
        instrument: state.study.instrument,
        measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
        suppressionState: "suppressed",
        retainedParticipants: null,
        items: items.map((item) => ({
          ...item,
          suppressionState: "suppressed",
          mean: null,
          respondentCount: null,
          missingCount: null,
          categoryCounts: null
        })),
        constructs: constructs.map((construct) => ({
          ...construct,
          suppressionState: "suppressed",
          mean: null,
          respondentCount: null,
          missingCount: null
        })),
        createdAt: new Date().toISOString()
      };
    }
    return {
      workspaceId: state.study.workspaceId,
      studyId,
      revision: state.revision,
      benchmarkId: state.study.benchmarkId,
      buildSha,
      instrument: state.study.instrument,
      measurementVersion: PLAYTESTS_MEASUREMENT_VERSION,
      suppressionState: anySuppressed ? "partially-suppressed" : "unsuppressed",
      retainedParticipants: result.retainedParticipants,
      items,
      constructs,
      createdAt: new Date().toISOString()
    };
  }
  getPairedDifferenceSummaries(
    studyId: string,
    pairedArmBuildIds: HumanStudyPairedArmBuildIds
  ): readonly PlaytestHumanPairedDifferenceSummary[] {
    const state = this.requireState(studyId);
    const result = aggregateHumanStudyResponses(
      state.study,
      this.activeResponses(state),
      { pairedArmBuildIds }
    );
    return result.pairedDifferences.map((cell) => {
      const suppressed = cell.pairedParticipants < this.threshold;
      return {
        workspaceId: state.study.workspaceId,
        studyId,
        revision: state.revision,
        itemId: cell.itemId,
        suppressionState: suppressed ? "suppressed" : "unsuppressed",
        pairedParticipants: suppressed ? null : cell.pairedParticipants,
        meanDifference: suppressed ? null : cell.meanDifference
      };
    });
  }
  /** Tombstone history contains state/revision metadata only, never prior values or identities. */
  getTombstonedHistory(
    studyId: string
  ): readonly HumanStudyTombstoneMetadata[] {
    return this.requireState(studyId).tombstones;
  }
}

function responseGroupKey(response: HumanStudyResponse): string {
  return JSON.stringify([response.studyId, response.responseId]);
}

/** Durable default restricted store location; never inside a game workspace. */
export function defaultRestrictedHumanStudyRoot(
  env: NodeJS.ProcessEnv = process.env
): string {
  const configuredRoot = env.AUTODEV_HUMAN_STUDY_DATA_ROOT?.trim();
  if (configuredRoot) {
    if (!path.isAbsolute(configuredRoot)) {
      throw new TypeError("AUTODEV_HUMAN_STUDY_DATA_ROOT must be absolute.");
    }
    return path.resolve(configuredRoot);
  }
  const codexHome = env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  if (!path.isAbsolute(codexHome)) {
    throw new TypeError(
      "CODEX_HOME must be absolute for restricted human-study storage."
    );
  }
  return path.join(
    path.resolve(codexHome),
    ...DEFAULT_RESTRICTED_HUMAN_STUDY_PATH
  );
}

/** One Data-owned owner-only store for the Runtime process. */
export function getDefaultRestrictedHumanResponseRepository(): RestrictedHumanResponseRepository {
  defaultRestrictedHumanResponseRepository ??=
    new RestrictedHumanResponseRepository({
      rootDirectory: defaultRestrictedHumanStudyRoot()
    });
  return defaultRestrictedHumanResponseRepository;
}
