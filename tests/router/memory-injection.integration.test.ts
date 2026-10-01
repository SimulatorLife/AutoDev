import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
  EvidenceReference,
  ExperienceEnvelope,
  MemoryActor,
  MemoryReadContext
} from "@simulatorlife/autodev-core";
import {
  applyMemoryMigrations,
  createPgMemoryPool
} from "@simulatorlife/autodev-data";
import {
  createPostgresMemoryHost,
  type MemoryProposalInput
} from "@simulatorlife/autodev-runtime/memory";

import { handleControlApiRequest } from "../../src/router/control-api.ts";
import {
  closeOrchestratorMemoryHost,
  injectOrchestratorMemory
} from "../../src/router/memory-injection.ts";

const databaseUrl = process.env.AUTODEV_MEMORY_ROUTER_TEST_DATABASE_URL;

test(
  "router JIT adapter injects only Git-verified MemoryService results into an orchestrator request",
  { skip: !databaseUrl },
  async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "autodev-router-memory-")
    );
    const identity = randomUUID();
    const repositoryId = `router-memory-${identity}`;
    const workspaceId = `workspace-${identity}`;
    const taskId = `task-${identity}`;
    const runId = `run-${identity}`;
    const sourceFile = join(repositoryRoot, "src", "feature.ts");
    const now = new Date().toISOString();
    const context: MemoryReadContext = {
      workspaceId,
      repositoryId,
      role: "orchestrator",
      taskId,
      runId,
      agentId: "root-thread",
      canReadGlobal: false
    };
    const rootActor: MemoryActor = { id: "root-thread", authority: "root" };
    const fileEvidence: EvidenceReference = {
      kind: "file",
      uri: pathToFileURL(sourceFile).href
    };
    let host: ReturnType<typeof createPostgresMemoryHost> | undefined;
    const previousMemoryUrl = process.env.AUTODEV_MEMORY_DATABASE_URL;
    const previousControlEnv = Object.fromEntries(
      [
        "AUTODEV_CONTROL_API_TOKEN",
        "AUTODEV_CONTROL_VIEWERS",
        "AUTODEV_CONTROL_OPERATORS",
        "CODEX_HOME",
        "AUTODEV_MEMORY_RECONSTRUCTION"
      ].map((key) => [key, process.env[key]])
    );
    const migrationPool = createPgMemoryPool({
      connectionString: databaseUrl!
    });

    try {
      await mkdir(join(repositoryRoot, "src"));
      await writeFile(sourceFile, "export const featureEnabled = true;\n");
      execGit(repositoryRoot, ["init", "-q"]);
      execGit(repositoryRoot, [
        "config",
        "user.name",
        "AutoDev Router Integration"
      ]);
      execGit(repositoryRoot, [
        "config",
        "user.email",
        "router-memory@example.invalid"
      ]);
      execGit(repositoryRoot, ["add", "src/feature.ts"]);
      execGit(repositoryRoot, ["commit", "-q", "-m", "Add feature setting"]);
      const sourceCommit = execGit(repositoryRoot, ["rev-parse", "HEAD"]);
      const evidence: EvidenceReference[] = [
        {
          kind: "commit",
          uri: `git://${encodeURIComponent(repositoryId)}/commit/${sourceCommit}`,
          revision: sourceCommit
        },
        fileEvidence
      ];
      await applyMemoryMigrations(migrationPool);
      host = createPostgresMemoryHost({ databaseUrl: databaseUrl! });
      const service = host.createService({
        resolve: async (readContext) =>
          readContext.repositoryId === repositoryId ? repositoryRoot : null
      });
      const experience: Omit<ExperienceEnvelope, "trajectory"> = {
        id: `experience-${identity}`,
        workspaceId,
        repositoryId,
        scope: { kind: "repository", workspaceId, repositoryId },
        taskId,
        runId,
        agentId: "root-thread",
        agentRole: "orchestrator",
        branch: "main",
        headCommit: sourceCommit,
        startedAt: now,
        outcome: "success",
        evidence
      };
      await service.appendExperience(
        {
          ...experience,
          trajectory: {
            format: "test-normalized-trajectory",
            uri: `file://${repositoryRoot}/trajectory.jsonl`,
            recordCount: 2
          }
        },
        rootActor,
        context
      );
      const candidate: MemoryProposalInput = {
        kind: "semantic",
        scope: { kind: "repository", workspaceId, repositoryId },
        claim: "The feature setting defaults to enabled.",
        experienceIds: [experience.id],
        evidence
      };
      const proposal = await service.propose(candidate, rootActor, context);
      await service.verifyAndPromote(proposal.id, rootActor, {
        taskId,
        task: "Where is the feature default defined?",
        query: "feature setting defaults enabled",
        context,
        asOf: now,
        maxPacketCharacters: 4000
      });

      process.env.AUTODEV_MEMORY_DATABASE_URL = databaseUrl;
      process.env.AUTODEV_MEMORY_RECONSTRUCTION = "deterministic";
      const request = {
        payload: {
          model: "autodev/orchestrator",
          instructions: "Root policy remains authoritative.",
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Where is the feature default defined?"
                }
              ]
            }
          ]
        },
        requestId: `request-${identity}`,
        sessionKey: `session-${identity}`,
        threadId: "root-thread",
        workspace: {
          key: repositoryId,
          cwd: repositoryRoot,
          workspace_id: workspaceId
        }
      };
      const injected = await injectOrchestratorMemory(request);
      assert.match(
        String(injected.instructions),
        /The feature setting defaults to enabled/
      );
      assert.match(
        String(injected.instructions),
        /Current repository files, RuleSync policy/
      );

      await writeFile(sourceFile, "export const featureEnabled = false;\n");
      const stale = await injectOrchestratorMemory(request);
      assert.doesNotMatch(
        String(stale.instructions),
        /The feature setting defaults to enabled/
      );
      // Restore the committed source so API verify/promote exercises the
      // compatible branch independently of the stale-memory assertion above.
      await writeFile(sourceFile, "export const featureEnabled = true;\n");

      process.env.AUTODEV_CONTROL_API_TOKEN =
        "router-memory-control-test-token";
      process.env.AUTODEV_CONTROL_VIEWERS = "memory-viewer";
      process.env.AUTODEV_CONTROL_OPERATORS = "memory-operator";
      const scopeQuery = new URLSearchParams({
        workspaceId,
        repositoryId
      }).toString();
      const listed = await callMemoryControlApi(
        "GET",
        `/control/memory/records?${scopeQuery}`,
        "memory-viewer"
      );
      assert.equal(listed.status, 200);
      assert.equal(listed.body.schema, "autodev-memory-records-v1");
      assert.ok(
        listed.body.items.some(
          (memory: { id: string }) => memory.id === proposal.id
        )
      );

      const apiProposal = await callMemoryControlApi(
        "POST",
        `/control/memory/records?${scopeQuery}`,
        "memory-operator",
        {
          kind: "procedural",
          scope: { kind: "repository", workspaceId, repositoryId },
          claim: "The API-reviewed procedure uses the current feature file.",
          experienceIds: [experience.id],
          evidence
        }
      );
      assert.equal(apiProposal.status, 200);
      assert.equal(apiProposal.body.memory.status, "proposed");
      const apiMemoryId = apiProposal.body.memory.id as string;

      const promoted = await callMemoryControlApi(
        "POST",
        `/control/memory/records/${encodeURIComponent(apiMemoryId)}/verify?${scopeQuery}`,
        "memory-operator",
        {
          task: "Check whether the feature procedure applies now.",
          query: "feature procedure current file",
          taskId
        }
      );
      assert.equal(promoted.status, 200);
      assert.equal(promoted.body.memory.status, "active");

      const why = await callMemoryControlApi(
        "GET",
        `/control/memory/records/${encodeURIComponent(apiMemoryId)}/why?${scopeQuery}`,
        "memory-viewer"
      );
      assert.equal(why.status, 200);
      assert.equal(why.body.schema, "autodev-memory-why-v1");
      assert.equal(why.body.sourceExperiences[0]?.id, experience.id);

      const invalidated = await callMemoryControlApi(
        "POST",
        `/control/memory/records/${encodeURIComponent(apiMemoryId)}/invalidate?${scopeQuery}`,
        "memory-operator",
        { evidence }
      );
      assert.equal(invalidated.status, 200);
      assert.equal(invalidated.body.memory.status, "invalidated");

      const validatedExperienceIds: string[] = [];
      for (const suffix of ["run-a", "run-b"]) {
        const experienceId = `promotion-${suffix}-${identity}`;
        const promotionTask = `${taskId}-${suffix}`;
        const promotionRun = `${runId}-${suffix}`;
        validatedExperienceIds.push(experienceId);
        await service.appendExperience(
          {
            ...experience,
            id: experienceId,
            taskId: promotionTask,
            runId: promotionRun,
            scope: { kind: "repository", workspaceId, repositoryId },
            outcome: "success",
            validation: { state: "passed", evidence },
            trajectory: {
              format: "test-normalized-trajectory",
              uri: `codex://session/${promotionRun}`,
              recordCount: 1
            }
          },
          rootActor,
          context
        );
      }
      const skillName = `verified-procedure-${identity}`;
      const procedure = await callMemoryControlApi(
        "POST",
        `/control/memory/records?${scopeQuery}`,
        "memory-operator",
        {
          kind: "procedural",
          scope: { kind: "repository", workspaceId, repositoryId },
          claim:
            "A repeated procedure is verified against current Git evidence.",
          experienceIds: validatedExperienceIds,
          evidence
        }
      );
      assert.equal(procedure.status, 200);
      const activatedProcedure = await callMemoryControlApi(
        "POST",
        `/control/memory/records/${encodeURIComponent(procedure.body.memory.id)}/verify?${scopeQuery}`,
        "memory-operator",
        {
          task: "Check the repeated procedure against current state.",
          query: "repeated procedure current Git evidence"
        }
      );
      assert.equal(activatedProcedure.status, 200);
      assert.equal(activatedProcedure.body.memory.status, "active");
      const promotedSkill = await callMemoryControlApi(
        "POST",
        `/control/memory/records/${encodeURIComponent(procedure.body.memory.id)}/promote-skill?${scopeQuery}`,
        "memory-operator",
        {
          skillName,
          description: "Use this when validating the feature setting.",
          content:
            "## Procedure\n\n1. Read the current setting.\n2. Run the focused checks.",
          task: "Promote the proven feature procedure.",
          query: "feature setting validation procedure"
        }
      );
      assert.equal(promotedSkill.status, 200);
      assert.equal(
        promotedSkill.body.schema,
        "autodev-memory-skill-promotion-v1"
      );
      assert.equal(promotedSkill.body.memory.status, "invalidated");
      assert.equal(promotedSkill.body.skill.name, skillName);
      assert.match(
        await readFile(
          join(repositoryRoot, ".rulesync", "skills", skillName, "SKILL.md"),
          "utf8"
        ),
        /Run the focused checks/
      );
      const repeatedPromotion = await callMemoryControlApi(
        "POST",
        `/control/memory/records/${encodeURIComponent(procedure.body.memory.id)}/promote-skill?${scopeQuery}`,
        "memory-operator",
        {
          skillName,
          description: "Use this when validating the feature setting.",
          content:
            "## Procedure\n\n1. Read the current setting.\n2. Run the focused checks.",
          task: "Promote the proven feature procedure.",
          query: "feature setting validation procedure"
        }
      );
      assert.equal(repeatedPromotion.status, 200);
      const promotionHistory = await service.history(
        procedure.body.memory.id as string,
        context
      );
      assert.equal(
        promotionHistory?.events.filter(
          (event) => event.action === "procedure_promoted"
        ).length,
        1,
        "repeating the same promotion is idempotent"
      );
      const changedSkillContent = await callMemoryControlApi(
        "POST",
        `/control/memory/records/${encodeURIComponent(procedure.body.memory.id)}/promote-skill?${scopeQuery}`,
        "memory-operator",
        {
          skillName,
          description: "A different description.",
          content: "Different canonical instructions.",
          task: "Promote the proven feature procedure.",
          query: "feature setting validation procedure"
        }
      );
      assert.equal(changedSkillContent.status, 409);

      const codexHome = join(repositoryRoot, "codex-home");
      const sessionsDirectory = join(codexHome, "sessions", "2026", "10", "01");
      const transcriptPath = join(sessionsDirectory, "session.jsonl");
      await mkdir(sessionsDirectory, { recursive: true });
      await writeFile(
        transcriptPath,
        [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: request.sessionKey,
              cwd: repositoryRoot,
              timestamp: now
            }
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: now,
            payload: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "private task text must not be stored"
                }
              ]
            }
          }),
          JSON.stringify({
            type: "response_item",
            timestamp: now,
            payload: {
              type: "message",
              role: "assistant",
              content: [
                { type: "output_text", text: "private tool observation" }
              ]
            }
          })
        ].join("\n")
      );
      process.env.CODEX_HOME = codexHome;
      const captureBody = {
        sessionId: request.sessionKey,
        transcriptPath,
        cwd: repositoryRoot
      };
      const capture = await callMemoryControlApi(
        "POST",
        "/control/memory/capture",
        "memory-operator",
        captureBody
      );
      assert.equal(capture.status, 200);
      assert.equal(capture.body.schema, "autodev-memory-capture-v1");
      assert.equal(capture.body.captured, true);
      const capturedId = `codex-session-${createHash("sha256")
        .update(request.sessionKey!)
        .digest("hex")}`;
      const captured = await service.getExperience(capturedId, {
        workspaceId,
        repositoryId,
        role: "orchestrator",
        taskId: request.sessionKey!,
        runId: request.sessionKey!,
        agentId: request.sessionKey!,
        canReadGlobal: false
      });
      assert.ok(captured);
      assert.equal(
        captured.trajectory.uri,
        `codex://session/${request.sessionKey}`
      );
      assert.equal(captured.scope.kind, "task");
      assert.doesNotMatch(
        JSON.stringify(captured),
        /private task text must not be stored|private tool observation/
      );
      assert.equal(
        JSON.stringify(captured).includes("transcriptPath"),
        false,
        "the absolute transcript path is not retained"
      );
      const duplicateCapture = await callMemoryControlApi(
        "POST",
        "/control/memory/capture",
        "memory-operator",
        captureBody
      );
      assert.equal(duplicateCapture.status, 200);
      assert.equal(duplicateCapture.body.captured, false);
      const outsideCapture = await callMemoryControlApi(
        "POST",
        "/control/memory/capture",
        "memory-operator",
        {
          ...captureBody,
          transcriptPath: join(repositoryRoot, "src", "feature.ts")
        }
      );
      assert.equal(outsideCapture.status, 400);
    } finally {
      await closeOrchestratorMemoryHost();
      await host?.close();
      await migrationPool.end();
      if (previousMemoryUrl === undefined)
        delete process.env.AUTODEV_MEMORY_DATABASE_URL;
      else process.env.AUTODEV_MEMORY_DATABASE_URL = previousMemoryUrl;
      for (const [key, value] of Object.entries(previousControlEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

async function callMemoryControlApi(
  method: string,
  url: string,
  actor: string,
  body?: unknown
): Promise<{ status: number; body: Record<string, any> }> {
  const bytes =
    body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = {
    host: "127.0.0.1",
    authorization: "Bearer router-memory-control-test-token",
    "x-autodev-actor": actor
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const request = {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      if (bytes.length > 0) yield bytes;
    }
  };
  const chunks: Buffer[] = [];
  const response = {
    statusCode: 0,
    headersSent: false,
    writableEnded: false,
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value);
    },
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
    },
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.writableEnded = true;
    }
  };
  await handleControlApiRequest(
    request as never,
    response as never,
    new URL(url, "http://127.0.0.1").pathname
  );
  return {
    status: response.statusCode,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      any
    >
  };
}
