import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  EvidenceReference,
  MemoryActor,
  MemoryReadContext,
  MemoryScope
} from "@simulatorlife/autodev-core";
import { z } from "zod/v4";

import {
  MemoryAuthorizationError,
  type MemoryService,
  MemoryValidationError
} from "./service.ts";

export interface MemoryMcpSession {
  readonly actor: MemoryActor;
  readonly context: MemoryReadContext;
  readonly taskId: string;
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
const evidenceReference = z.object({
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
});
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
        kinds: z.array(memoryKind).max(3).optional(),
        relevantPaths: z.array(z.string().min(1).max(500)).max(100).optional(),
        limit: z.number().int().min(1).max(40).optional()
      }
    },
    ({ query, kinds, relevantPaths, limit }) =>
      safely(async () => {
        const session = await sessionProvider.current();
        return service.search({
          query,
          context: session.context,
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
        relevantPaths: z.array(z.string().min(1).max(500)).max(100).optional(),
        maxPacketCharacters: z.number().int().min(0).max(24_000).default(8000)
      }
    },
    ({ query, relevantPaths, maxPacketCharacters }) =>
      safely(async () => {
        const session = await sessionProvider.current(query);
        return service.research({
          taskId: session.taskId,
          task: session.task,
          query,
          context: session.context,
          maxPacketCharacters,
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
