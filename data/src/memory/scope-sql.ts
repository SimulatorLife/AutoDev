import type {
  MemoryReadContext,
  MemoryScope
} from "@simulatorlife/autodev-core";

import { MemoryHydrationError } from "./errors.ts";

/**
 * Accumulates positional query parameters and hands back `$N` placeholders,
 * so SQL fragments can be composed without manual index arithmetic.
 */
export class SqlParams {
  private readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  get all(): readonly unknown[] {
    return this.values;
  }
}

/** Column prefix shared by every table that stores a flattened MemoryScope. */
export interface ScopeColumns {
  readonly kind: string;
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly role: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
}

export const SCOPE_COLUMNS: ScopeColumns = {
  kind: "scope_kind",
  workspaceId: "scope_workspace_id",
  repositoryId: "scope_repository_id",
  role: "scope_role",
  taskId: "scope_task_id",
  runId: "scope_run_id",
  agentId: "scope_agent_id"
};

/**
 * Builds the hard scope-visibility predicate mirroring
 * `isMemoryScopeVisibleTo` from core, so a row is only returned when the
 * caller's context genuinely resolves it. This predicate is always applied
 * before any ranking expression is computed.
 */
export function buildScopeFilterSql(
  alias: string,
  context: MemoryReadContext,
  params: SqlParams,
  columns: ScopeColumns = SCOPE_COLUMNS
): string {
  const canReadGlobal = params.add(context.canReadGlobal);
  const workspaceId = params.add(context.workspaceId);
  const repositoryId = params.add(context.repositoryId ?? null);
  const role = params.add(context.role ?? null);
  const taskId = params.add(context.taskId ?? null);
  const runId = params.add(context.runId ?? null);
  const agentId = params.add(context.agentId ?? null);

  const col = (name: string) => `${alias}.${name}`;

  const clauses = [
    `(${canReadGlobal}::boolean AND ${col(columns.kind)} = 'global')`,
    `(${col(columns.kind)} = 'workspace' AND ${col(columns.workspaceId)} = ${workspaceId})`,
    `(${col(columns.kind)} = 'repository' AND ${col(columns.workspaceId)} = ${workspaceId} AND ${col(columns.repositoryId)} = ${repositoryId})`,
    `(${col(columns.kind)} = 'role' AND ${col(columns.workspaceId)} = ${workspaceId} AND ${col(columns.role)} = ${role} AND (${col(columns.repositoryId)} IS NULL OR ${col(columns.repositoryId)} = ${repositoryId}))`,
    `(${col(columns.kind)} = 'task' AND ${col(columns.workspaceId)} = ${workspaceId} AND ${col(columns.taskId)} = ${taskId} AND ${col(columns.runId)} = ${runId})`,
    `(${col(columns.kind)} = 'agent' AND ${col(columns.workspaceId)} = ${workspaceId} AND ${col(columns.taskId)} = ${taskId} AND ${col(columns.runId)} = ${runId} AND ${col(columns.agentId)} = ${agentId})`
  ];

  return `(${clauses.join(" OR ")})`;
}

/**
 * Raw task/agent history may be read across runs only with an explicit
 * workspace-bounded curator grant. Durable memory records still use the
 * stricter exact-run `buildScopeFilterSql` predicate.
 */
export function buildExperienceScopeFilterSql(
  alias: string,
  context: MemoryReadContext,
  params: SqlParams
): string {
  const exact = buildScopeFilterSql(alias, context, params);
  if (!context.canReadTaskHistory) return exact;
  const taskScopeKinds = params.add(["task", "agent"]);
  const workspaceId = params.add(context.workspaceId);
  const repositoryFilter = context.repositoryId
    ? ` AND ${alias}.repository_id = ${params.add(context.repositoryId)}`
    : "";
  return `(${exact} OR (${alias}.scope_kind = ANY(${taskScopeKinds}::text[]) AND ${alias}.scope_workspace_id = ${workspaceId}${repositoryFilter}))`;
}

/** Flattens a MemoryScope into the column values written on insert/update. */
export function scopeToColumns(scope: MemoryScope): {
  scope_kind: string;
  scope_workspace_id: string | null;
  scope_repository_id: string | null;
  scope_role: string | null;
  scope_task_id: string | null;
  scope_run_id: string | null;
  scope_agent_id: string | null;
} {
  switch (scope.kind) {
    case "global": {
      return {
        scope_kind: "global",
        scope_workspace_id: null,
        scope_repository_id: null,
        scope_role: null,
        scope_task_id: null,
        scope_run_id: null,
        scope_agent_id: null
      };
    }
    case "workspace": {
      return {
        scope_kind: "workspace",
        scope_workspace_id: scope.workspaceId,
        scope_repository_id: null,
        scope_role: null,
        scope_task_id: null,
        scope_run_id: null,
        scope_agent_id: null
      };
    }
    case "repository": {
      return {
        scope_kind: "repository",
        scope_workspace_id: scope.workspaceId,
        scope_repository_id: scope.repositoryId,
        scope_role: null,
        scope_task_id: null,
        scope_run_id: null,
        scope_agent_id: null
      };
    }
    case "role": {
      return {
        scope_kind: "role",
        scope_workspace_id: scope.workspaceId,
        scope_repository_id: scope.repositoryId ?? null,
        scope_role: scope.role,
        scope_task_id: null,
        scope_run_id: null,
        scope_agent_id: null
      };
    }
    case "task": {
      return {
        scope_kind: "task",
        scope_workspace_id: scope.workspaceId,
        scope_repository_id: null,
        scope_role: null,
        scope_task_id: scope.taskId,
        scope_run_id: scope.runId,
        scope_agent_id: null
      };
    }
    case "agent": {
      return {
        scope_kind: "agent",
        scope_workspace_id: scope.workspaceId,
        scope_repository_id: null,
        scope_role: null,
        scope_task_id: scope.taskId,
        scope_run_id: scope.runId,
        scope_agent_id: scope.agentId
      };
    }
    default: {
      const exhaustive: never = scope;
      throw new Error(
        `Unhandled MemoryScope kind: ${JSON.stringify(exhaustive)}`
      );
    }
  }
}

/** Reconstructs a MemoryScope from the flattened columns on a row. */
export function columnsToScope(
  table: string,
  row: Record<string, unknown>
): MemoryScope {
  const kind = row.scope_kind;
  switch (kind) {
    case "global": {
      return { kind: "global" };
    }
    case "workspace": {
      return {
        kind: "workspace",
        workspaceId: requireString(table, row, "scope_workspace_id")
      };
    }
    case "repository": {
      return {
        kind: "repository",
        workspaceId: requireString(table, row, "scope_workspace_id"),
        repositoryId: requireString(table, row, "scope_repository_id")
      };
    }
    case "role": {
      const repositoryId = row.scope_repository_id;
      return {
        kind: "role",
        workspaceId: requireString(table, row, "scope_workspace_id"),
        role: requireString(table, row, "scope_role"),
        ...(typeof repositoryId === "string" ? { repositoryId } : {})
      };
    }
    case "task": {
      return {
        kind: "task",
        workspaceId: requireString(table, row, "scope_workspace_id"),
        taskId: requireString(table, row, "scope_task_id"),
        runId: requireString(table, row, "scope_run_id")
      };
    }
    case "agent": {
      return {
        kind: "agent",
        workspaceId: requireString(table, row, "scope_workspace_id"),
        taskId: requireString(table, row, "scope_task_id"),
        runId: requireString(table, row, "scope_run_id"),
        agentId: requireString(table, row, "scope_agent_id")
      };
    }
    default: {
      throw new MemoryHydrationError(
        table,
        "scope_kind",
        `unsupported value ${String(kind)}`
      );
    }
  }
}

function requireString(
  table: string,
  row: Record<string, unknown>,
  column: string
): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0) {
    throw new MemoryHydrationError(
      table,
      column,
      "expected a non-empty string"
    );
  }
  return value;
}
