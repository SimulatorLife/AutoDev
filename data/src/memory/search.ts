import type {
  ExperienceListRequest,
  ExperienceSearchRequest,
  MemoryExecutionMode,
  MemoryExpiredExperienceRequest,
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
const DEFAULT_PATH_WEIGHT = 0.2;
const DEFAULT_TASK_KIND_WEIGHT = 0.1;

/**
 * The `scoped` CTE applies hard scope/status/validity/type filters before the
 * `ranked` CTE computes lexical, optional vector, path-proximity, and optional
 * task-kind scores.
 * The final query discards candidates without any positive retrieval signal
 * before sorting and limiting them, so unrelated zero-score records cannot
 * fill the result page.
 * Relevant file paths are a soft ranking signal: exact file matches and
 * shared path prefixes improve rank, but unrelated historical evidence is
 * not discarded before lexical/semantic ranking.
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
  const embedding = request.queryEmbedding;
  const relevantPaths = request.relevantPaths?.filter((path) => path.trim());
  const taskKind = request.taskKind?.trim();

  const filters = [
    scopeFilter,
    "status = 'active'",
    "validity_state = 'verified'",
    `(validity_valid_from IS NULL OR validity_valid_from <= ${asOfParam}::timestamptz)`,
    `(validity_valid_to IS NULL OR validity_valid_to > ${asOfParam}::timestamptz)`
  ];
  if (request.kinds && request.kinds.length > 0) {
    const kindsParam = params.add(request.kinds);
    filters.push(`kind = ANY(${kindsParam}::text[])`);
  }

  // Without path signals, require a lexical or semantic retrieval signal.
  // Disjunctive lexical terms preserve partial task/claim overlap for JIT
  // reconstruction while rank orders candidates by the quality of the match.
  const lexicalQuery =
    "replace(plainto_tsquery('english', " +
    queryParam +
    ")::text, ' & ', ' | ')::tsquery";
  const lexicalMatch = `claim_search @@ ${lexicalQuery}`;
  if (!relevantPaths?.length) {
    filters.push(
      embedding
        ? `(${lexicalMatch} OR memory_records.embedding IS NOT NULL)`
        : lexicalMatch
    );
  }

  const limitParam = params.add(request.limit ?? DEFAULT_LIMIT);

  let vectorParam: string | undefined;
  if (embedding) {
    vectorParam = params.add(`[${embedding.join(",")}]`);
  }

  const pathWeight = relevantPaths?.length ? DEFAULT_PATH_WEIGHT : 0;
  const taskKindWeight = taskKind ? DEFAULT_TASK_KIND_WEIGHT : 0;
  const relevanceWeight = 1 - pathWeight;
  const lexicalWeight =
    (embedding
      ? (weights.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT)
      : (weights.lexicalWeight ?? 1)) * relevanceWeight;
  const vectorWeight =
    (weights.vectorWeight ?? DEFAULT_VECTOR_WEIGHT) * relevanceWeight;
  let pathScoreExpr = "0::double precision";
  if (relevantPaths?.length) {
    const pathsParam = params.add(relevantPaths);
    pathScoreExpr = `COALESCE((
  SELECT MAX(CASE
    WHEN evidence_ref->>'uri' = requested_path.uri THEN 1.0
    ELSE 0.6 * COALESCE((
      SELECT COUNT(*)::double precision /
        GREATEST(array_length(path_parts.evidence_parts, 1), array_length(path_parts.requested_parts, 1))
      FROM generate_series(
        1,
        LEAST(array_length(path_parts.evidence_parts, 1), array_length(path_parts.requested_parts, 1))
      ) AS shared_path_prefix(segment)
      WHERE path_parts.evidence_parts[shared_path_prefix.segment] = path_parts.requested_parts[shared_path_prefix.segment]
    ), 0)
  END)
  FROM jsonb_array_elements(COALESCE(scoped.provenance->'evidence', '[]'::jsonb)) AS evidence_ref
  CROSS JOIN unnest(${pathsParam}::text[]) AS requested_path(uri)
  CROSS JOIN LATERAL (
    SELECT
      string_to_array(trim(both '/' FROM regexp_replace(evidence_ref->>'uri', '^[^:]+://', '')), '/') AS evidence_parts,
      string_to_array(trim(both '/' FROM regexp_replace(requested_path.uri, '^[^:]+://', '')), '/') AS requested_parts
  ) AS path_parts
  WHERE evidence_ref->>'kind' = 'file'
), 0)::double precision`;
  }
  let taskKindScoreExpr = "0::double precision";
  if (taskKind) {
    // Task-kind metadata is only a tie/relevance bonus after the cited source
    // experience passes the same scope visibility rule as an explicit read.
    const taskKindParam = params.add(taskKind);
    const sourceExperienceScope = buildExperienceScopeFilterSql(
      "source_experience",
      request.context,
      params
    );
    taskKindScoreExpr = `CASE WHEN EXISTS (
  SELECT 1
  FROM jsonb_array_elements_text(COALESCE(scoped.provenance->'experienceIds', '[]'::jsonb)) AS cited_experience(id)
  JOIN memory_experiences AS source_experience ON source_experience.id = cited_experience.id
  WHERE source_experience.task_kind = ${taskKindParam}
    AND ${sourceExperienceScope}
) THEN 1.0 ELSE 0 END`;
  }
  const lexicalScore = `ts_rank(scoped.claim_search, ${lexicalQuery}) * ${lexicalWeight}`;
  const vectorScore = embedding
    ? `(CASE WHEN scoped.embedding IS NOT NULL THEN (1 - (scoped.embedding <=> ${vectorParam}::vector)) * ${vectorWeight} ELSE 0 END)`
    : "0::double precision";
  const relevantSignals = ["lexical_score > 0"];
  if (relevantPaths?.length) relevantSignals.push("path_score > 0");
  if (embedding) relevantSignals.push("embedding IS NOT NULL");

  const text = `
WITH scoped AS (
  SELECT id, kind, scope_kind, scope_workspace_id, scope_repository_id, scope_role,
         scope_task_id, scope_run_id, scope_agent_id, claim, claim_search, status,
         provenance, validity_state, validity_valid_from, validity_valid_to,
         validity_detail, supersedes, superseded_by, embedding, created_at, updated_at
  FROM memory_records
  WHERE ${filters.join(" AND ")}
), ranked AS (
  SELECT scoped.*, ${pathScoreExpr} AS path_score,
         ${taskKindScoreExpr} AS task_kind_score,
         ${lexicalScore} AS lexical_score, ${vectorScore} AS vector_score
  FROM scoped
)
SELECT *, (lexical_score + vector_score + (path_score * ${pathWeight}) + (task_kind_score * ${taskKindWeight})) AS score
FROM ranked
WHERE ${relevantSignals.join(" OR ")}
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

function experienceModeFilter(
  modes: readonly MemoryExecutionMode[],
  params: SqlParams
): string {
  const explicitModes = modes.filter((mode) => mode !== "unknown");
  if (explicitModes.length === 0) {
    return "(memory_mode IS NULL OR memory_mode = 'unknown')";
  }
  const modeParameter = params.add(explicitModes);
  const explicitMatch = `memory_mode = ANY(${modeParameter}::text[])`;
  return modes.includes("unknown")
    ? `(${explicitMatch} OR memory_mode IS NULL OR memory_mode = 'unknown')`
    : explicitMatch;
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
  if (request.memoryModes && request.memoryModes.length > 0) {
    countFilters.push(experienceModeFilter(request.memoryModes, countParams));
  }
  if (request.outcomes && request.outcomes.length > 0) {
    const outcomesParam = countParams.add(request.outcomes);
    countFilters.push(`outcome = ANY(${outcomesParam}::text[])`);
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
  if (request.memoryModes && request.memoryModes.length > 0) {
    rowFilters.push(experienceModeFilter(request.memoryModes, rowParams));
  }
  if (request.outcomes && request.outcomes.length > 0) {
    const outcomesParam = rowParams.add(request.outcomes);
    rowFilters.push(`outcome = ANY(${outcomesParam}::text[])`);
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

export function buildExpiredExperienceQuery(
  request: MemoryExpiredExperienceRequest
): BuiltQuery {
  const params = new SqlParams();
  const scope = buildExperienceScopeFilterSql(
    "memory_experiences",
    request.context,
    params
  );
  const cutoff = params.add(request.completedBefore);
  const limit = params.add(request.limit);
  return {
    text: `SELECT memory_experiences.* FROM memory_experiences WHERE ${scope} AND memory_experiences.completed_at IS NOT NULL AND memory_experiences.completed_at < ${cutoff} AND NOT EXISTS (SELECT 1 FROM memory_records WHERE memory_records.provenance->'experienceIds' @> jsonb_build_array(memory_experiences.id)) ORDER BY memory_experiences.completed_at ASC, memory_experiences.id ASC LIMIT ${limit}`,
    params: params.all
  };
}
