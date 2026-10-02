import type {
  MemoryConnectionPool,
  MemoryPooledConnection,
  MemoryQueryResult
} from "../../../src/memory/query-client.ts";

/**
 * Compiles one of this repository's own generated SQL boolean fragments
 * into a JS predicate. It is intentionally narrow: it only needs to
 * understand the grammar `buildScopeFilterSql` and the hard filters in
 * `search.ts` actually produce (parens, AND/OR, comparisons, `IS NULL`,
 * `$N` placeholders with optional `::type` casts,
 * and `x = ANY($N::type[])`), so tests exercise the real SQL text the
 * repository builds rather than a re-implementation of its semantics.
 */
function compileCondition(
  sql: string,
  params: readonly unknown[]
): (row: Record<string, unknown>) => boolean {
  let expr = sql.trim();

  expr = expr.replaceAll(
    /claim_search @@ replace\(plainto_tsquery\('english', \$(\d+)\)::text, ' & ', ' \| '\)::tsquery/g,
    (_all, index: string) =>
      `hasLexicalMatch(row.claim, params[${Number(index) - 1}])`
  );

  // x = ANY($N::type[])  ->  (params[N-1] ?? []).includes(x)
  expr = expr.replaceAll(
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded repository-generated SQL only, not untrusted input
    /([\w.]+)\s*=\s*ANY\(\$(\d+)(?:::\w+(?:\[\])?)?\)/g,
    (_all, column: string, index: string) =>
      `(params[${Number(index) - 1}] ?? []).includes(${column})`
  );

  // table-qualified columns -> row.column
  expr = expr.replaceAll(
    /\b(memory_records|memory_experiences)\.(\w+)/g,
    "row.$2"
  );
  // bare known columns used without a table prefix in CTE filters
  expr = expr.replaceAll(
    /\b(status|validity_state|validity_valid_from|validity_valid_to|memory_mode|outcome|kind)\b(?!\s*:)/g,
    "row.$1"
  );

  // IS NULL / IS NOT NULL
  expr = expr.replaceAll(/([\w.]+)\s+IS\s+NOT\s+NULL/g, "($1 != null)");
  expr = expr.replaceAll(/([\w.]+)\s+IS\s+NULL/g, "($1 == null)");

  // placeholders with casts, then bare placeholders
  expr = expr.replaceAll(
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded, repository-generated SQL text only
    /\$(\d+)(?:::\w+(?:\[\])?)?/g,
    (_all, index: string) => `params[${Number(index) - 1}]`
  );

  // boolean/comparison operators
  expr = expr.replaceAll("<>", "!==");
  expr = expr.replaceAll(/\bAND\b/g, "&&");
  expr = expr.replaceAll(/\bOR\b/g, "||");
  // single `=` (not already part of !==, <=, >=) -> ===
  expr = expr.replaceAll(/([^<>=!])=(?!=)/g, "$1===");

  const evaluate = new Function(
    "row",
    "params",
    "hasLexicalMatch",
    `return (${expr});`
  ) as (
    row: Record<string, unknown>,
    params: readonly unknown[],
    hasLexicalMatch: (claim: unknown, query: unknown) => boolean
  ) => boolean;
  return (row) => Boolean(evaluate(row, params, hasLexicalMatch));
}

function hasLexicalMatch(claim: unknown, query: unknown): boolean {
  if (typeof claim !== "string" || typeof query !== "string") return false;
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "to",
    "was",
    "were",
    "with"
  ]);
  const tokens = (query.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter(
    (token) => !stopWords.has(token)
  );
  const searchableClaim = new Set(claim.toLowerCase().match(/[a-z0-9]+/gu));
  return tokens.some((token) => searchableClaim.has(token));
}

interface UniqueViolation extends Error {
  code: "23505";
}
interface ForeignKeyViolation extends Error {
  code: "23503";
}

function uniqueViolation(message: string): UniqueViolation {
  const error = new Error(message) as UniqueViolation;
  error.code = "23505";
  return error;
}

function foreignKeyViolation(message: string): ForeignKeyViolation {
  const error = new Error(message) as ForeignKeyViolation;
  error.code = "23503";
  return error;
}

const OCCURRED_AT_COLLATOR = new Intl.Collator();

function memoryPathScore(
  row: Record<string, unknown>,
  requestedPaths: readonly string[]
): number {
  if (requestedPaths.length === 0) return 0;
  const rawProvenance = row.provenance;
  const provenance =
    typeof rawProvenance === "string"
      ? (JSON.parse(rawProvenance) as Record<string, unknown>)
      : (rawProvenance as Record<string, unknown> | undefined);
  const evidence = provenance?.evidence;
  if (!Array.isArray(evidence)) return 0;
  let best = 0;
  for (const reference of evidence) {
    if (!reference || typeof reference !== "object") continue;
    const fileReference = reference as Record<string, unknown>;
    if (fileReference.kind !== "file" || typeof fileReference.uri !== "string")
      continue;
    const evidenceUri = fileReference.uri;
    for (const requestedUri of requestedPaths) {
      if (evidenceUri === requestedUri) {
        best = 1;
        continue;
      }
      const evidenceParts = pathParts(evidenceUri);
      const requestedParts = pathParts(requestedUri);
      let sharedPrefix = 0;
      while (
        sharedPrefix < Math.min(evidenceParts.length, requestedParts.length) &&
        evidenceParts[sharedPrefix] === requestedParts[sharedPrefix]
      ) {
        sharedPrefix += 1;
      }
      best = Math.max(
        best,
        0.6 *
          (sharedPrefix / Math.max(evidenceParts.length, requestedParts.length))
      );
    }
  }
  return best;
}

function pathParts(uri: string): string[] {
  const schemeSeparator = uri.indexOf("://");
  const path =
    schemeSeparator === -1 ? uri : uri.slice(schemeSeparator + "://".length);
  return path.split("/").filter(Boolean);
}

function memoryTaskKindScore(
  row: Record<string, unknown>,
  taskKind: string | undefined,
  experiences: ReadonlyMap<string, Record<string, unknown>>
): number {
  if (!taskKind) return 0;
  const rawProvenance = row.provenance;
  const provenance =
    typeof rawProvenance === "string"
      ? (JSON.parse(rawProvenance) as Record<string, unknown>)
      : (rawProvenance as Record<string, unknown> | undefined);
  const experienceIds = provenance?.experienceIds;
  if (!Array.isArray(experienceIds)) return 0;
  return experienceIds.some(
    (id) => experiences.get(String(id))?.task_kind === taskKind
  )
    ? 1
    : 0;
}

interface MemoryTables {
  memory_experiences: Map<string, Record<string, unknown>>;
  memory_records: Map<string, Record<string, unknown>>;
  memory_lifecycle_events: Record<string, unknown>[];
  memory_experience_privacy_events: Record<string, unknown>[];
  memory_schema_migrations: Record<string, unknown>[];
}

function cloneTables(tables: MemoryTables): MemoryTables {
  return {
    memory_experiences: new Map(
      Array.from(tables.memory_experiences, ([k, v]) => [k, { ...v }])
    ),
    memory_records: new Map(
      Array.from(tables.memory_records, ([k, v]) => [k, { ...v }])
    ),
    memory_lifecycle_events: tables.memory_lifecycle_events.map((row) => ({
      ...row
    })),
    memory_experience_privacy_events:
      tables.memory_experience_privacy_events.map((row) => ({ ...row })),
    memory_schema_migrations: tables.memory_schema_migrations.map((row) => ({
      ...row
    }))
  };
}

/**
 * An in-memory, transactional stand-in for Postgres implementing exactly
 * the `MemoryConnectionPool` surface. It interprets the finite set of SQL
 * shapes `PostgresMemoryRepository` and `applyMemoryMigrations` generate,
 * including BEGIN/COMMIT/ROLLBACK snapshotting, so compare-and-set and
 * transactional constraints are exercised against real, generated SQL
 * rather than bypassed.
 */
export class FakeMemoryPool implements MemoryConnectionPool {
  readonly tables: MemoryTables = {
    memory_experiences: new Map(),
    memory_records: new Map(),
    memory_lifecycle_events: [],
    memory_experience_privacy_events: [],
    memory_schema_migrations: []
  };

  readonly executed: string[] = [];
  readonly calls: {
    readonly sql: string;
    readonly params: readonly unknown[];
  }[] = [];
  private snapshot: MemoryTables | undefined;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = []
  ): Promise<MemoryQueryResult<Row>> {
    const sql = text.trim();
    this.executed.push(sql);
    this.calls.push({ sql, params: [...params] });
    return this.dispatch(sql, params) as MemoryQueryResult<Row>;
  }

  async connect(): Promise<MemoryPooledConnection> {
    return {
      query: (text, params) => this.query(text, params),
      release: () => {}
    };
  }

  async end(): Promise<void> {}

  private dispatch(sql: string, params: readonly unknown[]): MemoryQueryResult {
    const transactionResult = this.handleTransaction(sql);
    if (transactionResult) return transactionResult;

    const bookkeeping = this.handleSchemaBookkeeping(sql, params);
    if (bookkeeping) return bookkeeping;

    const mutation = this.handleMutation(sql, params);
    if (mutation) return mutation;

    const read = this.handleRead(sql, params);
    if (read) return read;

    throw new Error(`FakeMemoryPool cannot interpret SQL: ${sql}`);
  }

  private handleTransaction(sql: string): MemoryQueryResult | null {
    if (sql === "BEGIN") {
      this.snapshot = cloneTables(this.tables);
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      this.snapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      if (this.snapshot) {
        this.tables.memory_experiences = this.snapshot.memory_experiences;
        this.tables.memory_records = this.snapshot.memory_records;
        this.tables.memory_lifecycle_events =
          this.snapshot.memory_lifecycle_events;
        this.tables.memory_experience_privacy_events =
          this.snapshot.memory_experience_privacy_events;
        this.tables.memory_schema_migrations =
          this.snapshot.memory_schema_migrations;
        this.snapshot = undefined;
      }
      return { rows: [], rowCount: 0 };
    }
    return null;
  }

  private handleMutation(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const insertMatch =
      /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/.exec(sql);
    if (insertMatch) {
      return this.handleInsert(
        insertMatch[1] as string,
        insertMatch[2] as string,
        params
      );
    }
    if (sql === "SELECT set_config('autodev.memory_privacy_purge', 'on', true)")
      return { rows: [{ set_config: "on" }], rowCount: 1 };
    const purgeMatch =
      /^DELETE FROM memory_experiences WHERE id = \$1 AND (.+)$/.exec(sql);
    if (purgeMatch) {
      const id = String(params[0]);
      const row = this.tables.memory_experiences.get(id);
      const predicate = compileCondition(purgeMatch[1] as string, params);
      if (!row || !predicate(row)) return { rows: [], rowCount: 0 };
      this.tables.memory_experiences.delete(id);
      return { rows: [{ id }], rowCount: 1 };
    }
    const updateMatch =
      /^UPDATE memory_records SET (.+) WHERE id = \$1 AND updated_at = \$2 RETURNING id$/.exec(
        sql
      );
    if (updateMatch) return this.handleUpdate(updateMatch[1] as string, params);
    return null;
  }

  private handleRead(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    if (sql === "SELECT * FROM memory_records WHERE id = $1 FOR SHARE") {
      const row = this.tables.memory_records.get(params[0] as string);
      const rows = row ? [row] : [];
      return { rows, rowCount: rows.length };
    }
    const purgeTarget = this.readPurgeTarget(sql, params);
    if (purgeTarget) return purgeTarget;
    const references = this.readPrivacyReferences(sql, params);
    if (references) return references;
    if (
      sql ===
      "SELECT id FROM memory_experiences WHERE id = ANY($1::text[]) ORDER BY id FOR KEY SHARE"
    ) {
      const ids = new Set(params[0] as string[]);
      const rows = [...this.tables.memory_experiences.keys()]
        .filter((id) => ids.has(id))
        .sort()
        .map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    const byId = this.readById(sql, params);
    if (byId) return byId;
    const related = this.readRelatedMemories(sql, params);
    if (related) return related;
    const history = this.readHistoryEvents(sql, params);
    if (history) return history;
    const expired = this.readExpiredExperiences(sql, params);
    if (expired) return expired;
    const listCount = this.readListCount(sql, params);
    if (listCount) return listCount;
    const listPage = this.readListPage(sql, params);
    if (listPage) return listPage;
    return this.readRankedRows(sql, params);
  }

  private readPurgeTarget(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const match =
      /^SELECT id FROM memory_experiences WHERE id = \$1 AND (.+) FOR UPDATE$/.exec(
        sql
      );
    if (!match) return null;
    const id = String(params[0]);
    const row = this.tables.memory_experiences.get(id);
    const predicate = compileCondition(match[1] as string, params);
    const rows = row && predicate(row) ? [{ id }] : [];
    return { rows, rowCount: rows.length };
  }

  private readPrivacyReferences(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    if (
      sql !==
      "SELECT id FROM memory_records WHERE provenance->'experienceIds' @> $1::jsonb LIMIT 1"
    ) {
      return null;
    }
    const experienceIds = new Set(JSON.parse(String(params[0])) as string[]);
    const row = [...this.tables.memory_records.values()].find((candidate) => {
      const provenance =
        typeof candidate.provenance === "string"
          ? (JSON.parse(candidate.provenance) as Record<string, unknown>)
          : (candidate.provenance as Record<string, unknown>);
      return (
        Array.isArray(provenance.experienceIds) &&
        provenance.experienceIds.some((id) => experienceIds.has(String(id)))
      );
    });
    return row
      ? { rows: [{ id: row.id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  private readById(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const match =
      /^SELECT \* FROM (memory_records|memory_experiences) WHERE id = \$1 AND (.+)$/.exec(
        sql
      );
    if (!match) return null;
    const table = match[1] as "memory_records" | "memory_experiences";
    const predicate = compileCondition(match[2] as string, params);
    const row = this.tables[table].get(params[0] as string);
    const rows = row && predicate(row) ? [row] : [];
    return { rows, rowCount: rows.length };
  }

  private readRelatedMemories(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const match =
      /^SELECT \* FROM memory_records WHERE id = ANY\(\$1::text\[\]\) AND (.+)$/.exec(
        sql
      );
    if (!match) return null;
    const ids = new Set(params[0] as string[]);
    const predicate = compileCondition(match[1] as string, params);
    const rows = [...this.tables.memory_records.values()].filter(
      (row) => ids.has(row.id as string) && predicate(row)
    );
    return { rows, rowCount: rows.length };
  }

  private readHistoryEvents(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    if (
      sql !==
      "SELECT * FROM memory_lifecycle_events WHERE memory_id = $1 OR related_memory_ids @> $2::jsonb ORDER BY occurred_at ASC"
    ) {
      return null;
    }
    const id = params[0];
    const relatedIds = new Set(JSON.parse(String(params[1])) as string[]);
    const rows = this.tables.memory_lifecycle_events
      .filter((row) => {
        const eventRelatedIds =
          typeof row.related_memory_ids === "string"
            ? (JSON.parse(row.related_memory_ids) as string[])
            : (row.related_memory_ids as string[]);
        return (
          row.memory_id === id ||
          relatedIds.has(String(row.memory_id)) ||
          eventRelatedIds.includes(String(id))
        );
      })
      .sort((left, right) =>
        OCCURRED_AT_COLLATOR.compare(
          String(left.occurred_at),
          String(right.occurred_at)
        )
      );
    return { rows, rowCount: rows.length };
  }

  private readExpiredExperiences(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const match =
      /^SELECT memory_experiences\.\* FROM memory_experiences WHERE (.+) AND memory_experiences\.completed_at IS NOT NULL AND memory_experiences\.completed_at < \$(\d+) AND NOT EXISTS \(SELECT 1 FROM memory_records WHERE memory_records\.provenance->'experienceIds' @> jsonb_build_array\(memory_experiences\.id\)\) ORDER BY memory_experiences\.completed_at ASC, memory_experiences\.id ASC LIMIT \$(\d+)$/.exec(
        sql
      );
    if (!match) return null;
    const visible = compileCondition(match[1] as string, params);
    const cutoff = Date.parse(String(params[Number(match[2]) - 1]));
    const limit = Number(params[Number(match[3]) - 1]);
    const rows = [...this.tables.memory_experiences.values()]
      .filter((row) => {
        if (!visible(row) || !row.completed_at) return false;
        if (Date.parse(String(row.completed_at)) >= cutoff) return false;
        return ![...this.tables.memory_records.values()].some((memory) => {
          const provenance =
            typeof memory.provenance === "string"
              ? (JSON.parse(memory.provenance) as Record<string, unknown>)
              : (memory.provenance as Record<string, unknown>);
          return (
            Array.isArray(provenance.experienceIds) &&
            provenance.experienceIds.includes(row.id)
          );
        });
      })
      .sort((left, right) => {
        const byCompletion = OCCURRED_AT_COLLATOR.compare(
          String(left.completed_at),
          String(right.completed_at)
        );
        return (
          byCompletion ||
          OCCURRED_AT_COLLATOR.compare(String(left.id), String(right.id))
        );
      })
      .slice(0, limit);
    return { rows, rowCount: rows.length };
  }

  private readListCount(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const match =
      /^SELECT COUNT\(\*\)::bigint AS total FROM (memory_records|memory_experiences) WHERE (.+)$/.exec(
        sql
      );
    if (!match) return null;
    const table = match[1] as "memory_records" | "memory_experiences";
    const predicate = compileCondition(match[2] as string, params);
    const total = [...this.tables[table].values()].filter(predicate).length;
    return { rows: [{ total }], rowCount: 1 };
  }

  private readListPage(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const match =
      /^SELECT \* FROM (memory_records|memory_experiences) WHERE (.+) ORDER BY (.+) LIMIT \$(\d+) OFFSET \$(\d+)$/.exec(
        sql
      );
    if (!match) return null;
    const table = match[1] as "memory_records" | "memory_experiences";
    const predicate = compileCondition(match[2] as string, params);
    const limit = Number(params[Number(match[4]) - 1]);
    const offset = Number(params[Number(match[5]) - 1]);
    const rows = [...this.tables[table].values()]
      .filter(predicate)
      .sort((left, right) => {
        const column =
          table === "memory_records" ? "created_at" : "completed_at";
        return OCCURRED_AT_COLLATOR.compare(
          String(right[column] ?? ""),
          String(left[column] ?? "")
        );
      })
      .slice(offset, offset + limit);
    return { rows, rowCount: rows.length };
  }

  private readRankedRows(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    if (!sql.startsWith("WITH scoped AS (")) return null;
    const table = (["memory_records", "memory_experiences"] as const).find(
      (candidate) => sql.includes(`FROM ${candidate}\n  WHERE `)
    );
    if (!table) return null;
    const whereStart =
      sql.indexOf(`FROM ${table}\n  WHERE `) + `FROM ${table}\n  WHERE `.length;
    const scopedEnd = sql.indexOf("), ranked AS (", whereStart);
    const plainCteEnd = sql.indexOf(")\nSELECT", whereStart);
    const whereEnd = scopedEnd === -1 ? plainCteEnd : scopedEnd;
    const limitStart = sql.lastIndexOf("LIMIT $");
    if (whereEnd === -1 || limitStart === -1) return null;
    const whereSql = sql.slice(whereStart, whereEnd);
    const predicate = compileCondition(whereSql, params);
    const limitParam = Number(sql.slice(limitStart + "LIMIT $".length));
    const limit = Number(params[limitParam - 1]);
    const source =
      table === "memory_records"
        ? [...this.tables.memory_records.values()]
        : [...this.tables.memory_experiences.values()];
    const pathMarker = "unnest($";
    const pathMarkerIndex = sql.indexOf(pathMarker);
    const pathParamEndMarker = "::text[]) AS requested_path(uri)";
    const pathParamEnd = sql.indexOf(pathParamEndMarker, pathMarkerIndex);
    const pathParamIndex =
      pathMarkerIndex === -1 || pathParamEnd === -1
        ? 0
        : Number(sql.slice(pathMarkerIndex + pathMarker.length, pathParamEnd));
    const requestedPaths = pathParamIndex
      ? (params[pathParamIndex - 1] as readonly string[])
      : [];
    const taskKindMarker = "source_experience.task_kind = $";
    const taskKindMarkerIndex = sql.indexOf(taskKindMarker);
    let taskKindParamEnd = 0;
    if (taskKindMarkerIndex !== -1) {
      taskKindParamEnd = taskKindMarkerIndex + taskKindMarker.length;
      while (
        taskKindParamEnd < sql.length &&
        sql.charCodeAt(taskKindParamEnd) >= 48 &&
        sql.charCodeAt(taskKindParamEnd) <= 57
      ) {
        taskKindParamEnd += 1;
      }
    }
    const taskKindParamIndex =
      taskKindMarkerIndex === -1
        ? 0
        : Number(
            sql.slice(
              taskKindMarkerIndex + taskKindMarker.length,
              taskKindParamEnd
            )
          );
    const requestedTaskKind = taskKindParamIndex
      ? String(params[taskKindParamIndex - 1])
      : undefined;
    const queryMarker = "plainto_tsquery('english', $";
    const queryMarkerIndex = sql.indexOf(queryMarker);
    const queryEnd = sql.indexOf(")", queryMarkerIndex);
    const queryParamIndex =
      queryMarkerIndex === -1 || queryEnd === -1
        ? 0
        : Number(sql.slice(queryMarkerIndex + queryMarker.length, queryEnd));
    const searchQuery = queryParamIndex
      ? params[queryParamIndex - 1]
      : undefined;
    const vectorSearch = sql.includes("::vector");
    const rows = source
      .filter(predicate)
      .map((row, index) => {
        const pathScore = memoryPathScore(row, requestedPaths);
        const lexicalScore = hasLexicalMatch(row.claim, searchQuery) ? 1 : 0;
        return {
          ...row,
          path_score: pathScore,
          task_kind_score: memoryTaskKindScore(
            row,
            requestedTaskKind,
            this.tables.memory_experiences
          ),
          lexical_score: lexicalScore,
          has_embedding: row.embedding !== null && row.embedding !== undefined,
          score: source.length - index
        };
      })
      .filter(
        (row) =>
          row.lexical_score > 0 ||
          row.path_score > 0 ||
          (vectorSearch && row.has_embedding)
      );
    return {
      rows: rows.slice(0, limit),
      rowCount: Math.min(rows.length, limit)
    };
  }

  /**
   * Handles the handful of fixed statements \`applyMemoryMigrations\` issues
   * against the migrations-tracking table and the DDL it runs, so the main
   * dispatcher only has to branch on actual row-level reads/writes.
   */
  private handleSchemaBookkeeping(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | undefined {
    let result: MemoryQueryResult | undefined;
    if (sql.startsWith("CREATE TABLE IF NOT EXISTS memory_schema_migrations")) {
      result = { rows: [], rowCount: 0 };
    } else if (sql === "SELECT version FROM memory_schema_migrations") {
      result = {
        rows: this.tables.memory_schema_migrations as unknown[] as Record<
          string,
          unknown
        >[],
        rowCount: this.tables.memory_schema_migrations.length
      };
    } else if (sql.startsWith("INSERT INTO memory_schema_migrations")) {
      this.tables.memory_schema_migrations.push({
        version: params[0],
        description: params[1]
      });
      result = { rows: [], rowCount: 1 };
    } else if (this.isDdlStatement(sql)) {
      // DDL migration statements: the fake does not model Postgres schema
      // objects, only the row-level tables the repository actually reads
      // and writes, so these are accepted as no-ops.
      result = { rows: [], rowCount: 0 };
    }
    return result;
  }

  private isDdlStatement(sql: string): boolean {
    const ddlMarkers = [
      "CREATE TABLE",
      "ALTER TABLE",
      "CREATE INDEX",
      "CREATE EXTENSION",
      "CREATE FUNCTION",
      "CREATE TRIGGER",
      "DO $$"
    ];
    return ddlMarkers.some((marker) => sql.includes(marker));
  }

  private handleInsert(
    table: string,
    columnsText: string,
    params: readonly unknown[]
  ): MemoryQueryResult {
    const columns = columnsText.split(",").map((c) => c.trim());
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column] = params[index];
    });

    if (table === "memory_experiences" || table === "memory_records") {
      const map = this.tables[table as "memory_experiences" | "memory_records"];
      const id = row.id as string;
      if (map.has(id))
        throw uniqueViolation(
          `duplicate key value violates unique constraint "${table}_pkey"`
        );
      map.set(id, row);
      return { rows: [row], rowCount: 1 };
    }

    if (table === "memory_experience_privacy_events") {
      this.tables.memory_experience_privacy_events.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (table === "memory_lifecycle_events") {
      const memoryId = row.memory_id as string;
      if (!this.tables.memory_records.has(memoryId)) {
        throw foreignKeyViolation(
          `insert or update on table "memory_lifecycle_events" violates foreign key constraint: memory_id ${memoryId} not found`
        );
      }
      this.tables.memory_lifecycle_events.push(row);
      return { rows: [row], rowCount: 1 };
    }

    throw new Error(
      `FakeMemoryPool cannot insert into unknown table: ${table}`
    );
  }

  private handleUpdate(
    setClause: string,
    params: readonly unknown[]
  ): MemoryQueryResult {
    const id = params[0] as string;
    const expectedUpdatedAt = params[1];
    const row = this.tables.memory_records.get(id);
    if (!row || row.updated_at !== expectedUpdatedAt) {
      return { rows: [], rowCount: 0 };
    }

    for (const assignment of setClause.split(",")) {
      const [column, placeholder] = assignment
        .trim()
        .split("=")
        .map((part) => part.trim());
      const index = Number((placeholder as string).slice(1)) - 1;
      row[column as string] = params[index];
    }

    return { rows: [{ id }], rowCount: 1 };
  }
}
