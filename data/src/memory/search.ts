import type {
  ExperienceListRequest,
  ExperienceSearchRequest,
  MemoryListRequest,
  MemorySearchRequest
} from "@simulatorlife/autodev-core";

import {
  buildExperienceScopeFilterSql,
  buildScopeFilterSql,
  SqlParams
} from "./scope-sql.ts";

export interface BuiltQuery {
  readonly text: string;
  readonly params: readonly unknown[];
}

export interface VectorRankingWeights {
  readonly lexicalWeight?: number;
  readonly vectorWeight?: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_LEXICAL_WEIGHT = 0.6;
const DEFAULT_VECTOR_WEIGHT = 0.4;

/**
 * Builds the memory search query as a two-stage statement: the `scoped`
 * CTE applies every hard filter (scope visibility, status, validity,
 * requested kinds, file-evidence path matches, verified validity, and as-of
 * window) and the outer SELECT is the only place a
 * ranking expression (lexical and, optionally, vector) is computed. This
 * keeps "filter before rank" a structural property of the generated SQL
 * rather than a convention callers must trust.
 *
 * pgvector ranking is purely optional: it activates only when the caller
 * supplies `request.queryEmbedding` (computed upstream via the existing
 * provider/model abstraction, never inside this package); exact lexical
 * retrieval via `ts_rank` always runs.
 */
export function buildMemorySearchQuery(
  request: MemorySearchRequest,
  weights: VectorRankingWeights = {}
): BuiltQuery {
  const params = new SqlParams();
  const scopeFilter = buildScopeFilterSql(
    "memory_records",
    request.context,
    params
  );

  const queryParam = params.add(request.query);
  const asOfParam = params.add(request.asOf ?? new Date().toISOString());

  const filters = [
    scopeFilter,
    "status = 'active'",
    "validity_state = 'verified'",
    `(validity_valid_from IS NULL OR validity_valid_from <= ${asOfParam}::timestamptz)`,
    `(validity_valid_to IS NULL OR validity_valid_to > ${asOfParam}::timestamptz)`
  ];
  if (request.relevantPaths && request.relevantPaths.length > 0) {
    const pathsParam = params.add(request.relevantPaths);
    filters.push(
      `EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(memory_records.provenance->'evidence', '[]'::jsonb)) AS evidence_ref WHERE evidence_ref->>'kind' = 'file' AND evidence_ref->>'uri' = ANY(${pathsParam}::text[]))`
    );
  }

  if (request.kinds && request.kinds.length > 0) {
    const kindsParam = params.add(request.kinds);
    filters.push(`kind = ANY(${kindsParam}::text[])`);
  }

  const limitParam = params.add(request.limit ?? DEFAULT_LIMIT);

  const embedding = request.queryEmbedding;
  let vectorParam: string | undefined;
  if (embedding) {
    vectorParam = params.add(`[${embedding.join(",")}]`);
  }

  const lexicalWeight = embedding
    ? (weights.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT)
    : 1;
  const vectorWeight = weights.vectorWeight ?? DEFAULT_VECTOR_WEIGHT;
  const scoreExpr = embedding
    ? `(ts_rank(claim_search, plainto_tsquery('english', ${queryParam})) * ${lexicalWeight}) + (CASE WHEN embedding IS NOT NULL THEN (1 - (embedding <=> ${vectorParam}::vector)) * ${vectorWeight} ELSE 0 END)`
    : `ts_rank(claim_search, plainto_tsquery('english', ${queryParam})) * ${lexicalWeight}`;

  const text = `
WITH scoped AS (
  SELECT id, kind, scope_kind, scope_workspace_id, scope_repository_id, scope_role,
         scope_task_id, scope_run_id, scope_agent_id, claim, claim_search, status,
         provenance, validity_state, validity_valid_from, validity_valid_to,
         validity_detail, supersedes, superseded_by, embedding, created_at, updated_at
  FROM memory_records
  WHERE ${filters.join(" AND ")}
)
SELECT *, ${scoreExpr} AS score
FROM scoped
ORDER BY score DESC
LIMIT ${limitParam}
`.trim();

  return { text, params: params.all };
}

/**
 * Same filter-before-rank structure as `buildMemorySearchQuery`, applied to
 * append-only experience envelopes: the `scoped` CTE enforces visibility,
 * the outer SELECT computes the lexical rank.
 */
export function buildExperienceSearchQuery(
  request: ExperienceSearchRequest
): BuiltQuery {
  const params = new SqlParams();
  const scopeFilter = buildExperienceScopeFilterSql(
    "memory_experiences",
    request.context,
    params
  );
  const queryParam = params.add(request.query);
  const limitParam = params.add(request.limit ?? DEFAULT_LIMIT);

  const text = `
WITH scoped AS (
  SELECT *
  FROM memory_experiences
  WHERE ${scopeFilter}
)
SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${queryParam})) AS score
FROM scoped
ORDER BY score DESC
LIMIT ${limitParam}
`.trim();

  return { text, params: params.all };
}

export interface BuiltListQuery {
  readonly countText: string;
  readonly countParams: readonly unknown[];
  readonly text: string;
  readonly params: readonly unknown[];
}

/** Builds a scoped browser query; statuses remain inspectable, unlike JIT retrieval. */
export function buildMemoryListQuery(
  request: MemoryListRequest
): BuiltListQuery {
  const params = new SqlParams();
  const scopeFilter = buildScopeFilterSql(
    "memory_records",
    request.context,
    params
  );
  const filters = [scopeFilter];
  const query = request.query?.trim();
  if (query) {
    const queryParam = params.add(query);
    filters.push(`claim_search @@ plainto_tsquery('english', ${queryParam})`);
  }
  if (request.kinds && request.kinds.length > 0) {
    const kindsParam = params.add(request.kinds);
    filters.push(`kind = ANY(${kindsParam}::text[])`);
  }
  if (request.statuses && request.statuses.length > 0) {
    const statusesParam = params.add(request.statuses);
    filters.push(`status = ANY(${statusesParam}::text[])`);
  }
  const where = filters.join(" AND ");
  const countText = `SELECT COUNT(*)::bigint AS total FROM memory_records WHERE ${where}`;
  const rowParams = new SqlParams();
  const rowScope = buildScopeFilterSql(
    "memory_records",
    request.context,
    rowParams
  );
  const rowFilters = [rowScope];
  const rowQuery = request.query?.trim();
  let rowQueryParam: string | undefined;
  if (rowQuery) {
    rowQueryParam = rowParams.add(rowQuery);
    rowFilters.push(
      `claim_search @@ plainto_tsquery('english', ${rowQueryParam})`
    );
  }
  if (request.kinds && request.kinds.length > 0) {
    const kindsParam = rowParams.add(request.kinds);
    rowFilters.push(`kind = ANY(${kindsParam}::text[])`);
  }
  if (request.statuses && request.statuses.length > 0) {
    const statusesParam = rowParams.add(request.statuses);
    rowFilters.push(`status = ANY(${statusesParam}::text[])`);
  }
  const limitParam = rowParams.add(request.limit ?? 50);
  const offsetParam = rowParams.add(request.offset ?? 0);
  const order = rowQueryParam
    ? `ts_rank(claim_search, plainto_tsquery('english', ${rowQueryParam})) DESC, created_at DESC`
    : "created_at DESC";
  const text = `SELECT * FROM memory_records WHERE ${rowFilters.join(" AND ")} ORDER BY ${order}, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`;
  return { countText, countParams: params.all, text, params: rowParams.all };
}

export function buildExperienceListQuery(
  request: ExperienceListRequest
): BuiltListQuery {
  const query = request.query?.trim();
  const countParams = new SqlParams();
  const countScope = buildExperienceScopeFilterSql(
    "memory_experiences",
    request.context,
    countParams
  );
  const countFilters = [countScope];
  if (query) {
    const queryParam = countParams.add(query);
    countFilters.push(
      `search_vector @@ plainto_tsquery('english', ${queryParam})`
    );
  }

  const rowParams = new SqlParams();
  const rowScope = buildExperienceScopeFilterSql(
    "memory_experiences",
    request.context,
    rowParams
  );
  const rowFilters = [rowScope];
  let rowQueryParam: string | undefined;
  if (query) {
    rowQueryParam = rowParams.add(query);
    rowFilters.push(
      `search_vector @@ plainto_tsquery('english', ${rowQueryParam})`
    );
  }
  const limitParam = rowParams.add(request.limit ?? 50);
  const offsetParam = rowParams.add(request.offset ?? 0);
  const order = rowQueryParam
    ? `ts_rank(search_vector, plainto_tsquery('english', ${rowQueryParam})) DESC, completed_at DESC NULLS LAST`
    : "completed_at DESC NULLS LAST";
  return {
    countText: `SELECT COUNT(*)::bigint AS total FROM memory_experiences WHERE ${countFilters.join(" AND ")}`,
    countParams: countParams.all,
    text: `SELECT * FROM memory_experiences WHERE ${rowFilters.join(" AND ")} ORDER BY ${order}, id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params: rowParams.all
  };
}
