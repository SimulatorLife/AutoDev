/** Workspaces-owned, owner-only local persistence for exact playtest approvals. */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  assertWorkspacePlaytestApproval,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";

const WORKSPACE_ID_PATTERN = /^[^/\s]+\/[^/\s]+$/u;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const TEMP_MARKER = ".tmp.";

export function defaultWorkspacePlaytestApprovalRoot(): string {
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(codexHome, "workspaces", "playtesting-approvals");
}

export class WorkspacePlaytestApprovalConflictError extends Error {
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(expectedRevision: number | null, actualRevision: number | null) {
    super("Workspace playtest approval changed; reload it before writing.");
    this.name = "WorkspacePlaytestApprovalConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WorkspacePlaytestApprovalStoreError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
    this.name = "WorkspacePlaytestApprovalStoreError";
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new TypeError(
      "Workspace id must be a canonical owner/repository key."
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function workspaceKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex");
}

function ensurePrivateDirectory(directory: string, root: string): void {
  if (!isWithin(root, directory)) {
    throw new WorkspacePlaytestApprovalStoreError(
      "Approval directory escaped its local Workspaces root."
    );
  }
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    chmodSync(directory, OWNER_DIRECTORY_MODE);
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspacePlaytestApprovalStoreError(
      "Workspace approval directories must be real directories, not symlinks."
    );
  }
  const canonical = realpathSync(directory);
  if (!isWithin(root, canonical)) {
    throw new WorkspacePlaytestApprovalStoreError(
      "Workspace approval directory resolves outside its local root."
    );
  }
  chmodSync(directory, OWNER_DIRECTORY_MODE);
}

/**
 * The repository persists one current approval revision per canonical
 * workspace. The file is not checked into the game repository, and its ID is a
 * one-way digest so repository names never become filesystem path segments.
 */
export class WorkspacePlaytestApprovalRepository {
  private readonly root: string;

  constructor(rootDirectory: string = defaultWorkspacePlaytestApprovalRoot()) {
    const absolute = path.resolve(rootDirectory);
    if (!existsSync(absolute)) {
      mkdirSync(absolute, { recursive: true, mode: OWNER_DIRECTORY_MODE });
      chmodSync(absolute, OWNER_DIRECTORY_MODE);
    }
    const stat = lstatSync(absolute);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspacePlaytestApprovalStoreError(
        "Workspace approval root must be a real local directory."
      );
    }
    this.root = realpathSync(absolute);
    if (this.root !== absolute) {
      throw new WorkspacePlaytestApprovalStoreError(
        "Workspace approval root must not resolve through a symlink."
      );
    }
    chmodSync(this.root, OWNER_DIRECTORY_MODE);
  }

  rootDirectory(): string {
    return this.root;
  }

  read(workspaceId: string): WorkspacePlaytestApproval | null {
    assertWorkspaceId(workspaceId);
    const directory = this.workspaceDirectory(workspaceId, false);
    if (directory === null) return null;
    const file = path.join(directory, "approval.json");
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new WorkspacePlaytestApprovalStoreError(
        "Workspace approval record could not be inspected.",
        error
      );
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new WorkspacePlaytestApprovalStoreError(
        "Workspace approval record must be a regular non-symlink file."
      );
    }
    const canonical = realpathSync(file);
    if (!isWithin(directory, canonical)) {
      throw new WorkspacePlaytestApprovalStoreError(
        "Workspace approval record resolves outside its workspace directory."
      );
    }
    try {
      const value = JSON.parse(readFileSync(canonical, "utf8")) as unknown;
      assertWorkspacePlaytestApproval(value);
      if (value.workspaceId !== workspaceId) {
        throw new TypeError(
          "Approval workspace identity does not match its store key."
        );
      }
      chmodSync(canonical, OWNER_FILE_MODE);
      return value;
    } catch (error) {
      if (error instanceof WorkspacePlaytestApprovalStoreError) throw error;
      throw new WorkspacePlaytestApprovalStoreError(
        "Workspace approval record is invalid or unreadable.",
        error
      );
    }
  }

  approve(
    approval: WorkspacePlaytestApproval,
    expectedRevision: number | null
  ): WorkspacePlaytestApproval {
    assertWorkspacePlaytestApproval(approval);
    const current = this.read(approval.workspaceId);
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== expectedRevision) {
      throw new WorkspacePlaytestApprovalConflictError(
        expectedRevision,
        actualRevision
      );
    }
    if (current !== null && current.revokedAt === null) {
      throw new WorkspacePlaytestApprovalConflictError(
        expectedRevision,
        actualRevision
      );
    }
    const next: WorkspacePlaytestApproval = {
      ...approval,
      revision: (actualRevision ?? 0) + 1
    };
    assertWorkspacePlaytestApproval(next);
    this.write(next);
    return next;
  }

  revoke(
    workspaceId: string,
    approvalId: string,
    expectedRevision: number,
    revokedAt: string,
    revokedBy: string,
    revocationReason: string
  ): WorkspacePlaytestApproval {
    assertWorkspaceId(workspaceId);
    const current = this.read(workspaceId);
    if (current === null || current.approvalId !== approvalId) {
      throw new WorkspacePlaytestApprovalConflictError(expectedRevision, null);
    }
    if (current.revision !== expectedRevision || current.revokedAt !== null) {
      throw new WorkspacePlaytestApprovalConflictError(
        expectedRevision,
        current.revision
      );
    }
    if (!Number.isFinite(Date.parse(revokedAt))) {
      throw new TypeError("Approval revocation timestamp is invalid.");
    }
    const next: WorkspacePlaytestApproval = {
      ...current,
      revision: current.revision + 1,
      revokedAt,
      revokedBy,
      revocationReason
    };
    assertWorkspacePlaytestApproval(next);
    this.write(next);
    return next;
  }

  private workspaceDirectory(
    workspaceId: string,
    create: boolean
  ): string | null {
    const directory = path.join(this.root, workspaceKey(workspaceId));
    if (!existsSync(directory) && !create) return null;
    ensurePrivateDirectory(directory, this.root);
    return directory;
  }

  private write(approval: WorkspacePlaytestApproval): void {
    const directory = this.workspaceDirectory(approval.workspaceId, true)!;
    const destination = path.join(directory, "approval.json");
    const temp = `${destination}${TEMP_MARKER}${randomBytes(8).toString("hex")}`;
    try {
      writeFileSync(temp, JSON.stringify(approval) + "\n", {
        encoding: "utf8",
        mode: OWNER_FILE_MODE,
        flag: "wx"
      });
      chmodSync(temp, OWNER_FILE_MODE);
      renameSync(temp, destination);
      chmodSync(destination, OWNER_FILE_MODE);
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // Preserve the original storage error.
      }
      throw new WorkspacePlaytestApprovalStoreError(
        "Workspace approval could not be written atomically.",
        error
      );
    }
  }
}
