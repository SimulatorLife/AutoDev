import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
  PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE,
  PLAYTESTS_SESSION_REVIEW_SCHEMA,
  type PlaytestDiscoverySessionReview,
  type PlaytestSessionReview
} from "@simulatorlife/autodev-core";

import {
  PlaytestRepository,
  type PlaytestListOptions,
  type PlaytestReviewSummary
} from "../../src/playtesting/index.ts";

const WORKSPACE_A = "workspace-a/game";
const WORKSPACE_B = "workspace-b/game";
const EPISODE_A = "episode-00001";
const EPISODE_B = "episode-00002";

/** One indexed review row as `playtest_reviews` holds it. */
interface StoredReviewRow {
  readonly workspace_id: string;
  readonly episode_id: string;
  readonly review_id: string;
  readonly version: number;
  readonly author_role: string;
  readonly rubric_hash: string;
  readonly measurement_version: string;
  readonly created_at: string;
  readonly payload_json: string;
}

function storedRow(options: {
  readonly workspaceId?: string;
  readonly episodeId: string;
  readonly reviewId: string;
  readonly version?: number;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
}): StoredReviewRow {
  return {
    workspace_id: options.workspaceId ?? WORKSPACE_A,
    episode_id: options.episodeId,
    review_id: options.reviewId,
    version: options.version ?? 1,
    author_role: "playtest-analyst",
    rubric_hash: "",
    measurement_version: "measurement-v1",
    created_at: options.createdAt,
    payload_json: JSON.stringify(options.payload)
  };
}

interface PayloadOptions {
  readonly reviewId: string;
  readonly episodeId: string;
  readonly workspaceId?: string;
  readonly version?: number;
  readonly observations?: readonly unknown[];
  readonly interpretations?: readonly unknown[];
  readonly findings?: readonly unknown[];
  readonly chronologicalSummary?: string;
  readonly status?: string;
  readonly evidenceRefs?: readonly unknown[];
}

/**
 * A confirmatory review payload. Keys left undefined are absent from the
 * payload, so a test can ask for a review that never carried them.
 */
function confirmatoryPayload(options: PayloadOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
    reviewId: options.reviewId,
    version: options.version ?? 1,
    episodeId: options.episodeId,
    provenance: {
      workspaceId: options.workspaceId ?? WORKSPACE_A,
      measurementVersion: "measurement-v1",
      generatedAt: "2026-10-01T00:00:00.000Z"
    },
    createdAt: "2026-10-01T00:00:00.000Z"
  };
  if (options.chronologicalSummary !== undefined) {
    payload.chronologicalSummary = options.chronologicalSummary;
  }
  if (options.observations !== undefined)
    payload.observations = options.observations;
  if (options.interpretations !== undefined) {
    payload.interpretations = options.interpretations;
  }
  if (options.findings !== undefined) payload.findings = options.findings;
  if (options.status !== undefined) payload.status = options.status;
  if (options.evidenceRefs !== undefined)
    payload.evidenceRefs = options.evidenceRefs;
  return payload;
}

/** A discovery review payload; its workspace lives at the top level. */
function discoveryPayload(options: PayloadOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    schema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
    analysisKind: "discovery",
    reviewId: options.reviewId,
    version: options.version ?? 1,
    workspaceId: options.workspaceId ?? WORKSPACE_A,
    batchId: "batch-visual-1",
    episodeId: options.episodeId,
    createdAt: "2026-10-01T00:00:00.000Z"
  };
  if (options.chronologicalSummary !== undefined) {
    payload.chronologicalSummary = options.chronologicalSummary;
  }
  if (options.observations !== undefined)
    payload.observations = options.observations;
  if (options.interpretations !== undefined) {
    payload.interpretations = options.interpretations;
  }
  if (options.findings !== undefined) payload.findings = options.findings;
  if (options.status !== undefined) payload.status = options.status;
  if (options.evidenceRefs !== undefined)
    payload.evidenceRefs = options.evidenceRefs;
  return payload;
}

function payloadSchema(row: StoredReviewRow): unknown {
  return (JSON.parse(row.payload_json) as { readonly schema?: unknown }).schema;
}

function compareRows(a: StoredReviewRow, b: StoredReviewRow): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? 1 : -1;
  }
  if (a.review_id === b.review_id) return 0;
  return a.review_id < b.review_id ? 1 : -1;
}

/**
 * A fake ClickHouse endpoint for the review table.
 *
 * It answers exactly what the review list asks for: workspace scope, the
 * optional episode and kind filters, the latest-version fold, the keyset
 * cursor and the population count.
 */
function makeReviewClickHouseFetch(seed: readonly StoredReviewRow[] = []) {
  const table: StoredReviewRow[] = [...seed];
  const calls: URL[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    const query = url.searchParams.get("query") ?? "";
    if (query.startsWith("INSERT INTO ")) {
      for (const line of String(init?.body ?? "")
        .split("\n")
        .filter((value) => value.length > 0)) {
        table.push(JSON.parse(line) as StoredReviewRow);
      }
      return new Response("", { status: 200 });
    }

    const workspaceId = url.searchParams.get("param_workspaceId") ?? "";
    const episodeId = url.searchParams.get("param_episodeId");
    const discoverySchema = url.searchParams.get("param_discoverySchema");
    let filtered = table.filter((row) => row.workspace_id === workspaceId);
    if (episodeId !== null) {
      filtered = filtered.filter((row) => row.episode_id === episodeId);
    }
    if (
      query.includes(
        "JSONExtractString(payload_json, 'schema') != {discoverySchema:String}"
      )
    ) {
      filtered = filtered.filter(
        (row) => payloadSchema(row) !== discoverySchema
      );
    } else if (
      query.includes(
        "JSONExtractString(payload_json, 'schema') = {discoverySchema:String}"
      )
    ) {
      filtered = filtered.filter(
        (row) => payloadSchema(row) === discoverySchema
      );
    }

    const latest = new Map<string, StoredReviewRow>();
    for (const row of filtered) {
      const key = `${row.workspace_id}|${row.episode_id}|${row.review_id}`;
      const current = latest.get(key);
      if (current === undefined || row.version > current.version) {
        latest.set(key, row);
      }
    }
    if (query.includes("count() AS total")) {
      return Response.json({ total: String(latest.size) }, { status: 200 });
    }

    const cursorOrderedAt = url.searchParams.get("param_cursorOrderedAt");
    const cursorTiebreakId = url.searchParams.get("param_cursorTiebreakId");
    let ordered = [...latest.values()].sort(compareRows);
    if (cursorOrderedAt !== null && cursorTiebreakId !== null) {
      ordered = ordered.filter(
        (row) =>
          row.created_at < cursorOrderedAt ||
          (row.created_at === cursorOrderedAt &&
            row.review_id < cursorTiebreakId)
      );
    }
    const limit = Number(url.searchParams.get("param_limit") ?? "500");
    return new Response(
      ordered
        .slice(0, limit)
        .map((row) => JSON.stringify(row))
        .join("\n"),
      { status: 200 }
    );
  };
  return { fetchImpl, calls, table };
}

function claim(text: string): Record<string, unknown> {
  return {
    text,
    evidenceRefs: [{ kind: "episode", id: EPISODE_A }]
  };
}

/** A page request that resumes at the cursor only when there is one. */
function pageOptions(
  limit: number,
  cursor: string | null
): PlaytestListOptions {
  return cursor === null ? { limit } : { limit, cursor };
}

test("the review list is workspace scoped and never returns another workspace's reviews", async () => {
  const fake = makeReviewClickHouseFetch([
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-a",
      createdAt: "2026-10-01 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-a",
        episodeId: EPISODE_A,
        interpretations: [claim("Workspace A interpretation")]
      })
    }),
    storedRow({
      episodeId: EPISODE_B,
      reviewId: "review-b",
      createdAt: "2026-10-02 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-b",
        episodeId: EPISODE_B,
        interpretations: [claim("Workspace A second review")]
      })
    }),
    storedRow({
      workspaceId: WORKSPACE_B,
      episodeId: EPISODE_A,
      reviewId: "review-foreign",
      createdAt: "2026-10-03 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-foreign",
        episodeId: EPISODE_A,
        workspaceId: WORKSPACE_B,
        interpretations: [claim("Foreign workspace interpretation")]
      })
    })
  ]);
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  const page = await repo.listReviews({ workspaceId: WORKSPACE_A });

  assert.equal(page.total, 2);
  assert.deepEqual(
    page.rows.map((row) => row.reviewId),
    ["review-b", "review-a"]
  );
  assert.ok(page.rows.every((row) => row.workspaceId === WORKSPACE_A));
  for (const call of fake.calls) {
    assert.equal(call.searchParams.get("param_workspaceId"), WORKSPACE_A);
  }
});

test("the review list keeps only the latest version of each review", async () => {
  const fake = makeReviewClickHouseFetch([
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-versioned",
      version: 1,
      createdAt: "2026-10-01 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-versioned",
        episodeId: EPISODE_A,
        version: 1,
        interpretations: [claim("First interpretation")]
      })
    }),
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-versioned",
      version: 2,
      createdAt: "2026-10-02 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-versioned",
        episodeId: EPISODE_A,
        version: 2,
        interpretations: [claim("Second interpretation")]
      })
    })
  ]);
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  const page = await repo.listReviews({ workspaceId: WORKSPACE_A });

  assert.equal(page.total, 1);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0]!.headline, "Second interpretation");
});

test("the review list tells discovery and confirmatory reviews apart", async () => {
  const fake = makeReviewClickHouseFetch([
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "discovery-review-1",
      createdAt: "2026-10-02 00:00:00.000",
      payload: discoveryPayload({
        reviewId: "discovery-review-1",
        episodeId: EPISODE_A,
        interpretations: [
          {
            hypothesisId: "interpretation-1",
            status: "not-observed",
            text: "Discovery interpretation",
            evidenceRefs: [{ kind: "episode", id: EPISODE_A }]
          }
        ]
      })
    }),
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-1",
      createdAt: "2026-10-01 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-1",
        episodeId: EPISODE_A,
        interpretations: [claim("Confirmatory interpretation")]
      })
    })
  ]);
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  const all = await repo.listReviews({ workspaceId: WORKSPACE_A });
  assert.deepEqual(
    all.rows.map((row) => [row.reviewId, row.kind]),
    [
      ["discovery-review-1", "discovery"],
      ["review-1", "confirmatory"]
    ]
  );

  const discovery = await repo.listReviews({
    workspaceId: WORKSPACE_A,
    kind: "discovery"
  });
  assert.equal(discovery.total, 1);
  assert.equal(discovery.rows[0]!.kind, "discovery");
  assert.equal(discovery.rows[0]!.headline, "Discovery interpretation");

  const confirmatory = await repo.listReviews({
    workspaceId: WORKSPACE_A,
    kind: "confirmatory"
  });
  assert.equal(confirmatory.total, 1);
  assert.equal(confirmatory.rows[0]!.kind, "confirmatory");
  assert.equal(confirmatory.rows[0]!.headline, "Confirmatory interpretation");
});

test("a review summary counts the observations, interpretations and findings of a review", async () => {
  const evidenceRefs = [
    { kind: "episode", id: EPISODE_A },
    { kind: "frame", id: "frame-1" },
    { kind: "frame", id: "frame-1" },
    { kind: "frame", id: "frame-2" },
    { kind: "frame", id: "frame-3" },
    { kind: "frame", id: "frame-4" },
    { kind: "frame", id: "frame-5" },
    { kind: "frame", id: "frame-6" },
    { kind: "frame", id: "frame-7" },
    { kind: "frame", id: "frame-8" },
    { kind: "frame", id: "frame-9" },
    { kind: "review", id: "review-other" }
  ];
  const fake = makeReviewClickHouseFetch([
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-counted",
      createdAt: "2026-10-01 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-counted",
        episodeId: EPISODE_A,
        chronologicalSummary: "The analyst concluded the race was lost.",
        status: "corroborated",
        observations: [claim("Observation one"), claim("Observation two")],
        interpretations: [
          claim("Interpretation one"),
          claim("Interpretation two"),
          claim("Interpretation three")
        ],
        findings: [{ findingId: "finding-1" }],
        evidenceRefs
      })
    })
  ]);
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  const page = await repo.listReviews({ workspaceId: WORKSPACE_A });
  const summary = page.rows[0]!;

  assert.equal(summary.observationCount, 2);
  assert.equal(summary.interpretationCount, 3);
  assert.equal(summary.findingCount, 1);
  assert.equal(summary.status, "corroborated");
  assert.equal(summary.headline, "Interpretation one");
  assert.equal(summary.summary, "The analyst concluded the race was lost.");
  assert.equal(summary.createdAt, "2026-10-01T00:00:00.000Z");
  // Twelve citations collapse to eight distinct ones: the duplicate frame is
  // dropped and the list row stops at the bounded number of references.
  assert.equal(summary.evidenceRefs.length, 8);
  assert.deepEqual(
    summary.evidenceRefs.map((ref) => ref.id),
    [
      EPISODE_A,
      "frame-1",
      "frame-2",
      "frame-3",
      "frame-4",
      "frame-5",
      "frame-6",
      "frame-7"
    ]
  );
});

test("a review headline falls back from interpretations to observations to the summary", async () => {
  const fake = makeReviewClickHouseFetch([
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-observation-headline",
      createdAt: "2026-10-03 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-observation-headline",
        episodeId: EPISODE_A,
        chronologicalSummary: "The chronological summary of the review.",
        observations: [claim("Observation headline")]
      })
    }),
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-summary-headline",
      createdAt: "2026-10-02 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-summary-headline",
        episodeId: EPISODE_A,
        chronologicalSummary: "The chronological summary of the review."
      })
    }),
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-empty-headline",
      createdAt: "2026-10-01 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-empty-headline",
        episodeId: EPISODE_A
      })
    })
  ]);
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  const page = await repo.listReviews({ workspaceId: WORKSPACE_A });

  assert.deepEqual(
    page.rows.map((row) => row.headline),
    ["Observation headline", "The chronological summary of the review.", ""]
  );
});

test("a review payload without the optional keys degrades instead of failing", async () => {
  const fake = makeReviewClickHouseFetch([
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-sparse",
      createdAt: "2026-10-01 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-sparse",
        episodeId: EPISODE_A
      })
    })
  ]);
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  const page = await repo.listReviews({ workspaceId: WORKSPACE_A });
  const summary = page.rows[0]!;

  assert.equal(summary.observationCount, 0);
  assert.equal(summary.interpretationCount, 0);
  assert.equal(summary.findingCount, 0);
  assert.equal(summary.status, "");
  assert.equal(summary.summary, "");
  assert.equal(summary.headline, "");
  assert.deepEqual(summary.evidenceRefs, []);
});

test("review paging resumes at the cursor and stops on the last page", async () => {
  const fake = makeReviewClickHouseFetch(
    [1, 2, 3, 4, 5].map((index) =>
      storedRow({
        episodeId: EPISODE_A,
        reviewId: `review-${index}`,
        createdAt: `2026-10-0${index} 00:00:00.000`,
        payload: confirmatoryPayload({
          reviewId: `review-${index}`,
          episodeId: EPISODE_A,
          interpretations: [claim(`Interpretation ${index}`)]
        })
      })
    )
  );
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  const first = await repo.listReviews(
    { workspaceId: WORKSPACE_A },
    { limit: 2 }
  );
  assert.equal(first.total, 5);
  assert.deepEqual(
    first.rows.map((row) => row.reviewId),
    ["review-5", "review-4"]
  );
  assert.notEqual(first.nextCursor, null);

  const second = await repo.listReviews(
    { workspaceId: WORKSPACE_A },
    pageOptions(2, first.nextCursor)
  );
  assert.deepEqual(
    second.rows.map((row) => row.reviewId),
    ["review-3", "review-2"]
  );
  assert.notEqual(second.nextCursor, null);

  const third = await repo.listReviews(
    { workspaceId: WORKSPACE_A },
    pageOptions(2, second.nextCursor)
  );
  assert.deepEqual(
    third.rows.map((row) => row.reviewId),
    ["review-1"]
  );
  assert.equal(third.nextCursor, null);

  // The cursor reached the query as a bound parameter, not as query text.
  const cursorCalls = fake.calls.filter((call) =>
    call.searchParams.has("param_cursorOrderedAt")
  );
  assert.equal(cursorCalls.length, 2);
  assert.equal(
    cursorCalls[0]!.searchParams.get("param_cursorTiebreakId"),
    "review-4"
  );
  assert.equal(
    cursorCalls[1]!.searchParams.get("param_cursorTiebreakId"),
    "review-2"
  );
});

test("countReviews agrees with the listed review population", async () => {
  const fake = makeReviewClickHouseFetch([
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-a",
      createdAt: "2026-10-01 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-a",
        episodeId: EPISODE_A
      })
    }),
    storedRow({
      episodeId: EPISODE_A,
      reviewId: "review-b",
      createdAt: "2026-10-02 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-b",
        episodeId: EPISODE_A
      })
    }),
    storedRow({
      episodeId: EPISODE_B,
      reviewId: "review-c",
      createdAt: "2026-10-03 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-c",
        episodeId: EPISODE_B
      })
    }),
    storedRow({
      workspaceId: WORKSPACE_B,
      episodeId: EPISODE_A,
      reviewId: "review-foreign",
      createdAt: "2026-10-04 00:00:00.000",
      payload: confirmatoryPayload({
        reviewId: "review-foreign",
        episodeId: EPISODE_A,
        workspaceId: WORKSPACE_B
      })
    })
  ]);
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });

  assert.equal(await repo.countReviews({ workspaceId: WORKSPACE_A }), 3);
  assert.equal(await repo.countReviews({ workspaceId: WORKSPACE_B }), 1);
  assert.equal(
    await repo.countReviews({ workspaceId: WORKSPACE_A, episodeId: EPISODE_A }),
    2
  );
  assert.equal(
    await repo.countReviews({ workspaceId: WORKSPACE_A, episodeId: EPISODE_B }),
    1
  );

  const page = await repo.listReviews({ workspaceId: WORKSPACE_A });
  assert.equal(
    page.total,
    await repo.countReviews({ workspaceId: WORKSPACE_A })
  );
  assert.equal(page.rows.length, page.total);
});

test("a persisted confirmatory and discovery review are listed from their canonical payloads", async () => {
  const fake = makeReviewClickHouseFetch();
  const repo = new PlaytestRepository({ fetchImpl: fake.fetchImpl });
  const episodeEvidence = { kind: "episode", id: EPISODE_A } as const;

  const confirmatory: PlaytestSessionReview = {
    schema: PLAYTESTS_SESSION_REVIEW_SCHEMA,
    reviewId: "review-canonical",
    version: 1,
    episodeId: EPISODE_A,
    supersedes: null,
    evidencePacket: {
      packetId: "packet-review-1",
      artifact: {
        artifactId: "artifact-review-1",
        sha256: "1".repeat(64),
        bytes: 256,
        mediaType: PLAYTESTS_EVIDENCE_PACKET_MEDIA_TYPE
      }
    },
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    rubricHash: "rubric-v1",
    measurementVersion: "measurement-v1",
    provenance: {
      workspaceId: WORKSPACE_A,
      measurementVersion: "measurement-v1",
      generatedAt: "2026-10-01T00:00:00.000Z"
    },
    chronologicalSummary: "The synthetic episode lost three races.",
    authoritativeMetrics: [],
    observations: [
      { text: "Synthetic observation", evidenceRefs: [episodeEvidence] }
    ],
    interpretations: [
      { text: "Synthetic interpretation", evidenceRefs: [episodeEvidence] }
    ],
    anchors: [],
    alternativeExplanations: [],
    reportCompleteness: {
      crossSessionContext: {
        status: "unavailable",
        reason: "The review packet contains only this session."
      },
      alternatives: {
        status: "none-identified",
        reason: "No alternative is included in this fixture."
      },
      experiments: {
        status: "none-recommended",
        reason: "No experiment is included in this fixture."
      },
      followUp: {
        status: "none",
        reason: "No follow-up is included in this fixture."
      }
    },
    experiments: [],
    status: "hypothesis",
    findings: [],
    evidenceRefs: [episodeEvidence],
    createdAt: "2026-10-01T00:00:00.000Z",
    notes: "Synthetic note"
  };

  const discovery: PlaytestDiscoverySessionReview = {
    schema: PLAYTESTS_DISCOVERY_SESSION_REVIEW_SCHEMA,
    analysisKind: "discovery",
    reviewId: "discovery-review-canonical",
    version: 1,
    workspaceId: WORKSPACE_A,
    batchId: "batch-visual-1",
    episodeId: EPISODE_A,
    supersedes: null,
    evidencePacket: {
      packetId: "discovery-packet-1",
      artifact: {
        artifactId: "discovery-packet-artifact-1",
        sha256: "2".repeat(64),
        bytes: 512,
        mediaType: PLAYTESTS_DISCOVERY_EVIDENCE_PACKET_MEDIA_TYPE
      }
    },
    authorRole: "playtest-analyst",
    authorId: "analyst-1",
    measurementVersion: "playtesting-measurement-v2",
    chronologicalSummary: "The setup screen exposed two visible stage choices.",
    observations: [
      {
        hypothesisId: "observation-1",
        status: "hypothesis",
        text: "Two stage choices were visible.",
        evidenceRefs: [episodeEvidence]
      }
    ],
    interpretations: [
      {
        hypothesisId: "interpretation-1",
        status: "not-observed",
        text: "The selected stage's effect was not observed.",
        evidenceRefs: [episodeEvidence]
      }
    ],
    alternativeExplanations: [],
    experiments: [],
    evidenceRefs: [episodeEvidence],
    createdAt: "2026-10-02T00:00:00.000Z",
    status: "hypothesis"
  };

  await repo.insertReview(confirmatory);
  await repo.insertDiscoveryReview(discovery);

  const page = await repo.listReviews({ workspaceId: WORKSPACE_A });
  const summaries: readonly PlaytestReviewSummary[] = page.rows;

  assert.equal(page.total, 2);
  assert.deepEqual(
    summaries.map((row) => [row.reviewId, row.kind, row.headline]),
    [
      [
        "discovery-review-canonical",
        "discovery",
        "The selected stage's effect was not observed."
      ],
      ["review-canonical", "confirmatory", "Synthetic interpretation"]
    ]
  );
  assert.deepEqual(
    summaries.map((row) => row.observationCount),
    [1, 1]
  );
  assert.deepEqual(
    summaries.map((row) => row.interpretationCount),
    [1, 1]
  );
  assert.deepEqual(
    summaries.map((row) => row.findingCount),
    [0, 0]
  );
  assert.deepEqual(
    summaries.map((row) => row.createdAt),
    ["2026-10-02T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]
  );
  assert.deepEqual(summaries[0]!.evidenceRefs, [episodeEvidence]);
});
