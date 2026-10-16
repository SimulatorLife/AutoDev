import {
  type ChildProcess,
  execFileSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  spawn,
  type SpawnOptions
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  type PlaytestArtifactReference,
  type PlaytestMetricRegistry,
  PLAYTESTS_ADAPTER_CONTAINER_WORKSPACE,
  type WorkspacePlaytestApproval,
  type WorkspacePlaytestBuild
} from "@simulatorlife/autodev-core";

import type {
  PlaytestAdapterExit,
  PlaytestAdapterStreams
} from "./adapter-client.ts";
import {
  type ApprovedPlaytestDefinition,
  loadApprovedPlaytestDefinition
} from "./approved-configuration.ts";

const SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const SHA256_PATTERN = /^[a-f\d]{64}$/iu;
const RUN_ID_PATTERN = /^[A-Za-z\d][A-Za-z\d._:-]{0,127}$/u;
const PATH_SEPARATOR_PATTERN = /[\\/]/u;
const LINE_SPLIT_PATTERN = /\r?\n/u;
const CONTAINER_WORKSPACE = PLAYTESTS_ADAPTER_CONTAINER_WORKSPACE;
const CONTAINER_TEMP = "/tmp";
const CONTAINER_ARTIFACTS = "/artifacts";
const CONTAINER_INPUT_ARTIFACTS = "/run/autodev-playtest-input";
const SANDBOX_UID = 65_532;
const SANDBOX_GID = 65_532;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_FILES = 1024;
const MAX_TAIL_LINES = 64;
const MAX_TAIL_CHARS_PER_LINE = 4096;
const KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const ARTIFACT_ERROR_CATEGORY: PlaytestSandboxErrorCategory = "artifact-error";
const DOCKER_COMMAND_TIMEOUT_MS = 10_000;

const DEFAULT_FILE_SYSTEM = { accessSync, statSync };

export interface PreparedPlaytestSandbox {
  readonly workspaceId: string;
  /** The operator's approved checkout the build was resolved from. */
  readonly sourceCheckoutRoot: string;
  /** Runtime-owned, read-only snapshot of exactly `build.buildSha`; the sandbox mounts this. */
  readonly checkoutRoot: string;
  /** The committed build resolved at preparation; game build is supplied to the adapter. */
  readonly build: WorkspacePlaytestBuild;
  readonly imageDigest: string;
  readonly workingDirectory: string;
  readonly command: readonly string[];
  readonly limits: WorkspacePlaytestApproval["limits"];
  readonly configuration: ApprovedPlaytestDefinition["configuration"];
  readonly observationContract: ApprovedPlaytestDefinition["observationContract"];
  readonly rubric: PlaytestMetricRegistry;
  readonly benchmark: ApprovedPlaytestDefinition["benchmark"];
  readonly benchmarkHash: ApprovedPlaytestDefinition["benchmarkHash"];
  readonly rubricHash: string;
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

export type PlaytestSandboxErrorCategory =
  | "docker-unavailable"
  | "image-unavailable"
  | "timeout"
  | "cancelled"
  | "process-error"
  | "exit-code"
  | "output-limit"
  | "artifact-error"
  | "approval-revoked";

export interface StagedPlaytestArtifact {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly size: number;
}

export interface PlaytestSandboxResult {
  readonly runId: string;
  readonly containerName: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly stdoutTail: readonly string[];
  readonly stderrTail: readonly string[];
  readonly stagingDirectory: string | null;
  readonly artifacts: readonly StagedPlaytestArtifact[];
}

export class PlaytestSandboxExecutionError extends Error {
  readonly category: PlaytestSandboxErrorCategory;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTail: readonly string[];
  readonly stderrTail: readonly string[];
  readonly partialArtifacts?: readonly StagedPlaytestArtifact[];

  constructor(
    message: string,
    options: {
      readonly category: PlaytestSandboxErrorCategory;
      readonly exitCode?: number | null;
      readonly signal?: NodeJS.Signals | null;
      readonly stdoutTail?: readonly string[];
      readonly stderrTail?: readonly string[];
      readonly partialArtifacts?: readonly StagedPlaytestArtifact[];
    }
  ) {
    super(message);
    this.name = "PlaytestSandboxExecutionError";
    this.category = options.category;
    this.exitCode = options.exitCode ?? null;
    this.signal = options.signal ?? null;
    this.stdoutTail = options.stdoutTail ?? [];
    this.stderrTail = options.stderrTail ?? [];
    if (options.partialArtifacts !== undefined) {
      this.partialArtifacts = options.partialArtifacts;
    }
  }
}

export type PlaytestSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;
export type PlaytestSpawnFunction = PlaytestSpawnFn;

export type PlaytestExecFileFn = (
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptionsWithStringEncoding | ExecFileSyncOptions
) => string | Buffer;
export type PlaytestExecFileFunction = PlaytestExecFileFn;

export interface PlaytestSandboxHandle extends PlaytestAdapterStreams {
  readonly runId: string;
  readonly containerName: string;
  readonly streams: PlaytestAdapterStreams;
  readonly cancel: (reason?: string) => Promise<void>;
  readonly result: Promise<PlaytestSandboxResult>;
  readonly cleanup: () => Promise<void>;
}

export interface PlaytestSandboxInputArtifact {
  readonly reference: PlaytestArtifactReference;
  readonly bytes: Uint8Array;
}

export interface PlaytestSandboxLaunchOptions {
  /** Verified Runtime bytes, mounted by SHA-256 filename as read-only input. */
  readonly inputArtifacts?: readonly PlaytestSandboxInputArtifact[];
  readonly runId?: string;
  readonly socket?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly maxArtifactFiles?: number;
  readonly maxArtifactBytes?: number;
  readonly spawn?: PlaytestSpawnFn;
  readonly execFile?: PlaytestExecFileFn;
  readonly inspectImage?: (
    imageDigest: string,
    socket: string,
    configDir: string
  ) => Promise<boolean> | boolean;
  readonly now?: () => number;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

const GIT_COMMAND_TIMEOUT_MS = 10_000;
const SNAPSHOT_COMMAND_TIMEOUT_MS = 180_000;
/**
 * Snapshots unused for longer than this are pruned. It exceeds the largest
 * approvable wall time, and every prepare/launch refreshes its snapshot's mtime.
 */
const SNAPSHOT_RETENTION_MS = 2 * 60 * 60 * 1000;
const SNAPSHOT_PARTIAL_MARKER = ".partial-";

/** Runtime-owned root for read-only committed-build snapshots. */
export function defaultPlaytestSnapshotRoot(): string {
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
  return path.join(codexHome, "playtesting", "snapshots");
}

export interface PlaytestSandboxPrepareOptions {
  /** Root for committed-build snapshots; defaults to {@link defaultPlaytestSnapshotRoot}. */
  readonly snapshotRoot?: string;
  readonly now?: () => number;
}

function runGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout = GIT_COMMAND_TIMEOUT_MS
): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 1024 * 1024
  }).trim();
}

/** The approved checkout's latest committed build; uncommitted edits are never run. */
function resolveCommittedHead(root: string): string {
  let sha: string;
  try {
    sha = runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout is not a readable Git repository with a commit."
    );
  }
  if (!SHA_PATTERN.test(sha)) {
    throw new PlaytestSandboxApprovalError(
      "Checkout HEAD is not a valid Git SHA."
    );
  }
  return sha.toLowerCase();
}

function ensureOwnerDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PlaytestSandboxApprovalError(
      "Playtest snapshot directories must be real directories."
    );
  }
}

/**
 * Check out exactly one commit into a Runtime-owned directory through a
 * temporary index, so the operator's index and working tree are untouched
 * and in-progress edits cannot leak into the build.
 */
function checkoutCommit(
  sourceRoot: string,
  sha: string,
  destination: string
): void {
  const indexFile = destination + ".index";
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    runGit(sourceRoot, ["read-tree", sha], env, SNAPSHOT_COMMAND_TIMEOUT_MS);
    runGit(
      sourceRoot,
      ["checkout-index", "--all", "--force", "--prefix=" + destination + "/"],
      env,
      SNAPSHOT_COMMAND_TIMEOUT_MS
    );
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function pruneStaleSnapshots(
  workspaceDirectory: string,
  keep: string,
  now: number
): void {
  for (const entry of readdirSync(workspaceDirectory)) {
    if (entry === keep) continue;
    const candidate = path.join(workspaceDirectory, entry);
    try {
      if (now - lstatSync(candidate).mtimeMs > SNAPSHOT_RETENTION_MS) {
        rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // A concurrent prune or materialization owns this entry.
    }
  }
}

/** Refresh a snapshot's last-use time so retention never prunes it mid-batch. */
function touchSnapshot(snapshotRoot: string, now: number): void {
  const time = new Date(now);
  utimesSync(snapshotRoot, time, time);
}

/** Materialize (or reuse) the immutable snapshot of one committed build. */
function materializeCommitSnapshot(input: {
  readonly workspaceId: string;
  readonly sourceRoot: string;
  readonly sha: string;
  readonly snapshotRoot: string;
  readonly now: number;
}): string {
  const root = path.resolve(input.snapshotRoot);
  ensureOwnerDirectory(root);
  const workspaceDirectory = path.join(
    realpathSync(root),
    createHash("sha256").update(input.workspaceId).digest("hex").slice(0, 32)
  );
  ensureOwnerDirectory(workspaceDirectory);
  const destination = path.join(workspaceDirectory, input.sha);
  if (!existsSync(destination)) {
    const partial =
      destination + SNAPSHOT_PARTIAL_MARKER + randomUUID().slice(0, 8);
    try {
      mkdirSync(partial, { mode: 0o700 });
      checkoutCommit(input.sourceRoot, input.sha, partial);
      renameSync(partial, destination);
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      // Another prepare published the same commit first; its snapshot is identical.
      if (!existsSync(destination)) {
        throw new PlaytestSandboxApprovalError(
          "The approved checkout's latest commit could not be snapshotted: " +
            (error instanceof Error ? error.message : String(error))
        );
      }
    }
  }
  touchSnapshot(destination, input.now);
  pruneStaleSnapshots(workspaceDirectory, input.sha, input.now);
  return destination;
}

/**
 * The paths a sandbox mounts are the Runtime's snapshot of the latest commit;
 * the approved working directory is resolved inside that snapshot.
 */
function resolveCommittedBuildCheckout(
  approval: WorkspacePlaytestApproval,
  options: PlaytestSandboxPrepareOptions
): {
  readonly sourceRoot: string;
  readonly root: string;
  readonly workingDirectory: string;
  readonly sha: string;
} {
  const sourceRoot = realpathSync(approval.checkoutRoot);
  if (sourceRoot !== path.resolve(approval.checkoutRoot)) {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout root is not the canonical real path."
    );
  }
  if (!statSync(sourceRoot).isDirectory()) {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout is not a directory."
    );
  }
  if (
    !approval.workingDirectory ||
    path.isAbsolute(approval.workingDirectory) ||
    approval.workingDirectory.split(PATH_SEPARATOR_PATTERN).includes("..")
  ) {
    throw new PlaytestSandboxApprovalError(
      "Working directory must stay inside the approved checkout."
    );
  }
  const sha = resolveCommittedHead(sourceRoot);
  const root = materializeCommitSnapshot({
    workspaceId: approval.workspaceId,
    sourceRoot,
    sha,
    snapshotRoot: options.snapshotRoot ?? defaultPlaytestSnapshotRoot(),
    now: (options.now ?? Date.now)()
  });
  // Docker's --mount argument is CSV-like; a comma could add a mount option.
  if (root.includes(",")) {
    throw new PlaytestSandboxApprovalError(
      "Snapshot paths containing commas are unsupported."
    );
  }
  let workingDirectory: string;
  try {
    workingDirectory = realpathSync(
      path.resolve(root, approval.workingDirectory)
    );
  } catch {
    throw new PlaytestSandboxApprovalError(
      "The approved working directory does not exist in the latest commit."
    );
  }
  if (
    !isWithin(root, workingDirectory) ||
    !statSync(workingDirectory).isDirectory()
  ) {
    throw new PlaytestSandboxApprovalError(
      "Working directory escapes the approved checkout."
    );
  }
  return { sourceRoot, root, workingDirectory, sha };
}

/**
 * Resolve the approved checkout's latest committed build, snapshot it, and
 * load that commit's own target configuration. Each batch therefore runs
 * whatever is committed at its start, with no per-commit approval.
 */
export function preparePlaytestSandbox(
  approval: WorkspacePlaytestApproval,
  options: PlaytestSandboxPrepareOptions = {}
): PreparedPlaytestSandbox {
  const checkout = resolveCommittedBuildCheckout(approval, options);
  const definition = loadApprovedPlaytestDefinition(approval, checkout.root);
  const { configuration } = definition;
  return {
    workspaceId: approval.workspaceId,
    sourceCheckoutRoot: checkout.sourceRoot,
    checkoutRoot: checkout.root,
    build: {
      buildSha: checkout.sha,
      gameBuild: checkout.sha,
      configHash: definition.configHash
    },
    imageDigest: approval.adapterImageDigest,
    workingDirectory: checkout.workingDirectory,
    command: [...configuration.adapter.command],
    limits: { ...approval.limits },
    configuration,
    observationContract: definition.observationContract,
    rubric: definition.rubric,
    benchmark: definition.benchmark,
    benchmarkHash: definition.benchmarkHash,
    rubricHash: definition.rubricHash
  };
}

/** Resolve only a local Docker Engine socket; remote Docker contexts are rejected. */
export function localDockerSocket(
  platform: NodeJS.Platform = process.platform,
  home = homedir()
): string {
  if (platform === "darwin") {
    const userSocket = path.join(home, ".docker", "run", "docker.sock");
    if (
      home === homedir() &&
      !existsSync(userSocket) &&
      existsSync("/var/run/docker.sock")
    ) {
      return "/var/run/docker.sock";
    }
    return userSocket;
  }
  if (platform === "linux") {
    return "/var/run/docker.sock";
  }
  throw new PlaytestSandboxUnavailableError(
    "Playtesting requires a local Docker-compatible Engine on macOS or Linux."
  );
}

/** Derive unique bounded Docker container name from runId. */
export function getPlaytestContainerName(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new PlaytestSandboxApprovalError("Run ID is invalid.");
  }
  return `autodev-playtest-${createHash("sha256")
    .update(runId)
    .digest("hex")
    .slice(0, 24)}`;
}

/** Create an isolated empty Docker configuration directory. */
export function createIsolatedDockerConfig(): {
  readonly configDirectory: string;
  readonly cleanup: () => void;
} {
  const configDirectory = mkdtempSync(
    path.join(tmpdir(), "autodev-docker-config-")
  );
  chmodSync(configDirectory, 0o700);
  const configFile = path.join(configDirectory, "config.json");
  writeFileSync(configFile, "{}", { mode: 0o600 });
  return {
    configDirectory,
    cleanup: () => {
      try {
        rmSync(configDirectory, { recursive: true, force: true });
      } catch {
        // ignore errors on cleanup
      }
    }
  };
}

/** Produce a sanitized minimal host environment for Docker CLI invocations. */
export function getSanitizedHostEnvironment(
  dockerConfigDirectory: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: baseEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: dockerConfigDirectory,
    DOCKER_CONFIG: dockerConfigDirectory,
    TMPDIR: tmpdir()
  };
  if (baseEnv.SYSTEMROOT) {
    safeEnv.SYSTEMROOT = baseEnv.SYSTEMROOT;
  }
  return safeEnv;
}

/** Confirm that the socket path exists and is an active local Docker endpoint. */
export function assertLocalDockerAvailable(
  socket = localDockerSocket(),
  fileSystem = DEFAULT_FILE_SYSTEM
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

/** Verify that the immutable approved image is present locally without pulling. */
export function verifyLocalDockerImage(
  imageDigest: string,
  socket: string,
  dockerConfigDirectory: string,
  execFileFn: PlaytestExecFileFn = execFileSync as unknown as PlaytestExecFileFn
): void {
  try {
    const output = execFileFn(
      "docker",
      [
        "--host",
        `unix://${socket}`,
        "--config",
        dockerConfigDirectory,
        "image",
        "inspect",
        imageDigest
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000
      }
    );
    const strOutput =
      typeof output === "string" ? output : output.toString("utf8");
    const parsed = JSON.parse(strOutput);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Empty image inspect result");
    }
  } catch (error) {
    throw new PlaytestSandboxUnavailableError(
      `Approved adapter image ${imageDigest} is not locally available without pulling: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Build argv without a shell; no workspace-supplied value is interpolated into a command string. */
export function buildDockerRunArguments(
  request: PreparedPlaytestSandbox,
  runId: string,
  dockerConfigDirectory: string,
  socket = localDockerSocket(),
  inputArtifactDirectory?: string,
  outputArtifactBytes = request.limits.artifactBytes
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
  const containerName = getPlaytestContainerName(runId);
  if (
    !Number.isSafeInteger(outputArtifactBytes) ||
    outputArtifactBytes < 1 ||
    outputArtifactBytes > request.limits.artifactBytes
  ) {
    throw new PlaytestSandboxApprovalError(
      "Sandbox output artifact quota exceeds the approved byte budget."
    );
  }
  if (
    inputArtifactDirectory !== undefined &&
    (!path.isAbsolute(inputArtifactDirectory) ||
      inputArtifactDirectory.includes(",") ||
      lstatSync(inputArtifactDirectory).isSymbolicLink() ||
      !lstatSync(inputArtifactDirectory).isDirectory())
  ) {
    throw new PlaytestSandboxApprovalError(
      "Playtest input artifact directory must be an existing absolute directory without commas."
    );
  }
  const workingDirectory = `${CONTAINER_WORKSPACE}${path.posix.sep}${path
    .relative(request.checkoutRoot, request.workingDirectory)
    .split(path.sep)
    .join(path.posix.sep)}`;
  const artifactTmpfs = [
    "rw",
    "noexec",
    "nosuid",
    "nodev",
    `size=${outputArtifactBytes}`,
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
    ...(inputArtifactDirectory === undefined
      ? []
      : [
          "--mount",
          `type=bind,source=${inputArtifactDirectory},target=${CONTAINER_INPUT_ARTIFACTS},readonly`
        ]),
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
    "--env",
    "AUTODEV_PLAYTEST_ENGINE_BUILD=" + request.build.gameBuild,
    "--env",
    "AUTODEV_PLAYTEST_OUTPUT_DIR=" + CONTAINER_ARTIFACTS,
    ...(inputArtifactDirectory === undefined
      ? []
      : ["--env", "AUTODEV_PLAYTEST_INPUT_DIR=" + CONTAINER_INPUT_ARTIFACTS]),
    "--entrypoint",
    request.command[0]!,
    request.imageDigest,
    ...request.command.slice(1)
  ];
}

function stageInputArtifacts(
  artifacts: readonly PlaytestSandboxInputArtifact[] | undefined,
  maximumBytes: number
): { readonly directory: string | null; readonly bytes: number } {
  if (!artifacts || artifacts.length === 0)
    return { directory: null, bytes: 0 };
  if (artifacts.length > DEFAULT_MAX_ARTIFACT_FILES) {
    throw new PlaytestSandboxApprovalError(
      "Playtest input artifact count exceeds the sandbox limit."
    );
  }
  const directory = mkdtempSync(path.join(tmpdir(), "autodev-playtest-input-"));
  chmodSync(directory, 0o700);
  let totalBytes = 0;
  const seen = new Set<string>();
  try {
    for (const { reference, bytes } of artifacts) {
      if (
        !SHA256_PATTERN.test(reference.sha256) ||
        !Number.isSafeInteger(reference.bytes) ||
        reference.bytes < 1 ||
        bytes.byteLength !== reference.bytes ||
        createHash("sha256").update(bytes).digest("hex") !==
          reference.sha256.toLowerCase()
      ) {
        throw new PlaytestSandboxApprovalError(
          "Playtest input artifact bytes do not match their content-addressed reference."
        );
      }
      const sha = reference.sha256.toLowerCase();
      if (seen.has(sha)) continue;
      totalBytes += bytes.byteLength;
      if (totalBytes > maximumBytes) {
        throw new PlaytestSandboxApprovalError(
          "Playtest input artifacts exceed the approved artifact-byte budget."
        );
      }
      seen.add(sha);
      writeFileSync(path.join(directory, sha), bytes, {
        flag: "wx",
        mode: 0o400
      });
    }
    return { directory, bytes: totalBytes };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Read one staged adapter artifact only after rechecking its path, size and SHA. */
export function readStagedPlaytestArtifact(
  reference: PlaytestArtifactReference,
  stagingDirectory: string | null,
  artifacts: readonly StagedPlaytestArtifact[]
): Uint8Array {
  if (
    stagingDirectory === null ||
    !SHA256_PATTERN.test(reference.sha256) ||
    !Number.isSafeInteger(reference.bytes) ||
    reference.bytes < 1
  ) {
    throw new PlaytestSandboxExecutionError(
      "The adapter artifact reference has no bounded staged source.",
      { category: ARTIFACT_ERROR_CATEGORY }
    );
  }
  const root = realpathSync(stagingDirectory);
  for (const artifact of artifacts) {
    if (
      artifact.size !== reference.bytes ||
      artifact.relativePath !== reference.sha256.toLowerCase()
    ) {
      continue;
    }
    const candidate = path.resolve(root, artifact.relativePath);
    let realArtifactPath: string;
    try {
      realArtifactPath = realpathSync(artifact.absolutePath);
    } catch {
      continue;
    }
    if (!isWithin(root, candidate) || realArtifactPath !== candidate) {
      throw new PlaytestSandboxExecutionError(
        "The staged adapter artifact escaped its private output directory.",
        { category: ARTIFACT_ERROR_CATEGORY }
      );
    }
    let current = root;
    const relative = path.relative(root, candidate);
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) {
        throw new PlaytestSandboxExecutionError(
          "The staged adapter artifact path contains a symbolic link.",
          { category: ARTIFACT_ERROR_CATEGORY }
        );
      }
      if (current === candidate && !metadata.isFile()) {
        throw new PlaytestSandboxExecutionError(
          "The staged adapter artifact is not a regular file.",
          { category: ARTIFACT_ERROR_CATEGORY }
        );
      }
    }
    const content = readFileSync(candidate);
    if (
      content.byteLength === reference.bytes &&
      createHash("sha256").update(content).digest("hex") ===
        reference.sha256.toLowerCase()
    ) {
      return new Uint8Array(
        content.buffer,
        content.byteOffset,
        content.byteLength
      );
    }
  }
  throw new PlaytestSandboxExecutionError(
    "The adapter did not stage bytes matching its artifact reference.",
    { category: ARTIFACT_ERROR_CATEGORY }
  );
}

/** Recursively scan mode-0700 staging directory, enforcing quotas and rejecting symlinks/special files. */
export function scanAndValidateStagingDirectory(
  stagingDirectory: string,
  maxBytes: number,
  maxFiles: number = DEFAULT_MAX_ARTIFACT_FILES
): StagedPlaytestArtifact[] {
  const artifacts: StagedPlaytestArtifact[] = [];
  let totalBytes = 0;
  let totalFiles = 0;

  chmodSync(stagingDirectory, 0o700);

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const stat = lstatSync(fullPath);

      if (stat.isSymbolicLink()) {
        throw new PlaytestSandboxExecutionError(
          `Artifact staging directory contains forbidden symbolic link: ${path.relative(stagingDirectory, fullPath)}`,
          { category: ARTIFACT_ERROR_CATEGORY }
        );
      }

      if (stat.isDirectory()) {
        chmodSync(fullPath, 0o700);
        walk(fullPath);
      } else if (stat.isFile()) {
        chmodSync(fullPath, 0o600);
        totalFiles += 1;
        if (totalFiles > maxFiles) {
          throw new PlaytestSandboxExecutionError(
            `Artifact file count exceeded limit (${maxFiles}).`,
            { category: ARTIFACT_ERROR_CATEGORY }
          );
        }
        totalBytes += stat.size;
        if (totalBytes > maxBytes) {
          throw new PlaytestSandboxExecutionError(
            `Artifact total bytes (${totalBytes}) exceeded limit (${maxBytes}).`,
            { category: ARTIFACT_ERROR_CATEGORY }
          );
        }
        artifacts.push({
          relativePath: path.relative(stagingDirectory, fullPath),
          absolutePath: fullPath,
          size: stat.size
        });
      } else {
        throw new PlaytestSandboxExecutionError(
          `Artifact staging directory contains forbidden special file: ${path.relative(stagingDirectory, fullPath)}`,
          { category: ARTIFACT_ERROR_CATEGORY }
        );
      }
    }
  }

  walk(stagingDirectory);
  return artifacts;
}

function appendTailLines(tail: string[], chunk: Buffer | string): void {
  const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const lines = str.split(LINE_SPLIT_PATTERN);
  for (const line of lines) {
    if (line.length > 0) {
      tail.push(line.slice(0, MAX_TAIL_CHARS_PER_LINE));
      if (tail.length > MAX_TAIL_LINES) {
        tail.shift();
      }
    }
  }
}

interface StagedArtifactsResult {
  readonly stagingDirectory: string | null;
  readonly stagedArtifacts: readonly StagedPlaytestArtifact[];
  readonly artifactError: PlaytestSandboxExecutionError | null;
}

function stageContainerArtifacts(
  socket: string,
  configDirectory: string,
  containerName: string,
  maxArtifactBytes: number,
  maxArtifactFiles: number,
  execFileFn: PlaytestExecFileFn
): StagedArtifactsResult {
  const stagingCandidate = mkdtempSync(
    path.join(tmpdir(), "autodev-playtest-staging-")
  );
  chmodSync(stagingCandidate, 0o700);

  try {
    execFileFn(
      "docker",
      [
        "--host",
        `unix://${socket}`,
        "--config",
        configDirectory,
        "cp",
        `${containerName}:${CONTAINER_ARTIFACTS}/.`,
        stagingCandidate
      ],
      { stdio: "pipe", timeout: DOCKER_COMMAND_TIMEOUT_MS }
    );
    const artifacts = scanAndValidateStagingDirectory(
      stagingCandidate,
      maxArtifactBytes,
      maxArtifactFiles
    );
    return {
      stagingDirectory: stagingCandidate,
      stagedArtifacts: artifacts,
      artifactError: null
    };
  } catch (error) {
    if (
      error instanceof PlaytestSandboxExecutionError &&
      error.category === ARTIFACT_ERROR_CATEGORY
    ) {
      try {
        rmSync(stagingCandidate, { recursive: true, force: true });
      } catch {
        // ignore removal errors
      }
      return {
        stagingDirectory: null,
        stagedArtifacts: [],
        artifactError: error
      };
    }
    try {
      const artifacts = scanAndValidateStagingDirectory(
        stagingCandidate,
        maxArtifactBytes,
        maxArtifactFiles
      );
      return {
        stagingDirectory: stagingCandidate,
        stagedArtifacts: artifacts,
        artifactError: null
      };
    } catch {
      return {
        stagingDirectory: stagingCandidate,
        stagedArtifacts: [],
        artifactError: null
      };
    }
  }
}

function determineSandboxFailure(options: {
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly outputLimitExceeded: boolean;
  readonly processError: Error | null;
  readonly artifactError: PlaytestSandboxExecutionError | null;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly wallTimeMs: number;
  readonly maxOutputBytes: number;
  readonly stdoutTail: readonly string[];
  readonly stderrTail: readonly string[];
  readonly stagedArtifacts: readonly StagedPlaytestArtifact[];
}): Error | null {
  if (options.timedOut) {
    return new PlaytestSandboxExecutionError(
      `Playtest sandbox wall time limit (${options.wallTimeMs} ms) exceeded.`,
      {
        category: "timeout",
        exitCode: options.code,
        signal: options.signal,
        stdoutTail: options.stdoutTail,
        stderrTail: options.stderrTail,
        partialArtifacts: options.stagedArtifacts
      }
    );
  }
  if (options.cancelled) {
    return new PlaytestSandboxExecutionError(
      "Playtest sandbox execution was cancelled.",
      {
        category: "cancelled",
        exitCode: options.code,
        signal: options.signal,
        stdoutTail: options.stdoutTail,
        stderrTail: options.stderrTail,
        partialArtifacts: options.stagedArtifacts
      }
    );
  }
  if (options.outputLimitExceeded) {
    return new PlaytestSandboxExecutionError(
      `Playtest sandbox exceeded maximum output limit (${options.maxOutputBytes} bytes).`,
      {
        category: "output-limit",
        exitCode: options.code,
        signal: options.signal,
        stdoutTail: options.stdoutTail,
        stderrTail: options.stderrTail,
        partialArtifacts: options.stagedArtifacts
      }
    );
  }
  if (options.processError) {
    return new PlaytestSandboxExecutionError(options.processError.message, {
      category: "process-error",
      exitCode: options.code,
      signal: options.signal,
      stdoutTail: options.stdoutTail,
      stderrTail: options.stderrTail,
      partialArtifacts: options.stagedArtifacts
    });
  }
  if (options.artifactError) {
    return options.artifactError;
  }
  if (options.code !== 0) {
    return new PlaytestSandboxExecutionError(
      `Playtest sandbox process exited with non-zero code ${options.code ?? "null"}.`,
      {
        category: "exit-code",
        exitCode: options.code,
        signal: options.signal,
        stdoutTail: options.stdoutTail,
        stderrTail: options.stderrTail,
        partialArtifacts: options.stagedArtifacts
      }
    );
  }
  return null;
}

interface StagedInputArtifacts {
  readonly directory: string | null;
  readonly bytes: number;
}

function cleanupStagedInput(input: StagedInputArtifacts): void {
  if (input.directory)
    rmSync(input.directory, { recursive: true, force: true });
}

function prepareStagedInput(
  prepared: PreparedPlaytestSandbox,
  options: PlaytestSandboxLaunchOptions | undefined,
  configCleanup: () => void
): { readonly staged: StagedInputArtifacts; readonly maxOutputBytes: number } {
  let staged: StagedInputArtifacts | undefined;
  try {
    staged = stageInputArtifacts(
      options?.inputArtifacts,
      prepared.limits.artifactBytes
    );
    const remaining = prepared.limits.artifactBytes - staged.bytes;
    if (remaining < 1) {
      throw new PlaytestSandboxApprovalError(
        "Branch input artifacts leave no room for bounded output evidence."
      );
    }
    return {
      staged,
      maxOutputBytes: Math.min(
        options?.maxArtifactBytes ?? prepared.limits.artifactBytes,
        remaining
      )
    };
  } catch (error) {
    if (staged) cleanupStagedInput(staged);
    configCleanup();
    throw error;
  }
}

async function verifyApprovedImage(
  prepared: PreparedPlaytestSandbox,
  socket: string,
  configDirectory: string,
  execFileFn: PlaytestExecFileFn,
  options: PlaytestSandboxLaunchOptions | undefined,
  stagedInput: StagedInputArtifacts,
  configCleanup: () => void
): Promise<void> {
  try {
    if (options?.inspectImage) {
      const available = await options.inspectImage(
        prepared.imageDigest,
        socket,
        configDirectory
      );
      if (!available) {
        throw new PlaytestSandboxUnavailableError(
          "Approved adapter image " +
            prepared.imageDigest +
            " is not locally available without pulling."
        );
      }
    } else {
      verifyLocalDockerImage(
        prepared.imageDigest,
        socket,
        configDirectory,
        execFileFn
      );
    }
  } catch (error) {
    cleanupStagedInput(stagedInput);
    configCleanup();
    if (
      error instanceof PlaytestSandboxUnavailableError ||
      error instanceof PlaytestSandboxApprovalError
    ) {
      throw error;
    }
    throw new PlaytestSandboxUnavailableError(
      "Approved adapter image " +
        prepared.imageDigest +
        " check failed: " +
        (error instanceof Error ? error.message : String(error))
    );
  }
}

function buildApprovedRunArguments(input: {
  readonly prepared: PreparedPlaytestSandbox;
  readonly runId: string;
  readonly configDirectory: string;
  readonly socket: string;
  readonly stagedInput: StagedInputArtifacts;
  readonly maxOutputBytes: number;
  readonly configCleanup: () => void;
}): string[] {
  try {
    return buildDockerRunArguments(
      input.prepared,
      input.runId,
      input.configDirectory,
      input.socket,
      input.stagedInput.directory ?? undefined,
      input.maxOutputBytes
    );
  } catch (error) {
    cleanupStagedInput(input.stagedInput);
    input.configCleanup();
    throw error;
  }
}

function spawnApprovedDocker(input: {
  readonly runArgs: string[];
  readonly env: NodeJS.ProcessEnv;
  readonly spawnFn: PlaytestSpawnFn;
  readonly stagedInput: StagedInputArtifacts;
  readonly configCleanup: () => void;
}): ChildProcess {
  try {
    return input.spawnFn("docker", input.runArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: input.env,
      shell: false
    });
  } catch (error) {
    cleanupStagedInput(input.stagedInput);
    input.configCleanup();
    throw new PlaytestSandboxExecutionError(
      "Failed to spawn Docker process: " +
        (error instanceof Error ? error.message : String(error)),
      { category: "process-error" }
    );
  }
}

/** Launch an approved OCI container sandbox with attached adapter streams and lifecycle management. */
export async function launchPlaytestSandbox(
  prepared: PreparedPlaytestSandbox,
  options?: PlaytestSandboxLaunchOptions
): Promise<PlaytestSandboxHandle> {
  const socket = options?.socket ?? localDockerSocket();
  assertLocalDockerAvailable(socket);

  const { configDirectory, cleanup: configCleanup } =
    createIsolatedDockerConfig();

  const runId = options?.runId ?? `run-${randomUUID()}`;
  const containerName = getPlaytestContainerName(runId);
  const execFileFn: PlaytestExecFileFn =
    options?.execFile ?? (execFileSync as unknown as PlaytestExecFileFn);
  const spawnFn: PlaytestSpawnFn =
    options?.spawn ?? (spawn as unknown as PlaytestSpawnFn);
  const nowFn = options?.now ?? Date.now;
  touchSnapshot(prepared.checkoutRoot, nowFn());
  const { staged: stagedInputArtifacts, maxOutputBytes: maxArtifactBytes } =
    prepareStagedInput(prepared, options, configCleanup);
  await verifyApprovedImage(
    prepared,
    socket,
    configDirectory,
    execFileFn,
    options,
    stagedInputArtifacts,
    configCleanup
  );
  const runArgs = buildApprovedRunArguments({
    prepared,
    runId,
    configDirectory,
    socket,
    stagedInput: stagedInputArtifacts,
    maxOutputBytes: maxArtifactBytes,
    configCleanup
  });
  const sanitizedEnv = getSanitizedHostEnvironment(
    configDirectory,
    options?.env ?? process.env
  );
  const startTime = nowFn();
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let processError: Error | null = null;
  let exitFired = false;
  let exitCause: PlaytestAdapterExit | null = null;
  let stagingDirectory: string | null = null;
  let stagedArtifacts: readonly StagedPlaytestArtifact[] = [];

  const stdoutTail: string[] = [];
  const stderrTail: string[] = [];
  let totalStdoutBytes = 0;
  let totalStderrBytes = 0;
  const maxOutputBytes = options?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxArtifactFiles =
    options?.maxArtifactFiles ?? DEFAULT_MAX_ARTIFACT_FILES;

  const stdinStream = new PassThrough();
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();

  const exitListeners: Array<(cause: PlaytestAdapterExit) => void> = [];
  const onExit = (listener: (cause: PlaytestAdapterExit) => void): void => {
    if (exitFired && exitCause) {
      listener(exitCause);
    } else {
      exitListeners.push(listener);
    }
  };

  const streams: PlaytestAdapterStreams = {
    stdin: stdinStream,
    stdout: stdoutStream,
    stderr: stderrStream,
    onExit
  };

  function removeContainer(): void {
    try {
      execFileFn(
        "docker",
        [
          "--host",
          `unix://${socket}`,
          "--config",
          configDirectory,
          "rm",
          "--force",
          containerName
        ],
        { stdio: "ignore", timeout: 5000 }
      );
    } catch {
      // ignore errors removing container
    }
  }

  const child = spawnApprovedDocker({
    runArgs,
    env: sanitizedEnv,
    spawnFn,
    stagedInput: stagedInputArtifacts,
    configCleanup
  });

  if (child.stdin) {
    stdinStream.pipe(child.stdin);
  }

  function killProcess(signal: NodeJS.Signals = KILL_SIGNAL): void {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
    removeContainer();
  }

  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => {
      totalStdoutBytes += chunk.length;
      appendTailLines(stdoutTail, chunk);
      if (totalStdoutBytes + totalStderrBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        stdoutStream.destroy();
        killProcess(KILL_SIGNAL);
      } else {
        stdoutStream.write(chunk);
      }
    });
    child.stdout.on("end", () => {
      stdoutStream.end();
    });
    child.stdout.on("error", () => {
      stdoutStream.destroy();
    });
  }

  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      totalStderrBytes += chunk.length;
      appendTailLines(stderrTail, chunk);
      if (totalStdoutBytes + totalStderrBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        stderrStream.destroy();
        killProcess(KILL_SIGNAL);
      } else {
        stderrStream.write(chunk);
      }
    });
    child.stderr.on("end", () => {
      stderrStream.end();
    });
    child.stderr.on("error", () => {
      stderrStream.destroy();
    });
  }

  const wallTimeMs = prepared.limits.wallTimeMs;
  const wallTimer = setTimeout(() => {
    timedOut = true;
    killProcess(KILL_SIGNAL);
  }, wallTimeMs);

  let resolveResult!: (value: PlaytestSandboxResult) => void;
  let rejectResult!: (reason: unknown) => void;
  const resultPromise = new Promise<PlaytestSandboxResult>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    }
  );
  // Prevent unhandled rejection warning if caller only listens to onExit
  resultPromise.catch(() => {});

  let finalized = false;
  function finalize(code: number | null, signal: NodeJS.Signals | null): void {
    if (finalized) return;
    finalized = true;
    clearTimeout(wallTimer);

    const stagingResult = stageContainerArtifacts(
      socket,
      configDirectory,
      containerName,
      maxArtifactBytes,
      maxArtifactFiles,
      execFileFn
    );
    stagingDirectory = stagingResult.stagingDirectory;
    stagedArtifacts = stagingResult.stagedArtifacts;

    removeContainer();
    configCleanup();

    exitFired = true;
    exitCause = {
      code,
      signal,
      stderrTail: [...stderrTail]
    };
    for (const listener of exitListeners) {
      try {
        listener(exitCause);
      } catch {
        // ignore listener errors
      }
    }

    const failure = determineSandboxFailure({
      timedOut,
      cancelled,
      outputLimitExceeded,
      processError,
      artifactError: stagingResult.artifactError,
      code,
      signal,
      wallTimeMs,
      maxOutputBytes,
      stdoutTail: [...stdoutTail],
      stderrTail: [...stderrTail],
      stagedArtifacts
    });

    if (failure) {
      rejectResult(failure);
      return;
    }

    resolveResult({
      runId,
      containerName,
      exitCode: code,
      signal,
      timedOut: false,
      cancelled: false,
      durationMs: Math.max(0, nowFn() - startTime),
      stdoutTail: [...stdoutTail],
      stderrTail: [...stderrTail],
      stagingDirectory,
      artifacts: stagedArtifacts
    });
  }

  child.on("error", (error: Error) => {
    processError = error;
    killProcess(KILL_SIGNAL);
    finalize(null, null);
  });

  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    finalize(code, signal);
  });

  const cancel = (): Promise<void> => {
    if (!finalized) {
      cancelled = true;
      killProcess(KILL_SIGNAL);
    }
    return Promise.resolve();
  };

  const cleanup = (): Promise<void> => {
    removeContainer();
    if (stagingDirectory) {
      try {
        rmSync(stagingDirectory, { recursive: true, force: true });
      } catch {
        // ignore removal error
      }
      stagingDirectory = null;
    }
    try {
      cleanupStagedInput(stagedInputArtifacts);
    } catch {
      // Best-effort deletion after the adapter process has exited.
    }
    configCleanup();
    return Promise.resolve();
  };

  return {
    runId,
    containerName,
    stdin: stdinStream,
    stdout: stdoutStream,
    stderr: stderrStream,
    onExit,
    streams,
    cancel,
    result: resultPromise,
    cleanup
  };
}

/** Run an approved sandbox to completion, returning the resulting metadata and staged artifacts. */
export async function runPlaytestSandbox(
  prepared: PreparedPlaytestSandbox,
  options?: PlaytestSandboxLaunchOptions
): Promise<PlaytestSandboxResult> {
  const sandbox = await launchPlaytestSandbox(prepared, options);
  return sandbox.result;
}
