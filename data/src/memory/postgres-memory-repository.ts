import { createHash } from "node:crypto";

import {
  assertMemoryInjectionOutcomeCohortFilter,
  assertMemoryInjectionUseCohortFilter,
  assertMemorySessionOutcomeCohortFilter,
  assertMemoryUseReportInvariants,
  type ExperienceEnvelope,
  type ExperienceListRequest,
  type ExperienceOutcome,
  type ExperienceSearchRequest,
  isMemoryInjectionSessionCardinality,
  isMemoryUseCohortEligibleMode,
  type MemoryAuthority,
  type MemoryExecutionMode,
  type MemoryExperiencePurgeRequest,
  type MemoryExperiencePurgeResult,
  type MemoryExpiredExperienceRequest,
  type MemoryHistory,
  type MemoryInjectionEvent,
  type MemoryInjectionEventSessionLookup,
  type MemoryInjectionOutcomeCohortCell,
  type MemoryInjectionOutcomeCohortFilter,
  type MemoryInjectionOutcomeCohortPage,
  type MemoryInjectionOutcomeJoin,
  type MemoryInjectionOutcomeJoinPage,
  type MemoryInjectionOutcomeJoinRequest,
  type MemoryInjectionResult,
  type MemoryInjectionUseCohortCell,
  type MemoryInjectionUseCohortFilter,
  type MemoryInjectionUseCohortPage,
  type MemoryInjectionUseJoin,
  type MemoryInjectionUseJoinPage,
  type MemoryInjectionUseJoinRequest,
  type MemoryLifecycleEvent,
  type MemoryListRequest,
  type MemoryOutcomeReport,
  type MemoryOutcomeReportKind,
  type MemoryPage,
  type MemoryReadContext,
  type MemoryRecord,
  type MemoryRecordInjectionEventInput,
  type MemoryRecordOutcomeReportInput,
  type MemoryRecordSessionOutcomeReportInput,
  type MemoryRecordUseReportInput,
  type MemoryRepository,
  type MemoryScope,
  type MemorySearchHit,
  type MemorySearchRequest,
  type MemorySessionCohortAssignedMode,
  type MemorySessionOutcomeCohortCell,
  type MemorySessionOutcomeCohortFilter,
  type MemorySessionOutcomeCohortPage,
  type MemorySessionOutcomeReport,
  type MemoryUseCohortEligibleMode,
  type MemoryUseKind,
  type MemoryUseReport,
  type MemoryVersionedUpdate,
  outcomeReportBodyMatches,
  sessionOutcomeReportBodyMatches,
  useReportBodyMatches
} from "@simulatorlife/autodev-core";

import {
  MemoryConflictError,
  MemoryHydrationError,
  MemoryLifecycleError,
  MemoryProvenanceError,
  MemoryVectorError
} from "./errors.ts";
import {
  hydrateExperienceRow,
  hydrateInjectionEventRow,
  hydrateInjectionUseReportRow,
  hydrateLifecycleEventRow,
  hydrateMemoryRecordRow,
  hydrateOutcomeReportRow,
  hydrateSessionOutcomeReportRow
} from "./hydration.ts";
import {
  type MemoryConnectionPool,
  withMemoryTransaction
} from "./query-client.ts";
import { MEMORY_EMBEDDING_DIMENSIONS } from "./schema.ts";
import {
  buildExperienceScopeFilterSql,
  buildScopeFilterSql,
  columnsToScope,
  scopeToColumns,
  SqlParams
} from "./scope-sql.ts";
import {
  buildExperienceListQuery,
  buildExperienceSearchQuery,
  buildExpiredExperienceQuery,
  buildMemoryListQuery,
  buildMemorySearchQuery,
  type VectorRankingWeights
} from "./search.ts";
import {
  buildInsert,
  experienceToRow,
  injectionEventToRow,
  injectionUseReportToRow,
  lifecycleEventToRow,
  memoryRecordToRow,
  outcomeReportToRow,
  sessionOutcomeReportToRow
} from "./serialize.ts";

export interface PostgresVectorSupport extends VectorRankingWeights {
  /** Fixed embedding width enforced by the pgvector column; must match every stored/queried vector. */
  readonly dimensions: number;
}

export interface PostgresMemoryRepositoryOptions {
  readonly pool: MemoryConnectionPool;
  /**
   * Declares that the existing provider/model adapter supplies embeddings of
   * the migrated width. PostgreSQL + pgvector itself is required by migration;
   * omitting this enables lexical/full-text queries when no embedder is wired.
   */
  readonly vectorSupport?: PostgresVectorSupport;
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

/**
 * Parses a `COUNT(...)::bigint` aggregate as a non-negative safe integer,
 * failing closed on malformed driver output instead of silently coercing
 * it (the pg driver returns bigint columns as strings).
 */
function parseCohortCount(value: unknown, column: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MemoryHydrationError(
      "memory_injection_events",
      column,
      `expected a non-negative safe integer, got ${String(value)}`
    );
  }
  return parsed;
}

/** Rejects missing, empty, non-finite, or dimension-mismatched vectors instead of silently coercing them. */
function validateEmbedding(
  embedding: readonly number[],
  expectedDimensions?: number
): void {
  if (embedding.length === 0) {
    throw new MemoryVectorError("embedding must not be empty");
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new MemoryVectorError(
        `embedding must contain only finite numbers, got ${value}`
      );
    }
  }
  if (
    expectedDimensions !== undefined &&
    embedding.length !== expectedDimensions
  ) {
    throw new MemoryVectorError(
      `embedding has ${embedding.length} dimensions, expected ${expectedDimensions}`
    );
  }
}

function buildSessionScopeFilter(
  alias: string,
  context: MemoryInjectionEventSessionLookup,
  params: SqlParams
): string {
  const workspaceId = params.add(context.workspaceId);
  const taskId = params.add(context.taskId);
  // The runtime path always supplies repositoryId, so an exact equality
  // check is sufficient and avoids the `=` operator. If
  // repositoryId is omitted, we deliberately skip the check (cross-repository
  // queries at the session level are not a documented capability).
  const repositoryClause = context.repositoryId
    ? ` AND ${alias}.repository_id = ${params.add(context.repositoryId)}`
    : "";
  return `(${alias}.scope_workspace_id = ${workspaceId}${repositoryClause} AND ${alias}.scope_task_id = ${taskId})`;
}

function assertTrustedUseReportScope(input: MemoryRecordUseReportInput): {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly taskId: string;
} {
  const { report, context, actor } = input;
  const repositoryId = context.repositoryId;
  const taskId = context.taskId;
  if (!repositoryId?.trim() || !taskId?.trim()) {
    throw new MemoryConflictError(
      "Injection use reports require a trusted repository and task scope."
    );
  }
  if (actor.authority !== "root" && actor.authority !== "curator") {
    throw new MemoryConflictError(
      "Injection use report reporter authority must be root or curator."
    );
  }
  if (!report.repositoryId.trim()) {
    throw new MemoryConflictError(
      "Injection use reports require a repository id."
    );
  }
  if (
    report.workspaceId !== context.workspaceId ||
    report.repositoryId !== repositoryId ||
    report.taskId !== taskId
  ) {
    throw new MemoryConflictError(
      "Injection use report identity must match trusted repository scope."
    );
  }
  return { workspaceId: context.workspaceId, repositoryId, taskId };
}

/**
 * Canonical PostgreSQL/pgvector implementation of the Core MemoryRepository
 * contract. It owns scope/status/validity enforcement, append-only
 * experience storage, versioned memory records, and transactional
 * lifecycle-event persistence; it never touches agent/trajectory internals
 * directly, only the typed Core contracts and references passed to it.
 * Embeddings are supplied by the caller (via the existing provider/model
 * abstraction) and only ever used/stored as an optional ranking signal
 * alongside full PostgreSQL full-text search, never computed here.
 */
export class PostgresMemoryRepository implements MemoryRepository {
  private readonly pool: MemoryConnectionPool;
  private readonly vectorSupport: PostgresVectorSupport | undefined;

  constructor(options: PostgresMemoryRepositoryOptions) {
    this.pool = options.pool;
    if (
      options.vectorSupport &&
      options.vectorSupport.dimensions !== MEMORY_EMBEDDING_DIMENSIONS
    ) {
      throw new MemoryVectorError(
        `configured vector width ${options.vectorSupport.dimensions} does not match the migrated width ${MEMORY_EMBEDDING_DIMENSIONS}`
      );
    }
    this.vectorSupport = options.vectorSupport;
  }

  async appendExperience(experience: ExperienceEnvelope): Promise<void> {
    const row = experienceToRow(experience);
    const { text, params } = buildInsert("memory_experiences", row);
    try {
      await this.pool.query(text, params);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new MemoryConflictError(
          `Experience ${experience.id} already exists`
        );
      }
      throw error;
    }
  }

  async getExperience(
    id: string,
    context: MemoryReadContext
  ): Promise<ExperienceEnvelope | null> {
    const params = new SqlParams();
    const idParam = params.add(id);
    const scopeFilter = buildExperienceScopeFilterSql(
      "memory_experiences",
      context,
      params
    );
    const text = `SELECT * FROM memory_experiences WHERE id = ${idParam} AND ${scopeFilter}`;
    const result = await this.pool.query(text, params.all);
    const row = result.rows[0];
    return row ? hydrateExperienceRow(row) : null;
  }

  async searchExperiences(
    request: ExperienceSearchRequest
  ): Promise<readonly ExperienceEnvelope[]> {
    const { text, params } = buildExperienceSearchQuery(request);
    const result = await this.pool.query(text, params);
    return result.rows.map((row) => hydrateExperienceRow(row));
  }

  async listExperiences(
    request: ExperienceListRequest
  ): Promise<MemoryPage<ExperienceEnvelope>> {
    const query = buildExperienceListQuery(request);
    const [count, rows] = await Promise.all([
      this.pool.query<{ total: string | number }>(
        query.countText,
        query.countParams
      ),
      this.pool.query(query.text, query.params)
    ]);
    return {
      items: rows.rows.map((row) => hydrateExperienceRow(row)),
      total: Number(count.rows[0]?.total ?? 0),
      limit: request.limit ?? 50,
      offset: request.offset ?? 0
    };
  }

  async listExpiredExperiences(
    request: MemoryExpiredExperienceRequest
  ): Promise<readonly ExperienceEnvelope[]> {
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 1000 ||
      !Number.isFinite(Date.parse(request.completedBefore))
    ) {
      throw new RangeError(
        "Memory experience retention scan bounds are invalid."
      );
    }
    const query = buildExpiredExperienceQuery(request);
    const result = await this.pool.query(query.text, query.params);
    return result.rows.map((row) => hydrateExperienceRow(row));
  }

  purgeExperience(
    request: MemoryExperiencePurgeRequest
  ): Promise<MemoryExperiencePurgeResult> {
    const params = new SqlParams();
    const idParam = params.add(request.experienceId);
    const scopeFilter = buildExperienceScopeFilterSql(
      "memory_experiences",
      request.context,
      params
    );
    const select = `SELECT id FROM memory_experiences WHERE id = ${idParam} AND ${scopeFilter} FOR UPDATE`;
    return withMemoryTransaction(this.pool, async (connection) => {
      const visible = await connection.query(select, params.all);
      if (visible.rowCount !== 1) return "not_visible";

      const reference = await connection.query(
        "SELECT id FROM memory_records WHERE provenance->'experienceIds' @> $1::jsonb LIMIT 1",
        [JSON.stringify([request.experienceId])]
      );
      if (reference.rowCount > 0) return "referenced_by_memory";

      const fingerprint = createHash("sha256")
        .update(request.experienceId, "utf8")
        .digest("hex");
      await connection.query(
        "SELECT set_config('autodev.memory_privacy_purge', 'on', true)"
      );
      const audit = buildInsert("memory_experience_privacy_events", {
        id: request.eventId,
        experience_fingerprint: fingerprint,
        actor_id: request.actorId,
        reason: request.reason,
        occurred_at: request.occurredAt
      });
      await connection.query(audit.text, audit.params);
      const deleted = await connection.query(
        `DELETE FROM memory_experiences WHERE id = ${idParam} AND ${scopeFilter}`,
        params.all
      );
      if (deleted.rowCount !== 1)
        throw new MemoryConflictError(
          "The experience changed during its privacy/retention purge."
        );
      return "purged";
    });
  }

  async proposeMemory(
    candidate: MemoryRecord,
    event: MemoryLifecycleEvent,
    embedding?: readonly number[]
  ): Promise<void> {
    if (event.memoryId !== candidate.id) {
      throw new MemoryLifecycleError(
        `Lifecycle event memoryId ${event.memoryId} does not match candidate id ${candidate.id}`
      );
    }
    if (event.action !== "proposed" && event.action !== "revised") {
      throw new MemoryLifecycleError(
        `proposeMemory requires a 'proposed' or 'revised' lifecycle event, got '${event.action}'`
      );
    }
    if (
      candidate.status !== "proposed" ||
      candidate.validity.state !== "unverified"
    ) {
      throw new MemoryLifecycleError(
        "New memory records must enter storage as unverified proposals."
      );
    }
    if (event.action === "proposed" && event.relatedMemoryIds.length > 0) {
      throw new MemoryLifecycleError(
        "A new proposal cannot claim a prior memory revision target."
      );
    }
    if (event.action === "revised" && event.relatedMemoryIds.length !== 1) {
      throw new MemoryLifecycleError(
        "A revision proposal must name exactly one existing memory."
      );
    }
    if (event.toStatus !== candidate.status) {
      throw new MemoryLifecycleError(
        `Lifecycle event toStatus '${event.toStatus}' does not match candidate status '${candidate.status}'`
      );
    }

    let embeddingLiteral: string | undefined;
    if (embedding) {
      validateEmbedding(embedding, this.vectorSupport?.dimensions);
      if (!this.vectorSupport) {
        throw new MemoryVectorError(
          "an embedding was supplied but this repository has no pgvector support configured"
        );
      }
      embeddingLiteral = `[${embedding.join(",")}]`;
    }

    if (
      candidate.provenance.experienceIds.length === 0 ||
      candidate.provenance.evidence.length === 0
    ) {
      throw new MemoryProvenanceError(
        "A durable memory requires source experience and evidence references."
      );
    }

    await withMemoryTransaction(this.pool, async (connection) => {
      if (event.action === "revised") {
        const priorId = event.relatedMemoryIds[0]!;
        const priorResult = await connection.query(
          "SELECT * FROM memory_records WHERE id = $1 FOR SHARE",
          [priorId]
        );
        const prior = priorResult.rows[0];
        if (!prior)
          throw new MemoryProvenanceError(
            `Revision target ${priorId} does not exist.`
          );
        if (prior.status !== "active" && prior.status !== "uncertain") {
          throw new MemoryLifecycleError(
            "Only active or uncertain records can receive revision proposals."
          );
        }
        const priorScope = columnsToScope("memory_records", prior);
        if (
          prior.kind !== candidate.kind ||
          JSON.stringify(scopeToColumns(priorScope)) !==
            JSON.stringify(scopeToColumns(candidate.scope))
        ) {
          throw new MemoryLifecycleError(
            "A revision proposal must preserve memory kind and exact scope."
          );
        }
      }
      if (candidate.provenance.experienceIds.length > 0) {
        // Hold key-share locks until the proposal and its provenance commit.
        // A concurrent privacy purge takes FOR UPDATE on these same rows, so
        // either the proposal commits first and the purge sees its reference,
        // or the purge commits first and this proposal rejects the missing
        // experience. Sorting provides a consistent lock order for proposals
        // that cite overlapping experience sets.
        const experienceIds = [
          ...new Set(candidate.provenance.experienceIds)
        ].sort();
        const existing = await connection.query<{ id: string }>(
          "SELECT id FROM memory_experiences WHERE id = ANY($1::text[]) ORDER BY id FOR KEY SHARE",
          [experienceIds]
        );
        const foundIds = new Set(existing.rows.map((row) => row.id));
        const missing = experienceIds.filter((id) => !foundIds.has(id));
        if (missing.length > 0) {
          throw new MemoryProvenanceError(
            `Memory ${candidate.id} references unknown experience ids: ${missing.join(", ")}`
          );
        }
      }

      const row: Record<string, unknown> = { ...memoryRecordToRow(candidate) };
      const casts: Record<string, string> = {};
      if (embeddingLiteral !== undefined) {
        row.embedding = embeddingLiteral;
        casts.embedding = "vector";
      }

      const recordInsert = buildInsert("memory_records", row, casts);
      try {
        await connection.query(recordInsert.text, recordInsert.params);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new MemoryConflictError(
            `Memory ${candidate.id} already exists`
          );
        }
        throw error;
      }

      const eventInsert = buildInsert(
        "memory_lifecycle_events",
        lifecycleEventToRow(event)
      );
      await connection.query(eventInsert.text, eventInsert.params);
    });
  }

  async getMemory(
    id: string,
    context: MemoryReadContext
  ): Promise<MemoryRecord | null> {
    const params = new SqlParams();
    const idParam = params.add(id);
    const scopeFilter = buildScopeFilterSql("memory_records", context, params);
    const text = `SELECT * FROM memory_records WHERE id = ${idParam} AND ${scopeFilter}`;
    const result = await this.pool.query(text, params.all);
    const row = result.rows[0];
    return row ? hydrateMemoryRecordRow(row) : null;
  }

  async searchMemories(
    request: MemorySearchRequest
  ): Promise<readonly MemorySearchHit[]> {
    if (request.queryEmbedding) {
      if (!this.vectorSupport) {
        throw new MemoryVectorError(
          "queryEmbedding was supplied without configured pgvector ranking support"
        );
      }
      validateEmbedding(request.queryEmbedding, this.vectorSupport.dimensions);
    }

    const usesVector = request.queryEmbedding !== undefined;
    const { text, params } = buildMemorySearchQuery(
      request,
      this.vectorSupport
    );
    const result = await this.pool.query(text, params);
    return result.rows.map((row) => ({
      memory: hydrateMemoryRecordRow(row),
      score: Number(row.score),
      matchedSignals: [
        ...(Number(row.lexical_score ?? 0) > 0 ? (["lexical"] as const) : []),
        ...(usesVector && row.embedding !== null && row.embedding !== undefined
          ? (["semantic"] as const)
          : []),
        ...(Number(row.path_score ?? 0) > 0 ? (["path"] as const) : []),
        ...(Number(row.task_kind_score ?? 0) > 0
          ? (["task_kind"] as const)
          : [])
      ]
    }));
  }

  async listMemories(
    request: MemoryListRequest
  ): Promise<MemoryPage<MemoryRecord>> {
    const query = buildMemoryListQuery(request);
    const [count, rows] = await Promise.all([
      this.pool.query<{ total: string | number }>(
        query.countText,
        query.countParams
      ),
      this.pool.query(query.text, query.params)
    ]);
    return {
      items: rows.rows.map((row) => hydrateMemoryRecordRow(row)),
      total: Number(count.rows[0]?.total ?? 0),
      limit: request.limit ?? 50,
      offset: request.offset ?? 0
    };
  }

  async getMemoryHistory(
    id: string,
    context: MemoryReadContext
  ): Promise<MemoryHistory | null> {
    const memory = await this.getMemory(id, context);
    if (!memory) return null;

    const eventsResult = await this.pool.query(
      "SELECT * FROM memory_lifecycle_events WHERE memory_id = $1 OR related_memory_ids @> $2::jsonb ORDER BY occurred_at ASC",
      [id, JSON.stringify([id])]
    );
    const events = eventsResult.rows.map((row) =>
      hydrateLifecycleEventRow(row)
    );

    const relatedIds = new Set<string>();
    for (const relatedId of [
      ...(memory.supersedes ?? []),
      ...(memory.supersededBy ?? [])
    ]) {
      relatedIds.add(relatedId);
    }
    for (const relatedEvent of events) {
      if (relatedEvent.memoryId !== memory.id)
        relatedIds.add(relatedEvent.memoryId);
      for (const relatedId of relatedEvent.relatedMemoryIds)
        relatedIds.add(relatedId);
    }
    relatedIds.delete(memory.id);

    let relatedMemories: readonly MemoryRecord[] = [];
    if (relatedIds.size > 0) {
      const params = new SqlParams();
      const idsParam = params.add([...relatedIds]);
      const scopeFilter = buildScopeFilterSql(
        "memory_records",
        context,
        params
      );
      const text = `SELECT * FROM memory_records WHERE id = ANY(${idsParam}::text[]) AND ${scopeFilter}`;
      const relatedResult = await this.pool.query(text, params.all);
      relatedMemories = relatedResult.rows.map((row) =>
        hydrateMemoryRecordRow(row)
      );
    }

    return { memory, relatedMemories, events };
  }

  async transitionMemories(
    changes: readonly MemoryVersionedUpdate[],
    events: readonly MemoryLifecycleEvent[]
  ): Promise<boolean> {
    const changesById = new Map(
      changes.map((change) => [change.next.id, change.next])
    );
    if (
      changes.some(
        (change) =>
          !events.some(
            (event) =>
              event.memoryId === change.next.id &&
              event.toStatus === change.next.status
          )
      ) ||
      events.some(
        (event) => changesById.get(event.memoryId)?.status !== event.toStatus
      )
    ) {
      throw new MemoryLifecycleError(
        "Every memory state change requires a matching append-only lifecycle event."
      );
    }
    try {
      return await withMemoryTransaction(this.pool, async (connection) => {
        for (const change of changes) {
          const row = memoryRecordToRow(change.next);
          const columns = Object.keys(row).filter((column) => column !== "id");
          const setClause = columns
            .map((column, index) => `${column} = $${index + 3}`)
            .join(", ");
          const text = `UPDATE memory_records SET ${setClause} WHERE id = $1 AND updated_at = $2 RETURNING id`;
          const params = [
            change.next.id,
            change.expectedUpdatedAt,
            ...columns.map((column) => row[column])
          ];
          // Updates must apply in order on the same transaction connection so an
          // earlier stale rejection aborts every later change in this batch.
          // eslint-disable-next-line no-await-in-loop -- same transaction connection; order matters
          const result = await connection.query(text, params);
          if (result.rowCount !== 1) {
            throw new MemoryConflictError(
              `Stale update rejected for memory ${change.next.id}: expected updatedAt ${change.expectedUpdatedAt}`
            );
          }
        }

        for (const event of events) {
          const eventInsert = buildInsert(
            "memory_lifecycle_events",
            lifecycleEventToRow(event)
          );
          // Same transaction connection; sequential writes, not independent requests.
          // eslint-disable-next-line no-await-in-loop -- same transaction connection; sequential writes
          await connection.query(eventInsert.text, eventInsert.params);
        }

        return true;
      });
    } catch (error) {
      if (error instanceof MemoryConflictError) return false;
      throw error;
    }
  }

  async recordInjectionEvent(
    input: MemoryRecordInjectionEventInput
  ): Promise<{ readonly appended: boolean; readonly id: string }> {
    const { event } = input;
    // Session-level write-scope authorization: only workspace, repository,
    // and task identity are checked against the trusted context.
    // `runId`/`agentId` are the event's own request-level identity
    // (requestId/threadId) and are intentionally NOT required to equal the
    // caller context's runId/agentId, mirroring the session-level join used
    // by findInjectionEventByTokenForSession/listInjectionOutcomeJoins.
    if (
      event.workspaceId !== input.context.workspaceId ||
      (event.repositoryId !== undefined &&
        event.repositoryId !== input.context.repositoryId) ||
      event.scope.kind === "global" ||
      event.scope.workspaceId !== event.workspaceId ||
      event.taskId !== input.context.taskId
    ) {
      throw new MemoryConflictError(
        "Injection event scope does not match the trusted session."
      );
    }
    const existing = await this.findInjectionEventByTokenForSession(
      {
        workspaceId: event.workspaceId,
        ...(event.repositoryId === undefined
          ? {}
          : { repositoryId: event.repositoryId }),
        taskId: event.taskId,
        ...(event.runId === undefined ? {} : { runId: event.runId }),
        ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        canReadGlobal: false
      },
      event.correlationToken
    );
    if (existing) {
      if (existing.id !== event.id)
        throw new MemoryConflictError(
          "Injection event correlationToken is already recorded with a different id."
        );
      return { appended: false, id: existing.id };
    }
    const row = injectionEventToRow(event);
    const insert = buildInsert("memory_injection_events", row);
    try {
      await this.pool.query(insert.text, insert.params);
      return { appended: true, id: event.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new MemoryConflictError(
          `Injection event ${event.id} already exists`
        );
      }
      throw error;
    }
  }

  async recordOutcomeReport(
    input: MemoryRecordOutcomeReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }> {
    const { report } = input;
    // Authority is owned by the trusted MemoryActor; "worker" and "system"
    // never appear in the stored column. The Control API path maps an
    // authenticated operator to `root`, and the runtime emits only injection
    // events. Reject anything else here so the database column never accepts
    // an unauthorized value even if the service is bypassed.
    if (
      input.actor.authority !== "root" &&
      input.actor.authority !== "curator"
    ) {
      throw new MemoryConflictError(
        "Outcome report reporter authority must be root or curator."
      );
    }
    // The Data boundary enforces the evidence requirement so a caller cannot
    // bypass it by skipping the MemoryService layer.
    if (report.outcomeKind !== "unknown" && report.evidence.length === 0) {
      throw new MemoryConflictError(
        "Non-unknown outcome reports require at least one evidence reference."
      );
    }
    // The trusted session context -- never the caller-supplied report
    // object -- is the sole source of workspace/repository/task/run/agent
    // identity for both the injection lookup and the persisted row. A
    // report whose own workspaceId/repositoryId/taskId diverges from the
    // context therefore fails with the same "no scope-aligned injection
    // event" signal as an unknown token, rather than leaking which part of
    // a forged/stale scope was wrong.
    if (!input.context.taskId) {
      throw new MemoryConflictError(
        "Outcome report requires a trusted session task context."
      );
    }
    // Scope-aligned injection must already exist; the Control API does this
    // check first, but the repository never trusts a missing linkage.
    const matched = await this.findInjectionEventByTokenForSession(
      {
        workspaceId: input.context.workspaceId,
        ...(input.context.repositoryId
          ? { repositoryId: input.context.repositoryId }
          : {}),
        taskId: input.context.taskId,
        ...(input.context.runId === undefined
          ? {}
          : { runId: input.context.runId }),
        ...(input.context.agentId === undefined
          ? {}
          : { agentId: input.context.agentId }),
        canReadGlobal: false
      },
      report.correlationToken
    );
    if (!matched) {
      throw new MemoryConflictError(
        "Outcome report targets a correlationToken that has no scope-aligned injection event."
      );
    }
    const scope: MemoryScope = {
      kind: "task",
      workspaceId: input.context.workspaceId,
      taskId: input.context.taskId,
      runId: input.context.runId ?? input.context.taskId
    };
    const storedReport: MemoryOutcomeReport = {
      ...report,
      reporterId: input.actor.id,
      reporterAuthority: input.actor.authority,
      workspaceId: input.context.workspaceId,
      ...(input.context.repositoryId
        ? { repositoryId: input.context.repositoryId }
        : {}),
      scope,
      taskId: input.context.taskId,
      runId: input.context.runId ?? input.context.taskId,
      agentId: input.context.agentId ?? input.context.taskId
    };
    // One outcome report per correlationToken: a scope-aligned retry with an
    // identical body is idempotent and returns `appended: false`; a retry
    // with a different body for the same token conflicts.
    const existingReport = await this.findOutcomeReportByToken(
      storedReport.workspaceId,
      storedReport.correlationToken
    );
    if (existingReport) {
      if (outcomeReportBodyMatches(existingReport, storedReport)) {
        return { appended: false, id: existingReport.id };
      }
      throw new MemoryConflictError(
        "Outcome report conflicts with a previously recorded report for this correlation token."
      );
    }
    const row = outcomeReportToRow(storedReport);
    const insert = buildInsert("memory_outcome_reports", row);
    try {
      await this.pool.query(insert.text, insert.params);
      return { appended: true, id: storedReport.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Race: another writer inserted between our lookup and this insert.
        // Re-check for idempotency before surfacing a hard conflict.
        const racedExisting = await this.findOutcomeReportByToken(
          storedReport.workspaceId,
          storedReport.correlationToken
        );
        if (
          racedExisting &&
          outcomeReportBodyMatches(racedExisting, storedReport)
        ) {
          return { appended: false, id: racedExisting.id };
        }
        throw new MemoryConflictError(
          `Outcome report ${storedReport.id} already exists for this scope and report key.`
        );
      }
      throw error;
    }
  }

  async findInjectionEventByTokenForSession(
    context: MemoryInjectionEventSessionLookup,
    correlationToken: string
  ): Promise<MemoryInjectionEvent | null> {
    if (!correlationToken.trim()) return null;
    const params = new SqlParams();
    const tokenParam = params.add(correlationToken);
    const workspaceId = params.add(context.workspaceId);
    const taskId = params.add(context.taskId);
    const repositoryClause = context.repositoryId
      ? ` AND repository_id = ${params.add(context.repositoryId)}`
      : "";
    const text = `SELECT * FROM memory_injection_events
      WHERE correlation_token = ${tokenParam}
        AND scope_workspace_id = ${workspaceId}${repositoryClause}
        AND scope_task_id = ${taskId}
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1`;
    const result = await this.pool.query(text, params.all);
    const matched = result.rows[0];
    return matched ? hydrateInjectionEventRow(matched) : null;
  }

  async getInjectionEventByIdForSession(
    context: MemoryInjectionEventSessionLookup,
    injectionEventId: string
  ): Promise<MemoryInjectionEvent | null> {
    if (
      !injectionEventId.trim() ||
      !context.workspaceId.trim() ||
      !context.repositoryId?.trim() ||
      !context.taskId.trim()
    ) {
      return null;
    }
    const result = await this.pool.query(
      `SELECT * FROM memory_injection_events
       WHERE id = $1
         AND workspace_id = $2 AND repository_id = $3 AND task_id = $4
         AND scope_workspace_id = $2 AND scope_task_id = $4
       LIMIT 1`,
      [
        injectionEventId,
        context.workspaceId,
        context.repositoryId,
        context.taskId
      ]
    );
    const row = result.rows[0];
    return row ? hydrateInjectionEventRow(row) : null;
  }

  async recordInjectionUseReport(
    input: MemoryRecordUseReportInput
  ): Promise<{ readonly appended: boolean; readonly id: string }> {
    const { report, context, actor } = input;
    const { workspaceId, repositoryId, taskId } =
      assertTrustedUseReportScope(input);

    const sessionLookup: MemoryInjectionEventSessionLookup = {
      workspaceId,
      repositoryId,
      taskId,
      ...(context.runId === undefined ? {} : { runId: context.runId }),
      ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
      canReadGlobal: false
    };
    const injection = await this.getInjectionEventByIdForSession(
      sessionLookup,
      report.injectionEventId
    );
    if (!injection) {
      throw new MemoryConflictError(
        "Injection use report targets an event that has no scope-aligned injection."
      );
    }
    try {
      assertMemoryUseReportInvariants(report, injection);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new MemoryConflictError(error.message);
      }
      throw error;
    }

    const sessionScope: MemoryScope = {
      kind: "task",
      workspaceId,
      taskId,
      runId: context.runId ?? taskId
    };
    const storedReport: MemoryUseReport = {
      ...report,
      injectionEventId: injection.id,
      workspaceId,
      repositoryId,
      scope: sessionScope,
      taskId,
      runId: context.runId ?? taskId,
      agentId: context.agentId ?? taskId,
      ...(context.role === undefined ? {} : { agentRole: context.role }),
      correlationToken: injection.correlationToken,
      reporterId: actor.id,
      reporterAuthority: actor.authority
    };

    const existing = await this.getInjectionUseReport(
      workspaceId,
      injection.correlationToken
    );
    if (existing) {
      if (useReportBodyMatches(existing, storedReport)) {
        return { appended: false, id: existing.id };
      }
      throw new MemoryConflictError(
        "Injection use report conflicts with a previously recorded report for this event."
      );
    }

    const insert = buildInsert(
      "memory_injection_use_reports",
      injectionUseReportToRow(storedReport)
    );
    try {
      await this.pool.query(insert.text, insert.params);
      return { appended: true, id: storedReport.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const racedExisting = await this.getInjectionUseReport(
          workspaceId,
          injection.correlationToken
        );
        if (
          racedExisting &&
          useReportBodyMatches(racedExisting, storedReport)
        ) {
          return { appended: false, id: racedExisting.id };
        }
        throw new MemoryConflictError(
          `Injection use report ${storedReport.id} already exists for this event.`
        );
      }
      throw error;
    }
  }

  async getInjectionUseReport(
    workspaceId: string,
    correlationToken: string
  ): Promise<MemoryUseReport | null> {
    if (!workspaceId.trim() || !correlationToken.trim()) return null;
    const result = await this.pool.query(
      `SELECT * FROM memory_injection_use_reports
       WHERE workspace_id = $1 AND correlation_token = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [workspaceId, correlationToken]
    );
    const row = result.rows[0];
    return row ? hydrateInjectionUseReportRow(row) : null;
  }

  async listInjectionUseJoins(
    request: MemoryInjectionUseJoinRequest
  ): Promise<MemoryInjectionUseJoinPage> {
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 100);
    const offset = Math.max(request.offset ?? 0, 0);
    const { workspaceId, repositoryId, taskId } = request.context;
    if (!repositoryId?.trim() || !taskId?.trim()) {
      return { items: [], total: 0, limit, offset };
    }

    const params = new SqlParams();
    const workspaceParam = params.add(workspaceId);
    const taskParam = params.add(taskId);
    const repositoryParam = params.add(repositoryId);
    const filters = [
      `i.workspace_id = ${workspaceParam}`,
      `i.repository_id = ${repositoryParam}`,
      `i.task_id = ${taskParam}`,
      `i.scope_workspace_id = ${workspaceParam}`,
      `i.scope_task_id = ${taskParam}`,
      `i.injection_result = 'injected'`,
      `i.memory_mode IN ('jit', 'retrieval-only')`,
      `jsonb_array_length(i.memory_ids) > 0`
    ];
    if (request.memoryModes && request.memoryModes.length > 0) {
      filters.push(
        `i.memory_mode = ANY(${params.add(request.memoryModes)}::text[])`
      );
    }
    if (request.injectionResults && request.injectionResults.length > 0) {
      filters.push(
        `i.injection_result = ANY(${params.add(request.injectionResults)}::text[])`
      );
    }
    if (request.useKinds && request.useKinds.length > 0) {
      filters.push(`r.use_kind = ANY(${params.add(request.useKinds)}::text[])`);
    }
    if (request.includeUnassessed !== true) filters.push(`r.id IS NOT NULL`);
    const whereClause = filters.join(" AND ");
    // Freeze the count-query parameters before pagination placeholders mutate
    // SqlParams; its `all` getter exposes the backing array.
    const filterParams = [...params.all];
    const limitParam = params.add(limit);
    const offsetParam = params.add(offset);
    const pageText = `
      WITH session_counts AS MATERIALIZED (
        SELECT si.workspace_id, si.repository_id, si.task_id,
               COUNT(*)::bigint AS session_injection_count
        FROM memory_injection_events si
        WHERE si.workspace_id = ${workspaceParam}
          AND si.repository_id = ${repositoryParam}
          AND si.task_id = ${taskParam}
        GROUP BY si.workspace_id, si.repository_id, si.task_id
      )
      SELECT i.*, sc.session_injection_count,
             r.id AS use_report_id,
             r.injection_event_id AS use_report_injection_event_id,
             r.workspace_id AS use_report_workspace_id,
             r.repository_id AS use_report_repository_id,
             r.scope_kind AS use_report_scope_kind,
             r.scope_workspace_id AS use_report_scope_workspace_id,
             r.scope_repository_id AS use_report_scope_repository_id,
             r.scope_role AS use_report_scope_role,
             r.scope_task_id AS use_report_scope_task_id,
             r.scope_run_id AS use_report_scope_run_id,
             r.scope_agent_id AS use_report_scope_agent_id,
             r.task_id AS use_report_task_id,
             r.run_id AS use_report_run_id,
             r.agent_id AS use_report_agent_id,
             r.agent_role AS use_report_agent_role,
             r.correlation_token AS use_report_correlation_token,
             r.use_kind AS use_report_kind,
             r.used_memory_ids AS use_report_memory_ids,
             r.reported_at AS use_report_reported_at,
             r.reporter_id AS use_report_reporter_id,
             r.reporter_authority AS use_report_reporter_authority,
             r.reason_code AS use_report_reason_code,
             r.evidence AS use_report_evidence
      FROM memory_injection_events i
      JOIN session_counts sc
        ON sc.workspace_id = i.workspace_id
       AND sc.repository_id IS NOT DISTINCT FROM i.repository_id
       AND sc.task_id = i.task_id
      LEFT JOIN memory_injection_use_reports r
        ON r.workspace_id = i.workspace_id
       AND r.repository_id = i.repository_id
       AND r.correlation_token = i.correlation_token
       AND r.injection_event_id = i.id
      WHERE ${whereClause}
      ORDER BY i.occurred_at DESC, i.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;
    const rows = await this.pool.query(pageText, params.all);
    const count = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::bigint AS total
       FROM memory_injection_events i
       LEFT JOIN memory_injection_use_reports r
         ON r.workspace_id = i.workspace_id
        AND r.repository_id = i.repository_id
        AND r.correlation_token = i.correlation_token
        AND r.injection_event_id = i.id
       WHERE ${whereClause}`,
      filterParams
    );
    const items: MemoryInjectionUseJoin[] = rows.rows.map((row) => {
      const injection = hydrateInjectionEventRow(row);
      const sessionInjectionCount = parseCohortCount(
        row.session_injection_count,
        "session_injection_count"
      );
      if (!row.use_report_id) {
        return { injection, use: null, sessionInjectionCount };
      }
      const reportRow: Record<string, unknown> = {
        id: row.use_report_id,
        injection_event_id: row.use_report_injection_event_id,
        workspace_id: row.use_report_workspace_id,
        repository_id: row.use_report_repository_id,
        scope_kind: row.use_report_scope_kind,
        scope_workspace_id: row.use_report_scope_workspace_id,
        scope_repository_id: row.use_report_scope_repository_id,
        scope_role: row.use_report_scope_role,
        scope_task_id: row.use_report_scope_task_id,
        scope_run_id: row.use_report_scope_run_id,
        scope_agent_id: row.use_report_scope_agent_id,
        task_id: row.use_report_task_id,
        run_id: row.use_report_run_id,
        agent_id: row.use_report_agent_id,
        agent_role: row.use_report_agent_role,
        correlation_token: row.use_report_correlation_token,
        use_kind: row.use_report_kind,
        used_memory_ids: row.use_report_memory_ids,
        reported_at: row.use_report_reported_at,
        reporter_id: row.use_report_reporter_id,
        reporter_authority: row.use_report_reporter_authority,
        reason_code: row.use_report_reason_code,
        evidence: row.use_report_evidence
      };
      return {
        injection,
        use: hydrateInjectionUseReportRow(reportRow),
        sessionInjectionCount
      };
    });
    return {
      items,
      total: Number(count.rows[0]?.total ?? 0),
      limit,
      offset
    };
  }

  async aggregateInjectionUseCohorts(
    request: MemoryInjectionUseCohortFilter
  ): Promise<MemoryInjectionUseCohortPage> {
    assertMemoryInjectionUseCohortFilter(request);
    const workspaceId = request.context.workspaceId;
    const repositoryId = request.context.repositoryId as string;
    const params = new SqlParams();
    const workspaceParam = params.add(workspaceId);
    const repositoryParam = params.add(repositoryId);
    const fromParam = params.add(request.occurredFrom);
    const untilParam = params.add(request.occurredUntil);
    const eligibleModes = `i.memory_mode IN ('jit', 'retrieval-only')`;
    let modeFilterSql = "";
    if (request.memoryModes && request.memoryModes.length > 0) {
      modeFilterSql = ` AND i.memory_mode = ANY(${params.add(request.memoryModes)}::text[])`;
    }
    let useFilterSql = "";
    if (request.useKinds && request.useKinds.length > 0) {
      useFilterSql = ` AND r.use_kind = ANY(${params.add(request.useKinds)}::text[])`;
    }
    const text = `
      WITH cohort_sessions AS MATERIALIZED (
        SELECT DISTINCT i.workspace_id, i.repository_id, i.task_id
        FROM memory_injection_events i
        WHERE i.workspace_id = ${workspaceParam}
          AND i.repository_id = ${repositoryParam}
          AND i.occurred_at >= ${fromParam}
          AND i.occurred_at <= ${untilParam}
          AND i.injection_result = 'injected'
          AND ${eligibleModes}
          AND jsonb_array_length(i.memory_ids) > 0${modeFilterSql}
      ),
      session_counts AS MATERIALIZED (
        SELECT si.workspace_id, si.repository_id, si.task_id,
               CASE WHEN COUNT(*) > 1 THEN 'multiple' ELSE 'single' END AS session_cardinality
        FROM cohort_sessions cs
        JOIN memory_injection_events si
          ON si.workspace_id = cs.workspace_id
         AND si.repository_id = cs.repository_id
         AND si.task_id = cs.task_id
        GROUP BY si.workspace_id, si.repository_id, si.task_id
      )
      SELECT i.memory_mode, sc.session_cardinality, r.use_kind,
             COUNT(i.id)::bigint AS exposure_count
      FROM memory_injection_events i
      JOIN session_counts sc
        ON sc.workspace_id = i.workspace_id
       AND sc.repository_id = i.repository_id
       AND sc.task_id = i.task_id
      LEFT JOIN memory_injection_use_reports r
        ON r.workspace_id = i.workspace_id
       AND r.repository_id = i.repository_id
       AND r.correlation_token = i.correlation_token
       AND r.injection_event_id = i.id
      WHERE i.workspace_id = ${workspaceParam}
        AND i.repository_id = ${repositoryParam}
        AND i.occurred_at >= ${fromParam}
        AND i.occurred_at <= ${untilParam}
        AND i.injection_result = 'injected'
        AND ${eligibleModes}
        AND jsonb_array_length(i.memory_ids) > 0${modeFilterSql}${useFilterSql}
      GROUP BY i.memory_mode, sc.session_cardinality, r.use_kind
      ORDER BY i.memory_mode, sc.session_cardinality, r.use_kind NULLS FIRST
    `;
    const result = await this.pool.query(text, params.all);
    let exposureCount = 0;
    const cells: MemoryInjectionUseCohortCell[] = result.rows.map((row) => {
      const count = parseCohortCount(row.exposure_count, "exposure_count");
      exposureCount = parseCohortCount(exposureCount + count, "exposure_count");
      if (!isMemoryInjectionSessionCardinality(row.session_cardinality)) {
        throw new MemoryHydrationError(
          "memory_injection_events",
          "session_cardinality",
          `expected "single" or "multiple", got ${String(row.session_cardinality)}`
        );
      }
      if (!isMemoryUseCohortEligibleMode(row.memory_mode)) {
        throw new MemoryHydrationError(
          "memory_injection_events",
          "memory_mode",
          `expected eligible use mode, got ${String(row.memory_mode)}`
        );
      }
      const useKind = (row.use_kind ?? null) as MemoryUseKind | null;
      if (
        useKind !== null &&
        !["used", "partially_used", "not_used", "unobservable"].includes(
          useKind
        )
      ) {
        throw new MemoryHydrationError(
          "memory_injection_use_reports",
          "use_kind",
          `expected a bounded use kind, got ${String(row.use_kind)}`
        );
      }
      return {
        memoryMode: row.memory_mode as MemoryUseCohortEligibleMode,
        sessionCardinality: row.session_cardinality,
        useKind,
        exposureCount: count
      };
    });
    return {
      schema: "autodev-memory-injection-use-cohorts-v1",
      workspaceId,
      repositoryId,
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells,
      exposureCount
    };
  }

  /**
   * Scope-free lookup of the single outcome report that already claims a
   * `(workspace_id, correlation_token)` key, used solely to decide whether
   * a new write is an idempotent retry or a genuine conflict. Not exposed
   * on `MemoryRepository`: callers only ever learn about an existing report
   * through `recordOutcomeReport`'s return value or through
   * `listInjectionOutcomeJoins`.
   */
  private async findOutcomeReportByToken(
    workspaceId: string,
    correlationToken: string
  ): Promise<MemoryOutcomeReport | null> {
    if (!correlationToken.trim()) return null;
    const params = new SqlParams();
    const tokenParam = params.add(correlationToken);
    const workspaceParam = params.add(workspaceId);
    const text = `SELECT * FROM memory_outcome_reports
      WHERE correlation_token = ${tokenParam}
        AND workspace_id = ${workspaceParam}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`;
    const result = await this.pool.query(text, params.all);
    const matched = result.rows[0];
    return matched ? hydrateOutcomeReportRow(matched) : null;
  }

  async listInjectionOutcomeJoins(
    request: MemoryInjectionOutcomeJoinRequest
  ): Promise<MemoryInjectionOutcomeJoinPage> {
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 100);
    const offset = Math.max(request.offset ?? 0, 0);
    const sessionLookup: MemoryInjectionEventSessionLookup = {
      workspaceId: request.context.workspaceId,
      ...(request.context.repositoryId
        ? { repositoryId: request.context.repositoryId }
        : {}),
      taskId: request.context.taskId ?? "",
      canReadGlobal: false
    };
    if (!sessionLookup.taskId) {
      return { items: [], total: 0, limit, offset };
    }
    const filterParams = new SqlParams();
    const scopeFilter = buildSessionScopeFilter(
      "i",
      sessionLookup,
      filterParams
    );
    const filters: string[] = [scopeFilter];
    if (request.memoryModes && request.memoryModes.length > 0) {
      const modeParam = filterParams.add(request.memoryModes);
      filters.push(`i.memory_mode = ANY(${modeParam}::text[])`);
    }
    if (request.injectionResults && request.injectionResults.length > 0) {
      const resultParam = filterParams.add(request.injectionResults);
      filters.push(`i.injection_result = ANY(${resultParam}::text[])`);
    }
    const includeUnreported = request.includeUnreported === true;
    if (includeUnreported) {
      filters.push(`(r.id IS NULL OR r.outcome_kind IS NOT NULL)`);
    } else {
      filters.push(`r.outcome_kind IS NOT NULL`);
    }
    if (request.outcomeKinds && request.outcomeKinds.length > 0) {
      const outcomeParam = filterParams.add(request.outcomeKinds);
      filters.push(`r.outcome_kind = ANY(${outcomeParam}::text[])`);
    }
    if (request.reportKinds && request.reportKinds.length > 0) {
      const reportKindParam = filterParams.add(request.reportKinds);
      filters.push(`r.report_kind = ANY(${reportKindParam}::text[])`);
    }
    const whereClause = filters.join(" AND ");

    // Pagination parameters are appended after the WHERE-filter parameters,
    // so their SQL placeholders must continue at the next parameter index.
    // Restarting them at $1/$2 makes PostgreSQL bind the workspace/task ids
    // as LIMIT/OFFSET (and leaves appended values unused).
    const limitParam = `$${filterParams.all.length + 1}`;
    const offsetParam = `$${filterParams.all.length + 2}`;

    // The first scope placeholders are deliberately shared with this CTE:
    // buildSessionScopeFilter adds workspace as $1, task as $2, and an
    // optional repository as $3. The aggregate groups once per canonical
    // session key before mode/result/outcome filters or pagination apply.
    const sessionCountRepositoryFilter = sessionLookup.repositoryId
      ? " AND si.repository_id = $3"
      : "";
    const pageText = `
      WITH session_counts AS MATERIALIZED (
        SELECT si.workspace_id, si.repository_id, si.task_id,
               COUNT(*)::bigint AS session_injection_count
        FROM memory_injection_events si
        WHERE si.workspace_id = $1
          AND si.task_id = $2${sessionCountRepositoryFilter}
        GROUP BY si.workspace_id, si.repository_id, si.task_id
      )
      SELECT i.*, sc.session_injection_count,
             r.id AS report_id,
             r.workspace_id AS report_workspace_id,
             r.repository_id AS report_repository_id,
             r.scope_kind AS report_scope_kind,
             r.scope_workspace_id AS report_scope_workspace_id,
             r.scope_repository_id AS report_scope_repository_id,
             r.scope_role AS report_scope_role,
             r.scope_task_id AS report_scope_task_id,
             r.scope_run_id AS report_scope_run_id,
             r.scope_agent_id AS report_scope_agent_id,
             r.task_id AS report_task_id,
             r.run_id AS report_run_id,
             r.agent_id AS report_agent_id,
             r.correlation_token AS report_correlation_token,
             r.outcome_kind, r.report_kind,
             r.reported_at,
             r.reporter_id, r.reporter_authority, r.evidence AS report_evidence,
             r.reason_code AS report_reason_code
      FROM memory_injection_events i
      JOIN session_counts sc
        ON sc.workspace_id = i.workspace_id
       AND sc.repository_id IS NOT DISTINCT FROM i.repository_id
       AND sc.task_id = i.task_id
      LEFT JOIN memory_outcome_reports r
        ON r.workspace_id = i.workspace_id
       AND r.repository_id = i.repository_id
       AND r.correlation_token = i.correlation_token
       AND r.task_id = i.task_id
      WHERE ${whereClause}
      ORDER BY i.occurred_at DESC, i.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;
    const pageParams = filterParams.all.concat([limit, offset]);
    const rowsResult = await this.pool.query(pageText, pageParams);
    const countResult = await this.pool.query<{ total: number }>(
      `SELECT COUNT(*)::bigint AS total FROM memory_injection_events i
       LEFT JOIN memory_outcome_reports r
         ON r.workspace_id = i.workspace_id
        AND r.repository_id = i.repository_id
        AND r.correlation_token = i.correlation_token
        AND r.task_id = i.task_id
       WHERE ${whereClause}`,
      filterParams.all
    );
    const items: MemoryInjectionOutcomeJoin[] = rowsResult.rows.map((row) => {
      const injection = hydrateInjectionEventRow(row);
      const sessionInjectionCount = parseCohortCount(
        row.session_injection_count,
        "session_injection_count"
      );
      if (!row.report_id)
        return { injection, outcome: null, sessionInjectionCount };
      const reportRow: Record<string, unknown> = {
        id: row.report_id,
        workspace_id: row.report_workspace_id,
        repository_id: row.report_repository_id,
        scope_kind: row.report_scope_kind,
        scope_workspace_id: row.report_scope_workspace_id,
        scope_repository_id: row.report_scope_repository_id,
        scope_role: row.report_scope_role,
        scope_task_id: row.report_scope_task_id,
        scope_run_id: row.report_scope_run_id,
        scope_agent_id: row.report_scope_agent_id,
        task_id: row.report_task_id,
        run_id: row.report_run_id,
        agent_id: row.report_agent_id,
        correlation_token: row.report_correlation_token,
        outcome_kind: row.outcome_kind,
        report_kind: row.report_kind,
        reported_at: row.reported_at,
        reporter_id: row.reporter_id,
        reporter_authority: row.reporter_authority,
        reason_code: row.report_reason_code,
        evidence: row.report_evidence
      };
      return {
        injection,
        outcome: hydrateOutcomeReportRow(reportRow),
        sessionInjectionCount
      };
    });
    return {
      items,
      total: Number(countResult.rows[0]?.total ?? 0),
      limit,
      offset
    };
  }

  /**
   * Workspace/repository/time-scoped GROUP BY aggregate over the canonical
   * append-only injection/outcome event tables. See the Core contract on
   * `MemoryRepository.aggregateInjectionOutcomeCohorts` for the privacy and
   * cardinality guarantees this method must uphold.
   */
  async aggregateInjectionOutcomeCohorts(
    request: MemoryInjectionOutcomeCohortFilter
  ): Promise<MemoryInjectionOutcomeCohortPage> {
    assertMemoryInjectionOutcomeCohortFilter(request);
    const workspaceId = request.context.workspaceId;
    // assertMemoryInjectionOutcomeCohortFilter already rejects a missing
    // repositoryId, so this narrowing is defensive, not a fallback path.
    const repositoryId = request.context.repositoryId as string;

    const params = new SqlParams();
    const workspaceParam = params.add(workspaceId);
    const repositoryParam = params.add(repositoryId);
    const fromParam = params.add(request.occurredFrom);
    const untilParam = params.add(request.occurredUntil);
    const filters = [
      `i.workspace_id = ${workspaceParam}`,
      `i.repository_id = ${repositoryParam}`,
      `i.occurred_at >= ${fromParam}`,
      `i.occurred_at <= ${untilParam}`
    ];
    if (request.memoryModes && request.memoryModes.length > 0) {
      const modeParam = params.add(request.memoryModes);
      filters.push(`i.memory_mode = ANY(${modeParam}::text[])`);
    }
    if (request.injectionResults && request.injectionResults.length > 0) {
      const resultParam = params.add(request.injectionResults);
      filters.push(`i.injection_result = ANY(${resultParam}::text[])`);
    }
    if (request.reportKinds && request.reportKinds.length > 0) {
      const reportKindParam = params.add(request.reportKinds);
      filters.push(`r.report_kind = ANY(${reportKindParam}::text[])`);
    }
    if (request.outcomeKinds && request.outcomeKinds.length > 0) {
      const outcomeParam = params.add(request.outcomeKinds);
      filters.push(`r.outcome_kind = ANY(${outcomeParam}::text[])`);
    }
    const whereClause = filters.join(" AND ");

    // The join is scoped to the matched event even if malformed rows were
    // inserted outside the repository's report-write path. The unique
    // (workspace_id, correlation_token) index still guarantees at most one
    // joined report per exposure, so `reportCount <= exposureCount` holds
    // structurally.
    const text = `
      WITH cohort_sessions AS MATERIALIZED (
        SELECT DISTINCT i.workspace_id, i.repository_id, i.task_id
        FROM memory_injection_events i
        WHERE i.workspace_id = ${workspaceParam}
          AND i.repository_id = ${repositoryParam}
          AND i.occurred_at >= ${fromParam}
          AND i.occurred_at <= ${untilParam}
      ),
      session_counts AS MATERIALIZED (
        SELECT si.workspace_id, si.repository_id, si.task_id,
               CASE WHEN COUNT(*) > 1 THEN 'multiple' ELSE 'single' END AS session_cardinality
        FROM cohort_sessions cs
        JOIN memory_injection_events si
          ON si.workspace_id = cs.workspace_id
         AND si.repository_id = cs.repository_id
         AND si.task_id = cs.task_id
        GROUP BY si.workspace_id, si.repository_id, si.task_id
      )
      SELECT i.memory_mode, i.injection_result, sc.session_cardinality,
             r.report_kind, r.outcome_kind,
             COUNT(i.id)::bigint AS exposure_count,
             COUNT(r.id)::bigint AS report_count
      FROM memory_injection_events i
      JOIN session_counts sc
        ON sc.workspace_id = i.workspace_id
       AND sc.repository_id = i.repository_id
       AND sc.task_id = i.task_id
      LEFT JOIN memory_outcome_reports r
        ON r.workspace_id = i.workspace_id
       AND r.repository_id = i.repository_id
       AND r.correlation_token = i.correlation_token
       AND r.task_id = i.task_id
      WHERE ${whereClause}
      GROUP BY i.memory_mode, i.injection_result, sc.session_cardinality, r.report_kind, r.outcome_kind
      ORDER BY i.memory_mode, i.injection_result, sc.session_cardinality,
               r.report_kind NULLS FIRST, r.outcome_kind NULLS FIRST
    `;
    const result = await this.pool.query(text, params.all);

    let exposureCount = 0;
    let reportCount = 0;
    const cells: MemoryInjectionOutcomeCohortCell[] = result.rows.map((row) => {
      const cellExposureCount = parseCohortCount(
        row.exposure_count,
        "exposure_count"
      );
      const cellReportCount = parseCohortCount(
        row.report_count,
        "report_count"
      );
      if (cellReportCount > cellExposureCount) {
        throw new MemoryHydrationError(
          "memory_injection_events",
          "report_count",
          `report_count ${cellReportCount} exceeds exposure_count ${cellExposureCount}`
        );
      }
      exposureCount = parseCohortCount(
        exposureCount + cellExposureCount,
        "exposure_count"
      );
      reportCount = parseCohortCount(
        reportCount + cellReportCount,
        "report_count"
      );
      if (!isMemoryInjectionSessionCardinality(row.session_cardinality)) {
        throw new MemoryHydrationError(
          "memory_injection_events",
          "session_cardinality",
          `expected "single" or "multiple", got ${String(row.session_cardinality)}`
        );
      }
      return {
        memoryMode: row.memory_mode as MemoryExecutionMode,
        injectionResult: row.injection_result as MemoryInjectionResult,
        sessionCardinality: row.session_cardinality,
        reportKind: (row.report_kind ?? null) as MemoryOutcomeReportKind | null,
        outcomeKind: (row.outcome_kind ?? null) as ExperienceOutcome | null,
        exposureCount: cellExposureCount,
        reportCount: cellReportCount
      };
    });

    return {
      schema: "autodev-memory-injection-outcome-cohorts-v1",
      workspaceId,
      repositoryId,
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells,
      exposureCount,
      reportCount
    };
  }

  /**
   * Appends one reporter-supplied session-level outcome report.
   * Exactly one report is permitted per unique session key (workspace_id, repository_id, task_id).
   * Scope-aligned injection event must exist.
   * Idempotent retry returns appended: false. Conflicting retry throws MemoryConflictError.
   */
  async recordSessionOutcomeReport(
    input: MemoryRecordSessionOutcomeReportInput
  ): Promise<{ appended: boolean; id: string }> {
    const report = input.report;
    const workspaceId = input.context.workspaceId;
    const repositoryId = input.context.repositoryId;
    const taskId = input.context.taskId;

    if (
      !report.repositoryId ||
      !report.repositoryId.trim() ||
      !repositoryId ||
      !repositoryId.trim()
    ) {
      throw new MemoryConflictError(
        "Session outcome report requires an explicit repository scope."
      );
    }
    if (
      report.repositoryId !== repositoryId ||
      report.workspaceId !== workspaceId ||
      report.taskId !== taskId
    ) {
      throw new MemoryConflictError(
        "Session outcome report identity must match trusted context."
      );
    }
    if (!taskId || !taskId.trim()) {
      throw new MemoryConflictError(
        "Session outcome report requires a trusted session task context."
      );
    }
    if (
      report.outcomeKind !== "unknown" &&
      (!report.evidence || report.evidence.length === 0)
    ) {
      throw new MemoryConflictError(
        "Non-unknown outcome reports require at least one evidence reference."
      );
    }

    // Require at least one recorded injection event for (workspaceId, repositoryId, taskId)
    const injectionCheck = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::bigint AS count FROM memory_injection_events
       WHERE workspace_id = $1 AND repository_id = $2 AND task_id = $3
       LIMIT 1`,
      [workspaceId, repositoryId, taskId]
    );
    if (!injectionCheck.rows[0] || Number(injectionCheck.rows[0].count) <= 0) {
      throw new MemoryConflictError(
        "Session outcome report requires at least one recorded injection event for this session key."
      );
    }

    // Check for existing session outcome report
    const existingReport = await this.getSessionOutcomeReport(
      workspaceId,
      repositoryId,
      taskId
    );
    if (existingReport) {
      if (sessionOutcomeReportBodyMatches(existingReport, report)) {
        return { appended: false, id: existingReport.id };
      }
      throw new MemoryConflictError(
        "Session outcome report conflicts with a previously recorded report for this session."
      );
    }

    const storedReport: MemorySessionOutcomeReport = {
      ...report,
      workspaceId,
      repositoryId,
      taskId,
      reasonCode: report.reasonCode ?? "reporter_supplied",
      reporterId: input.actor.id,
      reporterAuthority: input.actor.authority as MemoryAuthority
    };

    const row = sessionOutcomeReportToRow(storedReport);
    const insert = buildInsert("memory_session_outcome_reports", row);
    try {
      await this.pool.query(insert.text, insert.params);
      return { appended: true, id: storedReport.id };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const racedExisting = await this.getSessionOutcomeReport(
          workspaceId,
          repositoryId,
          taskId
        );
        if (
          racedExisting &&
          sessionOutcomeReportBodyMatches(racedExisting, storedReport)
        ) {
          return { appended: false, id: racedExisting.id };
        }
        throw new MemoryConflictError(
          `Session outcome report ${storedReport.id} already exists for this session key.`
        );
      }
      throw error;
    }
  }

  async getSessionOutcomeReport(
    workspaceId: string,
    repositoryId: string,
    taskId: string
  ): Promise<MemorySessionOutcomeReport | null> {
    if (!workspaceId.trim() || !repositoryId.trim() || !taskId.trim()) {
      return null;
    }
    const params = new SqlParams();
    const w = params.add(workspaceId);
    const r = params.add(repositoryId);
    const t = params.add(taskId);
    const text = `SELECT * FROM memory_session_outcome_reports
      WHERE workspace_id = ${w}
        AND repository_id = ${r}
        AND task_id = ${t}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`;
    const result = await this.pool.query(text, params.all);
    const matched = result.rows[0];
    return matched ? hydrateSessionOutcomeReportRow(matched) : null;
  }

  /**
   * Workspace/repository/time-scoped GROUP BY aggregate over canonical
   * append-only injection events and the session outcome report table, at
   * the unique session key unit. Derives each session's full-session mode
   * from its complete, unfiltered injection-event set, regardless of the
   * selected time window or mode/result filter. A session surfaces as a
   * cell only when its full-session mode is a single assigned mode
   * (jit/retrieval-only/disabled); mixed-mode sessions are counted only in
   * mixedModeSessionCount, and invalid/unknown-only sessions are excluded
   * from this response entirely. Joins the single session outcome report
   * per session key (workspace_id, repository_id, task_id) and derives
   * conflictingOutcomeSessionCount as a diagnostic from per-injection-token
   * report disagreement.
   */
  async aggregateSessionOutcomeCohorts(
    request: MemorySessionOutcomeCohortFilter
  ): Promise<MemorySessionOutcomeCohortPage> {
    assertMemorySessionOutcomeCohortFilter(request);
    const workspaceId = request.context.workspaceId;
    const repositoryId = request.context.repositoryId as string;

    const params = new SqlParams();
    const workspaceParam = params.add(workspaceId);
    const repositoryParam = params.add(repositoryId);
    const fromParam = params.add(request.occurredFrom);
    const untilParam = params.add(request.occurredUntil);

    let eventFilterSql = "";
    if (request.memoryModes && request.memoryModes.length > 0) {
      const modeParam = params.add(request.memoryModes);
      eventFilterSql += ` AND i.memory_mode = ANY(${modeParam}::text[])`;
    }
    if (request.injectionResults && request.injectionResults.length > 0) {
      const resultParam = params.add(request.injectionResults);
      eventFilterSql += ` AND i.injection_result = ANY(${resultParam}::text[])`;
    }

    let reportFilterSql = "";
    if (request.reportKinds && request.reportKinds.length > 0) {
      const rkParam = params.add(request.reportKinds);
      reportFilterSql += ` AND r.report_kind = ANY(${rkParam}::text[])`;
    }
    if (request.outcomeKinds && request.outcomeKinds.length > 0) {
      const okParam = params.add(request.outcomeKinds);
      reportFilterSql += ` AND r.outcome_kind = ANY(${okParam}::text[])`;
    }

    const text = `
      WITH in_window_events AS MATERIALIZED (
        SELECT i.workspace_id, i.repository_id, i.task_id
        FROM memory_injection_events i
        WHERE i.workspace_id = ${workspaceParam}
          AND i.repository_id = ${repositoryParam}
          AND i.occurred_at >= ${fromParam}
          AND i.occurred_at <= ${untilParam}${eventFilterSql}
      ),
      in_window_sessions AS MATERIALIZED (
        SELECT DISTINCT workspace_id, repository_id, task_id
        FROM in_window_events
      ),
      full_session_stats AS MATERIALIZED (
        SELECT
          ws.workspace_id,
          ws.repository_id,
          ws.task_id,
          COUNT(DISTINCT si.memory_mode)::int AS mode_count,
          MIN(si.memory_mode) AS sample_mode,
          COUNT(DISTINCT mor.outcome_kind)::int AS token_outcome_kind_count
        FROM in_window_sessions ws
        JOIN memory_injection_events si
          ON si.workspace_id = ws.workspace_id
         AND si.repository_id = ws.repository_id
         AND si.task_id = ws.task_id
        LEFT JOIN memory_outcome_reports mor
          ON mor.workspace_id = si.workspace_id
         AND mor.repository_id = si.repository_id
         AND mor.task_id = si.task_id
         AND mor.correlation_token = si.correlation_token
        GROUP BY ws.workspace_id, ws.repository_id, ws.task_id
      ),
      session_outcomes AS MATERIALIZED (
        SELECT
          fss.workspace_id,
          fss.repository_id,
          fss.task_id,
          CASE
            WHEN fss.mode_count > 1 THEN 'mixed'
            WHEN fss.sample_mode = ANY(ARRAY['jit', 'retrieval-only', 'disabled']) THEN fss.sample_mode
            ELSE 'excluded'
          END AS cohort_mode,
          CASE
            WHEN fss.token_outcome_kind_count > 1 THEN 1
            ELSE 0
          END AS has_conflicting_outcomes,
          r.outcome_kind
        FROM full_session_stats fss
        LEFT JOIN memory_session_outcome_reports r
          ON r.workspace_id = fss.workspace_id
         AND r.repository_id = fss.repository_id
         AND r.task_id = fss.task_id
        WHERE 1 = 1${reportFilterSql}
      )
      SELECT
        cohort_mode,
        outcome_kind,
        COUNT(*)::bigint AS session_count,
        SUM(has_conflicting_outcomes)::bigint AS conflicting_count
      FROM session_outcomes
      WHERE cohort_mode <> 'excluded'
      GROUP BY cohort_mode, outcome_kind
      ORDER BY cohort_mode, outcome_kind NULLS FIRST
    `;

    const result = await this.pool.query<{
      cohort_mode: string;
      outcome_kind: string | null;
      session_count: string | number;
      conflicting_count: string | number;
    }>(text, params.all);

    let sessionCount = 0;
    let reportedSessionCount = 0;
    let unreportedSessionCount = 0;
    let mixedModeSessionCount = 0;
    let conflictingOutcomeSessionCount = 0;
    const cells: MemorySessionOutcomeCohortCell[] = [];

    for (const row of result.rows) {
      const cellSessionCount = parseCohortCount(
        row.session_count,
        "session_count"
      );
      const cellConflictingCount = parseCohortCount(
        row.conflicting_count ?? 0,
        "conflicting_count"
      );
      conflictingOutcomeSessionCount += cellConflictingCount;

      if (row.cohort_mode === "mixed") {
        mixedModeSessionCount += cellSessionCount;
        continue;
      }

      const outcomeKind = (row.outcome_kind ??
        null) as ExperienceOutcome | null;
      sessionCount += cellSessionCount;
      if (outcomeKind === null) {
        unreportedSessionCount += cellSessionCount;
      } else {
        reportedSessionCount += cellSessionCount;
      }

      cells.push({
        memoryMode: row.cohort_mode as MemorySessionCohortAssignedMode,
        outcomeKind,
        sessionCount: cellSessionCount
      });
    }

    return {
      schema: "autodev-memory-session-outcome-cohorts-v1",
      workspaceId,
      repositoryId,
      occurredFrom: request.occurredFrom,
      occurredUntil: request.occurredUntil,
      cells,
      sessionCount,
      reportedSessionCount,
      unreportedSessionCount,
      conflictingOutcomeSessionCount,
      mixedModeSessionCount
    };
  }
}
