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
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  PLAYTESTS_ADAPTER_CONTAINER_WORKSPACE,
  PLAYTESTS_INTEGRATION_DIR,
  type PlaytestArtifactReference,
  type PlaytestMetricRegistry,
  type WorkspacePlaytestApproval
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
  readonly checkoutRoot: string;
  readonly checkoutSha: string;
  readonly imageDigest: string;
  readonly workingDirectory: string;
  readonly command: readonly string[];
  readonly limits: WorkspacePlaytestApproval["limits"];
  readonly configuration: ApprovedPlaytestDefinition["configuration"];
  readonly observationContract: ApprovedPlaytestDefinition["observationContract"];
  readonly rubric: PlaytestMetricRegistry;
  readonly benchmark: ApprovedPlaytestDefinition["benchmark"];
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

function readCleanCheckoutSha(root: string): string {
  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== path.resolve(root)) {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout root must be stored as its canonical real path."
    );
  }
  let sha: string;
  let status: string;
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: canonicalRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000
    }).trim();
    status = execFileSync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching"
      ],
      {
        cwd: canonicalRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
        maxBuffer: 256 * 1024
      }
    );
  } catch {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout is not a readable Git working tree."
    );
  }
  if (!SHA_PATTERN.test(sha)) {
    throw new PlaytestSandboxApprovalError(
      "Checkout HEAD is not a valid Git SHA."
    );
  }
  if (status !== "") {
    // Name what is actually wrong. The approved checkout is meant to be clean,
    // so an operator who gitignored `.autodev/` sees a generic "untracked or
    // ignored" line and has to guess that the directory holding the playtest
    // config, rubric and observation manifests is the thing to un-ignore.
    const ignored = status
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith("!! "))
      .map((line) => line.slice(3).trim());
    const autodevIgnored = ignored.filter(
      (path) =>
        path === AUTODEV_INTEGRATION_DIR ||
        path.startsWith(`${AUTODEV_INTEGRATION_DIR}/`)
    );
    if (autodevIgnored.length > 0) {
      throw new PlaytestSandboxApprovalError(
        `Approved checkout ignores ${AUTODEV_INTEGRATION_DIR}/, which holds the playtest config, rubric and observation manifests. Commit those files or stop ignoring ${AUTODEV_INTEGRATION_DIR}/ before running an approved batch.`
      );
    }
    const named = [...ignored, ...modifiedPaths(status)].slice(0, 5);
    throw new PlaytestSandboxApprovalError(
      named.length > 0
        ? `Approved checkout is not clean; commit or remove: ${named.join(", ")}.`
        : "Approved checkout has modified, untracked, or ignored files."
    );
  }
  return sha;
}

/** Paths from `git status --porcelain=v1` other than ignored entries. */
function modifiedPaths(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0 && !line.startsWith("!!"))
    .map((line) => line.slice(3).trim())
    .filter((path) => path.length > 0);
}

/**
 * The canonical integration directory a repository uses to declare AutoDev
 * Playtesting support. Naming it in a failure is the difference between an
 * operator knowing which path to un-ignore and guessing.
 */
const AUTODEV_INTEGRATION_DIR = PLAYTESTS_INTEGRATION_DIR;

function resolveApprovedCheckout(approval: WorkspacePlaytestApproval): {
  readonly root: string;
  readonly workingDirectory: string;
  readonly sha: string;
} {
  const root = realpathSync(approval.checkoutRoot);
  if (root !== path.resolve(approval.checkoutRoot)) {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout root is not the canonical real path."
    );
  }
  if (!statSync(root).isDirectory()) {
    throw new PlaytestSandboxApprovalError(
      "Approved checkout is not a directory."
    );
  }
  // Docker's --mount argument is CSV-like; a comma could add a mount option.
  if (root.includes(",")) {
    throw new PlaytestSandboxApprovalError(
      "Checkout paths containing commas are unsupported."
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
  const workingDirectory = realpathSync(
    path.resolve(root, approval.workingDirectory)
  );
  if (
    !isWithin(root, workingDirectory) ||
    !statSync(workingDirectory).isDirectory()
  ) {
    throw new PlaytestSandboxApprovalError(
      "Working directory escapes the approved checkout."
    );
  }
  const sha = readCleanCheckoutSha(root);
  if (sha.toLowerCase() !== approval.buildSha.toLowerCase()) {
    throw new PlaytestSandboxApprovalError(
      "Checkout HEAD no longer matches the approved build SHA."
    );
  }
  return { root, workingDirectory, sha };
}

/** Load the hashed target config and bind it to the exact clean checkout. */
export function preparePlaytestSandbox(
  approval: WorkspacePlaytestApproval
): PreparedPlaytestSandbox {
  const definition = loadApprovedPlaytestDefinition(approval);
  const { configuration } = definition;
  const configuredCommand = configuration.adapter.command;
  const checkout = resolveApprovedCheckout(approval);
  return {
    workspaceId: approval.workspaceId,
    checkoutRoot: checkout.root,
    checkoutSha: checkout.sha,
    imageDigest: approval.adapterImageDigest,
    workingDirectory: checkout.workingDirectory,
    command: [...configuredCommand],
    limits: { ...approval.limits },
    configuration,
    observationContract: definition.observationContract,
    rubric: definition.rubric,
    benchmark: definition.benchmark,
    rubricHash: definition.rubricHash
  };
}

/** Recheck after execution so concurrent host changes invalidate the attempt. */
export function assertPlaytestCheckoutUnchanged(
  prepared: PreparedPlaytestSandbox
): void {
  const currentSha = readCleanCheckoutSha(prepared.checkoutRoot);
  if (currentSha.toLowerCase() !== prepared.checkoutSha.toLowerCase()) {
    throw new PlaytestSandboxApprovalError(
      "Checkout changed during the playtest attempt."
    );
  }
}

/** Resolve only a local Docker Engine socket; remote Docker contexts are rejected. */
export function localDockerSocket(
  platform: NodeJS.Platform = process.platform,
  home = homedir()
): string {
  if (platform === "darwin") {
    return path.join(home, ".docker", "run", "docker.sock");
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
  readonly checkoutError: Error | null;
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
  if (options.checkoutError) {
    return options.checkoutError;
  }
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

    let checkoutError: Error | null = null;
    try {
      assertPlaytestCheckoutUnchanged(prepared);
    } catch (error) {
      checkoutError = error instanceof Error ? error : new Error(String(error));
    }

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
      checkoutError,
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
