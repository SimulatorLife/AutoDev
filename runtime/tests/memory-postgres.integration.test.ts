import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
  EvidenceReference,
  ExperienceEnvelope,
  MemoryActor,
  MemoryReadContext,
  MemoryResearchRequest
} from "@simulatorlife/autodev-core";
import {
  applyMemoryMigrations,
  createPgMemoryPool
} from "@simulatorlife/autodev-data";

import {
  memoryCaptureConfiguration,
  runMemoryCapture
} from "../src/memory/capture-main.ts";
import { createPostgresMemoryRuntime } from "../src/memory/postgres.ts";
import type { MemoryProposalInput } from "../src/memory/service.ts";

const databaseUrl = process.env.AUTODEV_MEMORY_RUNTIME_TEST_DATABASE_URL;

test(
  "PostgreSQL MemoryService captures, verifies, injects, and rejects stale Git-backed guidance",
  { skip: !databaseUrl },
  async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "autodev-memory-runtime-")
    );
    const repositoryId = `memory-runtime-${randomUUID()}`;
    const workspaceId = `workspace-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const runId = `run-${randomUUID()}`;
    const sourceFile = join(repositoryRoot, "src", "feature.ts");
    const now = "2026-10-01T12:00:00.000Z";
    const readContext: MemoryReadContext = {
      workspaceId,
      repositoryId,
      role: "worker",
      taskId,
      runId,
      agentId: "worker-1",
      canReadGlobal: false
    };
    const worker: MemoryActor = {
      id: "worker-1",
      authority: "worker",
      role: "worker"
    };
    const root: MemoryActor = { id: "root-1", authority: "root" };
    const fileReference: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(sourceFile).href
    };
    let runtime: ReturnType<typeof createPostgresMemoryRuntime> | undefined;

    try {
      await mkdir(join(repositoryRoot, "src"));
      await writeFile(sourceFile, "export const enabledByDefault = true;\n");
      execGit(repositoryRoot, ["init", "-q"]);
      execGit(repositoryRoot, [
        "config",
        "user.name",
        "AutoDev Runtime Integration"
      ]);
      execGit(repositoryRoot, [
        "config",
        "user.email",
        "runtime-integration@example.invalid"
      ]);
      execGit(repositoryRoot, ["add", "src/feature.ts"]);
      execGit(repositoryRoot, [
        "commit",
        "-q",
        "-m",
        "Add verified feature flag"
      ]);
      const sourceCommit = execGit(repositoryRoot, ["rev-parse", "HEAD"]);
      const commitReference: EvidenceReference = {
        kind: "commit",
        uri: `git://${encodeURIComponent(repositoryId)}/commit/${sourceCommit}`,
        revision: sourceCommit
      };
      const evidence = [commitReference, fileReference];

      const pool = createPgMemoryPool({ connectionString: databaseUrl! });
      try {
        await applyMemoryMigrations(pool);
      } finally {
        await pool.end();
      }

      runtime = createPostgresMemoryRuntime({
        databaseUrl: databaseUrl!,
        repositories: {
          resolve: async (context) =>
            context.repositoryId === repositoryId ? repositoryRoot : null
        },
        now: () => now
      });
      const transcript = [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Check the feature default." }
            ]
          }
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The default is enabled." }]
          }
        }
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");

      const experience: Omit<ExperienceEnvelope, "trajectory"> = {
        id: `experience-${randomUUID()}`,
        workspaceId,
        repositoryId,
        scope: { kind: "repository" as const, workspaceId, repositoryId },
        taskId,
        runId,
        agentId: worker.id,
        agentRole: "worker",
        branch: "main",
        headCommit: sourceCommit,
        startedAt: now,
        outcome: "success" as const,
        evidence
      };
      await runtime.service.captureExperience(
        {
          source: "codex",
          transcript,
          trajectoryUri: `file://${repositoryRoot}/trajectory.jsonl`,
          experience
        },
        worker,
        readContext
      );
      const transcriptRoot = join(repositoryRoot, "provider-transcripts");
      await mkdir(transcriptRoot);
      const nativeTranscriptPath = join(transcriptRoot, "claude-session.jsonl");
      await writeFile(
        nativeTranscriptPath,
        [
          {
            type: "user",
            uuid: "claude-user",
            sessionId: "claude-session",
            cwd: repositoryRoot,
            message: { role: "user", content: "private native prompt" }
          },
          {
            type: "assistant",
            uuid: "claude-assistant",
            sessionId: "claude-session",
            message: { role: "assistant", content: "private native answer" }
          }
        ]
          .map((record) => JSON.stringify(record))
          .join("\n")
      );
      const captureConfiguration = memoryCaptureConfiguration({
        AUTODEV_MEMORY_CAPTURE_ENABLED: "1",
        AUTODEV_MEMORY_DATABASE_URL: databaseUrl!,
        AUTODEV_MEMORY_WORKSPACE_ID: workspaceId,
        AUTODEV_MEMORY_REPOSITORY_ID: repositoryId,
        AUTODEV_MEMORY_REPOSITORY_ROOT: repositoryRoot,
        AUTODEV_MEMORY_CAPTURE_ROOT: transcriptRoot,
        AUTODEV_MEMORY_CAPTURE_PATH: "claude-session.jsonl",
        AUTODEV_MEMORY_CAPTURE_SOURCE: "claude-code",
        AUTODEV_MEMORY_TASK_ID: `${taskId}-native-capture`,
        AUTODEV_MEMORY_RUN_ID: `${runId}-native-capture`,
        AUTODEV_MEMORY_AGENT_ID: "worker-native-capture",
        AUTODEV_MEMORY_ROLE: "worker",
        AUTODEV_MEMORY_CAPTURE_TASK_KIND: "bugfix"
      });
      const imported = await runMemoryCapture(
        runtime.service,
        captureConfiguration
      );
      assert.equal(imported.appended, true);
      assert.equal(imported.source, "claude-code");
      const importedExperience = await runtime.service.getExperience(
        imported.id,
        captureConfiguration.context
      );
      assert.equal(
        importedExperience?.trajectory.format,
        "letta-trajectory-v1"
      );
      assert.equal(importedExperience?.taskKind, "bugfix");
      assert.equal(importedExperience?.outcome, "unknown");
      assert.doesNotMatch(
        JSON.stringify(importedExperience),
        /private native prompt|private native answer/
      );
      assert.equal(
        (await runMemoryCapture(runtime.service, captureConfiguration))
          .appended,
        false
      );

      const proposalInput: MemoryProposalInput = {
        kind: "semantic",
        scope: { kind: "repository", workspaceId, repositoryId },
        claim: "The feature flag defaults to enabled.",
        experienceIds: [experience.id],
        evidence
      };
      const proposal = await runtime.service.propose(
        proposalInput,
        worker,
        readContext
      );
      const request: MemoryResearchRequest = {
        taskId,
        task: "Change a different source file without altering feature defaults.",
        query: "feature flag defaults enabled",
        context: readContext,
        relevantPaths: [fileReference.uri],
        asOf: now,
        maxPacketCharacters: 4000
      };
      const active = await runtime.service.verifyAndPromote(
        proposal.id,
        root,
        request
      );
      assert.equal(active.status, "active");

      const applicablePacket = await runtime.service.research(request);
      assert.equal(applicablePacket.entries.length, 1);
      assert.match(applicablePacket.text, /feature flag defaults to enabled/);
      assert.match(applicablePacket.text, new RegExp(sourceCommit));

      await writeFile(sourceFile, "export const enabledByDefault = false;\n");
      const stalePacket = await runtime.service.research(request);
      assert.equal(stalePacket.entries.length, 0);
      assert.equal(stalePacket.text, "");

      // Restore the exact bytes verified by the cited commit before exercising
      // procedure promotion later in this integration workflow.
      await writeFile(sourceFile, "export const enabledByDefault = true;\n");

      const expiredExperienceId = `experience-retention-${randomUUID()}`;
      await runtime.service.captureExperience(
        {
          source: "codex",
          transcript,
          trajectoryUri: `file://${repositoryRoot}/retention-trajectory.jsonl`,
          experience: {
            ...experience,
            id: expiredExperienceId,
            startedAt: "2026-09-30T10:00:00.000Z",
            completedAt: "2026-09-30T11:00:00.000Z"
          }
        },
        worker,
        readContext
      );
      const retention = await runtime.service.purgeExpiredExperiences({
        completedBefore: now,
        limit: 10,
        actor: root,
        context: { ...readContext, canReadTaskHistory: true }
      });
      assert.deepEqual(retention, {
        selected: 1,
        purged: 1,
        referencedByMemory: 0,
        noLongerVisible: 0
      });
      assert.equal(
        await runtime.service.getExperience(expiredExperienceId, readContext),
        null
      );
    } finally {
      await runtime?.close();
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  }
);

function execGit(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
