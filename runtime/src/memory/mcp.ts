import { createHash } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  EvidenceReference,
  ExperienceEnvelope,
  MemoryActor,
  MemoryExecutionMode,
  MemoryReadContext,
  MemoryScope
} from "@simulatorlife/autodev-core";
import { z } from "zod/v4";

import { sanitizeEvidenceReference } from "./privacy.ts";
import {
  MemoryAuthorizationError,
  MemoryConflictError,
  type MemoryService,
  MemoryValidationError
} from "./service.ts";

export interface MemoryMcpSession {
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
  readonly taskId: string;
  readonly memoryMode: MemoryExecutionMode;
  /** Transient current task text; never accepted from tool arguments or persisted. */
  readonly task: string;
}

/**
 * The host binds authorization and scope to a trusted process/session. Tool
 * arguments can request a query but cannot choose an actor, workspace, role,
 * repository, task, or run.
 */
export interface MemoryMcpSessionProvider {
  current(researchQuery?: string): Promise<MemoryMcpSession> | MemoryMcpSession;
}

const memoryKind = z.enum(["episodic", "semantic", "procedural"]);
const evidenceReference = z
  .object({
    kind: z.enum([
      "trajectory",
      "trace",
      "file",
      "commit",
      "pull_request",
      "issue",
      "rule",
      "skill",
      "document",
      "other"
    ]),
    uri: z.string().min(1).max(2000),
    revision: z.string().max(300).optional(),
    observedAt: z.string().datetime().optional()
  })
  .strict();
const trajectoryReference = z
  .object({
    format: z.string().min(1).max(128),
    uri: z.string().min(1).max(2000),
    digest: z.string().regex(/^[a-f\d]{64}$/iu),
    recordCount: z.number().int().min(0).max(10_000_000).optional()
  })
  .strict();
const experienceOutcome = z.enum([
  "success",
  "partial",
  "failure",
  "cancelled",
  "unknown"
]);
const experienceValidation = z
  .object({
    state: z.enum(["passed", "failed", "partial", "not_run"]),
    evidence: z.array(evidenceReference).max(64)
  })
  .strict();
const memoryScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }).strict(),
  z
    .object({ kind: z.literal("workspace"), workspaceId: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("repository"),
      workspaceId: z.string().min(1),
      repositoryId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("role"),
      workspaceId: z.string().min(1),
      role: z.string().min(1),
      repositoryId: z.string().min(1).optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      workspaceId: z.string().min(1),
      taskId: z.string().min(1),
      runId: z.string().min(1)
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      workspaceId: z.string().min(1),
      taskId: z.string().min(1),
      runId: z.string().min(1),
      agentId: z.string().min(1)
    })
    .strict()
]);

const server = () =>
  new McpServer(
    { name: "autodev-memory", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

/** Build the standard MCP facade over the shared MemoryService. */
export function createMemoryMcpServer(
  service: MemoryService,
  sessionProvider: MemoryMcpSessionProvider
): McpServer {
  const mcp = server();

  mcp.registerTool(
    "experience_append",
    {
      description:
        "Append current-run reported metadata and source references. Workspace, task, run, agent, and role come from the trusted host session; transcript payloads stay in the source system. Outcome and validation are historical assertions, not canonical status; durable promotion still requires curator verification.",
      inputSchema: {
        trajectory: trajectoryReference,
        taskKind: z.string().max(200).optional(),
        provider: z.string().max(128).optional(),
        model: z.string().max(256).optional(),
        branch: z.string().max(512).optional(),
        baseCommit: z.string().max(300).optional(),
        headCommit: z.string().max(300).optional(),
        startedAt: z.string().datetime(),
        completedAt: z.string().datetime().optional(),
        outcome: experienceOutcome,
        validation: experienceValidation.optional(),
        evidence: z.array(evidenceReference).max(64).optional()
      }
    },
    (input) =>
      safely(async () => {
        const session = await sessionProvider.current();
        const { workspaceId, taskId, runId, agentId } = session.context;
        if (
          !workspaceId ||
          !taskId ||
          taskId !== session.taskId ||
          !runId ||
          !agentId
        ) {
          throw new MemoryAuthorizationError(
            "Experience append requires a host-bound workspace, task, run, and agent."
          );
        }
        const safeTrajectoryReference = sanitizeEvidenceReference({
          kind: "trajectory",
          uri: input.trajectory.uri
        });
        const trajectoryDigest = input.trajectory.digest.toLowerCase();
        const trajectoryEvidence: EvidenceReference = safeTrajectoryReference;
        const evidenceByIdentity = new Map<string, EvidenceReference>();
        for (const reference of [
          trajectoryEvidence,
          ...toEvidenceReferences(input.evidence ?? []).map(
            sanitizeEvidenceReference
          )
        ]) {
          evidenceByIdentity.set(
            `${reference.kind}\u0000${reference.uri}`,
            reference
          );
        }
        if (evidenceByIdentity.size > 64) {
          throw new MemoryValidationError(
            "Too many experience evidence references."
          );
        }
        const evidence = [...evidenceByIdentity.values()];
        const id = experienceAppendId({
          workspaceId,
          repositoryId: session.context.repositoryId,
          taskId,
          runId,
          agentId,
          trajectoryUri: safeTrajectoryReference.uri,
          trajectoryDigest
        });
        const experience: ExperienceEnvelope = {
          id,
          workspaceId,
          ...(session.context.repositoryId
            ? { repositoryId: session.context.repositoryId }
            : {}),
          scope: {
            kind: "agent",
            workspaceId,
            taskId,
            runId,
            agentId
          },
          taskId,
          runId,
          agentId,
          ...(session.actor.role ? { agentRole: session.actor.role } : {}),
          ...(input.taskKind ? { taskKind: input.taskKind } : {}),
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
          ...(input.headCommit ? { headCommit: input.headCommit } : {}),
          startedAt: input.startedAt,
          ...(input.completedAt ? { completedAt: input.completedAt } : {}),
          outcome: input.outcome,
          memoryMode: session.memoryMode,
          ...(input.validation
            ? {
                validation: {
                  state: input.validation.state,
                  evidence: toEvidenceReferences(input.validation.evidence)
                }
              }
            : {}),
          trajectory: {
            format: input.trajectory.format,
            uri: safeTrajectoryReference.uri,
            digest: trajectoryDigest,
            ...(input.trajectory.recordCount === undefined
              ? {}
              : { recordCount: input.trajectory.recordCount })
          },
          evidence
        };
        try {
          await service.appendExperience(
            experience,
            session.actor,
            session.context
          );
          return { id, appended: true };
        } catch (error) {
          if (!(error instanceof MemoryConflictError)) throw error;
          const existing = await service.getExperience(id, session.context);
          if (
            existing?.trajectory.uri === safeTrajectoryReference.uri &&
            existing.trajectory.digest === trajectoryDigest
          ) {
            return { id, appended: false };
          }
          throw error;
        }
      })
  );

  mcp.registerTool(
    "experience_search",
    {
      description:
        "Search scoped execution evidence by task, outcome, or source reference.",
      inputSchema: {
        query: z.string().min(1).max(4000),
        limit: z.number().int().min(1).max(40).optional()
      }
    },
    ({ query, limit }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.searchExperiences({
          query,
          context: session.context,
          ...(limit === undefined ? {} : { limit })
        });
      })
  );

  mcp.registerTool(
    "experience_get",
    {
      description:
        "Read a scoped experience envelope and its evidence references, not transcript payloads.",
      inputSchema: { id: z.string().min(1).max(200) }
    },
    ({ id }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.getExperience(id, session.context);
      })
  );

  mcp.registerTool(
    "memory_search",
    {
      description:
        "Search currently visible memory candidates; JIT research is preferred before applying remembered guidance.",
      inputSchema: {
        query: z.string().min(1).max(4000),
        taskKind: z.string().min(1).max(200).optional(),
        kinds: z.array(memoryKind).max(3).optional(),
        relevantPaths: z.array(z.string().min(1).max(500)).max(100).optional(),
        limit: z.number().int().min(1).max(40).optional()
      }
    },
    ({ query, taskKind, kinds, relevantPaths, limit }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.search({
          query,
          context: session.context,
          ...(taskKind ? { taskKind } : {}),
          ...(kinds ? { kinds } : {}),
          ...(relevantPaths ? { relevantPaths } : {}),
          ...(limit === undefined ? {} : { limit })
        });
      })
  );

  mcp.registerTool(
    "memory_get",
    {
      description:
        "Read a scoped memory record including its provenance and validity state.",
      inputSchema: { id: z.string().min(1).max(200) }
    },
    ({ id }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.get(id, session.context);
      })
  );

  mcp.registerTool(
    "memory_history",
    {
      description:
        "Read the lifecycle and supersession history for a visible memory record.",
      inputSchema: { id: z.string().min(1).max(200) }
    },
    ({ id }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.history(id, session.context);
      })
  );

  mcp.registerTool(
    "memory_why",
    {
      description:
        "Explain why a visible memory exists by returning its source experiences, evidence, verification, and lifecycle events.",
      inputSchema: { id: z.string().min(1).max(200) }
    },
    ({ id }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.why(id, session.context);
      })
  );

  mcp.registerTool(
    "memory_propose",
    {
      description:
        "Submit an evidence-backed candidate; proposals are not injected until a root/curator verifies and promotes them.",
      inputSchema: {
        kind: memoryKind,
        scope: memoryScope,
        claim: z.string().min(1).max(4000),
        experienceIds: z.array(z.string().min(1).max(200)).min(1).max(64),
        evidence: z.array(evidenceReference).min(1).max(64)
      }
    },
    ({ kind, scope, claim, experienceIds, evidence }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.propose(
          {
            kind,
            scope: toMemoryScope(scope),
            claim,
            experienceIds,
            evidence: toEvidenceReferences(evidence)
          },
          session.actor,
          session.context
        );
      })
  );

  mcp.registerTool(
    "memory_revise",
    {
      description:
        "Propose a revised record without changing the currently active claim; a curator must verify and supersede it.",
      inputSchema: {
        id: z.string().min(1).max(200),
        claim: z.string().min(1).max(4000),
        experienceIds: z.array(z.string().min(1).max(200)).min(1).max(64),
        evidence: z.array(evidenceReference).min(1).max(64)
      }
    },
    ({ id, claim, experienceIds, evidence }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.revise(
          id,
          { claim, experienceIds, evidence: toEvidenceReferences(evidence) },
          session.actor,
          session.context
        );
      })
  );

  mcp.registerTool(
    "memory_invalidate",
    {
      description:
        "Invalidate a visible stale or contradicted memory without deleting its historical evidence.",
      inputSchema: {
        id: z.string().min(1).max(200),
        evidence: z.array(evidenceReference).min(1).max(64)
      }
    },
    ({ id, evidence }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.invalidate(
          id,
          session.actor,
          session.context,
          toEvidenceReferences(evidence)
        );
      })
  );

  mcp.registerTool(
    "memory_research",
    {
      description:
        "Reconstruct a bounded advisory packet for the current task after checking memory against authoritative current state.",
      inputSchema: {
        query: z.string().min(1).max(4000),
        taskKind: z.string().min(1).max(200).optional(),
        relevantPaths: z.array(z.string().min(1).max(500)).max(100).optional(),
        maxPacketCharacters: z.number().int().min(0).max(24_000).default(8000)
      }
    },
    ({ query, taskKind, relevantPaths, maxPacketCharacters }) =>
      safely(async () => {
        const session = await sessionProvider.current(query);
        return service.research({
          taskId: session.taskId,
          task: session.task,
          query,
          context: session.context,
          maxPacketCharacters,
          ...(taskKind ? { taskKind } : {}),
          ...(relevantPaths ? { relevantPaths } : {})
        });
      })
  );

  return mcp;
}

async function safely<T>(operation: () => Promise<T>) {
  try {
    const result = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }]
    };
  } catch (error) {
    const text =
      error instanceof MemoryAuthorizationError
        ? "Memory operation is not authorized for this session."
        : error instanceof MemoryValidationError
          ? "Memory operation could not be completed with the supplied evidence or current record state."
          : "Memory operation failed.";
    return {
      isError: true,
      content: [{ type: "text" as const, text }]
    };
  }
}

function toMemoryScope(input: z.infer<typeof memoryScope>): MemoryScope {
  switch (input.kind) {
    case "global": {
      return { kind: "global" };
    }
    case "workspace": {
      return { kind: "workspace", workspaceId: input.workspaceId };
    }
    case "repository": {
      return {
        kind: "repository",
        workspaceId: input.workspaceId,
        repositoryId: input.repositoryId
      };
    }
    case "role": {
      return {
        kind: "role",
        workspaceId: input.workspaceId,
        role: input.role,
        ...(input.repositoryId === undefined
          ? {}
          : { repositoryId: input.repositoryId })
      };
    }
    case "task": {
      return {
        kind: "task",
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        runId: input.runId
      };
    }
    case "agent": {
      return {
        kind: "agent",
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId
      };
    }
    default: {
      const exhaustive: never = input;
      throw new Error(
        `Unsupported memory scope: ${JSON.stringify(exhaustive)}`
      );
    }
  }
}

function toEvidenceReferences(
  input: readonly z.infer<typeof evidenceReference>[]
): readonly EvidenceReference[] {
  return input.map((reference) => ({
    kind: reference.kind,
    uri: reference.uri,
    ...(reference.revision === undefined
      ? {}
      : { revision: reference.revision }),
    ...(reference.observedAt === undefined
      ? {}
      : { observedAt: reference.observedAt })
  }));
}

function experienceAppendId(input: {
  readonly workspaceId: string;
  readonly repositoryId: string | undefined;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly trajectoryUri: string;
  readonly trajectoryDigest: string;
}): string {
  const identity = JSON.stringify([
    input.workspaceId,
    input.repositoryId ?? "",
    input.taskId,
    input.runId,
    input.agentId,
    input.trajectoryUri,
    input.trajectoryDigest.toLowerCase()
  ]);
  return `experience-mcp-${createHash("sha256").update(identity).digest("hex")}`;
}
