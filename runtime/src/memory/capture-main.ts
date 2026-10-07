#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  type EvidenceReference,
  EXPERIENCE_OUTCOMES,
  type ExperienceEnvelope,
  type ExperienceOutcome,
  EXPERIENCE_VALIDATION_STATES,
  type MemoryActor,
  type MemoryExecutionMode,
  MEMORY_EVIDENCE_KINDS,
  type MemoryReadContext,
  parseMemoryExecutionMode
} from "@simulatorlife/autodev-core";

import { createPostgresMemoryRuntime } from "./postgres.ts";
import {
  MemoryAuthorizationError,
  MemoryConflictError,
  type MemoryExperienceCaptureInput,
  type MemoryService,
  MemoryValidationError
} from "./service.ts";
import {
  MAX_NATIVE_TRAJECTORY_BYTES,
  NATIVE_TRAJECTORY_SOURCES,
  type NativeTrajectorySource
} from "./trajectory.ts";

const MAX_CAPTURE_PATH_LENGTH = 4096;
const MAX_CAPTURE_ID_LENGTH = 256;
const MAX_CAPTURE_TASK_KIND_LENGTH = 200;
const MAX_CAPTURE_VALIDATION_BYTES = 32 * 1024;
const MAX_CAPTURE_VALIDATION_EVIDENCE = 64;
const MAX_EVIDENCE_URI_LENGTH = 2000;
const MAX_EVIDENCE_REVISION_LENGTH = 300;
// Capture is the loosest boundary in the memory system: the service and the
// Control API both admit 2048/256 for the same `EvidenceReference` type (see
// `MAX_EVIDENCE_URI_CHARACTERS` in `service.ts`), and every consumer of a
// captured reference re-measures it before use. Nothing copies capture evidence
// into a memory without passing those checks, so the gap between the two pairs
// is a difference in where a value is first measured rather than a path where
// one side accepts what the other refuses.
// The vocabularies come from Core rather than being spelled here, because this
// is the boundary a capture crosses into memory: the three lists below decided
// what a capture may say about its own execution, and a capture that rejected a
// state the Console could display is a silent disagreement about what exists.
// Two of the three were typed by Core's unions, so a change to them failed the
// build here; the validation set was a bare `Set<string>` and drifted quietly.
const OUTCOMES = new Set<ExperienceOutcome>(EXPERIENCE_OUTCOMES);
const VALIDATION_STATES = new Set<string>(EXPERIENCE_VALIDATION_STATES);
const EVIDENCE_KINDS = new Set<EvidenceReference["kind"]>(
  MEMORY_EVIDENCE_KINDS
);

export interface MemoryCaptureConfiguration {
  readonly databaseUrl: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly transcriptRoot: string;
  readonly transcriptRelativePath: string;
  readonly source: NativeTrajectorySource;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly role: string;
  readonly taskKind?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly branch?: string;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly outcome: ExperienceOutcome;
  readonly memoryMode: MemoryExecutionMode;
  readonly validation?: ExperienceEnvelope["validation"];
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
}

export interface MemoryCaptureResult {
  readonly id: string;
  readonly appended: boolean;
  readonly source: NativeTrajectorySource;
  readonly digest: string;
  readonly recordCount: number;
  readonly diagnosticCount?: number;
  readonly outcome: ExperienceOutcome;
  readonly memoryMode: MemoryExecutionMode;
}

interface TranscriptSource {
  readonly path: string;
  readonly contents: string;
}

/** Parse an explicit, run-bound import policy; no user or global default scope. */
export function memoryCaptureConfiguration(
  env: NodeJS.ProcessEnv
): MemoryCaptureConfiguration {
  if (env.AUTODEV_MEMORY_CAPTURE_ENABLED !== "1") {
    throw new MemoryCaptureConfigurationError(
      "Set AUTODEV_MEMORY_CAPTURE_ENABLED=1 to run native trajectory capture."
    );
  }
  const databaseUrl = required(env.AUTODEV_MEMORY_DATABASE_URL, "database URL");
  const workspaceId = requiredBounded(
    env.AUTODEV_MEMORY_WORKSPACE_ID,
    "workspace id",
    MAX_CAPTURE_ID_LENGTH
  );
  const repositoryId = requiredBounded(
    env.AUTODEV_MEMORY_REPOSITORY_ID,
    "repository id",
    MAX_CAPTURE_ID_LENGTH
  );
  const repositoryRoot = requiredAbsolute(
    env.AUTODEV_MEMORY_REPOSITORY_ROOT,
    "repository root"
  );
  const transcriptRoot = requiredAbsolute(
    env.AUTODEV_MEMORY_CAPTURE_ROOT,
    "native transcript root"
  );
  const transcriptRelativePath = requiredBounded(
    env.AUTODEV_MEMORY_CAPTURE_PATH,
    "relative transcript path",
    MAX_CAPTURE_PATH_LENGTH
  );
  if (path.isAbsolute(transcriptRelativePath)) {
    throw new MemoryCaptureConfigurationError(
      "Native transcript path must be relative to its configured root."
    );
  }

  const source = env.AUTODEV_MEMORY_CAPTURE_SOURCE?.trim();
  if (
    !source ||
    !NATIVE_TRAJECTORY_SOURCES.includes(source as NativeTrajectorySource)
  ) {
    throw new MemoryCaptureConfigurationError(
      `Capture source must be one of: ${NATIVE_TRAJECTORY_SOURCES.join(", ")}.`
    );
  }
  const taskId = requiredBounded(
    env.AUTODEV_MEMORY_TASK_ID,
    "task id",
    MAX_CAPTURE_ID_LENGTH
  );
  const runId = requiredBounded(
    env.AUTODEV_MEMORY_RUN_ID,
    "run id",
    MAX_CAPTURE_ID_LENGTH
  );
  const agentId = requiredBounded(
    env.AUTODEV_MEMORY_AGENT_ID,
    "agent id",
    MAX_CAPTURE_ID_LENGTH
  );
  const role =
    optionalBounded(env.AUTODEV_MEMORY_ROLE, 128, "role") || "worker";
  const taskKind = optionalBounded(
    env.AUTODEV_MEMORY_CAPTURE_TASK_KIND,
    MAX_CAPTURE_TASK_KIND_LENGTH,
    "task kind"
  );
  const provider = optionalBounded(
    env.AUTODEV_MEMORY_CAPTURE_PROVIDER,
    128,
    "provider"
  );
  const model = optionalBounded(env.AUTODEV_MEMORY_CAPTURE_MODEL, 256, "model");
  const branch = optionalBounded(
    env.AUTODEV_MEMORY_CAPTURE_BRANCH,
    512,
    "branch"
  );
  const baseCommit = optionalBounded(
    env.AUTODEV_MEMORY_CAPTURE_BASE_COMMIT,
    300,
    "base commit"
  );
  const headCommit = optionalBounded(
    env.AUTODEV_MEMORY_CAPTURE_HEAD_COMMIT,
    300,
    "head commit"
  );
  const outcome = captureOutcome(env.AUTODEV_MEMORY_CAPTURE_OUTCOME);
  const captureMode =
    env.AUTODEV_MEMORY_CAPTURE_MODE?.trim() || env.AUTODEV_MEMORY_MODE?.trim();
  const memoryMode = parseMemoryExecutionMode(
    captureMode,
    env.AUTODEV_MEMORY_ABLATION === "1"
  );
  const validation = captureValidation(env);
  const actor: MemoryActor = { id: agentId, authority: "worker", role };
  const context: MemoryReadContext = {
    workspaceId,
    repositoryId,
    role,
    taskId,
    runId,
    agentId,
    canReadGlobal: false,
    canReadTaskHistory: false
  };

  return {
    databaseUrl,
    workspaceId,
    repositoryId,
    repositoryRoot,
    transcriptRoot,
    transcriptRelativePath,
    source: source as NativeTrajectorySource,
    taskId,
    runId,
    agentId,
    role,
    ...(taskKind ? { taskKind } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(branch ? { branch } : {}),
    ...(baseCommit ? { baseCommit } : {}),
    ...(headCommit ? { headCommit } : {}),
    outcome,
    memoryMode,
    ...(validation ? { validation } : {}),
    actor,
    context
  };
}

/** Import one bounded native transcript; only Letta-normalized metadata persists. */
export async function runMemoryCapture(
  service: Pick<MemoryService, "captureExperience" | "getExperience">,
  configuration: MemoryCaptureConfiguration
): Promise<MemoryCaptureResult> {
  const transcript = await readTranscriptSource(configuration);
  const { digest, trajectoryUri } = transcriptFingerprint(transcript);
  const id = captureExperienceId({
    workspaceId: configuration.workspaceId,
    repositoryId: configuration.repositoryId,
    taskId: configuration.taskId,
    runId: configuration.runId,
    agentId: configuration.agentId,
    source: configuration.source,
    trajectoryUri,
    digest
  });
  const experience = captureExperienceRecord({
    configuration,
    id,
    trajectoryUri
  });
  try {
    const normalized = await service.captureExperience(
      {
        source: configuration.source,
        transcript: transcript.contents,
        trajectoryUri,
        experience
      },
      configuration.actor,
      configuration.context
    );
    return {
      id,
      appended: true,
      source: configuration.source,
      digest: normalized.digest,
      recordCount: normalized.recordCount,
      diagnosticCount: normalized.diagnosticCount,
      outcome: configuration.outcome,
      memoryMode: configuration.memoryMode
    };
  } catch (error) {
    if (!(error instanceof MemoryConflictError)) throw error;
    const reconciled = await reconcileConflictingCapture({
      service,
      configuration,
      id,
      trajectoryUri,
      digest
    });
    if (reconciled) return reconciled;
    throw error;
  }
}

export async function runMemoryCaptureFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): Promise<MemoryCaptureResult> {
  const configuration = memoryCaptureConfiguration(env);
  const runtime = createPostgresMemoryRuntime({
    databaseUrl: configuration.databaseUrl,
    repositories: {
      resolve: (context) =>
        Promise.resolve(
          context.workspaceId === configuration.workspaceId &&
            context.repositoryId === configuration.repositoryId
            ? configuration.repositoryRoot
            : null
        )
    }
  });
  try {
    return await runMemoryCapture(runtime.service, configuration);
  } finally {
    await runtime.close();
  }
}

/**
 * How one transcript is identified: the digest is what makes a repeated capture
 * idempotent, and the URI is the evidence reference every record points at.
 */
function transcriptFingerprint(transcript: TranscriptSource): {
  readonly digest: string;
  readonly trajectoryUri: string;
} {
  return {
    digest: createHash("sha256")
      .update(transcript.contents, "utf8")
      .digest("hex"),
    trajectoryUri: pathToFileURL(transcript.path).href
  };
}

/**
 * The record one capture persists. A change to what a capture stores is a
 * change here alone; the orchestration around it does not move.
 */
function captureExperienceRecord({
  configuration,
  id,
  trajectoryUri
}: {
  readonly configuration: MemoryCaptureConfiguration;
  readonly id: string;
  readonly trajectoryUri: string;
}): MemoryExperienceCaptureInput["experience"] {
  const trajectoryEvidence = {
    kind: "trajectory" as const,
    uri: trajectoryUri
  };
  return {
    id,
    workspaceId: configuration.workspaceId,
    repositoryId: configuration.repositoryId,
    scope: {
      kind: "agent",
      workspaceId: configuration.workspaceId,
      taskId: configuration.taskId,
      runId: configuration.runId,
      agentId: configuration.agentId
    },
    taskId: configuration.taskId,
    runId: configuration.runId,
    agentId: configuration.agentId,
    agentRole: configuration.role,
    ...(configuration.taskKind ? { taskKind: configuration.taskKind } : {}),
    ...(configuration.provider ? { provider: configuration.provider } : {}),
    ...(configuration.model ? { model: configuration.model } : {}),
    ...(configuration.branch ? { branch: configuration.branch } : {}),
    ...(configuration.baseCommit
      ? { baseCommit: configuration.baseCommit }
      : {}),
    ...(configuration.headCommit
      ? { headCommit: configuration.headCommit }
      : {}),
    outcome: configuration.outcome,
    memoryMode: configuration.memoryMode,
    ...(configuration.validation
      ? { validation: configuration.validation }
      : {}),
    taskReference: trajectoryEvidence,
    evidence: [trajectoryEvidence]
  };
}

/**
 * Whether a capture conflict is this same trajectory arriving twice, which is a
 * successful no-op rather than a failure. Returns null when the stored record
 * is a different trajectory, leaving the caller to rethrow the conflict.
 */
async function reconcileConflictingCapture({
  service,
  configuration,
  id,
  trajectoryUri,
  digest
}: {
  readonly service: Pick<MemoryService, "captureExperience" | "getExperience">;
  readonly configuration: MemoryCaptureConfiguration;
  readonly id: string;
  readonly trajectoryUri: string;
  readonly digest: string;
}): Promise<MemoryCaptureResult | null> {
  const existing = await service.getExperience(id, configuration.context);
  if (
    existing?.trajectory.uri !== trajectoryUri ||
    existing.trajectory.digest !== digest
  ) {
    return null;
  }
  return {
    id,
    appended: false,
    source: configuration.source,
    digest,
    recordCount: existing.trajectory.recordCount ?? 0,
    outcome: existing.outcome,
    memoryMode: existing.memoryMode ?? "unknown"
  };
}

async function readTranscriptSource(
  configuration: MemoryCaptureConfiguration
): Promise<TranscriptSource> {
  let root: string;
  let file: string;
  let fileStats: Awaited<ReturnType<typeof stat>>;
  try {
    root = await realpath(configuration.transcriptRoot);
    const candidate = path.resolve(root, configuration.transcriptRelativePath);
    if (!isWithin(root, candidate)) {
      throw new MemoryCaptureConfigurationError(
        "Native transcript path must remain beneath its configured root."
      );
    }
    file = await realpath(candidate);
    if (!isWithin(root, file)) {
      throw new MemoryCaptureConfigurationError(
        "Native transcript resolves outside its configured root."
      );
    }
    fileStats = await stat(file);
  } catch (error) {
    if (error instanceof MemoryCaptureConfigurationError) throw error;
    throw new MemoryCaptureConfigurationError(
      "Configured native transcript is unavailable under its source root."
    );
  }
  if (!fileStats.isFile() || fileStats.size === 0) {
    throw new MemoryCaptureConfigurationError(
      "Native transcript must be a non-empty regular file."
    );
  }
  if (fileStats.size > MAX_NATIVE_TRAJECTORY_BYTES) {
    throw new MemoryCaptureConfigurationError(
      "Native transcript exceeds the 32 MiB capture limit."
    );
  }
  try {
    const contents = await readFile(file, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_NATIVE_TRAJECTORY_BYTES) {
      throw new MemoryCaptureConfigurationError(
        "Native transcript exceeds the 32 MiB capture limit."
      );
    }
    return { path: file, contents };
  } catch (error) {
    if (error instanceof MemoryCaptureConfigurationError) throw error;
    throw new MemoryCaptureConfigurationError(
      "Configured native transcript could not be read."
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(
    relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function captureExperienceId(input: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly source: NativeTrajectorySource;
  readonly trajectoryUri: string;
  readonly digest: string;
}): string {
  const identity = JSON.stringify([
    input.workspaceId,
    input.repositoryId,
    input.taskId,
    input.runId,
    input.agentId,
    input.source,
    input.trajectoryUri,
    input.digest
  ]);
  return `experience-capture-${createHash("sha256").update(identity).digest("hex")}`;
}

function captureOutcome(value: string | undefined): ExperienceOutcome {
  const outcome = value?.trim() || "unknown";
  if (!OUTCOMES.has(outcome as ExperienceOutcome)) {
    throw new MemoryCaptureConfigurationError(
      "Native capture outcome must be a supported historical outcome label."
    );
  }
  return outcome as ExperienceOutcome;
}

function captureValidation(
  env: NodeJS.ProcessEnv
): ExperienceEnvelope["validation"] {
  const state = env.AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE?.trim();
  const rawEvidence = env.AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE?.trim();
  let validation: ExperienceEnvelope["validation"];
  if (state || rawEvidence) {
    if (!state || !VALIDATION_STATES.has(state)) {
      throw new MemoryCaptureConfigurationError(
        "Native capture validation state is missing or unsupported."
      );
    }
    if (
      rawEvidence &&
      Buffer.byteLength(rawEvidence, "utf8") > MAX_CAPTURE_VALIDATION_BYTES
    ) {
      throw new MemoryCaptureConfigurationError(
        "Native capture validation evidence exceeds its size bound."
      );
    }
    let evidence: readonly EvidenceReference[] = [];
    if (rawEvidence) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawEvidence) as unknown;
      } catch {
        throw new MemoryCaptureConfigurationError(
          "Native capture validation evidence must be a JSON array."
        );
      }
      if (
        !Array.isArray(parsed) ||
        parsed.length > MAX_CAPTURE_VALIDATION_EVIDENCE
      ) {
        throw new MemoryCaptureConfigurationError(
          "Native capture validation evidence must be a bounded JSON array."
        );
      }
      evidence = parsed.map(parseCaptureEvidence);
    }
    if (state !== "not_run" && evidence.length === 0) {
      throw new MemoryCaptureConfigurationError(
        "Reported validation requires at least one evidence reference."
      );
    }
    validation = {
      state: state as NonNullable<ExperienceEnvelope["validation"]>["state"],
      evidence
    };
  }
  return validation;
}

function parseCaptureEvidence(value: unknown): EvidenceReference {
  if (!isRecord(value)) {
    throw new MemoryCaptureConfigurationError(
      "Native capture validation evidence contains an invalid reference."
    );
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => !["kind", "uri", "revision", "observedAt"].includes(key)
    ) ||
    typeof value.kind !== "string" ||
    !EVIDENCE_KINDS.has(value.kind as EvidenceReference["kind"]) ||
    typeof value.uri !== "string" ||
    !value.uri.trim() ||
    value.uri.length > MAX_EVIDENCE_URI_LENGTH ||
    (value.revision !== undefined &&
      (typeof value.revision !== "string" ||
        value.revision.length > MAX_EVIDENCE_REVISION_LENGTH)) ||
    (value.observedAt !== undefined &&
      (typeof value.observedAt !== "string" ||
        !Number.isFinite(Date.parse(value.observedAt))))
  ) {
    throw new MemoryCaptureConfigurationError(
      "Native capture validation evidence contains an invalid reference."
    );
  }
  return {
    kind: value.kind as EvidenceReference["kind"],
    uri: value.uri,
    ...(typeof value.revision === "string" ? { revision: value.revision } : {}),
    ...(typeof value.observedAt === "string"
      ? { observedAt: value.observedAt }
      : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new MemoryCaptureConfigurationError(
      `Memory capture requires a configured ${name}.`
    );
  }
  return normalized;
}

function requiredBounded(
  value: string | undefined,
  name: string,
  maximum: number
): string {
  const normalized = required(value, name);
  if (normalized.length > maximum) {
    throw new MemoryCaptureConfigurationError(
      `Memory capture ${name} exceeds its length bound.`
    );
  }
  return normalized;
}

function requiredAbsolute(value: string | undefined, name: string): string {
  const normalized = required(value, name);
  if (
    !path.isAbsolute(normalized) ||
    normalized.length > MAX_CAPTURE_PATH_LENGTH
  ) {
    throw new MemoryCaptureConfigurationError(
      `Memory capture ${name} must be a bounded absolute path.`
    );
  }
  return path.resolve(normalized);
}

function optionalBounded(
  value: string | undefined,
  max: number,
  name: string
): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) return "";
  if (normalized.length > max) {
    throw new MemoryCaptureConfigurationError(
      `Memory capture ${name} exceeds its length bound.`
    );
  }
  return normalized;
}

export class MemoryCaptureConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryCaptureConfigurationError";
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint &&
  (() => {
    try {
      return (
        realpathSync(entryPoint) ===
        realpathSync(fileURLToPath(import.meta.url))
      );
    } catch {
      return (
        path.resolve(entryPoint) ===
        path.resolve(fileURLToPath(import.meta.url))
      );
    }
  })()
) {
  try {
    const result = await runMemoryCaptureFromEnvironment();
    process.stdout.write(
      `${JSON.stringify({ schema: "autodev-memory-capture-v1", ...result })}\n`
    );
  } catch (error) {
    const message =
      error instanceof MemoryCaptureConfigurationError ||
      error instanceof MemoryAuthorizationError ||
      error instanceof MemoryValidationError
        ? error.message
        : "Memory capture failed; check the database and configured transcript source.";
    process.stderr.write(`memory-capture: ${message}\n`);
    process.exitCode = 1;
  }
}
