/**
 * Playtesting-owned typed ClickHouse repository.
 *
 * Reuses resolveOpenLitClickHouseConnection and Data's existing
 * runParameterizedClickHouseStatement transport. Persists workspace-scoped
 * launch intents, batches, episode summary/version rows, findings, reviews,
 * cross-session syntheses and comparisons
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

import {
  PLAYTESTS_EPISODE_SCHEMA,
  type HumanPlaytestStudy,
  type PlaytestArtifactReference,
  type PlaytestBatch,
  type PlaytestBenchmark,
  type PlaytestComparison,
  type PlaytestCrossSessionSynthesis,
  type PlaytestEpisode,
  type PlaytestDiscoverySessionReview,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  type PlaytestExperiment,
  type PlaytestFinding,
  type PlaytestSessionReview
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
  decodeCrossSessionSynthesis,
  decodeEpisode,
  decodeExperiment,
  decodeFinding,
  decodeHumanStudy,
  decodeHumanSummary,
  decodeReview,
  decodeReviewSummary,
  decodeDiscoveryReview,
  encodeBatch,
  encodeBenchmark,
  encodeComparison,
  encodeCrossSessionSynthesis,
  encodeEpisode,
  encodeExperiment,
  encodeFinding,
  encodeHumanStudy,
  encodeHumanSummary,
  encodeReview,
  encodeDiscoveryReview,
  isRecord,
  migrateLegacyEpisodeForStorage,
  clickHouseDateTimeAsIso,
  toClickHouseDateTime
} from "./row-codec.ts";
import {
  ensurePlaytestSchema,
  PLAYTEST_BATCHES_TABLE,
  PLAYTEST_BENCHMARKS_TABLE,
  PLAYTEST_COMPARISONS_TABLE,
  PLAYTEST_CROSS_SESSION_SYNTHESES_TABLE,
  PLAYTEST_EPISODES_TABLE,
  PLAYTEST_EXPERIMENTS_TABLE,
  PLAYTEST_FINDINGS_TABLE,
  PLAYTEST_HUMAN_STUDIES_TABLE,
  PLAYTEST_HUMAN_SUMMARIES_TABLE,
  PLAYTEST_LAUNCH_INTENTS_TABLE,
  PLAYTEST_REVIEWS_TABLE
} from "./schema.ts";
import type {
  PlaytestBatchArtifactState,
  PlaytestBatchFilter,
  PlaytestBenchmarkFilter,
  PlaytestComparisonFilter,
  PlaytestEpisodeFilter,
  PlaytestExperimentFilter,
  PlaytestFindingFilter,
  PlaytestHumanAggregateRecord,
  PlaytestHumanStudyFilter,
  PlaytestHumanValidationSummary,
  PlaytestLaunchIntent,
  PlaytestPage,
  PlaytestReviewListFilter,
  PlaytestReviewSummary
} from "./types.ts";

/** The most rows one list read will return, whatever the caller asks for. */
const MAX_PLAYTEST_PAGE_SIZE = 500;
const DEFAULT_PLAYTEST_PAGE_SIZE = 50;
const MAX_BATCH_ARTIFACT_HISTORY_ROWS = 128;
const EPISODE_SCHEMA_MIGRATION_BATCH_SIZE = 100;
const CURRENT_EPISODE_SCHEMA_PRIORITY = `(JSONExtractString(payload_json, 'schema') = '${PLAYTESTS_EPISODE_SCHEMA}') DESC`;
const LINE_BREAK_PATTERN = /\r?\n/u;
const COUNT_PATTERN = /^\d+$/u;
const SHA256_HEX_PATTERN = /^[a-f\d]{64}$/iu;
const WORKSPACE_ID_PATTERN = /^[^/\\\s]+\/[^/\\\s]+$/u;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9@._:+-]{1,256}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const BATCH_ID_PATTERN = /^batch-[A-Za-z0-9._:-]{1,128}$/u;
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

function assertPlaytestLaunchIntent(intent: PlaytestLaunchIntent): void {
  if (
    !WORKSPACE_ID_PATTERN.test(intent.workspaceId) ||
    !ACTOR_ID_PATTERN.test(intent.actorId) ||
    !REQUEST_ID_PATTERN.test(intent.requestId) ||
    !SHA256_HEX_PATTERN.test(intent.launchIntentHash) ||
    !BATCH_ID_PATTERN.test(intent.batchId) ||
    !Number.isSafeInteger(intent.assignmentCount) ||
    intent.assignmentCount < 1 ||
    intent.assignmentCount > 1000 ||
    !Number.isFinite(Date.parse(intent.createdAt)) ||
    !Number.isFinite(Date.parse(intent.expiresAt)) ||
    Date.parse(intent.expiresAt) <= Date.parse(intent.createdAt)
  ) {
    throw new TypeError("Playtest launch intent identity is invalid.");
  }
}

function decodeLaunchIntent(
  row: Readonly<Record<string, unknown>>
): PlaytestLaunchIntent {
  const rawCount = row.assignment_count;
  const assignmentCount =
    typeof rawCount === "number"
      ? rawCount
      : typeof rawCount === "string" && COUNT_PATTERN.test(rawCount)
        ? Number(rawCount)
        : Number.NaN;
  const intent: PlaytestLaunchIntent = {
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : "",
    actorId: typeof row.actor_id === "string" ? row.actor_id : "",
    requestId: typeof row.request_id === "string" ? row.request_id : "",
    launchIntentHash:
      typeof row.launch_intent_hash === "string" ? row.launch_intent_hash : "",
    batchId: typeof row.batch_id === "string" ? row.batch_id : "",
    assignmentCount,
    createdAt: clickHouseDateTimeAsIso(row.created_at),
    expiresAt: clickHouseDateTimeAsIso(row.expires_at)
  };
  try {
    assertPlaytestLaunchIntent(intent);
  } catch (error) {
    throw new PlaytestSourceUnavailableError(
      "ClickHouse returned an invalid launch-intent record.",
      error
    );
  }
  return intent;
}

/**
 * Fixed-fragment WHERE clauses for the persisted-review list.
 *
 * Discovery and confirmatory reviews share one table, so the kind filter is
 * a payload-schema predicate. It is applied inside the version fold so that
 * "latest version" is resolved within one kind; the episode filter is
 * applied after the fold, exactly like every other Playtesting list.
 */
interface ReviewWhereClause {
  readonly innerClauses: readonly string[];
  readonly outerClauses: readonly string[];
  readonly params: Record<string, ClickHouseParamValue>;
}

function buildReviewWhereClause(
  filter: PlaytestReviewListFilter
): ReviewWhereClause {
  if (filter.workspaceId.trim().length === 0) {
    throw new TypeError("workspaceId is required for every Playtesting query");
  }
  const params: Record<string, ClickHouseParamValue> = {
    workspaceId: filter.workspaceId
  };
  const innerClauses: string[] = [WORKSPACE_ID_PREDICATE];
  const outerClauses: string[] = [];
  if (filter.episodeId !== undefined) {
    outerClauses.push("episode_id = {episodeId:String}");
    params.episodeId = filter.episodeId;
  }
  if (filter.kind !== undefined) {
    innerClauses.push(
      filter.kind === "discovery"
        ? "JSONExtractString(payload_json, 'schema') = {discoverySchema:String}"
        : "JSONExtractString(payload_json, 'schema') != {discoverySchema:String}"
    );
    params.discoverySchema = PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA;
  }
  return { innerClauses, outerClauses, params };
}

/**
 * Typed ClickHouse repository for Playtesting launch receipts, batches,
 * episodes, findings, reviews and comparisons. One owner of the Playtesting schema and every
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
    await this.migrateLegacyEpisodeSchemas();
  }

  /**
   * Promote historical episode rows before Runtime exposes reads. This appends
   * a verified current-schema revision; serving decoders never infer mode or
   * translate a legacy artifact on demand.
   */
  private async migrateLegacyEpisodeSchemas(): Promise<void> {
    for (;;) {
      const rows = parseNdjsonLines(
        await this.execute(
          `SELECT * FROM (
            SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, ${CURRENT_EPISODE_SCHEMA_PRIORITY}, cityHash64(payload_json) DESC, payload_json DESC) AS rn
            FROM ${PLAYTEST_EPISODES_TABLE}
          ) WHERE rn = 1 AND JSONExtractString(payload_json, 'schema') != {currentSchema:String}
          ORDER BY workspace_id, episode_id
          LIMIT {limit:UInt32} FORMAT JSONEachRow`,
          {
            currentSchema: PLAYTESTS_EPISODE_SCHEMA,
            limit: EPISODE_SCHEMA_MIGRATION_BATCH_SIZE
          }
        )
      );
      if (rows.length === 0) return;
      const migratedRows = rows.map((row) =>
        encodeEpisode(migrateLegacyEpisodeForStorage(row))
      );
      await this.execute(
        `INSERT INTO ${PLAYTEST_EPISODES_TABLE} FORMAT JSONEachRow`,
        {},
        migratedRows.map((row) => JSON.stringify(row)).join("\n") + "\n"
      );
    }
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

  async insertLaunchIntent(intent: PlaytestLaunchIntent): Promise<void> {
    assertPlaytestLaunchIntent(intent);
    const row = {
      workspace_id: intent.workspaceId,
      actor_id: intent.actorId,
      request_id: intent.requestId,
      launch_intent_hash: intent.launchIntentHash,
      batch_id: intent.batchId,
      assignment_count: intent.assignmentCount,
      created_at: toClickHouseDateTime(intent.createdAt),
      expires_at: toClickHouseDateTime(intent.expiresAt)
    };
    await this.execute(
      `INSERT INTO ${PLAYTEST_LAUNCH_INTENTS_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getLaunchIntent(
    workspaceId: string,
    actorId: string,
    requestId: string
  ): Promise<PlaytestLaunchIntent | null> {
    const rows = parseNdjsonLines(
      await this.execute(
        `SELECT * FROM ${PLAYTEST_LAUNCH_INTENTS_TABLE} ` +
          `WHERE workspace_id = {workspaceId:String} ` +
          `AND actor_id = {actorId:String} AND request_id = {requestId:String} ` +
          `ORDER BY created_at ASC LIMIT 3 FORMAT JSONEachRow`,
        { workspaceId, actorId, requestId }
      )
    );
    if (rows.length === 0) return null;
    const intents = rows.map(decodeLaunchIntent);
    if (
      intents.some(
        (intent) =>
          intent.workspaceId !== workspaceId ||
          intent.actorId !== actorId ||
          intent.requestId !== requestId
      )
    ) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse returned a launch-intent row outside its requested identity."
      );
    }
    const first = intents[0]!;
    if (
      intents.some(
        (intent) =>
          intent.launchIntentHash !== first.launchIntentHash ||
          intent.batchId !== first.batchId ||
          intent.assignmentCount !== first.assignmentCount ||
          intent.createdAt !== first.createdAt ||
          intent.expiresAt !== first.expiresAt
      )
    ) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse contains conflicting launch-intent records for one request identity."
      );
    }
    return first;
  }

  /**
   * Read all bounded revisions for one batch so Runtime can safely decide
   * whether a local pending packet reference was ever durably published.
   * Historical references count: an uncertain insert acknowledgement must not
   * make an earlier committed packet look like an orphan.
   */
  async getBatchArtifactState(
    workspaceId: string,
    batchId: string
  ): Promise<PlaytestBatchArtifactState> {
    if (workspaceId.trim().length === 0 || batchId.trim().length === 0) {
      throw new TypeError("workspaceId and batchId are required.");
    }
    const rows = parseNdjsonLines(
      await this.execute(
        `SELECT * FROM ${PLAYTEST_BATCHES_TABLE} ` +
          `WHERE workspace_id = {workspaceId:String} AND batch_id = {batchId:String} ` +
          `ORDER BY revision DESC, cityHash64(payload_json) DESC, payload_json DESC ` +
          `LIMIT {limit:UInt32} FORMAT JSONEachRow`,
        {
          workspaceId,
          batchId,
          limit: MAX_BATCH_ARTIFACT_HISTORY_ROWS + 1
        }
      )
    );
    if (rows.length > MAX_BATCH_ARTIFACT_HISTORY_ROWS) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse batch history exceeds the bounded packet-reconciliation limit."
      );
    }
    const batches = rows.map(decodeBatch);
    if (
      batches.some(
        (batch) =>
          batch.workspaceId !== workspaceId || batch.batchId !== batchId
      )
    ) {
      throw new PlaytestSourceUnavailableError(
        "ClickHouse batch history contains a mismatched workspace or batch identity."
      );
    }
    const packetArtifacts = new Map<string, PlaytestArtifactReference>();
    for (const batch of batches) {
      for (const receipt of batch.reviewPackets) {
        if (receipt.status !== "prepared" || receipt.artifact === null) {
          continue;
        }
        const prior = packetArtifacts.get(receipt.artifact.artifactId);
        if (
          prior &&
          (prior.sha256 !== receipt.artifact.sha256 ||
            prior.bytes !== receipt.artifact.bytes ||
            prior.mediaType !== receipt.artifact.mediaType)
        ) {
          throw new PlaytestSourceUnavailableError(
            "ClickHouse batch history contains conflicting packet artifact identities."
          );
        }
        packetArtifacts.set(receipt.artifact.artifactId, receipt.artifact);
      }
    }
    return {
      latestStatus: batches[0]?.status ?? null,
      packetArtifacts: [...packetArtifacts.values()]
    };
  }

  async listBatches(
    filter: PlaytestBatchFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestBatch>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const filterClause = buildBatchWhereClause(filter);
    const innerWhere = WORKSPACE_ID_PREDICATE;
    const outerWhere = appendCursorClause(
      {
        clauses: ["rn = 1", ...filterClause.clauses.slice(1)],
        params: filterClause.params
      },
      cursor,
      "created_at",
      "batch_id"
    );

    const selectQuery =
      `SELECT workspace_id, batch_id, revision, build_sha, status, created_at, payload_json FROM (` +
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
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, ${CURRENT_EPISODE_SCHEMA_PRIORITY}, cityHash64(payload_json) DESC, payload_json DESC) AS rn
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
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, ${CURRENT_EPISODE_SCHEMA_PRIORITY}, cityHash64(payload_json) DESC, payload_json DESC) AS rn
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

    const outerWhere = appendCursorClause(
      {
        clauses: ["rn = 1", ...restClauses],
        params: filterClause.params
      },
      cursor,
      "assigned_at",
      "episode_id"
    );

    const selectQuery =
      `SELECT workspace_id, batch_id, episode_id, revision, scenario, seed, build_sha, policy, assignment_id, cohort, status, game_outcome, assigned_at, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, ${CURRENT_EPISODE_SCHEMA_PRIORITY}, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_EPISODES_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY assigned_at DESC, episode_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, ${CURRENT_EPISODE_SCHEMA_PRIORITY}, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_EPISODES_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${restClauses.length > 0 ? restClauses.join(" AND ") : "1 = 1"} ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, {
        ...outerWhere.params,
        limit
      }),
      this.execute(countQuery, {
        ...filterClause.params
      })
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
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id ORDER BY revision DESC, ${CURRENT_EPISODE_SCHEMA_PRIORITY}, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_EPISODES_TABLE}
        WHERE workspace_id = {workspaceId:String}
      ) WHERE rn = 1 AND ${where.clauses.slice(1).join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(
      await this.execute(countQuery, {
        ...where.params
      })
    );
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
      !SHA256_HEX_PATTERN.test(fingerprint)
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

  // ---- Reviews ---------------------------------------------------------------

  async insertReview(record: PlaytestSessionReview): Promise<void> {
    const row = encodeReview(record.provenance.workspaceId, record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_REVIEWS_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async insertDiscoveryReview(
    record: PlaytestDiscoverySessionReview
  ): Promise<void> {
    const row = encodeDiscoveryReview(record.workspaceId, record);
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
          AND JSONExtractString(payload_json, 'schema') != {discoverySchema:String}
      ) WHERE rn = 1
      FORMAT JSONEachRow`,
      {
        workspaceId,
        episodeId,
        reviewId,
        discoverySchema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA
      }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeReview(rows[0]!) : null;
  }

  /** Latest immutable confirmatory review for one episode, if one exists. */

  async getLatestReviewForEpisode(
    workspaceId: string,
    episodeId: string
  ): Promise<PlaytestSessionReview | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id, review_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_REVIEWS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND episode_id = {episodeId:String}
          AND JSONExtractString(payload_json, 'schema') != {discoverySchema:String}
      ) WHERE rn = 1 ORDER BY created_at DESC, review_id DESC LIMIT 1
      FORMAT JSONEachRow`,
      {
        workspaceId,
        episodeId,
        discoverySchema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA
      }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeReview(rows[0]!) : null;
  }

  /** Latest immutable discovery review for one episode, if one exists. */
  async getLatestDiscoveryReviewForEpisode(
    workspaceId: string,
    episodeId: string
  ): Promise<PlaytestDiscoverySessionReview | null> {
    const text = await this.execute(
      `SELECT * FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id, review_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_REVIEWS_TABLE}
        WHERE workspace_id = {workspaceId:String} AND episode_id = {episodeId:String}
          AND JSONExtractString(payload_json, 'schema') = {discoverySchema:String}
      ) WHERE rn = 1 ORDER BY created_at DESC, review_id DESC LIMIT 1
      FORMAT JSONEachRow`,
      {
        workspaceId,
        episodeId,
        discoverySchema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA
      }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeDiscoveryReview(rows[0]!) : null;
  }

  /**
   * List the persisted analyst reviews of one workspace, newest first.
   *
   * Every filter is applied at ClickHouse before pagination and the count
   * is the full matching population, not the loaded page. Only the latest
   * version of each review is listed: a review is append-only, and a
   * superseded version is not what the analyst concluded.
   */
  async listReviews(
    filter: PlaytestReviewListFilter,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestReviewSummary>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const where = buildReviewWhereClause(filter);
    const innerWhere = where.innerClauses.join(" AND ");
    const restClauses = where.outerClauses;

    const outerWhere = appendCursorClause(
      {
        clauses: ["rn = 1", ...restClauses],
        params: where.params
      },
      cursor,
      "created_at",
      "review_id"
    );

    const selectQuery =
      `SELECT workspace_id, episode_id, review_id, version, created_at, payload_json FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id, review_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_REVIEWS_TABLE} WHERE ${innerWhere}) ` +
      `WHERE ${joinWhereClauses(outerWhere)} ORDER BY created_at DESC, review_id DESC ` +
      `LIMIT {limit:UInt32} FORMAT JSONEachRow`;

    const countQuery =
      `SELECT count() AS total FROM (` +
      `SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id, review_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn ` +
      `FROM ${PLAYTEST_REVIEWS_TABLE} WHERE ${innerWhere}) WHERE rn = 1 AND ` +
      `${restClauses.length > 0 ? restClauses.join(" AND ") : "1 = 1"} ` +
      `FORMAT JSONEachRow`;

    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...outerWhere.params, limit }),
      this.execute(countQuery, where.params)
    ]);

    const rawRows = parseNdjsonLines(rowsText);
    const rows = rawRows.map(decodeReviewSummary);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: String(rawRows.at(-1)!.created_at),
            tiebreakId: rows.at(-1)!.reviewId
          })
        : null;
    return { rows, total, nextCursor };
  }

  /** The number of persisted reviews matching a filter, before pagination. */
  async countReviews(filter: PlaytestReviewListFilter): Promise<number> {
    const where = buildReviewWhereClause(filter);
    const countQuery = `SELECT count() AS total FROM (
        SELECT *, row_number() OVER (PARTITION BY workspace_id, episode_id, review_id ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC) AS rn
        FROM ${PLAYTEST_REVIEWS_TABLE}
        WHERE ${where.innerClauses.join(" AND ")}
      ) WHERE rn = 1 AND ${where.outerClauses.join(" AND ") || "1 = 1"}
      FORMAT JSONEachRow`;
    return parseTotalCount(await this.execute(countQuery, where.params));
  }

  // ---- Cross-session synthesis --------------------------------------------

  async insertCrossSessionSynthesis(
    record: PlaytestCrossSessionSynthesis
  ): Promise<void> {
    const row = encodeCrossSessionSynthesis(record.workspaceId, record);
    await this.execute(
      `INSERT INTO ${PLAYTEST_CROSS_SESSION_SYNTHESES_TABLE} FORMAT JSONEachRow`,
      {},
      JSON.stringify(row) + "\n"
    );
  }

  async getCrossSessionSynthesisForAnalysis(
    workspaceId: string,
    analysisId: string
  ): Promise<PlaytestCrossSessionSynthesis | null> {
    const text = await this.execute(
      `SELECT * FROM ${PLAYTEST_CROSS_SESSION_SYNTHESES_TABLE} ` +
        `WHERE workspace_id = {workspaceId:String} AND analysis_id = {analysisId:String} ` +
        `ORDER BY version DESC, cityHash64(payload_json) DESC, payload_json DESC ` +
        `LIMIT 1 FORMAT JSONEachRow`,
      { workspaceId, analysisId }
    );
    const rows = parseNdjsonLines(text);
    return rows.length > 0 ? decodeCrossSessionSynthesis(rows[0]!) : null;
  }

  async listCrossSessionSyntheses(
    workspaceId: string,
    listOptions: PlaytestListOptions = {}
  ): Promise<PlaytestPage<PlaytestCrossSessionSynthesis>> {
    const limit = clampLimit(listOptions.limit);
    const cursor = decodePlaytestCursor(listOptions.cursor);
    const where = appendCursorClause(
      { clauses: [WORKSPACE_ID_PREDICATE], params: { workspaceId } },
      cursor,
      "created_at",
      "synthesis_id"
    );
    const selectQuery =
      `SELECT workspace_id, synthesis_id, analysis_id, version, created_at, payload_json ` +
      `FROM ${PLAYTEST_CROSS_SESSION_SYNTHESES_TABLE} WHERE ${joinWhereClauses(where)} ` +
      `ORDER BY created_at DESC, synthesis_id DESC LIMIT {limit:UInt32} FORMAT JSONEachRow`;
    const countQuery =
      `SELECT count() AS total FROM ${PLAYTEST_CROSS_SESSION_SYNTHESES_TABLE} ` +
      `WHERE ${WORKSPACE_ID_PREDICATE} FORMAT JSONEachRow`;
    const [rowsText, countText] = await Promise.all([
      this.execute(selectQuery, { ...where.params, limit }),
      this.execute(countQuery, { workspaceId })
    ]);
    const rawRows = parseNdjsonLines(rowsText);
    const rows = rawRows.map(decodeCrossSessionSynthesis);
    const total = parseTotalCount(countText);
    const nextCursor =
      rows.length === limit && rows.length > 0
        ? encodePlaytestCursor({
            orderedAt: String(rawRows.at(-1)!.created_at),
            tiebreakId: rows.at(-1)!.synthesisId
          })
        : null;
    return { rows, total, nextCursor };
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
