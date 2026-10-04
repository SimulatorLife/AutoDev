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

// Repository-generated SQL templates are multi-line for readability
// (see postgres-memory-repository.ts). Collapsing every whitespace run
// to a single space here, once, lets every matcher below use plain
// single-space separators instead of scattered \s+ runs that the
// regex-safety linters flag as backtracking-prone.
const WHITESPACE_RUN_PATTERN = /\s+/gu;
function normalizeSql(sql: string): string {
  return sql.replaceAll(WHITESPACE_RUN_PATTERN, " ").trim();
}

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
  memory_injection_events: Map<string, Record<string, unknown>>;
  memory_outcome_reports: Map<string, Record<string, unknown>>;
  memory_injection_use_reports: Map<string, Record<string, unknown>>;
  memory_session_outcome_reports: Map<string, Record<string, unknown>>;
  memory_schema_migrations: Record<string, unknown>[];
}

interface SessionOutcomeCohortFilter {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly fromDate: Date;
  readonly untilDate: Date;
  readonly memoryModes?: readonly string[];
  readonly injectionResults?: readonly string[];
  readonly reportKinds?: readonly string[];
  readonly outcomeKinds?: readonly string[];
}

interface SessionOutcomeCohortRow extends Record<string, unknown> {
  cohort_mode: string;
  outcome_kind: string | null;
  session_count: number;
  conflicting_count: number;
}

interface InjectionUseCohortFilter {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly occurredFrom: string;
  readonly occurredUntil: string;
  readonly memoryModes?: readonly string[];
  readonly useKinds?: readonly string[];
}

interface InjectionUseCohortRow extends Record<string, unknown> {
  memory_mode: string;
  session_cardinality: string;
  use_kind: string | null;
  exposure_count: number;
}

interface InjectionOutcomeCohortRow extends Record<string, unknown> {
  memory_mode: unknown;
  injection_result: unknown;
  session_cardinality: unknown;
  report_kind: unknown;
  outcome_kind: unknown;
  exposure_count: number;
  report_count: number;
}

interface InjectionOutcomeCohortAccumulator {
  readonly predicate: (
    injection: Record<string, unknown>,
    report: Record<string, unknown> | null
  ) => boolean;
  readonly reportsByToken: Map<string, Record<string, unknown>>;
  readonly sessionCounts: Map<string, number>;
  readonly cells: Map<string, InjectionOutcomeCohortRow>;
}

const ASSIGNED_SESSION_MODES = new Set(["jit", "retrieval-only", "disabled"]);

function readTextArrayFilter(
  sql: string,
  params: readonly unknown[],
  pattern: RegExp
): readonly string[] | undefined {
  const match = pattern.exec(sql);
  return match
    ? (params[Number(match[1]) - 1] as readonly string[])
    : undefined;
}

function parseSessionOutcomeCohortFilter(
  sql: string,
  params: readonly unknown[]
): SessionOutcomeCohortFilter {
  const memoryModes = readTextArrayFilter(
    sql,
    params,
    /i\.memory_mode = ANY\(\$(\d+)::text\[\]\)/i
  );
  const injectionResults = readTextArrayFilter(
    sql,
    params,
    /i\.injection_result = ANY\(\$(\d+)::text\[\]\)/i
  );
  const reportKinds = readTextArrayFilter(
    sql,
    params,
    /r\.report_kind = ANY\(\$(\d+)::text\[\]\)/i
  );
  const outcomeKinds = readTextArrayFilter(
    sql,
    params,
    /r\.outcome_kind = ANY\(\$(\d+)::text\[\]\)/i
  );

  return {
    workspaceId: params[0] as string,
    repositoryId: params[1] as string,
    fromDate: new Date(params[2] as string),
    untilDate: new Date(params[3] as string),
    ...(memoryModes ? { memoryModes } : {}),
    ...(injectionResults ? { injectionResults } : {}),
    ...(reportKinds ? { reportKinds } : {}),
    ...(outcomeKinds ? { outcomeKinds } : {})
  };
}

function matchesSessionOutcomeWindow(
  event: Record<string, unknown>,
  filter: SessionOutcomeCohortFilter
): boolean {
  if (
    event.workspace_id !== filter.workspaceId ||
    event.repository_id !== filter.repositoryId
  ) {
    return false;
  }
  const eventDate = new Date(event.occurred_at as string);
  if (eventDate < filter.fromDate || eventDate > filter.untilDate) return false;
  if (
    filter.memoryModes?.length &&
    !filter.memoryModes.includes(event.memory_mode as string)
  ) {
    return false;
  }
  return !(
    filter.injectionResults?.length &&
    !filter.injectionResults.includes(event.injection_result as string)
  );
}

function selectInWindowSessionKeys(
  events: Iterable<Record<string, unknown>>,
  filter: SessionOutcomeCohortFilter
): Set<string> {
  const sessionKeys = new Set<string>();
  for (const event of events) {
    if (!matchesSessionOutcomeWindow(event, filter)) continue;
    sessionKeys.add(
      `${event.workspace_id}\u0000${event.repository_id}\u0000${event.task_id}`
    );
  }
  return sessionKeys;
}

function sessionMode(events: readonly Record<string, unknown>[]): string {
  const modes = new Set(events.map((event) => event.memory_mode as string));
  if (modes.size > 1) return "mixed";
  const [mode] = modes;
  return mode && ASSIGNED_SESSION_MODES.has(mode) ? mode : "excluded";
}

function countConflictingSessionOutcomes(
  workspaceId: string,
  repositoryId: string,
  taskId: string,
  events: readonly Record<string, unknown>[],
  reports: Iterable<Record<string, unknown>>
): number {
  const sessionTokens = new Set(
    events.map((event) => event.correlation_token as string).filter(Boolean)
  );
  const outcomeKinds = new Set(
    [...reports]
      .filter(
        (report) =>
          report.workspace_id === workspaceId &&
          report.repository_id === repositoryId &&
          report.task_id === taskId &&
          sessionTokens.has(report.correlation_token as string)
      )
      .map((report) => report.outcome_kind as string)
  );
  return outcomeKinds.size > 1 ? 1 : 0;
}

function matchesSessionReportFilters(
  reportKind: string | null,
  outcomeKind: string | null,
  filter: SessionOutcomeCohortFilter
): boolean {
  if (
    filter.reportKinds?.length &&
    (!reportKind || !filter.reportKinds.includes(reportKind))
  ) {
    return false;
  }
  return !(
    filter.outcomeKinds?.length &&
    (!outcomeKind || !filter.outcomeKinds.includes(outcomeKind))
  );
}

function projectSessionOutcomeCohort(
  sessionKey: string,
  tables: MemoryTables,
  filter: SessionOutcomeCohortFilter
): SessionOutcomeCohortRow | null {
  const [workspaceId, repositoryId, taskId] = sessionKey.split("\u0000") as [
    string,
    string,
    string
  ];
  const sessionEvents = [...tables.memory_injection_events.values()].filter(
    (event) =>
      event.workspace_id === workspaceId &&
      event.repository_id === repositoryId &&
      event.task_id === taskId
  );
  const cohortMode = sessionMode(sessionEvents);
  if (cohortMode === "excluded") return null;

  const report = [...tables.memory_session_outcome_reports.values()].find(
    (row) =>
      row.workspace_id === workspaceId &&
      row.repository_id === repositoryId &&
      row.task_id === taskId
  );
  const reportKind = (report?.report_kind as string) ?? null;
  const outcomeKind = (report?.outcome_kind as string) ?? null;
  if (!matchesSessionReportFilters(reportKind, outcomeKind, filter))
    return null;

  return {
    cohort_mode: cohortMode,
    outcome_kind: outcomeKind,
    session_count: 1,
    conflicting_count: countConflictingSessionOutcomes(
      workspaceId,
      repositoryId,
      taskId,
      sessionEvents,
      tables.memory_outcome_reports.values()
    )
  };
}

function addSessionOutcomeCohort(
  rows: Map<string, SessionOutcomeCohortRow>,
  cohort: SessionOutcomeCohortRow
): void {
  if (cohort.cohort_mode === "mixed") return;
  const key = `${cohort.cohort_mode}\u0000${cohort.outcome_kind ?? ""}`;
  const existing = rows.get(key);
  if (existing) {
    existing.session_count += cohort.session_count;
    existing.conflicting_count += cohort.conflicting_count;
    return;
  }
  rows.set(key, cohort);
}

function compareSessionOutcomeRows(
  left: SessionOutcomeCohortRow,
  right: SessionOutcomeCohortRow
): number {
  const modeOrder = OCCURRED_AT_COLLATOR.compare(
    left.cohort_mode,
    right.cohort_mode
  );
  if (modeOrder !== 0) return modeOrder;
  return compareNullableStrings(left.outcome_kind, right.outcome_kind);
}

function addInjectionUseCohortExposure(
  injection: Record<string, unknown>,
  reports: Map<string, Record<string, unknown>>,
  sessionCounts: Map<string, number>,
  cells: Map<string, InjectionUseCohortRow>,
  filter: InjectionUseCohortFilter
): void {
  if (
    !isEligibleInjectionUseExposure(
      injection,
      filter.workspaceId,
      filter.repositoryId,
      filter.occurredFrom,
      filter.occurredUntil,
      filter.memoryModes
    )
  ) {
    return;
  }
  const report = findUseReportForInjection(injection, reports);
  const useKind = (report?.use_kind as string | undefined) ?? null;
  if (
    filter.useKinds?.length &&
    (useKind === null || !filter.useKinds.includes(useKind))
  ) {
    return;
  }

  const sessionCardinality =
    (sessionCounts.get(injectionSessionKey(injection)) ?? 0) > 1
      ? "multiple"
      : "single";
  const key = [injection.memory_mode, sessionCardinality, useKind ?? ""].join(
    "\u0001"
  );
  const cell = cells.get(key);
  if (cell) {
    cell.exposure_count += 1;
    return;
  }
  cells.set(key, {
    memory_mode: String(injection.memory_mode),
    session_cardinality: sessionCardinality,
    use_kind: useKind,
    exposure_count: 1
  });
}

function addInjectionOutcomeCohortExposure(
  injection: Record<string, unknown>,
  accumulator: InjectionOutcomeCohortAccumulator
): void {
  const candidate =
    accumulator.reportsByToken.get(injectionWorkspaceTokenKey(injection)) ??
    null;
  const report =
    candidate &&
    candidate.repository_id === injection.repository_id &&
    candidate.task_id === injection.task_id
      ? candidate
      : null;
  if (!accumulator.predicate(injection, report)) return;

  const sessionCardinality =
    (accumulator.sessionCounts.get(injectionSessionKey(injection)) ?? 0) > 1
      ? "multiple"
      : "single";
  const reportKind = report ? report.report_kind : null;
  const outcomeKind = report ? report.outcome_kind : null;
  const key = [
    injection.memory_mode,
    injection.injection_result,
    sessionCardinality,
    reportKind,
    outcomeKind
  ].join("\u0001");
  const existing = accumulator.cells.get(key);
  if (existing) {
    existing.exposure_count += 1;
    if (report) existing.report_count += 1;
    return;
  }
  accumulator.cells.set(key, {
    memory_mode: injection.memory_mode,
    injection_result: injection.injection_result,
    session_cardinality: sessionCardinality,
    report_kind: reportKind,
    outcome_kind: outcomeKind,
    exposure_count: 1,
    report_count: report ? 1 : 0
  });
}

function compareInjectionOutcomeCohortRows(
  left: InjectionOutcomeCohortRow,
  right: InjectionOutcomeCohortRow
): number {
  const dimensions: (keyof InjectionOutcomeCohortRow)[] = [
    "memory_mode",
    "injection_result",
    "session_cardinality",
    "report_kind",
    "outcome_kind"
  ];
  for (const dimension of dimensions) {
    const leftValue = left[dimension];
    const rightValue = right[dimension];
    if (leftValue === rightValue) continue;
    if (leftValue === null || leftValue === undefined) return -1;
    if (rightValue === null || rightValue === undefined) return 1;
    const comparison = OCCURRED_AT_COLLATOR.compare(
      String(leftValue),
      String(rightValue)
    );
    if (comparison !== 0) return comparison;
  }
  return 0;
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
    memory_injection_events: new Map(
      Array.from(tables.memory_injection_events, ([k, v]) => [k, { ...v }])
    ),
    memory_outcome_reports: new Map(
      Array.from(tables.memory_outcome_reports, ([k, v]) => [k, { ...v }])
    ),
    memory_injection_use_reports: new Map(
      Array.from(tables.memory_injection_use_reports, ([k, v]) => [k, { ...v }])
    ),
    memory_session_outcome_reports: new Map(
      Array.from(tables.memory_session_outcome_reports, ([k, v]) => [
        k,
        { ...v }
      ])
    ),
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
    memory_injection_events: new Map(),
    memory_outcome_reports: new Map(),
    memory_injection_use_reports: new Map(),
    memory_session_outcome_reports: new Map(),
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
        this.tables.memory_injection_events =
          this.snapshot.memory_injection_events;
        this.tables.memory_outcome_reports =
          this.snapshot.memory_outcome_reports;
        this.tables.memory_injection_use_reports =
          this.snapshot.memory_injection_use_reports;
        this.tables.memory_session_outcome_reports =
          this.snapshot.memory_session_outcome_reports;
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
    if (/^(UPDATE|DELETE FROM) memory_injection_use_reports\b/i.test(sql)) {
      throw new Error(
        `memory_injection_use_reports is append-only: ${sql.startsWith("UPDATE") ? "UPDATE" : "DELETE"} is not permitted`
      );
    }
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
    return (
      this.readEventQuery(sql, params) ??
      this.readSpecialQuery(sql, params) ??
      this.readMemoryPageQuery(sql, params) ??
      this.readRankedRows(sql, params)
    );
  }

  private readEventQuery(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    return (
      this.readSessionOutcomeCohorts(sql, params) ??
      this.readInjectionUse(sql, params) ??
      this.readInjectionOutcomeCohorts(sql, params) ??
      this.readInjectionOutcomeJoin(sql, params) ??
      this.readInjectionEventByToken(sql, params) ??
      this.readInjectionEventById(sql, params) ??
      this.readInjectionUseReportByToken(sql, params) ??
      this.readOutcomeReportByToken(sql, params) ??
      this.readSessionInjectionCount(sql, params) ??
      this.readSessionOutcomeReport(sql, params)
    );
  }

  private readSpecialQuery(
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
    return null;
  }

  private readMemoryPageQuery(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    return (
      this.readById(sql, params) ??
      this.readRelatedMemories(sql, params) ??
      this.readHistoryEvents(sql, params) ??
      this.readExpiredExperiences(sql, params) ??
      this.readListCount(sql, params) ??
      this.readListPage(sql, params)
    );
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

  private readInjectionEventByToken(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    // The repository's session lookup uses workspace + (optional) repository
    // = + task. The template is multi-line for readability, so normalize
    // whitespace once here rather than matching \s+ runs throughout.
    const normalizedSql = normalizeSql(sql);
    const withRepository =
      /^SELECT \* FROM memory_injection_events WHERE correlation_token = \$(\d+) AND scope_workspace_id = \$(\d+) AND repository_id = \$(\d+) AND scope_task_id = \$(\d+) ORDER BY occurred_at DESC, id DESC LIMIT 1$/i.exec(
        normalizedSql
      );
    const withoutRepository =
      /^SELECT \* FROM memory_injection_events WHERE correlation_token = \$(\d+) AND scope_workspace_id = \$(\d+) AND scope_task_id = \$(\d+) ORDER BY occurred_at DESC, id DESC LIMIT 1$/i.exec(
        normalizedSql
      );
    const match = withRepository ?? withoutRepository;
    if (!match) return null;
    const token = String(params[Number(match[1]) - 1]);
    const workspaceId = String(params[Number(match[2]) - 1]);
    const repositoryId = withRepository
      ? String(params[Number(withRepository[3]) - 1])
      : undefined;
    const taskId = withRepository
      ? String(params[Number(withRepository[4]) - 1])
      : String(params[Number(match[3]) - 1]);
    const rows = [...this.tables.memory_injection_events.values()]
      .filter(
        (row) =>
          row.correlation_token === token &&
          row.scope_workspace_id === workspaceId &&
          (repositoryId === undefined ||
            (row.repository_id ?? null) === (repositoryId ?? null)) &&
          row.scope_task_id === taskId
      )
      .sort((left, right) => {
        const byTime = OCCURRED_AT_COLLATOR.compare(
          String(right.occurred_at),
          String(left.occurred_at)
        );
        return (
          byTime ||
          OCCURRED_AT_COLLATOR.compare(String(right.id), String(left.id))
        );
      })
      .slice(0, 1);
    return { rows, rowCount: rows.length };
  }

  private readOutcomeReportByToken(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    // The repository's idempotency lookup uses (workspace_id,
    // correlation_token) only, matching the narrowed unique index.
    const normalizedSql = normalizeSql(sql);
    const match =
      /^SELECT \* FROM memory_outcome_reports WHERE correlation_token = \$(\d+) AND workspace_id = \$(\d+) ORDER BY created_at DESC, id DESC LIMIT 1$/i.exec(
        normalizedSql
      );
    if (!match) return null;
    const token = String(params[Number(match[1]) - 1]);
    const workspaceId = String(params[Number(match[2]) - 1]);
    const rows = [...this.tables.memory_outcome_reports.values()]
      .filter(
        (row) =>
          row.correlation_token === token && row.workspace_id === workspaceId
      )
      .sort((left, right) =>
        OCCURRED_AT_COLLATOR.compare(
          String(right.id ?? ""),
          String(left.id ?? "")
        )
      )
      .slice(0, 1);
    return { rows, rowCount: rows.length };
  }

  private readInjectionEventById(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const normalizedSql = normalizeSql(sql);
    if (
      normalizedSql !==
      "SELECT * FROM memory_injection_events WHERE id = $1 AND workspace_id = $2 AND repository_id = $3 AND task_id = $4 AND scope_workspace_id = $2 AND scope_task_id = $4 LIMIT 1"
    ) {
      return null;
    }
    const row = [...this.tables.memory_injection_events.values()].find(
      (event) =>
        event.id === params[0] &&
        event.workspace_id === params[1] &&
        event.repository_id === params[2] &&
        event.task_id === params[3] &&
        event.scope_workspace_id === params[1] &&
        event.scope_task_id === params[3]
    );
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  private readInjectionUseReportByToken(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const normalizedSql = normalizeSql(sql);
    if (
      normalizedSql !==
      "SELECT * FROM memory_injection_use_reports WHERE workspace_id = $1 AND correlation_token = $2 ORDER BY created_at DESC, id DESC LIMIT 1"
    ) {
      return null;
    }
    const row = [...this.tables.memory_injection_use_reports.values()]
      .filter(
        (report) =>
          report.workspace_id === params[0] &&
          report.correlation_token === params[1]
      )
      .sort((left, right) =>
        OCCURRED_AT_COLLATOR.compare(String(right.id), String(left.id))
      )[0];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  private readSessionInjectionCount(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const normalizedSql = normalizeSql(sql);
    const match =
      /^SELECT COUNT\(\*\)::bigint AS count FROM memory_injection_events WHERE workspace_id = \$(\d+) AND repository_id = \$(\d+) AND task_id = \$(\d+) LIMIT 1$/i.exec(
        normalizedSql
      );
    if (!match) return null;
    const wsId = String(params[Number(match[1]) - 1]);
    const repoId = String(params[Number(match[2]) - 1]);
    const taskId = String(params[Number(match[3]) - 1]);
    const count = [...this.tables.memory_injection_events.values()].filter(
      (inj) =>
        inj.workspace_id === wsId &&
        inj.repository_id === repoId &&
        inj.task_id === taskId
    ).length;
    return { rows: [{ count: String(count) }], rowCount: 1 };
  }

  private readSessionOutcomeReport(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const normalizedSql = normalizeSql(sql);
    const match =
      /^SELECT \* FROM memory_session_outcome_reports WHERE workspace_id = \$(\d+) AND repository_id = \$(\d+) AND task_id = \$(\d+) ORDER BY created_at DESC, id DESC LIMIT 1$/i.exec(
        normalizedSql
      );
    if (!match) return null;
    const wsId = String(params[Number(match[1]) - 1]);
    const repoId = String(params[Number(match[2]) - 1]);
    const taskId = String(params[Number(match[3]) - 1]);
    const rows = [...this.tables.memory_session_outcome_reports.values()]
      .filter(
        (row) =>
          row.workspace_id === wsId &&
          row.repository_id === repoId &&
          row.task_id === taskId
      )
      .slice(0, 1);
    return { rows, rowCount: rows.length };
  }

  private readInjectionOutcomeJoin(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    // The repository builds exactly two SQL shapes for the joined read: a
    // paginated SELECT and a COUNT. Both must use the same WHERE clause.
    // The templates are multi-line for readability, so normalize whitespace
    // once here rather than matching \s+ runs throughout.
    const normalizedSql = normalizeSql(sql);
    const pageMatch =
      /^WITH session_counts AS MATERIALIZED \(.+?\) SELECT i\.\*, sc\.session_injection_count, (.+?) FROM memory_injection_events i JOIN session_counts sc ON sc\.workspace_id = i\.workspace_id AND sc\.repository_id IS NOT DISTINCT FROM i\.repository_id AND sc\.task_id = i\.task_id LEFT JOIN memory_outcome_reports r ON r\.workspace_id = i\.workspace_id AND r\.repository_id = i\.repository_id AND r\.correlation_token = i\.correlation_token AND r\.task_id = i\.task_id WHERE (.+?) ORDER BY i\.occurred_at DESC, i\.id DESC LIMIT \$(\d+) OFFSET \$(\d+)$/i.exec(
        normalizedSql
      );
    const countMatch =
      /^SELECT COUNT\(\*\)::bigint AS total FROM memory_injection_events i LEFT JOIN memory_outcome_reports r ON r\.workspace_id = i\.workspace_id AND r\.repository_id = i\.repository_id AND r\.correlation_token = i\.correlation_token AND r\.task_id = i\.task_id WHERE (.+)$/i.exec(
        normalizedSql
      );
    if (!pageMatch && !countMatch) return null;
    // The page SELECT has both a projection capture and a WHERE capture;
    // COUNT has only its WHERE capture. Select the capture that corresponds
    // to the exact SQL shape rather than treating both shapes as group 1.
    const whereSql = (pageMatch ? pageMatch[2] : countMatch?.[1]) as string;
    const limit = pageMatch ? Number(params[Number(pageMatch[3]) - 1]) : 0;
    const offset = pageMatch ? Number(params[Number(pageMatch[4]) - 1]) : 0;
    const predicate = parseInjectionOutcomeJoinWhere(whereSql, params);
    const reportsByInjection = indexReportsByInjection(
      this.tables.memory_outcome_reports
    );
    const matched: Array<{
      injection: Record<string, unknown>;
      report: Record<string, unknown> | null;
    }> = [];
    for (const injection of this.tables.memory_injection_events.values()) {
      const report =
        reportsByInjection.get(injectionJoinKey(injection)) ?? null;
      if (predicate(injection, report)) {
        matched.push({ injection, report });
      }
    }
    matched.sort((left, right) => {
      const byTime = OCCURRED_AT_COLLATOR.compare(
        String(right.injection.occurred_at ?? ""),
        String(left.injection.occurred_at ?? "")
      );
      return (
        byTime ||
        OCCURRED_AT_COLLATOR.compare(
          String(right.injection.id ?? ""),
          String(left.injection.id ?? "")
        )
      );
    });
    if (!pageMatch) {
      return { rows: [{ total: matched.length }], rowCount: 1 };
    }
    const allInjections = [...this.tables.memory_injection_events.values()];
    const sessionCounts = countInjectionsBySession(allInjections);
    const projected = matched
      .slice(offset, offset + limit)
      .map((row) =>
        projectJoinRow(
          row.injection,
          row.report,
          sessionCounts.get(injectionSessionKey(row.injection)) ?? 0
        )
      );
    return { rows: projected, rowCount: projected.length };
  }

  private readInjectionUseJoin(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const normalizedSql = normalizeSql(sql);
    const pageMatch =
      /^WITH session_counts AS MATERIALIZED \(.+?\) SELECT i\.\*, sc\.session_injection_count, (.+?) FROM memory_injection_events i JOIN session_counts sc ON sc\.workspace_id = i\.workspace_id AND sc\.repository_id IS NOT DISTINCT FROM i\.repository_id AND sc\.task_id = i\.task_id LEFT JOIN memory_injection_use_reports r ON r\.workspace_id = i\.workspace_id AND r\.repository_id = i\.repository_id AND r\.correlation_token = i\.correlation_token AND r\.injection_event_id = i\.id WHERE (.+?) ORDER BY i\.occurred_at DESC, i\.id DESC LIMIT \$(\d+) OFFSET \$(\d+)$/i.exec(
        normalizedSql
      );
    const countMatch =
      /^SELECT COUNT\(\*\)::bigint AS total FROM memory_injection_events i LEFT JOIN memory_injection_use_reports r ON r\.workspace_id = i\.workspace_id AND r\.repository_id = i\.repository_id AND r\.correlation_token = i\.correlation_token AND r\.injection_event_id = i\.id WHERE (.+)$/i.exec(
        normalizedSql
      );
    if (!pageMatch && !countMatch) return null;
    const whereSql = (pageMatch ? pageMatch[2] : countMatch?.[1]) as string;
    const predicate = parseInjectionUseJoinWhere(whereSql, params);
    const reports = indexUseReportsByInjection(
      this.tables.memory_injection_use_reports
    );
    const matched: Array<{
      injection: Record<string, unknown>;
      report: Record<string, unknown> | null;
    }> = [];
    for (const injection of this.tables.memory_injection_events.values()) {
      const candidate = reports.get(injectionJoinKey(injection)) ?? null;
      const report =
        candidate?.injection_event_id === injection.id ? candidate : null;
      if (predicate(injection, report)) matched.push({ injection, report });
    }
    matched.sort((left, right) => {
      const byTime = OCCURRED_AT_COLLATOR.compare(
        String(right.injection.occurred_at ?? ""),
        String(left.injection.occurred_at ?? "")
      );
      return (
        byTime ||
        OCCURRED_AT_COLLATOR.compare(
          String(right.injection.id),
          String(left.injection.id)
        )
      );
    });
    if (!pageMatch) return { rows: [{ total: matched.length }], rowCount: 1 };

    const limit = Number(params[Number(pageMatch[3]) - 1]);
    const offset = Number(params[Number(pageMatch[4]) - 1]);
    const sessionCounts = countInjectionsBySession([
      ...this.tables.memory_injection_events.values()
    ]);
    const rows = matched
      .slice(offset, offset + limit)
      .map(({ injection, report }) =>
        projectUseJoinRow(
          injection,
          report,
          sessionCounts.get(injectionSessionKey(injection)) ?? 0
        )
      );
    return { rows, rowCount: rows.length };
  }

  private readInjectionUse(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    return (
      this.readInjectionUseCohorts(sql, params) ??
      this.readInjectionUseJoin(sql, params)
    );
  }

  private readInjectionUseCohorts(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const normalizedSql = normalizeSql(sql);
    if (
      !normalizedSql.includes("cohort_sessions AS MATERIALIZED") ||
      !normalizedSql.includes(
        "SELECT i.memory_mode, sc.session_cardinality, r.use_kind"
      )
    ) {
      return null;
    }
    const memoryModes = readTextArrayFilter(
      normalizedSql,
      params,
      /i\.memory_mode = ANY\(\$(\d+)::text\[\]\)/i
    );
    const useKinds = readTextArrayFilter(
      normalizedSql,
      params,
      /r\.use_kind = ANY\(\$(\d+)::text\[\]\)/i
    );
    const reports = indexUseReportsByInjection(
      this.tables.memory_injection_use_reports
    );
    const events = [...this.tables.memory_injection_events.values()];
    const counts = countInjectionsBySession(events);
    const cells = new Map<string, InjectionUseCohortRow>();
    const filter: InjectionUseCohortFilter = {
      workspaceId: String(params[0]),
      repositoryId: String(params[1]),
      occurredFrom: String(params[2]),
      occurredUntil: String(params[3]),
      ...(memoryModes ? { memoryModes } : {}),
      ...(useKinds ? { useKinds } : {})
    };
    for (const injection of events) {
      addInjectionUseCohortExposure(injection, reports, counts, cells, filter);
    }
    const rows = [...cells.values()].sort(
      (left, right) =>
        OCCURRED_AT_COLLATOR.compare(left.memory_mode, right.memory_mode) ||
        OCCURRED_AT_COLLATOR.compare(
          left.session_cardinality,
          right.session_cardinality
        ) ||
        compareNullableStrings(left.use_kind, right.use_kind)
    );
    return { rows, rowCount: rows.length };
  }

  /**
   * Interprets the single GROUP BY SQL shape
   * `PostgresMemoryRepository.aggregateInjectionOutcomeCohorts` issues. The
   * join key includes the canonical workspace/repository/task/token match.
   * The fake also respects the real `(workspace_id, correlation_token)`
   * uniqueness constraint, which limits each exposure to at most one report.
   */
  private readInjectionOutcomeCohorts(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const normalizedSql = normalizeSql(sql);
    const match =
      /^WITH cohort_sessions AS MATERIALIZED \(.+?\), session_counts AS MATERIALIZED \(.+?\) SELECT i\.memory_mode, i\.injection_result, sc\.session_cardinality, r\.report_kind, r\.outcome_kind, COUNT\(i\.id\)::bigint AS exposure_count, COUNT\(r\.id\)::bigint AS report_count FROM memory_injection_events i JOIN session_counts sc ON sc\.workspace_id = i\.workspace_id AND sc\.repository_id = i\.repository_id AND sc\.task_id = i\.task_id LEFT JOIN memory_outcome_reports r ON r\.workspace_id = i\.workspace_id AND r\.repository_id = i\.repository_id AND r\.correlation_token = i\.correlation_token AND r\.task_id = i\.task_id WHERE (.+) GROUP BY i\.memory_mode, i\.injection_result, sc\.session_cardinality, r\.report_kind, r\.outcome_kind ORDER BY i\.memory_mode, i\.injection_result, sc\.session_cardinality, r\.report_kind NULLS FIRST, r\.outcome_kind NULLS FIRST$/i.exec(
        normalizedSql
      );
    if (!match) return null;
    const whereSql = match[1] as string;
    const predicate = parseInjectionOutcomeCohortWhere(whereSql, params);
    const reportsByToken = indexReportsByWorkspaceToken(
      this.tables.memory_outcome_reports
    );
    const allInjections = [...this.tables.memory_injection_events.values()];
    const sessionCounts = countInjectionsBySession(allInjections);
    const cells = new Map<string, InjectionOutcomeCohortRow>();
    const accumulator: InjectionOutcomeCohortAccumulator = {
      predicate,
      reportsByToken,
      sessionCounts,
      cells
    };
    for (const injection of this.tables.memory_injection_events.values()) {
      addInjectionOutcomeCohortExposure(injection, accumulator);
    }
    const rows = [...cells.values()].sort(compareInjectionOutcomeCohortRows);
    return { rows, rowCount: rows.length };
  }

  private readSessionOutcomeCohorts(
    sql: string,
    params: readonly unknown[]
  ): MemoryQueryResult | null {
    const normalizedSql = normalizeSql(sql);
    if (!normalizedSql.includes("in_window_events AS MATERIALIZED"))
      return null;

    const filter = parseSessionOutcomeCohortFilter(normalizedSql, params);
    const events = this.tables.memory_injection_events.values();
    const inWindowSessionKeys = selectInWindowSessionKeys(events, filter);
    const cellMap = new Map<string, SessionOutcomeCohortRow>();
    let mixedModeSessionCount = 0;
    let mixedModeConflictingCount = 0;

    for (const sessionKey of inWindowSessionKeys) {
      const cohort = projectSessionOutcomeCohort(
        sessionKey,
        this.tables,
        filter
      );
      if (!cohort) continue;
      if (cohort.cohort_mode === "mixed") {
        mixedModeSessionCount += 1;
        mixedModeConflictingCount += cohort.conflicting_count;
        continue;
      }
      addSessionOutcomeCohort(cellMap, cohort);
    }

    const rows = [...cellMap.values()].sort(compareSessionOutcomeRows);
    if (mixedModeSessionCount > 0) {
      rows.push({
        cohort_mode: "mixed",
        outcome_kind: null,
        session_count: mixedModeSessionCount,
        conflicting_count: mixedModeConflictingCount
      });
    }

    return { rows, rowCount: rows.length };
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
    if (sql.startsWith("SELECT pg_advisory_xact_lock(")) {
      // applyMemoryMigrations serializes bootstrap table creation and each
      // migration's check/apply behind this transaction-scoped advisory
      // lock. FakeMemoryPool runs every query sequentially (there is no
      // real concurrency inside one JS event loop turn without awaiting
      // across calls), so the lock itself is a no-op here; its SQL shape
      // still needs to be recognized rather than falling through as an
      // unrecognized statement.
      result = { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };
    } else if (
      sql.startsWith("CREATE TABLE IF NOT EXISTS memory_schema_migrations")
    ) {
      result = { rows: [], rowCount: 0 };
    } else if (sql === "SELECT version FROM memory_schema_migrations") {
      result = {
        rows: this.tables.memory_schema_migrations as unknown[] as Record<
          string,
          unknown
        >[],
        rowCount: this.tables.memory_schema_migrations.length
      };
    } else if (
      sql === "SELECT version FROM memory_schema_migrations WHERE version = $1"
    ) {
      // The per-migration recheck applyMemoryMigrations issues while
      // holding the advisory lock, immediately before deciding whether to
      // run that migration's DDL.
      const rows = this.tables.memory_schema_migrations.filter(
        (row) => row.version === params[0]
      ) as unknown[] as Record<string, unknown>[];
      result = { rows, rowCount: rows.length };
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
      return this.insertVersionedRow(table, row);
    }
    if (table === "memory_experience_privacy_events") {
      this.tables.memory_experience_privacy_events.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (table === "memory_injection_events") {
      return this.insertInjectionEvent(row);
    }
    if (table === "memory_outcome_reports") {
      return this.insertOutcomeReport(row);
    }
    if (table === "memory_injection_use_reports") {
      return this.insertInjectionUseReport(row);
    }
    if (table === "memory_session_outcome_reports") {
      return this.insertSessionOutcomeReport(row);
    }
    if (table === "memory_lifecycle_events") {
      return this.insertLifecycleEvent(row);
    }

    throw new TypeError(
      `FakeMemoryPool cannot insert into unknown table: ${table}`
    );
  }

  private insertVersionedRow(
    table: "memory_experiences" | "memory_records",
    row: Record<string, unknown>
  ): MemoryQueryResult {
    const map = this.tables[table];
    const id = row.id as string;
    if (map.has(id)) {
      throw uniqueViolation(
        `duplicate key value violates unique constraint "${table}_pkey"`
      );
    }
    map.set(id, row);
    return { rows: [row], rowCount: 1 };
  }

  private insertInjectionEvent(
    row: Record<string, unknown>
  ): MemoryQueryResult {
    const map = this.tables.memory_injection_events;
    const id = row.id as string;
    if (map.has(id)) {
      throw uniqueViolation(
        `duplicate key value violates unique constraint "memory_injection_events_pkey"`
      );
    }
    // memory_injection_events.correlation_token is a bare column-level
    // UNIQUE constraint: one token, globally, across every workspace.
    const token = row.correlation_token as string | undefined;
    if (token) {
      for (const existing of map.values()) {
        if (existing.correlation_token === token) {
          throw uniqueViolation(
            `duplicate key value violates unique constraint "memory_injection_events_correlation_token_key"`
          );
        }
      }
    }
    map.set(id, row);
    return { rows: [row], rowCount: 1 };
  }

  private insertOutcomeReport(row: Record<string, unknown>): MemoryQueryResult {
    const map = this.tables.memory_outcome_reports;
    const id = row.id as string;
    if (map.has(id)) {
      throw uniqueViolation(
        `duplicate key value violates unique constraint "memory_outcome_reports_pkey"`
      );
    }
    // Enforce the unique index on (workspace_id, correlation_token): at
    // most one outcome report per injection, per workspace.
    for (const existing of map.values()) {
      if (
        existing.workspace_id === row.workspace_id &&
        existing.correlation_token === row.correlation_token
      ) {
        throw uniqueViolation(
          `duplicate key value violates unique constraint "uniq_memory_outcome_reports_scope_key"`
        );
      }
    }
    // The reporter_authority column is narrowed to "root"/"curator".
    if (
      row.reporter_authority !== "root" &&
      row.reporter_authority !== "curator"
    ) {
      throw new Error(
        `memory_outcome_reports.reporter_authority check violation: ${row.reporter_authority}`
      );
    }
    map.set(id, row);
    return { rows: [row], rowCount: 1 };
  }

  private insertInjectionUseReport(
    row: Record<string, unknown>
  ): MemoryQueryResult {
    const map = this.tables.memory_injection_use_reports;
    const id = row.id as string;
    if (map.has(id)) {
      throw uniqueViolation(
        `duplicate key value violates unique constraint "memory_injection_use_reports_pkey"`
      );
    }
    if (
      [...map.values()].some(
        (existing) =>
          existing.workspace_id === row.workspace_id &&
          existing.correlation_token === row.correlation_token
      )
    ) {
      throw uniqueViolation(
        `duplicate key value violates unique constraint "uniq_memory_injection_use_reports_scope_key"`
      );
    }
    const event = this.tables.memory_injection_events.get(
      String(row.injection_event_id)
    );
    if (!event) {
      throw new Error(
        "memory_injection_use_reports requires a recorded injection event"
      );
    }
    assertFakeUseReportValid(row, event);
    map.set(id, row);
    return { rows: [row], rowCount: 1 };
  }

  private insertSessionOutcomeReport(
    row: Record<string, unknown>
  ): MemoryQueryResult {
    const map = this.tables.memory_session_outcome_reports;
    const id = row.id as string;
    if (map.has(id)) {
      throw uniqueViolation(
        `duplicate key value violates unique constraint "memory_session_outcome_reports_pkey"`
      );
    }
    // Enforce UNIQUE (workspace_id, repository_id, task_id)
    for (const existing of map.values()) {
      if (
        existing.workspace_id === row.workspace_id &&
        existing.repository_id === row.repository_id &&
        existing.task_id === row.task_id
      ) {
        throw uniqueViolation(
          `duplicate key value violates unique constraint "uniq_memory_session_outcome_reports_key"`
        );
      }
    }
    // Validate trigger: requires at least one matching injection event
    const hasInjection = [...this.tables.memory_injection_events.values()].some(
      (inj) =>
        inj.workspace_id === row.workspace_id &&
        inj.repository_id === row.repository_id &&
        inj.task_id === row.task_id
    );
    if (!hasInjection) {
      throw new Error(
        "memory_session_outcome_reports requires at least one recorded injection event for (workspace_id, repository_id, task_id)"
      );
    }
    if (
      row.reporter_authority !== "root" &&
      row.reporter_authority !== "curator"
    ) {
      throw new Error(
        `memory_session_outcome_reports.reporter_authority check violation: ${row.reporter_authority}`
      );
    }
    map.set(id, row);
    return { rows: [row], rowCount: 1 };
  }

  private insertLifecycleEvent(
    row: Record<string, unknown>
  ): MemoryQueryResult {
    const memoryId = row.memory_id as string;
    if (!this.tables.memory_records.has(memoryId)) {
      throw foreignKeyViolation(
        `insert or update on table "memory_lifecycle_events" violates foreign key constraint: memory_id ${memoryId} not found`
      );
    }
    this.tables.memory_lifecycle_events.push(row);
    return { rows: [row], rowCount: 1 };
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

/**
 * Narrow, explicit matcher for the WHERE clause the repository emits from
 * `buildSessionScopeFilter` plus the modal-union filters. The fake does NOT
 * attempt to interpret arbitrary SQL — only the well-known shapes the
 * repository generates.
 */
function parseInjectionOutcomeJoinWhere(
  whereSql: string,
  params: readonly unknown[]
): (
  injection: Record<string, unknown>,
  report: Record<string, unknown> | null
) => boolean {
  // workspace + repository + task session scope
  const scopeWithRepository =
    /\(i\.scope_workspace_id = \$(\d+) AND i\.repository_id = \$(\d+) AND i\.scope_task_id = \$(\d+)\)/i.exec(
      whereSql
    );
  const scopeWithoutRepository =
    /\(i\.scope_workspace_id = \$(\d+) AND i\.scope_task_id = \$(\d+)\)/i.exec(
      whereSql
    );
  const scopeMatch = scopeWithRepository ?? scopeWithoutRepository;
  let workspaceId: string | undefined;
  let repositoryId: string | undefined;
  let taskId: string | undefined;
  if (scopeMatch) {
    workspaceId = String(params[Number(scopeMatch[1]) - 1]);
    if (scopeWithRepository) {
      repositoryId = String(params[Number(scopeWithRepository[2]) - 1]);
      taskId = String(params[Number(scopeWithRepository[3]) - 1]);
    } else {
      taskId = String(params[Number(scopeMatch[2]) - 1]);
    }
  }
  // i.memory_mode = ANY($N::text[])  -- optional
  const modeMatch = /i\.memory_mode = ANY\(\$(\d+)::text\[\]\)/i.exec(whereSql);
  const modes = modeMatch
    ? (params[Number(modeMatch[1]) - 1] as readonly string[])
    : undefined;
  // i.injection_result = ANY($N::text[])  -- optional
  const resultMatch = /i\.injection_result = ANY\(\$(\d+)::text\[\]\)/i.exec(
    whereSql
  );
  const results = resultMatch
    ? (params[Number(resultMatch[1]) - 1] as readonly string[])
    : undefined;
  // r.outcome_kind = ANY($N::text[])  -- optional
  const outcomeMatch = /r\.outcome_kind = ANY\(\$(\d+)::text\[\]\)/i.exec(
    whereSql
  );
  const outcomeKinds = outcomeMatch
    ? (params[Number(outcomeMatch[1]) - 1] as readonly string[])
    : undefined;
  // r.report_kind = ANY($N::text[])  -- optional
  const reportMatch = /r\.report_kind = ANY\(\$(\d+)::text\[\]\)/i.exec(
    whereSql
  );
  const reportKinds = reportMatch
    ? (params[Number(reportMatch[1]) - 1] as readonly string[])
    : undefined;
  // Default includeUnreported=false -> `r.outcome_kind IS NOT NULL`
  // includeUnreported=true -> `(r.id IS NULL OR r.outcome_kind IS NOT NULL)`
  const includeUnreported = /r\.id IS NULL/i.test(whereSql);
  return (injection, report) => {
    if (
      workspaceId !== undefined &&
      String(injection.scope_workspace_id ?? "") !== workspaceId
    )
      return false;
    if (
      repositoryId !== undefined &&
      String(injection.repository_id ?? "") !== repositoryId
    )
      return false;
    if (
      taskId !== undefined &&
      String(injection.scope_task_id ?? "") !== taskId
    )
      return false;
    if (modes && !modes.includes(String(injection.memory_mode ?? "")))
      return false;
    if (results && !results.includes(String(injection.injection_result ?? "")))
      return false;
    if (report === null) {
      if (!includeUnreported) return false;
    } else {
      if (outcomeKinds && !outcomeKinds.includes(String(report.outcome_kind)))
        return false;
      if (
        reportKinds &&
        !reportKinds.includes(String(report.report_kind ?? ""))
      )
        return false;
    }
    return true;
  };
}

function injectionJoinKey(row: Record<string, unknown>): string {
  return [
    row.workspace_id ?? "",
    row.correlation_token ?? "",
    row.scope_task_id ?? row.task_id ?? "",
    row.repository_id ?? ""
  ].join("\u0001");
}

function indexReportsByInjection(
  reports: Map<string, Record<string, unknown>>
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const report of reports.values()) {
    map.set(
      [
        report.workspace_id ?? "",
        report.correlation_token ?? "",
        report.task_id ?? "",
        report.repository_id ?? ""
      ].join("\u0001"),
      report
    );
  }
  return map;
}

function rowStringArray(value: unknown): string[] {
  let decoded: unknown = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return [];
    }
  }
  return Array.isArray(decoded) &&
    decoded.every((item) => typeof item === "string")
    ? decoded
    : [];
}

function indexUseReportsByInjection(
  reports: Map<string, Record<string, unknown>>
): Map<string, Record<string, unknown>> {
  return indexReportsByInjection(reports);
}

function assertFakeUseReportValid(
  row: Record<string, unknown>,
  event: Record<string, unknown>
): void {
  assertEligibleInjectionForUse(event);
  assertUseReportScopeMatchesEvent(row, event);
  assertUsedMemoryIdsMatchPacket(row, event);
  assertUseReportMetadata(row);
}

function assertEligibleInjectionForUse(event: Record<string, unknown>): void {
  if (
    event.injection_result !== "injected" ||
    (event.memory_mode !== "jit" && event.memory_mode !== "retrieval-only") ||
    rowStringArray(event.memory_ids).length === 0
  ) {
    throw new TypeError(
      "memory_injection_use_reports requires an eligible injected packet"
    );
  }
}

function assertUseReportScopeMatchesEvent(
  row: Record<string, unknown>,
  event: Record<string, unknown>
): void {
  if (
    !String(row.repository_id ?? "").trim() ||
    row.workspace_id !== event.workspace_id ||
    row.repository_id !== event.repository_id ||
    row.task_id !== event.task_id ||
    row.correlation_token !== event.correlation_token ||
    event.scope_kind !== "task" ||
    event.scope_workspace_id !== event.workspace_id ||
    event.scope_task_id !== event.task_id ||
    row.scope_kind !== "task" ||
    row.scope_workspace_id !== row.workspace_id ||
    row.scope_task_id !== row.task_id
  ) {
    throw new TypeError(
      "memory_injection_use_reports event scope does not match report scope"
    );
  }
}

function assertUsedMemoryIdsMatchPacket(
  row: Record<string, unknown>,
  event: Record<string, unknown>
): void {
  const packetIds = rowStringArray(event.memory_ids);
  const rawUsedIds = rowJsonValue(row.used_memory_ids);
  if (
    !Array.isArray(rawUsedIds) ||
    !rawUsedIds.every((memoryId) => typeof memoryId === "string")
  ) {
    throw new TypeError(
      "memory_injection_use_reports used_memory_ids must be a string array"
    );
  }
  const usedIds = rawUsedIds as string[];
  if (new Set(usedIds).size !== usedIds.length) {
    throw new TypeError(
      "memory_injection_use_reports used_memory_ids must not contain duplicates"
    );
  }
  if (usedIds.some((memoryId) => !packetIds.includes(memoryId))) {
    throw new Error(
      "memory_injection_use_reports used_memory_ids must be a subset of packet memory_ids"
    );
  }
  const useKind = String(row.use_kind);
  if (!isFakeUseKind(useKind, usedIds.length, packetIds.length)) {
    throw new Error(
      "memory_injection_use_reports used_memory_ids cardinality does not match use_kind"
    );
  }
}

function isFakeUseKind(
  useKind: string,
  usedIdCount: number,
  packetIdCount: number
): boolean {
  switch (useKind) {
    case "used": {
      return usedIdCount === packetIdCount;
    }
    case "partially_used": {
      return usedIdCount > 0 && usedIdCount < packetIdCount;
    }
    case "not_used":
    case "unobservable": {
      return usedIdCount === 0;
    }
    default: {
      return false;
    }
  }
}

function assertUseReportMetadata(row: Record<string, unknown>): void {
  const useKind = String(row.use_kind);
  if (
    (useKind === "unobservable" &&
      row.reason_code !== "reporter_unobservable") ||
    (useKind !== "unobservable" && row.reason_code !== "reporter_supplied")
  ) {
    throw new TypeError(
      "memory_injection_use_reports reason_code check violation"
    );
  }
  if (
    row.reporter_authority !== "root" &&
    row.reporter_authority !== "curator"
  ) {
    throw new TypeError(
      `memory_injection_use_reports.reporter_authority check violation: ${row.reporter_authority}`
    );
  }
  const rawEvidence = rowJsonValue(row.evidence);
  if (!Array.isArray(rawEvidence)) {
    throw new TypeError(
      "memory_injection_use_reports evidence must be an array"
    );
  }
  if (
    useKind !== "unobservable" &&
    !rawEvidence.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).kind === "trajectory" &&
        typeof (item as Record<string, unknown>).uri === "string" &&
        ((item as Record<string, unknown>).uri as string).trim().length > 0
    )
  ) {
    throw new TypeError(
      "memory_injection_use_reports requires trajectory evidence"
    );
  }
}

function rowJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isEligibleInjectionUseExposure(
  injection: Record<string, unknown>,
  workspaceId: string,
  repositoryId: string,
  occurredFrom: string,
  occurredUntil: string,
  memoryModes: readonly string[] | undefined
): boolean {
  const memoryIds = rowStringArray(injection.memory_ids);
  const occurredAt = String(injection.occurred_at ?? "");
  return (
    injection.workspace_id === workspaceId &&
    injection.repository_id === repositoryId &&
    occurredAt >= occurredFrom &&
    occurredAt <= occurredUntil &&
    injection.injection_result === "injected" &&
    (injection.memory_mode === "jit" ||
      injection.memory_mode === "retrieval-only") &&
    memoryIds.length > 0 &&
    (!memoryModes || memoryModes.includes(String(injection.memory_mode)))
  );
}

function findUseReportForInjection(
  injection: Record<string, unknown>,
  reports: Map<string, Record<string, unknown>>
): Record<string, unknown> | undefined {
  const candidate = reports.get(injectionJoinKey(injection));
  return candidate?.injection_event_id === injection.id ? candidate : undefined;
}

function compareNullableStrings(
  left: string | null,
  right: string | null
): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return OCCURRED_AT_COLLATOR.compare(left, right);
}

function parseInjectionUseJoinWhere(
  whereSql: string,
  params: readonly unknown[]
): (
  injection: Record<string, unknown>,
  report: Record<string, unknown> | null
) => boolean {
  const workspaceMatch = /i\.workspace_id = \$(\d+)/i.exec(whereSql);
  const repositoryMatch = /i\.repository_id = \$(\d+)/i.exec(whereSql);
  const taskMatch = /i\.task_id = \$(\d+)/i.exec(whereSql);
  if (!workspaceMatch || !repositoryMatch || !taskMatch) {
    throw new Error(
      `FakeMemoryPool cannot interpret use join WHERE clause: ${whereSql}`
    );
  }
  const workspaceId = String(params[Number(workspaceMatch[1]) - 1]);
  const repositoryId = String(params[Number(repositoryMatch[1]) - 1]);
  const taskId = String(params[Number(taskMatch[1]) - 1]);
  const modeMatch = /i\.memory_mode = ANY\(\$(\d+)::text\[\]\)/i.exec(whereSql);
  const modes = modeMatch
    ? (params[Number(modeMatch[1]) - 1] as readonly string[])
    : undefined;
  const resultMatch = /i\.injection_result = ANY\(\$(\d+)::text\[\]\)/i.exec(
    whereSql
  );
  const results = resultMatch
    ? (params[Number(resultMatch[1]) - 1] as readonly string[])
    : undefined;
  const useMatch = /r\.use_kind = ANY\(\$(\d+)::text\[\]\)/i.exec(whereSql);
  const useKinds = useMatch
    ? (params[Number(useMatch[1]) - 1] as readonly string[])
    : undefined;
  const requireReport = /r\.id IS NOT NULL/i.test(whereSql);
  return (injection, report) => {
    const memoryIds = rowStringArray(injection.memory_ids);
    if (
      injection.workspace_id !== workspaceId ||
      injection.repository_id !== repositoryId ||
      injection.task_id !== taskId ||
      injection.scope_workspace_id !== workspaceId ||
      injection.scope_task_id !== taskId ||
      injection.injection_result !== "injected" ||
      (injection.memory_mode !== "jit" &&
        injection.memory_mode !== "retrieval-only") ||
      memoryIds.length === 0 ||
      (modes && !modes.includes(String(injection.memory_mode))) ||
      (results && !results.includes(String(injection.injection_result)))
    ) {
      return false;
    }
    if (report === null) return !requireReport;
    return !useKinds || useKinds.includes(String(report.use_kind));
  };
}

function projectUseJoinRow(
  injection: Record<string, unknown>,
  report: Record<string, unknown> | null,
  sessionInjectionCount: number
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...injection,
    session_injection_count: sessionInjectionCount
  };
  const aliases: Readonly<Record<string, string>> = {
    use_report_id: "id",
    use_report_injection_event_id: "injection_event_id",
    use_report_workspace_id: "workspace_id",
    use_report_repository_id: "repository_id",
    use_report_scope_kind: "scope_kind",
    use_report_scope_workspace_id: "scope_workspace_id",
    use_report_scope_repository_id: "scope_repository_id",
    use_report_scope_role: "scope_role",
    use_report_scope_task_id: "scope_task_id",
    use_report_scope_run_id: "scope_run_id",
    use_report_scope_agent_id: "scope_agent_id",
    use_report_task_id: "task_id",
    use_report_run_id: "run_id",
    use_report_agent_id: "agent_id",
    use_report_agent_role: "agent_role",
    use_report_correlation_token: "correlation_token",
    use_report_kind: "use_kind",
    use_report_memory_ids: "used_memory_ids",
    use_report_reported_at: "reported_at",
    use_report_reporter_id: "reporter_id",
    use_report_reporter_authority: "reporter_authority",
    use_report_reason_code: "reason_code",
    use_report_evidence: "evidence"
  };
  for (const [alias, column] of Object.entries(aliases)) {
    projected[alias] = report ? (report[column] ?? null) : null;
  }
  return projected;
}

function injectionSessionKey(row: Record<string, unknown>): string {
  // Mirrors both repository aggregates. JSON tuple encoding preserves the
  // difference between a NULL repository and an empty-string repository.
  return JSON.stringify([
    row.workspace_id ?? null,
    row.repository_id ?? null,
    row.task_id ?? null
  ]);
}

function countInjectionsBySession(
  injections: readonly Record<string, unknown>[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const injection of injections) {
    const key = injectionSessionKey(injection);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function projectJoinRow(
  injection: Record<string, unknown>,
  report: Record<string, unknown> | null,
  sessionInjectionCountValue: number
): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...injection,
    session_injection_count: sessionInjectionCountValue
  };
  const reportProjection: Readonly<Record<string, string>> = {
    report_id: "id",
    report_workspace_id: "workspace_id",
    report_repository_id: "repository_id",
    report_scope_kind: "scope_kind",
    report_scope_workspace_id: "scope_workspace_id",
    report_scope_repository_id: "scope_repository_id",
    report_scope_role: "scope_role",
    report_scope_task_id: "scope_task_id",
    report_scope_run_id: "scope_run_id",
    report_scope_agent_id: "scope_agent_id",
    report_task_id: "task_id",
    report_run_id: "run_id",
    report_agent_id: "agent_id",
    report_correlation_token: "correlation_token",
    outcome_kind: "outcome_kind",
    report_kind: "report_kind",
    reported_at: "reported_at",
    reporter_id: "reporter_id",
    reporter_authority: "reporter_authority",
    report_evidence: "evidence",
    report_reason_code: "reason_code"
  };
  if (report === null) {
    for (const alias of Object.keys(reportProjection)) projected[alias] = null;
    return projected;
  }
  for (const [alias, column] of Object.entries(reportProjection)) {
    projected[alias] = report[column] ?? null;
  }
  return projected;
}

/**
 * Narrow matcher for the WHERE clause
 * `PostgresMemoryRepository.aggregateInjectionOutcomeCohorts` builds: a
 * hard workspace/repository/occurred-window filter plus the four optional
 * bounded-enum filters. The fake does NOT attempt to interpret arbitrary
 * SQL, only this well-known shape.
 */
function parseInjectionOutcomeCohortWhere(
  whereSql: string,
  params: readonly unknown[]
): (
  injection: Record<string, unknown>,
  report: Record<string, unknown> | null
) => boolean {
  const hardMatch =
    /i\.workspace_id = \$(\d+) AND i\.repository_id = \$(\d+) AND i\.occurred_at >= \$(\d+) AND i\.occurred_at <= \$(\d+)/i.exec(
      whereSql
    );
  if (!hardMatch) {
    throw new Error(
      `FakeMemoryPool cannot interpret cohort WHERE clause: ${whereSql}`
    );
  }
  const workspaceId = String(params[Number(hardMatch[1]) - 1]);
  const repositoryId = String(params[Number(hardMatch[2]) - 1]);
  const occurredFrom = String(params[Number(hardMatch[3]) - 1]);
  const occurredUntil = String(params[Number(hardMatch[4]) - 1]);

  const modeMatch = /i\.memory_mode = ANY\(\$(\d+)::text\[\]\)/i.exec(whereSql);
  const modes = modeMatch
    ? (params[Number(modeMatch[1]) - 1] as readonly string[])
    : undefined;
  const resultMatch = /i\.injection_result = ANY\(\$(\d+)::text\[\]\)/i.exec(
    whereSql
  );
  const results = resultMatch
    ? (params[Number(resultMatch[1]) - 1] as readonly string[])
    : undefined;
  const reportKindMatch = /r\.report_kind = ANY\(\$(\d+)::text\[\]\)/i.exec(
    whereSql
  );
  const reportKinds = reportKindMatch
    ? (params[Number(reportKindMatch[1]) - 1] as readonly string[])
    : undefined;
  const outcomeKindMatch = /r\.outcome_kind = ANY\(\$(\d+)::text\[\]\)/i.exec(
    whereSql
  );
  const outcomeKinds = outcomeKindMatch
    ? (params[Number(outcomeKindMatch[1]) - 1] as readonly string[])
    : undefined;

  return (injection, report) => {
    if (String(injection.workspace_id ?? "") !== workspaceId) return false;
    if (String(injection.repository_id ?? "") !== repositoryId) return false;
    const occurredAt = String(injection.occurred_at ?? "");
    if (occurredAt < occurredFrom || occurredAt > occurredUntil) return false;
    if (modes && !modes.includes(String(injection.memory_mode ?? "")))
      return false;
    if (results && !results.includes(String(injection.injection_result ?? "")))
      return false;
    if (reportKinds && !reportKinds.includes(String(report?.report_kind ?? "")))
      return false;
    if (
      outcomeKinds &&
      !outcomeKinds.includes(String(report?.outcome_kind ?? ""))
    )
      return false;
    return true;
  };
}

/** `(workspace_id, correlation_token)` key matching the real unique index. */
function injectionWorkspaceTokenKey(row: Record<string, unknown>): string {
  return [row.workspace_id ?? "", row.correlation_token ?? ""].join("\u0001");
}

function indexReportsByWorkspaceToken(
  reports: Map<string, Record<string, unknown>>
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const report of reports.values()) {
    map.set(injectionWorkspaceTokenKey(report), report);
  }
  return map;
}
