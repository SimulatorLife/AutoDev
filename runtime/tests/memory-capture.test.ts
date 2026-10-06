import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
  ExperienceEnvelope,
  MemoryActor,
  MemoryReadContext
} from "@simulatorlife/autodev-core";

import {
  memoryCaptureConfiguration,
  MemoryCaptureConfigurationError,
  runMemoryCapture
} from "../src/memory/capture-main.ts";
import {
  MemoryConflictError,
  type MemoryExperienceCaptureInput,
  type MemoryService
} from "../src/memory/service.ts";
import {
  NATIVE_TRAJECTORY_SOURCES,
  normalizeNativeTrajectory
} from "../src/memory/trajectory.ts";

const enabledEnvironment = {
  AUTODEV_MEMORY_CAPTURE_ENABLED: "1",
  AUTODEV_MEMORY_DATABASE_URL: "postgresql://memory.invalid/autodev",
  AUTODEV_MEMORY_WORKSPACE_ID: "workspace-a",
  AUTODEV_MEMORY_REPOSITORY_ID: "owner/repo",
  AUTODEV_MEMORY_REPOSITORY_ROOT: "/workspace/repo",
  AUTODEV_MEMORY_CAPTURE_ROOT: "/workspace/transcripts",
  AUTODEV_MEMORY_CAPTURE_PATH: "project/session.jsonl",
  AUTODEV_MEMORY_CAPTURE_SOURCE: "claude-code",
  AUTODEV_MEMORY_TASK_ID: "task-a",
  AUTODEV_MEMORY_RUN_ID: "run-a",
  AUTODEV_MEMORY_AGENT_ID: "worker-a"
};

function claudeTranscript(): string {
  return [
    {
      type: "user",
      uuid: "user-record",
      sessionId: "session-a",
      timestamp: "2026-10-01T10:00:00.000Z",
      cwd: "/workspace/repo",
      message: { role: "user", content: "private transcript request" }
    },
    {
      type: "assistant",
      uuid: "assistant-record",
      sessionId: "session-a",
      timestamp: "2026-10-01T10:01:00.000Z",
      message: { role: "assistant", content: "private transcript response" }
    }
  ]
    .map((record) => JSON.stringify(record))
    .join("\n");
}

function captureServiceStub(): {
  readonly service: MemoryService;
  readonly experiences: Map<string, ExperienceEnvelope>;
  readonly calls: MemoryExperienceCaptureInput[];
} {
  const experiences = new Map<string, ExperienceEnvelope>();
  const calls: MemoryExperienceCaptureInput[] = [];
  const service = {
    async captureExperience(
      input: MemoryExperienceCaptureInput,
      _actor: MemoryActor,
      _context: MemoryReadContext
    ) {
      calls.push(input);
      const normalized = normalizeNativeTrajectory({
        source: input.source,
        transcript: input.transcript,
        uri: input.trajectoryUri
      });
      if (experiences.has(input.experience.id)) {
        throw new MemoryConflictError("Duplicate experience.");
      }
      const startedAt =
        input.experience.startedAt ??
        (normalized.timestampsInferred
          ? undefined
          : normalized.firstTimestamp) ??
        now;
      const completedAt =
        input.experience.completedAt ??
        (normalized.timestampsInferred ? undefined : normalized.lastTimestamp);
      experiences.set(input.experience.id, {
        ...input.experience,
        startedAt,
        ...(completedAt ? { completedAt } : {}),
        trajectory: {
          format: normalized.format,
          uri: normalized.uri,
          digest: normalized.digest,
          recordCount: normalized.recordCount
        }
      });
      return normalized;
    },
    async getExperience(id: string) {
      return experiences.get(id) ?? null;
    }
  } as unknown as MemoryService;
  return { service, experiences, calls };
}

const now = "2026-10-01T12:00:00.000Z";

test("manual native capture configuration accepts every supported transcript adapter", () => {
  for (const source of NATIVE_TRAJECTORY_SOURCES) {
    const configuration = memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_CAPTURE_SOURCE: source
    });
    assert.equal(configuration.source, source);
    assert.equal(configuration.outcome, "unknown");
    assert.equal(configuration.memoryMode, "unknown");
  }
});

test("manual native capture normalizes, scopes, bounds, and deduplicates a source transcript", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "autodev-memory-capture-")
  );
  try {
    const repositoryRoot = join(temporaryRoot, "repo");
    const transcriptRoot = join(temporaryRoot, "provider-history");
    await mkdir(repositoryRoot);
    await mkdir(join(transcriptRoot, "project"), { recursive: true });
    const transcriptPath = join(transcriptRoot, "project", "session.jsonl");
    const transcript = claudeTranscript();
    await writeFile(transcriptPath, transcript);
    const configuration = memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_REPOSITORY_ROOT: repositoryRoot,
      AUTODEV_MEMORY_CAPTURE_ROOT: transcriptRoot,
      AUTODEV_MEMORY_CAPTURE_OUTCOME: "success",
      AUTODEV_MEMORY_CAPTURE_MODE: "retrieval-only",
      AUTODEV_MEMORY_ABLATION: "1",
      AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE: "passed",
      AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE: JSON.stringify([
        { kind: "pull_request", uri: "https://example.invalid/pull/8" }
      ])
    });
    const { service, experiences, calls } = captureServiceStub();

    const captured = await runMemoryCapture(service, configuration);

    assert.equal(captured.appended, true);
    assert.equal(captured.outcome, "success");
    assert.equal(captured.memoryMode, "retrieval-only");
    assert.equal(captured.source, "claude-code");
    assert.equal(
      captured.digest,
      createHash("sha256").update(transcript, "utf8").digest("hex")
    );
    assert.ok(captured.recordCount > 0);
    assert.match(captured.id, /^experience-capture-[a-f0-9]{64}$/u);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.transcript, transcript);
    const stored = experiences.get(captured.id);
    assert.ok(stored);
    assert.deepEqual(stored.scope, {
      kind: "agent",
      workspaceId: "workspace-a",
      taskId: "task-a",
      runId: "run-a",
      agentId: "worker-a"
    });
    assert.equal(stored.outcome, "success");
    assert.equal(stored.memoryMode, "retrieval-only");
    assert.deepEqual(stored.validation, {
      state: "passed",
      evidence: [
        { kind: "pull_request", uri: "https://example.invalid/pull/8" }
      ]
    });
    assert.equal(stored.trajectory.format, "letta-trajectory-v1");
    assert.equal(
      stored.trajectory.uri,
      pathToFileURL(await realpath(transcriptPath)).href
    );
    assert.doesNotMatch(
      JSON.stringify(stored),
      /private transcript request|private transcript response/
    );

    const changedReporterAssertion = memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_REPOSITORY_ROOT: repositoryRoot,
      AUTODEV_MEMORY_CAPTURE_ROOT: transcriptRoot,
      AUTODEV_MEMORY_CAPTURE_OUTCOME: "failure"
    });
    const repeated = await runMemoryCapture(service, changedReporterAssertion);
    assert.equal(repeated.id, captured.id);
    assert.equal(repeated.appended, false);
    assert.equal(repeated.outcome, "success");
    assert.equal(repeated.memoryMode, "retrieval-only");
    assert.equal(calls.length, 2);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("two distinct transcripts are captured separately rather than deduplicated", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "autodev-memory-capture-distinct-")
  );
  try {
    const repositoryRoot = join(temporaryRoot, "repo");
    const transcriptRoot = join(temporaryRoot, "provider-history");
    await mkdir(repositoryRoot);
    await mkdir(join(transcriptRoot, "project"), { recursive: true });
    const firstPath = join(transcriptRoot, "project", "first.jsonl");
    const secondPath = join(transcriptRoot, "project", "second.jsonl");
    await writeFile(firstPath, claudeTranscript());
    await writeFile(
      secondPath,
      [
        claudeTranscript(),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-record-2",
          sessionId: "session-a",
          timestamp: "2026-10-01T10:02:00.000Z",
          cwd: "/workspace/repo",
          message: { role: "assistant", content: "a later turn" }
        })
      ].join("\n")
    );
    const configuration = memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_REPOSITORY_ROOT: repositoryRoot,
      AUTODEV_MEMORY_CAPTURE_ROOT: transcriptRoot,
      AUTODEV_MEMORY_CAPTURE_PATH: "project/first.jsonl"
    });
    const { service, experiences } = captureServiceStub();

    // A transcript is identified by its digest and its URI, so different
    // contents at a different path are a different capture -- never a repeat.
    const first = await runMemoryCapture(service, configuration);
    const second = await runMemoryCapture(service, {
      ...configuration,
      transcriptRelativePath: "project/second.jsonl"
    });

    assert.equal(first.appended, true);
    assert.equal(second.appended, true);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.digest, second.digest);
    assert.equal(
      experiences.get(second.id)?.trajectory.uri,
      pathToFileURL(await realpath(secondPath)).href
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("manual native capture rejects disabled, unsupported, and symlink-escaped inputs", async () => {
  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_ENABLED: undefined
      }),
    MemoryCaptureConfigurationError
  );
  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_SOURCE: "unsupported-harness"
      }),
    /Capture source must be one of/
  );
  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_OUTCOME: "maybe"
      }),
    /supported historical outcome/
  );
  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE: "passed"
      }),
    /validation requires at least one evidence reference/
  );
  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE: "passed",
        AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE: "not-json"
      }),
    /validation evidence must be a JSON array/
  );

  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "autodev-memory-capture-path-")
  );
  try {
    const repositoryRoot = join(temporaryRoot, "repo");
    const transcriptRoot = join(temporaryRoot, "history");
    await mkdir(repositoryRoot);
    await mkdir(transcriptRoot);
    const outsidePath = join(temporaryRoot, "outside.jsonl");
    await writeFile(outsidePath, claudeTranscript());
    await symlink(outsidePath, join(transcriptRoot, "escape.jsonl"));
    const configuration = memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_REPOSITORY_ROOT: repositoryRoot,
      AUTODEV_MEMORY_CAPTURE_ROOT: transcriptRoot,
      AUTODEV_MEMORY_CAPTURE_PATH: "escape.jsonl"
    });
    const { service, calls } = captureServiceStub();

    await assert.rejects(
      runMemoryCapture(service, configuration),
      /outside its configured root/
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
