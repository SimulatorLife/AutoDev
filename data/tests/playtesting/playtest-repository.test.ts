import assert from "node:assert/strict";
import test from "node:test";

import {
  type HumanPlaytestStudy,
  type PlaytestBatch,
  type PlaytestBenchmark,
  type PlaytestComparison,
  type PlaytestEpisode,
  type PlaytestExperiment,
  type PlaytestFinding,
  PLAYTESTS_BATCH_SCHEMA,
  PLAYTESTS_COMPARISON_SCHEMA,
  PLAYTESTS_EPISODE_SCHEMA,
  PLAYTESTS_EXPERIMENT_SCHEMA,
  PLAYTESTS_HUMAN_STUDY_SCHEMA,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  type PlaytestSessionReview
} from "@simulatorlife/autodev-core";

import {
  type PlaytestHumanAggregateRecord,
  PlaytestInvalidCursorError,
  PlaytestRepository,
  PlaytestSourceUnavailableError
} from "../../src/playtesting/index.ts";
import {
  encodeBenchmark,
  encodeComparison,
  encodeEpisode,
  encodeExperiment,
  encodeHumanStudy,
  encodeHumanSummary
} from "../../src/playtesting/row-codec.ts";

function counts() {
  return {
    assigned: 1,
    started: 1,
    completed: 1,
    crashed: 0,
    infrastructureFailed: 0,
    cancelled: 0,
    budgetTruncated: 0,
    reviewed: 0,
    eligible: 1
  } as const;
}

function episode(index: number, workspaceId = "workspace-a"): PlaytestEpisode {
  const timestamp = new Date(
    Date.UTC(2026, 9, 1, 0, 0, index % 60)
  ).toISOString();
  return {
    schema: PLAYTESTS_EPISODE_SCHEMA,
    episodeId: `episode-${String(index).padStart(5, "0")}`,
    revision: 1,
    batchId: `batch-${Math.floor(index / 20)}`,
    identity: {
      workspaceId,
      repository: "synthetic/game",
      buildSha: index % 2 ? "build-a" : "build-b",
      gameBuild: "game-v1",
      scenarioId: index % 2 ? "tutorial" : "arena",
      configHash: "config-hash",
      seed: String(index),
      rngAlgorithm: "pcg32",
      rngVersion: "1",
      policyId: index % 3 ? "heuristic" : "expert",
      policyVersion: "1",
      modelId: null,
      modelRevision: null,
      observationSchemaHash: "obs-v1",
      actionSchemaHash: "act-v1",
      eventSchemaHash: "event-v1",
      protocolVersion: 1,
      runtimeVersion: "runtime-v1",
      environmentHash: "env-v1"
    },
    scenarioFamily: "synthetic",
    policyCohort: index % 4 ? "novice" : "expert",
    strategy: "baseline",
    status: index % 5 ? "completed" : "crashed",
    outcome: index % 5 ? "win" : "dnf",
    outcomeMetrics: { score: index },
    completionCounts: counts(),
    replayStatus: "trace-replayable",
    trace: { kind: "episode", id: `sha256:${String(index).padStart(64, "0")}` },
    frames: [],
    stepCount: 0,
    metrics: [],
    findingIds: [],
    assignedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    simulationWallMs: 10,
    logicalTicks: 12,
    policyInferenceMs: 1,
    nativeDurationMs: null,
    completeness: "complete",
    missingReasons: []
  };
}

function batch(): PlaytestBatch {
  return {
    schema: PLAYTESTS_BATCH_SCHEMA,
    batchId: "batch-0",
    revision: 1,
    workspaceId: "workspace-a",
    repository: "synthetic/game",
    buildSha: "build-a",
    gameBuild: "game-v1",
    configHash: "config-hash",
    rubricHash: "rubric-v1",
    actionSchemaHash: "act-v1",
    observationSchemaHash: "obs-v1",
    eventSchemaHash: "events-v1",
    measurementVersion: "measurement-v1",
    protocolVersion: 1,
    policyIds: ["heuristic"],
    cohortIds: ["novice"],
    scenarioIds: ["tutorial"],
    samplingPlan: null,
    status: "completed",
    counts: counts(),
    budget: {
      assignedEpisodes: 1,
      maxStepsPerEpisode: 50,
      wallTimeMs: 1000,
      critiqueBudget: 1,
      actualCritiques: 0
    },
    startedAt: "2026-10-01T00:00:00.000Z",
    completedAt: "2026-10-01T00:00:01.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    provenance: {
      workspaceId: "workspace-a",
      buildSha: "build-a",
      measurementVersion: "measurement-v1",
      generatedAt: "2026-10-01T00:00:00.000Z"
    },
    evaluationIds: [],
    spanIds: []
  };
}

function finding(): PlaytestFinding {
  return {
    findingId: "finding-1",
    version: 2,
    title: "Verified synthetic finding",
    description: "The content remains in the full canonical artifact payload.",
    severity: "major",
    status: "open",
    verificationStage: "fixed-on-reproduced-case",
    evidenceStatus: "verified",
    affectedEpisodes: 2,
    totalEligibleEpisodes: 10,
    affectedOpportunities: 2,
    totalEligibleOpportunities: 8,
    affectedCohorts: ["novice"],
    evidenceRefs: [{ kind: "episode", id: "episode-1", step: 2 }],
    experimentIds: [],
    issueRefs: [],
    lastVerifiedBuild: "build-a",
    nextReviewAt: null
  };
}

function review(): PlaytestSessionReview {
  return {
    schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
    reviewId: "review-1",
    version: 1,
    episodeId: "episode-00001",
    supersedes: null,
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    rubricHash: "rubric-v1",
    measurementVersion: "measurement-v1",
    provenance: {
      workspaceId: "workspace-a",
      buildSha: "build-a",
      measurementVersion: "measurement-v1",
      generatedAt: "2026-10-01T00:00:00.000Z"
    },
    chronologicalSummary: "Synthetic summary",
    authoritativeMetrics: [],
    observations: ["Synthetic observation"],
    interpretations: ["Synthetic interpretation"],
    anchors: [],
    alternativeExplanations: [],
    experiments: [],
    status: "hypothesis",
    findings: [],
    evidenceRefs: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    notes: "Synthetic note"
  };
}

function comparison(
  index = 1,
  workspaceId = "workspace-a"
): PlaytestComparison {
  return {
    schema: PLAYTESTS_COMPARISON_SCHEMA,
    comparisonId: `comparison-${String(index).padStart(5, "0")}`,
    version: 1,
    benchmarkId: `benchmark-${index % 2 === 0 ? 2 : 1}`,
    experimentId: index % 3 === 0 ? `experiment-${index}` : null,
    baseline: { id: "baseline", version: "1" },
    candidate: { id: "candidate", version: "2" },
    freezeStatus: "frozen",
    pairing: {
      mode: "observational",
      pairMap: {},
      rngAlgorithm: null,
      rngStreamVersion: null,
      couplingDiagnostics: [],
      exclusions: []
    },
    sourceFindingIds: [],
    episodeRefs: [],
    measurementVersion: "measurement-v1",
    metrics: [],
    decision:
      index % 2 === 0 ? "eligible-for-owner-promotion" : "hold-inconclusive",
    ownerDecisionAt: null,
    ownerDecisionReason: null,
    humanPreference: { answer: "not-collected", interval: null },
    provenance: {
      workspaceId,
      buildSha: "build-a",
      measurementVersion: "measurement-v1",
      generatedAt: new Date(
        Date.UTC(2026, 9, 1, 0, 0, index % 60)
      ).toISOString()
    },
    notes: "Synthetic comparison note"
  };
}

function benchmark(index = 1, workspaceId = "workspace-a"): PlaytestBenchmark {
  return {
    benchmarkId: `benchmark-${String(index).padStart(5, "0")}`,
    version: 1,
    workspaceId,
    referenceBuildSha: index % 2 === 0 ? "build-a" : "build-b",
    scenarioInventory: [{ scenarioId: "tutorial", family: "intro", weight: 1 }],
    seedInventory: [{ seed: "1", purpose: "discovery" }],
    policyVersions: { heuristic: "1" },
    competenceReportRefs: [],
    memoryResetRules: "episode",
    engineEnvironmentHash: "environment-v1",
    actionSchemaHash: "actions-v1",
    observationSchemaHash: "observations-v1",
    eventSchemaHash: "events-v1",
    metricRegistryHash: "metrics-v1",
    rubricHash: "rubric-v1",
    captureMode: "headless",
    measurementVersion: index % 3 === 0 ? "measurement-v2" : "measurement-v1",
    primaryMetricIds: ["completion"],
    guardrailMetricIds: [],
    practicalMargins: {},
    independentUnit: "episode",
    precisionPlanRef: "precision-plan-v1",
    missingnessBound: 0.1,
    refreshPolicy: "manual",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index % 60)).toISOString(),
    createdBy: "operator",
    contentHash: "benchmark-hash"
  };
}

function experiment(
  index = 1,
  workspaceId = "workspace-a"
): PlaytestExperiment {
  return {
    schema: PLAYTESTS_EXPERIMENT_SCHEMA,
    experimentId: `experiment-${String(index).padStart(5, "0")}`,
    version: 1,
    workspaceId,
    findingIds: ["finding-1"],
    hypothesis: "Synthetic hypothesis",
    falsifier: "Synthetic falsifier",
    alternativeExplanations: [],
    benchmarkId: `benchmark-${index % 2 === 0 ? 2 : 1}`,
    baseline: { id: "baseline", version: "1" },
    treatment: { id: "treatment", version: "2" },
    approvalId: null,
    exposureUnit: "episode",
    allocationSeed: "seed-1",
    allocationMethod: "randomized",
    cohort: "novice",
    memoryInitialization: "fresh",
    pairMap: {},
    assignmentMap: {},
    discoveryInventory: [],
    confirmationInventory: [],
    primaryMetricId: "completion",
    guardrailMetricIds: [],
    analysisPlan: "descriptive",
    missingnessPlan: "report",
    multiplicityPlan: "none",
    budget: { maxAssignments: 10, maxCritiques: 1, maxWallTimeMs: 1000 },
    stoppingRule: "fixed-budget",
    state: index % 2 === 0 ? "approved" : "draft",
    attemptIds: [],
    comparisonId: null,
    ownerDecision: null,
    rollbackRefs: [],
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index % 60)).toISOString(),
    contentHash: "experiment-hash"
  };
}

function humanStudy(
  index = 1,
  workspaceId = "workspace-a"
): HumanPlaytestStudy {
  return {
    schema: PLAYTESTS_HUMAN_STUDY_SCHEMA,
    studyId: `study-${String(index).padStart(5, "0")}`,
    version: 1,
    workspaceId,
    benchmarkId: `benchmark-${index % 2 === 0 ? 2 : 1}`,
    allowedBuilds: [{ id: "a".repeat(40), version: 1 }],
    pxiItemConstructMappingHash: null,
    instrument: "miniPXI",
    instrumentVersion: "1.0",
    instrumentHash: "hash-instrument",
    consentVersion: "consent-v1",
    consentScope: "full",
    approved: index % 2 === 1,
    approvedBy: "operator",
    responseWindowMs: 60_000,
    minimumExposureMs: 5000,
    orderDesign: "AB/BA",
    independentUnit: "participant",
    missingItemPolicy: "item-wise",
    invitedCount: 10,
    eligibleCount: 8,
    respondedCount: 6,
    withdrawnCount: 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index % 60)).toISOString()
  };
}

function humanSummary(
  studyId = "study-1",
  retainedParticipants = 5,
  revision = 1,
  isTombstone = false,
  workspaceId = "workspace-a",
  benchmarkId = "benchmark-1"
): PlaytestHumanAggregateRecord {
  return {
    workspaceId,
    studyId,
    revision,
    benchmarkId,
    buildSha: "build-a",
    instrument: "miniPXI",
    measurementVersion: "measurement-v1",
    retainedParticipants,
    isTombstone,
    items: [
      {
        itemId: "ENJ",
        mean: 2.5,
        respondentCount: retainedParticipants,
        missingCount: 0,
        categoryCounts: {
          "-3": 0,
          "-2": 0,
          "-1": 0,
          "0": 0,
          "1": 1,
          "2": 2,
          "3": 2
        },
        unit: "native-Likert-minus3-plus3",
        missingReasons: []
      }
    ],
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, revision % 60)).toISOString()
  };
}

const SYNTHETIC_ID_COLUMNS = {
  batchId: "batch_id",
  episodeId: "episode_id",
  findingId: "finding_id",
  reviewId: "review_id",
  comparisonId: "comparison_id",
  benchmarkId: "benchmark_id",
  experimentId: "experiment_id",
  studyId: "study_id"
} as const;
const SYNTHETIC_FILTER_COLUMNS: readonly (readonly [string, string])[] = [
  ["buildSha", "build_sha"],
  ["scenario", "scenario"],
  ["policy", "policy"],
  ["cohort", "cohort"],
  ["status", "status"],
  ["gameOutcome", "game_outcome"],
  ["severity", "severity"],
  ["verificationStage", "verification_stage"],
  ["evidenceStatus", "evidence_status"],
  ["decision", "decision"],
  ["referenceBuildSha", "reference_build_sha"],
  ["measurementVersion", "measurement_version"],
  ["state", "state"],
  ["instrument", "instrument"],
  ["approved", "approved"]
];
const SYNTHETIC_COLLATOR = new Intl.Collator("en");

function tableKeyColumn(table: string): string {
  switch (table) {
    case "playtest_batches": {
      return "batch_id";
    }
    case "playtest_episodes": {
      return "episode_id";
    }
    case "playtest_findings": {
      return "finding_id";
    }
    case "playtest_reviews": {
      return "review_id";
    }
    case "playtest_benchmarks": {
      return "benchmark_id";
    }
    case "playtest_experiments": {
      return "experiment_id";
    }
    case "playtest_human_studies":
    case "playtest_human_summaries": {
      return "study_id";
    }
    default: {
      return "comparison_id";
    }
  }
}

function filterSyntheticRows(
  url: URL,
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const workspace = url.searchParams.get("param_workspaceId");
  let filtered =
    workspace === null
      ? rows
      : rows.filter((row) => row.workspace_id === workspace);
  for (const key of Object.keys(
    SYNTHETIC_ID_COLUMNS
  ) as (keyof typeof SYNTHETIC_ID_COLUMNS)[]) {
    const value = url.searchParams.get(`param_${key}`);
    if (value !== null) {
      const column = SYNTHETIC_ID_COLUMNS[key];
      filtered = filtered.filter((row) => row[column] === value);
    }
  }
  const episodeIdParameters = [...url.searchParams.entries()]
    .filter(([key]) => /^param_episodeId\d+$/u.test(key))
    .map(([, value]) => value);
  if (episodeIdParameters.length > 0) {
    const selected = new Set(episodeIdParameters);
    filtered = filtered.filter((row) => selected.has(String(row.episode_id)));
  }
  for (const [param, column] of SYNTHETIC_FILTER_COLUMNS) {
    const value = url.searchParams.get(`param_${param}`);
    if (value !== null) {
      filtered = filtered.filter(
        (row) => String(row[column]) === String(value)
      );
    }
  }
  return filtered;
}

function latestSyntheticRows(
  table: string,
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const keyColumn = tableKeyColumn(table);
  const versionColumn =
    table === "playtest_batches" ||
    table === "playtest_episodes" ||
    table === "playtest_human_summaries"
      ? "revision"
      : "version";
  const latest = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = String(row[keyColumn]);
    const current = latest.get(key);
    if (
      !current ||
      Number(row[versionColumn]) > Number(current[versionColumn])
    ) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

function cursorSyntheticRows(
  url: URL,
  table: string,
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const cursorAt = url.searchParams.get("param_cursorOrderedAt");
  const cursorId = url.searchParams.get("param_cursorTiebreakId");
  if (!cursorAt || !cursorId) return rows;
  const cursorDateTime = cursorAt.replace("T", " ").replace("Z", "");
  const timeColumn =
    table === "playtest_episodes" ? "assigned_at" : "created_at";
  const keyColumn = tableKeyColumn(table);
  return rows.filter(
    (row) =>
      String(row[timeColumn]) < cursorDateTime ||
      (String(row[timeColumn]) === cursorDateTime &&
        String(row[keyColumn]) < cursorId)
  );
}

function makeClickHouseFetch() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const calls: URL[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    const query = url.searchParams.get("query") ?? "";
    const tableMatch = query.match(/(?:INTO|FROM) (playtest_[a-z_]+)/u);
    const table = tableMatch?.[1] ?? "";
    if (query.startsWith("INSERT INTO ")) {
      const current = tables.get(table) ?? [];
      for (const line of String(init?.body ?? "")
        .split("\n")
        .filter(Boolean)) {
        current.push(JSON.parse(line) as Record<string, unknown>);
      }
      tables.set(table, current);
      return new Response("", { status: 200 });
    }
    if (query.includes("CREATE TABLE IF NOT EXISTS"))
      return new Response("", { status: 200 });

    const rows = latestSyntheticRows(
      table,
      filterSyntheticRows(url, [...(tables.get(table) ?? [])])
    );

    const count = query.includes("count() AS total");
    if (count)
      return Response.json(
        { total: String(rows.length) },
        {
          status: 200
        }
      );

    const keyColumn = tableKeyColumn(table);
    const cursorRows = cursorSyntheticRows(url, table, rows);
    const timeColumn =
      table === "playtest_episodes" ? "assigned_at" : "created_at";
    cursorRows.sort(
      (a, b) =>
        SYNTHETIC_COLLATOR.compare(
          String(b[timeColumn]),
          String(a[timeColumn])
        ) ||
        SYNTHETIC_COLLATOR.compare(String(b[keyColumn]), String(a[keyColumn]))
    );
    const limit = Number(url.searchParams.get("param_limit") ?? "500");
    return new Response(
      cursorRows
        .slice(0, limit)
        .map((row) => JSON.stringify(row))
        .join("\n"),
      { status: 200 }
    );
  };
  return { fetchImpl, calls, tables };
}

test("Core artifact round-trips preserve full canonical payloads and latest revisions", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  const batchArtifact = batch();
  const firstEpisode = episode(1);
  const latestEpisode = {
    ...firstEpisode,
    revision: 2,
    outcomeMetrics: { score: 42 }
  };
  const findingArtifact = finding();
  const reviewArtifact = review();
  const comparisonArtifact = comparison();
  const benchmarkArtifact = benchmark();
  const experimentArtifact = experiment();

  const humanStudyArtifact = humanStudy();
  const humanSummaryArtifact = humanSummary("study-00001", 6);

  await repo.insertBatch(batchArtifact);
  await repo.insertEpisode(firstEpisode);
  await repo.insertEpisode(latestEpisode);
  await repo.insertEpisode(latestEpisode);
  await repo.insertFinding("workspace-a", findingArtifact);
  await repo.insertReview(reviewArtifact);
  await repo.insertComparison(comparisonArtifact);
  await repo.insertBenchmark(benchmarkArtifact);
  await repo.insertExperiment(experimentArtifact);
  await repo.insertHumanStudy(humanStudyArtifact);
  await repo.insertHumanSummary(humanSummaryArtifact);

  assert.deepEqual(
    await repo.getBatch("workspace-a", batchArtifact.batchId),
    batchArtifact
  );
  assert.deepEqual(
    await repo.getEpisode("workspace-a", firstEpisode.episodeId),
    latestEpisode
  );
  assert.deepEqual(
    await repo.getFinding("workspace-a", findingArtifact.findingId),
    findingArtifact
  );
  assert.deepEqual(
    await repo.getLatestReview(
      "workspace-a",
      reviewArtifact.episodeId,
      reviewArtifact.reviewId
    ),
    reviewArtifact
  );
  assert.deepEqual(
    await repo.getLatestReviewForEpisode(
      "workspace-a",
      reviewArtifact.episodeId
    ),
    reviewArtifact
  );
  assert.deepEqual(
    await repo.getLatestComparison(
      "workspace-a",
      comparisonArtifact.comparisonId
    ),
    comparisonArtifact
  );
  assert.deepEqual(
    await repo.getLatestBenchmark("workspace-a", benchmarkArtifact.benchmarkId),
    benchmarkArtifact
  );
  assert.deepEqual(
    await repo.getLatestExperiment(
      "workspace-a",
      experimentArtifact.experimentId
    ),
    experimentArtifact
  );
  assert.deepEqual(
    await repo.getLatestHumanStudy("workspace-a", humanStudyArtifact.studyId),
    humanStudyArtifact
  );
  const summaryRes = await repo.getHumanValidationSummary(
    "workspace-a",
    humanSummaryArtifact.studyId
  );
  assert.equal(summaryRes?.suppressionState, "unsuppressed");
  assert.equal(summaryRes?.retainedParticipants, 6);
  assert.ok(
    fake.calls.some((url) =>
      url.searchParams.get("query")?.includes("cityHash64(payload_json)")
    )
  );

  const insertedEpisodeRows = fake.tables.get("playtest_episodes") ?? [];
  assert.equal(insertedEpisodeRows.length, 3);
  assert.equal(
    JSON.parse(String(insertedEpisodeRows[1]?.payload_json)).revision,
    2
  );
  assert.equal(
    insertedEpisodeRows[1]?.trace_hash_manifest,
    latestEpisode.trace?.id
  );
});

test("human import resolves bounded episode links with parameterized workspace-scoped batches", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  const first = episode(101, "workspace-a");
  const latest = { ...first, revision: 2, outcome: "loss" as const };
  const other = episode(102, "workspace-b");
  await repo.insertEpisode(first);
  await repo.insertEpisode(latest);
  await repo.insertEpisode(other);

  const rows = await repo.getEpisodesByIds("workspace-a", [
    first.episodeId,
    other.episodeId,
    "missing-episode"
  ]);
  assert.deepEqual(
    rows.map((item) => item.episodeId),
    [first.episodeId]
  );
  assert.equal(rows[0]!.revision, 2);
  const query = fake.calls.at(-1)!;
  const sql = query.searchParams.get("query") ?? "";
  assert.match(sql, /episode_id IN \(/u);
  assert.doesNotMatch(sql, new RegExp(first.episodeId, "u"));
  assert.equal(query.searchParams.get("param_workspaceId"), "workspace-a");
  assert.equal(query.searchParams.get("param_episodeId0"), first.episodeId);
  assert.equal(query.searchParams.get("param_episodeId1"), other.episodeId);

  await assert.rejects(
    repo.getEpisodesByIds(
      "workspace-a",
      Array.from({ length: 201 }, (_, i) => String(i))
    ),
    /at most 200 bounded IDs/u
  );
});

test("filtered episode counts reflect the full 10k population and SQL binds values before pagination", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({
    clickhouseUrl: "http://clickhouse.test:8123",
    dbName: "test",
    fetchImpl: fake.fetchImpl
  });
  for (let index = 0; index < 10_000; index += 1) {
    const item = episode(index, index % 5 ? "workspace-a" : "workspace-b");
    const encoded = encodeEpisode(item);
    const rows = fake.tables.get("playtest_episodes") ?? [];
    rows.push(encoded as unknown as Record<string, unknown>);
    fake.tables.set("playtest_episodes", rows);
  }
  const page = await repo.listEpisodes(
    {
      workspaceId: "workspace-a",
      buildSha: "build-a",
      cohort: "novice",
      status: "completed",
      gameOutcome: "win"
    },
    { limit: 7 }
  );
  const expected = (fake.tables.get("playtest_episodes") ?? []).filter(
    (row) =>
      row.workspace_id === "workspace-a" &&
      row.build_sha === "build-a" &&
      row.cohort === "novice" &&
      row.status === "completed" &&
      row.game_outcome === "win"
  ).length;
  assert.equal(page.total, expected);
  assert.equal(
    await repo.countEpisodes({
      workspaceId: "workspace-a",
      buildSha: "build-a",
      cohort: "novice",
      status: "completed",
      gameOutcome: "win"
    }),
    expected
  );
  assert.equal(page.rows.length, 7);
  assert.ok(page.nextCursor);
  const select = fake.calls.find((url) =>
    url.searchParams.get("query")?.includes("ORDER BY assigned_at DESC")
  )!;
  const sql = select.searchParams.get("query")!;
  assert.match(sql, /cohort = \{cohort:String\}/u);
  assert.match(sql, /game_outcome = \{gameOutcome:String\}/u);
  assert.ok(sql.indexOf("cohort =") < sql.indexOf("LIMIT"));
  assert.equal(select.searchParams.get("param_workspaceId"), "workspace-a");
  assert.equal(select.searchParams.get("param_buildSha"), "build-a");
});

test("workspace scope and keyset cursors do not expose another workspace or repeat rows", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  for (let index = 0; index < 30; index += 1) {
    const item = episode(index, index < 20 ? "workspace-a" : "workspace-b");
    const rows = fake.tables.get("playtest_episodes") ?? [];
    rows.push(encodeEpisode(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_episodes", rows);
  }
  const first = await repo.listEpisodes(
    { workspaceId: "workspace-a" },
    { limit: 8 }
  );
  const second = await repo.listEpisodes(
    { workspaceId: "workspace-a" },
    { limit: 8, ...(first.nextCursor ? { cursor: first.nextCursor } : {}) }
  );
  assert.equal(first.total, 20);
  assert.ok(
    second.rows.every((item) => item.identity.workspaceId === "workspace-a")
  );
  assert.equal(
    new Set([...first.rows, ...second.rows].map((item) => item.episodeId)).size,
    16
  );
  await assert.rejects(
    repo.listEpisodes(
      { workspaceId: "workspace-a" },
      { cursor: "not-a-cursor" }
    ),
    PlaytestInvalidCursorError
  );
});

test("SQL-like workspace and filter values remain bound parameters", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  await repo.countEpisodes({
    workspaceId: "ws'; DROP TABLE playtest_episodes; --",
    scenario: "x' OR 1=1 --"
  });
  const query = fake.calls[0]!.searchParams.get("query")!;
  assert.doesNotMatch(query, /DROP TABLE|x' OR 1=1/u);
  assert.equal(
    fake.calls[0]!.searchParams.get("param_workspaceId"),
    "ws'; DROP TABLE playtest_episodes; --"
  );
  assert.equal(
    fake.calls[0]!.searchParams.get("param_scenario"),
    "x' OR 1=1 --"
  );
});

test("missing artifacts are distinct from malformed, unavailable, and failed ClickHouse sources", async () => {
  const missing = new PlaytestRepository({
    fetchImpl: async () => new Response("", { status: 200 })
  });
  assert.equal(await missing.getEpisode("workspace-a", "missing"), null);
  for (const fetchImpl of [
    (async () => new Response("not json", { status: 200 })) as typeof fetch,
    (async () =>
      Response.json(
        { total: "many" },
        {
          status: 200
        }
      )) as typeof fetch,
    (async () => new Response("denied", { status: 503 })) as typeof fetch,
    (async () => {
      throw new Error("offline");
    }) as typeof fetch
  ]) {
    const repo = new PlaytestRepository({ fetchImpl });
    await assert.rejects(
      repo.listEpisodes({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
  }
});

test("idempotent schema stores complete canonical payloads but no human-response table or raw trace/frame bytes", async () => {
  const queries: string[] = [];
  const repo = new PlaytestRepository({
    fetchImpl: async (input) => {
      queries.push(new URL(String(input)).searchParams.get("query") ?? "");
      return new Response("", { status: 200 });
    }
  });
  await repo.ensureSchema();
  await repo.ensureSchema();
  assert.equal(queries.length, 18);
  assert.ok(
    queries.every((query) => query.includes("CREATE TABLE IF NOT EXISTS"))
  );
  assert.ok(queries.every((query) => query.includes("payload_json")));
  assert.ok(queries.some((query) => query.includes("trace_hash_manifest")));
  assert.ok(queries.some((query) => query.includes("playtest_human_studies")));
  assert.ok(
    queries.some((query) => query.includes("playtest_human_summaries"))
  );
  assert.ok(
    queries.every(
      (query) =>
        !/human_experience|participant_id|raw_trace|frame_bytes/u.test(query)
    )
  );
});

test("comparisons, benchmarks, and experiments support cursor pagination, full totals, and workspace isolation", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  // 1. Comparisons
  for (let index = 1; index <= 25; index += 1) {
    const item = comparison(index, index <= 15 ? "workspace-a" : "workspace-b");
    const rows = fake.tables.get("playtest_comparisons") ?? [];
    rows.push(encodeComparison(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_comparisons", rows);
  }

  const compPage1 = await repo.listComparisons(
    { workspaceId: "workspace-a" },
    { limit: 6 }
  );
  assert.equal(compPage1.total, 15);
  assert.equal(compPage1.rows.length, 6);
  assert.ok(compPage1.nextCursor);
  assert.ok(
    compPage1.rows.every((row) => row.provenance.workspaceId === "workspace-a")
  );

  const compPage2 = await repo.listComparisons(
    { workspaceId: "workspace-a" },
    { limit: 6, cursor: compPage1.nextCursor! }
  );
  assert.equal(compPage2.total, 15);
  assert.equal(compPage2.rows.length, 6);
  assert.ok(compPage2.nextCursor);
  const compIds = new Set([
    ...compPage1.rows.map((r) => r.comparisonId),
    ...compPage2.rows.map((r) => r.comparisonId)
  ]);
  assert.equal(compIds.size, 12);

  const compFiltered = await repo.listComparisons({
    workspaceId: "workspace-a",
    decision: "eligible-for-owner-promotion"
  });
  assert.equal(compFiltered.total, 7);
  assert.equal(compFiltered.rows.length, 7);
  assert.equal(
    await repo.countComparisons({
      workspaceId: "workspace-a",
      decision: "eligible-for-owner-promotion"
    }),
    7
  );

  // 2. Benchmarks
  for (let index = 1; index <= 25; index += 1) {
    const item = benchmark(index, index <= 15 ? "workspace-a" : "workspace-b");
    const rows = fake.tables.get("playtest_benchmarks") ?? [];
    rows.push(encodeBenchmark(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_benchmarks", rows);
  }

  const benchPage1 = await repo.listBenchmarks(
    { workspaceId: "workspace-a" },
    { limit: 5 }
  );
  assert.equal(benchPage1.total, 15);
  assert.equal(benchPage1.rows.length, 5);
  assert.ok(benchPage1.nextCursor);
  assert.ok(benchPage1.rows.every((row) => row.workspaceId === "workspace-a"));

  const benchPage2 = await repo.listBenchmarks(
    { workspaceId: "workspace-a" },
    { limit: 5, cursor: benchPage1.nextCursor! }
  );
  assert.equal(benchPage2.total, 15);
  assert.equal(benchPage2.rows.length, 5);
  const benchIds = new Set([
    ...benchPage1.rows.map((r) => r.benchmarkId),
    ...benchPage2.rows.map((r) => r.benchmarkId)
  ]);
  assert.equal(benchIds.size, 10);

  const benchFiltered = await repo.listBenchmarks({
    workspaceId: "workspace-a",
    referenceBuildSha: "build-a"
  });
  assert.equal(benchFiltered.total, 7);
  assert.equal(
    await repo.countBenchmarks({
      workspaceId: "workspace-a",
      referenceBuildSha: "build-a"
    }),
    7
  );

  // 3. Experiments
  for (let index = 1; index <= 25; index += 1) {
    const item = experiment(index, index <= 15 ? "workspace-a" : "workspace-b");
    const rows = fake.tables.get("playtest_experiments") ?? [];
    rows.push(encodeExperiment(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_experiments", rows);
  }

  const expPage1 = await repo.listExperiments(
    { workspaceId: "workspace-a" },
    { limit: 4 }
  );
  assert.equal(expPage1.total, 15);
  assert.equal(expPage1.rows.length, 4);
  assert.ok(expPage1.nextCursor);
  assert.ok(expPage1.rows.every((row) => row.workspaceId === "workspace-a"));

  const expPage2 = await repo.listExperiments(
    { workspaceId: "workspace-a" },
    { limit: 4, cursor: expPage1.nextCursor! }
  );
  assert.equal(expPage2.total, 15);
  assert.equal(expPage2.rows.length, 4);
  const expIds = new Set([
    ...expPage1.rows.map((r) => r.experimentId),
    ...expPage2.rows.map((r) => r.experimentId)
  ]);
  assert.equal(expIds.size, 8);

  const expFiltered = await repo.listExperiments({
    workspaceId: "workspace-a",
    state: "approved"
  });
  assert.equal(expFiltered.total, 7);
  assert.equal(
    await repo.countExperiments({
      workspaceId: "workspace-a",
      state: "approved"
    }),
    7
  );
});

test("human study metadata supports insertion, benchmark lookup, and filtered pagination", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  for (let index = 1; index <= 20; index += 1) {
    const item = humanStudy(index, index <= 12 ? "workspace-a" : "workspace-b");
    const rows = fake.tables.get("playtest_human_studies") ?? [];
    rows.push(encodeHumanStudy(item) as unknown as Record<string, unknown>);
    fake.tables.set("playtest_human_studies", rows);
  }

  const studyPage1 = await repo.listHumanStudies(
    { workspaceId: "workspace-a" },
    { limit: 5 }
  );
  assert.equal(studyPage1.total, 12);
  assert.equal(studyPage1.rows.length, 5);
  assert.ok(studyPage1.nextCursor);
  assert.ok(studyPage1.rows.every((row) => row.workspaceId === "workspace-a"));

  const studyPage2 = await repo.listHumanStudies(
    { workspaceId: "workspace-a" },
    { limit: 5, cursor: studyPage1.nextCursor! }
  );
  assert.equal(studyPage2.total, 12);
  assert.equal(studyPage2.rows.length, 5);
  const studyIds = new Set([
    ...studyPage1.rows.map((r) => r.studyId),
    ...studyPage2.rows.map((r) => r.studyId)
  ]);
  assert.equal(studyIds.size, 10);

  const approvedPage = await repo.listHumanStudies({
    workspaceId: "workspace-a",
    approved: true
  });
  assert.equal(approvedPage.total, 6);
  assert.equal(
    await repo.countHumanStudies({
      workspaceId: "workspace-a",
      approved: true
    }),
    6
  );

  const latestStudy = await repo.getLatestHumanStudy(
    "workspace-a",
    "study-00001"
  );
  assert.ok(latestStudy);
  assert.equal(latestStudy.studyId, "study-00001");

  const studyByBench = await repo.getLatestHumanStudyByBenchmark(
    "workspace-a",
    "benchmark-1"
  );
  assert.ok(studyByBench);
  assert.equal(studyByBench.workspaceId, "workspace-a");
});

test("human summary suppression enforces privacy for <5 retained participants vs unsuppressed for >=5", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  // 1. Unsuppressed summary with >= 5 retained participants
  const unsuppressedSummary = humanSummary("study-5", 5);
  await repo.insertHumanSummary(unsuppressedSummary);

  const res5 = await repo.getHumanValidationSummary("workspace-a", "study-5");
  assert.ok(res5);
  assert.equal(res5.suppressionState, "unsuppressed");
  if (res5.suppressionState === "unsuppressed") {
    assert.equal(res5.retainedParticipants, 5);
    assert.equal(res5.items.length, 1);
    assert.equal(res5.items[0]?.itemId, "ENJ");
    assert.equal(res5.items[0]?.mean, 2.5);
    assert.equal(res5.items[0]?.respondentCount, 5);
    assert.deepEqual(res5.items[0]?.categoryCounts, {
      "-3": 0,
      "-2": 0,
      "-1": 0,
      "0": 0,
      "1": 1,
      "2": 2,
      "3": 2
    });
  }

  // 2. Suppressed summary with < 5 retained participants (small-cell response)
  const suppressedSummary = humanSummary(
    "study-4",
    4,
    1,
    false,
    "workspace-a",
    "benchmark-suppressed"
  );
  await repo.insertHumanSummary(suppressedSummary);

  const res4 = await repo.getHumanValidationSummary("workspace-a", "study-4");
  assert.ok(res4);
  assert.equal(res4.suppressionState, "suppressed");
  assert.equal(
    res4.suppressionReason,
    "small-cell-privacy-retained-participants-under-5"
  );
  assert.equal("retainedParticipants" in res4, false);
  assert.equal("items" in res4, false);
  assert.equal("mean" in res4, false);
  assert.equal("distribution" in res4, false);
  assert.equal("categoryCounts" in res4, false);
  assert.equal("participantId" in res4, false);

  // 3. Querying by benchmark also applies suppression
  const benchSummarySuppressed =
    await repo.getHumanValidationSummaryByBenchmark(
      "workspace-a",
      "benchmark-suppressed"
    );
  assert.ok(benchSummarySuppressed);
  assert.equal(benchSummarySuppressed.suppressionState, "suppressed");

  const benchSummaryUnsuppressed =
    await repo.getHumanValidationSummaryByBenchmark(
      "workspace-a",
      "benchmark-1"
    );
  assert.ok(benchSummaryUnsuppressed);
  assert.equal(benchSummaryUnsuppressed.suppressionState, "unsuppressed");
});

test("withdrawals and tombstone revisions remove prior summary from active reads", async () => {
  const fake = makeClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  // Revision 1: active unsuppressed summary with 6 retained participants
  await repo.insertHumanSummary(humanSummary("study-tombstone", 6, 1, false));

  const beforeWithdrawal = await repo.getHumanValidationSummary(
    "workspace-a",
    "study-tombstone"
  );
  assert.ok(beforeWithdrawal);
  assert.equal(beforeWithdrawal.suppressionState, "unsuppressed");

  // Revision 2: participant withdrawal / tombstone revision
  await repo.insertHumanSummary(humanSummary("study-tombstone", 0, 2, true));

  const afterWithdrawal = await repo.getHumanValidationSummary(
    "workspace-a",
    "study-tombstone"
  );
  assert.equal(afterWithdrawal, null);

  assert.equal(
    await repo.getLatestHumanSummary("workspace-a", "study-tombstone"),
    null
  );
});

test("human summary codec strictly rejects raw participant IDs, response IDs, and free text", () => {
  const base = humanSummary("study-leak", 5);

  assert.throws(
    () =>
      encodeHumanSummary({
        ...base,
        participantId: "p-12345"
      } as unknown as PlaytestHumanAggregateRecord),
    /Participant-identifying or raw response field "participantId" is prohibited/u
  );

  assert.throws(
    () =>
      encodeHumanSummary({
        ...base,
        pseudonymousParticipantId: "pseudo-12345"
      } as unknown as PlaytestHumanAggregateRecord),
    /Participant-identifying or raw response field "pseudonymousParticipantId" is prohibited/u
  );

  assert.throws(
    () =>
      encodeHumanSummary({
        ...base,
        freeText: "User said this was fun"
      } as unknown as PlaytestHumanAggregateRecord),
    /Participant-identifying or raw response field "freeText" is prohibited/u
  );

  assert.throws(
    () =>
      encodeHumanSummary({
        ...base,
        items: [
          {
            ...base.items[0]!,
            participantId: "leak"
          } as unknown as PlaytestHumanAggregateRecord["items"][number]
        ]
      }),
    /Raw participant or response fields are prohibited in human item summaries/u
  );
});

test("unavailable and malformed ClickHouse failures never appear as empty collections or zero counts across all entities", async () => {
  for (const fetchImpl of [
    (async () => new Response("not json", { status: 200 })) as typeof fetch,
    (async () =>
      Response.json(
        { total: "invalid-count" },
        { status: 200 }
      )) as typeof fetch,
    (async () =>
      new Response("service unavailable", { status: 503 })) as typeof fetch,
    (async () => {
      throw new Error("network partition");
    }) as typeof fetch
  ]) {
    const repo = new PlaytestRepository({ fetchImpl });

    await assert.rejects(
      repo.listComparisons({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.countComparisons({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getLatestComparison("workspace-a", "comp-1"),
      PlaytestSourceUnavailableError
    );

    await assert.rejects(
      repo.listBenchmarks({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.countBenchmarks({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getLatestBenchmark("workspace-a", "bench-1"),
      PlaytestSourceUnavailableError
    );

    await assert.rejects(
      repo.listExperiments({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.countExperiments({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getLatestExperiment("workspace-a", "exp-1"),
      PlaytestSourceUnavailableError
    );

    await assert.rejects(
      repo.listHumanStudies({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.countHumanStudies({ workspaceId: "workspace-a" }),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getLatestHumanStudy("workspace-a", "study-1"),
      PlaytestSourceUnavailableError
    );

    await assert.rejects(
      repo.getHumanValidationSummary("workspace-a", "study-1"),
      PlaytestSourceUnavailableError
    );
    await assert.rejects(
      repo.getHumanValidationSummaryByBenchmark("workspace-a", "benchmark-1"),
      PlaytestSourceUnavailableError
    );
  }
});
