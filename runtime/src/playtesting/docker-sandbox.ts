import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const IMAGE_DIGEST_PATTERN =
  /^(?:[a-z\d][a-z\d._/:\-]*@)?sha256:[a-f\d]{64}$/iu;
const RUN_ID_PATTERN = /^[A-Za-z\d][A-Za-z\d._:-]{0,127}$/u;
const MAX_CPU_CORES = 16;
const MIN_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_MEMORY_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_PROCESS_COUNT = 1024;
const MAX_WALL_TIME_MS = 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_TEMP = "/tmp";
const CONTAINER_ARTIFACTS = "/artifacts";
const SANDBOX_UID = 65_532;
const SANDBOX_GID = 65_532;

export interface PlaytestSandboxLimits {
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly processCount: number;
  readonly wallTimeMs: number;
  readonly artifactBytes: number;
}

/**
 * Operator-owned, immutable execution approval. Model-controlled run requests
 * can select a scenario/seed/policy but can never supply or change these fields.
 */
export interface PlaytestSandboxApproval {
  readonly workspaceId: string;
  readonly checkoutRoot: string;
  readonly buildSha: string;
  readonly imageDigest: string;
  readonly workingDirectory: string;
  readonly adapterCommand: readonly string[];
  readonly approvedCommand: readonly string[];
  readonly limits: PlaytestSandboxLimits;
}

export interface PreparedPlaytestSandbox {
  readonly workspaceId: string;
  readonly checkoutRoot: string;
  readonly checkoutSha: string;
  readonly imageDigest: string;
  readonly workingDirectory: string;
  readonly command: readonly string[];
  readonly limits: PlaytestSandboxLimits;
}

export class PlaytestSandboxApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestSandboxApprovalError";
  }
}

export class PlaytestSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestSandboxUnavailableError";
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function validateLimits(limits: PlaytestSandboxLimits): void {
  if (
    !Number.isFinite(limits.cpuCores) ||
    limits.cpuCores <= 0 ||
    limits.cpuCores > MAX_CPU_CORES
  ) {
    throw new PlaytestSandboxApprovalError(
      "CPU quota is outside the supported range."
    );
  }
  if (
    !Number.isSafeInteger(limits.memoryBytes) ||
    limits.memoryBytes < MIN_MEMORY_BYTES ||
    limits.memoryBytes > MAX_MEMORY_BYTES
  ) {
    throw new PlaytestSandboxApprovalError(
      "Memory quota is outside the supported range."
    );
  }
  if (
    !Number.isSafeInteger(limits.processCount) ||
    limits.processCount < 1 ||
    limits.processCount > MAX_PROCESS_COUNT
  ) {
    throw new PlaytestSandboxApprovalError(
      "Process quota is outside the supported range."
    );
  }
  if (
    !Number.isSafeInteger(limits.wallTimeMs) ||
    limits.wallTimeMs < 1_000 ||
    limits.wallTimeMs > MAX_WALL_TIME_MS
  ) {
    throw new PlaytestSandboxApprovalError(
      "Wall-time quota is outside the supported range."
    );
  }
  if (
    !Number.isSafeInteger(limits.artifactBytes) ||
    limits.artifactBytes < 1_024 ||
    limits.artifactBytes > MAX_ARTIFACT_BYTES
  ) {
    throw new PlaytestSandboxApprovalError(
      "Artifact quota is outside the supported range."
    );
  }
}

function validateCommand(command: readonly string[]): void {
  if (
    command.length < 1 ||
    command.length > 128 ||
    command.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length < 1 ||
        argument.length > 4_096 ||
        argument.includes("\0")
    )
  ) {
    throw new PlaytestSandboxApprovalError(
      "Adapter command is invalid or too large."
    );
  }
}

function resolveApprovedCheckout(approval: PlaytestSandboxApproval): {
  readonly root: string;
  readonly workingDirectory: string;
  readonly sha: string;
} {
  if (!SHA_PATTERN.test(approval.buildSha)) {
    throw new PlaytestSandboxApprovalError("Approved build SHA is invalid.");
  }
  if (!IMAGE_DIGEST_PATTERN.test(approval.imageDigest)) {
    throw new PlaytestSandboxApprovalError(
      "Approved adapter image must be pinned by sha256 digest."
    );
  }
  if (!approval.checkoutRoot || !path.isAbsolute(approval.checkoutRoot)) {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout root must be absolute."
    );
  }
  const root = realpathSync(approval.checkoutRoot);
  if (!statSync(root).isDirectory()) {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout is not a directory."
    );
  }
  // The Docker --mount argument is a CSV-like field list. Failing closed on a
  // comma avoids a path being parsed as an additional mount option.
  if (root.includes(",")) {
    throw new PlaytestSandboxApprovalError(
      "Checkout paths containing commas are unsupported."
    );
  }
  if (
    !approval.workingDirectory ||
    path.isAbsolute(approval.workingDirectory) ||
    approval.workingDirectory.split(/[\\/]/u).some((part) => part === "..")
  ) {
    throw new PlaytestSandboxApprovalError(
      "Working directory must stay inside the approved checkout."
    );
  }
  const candidate = path.resolve(root, approval.workingDirectory);
  const workingDirectory = realpathSync(candidate);
  if (
    !isWithin(root, workingDirectory) ||
    !statSync(workingDirectory).isDirectory()
  ) {
    throw new PlaytestSandboxApprovalError(
      "Working directory escapes the approved checkout."
    );
  }
  const command = approval.adapterCommand;
  validateCommand(command);
  validateCommand(approval.approvedCommand);
  if (
    command.length !== approval.approvedCommand.length ||
    command.some(
      (argument, index) => argument !== approval.approvedCommand[index]
    )
  ) {
    throw new PlaytestSandboxApprovalError(
      "Game adapter command differs from the operator-approved command."
    );
  }
  validateLimits(approval.limits);

  let sha: string;
  let status: string;
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3_000
    }).trim();
    status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
        maxBuffer: 256 * 1024
      }
    );
  } catch {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout is not a readable Git working tree."
    );
  }
  if (
    !SHA_PATTERN.test(sha) ||
    sha.toLowerCase() !== approval.buildSha.toLowerCase()
  ) {
    throw new PlaytestSandboxApprovalError(
      "Checkout HEAD no longer matches the approved build SHA."
    );
  }
  if (status !== "") {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout has modified or untracked files."
    );
  }
  return { root, workingDirectory, sha };
}

/** Validate the approval and bind it to the exact clean checkout that will run. */
export function preparePlaytestSandbox(
  approval: PlaytestSandboxApproval
): PreparedPlaytestSandbox {
  if (
    !approval.workspaceId ||
    !/^[^/\s]+\/[^/\s]+$/u.test(approval.workspaceId)
  ) {
    throw new PlaytestSandboxApprovalError(
      "A canonical workspace identity is required."
    );
  }
  const checkout = resolveApprovedCheckout(approval);
  return {
    workspaceId: approval.workspaceId,
    checkoutRoot: checkout.root,
    checkoutSha: checkout.sha,
    imageDigest: approval.imageDigest,
    workingDirectory: checkout.workingDirectory,
    command: [...approval.approvedCommand],
    limits: { ...approval.limits }
  };
}

/** Resolve only a local Docker Engine socket; remote Docker contexts are rejected. */
export function localDockerSocket(
  platform: NodeJS.Platform = process.platform,
  home = homedir()
): string {
  if (platform === "darwin")
    return path.join(home, ".docker", "run", "docker.sock");
  if (platform === "linux") return "/var/run/docker.sock";
  throw new PlaytestSandboxUnavailableError(
    "Playtesting requires a local Docker-compatible Engine on macOS or Linux."
  );
}

/** Build argv without a shell; no workspace-supplied value is interpolated into a command string. */
export function buildDockerRunArguments(
  request: PreparedPlaytestSandbox,
  runId: string,
  dockerConfigDirectory: string,
  socket = localDockerSocket()
): string[] {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new PlaytestSandboxApprovalError("Run ID is invalid.");
  }
  if (
    !path.isAbsolute(dockerConfigDirectory) ||
    dockerConfigDirectory.includes(",")
  ) {
    throw new PlaytestSandboxApprovalError(
      "Isolated Docker config directory must be an absolute path."
    );
  }
  accessSync(socket, constants.R_OK | constants.W_OK);
  if (!statSync(socket).isSocket()) {
    throw new PlaytestSandboxUnavailableError(
      "Local Docker Engine socket is unavailable."
    );
  }
  const containerName = `autodev-playtest-${createHash("sha256")
    .update(runId)
    .digest("hex")
    .slice(0, 24)}`;
  const workingDirectory = `${CONTAINER_WORKSPACE}${path.posix.sep}${path
    .relative(request.checkoutRoot, request.workingDirectory)
    .split(path.sep)
    .join(path.posix.sep)}`;
  const artifactTmpfs = [
    "rw",
    "noexec",
    "nosuid",
    "nodev",
    `size=${request.limits.artifactBytes}`,
    `uid=${SANDBOX_UID}`,
    `gid=${SANDBOX_GID}`,
    "mode=0700"
  ].join(",");
  const tempTmpfs = [
    "rw",
    "noexec",
    "nosuid",
    "nodev",
    "size=16777216",
    `uid=${SANDBOX_UID}`,
    `gid=${SANDBOX_GID}`,
    "mode=0700"
  ].join(",");
  return [
    "--host",
    `unix://${socket}`,
    "--config",
    dockerConfigDirectory,
    "run",
    "--interactive",
    "--name",
    containerName,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--memory",
    String(request.limits.memoryBytes),
    "--memory-swap",
    String(request.limits.memoryBytes),
    "--cpus",
    String(request.limits.cpuCores),
    "--pids-limit",
    String(request.limits.processCount),
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    `${SANDBOX_UID}:${SANDBOX_GID}`,
    "--log-driver=none",
    "--stop-timeout=2",
    "--mount",
    `type=bind,source=${request.checkoutRoot},target=${CONTAINER_WORKSPACE},readonly`,
    "--tmpfs",
    `${CONTAINER_TEMP}:${tempTmpfs}`,
    "--tmpfs",
    `${CONTAINER_ARTIFACTS}:${artifactTmpfs}`,
    "--workdir",
    workingDirectory,
    "--env",
    "HOME=/tmp",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "TZ=UTC",
    "--entrypoint",
    request.command[0]!,
    request.imageDigest,
    ...request.command.slice(1)
  ];
}

/** Confirm that the socket path exists and is an active local Docker endpoint. */
export function assertLocalDockerAvailable(
  socket = localDockerSocket(),
  fileSystem = { accessSync, statSync }
): void {
  try {
    fileSystem.accessSync(socket, constants.R_OK | constants.W_OK);
    if (!fileSystem.statSync(socket).isSocket()) {
      throw new Error("not a socket");
    }
  } catch {
    throw new PlaytestSandboxUnavailableError(
      "Local Docker Engine is unavailable; adapter execution is disabled."
    );
  }
}
