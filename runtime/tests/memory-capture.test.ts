import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
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
  EXPERIENCE_OUTCOMES,
  EXPERIENCE_VALIDATION_STATES,
  MEMORY_EVIDENCE_KINDS
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
  MAX_NATIVE_TRAJECTORY_BYTES,
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

test("capture accepts every vocabulary the Console can display", () => {
  // Capture used to carry its own list of acceptable validation states, as a
  // bare `Set<string>` that nothing tied to Core's union. A state added to Core
  // would then be displayable in the Console and silently refused here — a
  // disagreement about what exists, between the two sides of the same product.
  for (const state of EXPERIENCE_VALIDATION_STATES) {
    const configuration = memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE: state,
      AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE: JSON.stringify([
        { kind: "file", uri: "runs/42/result.json" }
      ])
    });
    assert.equal(
      configuration.validation?.state,
      state,
      `${state} is declared in Core and must be accepted here`
    );
  }

  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE: "mostly-passed",
        AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE: JSON.stringify([
          { kind: "file", uri: "runs/42/result.json" }
        ])
      }),
    /missing or unsupported/u,
    "a state Core does not declare is still refused"
  );

  // The same disagreement for the other two vocabularies capture decided on.
  // These were typed by Core's unions, so they could not drift silently; this
  // pins the direction that matters instead — nothing in Core is refused here.
  for (const outcome of EXPERIENCE_OUTCOMES) {
    assert.equal(
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_OUTCOME: outcome
      }).outcome,
      outcome,
      `${outcome} is declared in Core and must be accepted here`
    );
  }

  for (const kind of MEMORY_EVIDENCE_KINDS) {
    const configuration = memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE: "passed",
      AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE: JSON.stringify([
        { kind, uri: "runs/42/evidence" }
      ])
    });
    assert.deepEqual(
      configuration.validation?.evidence.map((reference) => reference.kind),
      [kind],
      `${kind} is declared in Core and must be accepted here`
    );
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

/**
 * The transcript source is read from a path an operator configures, and every
 * bound on it is the only thing between a hostile or merely broken transcript
 * and durable memory. The symlink escape above was the one covered case; the
 * remaining refusals had no failing test at all, so each could be deleted with
 * the suite green.
 */
test("a native transcript must be a bounded, readable file beneath its configured root", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "autodev-memory-capture-source-")
  );
  try {
    const repositoryRoot = join(temporaryRoot, "repo");
    const transcriptRoot = join(temporaryRoot, "history");
    await mkdir(repositoryRoot);
    await mkdir(transcriptRoot);
    const configurationAt = (capturePath: string) =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_REPOSITORY_ROOT: repositoryRoot,
        AUTODEV_MEMORY_CAPTURE_ROOT: transcriptRoot,
        AUTODEV_MEMORY_CAPTURE_PATH: capturePath
      });
    const { service, calls } = captureServiceStub();

    // `..` leaves the configured root with no symlink involved at all, so the
    // check on the configured path and the check on the resolved file are two
    // separate refusals rather than one.
    await writeFile(join(temporaryRoot, "outside.jsonl"), claudeTranscript());
    await assert.rejects(
      runMemoryCapture(service, configurationAt("../outside.jsonl")),
      /must remain beneath its configured root/u,
      "a relative path must not walk out of the configured root"
    );

    await mkdir(join(transcriptRoot, "nested"));
    await assert.rejects(
      runMemoryCapture(service, configurationAt("nested")),
      /must be a non-empty regular file/u,
      "a directory is not a transcript"
    );

    await writeFile(join(transcriptRoot, "empty.jsonl"), "");
    await assert.rejects(
      runMemoryCapture(service, configurationAt("empty.jsonl")),
      /must be a non-empty regular file/u,
      "a transcript with no records is refused rather than stored as empty"
    );

    // Oversized on disk *and* unreadable, so the refusal can only name the
    // size: if the bound were checked after the read, this would fail with the
    // read error instead. Runs as root the chmod does not bite, and the second
    // byte check below covers the bound on its own.
    const oversized = join(transcriptRoot, "oversized.jsonl");
    await writeFile(oversized, "");
    // A sparse file, so the fixture costs no real disk.
    await truncate(oversized, MAX_NATIVE_TRAJECTORY_BYTES + 1);
    await chmod(oversized, 0o000);
    await assert.rejects(
      runMemoryCapture(service, configurationAt("oversized.jsonl")),
      /exceeds the 32 MiB capture limit/u,
      "an oversized transcript is refused on its size, without being read"
    );

    // Bytes that are not valid UTF-8 each decode to U+FFFD, three bytes each,
    // so a transcript well inside the on-disk bound can still exceed the bound
    // on the string everything downstream actually holds and hashes.
    const expansion = join(transcriptRoot, "expansion.jsonl");
    const invalidByteCount = Math.floor(MAX_NATIVE_TRAJECTORY_BYTES / 3) + 1;
    await writeFile(expansion, Buffer.alloc(invalidByteCount, 0xff));
    assert.ok(
      invalidByteCount < MAX_NATIVE_TRAJECTORY_BYTES,
      "the fixture must stay inside the on-disk bound, or it proves nothing"
    );
    assert.ok(
      Buffer.byteLength(await readFile(expansion, "utf8"), "utf8") >
        MAX_NATIVE_TRAJECTORY_BYTES,
      "the fixture must decode past the bound, or it proves nothing"
    );
    await assert.rejects(
      runMemoryCapture(service, configurationAt("expansion.jsonl")),
      /exceeds the 32 MiB capture limit/u,
      "the bound applies to the decoded transcript, not only to the file"
    );

    assert.equal(
      calls.length,
      0,
      "no refused transcript reached the memory service"
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

/**
 * Validation evidence arrives as an operator-supplied JSON string and becomes
 * an evidence reference on a durable record. Every bound on it -- the array
 * shape, the count, the size, and each field of each reference -- had no
 * failing test, so each was deletable with the suite green.
 */
test("native capture validation evidence is a bounded array of well-formed references", () => {
  const withEvidence = (evidence: string) =>
    memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_CAPTURE_VALIDATION_STATE: "passed",
      AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE: evidence
    });
  const reference = {
    kind: "file",
    uri: "runs/42/result.json"
  } as const;

  // Evidence with no state at all. The state is what qualifies the evidence,
  // so an array on its own is not a validation claim and must not become one.
  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_VALIDATION_EVIDENCE: JSON.stringify([reference])
      }),
    /validation state is missing or unsupported/u
  );

  assert.throws(
    () =>
      withEvidence(
        JSON.stringify([{ ...reference, uri: `runs/${"a".repeat(40_000)}` }])
      ),
    /validation evidence exceeds its size bound/u
  );
  assert.throws(
    () => withEvidence(JSON.stringify(reference)),
    /must be a bounded JSON array/u,
    "a single object is not an array of references"
  );
  assert.throws(
    () =>
      withEvidence(
        JSON.stringify(
          Array.from({ length: 65 }, (_, index) => ({
            ...reference,
            uri: `runs/${index}/result.json`
          }))
        )
      ),
    /must be a bounded JSON array/u,
    "the reference count is bounded, not merely the array"
  );

  for (const [label, invalid] of [
    ["an unknown field", { ...reference, note: "not part of a reference" }],
    [
      "a uri past its length bound",
      { ...reference, uri: `runs/${"a".repeat(2000)}` }
    ],
    [
      "a revision past its length bound",
      { ...reference, revision: "a".repeat(301) }
    ],
    [
      "an observedAt that is not a date",
      { ...reference, observedAt: "not-a-timestamp" }
    ]
  ] as const) {
    assert.throws(
      () => withEvidence(JSON.stringify([invalid])),
      /contains an invalid reference/u,
      `${label} is refused`
    );
  }

  // The positive control: a well-formed reference carrying every optional field
  // is still accepted, so the cases above refuse the field rather than the shape.
  const accepted = withEvidence(
    JSON.stringify([
      {
        ...reference,
        revision: "abc123",
        observedAt: "2026-10-01T10:00:00.000Z"
      }
    ])
  );
  assert.deepEqual(accepted.validation?.evidence, [
    {
      kind: "file",
      uri: "runs/42/result.json",
      revision: "abc123",
      observedAt: "2026-10-01T10:00:00.000Z"
    }
  ]);
});

/**
 * The capture configuration's own refusals.
 *
 * The file already notes that the *path resolution* refusals could be deleted
 * with the suite green. The same was true, less visibly, of every refusal in
 * the environment parser itself: `required`, `requiredBounded`,
 * `requiredAbsolute` and `optionalBounded` had no failing test at all, because
 * every fixture spread a complete environment and the refusal cases overrode
 * values with *invalid* ones rather than omitting or oversizing them.
 *
 * Each bound is asserted against the number the reader meets -- 256, 4096 --
 * rather than against the module-private constant, so raising a constant
 * cannot quietly widen what is accepted while this test stays green. Each is
 * asserted from both sides: at the bound and one character past it.
 */
test("capture configuration refuses an omitted, oversized, or relative value", () => {
  const atPathBound = (length: number) => `/${"a".repeat(length - 1)}`;

  // Omitted. `required` is what makes a half-configured capture fail loudly
  // rather than run against an undefined workspace.
  for (const name of [
    "AUTODEV_MEMORY_DATABASE_URL",
    "AUTODEV_MEMORY_WORKSPACE_ID",
    "AUTODEV_MEMORY_REPOSITORY_ID",
    "AUTODEV_MEMORY_REPOSITORY_ROOT",
    "AUTODEV_MEMORY_CAPTURE_ROOT",
    "AUTODEV_MEMORY_CAPTURE_PATH",
    "AUTODEV_MEMORY_TASK_ID",
    "AUTODEV_MEMORY_RUN_ID",
    "AUTODEV_MEMORY_AGENT_ID"
  ] as const) {
    assert.throws(
      () =>
        memoryCaptureConfiguration({
          ...enabledEnvironment,
          [name]: undefined
        }),
      MemoryCaptureConfigurationError,
      `${name} is required and omitting it must be refused`
    );
  }

  // Required identifiers are bounded at 256 characters.
  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_WORKSPACE_ID: "w".repeat(257)
      }),
    /workspace id exceeds its length bound/u,
    "a workspace id one character past 256 must be refused"
  );
  assert.doesNotThrow(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_WORKSPACE_ID: "w".repeat(256)
      }),
    "a workspace id of exactly 256 must still be accepted"
  );

  // Absolute paths are bounded at 4096 characters, and must actually be absolute.
  for (const name of [
    "AUTODEV_MEMORY_REPOSITORY_ROOT",
    "AUTODEV_MEMORY_CAPTURE_ROOT"
  ] as const) {
    assert.throws(
      () =>
        memoryCaptureConfiguration({
          ...enabledEnvironment,
          [name]: "relative/path"
        }),
      /must be a bounded absolute path/u,
      `${name} must be refused when it is relative`
    );
    assert.throws(
      () =>
        memoryCaptureConfiguration({
          ...enabledEnvironment,
          [name]: atPathBound(4097)
        }),
      /must be a bounded absolute path/u,
      `${name} must be refused one character past 4096`
    );
    assert.doesNotThrow(
      () =>
        memoryCaptureConfiguration({
          ...enabledEnvironment,
          [name]: atPathBound(4096)
        }),
      `${name} of exactly 4096 characters must still be accepted`
    );
  }

  // Optional values are bounded too, and their absence is not an error -- so
  // the refusal has to be proven distinct from both the bound and the default.
  assert.throws(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_MODEL: "m".repeat(257)
      }),
    /model exceeds its length bound/u,
    "a model one character past 256 must be refused"
  );
  assert.doesNotThrow(
    () =>
      memoryCaptureConfiguration({
        ...enabledEnvironment,
        AUTODEV_MEMORY_CAPTURE_MODEL: "m".repeat(256)
      }),
    "a model of exactly 256 must still be accepted"
  );
  const absent = memoryCaptureConfiguration(enabledEnvironment);
  assert.equal(
    absent.model,
    undefined,
    "an omitted optional value is left off the configuration, not refused and not empty"
  );
});

/**
 * The transcript path is the one configured path that must be *relative*.
 *
 * `AUTODEV_MEMORY_CAPTURE_ROOT` and `AUTODEV_MEMORY_REPOSITORY_ROOT` are the
 * inverse -- they are refused unless absolute -- and both directions are
 * already asserted. The relative-path half of the same idea had no test, so the
 * check could have been deleted with the file staying green.
 *
 * It is not redundant with the containment checks at read time, and the message
 * is what says so. `path.resolve(root, "/etc/passwd")` is `/etc/passwd`, which
 * `isWithin` then refuses -- so the capture still fails closed. But that refusal
 * arrives at read time, after the root has been opened, and says "must remain
 * beneath its configured root". This one refuses while the configuration is
 * still being parsed, before any filesystem call, and names the actual mistake:
 * an absolute path was supplied where a relative one was required. An operator
 * reading the two messages learns different things.
 */
test("capture configuration refuses an absolute transcript path, and says why", () => {
  for (const supplied of [
    "/etc/passwd",
    "/workspace/transcripts/../secrets.jsonl",
    `${process.platform === "win32" ? "C:\\" : "/"}${"a".repeat(1)}/session.jsonl`
  ]) {
    assert.throws(
      () =>
        memoryCaptureConfiguration({
          ...enabledEnvironment,
          AUTODEV_MEMORY_CAPTURE_PATH: supplied
        }),
      /must be relative to its configured root/u,
      `${supplied} names a file directly rather than one beneath the root`
    );
  }

  // Both sides of the rule, so "everything is refused" cannot pass it: a
  // relative path is accepted, including one that climbs and is caught later by
  // the containment check rather than here.
  const relative = memoryCaptureConfiguration(enabledEnvironment);
  assert.equal(relative.transcriptRelativePath, "project/session.jsonl");
  assert.equal(
    memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_CAPTURE_PATH: "../elsewhere/session.jsonl"
    }).transcriptRelativePath,
    "../elsewhere/session.jsonl",
    "a traversal is a relative path, so this guard accepts it -- `isWithin` is what refuses it, at read time"
  );
});

/**
 * A conflicting capture is only deduplicated when the stored row is the same one.
 *
 * The capture id is a hash of the trajectory uri and digest, so through an
 * honest store a conflict always means "this exact transcript is already
 * captured" -- and the reconciliation is never actually load-bearing. It becomes
 * load-bearing when the stored row under that id is *not* the transcript being
 * written: a row left by an older normalizer whose digest derivation has since
 * changed, or one inserted out of band.
 *
 * In that case reporting `appended: false` would tell the operator this
 * transcript is stored when what is stored is something else. The conflict has
 * to reach them instead. Deleting the `throw error` at the end of the catch does
 * not even produce a wrong answer -- it produces no answer at all, falling out
 * of the function with `undefined` where a `MemoryCaptureResult` is declared.
 */
test("a capture that conflicts with a different stored row reports the conflict", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "autodev-memory-capture-conflict-")
  );
  try {
    const repositoryRoot = join(temporaryRoot, "repo");
    const transcriptRoot = join(temporaryRoot, "provider-history");
    await mkdir(repositoryRoot);
    await mkdir(join(transcriptRoot, "project"), { recursive: true });
    await writeFile(
      join(transcriptRoot, "project", "session.jsonl"),
      claudeTranscript()
    );
    const configuration = memoryCaptureConfiguration({
      ...enabledEnvironment,
      AUTODEV_MEMORY_REPOSITORY_ROOT: repositoryRoot,
      AUTODEV_MEMORY_CAPTURE_ROOT: transcriptRoot,
      AUTODEV_MEMORY_CAPTURE_PATH: "project/session.jsonl"
    });
    const { service, experiences } = captureServiceStub();

    const first = await runMemoryCapture(service, configuration);
    assert.equal(first.appended, true);

    const stored = experiences.get(first.id);
    assert.ok(stored, "the first capture must be in the store");

    // Same id, different contents -- and both ways of differing, because a
    // check that only compares the digest would pass the first case while a
    // check that only compares the uri passes the second. The transcript is
    // re-read from disk each run, so the id it computes is stable either way.
    const disagreements: readonly {
      readonly why: string;
      readonly row: ExperienceEnvelope;
    }[] = [
      {
        why: "the stored row has a different digest",
        row: {
          ...stored,
          trajectory: { ...stored.trajectory, digest: "f".repeat(64) }
        }
      },
      {
        why: "the stored row has a different trajectory uri",
        row: {
          ...stored,
          trajectory: {
            ...stored.trajectory,
            uri: "file:///somewhere/else/session.jsonl"
          }
        }
      }
    ];

    for (const { why, row } of disagreements) {
      experiences.set(first.id, row);
      await assert.rejects(
        runMemoryCapture(service, configuration),
        MemoryConflictError,
        `a conflict against a row where ${why} must be reported, not deduplicated`
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
