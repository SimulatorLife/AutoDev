import { createHash } from "node:crypto";

import type {
  ExperienceEnvelope,
  ExperienceListRequest,
  ExperienceSearchRequest,
  MemoryExperiencePurgeRequest,
  MemoryExperiencePurgeResult,
  MemoryExpiredExperienceRequest,
  MemoryHistory,
  MemoryLifecycleEvent,
  MemoryListRequest,
  MemoryPage,
  MemoryReadContext,
  MemoryRecord,
  MemoryRepository,
  MemorySearchHit,
  MemorySearchRequest,
  MemoryVersionedUpdate
} from "@simulatorlife/autodev-core";

import {
  MemoryConflictError,
  MemoryLifecycleError,
  MemoryProvenanceError,
  MemoryVectorError
} from "./errors.ts";
import {
  hydrateExperienceRow,
  hydrateLifecycleEventRow,
  hydrateMemoryRecordRow
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
  lifecycleEventToRow,
  memoryRecordToRow
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
}
