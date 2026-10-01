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
          transcript: [
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
                content: [
                  { type: "output_text", text: "The default is enabled." }
                ]
              }
            }
          ]
            .map((event) => JSON.stringify(event))
            .join("\n"),
          trajectoryUri: `file://${repositoryRoot}/trajectory.jsonl`,
          experience
        },
        worker,
        readContext
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
