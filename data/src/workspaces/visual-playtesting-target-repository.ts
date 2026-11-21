/** Workspaces-owned local persistence for separately approved visual targets. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  assertWorkspaceVisualPlaytestTargetApproval,
  type WorkspaceVisualPlaytestTargetApproval
} from "@simulatorlife/autodev-core";

import { atomicWriteSync } from "../files/atomic-write.ts";
import { isPathWithin } from "../files/path-containment.ts";

const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH_PATTERN = /^[a-f\d]{64}$/u;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;

export function defaultWorkspaceVisualPlaytestTargetRoot(): string {
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(codexHome, "workspaces", "visual-playtest-targets");
}

export class WorkspaceVisualPlaytestTargetConflictError extends Error {
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(expectedRevision: number | null, actualRevision: number | null) {
    super("Visual target approval changed; reload it before writing.");
    this.name = "WorkspaceVisualPlaytestTargetConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WorkspaceVisualPlaytestTargetStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
    this.name = "WorkspaceVisualPlaytestTargetStoreError";
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TypeError(
      "Workspace id must be a canonical owner/repository key."
    );
  }
}

function assertTargetId(targetId: string): void {
  if (!TARGET_ID_PATTERN.test(targetId)) {
    throw new TypeError("Visual target id is invalid.");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function ensurePrivateDirectory(directory: string, root: string): void {
  if (!isPathWithin(root, directory)) {
    throw new WorkspaceVisualPlaytestTargetStoreError(
      "Visual target approval directory escaped its Workspaces root."
    );
  }
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    chmodSync(directory, OWNER_DIRECTORY_MODE);
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspaceVisualPlaytestTargetStoreError(
      "Visual target approval directories must be real directories, not symlinks."
    );
  }
  const canonical = realpathSync(directory);
  if (!isPathWithin(root, canonical)) {
    throw new WorkspaceVisualPlaytestTargetStoreError(
      "Visual target approval directory resolves outside its Workspaces root."
    );
  }
  chmodSync(directory, OWNER_DIRECTORY_MODE);
}

function ensureTargetDirectory(
  directory: string,
  workspaceDirectory: string
): void {
  ensurePrivateDirectory(directory, workspaceDirectory);
}

/**
 * The repository stores one current approval per `(workspaceId, targetId)`.
 * Both path segments are SHA-256 keys, never operator-controlled names. Files
 * remain local to Workspaces and are not committed with a game repository.
 */
export class WorkspaceVisualPlaytestTargetRepository {
  private readonly root: string;

  constructor(
    rootDirectory: string = defaultWorkspaceVisualPlaytestTargetRoot()
  ) {
    const absolute = path.resolve(rootDirectory);
    if (!existsSync(absolute)) {
      mkdirSync(absolute, { recursive: true, mode: OWNER_DIRECTORY_MODE });
      chmodSync(absolute, OWNER_DIRECTORY_MODE);
    }
    const info = lstatSync(absolute);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceVisualPlaytestTargetStoreError(
        "Visual target approval root must be a real local directory."
      );
    }
    this.root = realpathSync(absolute);
    if (this.root !== absolute) {
      throw new WorkspaceVisualPlaytestTargetStoreError(
        "Visual target approval root must not resolve through a symlink."
      );
    }
    chmodSync(this.root, OWNER_DIRECTORY_MODE);
  }

  rootDirectory(): string {
    return this.root;
  }

  read(
    workspaceId: string,
    targetId: string
  ): WorkspaceVisualPlaytestTargetApproval | null {
    assertWorkspaceId(workspaceId);
    assertTargetId(targetId);
    const workspaceDirectory = this.workspaceDirectory(workspaceId, false);
    if (workspaceDirectory === null) return null;
    const directory = path.join(workspaceDirectory, digest(targetId));
    if (!existsSync(directory)) return null;
    return this.readDirectory(
      workspaceId,
      targetId,
      directory,
      workspaceDirectory
    );
  }

  list(workspaceId: string): readonly WorkspaceVisualPlaytestTargetApproval[] {
    assertWorkspaceId(workspaceId);
    const workspaceDirectory = this.workspaceDirectory(workspaceId, false);
    if (workspaceDirectory === null) return [];
    let entries: string[];
    try {
      entries = readdirSync(workspaceDirectory);
    } catch (error) {
      throw new WorkspaceVisualPlaytestTargetStoreError(
        "Visual target approvals could not be enumerated.",
        error
      );
    }
    const targets = entries.map((entry) => {
      if (!HASH_PATTERN.test(entry)) {
        throw new WorkspaceVisualPlaytestTargetStoreError(
          "Visual target approval directory has an invalid key."
        );
      }
      const directory = path.join(workspaceDirectory, entry);
      const approval = this.readDirectory(
        workspaceId,
        null,
        directory,
        workspaceDirectory
      );
      if (digest(approval.targetId) !== entry) {
        throw new WorkspaceVisualPlaytestTargetStoreError(
          "Visual target approval identity does not match its store key."
        );
      }
      return approval;
    });
    return targets.sort((left, right) =>
      left.targetId < right.targetId
        ? -1
        : left.targetId > right.targetId
          ? 1
          : 0
    );
  }

  approve(
    approval: WorkspaceVisualPlaytestTargetApproval,
    expectedRevision: number | null
  ): WorkspaceVisualPlaytestTargetApproval {
    assertWorkspaceVisualPlaytestTargetApproval(approval);
    const current = this.read(approval.workspaceId, approval.targetId);
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== expectedRevision) {
      throw new WorkspaceVisualPlaytestTargetConflictError(
        expectedRevision,
        actualRevision
      );
    }
    if (current !== null && current.revokedAt === null) {
      throw new WorkspaceVisualPlaytestTargetConflictError(
        expectedRevision,
        actualRevision
      );
    }
    const next: WorkspaceVisualPlaytestTargetApproval = {
      ...approval,
      revision: (actualRevision ?? 0) + 1
    };
    assertWorkspaceVisualPlaytestTargetApproval(next);
    this.write(next);
    return next;
  }

  revoke(
    workspaceId: string,
    targetId: string,
    approvalId: string,
    expectedRevision: number,
    revokedAt: string,
    revokedBy: string,
    revocationReason: string
  ): WorkspaceVisualPlaytestTargetApproval {
    assertWorkspaceId(workspaceId);
    assertTargetId(targetId);
    const current = this.read(workspaceId, targetId);
    if (current === null || current.approvalId !== approvalId) {
      throw new WorkspaceVisualPlaytestTargetConflictError(
        expectedRevision,
        null
      );
    }
    if (current.revision !== expectedRevision || current.revokedAt !== null) {
      throw new WorkspaceVisualPlaytestTargetConflictError(
        expectedRevision,
        current.revision
      );
    }
    const next: WorkspaceVisualPlaytestTargetApproval = {
      ...current,
      revision: current.revision + 1,
      revokedAt,
      revokedBy,
      revocationReason
    };
    assertWorkspaceVisualPlaytestTargetApproval(next);
    this.write(next);
    return next;
  }

  private workspaceDirectory(
    workspaceId: string,
    create: boolean
  ): string | null {
    const directory = path.join(this.root, digest(workspaceId));
    if (!existsSync(directory) && !create) return null;
    ensurePrivateDirectory(directory, this.root);
    return directory;
  }

  private readDirectory(
    workspaceId: string,
    targetId: string | null,
    directory: string,
    workspaceDirectory: string
  ): WorkspaceVisualPlaytestTargetApproval {
    ensureTargetDirectory(directory, workspaceDirectory);
    const file = path.join(directory, "approval.json");
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(file);
    } catch (error) {
      throw new WorkspaceVisualPlaytestTargetStoreError(
        "Visual target approval record could not be inspected.",
        error
      );
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new WorkspaceVisualPlaytestTargetStoreError(
        "Visual target approval record must be a regular non-symlink file."
      );
    }
    const canonical = realpathSync(file);
    if (!isPathWithin(directory, canonical)) {
      throw new WorkspaceVisualPlaytestTargetStoreError(
        "Visual target approval record resolves outside its target directory."
      );
    }
    try {
      const value = JSON.parse(readFileSync(canonical, "utf8")) as unknown;
      assertWorkspaceVisualPlaytestTargetApproval(value);
      if (
        value.workspaceId !== workspaceId ||
        (targetId !== null && value.targetId !== targetId)
      ) {
        throw new TypeError(
          "Visual target approval identity does not match its store key."
        );
      }
      chmodSync(canonical, OWNER_FILE_MODE);
      return value;
    } catch (error) {
      if (error instanceof WorkspaceVisualPlaytestTargetStoreError) throw error;
      throw new WorkspaceVisualPlaytestTargetStoreError(
        "Visual target approval record is invalid or unreadable.",
        error
      );
    }
  }

  private write(approval: WorkspaceVisualPlaytestTargetApproval): void {
    const workspaceDirectory = this.workspaceDirectory(
      approval.workspaceId,
      true
    )!;
    const directory = path.join(workspaceDirectory, digest(approval.targetId));
    ensureTargetDirectory(directory, workspaceDirectory);
    const destination = path.join(directory, "approval.json");
    try {
      atomicWriteSync(destination, JSON.stringify(approval) + "\n", {
        mode: OWNER_FILE_MODE
      });
    } catch (error) {
      throw new WorkspaceVisualPlaytestTargetStoreError(
        "Visual target approval could not be written atomically.",
        error
      );
    }
  }
}
