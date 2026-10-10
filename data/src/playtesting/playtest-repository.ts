/**
 * Playtesting-owned typed ClickHouse repository.
 *
 * Reuses resolveOpenLitClickHouseConnection and Data's existing
 * runParameterizedClickHouseStatement transport. Persists workspace-scoped
 * batches, episode summary/version rows, findings, reviews and comparisons
 * per docs/playtesting-target-state.md Section 9. Large JSONL/frames never
 * land here; episode rows retain only bounded content-hash manifests/opaque
 * refs into Runtime-owned artifact storage.
 *
 * Every filtered list applies its filters at ClickHouse before pagination;
 * every count is the full matching population, not the loaded page. Every
 * read throws PlaytestSourceUnavailableError on an unreachable, malformed or
 * non-JSON ClickHouse response rather than returning an empty collection or
 * a zero count.
 */

import type {
  HumanPlaytestStudy,
  PlaytestBatch,
  PlaytestBenchmark,
  PlaytestComparison,
  PlaytestEpisode,
  PlaytestExperiment,
  PlaytestFinding,
  PlaytestSessionReview
} from "@simulatorlife/autodev-core";

import {
  type ClickHouseParamValue,
  runParameterizedClickHouseStatement
} from "../clickhouse/clickhouse-client.ts";
import {
  type OpenLitClickHouseOptions,
  resolveOpenLitClickHouseConnection
} from "../openlit/clickhouse-config.ts";
import { decodePlaytestCursor, encodePlaytestCursor } from "./cursor.ts";
import { PlaytestSourceUnavailableError } from "./errors.ts";
import {
  appendCursorClause,
  type BoundWhereClause,
  buildBatchWhereClause,
  buildBenchmarkWhereClause,
  buildComparisonWhereClause,
  buildEpisodeWhereClause,
  buildExperimentWhereClause,
  buildFindingWhereClause,
  buildHumanStudyWhereClause,
  joinWhereClauses
} from "./query-filters.ts";
import {
  decodeBatch,
  decodeBenchmark,
  decodeComparison,
  decodeEpisode,
  decodeExperiment,
  decodeFinding,
  decodeHumanStudy,
  decodeHumanSummary,
  decodeReview,
  encodeBatch,
  encodeBenchmark,
  encodeComparison,
  encodeEpisode,
  encodeExperiment,
  encodeFinding,
  encodeHumanStudy,
  encodeHumanSummary,
  encodeReview,
  isRecord
} from "./row-codec.ts";
import {
  ensurePlaytestSchema,
  PLAYTEST_BATCHES_TABLE,
  PLAYTEST_BENCHMARKS_TABLE,
  PLAYTEST_COMPARISONS_TABLE,
  PLAYTEST_EPISODES_TABLE,
  PLAYTEST_EXPERIMENTS_TABLE,
  PLAYTEST_FINDINGS_TABLE,
  PLAYTEST_HUMAN_STUDIES_TABLE,
  PLAYTEST_HUMAN_SUMMARIES_TABLE,
  PLAYTEST_REVIEWS_TABLE
} from "./schema.ts";
import type {
  PlaytestBatchFilter,
  PlaytestBenchmarkFilter,
  PlaytestComparisonFilter,
  PlaytestEpisodeFilter,
  PlaytestExperimentFilter,
  PlaytestFindingFilter,
  PlaytestHumanAggregateRecord,
  PlaytestHumanStudyFilter,
  PlaytestHumanValidationSummary,
  PlaytestPage
} from "./types.ts";

/** The most rows one list read will return, whatever the caller asks for. */
const MAX_PLAYTEST_PAGE_SIZE = 500;
const DEFAULT_PLAYTEST_PAGE_SIZE = 50;
const LINE_BREAK_PATTERN = /\r?\n/u;
const COUNT_PATTERN = /^\d+$/u;
const SMALL_CELL_SUPPRESSION_THRESHOLD = 5;
const WORKSPACE_ID_PREDICATE = "workspace_id = {workspaceId:String}";

export interface PlaytestRepositoryOptions extends OpenLitClickHouseOptions {
  readonly fetchImpl?: typeof fetch;
}

export interface PlaytestListOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

function clampLimit(limit: number | undefined): number {
  const requested = limit ?? DEFAULT_PLAYTEST_PAGE_SIZE;
  return Math.max(1, Math.min(requested, MAX_PLAYTEST_PAGE_SIZE));
}

function parseNdjsonLines(text: string): readonly Record<string, unknown>[] {
  const lines = text
    .split(LINE_BREAK_PATTERN)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.map((line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse returned a non-JSON row",
        error
      );
    }
    if (!isRecord(parsed)) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse row did not decode to an object"
      );
    }
    return parsed;
  });
}

function parseTotalCount(text: string): number {
  const row = parseNdjsonLines(text)[0];
  if (row === undefined) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned no population count row"
    );
  }
  const total = row.total;
  if (typeof total !== "string" || !COUNT_PATTERN.test(total)) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned an unparsable population count"
    );
  }
  const numericTotal = Number(total);
  if (!Number.isSafeInteger(numericTotal)) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse population count exceeds the safe integer range"
    );
  }
  return numericTotal;
}

/**
 * Typed ClickHouse repository for Playtesting batches, episodes, findings,
 * reviews and comparisons. One owner of the Playtesting schema and every
 * query/pagination/count path against it.
 */
export class PlaytestRepository {
  private readonly options: OpenLitClickHouseOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlaytestRepositoryOptions = {}) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  /** Idempotently create every Playtesting table. Safe to call repeatedly. */
  async ensureSchema(): Promise<void> {
    const { endpoint } = resolveOpenLitClickHouseConnection(this.options);
    await ensurePlaytestSchema(endpoint, this.fetchImpl);
  }

  private resolveEndpoint(): string {
    return resolveOpenLitClickHouseConnection(this.options).endpoint;
  }

  private async execute(
    query: string,
    params: Readonly<Record<string, ClickHouseParamValue>>,
    body?: string
  ): Promise<string> {
    try {
      return await runParameterizedClickHouseStatement(
        this.resolveEndpoint(),
        query,
        params,
        { fetchImpl: this.fetchImpl, ...(body === undefined ? {} : { body }) }
      );
    } catch (error) {
      if (error instanceof PlaytestSourceUnavailableError) throw error;
      throw new PlaytestSourceUnavailableError(
        "ClickHouse request failed",
        error
      );
    }
  }

  // ---- Batches -----------------------------------------------------------

  async insertBatch(record: PlaytestBatch): Promise<void> {
    const row = encodeBatch(record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_BATCHES_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getBatch(
    workspaceId: string,
    batchId: string
  ): Promise<PlaytestBatch | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, batch_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_BATCHES_TABLE}
        WHERE workspace_id = {workspaceId:String} AND batch_id = {batchId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, batchId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeBatch(rows[0]!) : null;
  }

  async listBatches(
    filter: PlaytestBatchFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestBatch>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const filterClause = buildBatchWhereClause(filter);
    const innerWhere = WORKSPACE_ID_PREDICATE;
    let outerWhere: BoundWhereClause = {
      clauses: ["rn = 1", ...filterClause.clauses.slice(1)],
      params: filterClause.params
    };
    outerWhere = appendCursorClause(
      outerWhere,
      cursor,
      "created_at",
      "batch_id"
    );

    const selectQuery =
      `SELECT workspace_id, batch_id, revision, status, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, batch_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_BATCHES_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY created_at DESC, batch_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (SELECT workspace_id, batch_id FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, batch_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_BATCHES_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${filterClause.clauses.slice(1).length > 0 ? filterClause.clauses.slice(1).join(" AND ") : "1 = 1"}) ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...outerWhere.params, limit }),
      this.execute(countQuery, filterClause.params)
    ]);

    const rows = parseNdjsonLines(rowsText).map(decodeBatch);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: rows.at(-1)!.createdAt,
            tiebreakId: rows.at(-1)!.batchId
          })
        : null;
    return { rows, total, nextCursor };
  }

  async countBatches(filter: PlaytestBatchFilter): Promise<number> {
    const where = buildBatchWhereClause(filter);
    const countQuery = `SELECT count() AS total FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, batch_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_BATCHES_TABLE}
        WHERE workspace_id = {workspaceId:String}
      ) WHERE rn = 1 AND ${where.clauses.slice(1).join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(await this.execute(countQuery, where.params));
  }

  // ---- Episodes ------------------------------------------------------------

  async insertEpisode(record: PlaytestEpisode): Promise<void> {
    const row = encodeEpisode(record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_EPISODES_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  /** Deterministically reads the latest revision of one episode, or null. */
  async getEpisode(
    workspaceId: string,
    episodeId: string
  ): Promise<PlaytestEpisode | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_EPISODES_TABLE}
        WHERE workspace_id = {workspaceId:String} AND episode_id = {episodeId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, episodeId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeEpisode(rows[0]!) : null;
  }

  /** Resolve a bounded set of episode links in indexed, workspace-scoped batches. */
  async getEpisodesByIds(
    workspaceId: string,
    episodeIds: readonly string[]
  ): Promise<readonly PlaytestEpisode[]> {
    if (
      !workspaceId.trim() ||
      episodeIds.length > 200 ||
      episodeIds.some((id) => !id.trim() || id.length > 256)
    ) {
      throw new TypeError(
        "Episode-link lookup must contain at most 200 bounded IDs."
      );
    }
    const ids = [...new Set(episodeIds)];
    if (ids.length === 0) return [];
    const params: Record<string, string> = { workspaceId };
    const placeholders = ids.map((id, index) => {
      const name = "episodeId" + String(index);
      params[name] = id;
      return `{${name}:String}`;
    });
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_EPISODES_TABLE}
        WHERE workspace_id = {workspaceId:String} AND episode_id IN (${placeholders.join(",")})
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      params
    );
    return parseNdjsonLines(text).map(decodeEpisode);
  }

  async listEpisodes(
    filter: PlaytestEpisodeFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestEpisode>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const filterClause = buildEpisodeWhereClause(filter);
    const restClauses = filterClause.clauses.slice(1);
    const innerWhere = WORKSPACE_ID_PREDICATE;

    let outerWhere: BoundWhereClause = {
      clauses: ["rn = 1", ...restClauses],
      params: filterClause.params
    };
    outerWhere = appendCursorClause(
      outerWhere,
      cursor,
      "assigned_at",
      "episode_id"
    );

    const selectQuery =
      `SELECT workspace_id, batch_id, episode_id, revision, status, game_outcome, assigned_at, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_EPISODES_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY assigned_at DESC, episode_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_EPISODES_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${restClauses.length > 0 ? restClauses.join(" AND ") : "1 = 1"} ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...outerWhere.params, limit }),
      this.execute(countQuery, filterClause.params)
    ]);

    const rows = parseNdjsonLines(rowsText).map(decodeEpisode);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: rows.at(-1)!.assignedAt,
            tiebreakId: rows.at(-1)!.episodeId
          })
        : null;
    return { rows, total, nextCursor };
  }

  async countEpisodes(filter: PlaytestEpisodeFilter): Promise<number> {
    const where = buildEpisodeWhereClause(filter);
    const countQuery = `SELECT count() AS total FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_EPISODES_TABLE}
        WHERE workspace_id = {workspaceId:String}
      ) WHERE rn = 1 AND ${where.clauses.slice(1).join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(await this.execute(countQuery, where.params));
  }

  // ---- Findings ------------------------------------------------------------

  async insertFinding(
    workspaceId: string,
    record: PlaytestFinding
  ): Promise<void> {
    const row = encodeFinding(workspaceId, record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_FINDINGS_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getFinding(
    workspaceId: string,
    findingId: string
  ): Promise<PlaytestFinding | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, finding_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_FINDINGS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND finding_id = {findingId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, findingId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeFinding(rows[0]!) : null;
  }

  /**
   * Latest revision of the finding with this fingerprint in the given
   * workspace, or null if none exists. `fingerprint` is a SHA-256
   * hexadecimal digest produced by Runtime over
   * `playtestFindingIdentityHashInput(identity)`. The query always binds
   * `workspaceId` (mandatory scope) and `fingerprint` (validated on
   * encode/decode) through ClickHouse parameters; the SQL text is fixed
   * so a caller cannot smuggle a different column.
   */
  async getLatestFindingByFingerprint(
    workspaceId: string,
    fingerprint: string
  ): Promise<PlaytestFinding | null> {
    if (
      typeof fingerprint !== "string" ||
      !/^[a-f\d]{64}$/iu.test(fingerprint)
    ) {
      throw new TypeError(
        "getLatestFindingByFingerprint requires a SHA-256 fingerprint."
      );
    }
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, fingerprint ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_FINDINGS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND fingerprint = {fingerprint:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, fingerprint: fingerprint.toLowerCase() }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeFinding(rows[0]!) : null;
  }

  async listFindings(
    filter: PlaytestFindingFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestFinding>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const filterClause = buildFindingWhereClause(filter);
    const restClauses = filterClause.clauses.slice(1);
    const innerWhere = WORKSPACE_ID_PREDICATE;

    let outerWhere: BoundWhereClause = {
      clauses: ["rn = 1", ...restClauses],
      params: filterClause.params
    };
    outerWhere = appendCursorClause(
      outerWhere,
      cursor,
      "created_at",
      "finding_id"
    );

    const selectQuery =
      `SELECT workspace_id, finding_id, version, fingerprint, severity, status, verification_stage, evidence_status, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, finding_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_FINDINGS_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY created_at DESC, finding_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, finding_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_FINDINGS_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${restClauses.length > 0 ? restClauses.join(" AND ") : "1 = 1"} ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...outerWhere.params, limit }),
      this.execute(countQuery, filterClause.params)
    ]);

    const rawRows = parseNdjsonLines(rowsText);
    const rows = rawRows.map(decodeFinding);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: String(rawRows.at(-1)!.created_at),
            tiebreakId: rows.at(-1)!.findingId
          })
        : null;
    return { rows, total, nextCursor };
  }

  async countFindings(filter: PlaytestFindingFilter): Promise<number> {
    const where = buildFindingWhereClause(filter);
    const countQuery = `SELECT count() AS total FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, finding_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_FINDINGS_TABLE}
        WHERE workspace_id = {workspaceId:String}
      ) WHERE rn = 1 AND ${where.clauses.slice(1).join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(await this.execute(countQuery, where.params));
  }

  // ---- Reviews (latest read only; no pagination requirement) ---------------

  async insertReview(record: PlaytestSessionReview): Promise<void> {
    const row = encodeReview(record.provenance.workspaceId, record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_REVIEWS_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getLatestReview(
    workspaceId: string,
    episodeId: string,
    reviewId: string
  ): Promise<PlaytestSessionReview | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id, review_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_REVIEWS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND episode_id = {episodeId:String} AND review_id = {reviewId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, episodeId, reviewId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeReview(rows[0]!) : null;
  }

  /** Latest immutable review revision for one episode, if one exists. */
  async getLatestReviewForEpisode(
    workspaceId: string,
    episodeId: string
  ): Promise<PlaytestSessionReview | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id, review_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_REVIEWS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND episode_id = {episodeId:String}
      ) WHERE rn = 1 ORDER BY created_at DESC, review_id DESC LIMIT 1
      FORMAT JSONEachRow`,
      { workspaceId, episodeId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeReview(rows[0]!) : null;
  }

  // ---- Comparisons ---------------------------------------------------------

  async insertComparison(record: PlaytestComparison): Promise<void> {
    const row = encodeComparison(record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_COMPARISONS_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getLatestComparison(
    workspaceId: string,
    comparisonId: string
  ): Promise<PlaytestComparison | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, comparison_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_COMPARISONS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND comparison_id = {comparisonId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, comparisonId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeComparison(rows[0]!) : null;
  }

  async listComparisons(
    filter: PlaytestComparisonFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestComparison>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const filterClause = buildComparisonWhereClause(filter);
    const restClauses = filterClause.clauses.slice(1);
    const innerWhere = WORKSPACE_ID_PREDICATE;

    let outerWhere: BoundWhereClause = {
      clauses: ["rn = 1", ...restClauses],
      params: filterClause.params
    };
    outerWhere = appendCursorClause(
      outerWhere,
      cursor,
      "created_at",
      "comparison_id"
    );

    const selectQuery =
      `SELECT workspace_id, comparison_id, version, benchmark_id, experiment_id, baseline_id, baseline_version, candidate_id, candidate_version, measurement_version, decision, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, comparison_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_COMPARISONS_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY created_at DESC, comparison_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, comparison_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_COMPARISONS_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${restClauses.length > 0 ? restClauses.join(" AND ") : "1 = 1"} ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...outerWhere.params, limit }),
      this.execute(countQuery, filterClause.params)
    ]);

    const rawRows = parseNdjsonLines(rowsText);
    const rows = rawRows.map(decodeComparison);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: String(rawRows.at(-1)!.created_at),
            tiebreakId: rows.at(-1)!.comparisonId
          })
        : null;
    return { rows, total, nextCursor };
  }

  async countComparisons(filter: PlaytestComparisonFilter): Promise<number> {
    const where = buildComparisonWhereClause(filter);
    const countQuery = `SELECT count() AS total FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, comparison_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_COMPARISONS_TABLE}
        WHERE workspace_id = {workspaceId:String}
      ) WHERE rn = 1 AND ${where.clauses.slice(1).join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(await this.execute(countQuery, where.params));
  }

  // ---- Benchmarks ----------------------------------------------------------

  async insertBenchmark(record: PlaytestBenchmark): Promise<void> {
    const row = encodeBenchmark(record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_BENCHMARKS_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getLatestBenchmark(
    workspaceId: string,
    benchmarkId: string
  ): Promise<PlaytestBenchmark | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, benchmark_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_BENCHMARKS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND benchmark_id = {benchmarkId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, benchmarkId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeBenchmark(rows[0]!) : null;
  }

  async listBenchmarks(
    filter: PlaytestBenchmarkFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestBenchmark>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const filterClause = buildBenchmarkWhereClause(filter);
    const restClauses = filterClause.clauses.slice(1);
    const innerWhere = WORKSPACE_ID_PREDICATE;

    let outerWhere: BoundWhereClause = {
      clauses: ["rn = 1", ...restClauses],
      params: filterClause.params
    };
    outerWhere = appendCursorClause(
      outerWhere,
      cursor,
      "created_at",
      "benchmark_id"
    );

    const selectQuery =
      `SELECT workspace_id, benchmark_id, version, reference_build_sha, measurement_version, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, benchmark_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_BENCHMARKS_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY created_at DESC, benchmark_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, benchmark_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_BENCHMARKS_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${restClauses.length > 0 ? restClauses.join(" AND ") : "1 = 1"} ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...outerWhere.params, limit }),
      this.execute(countQuery, filterClause.params)
    ]);

    const rawRows = parseNdjsonLines(rowsText);
    const rows = rawRows.map(decodeBenchmark);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: String(rawRows.at(-1)!.created_at),
            tiebreakId: rows.at(-1)!.benchmarkId
          })
        : null;
    return { rows, total, nextCursor };
  }

  async countBenchmarks(filter: PlaytestBenchmarkFilter): Promise<number> {
    const where = buildBenchmarkWhereClause(filter);
    const countQuery = `SELECT count() AS total FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, benchmark_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_BENCHMARKS_TABLE}
        WHERE workspace_id = {workspaceId:String}
      ) WHERE rn = 1 AND ${where.clauses.slice(1).join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(await this.execute(countQuery, where.params));
  }

  // ---- Experiments ---------------------------------------------------------

  async insertExperiment(record: PlaytestExperiment): Promise<void> {
    const row = encodeExperiment(record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_EXPERIMENTS_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getLatestExperiment(
    workspaceId: string,
    experimentId: string
  ): Promise<PlaytestExperiment | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, experiment_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_EXPERIMENTS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND experiment_id = {experimentId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, experimentId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeExperiment(rows[0]!) : null;
  }

  async listExperiments(
    filter: PlaytestExperimentFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestExperiment>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const filterClause = buildExperimentWhereClause(filter);
    const restClauses = filterClause.clauses.slice(1);
    const innerWhere = WORKSPACE_ID_PREDICATE;

    let outerWhere: BoundWhereClause = {
      clauses: ["rn = 1", ...restClauses],
      params: filterClause.params
    };
    outerWhere = appendCursorClause(
      outerWhere,
      cursor,
      "created_at",
      "experiment_id"
    );

    const selectQuery =
      `SELECT workspace_id, experiment_id, version, benchmark_id, state, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, experiment_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_EXPERIMENTS_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY created_at DESC, experiment_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, experiment_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_EXPERIMENTS_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${restClauses.length > 0 ? restClauses.join(" AND ") : "1 = 1"} ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...outerWhere.params, limit }),
      this.execute(countQuery, filterClause.params)
    ]);

    const rawRows = parseNdjsonLines(rowsText);
    const rows = rawRows.map(decodeExperiment);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: String(rawRows.at(-1)!.created_at),
            tiebreakId: rows.at(-1)!.experimentId
          })
        : null;
    return { rows, total, nextCursor };
  }

  async countExperiments(filter: PlaytestExperimentFilter): Promise<number> {
    const where = buildExperimentWhereClause(filter);
    const countQuery = `SELECT count() AS total FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, experiment_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_EXPERIMENTS_TABLE}
        WHERE workspace_id = {workspaceId:String}
      ) WHERE rn = 1 AND ${where.clauses.slice(1).join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(await this.execute(countQuery, where.params));
  }

  // ---- Human Studies -------------------------------------------------------

  async insertHumanStudy(record: HumanPlaytestStudy): Promise<void> {
    const row = encodeHumanStudy(record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_HUMAN_STUDIES_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getLatestHumanStudy(
    workspaceId: string,
    studyId: string
  ): Promise<HumanPlaytestStudy | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, study_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_HUMAN_STUDIES_TABLE}
        WHERE workspace_id = {workspaceId:String} AND study_id = {studyId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, studyId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeHumanStudy(rows[0]!) : null;
  }

  async getLatestHumanStudyByBenchmark(
    workspaceId: string,
    benchmarkId: string
  ): Promise<HumanPlaytestStudy | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, study_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_HUMAN_STUDIES_TABLE}
        WHERE workspace_id = {workspaceId:String} AND benchmark_id = {benchmarkId:String}
      ) WHERE rn = 1
      ORDER BY created_at DESC, version DESC
      LIMIT 1
      FORMAT JSONEachRow`,
      { workspaceId, benchmarkId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeHumanStudy(rows[0]!) : null;
  }

  async listHumanStudies(
    filter: PlaytestHumanStudyFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<HumanPlaytestStudy>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const filterClause = buildHumanStudyWhereClause(filter);
    const restClauses = filterClause.clauses.slice(1);
    const innerWhere = WORKSPACE_ID_PREDICATE;

    let outerWhere: BoundWhereClause = {
      clauses: ["rn = 1", ...restClauses],
      params: filterClause.params
    };
    outerWhere = appendCursorClause(
      outerWhere,
      cursor,
      "created_at",
      "study_id"
    );

    const selectQuery =
      `SELECT workspace_id, study_id, version, benchmark_id, instrument, approved, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, study_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_HUMAN_STUDIES_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY created_at DESC, study_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, study_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_HUMAN_STUDIES_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${restClauses.length > 0 ? restClauses.join(" AND ") : "1 = 1"} ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...outerWhere.params, limit }),
      this.execute(countQuery, filterClause.params)
    ]);

    const rawRows = parseNdjsonLines(rowsText);
    const rows = rawRows.map(decodeHumanStudy);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: String(rawRows.at(-1)!.created_at),
            tiebreakId: rows.at(-1)!.studyId
          })
        : null;
    return { rows, total, nextCursor };
  }

  async countHumanStudies(filter: PlaytestHumanStudyFilter): Promise<number> {
    const where = buildHumanStudyWhereClause(filter);
    const countQuery = `SELECT count() AS total FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, study_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_HUMAN_STUDIES_TABLE}
        WHERE workspace_id = {workspaceId:String}
      ) WHERE rn = 1 AND ${where.clauses.slice(1).join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(await this.execute(countQuery, where.params));
  }

  // ---- Human Summaries (Aggregated reads with small-cell privacy) -----------

  async insertHumanSummary(
    record: PlaytestHumanAggregateRecord
  ): Promise<void> {
    const row = encodeHumanSummary(record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_HUMAN_SUMMARIES_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  private resolveHumanValidationSummary(
    rawRow: Record<string, unknown> | undefined
  ): PlaytestHumanValidationSummary | null {
    if (rawRow === undefined) return null;
    // Check tombstone flag on index column or decoded payload
    if (Number(rawRow.is_tombstone) === 1) return null;
    const payload = decodeHumanSummary(rawRow);
    if (payload.isTombstone) return null;

    if (payload.retainedParticipants < SMALL_CELL_SUPPRESSION_THRESHOLD) {
      // Small-cell privacy: suppressed state with NO exact counts, means, or distributions
      return {
        workspaceId: payload.workspaceId,
        studyId: payload.studyId,
        revision: payload.revision,
        benchmarkId: payload.benchmarkId ?? null,
        buildSha: payload.buildSha ?? null,
        instrument: payload.instrument,
        measurementVersion: payload.measurementVersion,
        suppressionState: "suppressed",
        suppressionReason: "small-cell-privacy-retained-participants-under-5",
        createdAt: payload.createdAt
      };
    }

    return {
      workspaceId: payload.workspaceId,
      studyId: payload.studyId,
      revision: payload.revision,
      benchmarkId: payload.benchmarkId ?? null,
      buildSha: payload.buildSha ?? null,
      instrument: payload.instrument,
      measurementVersion: payload.measurementVersion,
      suppressionState: "unsuppressed",
      retainedParticipants: payload.retainedParticipants,
      items: payload.items,
      createdAt: payload.createdAt
    };
  }

  async getHumanValidationSummary(
    workspaceId: string,
    studyId: string
  ): Promise<PlaytestHumanValidationSummary | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, study_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_HUMAN_SUMMARIES_TABLE}
        WHERE workspace_id = {workspaceId:String} AND study_id = {studyId:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      { workspaceId, studyId }
    );
    const rows = parseNdjsonLines(text);
    return this.resolveHumanValidationSummary(rows[0]);
  }

  async getHumanValidationSummaryByBenchmark(
    workspaceId: string,
    benchmarkId: string
  ): Promise<PlaytestHumanValidationSummary | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, study_id ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_HUMAN_SUMMARIES_TABLE}
        WHERE workspace_id = {workspaceId:String} AND benchmark_id = {benchmarkId:String}
      ) WHERE rn = 1
      ORDER BY created_at DESC, revision DESC
      LIMIT 1
      FORMAT JSONEachRow`,
      { workspaceId, benchmarkId }
    );
    const rows = parseNdjsonLines(text);
    return this.resolveHumanValidationSummary(rows[0]);
  }

  getLatestHumanSummary(
    workspaceId: string,
    studyId: string
  ): Promise<PlaytestHumanValidationSummary | null> {
    return this.getHumanValidationSummary(workspaceId, studyId);
  }
}
