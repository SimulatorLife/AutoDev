import assert from "node:assert/strict";
import test from "node:test";

import { PLAYTESTS_MAX_BATCH_ASSIGNMENTS } from "@simulatorlife/autodev-core";

import {
  fetchPlaytestingEpisode,
  fetchPlaytestingFrame,
  fetchPlaytestingHumanValidation,
  fetchPlaytestingPage,
  fetchPlaytestingReadiness,
  fetchPlaytestingWindow,
  playtestingReadinessFailure,
  startPlaytestingRun
} from "../app/playtesting/playtesting-server.ts";
import { fetchControlApiBinary } from "../src/lib/server/control-api.ts";

const config = {
  baseUrl: "http://127.0.0.1:4101",
  serviceToken: "secret-control-token"
};
const workspaceId = "owner/game";

test("run client forwards the canonical maximum batch and rejects a larger inventory before fetch", async () => {
  let body: unknown = null;
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    body = JSON.parse(String(init?.body));
    return response({
      schema: "autodev-control-playtesting-run-started-v1",
      workspaceId,
      batchId: "batch-1000",
      assignmentCount: PLAYTESTS_MAX_BATCH_ASSIGNMENTS,
      status: "running"
    });
  };
  const assignments = Array.from(
    { length: PLAYTESTS_MAX_BATCH_ASSIGNMENTS },
    (_, index) => ({
      scenario: "tutorial",
      policy: "random",
      seed: "seed-" + String(index + 1),
      maxSteps: 20
    })
  );
  const started = await startPlaytestingRun(
    { workspaceId, assignments },
    config,
    { fetchImpl }
  );
  assert.equal(started.kind, "ok");
  assert.equal(
    (body as { assignments: readonly unknown[] }).assignments.length,
    PLAYTESTS_MAX_BATCH_ASSIGNMENTS
  );

  const oversized = await startPlaytestingRun(
    {
      workspaceId,
      assignments: [...assignments, { ...assignments[0]!, seed: "extra" }]
    },
    config,
    { fetchImpl }
  );
  assert.equal(oversized.kind, "invalid-response");
  assert.equal(calls, 1);
});

function response(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

test("Playtesting readiness validates workspace and reports schema startup without waiting for Data", async () => {
  let requested = "";
  const result = await fetchPlaytestingReadiness(workspaceId, config, {
    fetchImpl: (async (input) => {
      requested = String(input);
      return response({
        schema: "autodev-control-playtesting-readiness-v1",
        workspaceId,
        status: "initializing"
      });
    }) as typeof fetch
  });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.equal(result.data.status, "initializing");
  assert.match(requested, /\/control\/playtesting\/readiness\?/u);
  assert.match(requested, /workspaceId=owner%2Fgame/u);

  const rejected = await fetchPlaytestingReadiness("not-canonical", config, {
    fetchImpl: (async () => {
      throw new Error("invalid workspace must be rejected locally");
    }) as typeof fetch
  });
  assert.equal(rejected.kind, "invalid-response");
});

test("Playtesting readiness retry uses the operator-only initialization route", async () => {
  let method = "";
  let requested = "";
  const result = await fetchPlaytestingReadiness(workspaceId, config, {
    retry: true,
    fetchImpl: (async (input, init) => {
      requested = String(input);
      method = init?.method ?? "GET";
      return response({
        schema: "autodev-control-playtesting-readiness-v1",
        workspaceId,
        status: "initializing"
      });
    }) as typeof fetch
  });
  assert.equal(result.kind, "ok");
  assert.equal(method, "POST");
  assert.match(requested, /\/control\/playtesting\/initialize\?/u);
});

test("Playtesting readiness rejects cross-workspace or malformed status responses", async () => {
  const result = await fetchPlaytestingReadiness(workspaceId, config, {
    fetchImpl: (async () =>
      response({
        schema: "autodev-control-playtesting-readiness-v1",
        workspaceId: "other/game",
        status: "ready"
      })) as typeof fetch
  });
  assert.equal(result.kind, "invalid-response");
});

test("resource initialization errors share the readiness UX mapping", () => {
  assert.deepEqual(
    playtestingReadinessFailure({
      kind: "http-error",
      status: 503,
      code: "autodev_control_playtesting_source_initializing",
      message: "Schema DDL is still running."
    }),
    {
      status: "initializing",
      code: "autodev_control_playtesting_source_initializing",
      message: "Schema DDL is still running."
    }
  );
  assert.equal(
    playtestingReadinessFailure({
      kind: "http-error",
      status: 503,
      code: "autodev_control_playtesting_source_unavailable",
      message: "Schema initialization failed."
    })?.status,
    "unavailable"
  );
  assert.equal(
    playtestingReadinessFailure({
      kind: "http-error",
      status: 404,
      code: "autodev_control_playtesting_episode_not_found",
      message: "Episode not found."
    }),
    null
  );
});

test("resource read transient errors map to the shared readiness state", () => {
  assert.deepEqual(
    playtestingReadinessFailure({
      kind: "http-error",
      status: 503,
      code: "autodev_control_playtesting_source_initializing",
      message: "The schema is still initializing."
    }),
    {
      status: "initializing",
      code: "autodev_control_playtesting_source_initializing",
      message: "The schema is still initializing."
    }
  );
  assert.equal(
    playtestingReadinessFailure({
      kind: "http-error",
      status: 503,
      code: "autodev_control_playtesting_source_unavailable",
      message: "Schema initialization failed."
    })?.status,
    "unavailable"
  );
  assert.equal(
    playtestingReadinessFailure({
      kind: "http-error",
      status: 404,
      code: "autodev_control_playtesting_episode_not_found",
      message: "The episode was not found."
    }),
    null
  );
});

test("Playtesting page fetch sends server-bound identity and validates keyset totals", async () => {
  let requested = "";
  let authorization = "";
  let actor = "";
  const result = await fetchPlaytestingPage(
    "episodes",
    {
      workspaceId,
      limit: 25,
      cursor: "next-keyset",
      filters: { buildSha: "a".repeat(40), cohort: "novice" }
    },
    config,
    {
      fetchImpl: (async (input, init) => {
        requested = String(input);
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization") ?? "";
        actor = headers.get("x-autodev-actor") ?? "";
        return response({
          schema: "autodev-control-playtesting-page-v1",
          workspaceId,
          resource: "episodes",
          readOnly: true,
          page: { rows: [], total: 10_000, nextCursor: "next-keyset-2" }
        });
      }) as typeof fetch
    }
  );
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.equal(result.data.page.total, 10_000);
  assert.equal(result.data.page.nextCursor, "next-keyset-2");
  const url = new URL(requested);
  assert.equal(url.pathname, "/control/playtesting/episodes");
  assert.equal(url.searchParams.get("workspaceId"), workspaceId);
  assert.equal(url.searchParams.get("buildSha"), "a".repeat(40));
  assert.equal(url.searchParams.get("cohort"), "novice");
  assert.equal(url.searchParams.get("cursor"), "next-keyset");
  assert.equal(authorization, `Bearer ${config.serviceToken}`);
  assert.equal(actor, "autodev-local");
});

test("Playtesting page rejects a response for another workspace rather than rendering its rows", async () => {
  const result = await fetchPlaytestingPage(
    "findings",
    { workspaceId, limit: 50 },
    config,
    {
      fetchImpl: (async () =>
        response({
          schema: "autodev-control-playtesting-page-v1",
          workspaceId: "other/game",
          resource: "findings",
          readOnly: true,
          page: { rows: [], total: 0, nextCursor: null }
        })) as typeof fetch
    }
  );
  assert.equal(result.kind, "invalid-response");
});

test("Playtesting selected episode validates workspace binding and nullable review", async () => {
  let requested = "";
  const episode = {
    schema: "autodev-playtest-episode-v3",
    episodeId: "episode-1",
    revision: 1,
    batchId: "batch-1",
    identity: { workspaceId },
    stepCount: 0,
    metrics: [],
    frames: []
  };
  const result = await fetchPlaytestingEpisode(
    workspaceId,
    "episode-1",
    config,
    {
      fetchImpl: (async (input) => {
        requested = String(input);
        return response({
          schema: "autodev-control-playtesting-detail-v1",
          workspaceId,
          resource: "episode",
          readOnly: true,
          record: episode,
          latestReview: null
        });
      }) as typeof fetch
    }
  );
  assert.equal(result.kind, "ok");
  assert.match(requested, /\/control\/playtesting\/episodes\/episode-1\?/u);
});

test("Playtesting window fetch validates the exact episode, artifact, and step range", async () => {
  const requestArgs = {
    workspaceId,
    episodeId: "episode-1",
    artifactId: "trace-window-1",
    startStep: 10,
    endStep: 12
  } as const;
  const result = await fetchPlaytestingWindow(requestArgs, config, {
    fetchImpl: (async () =>
      response({
        schema: "autodev-control-playtesting-window-v1",
        ...requestArgs,
        sha256: "b".repeat(64),
        mediaType: "application/x-ndjson",
        sourceLineCount: 4,
        omittedLineCount: 1,
        entries: [{ step: 10, eventId: "event-10" }]
      })) as typeof fetch
  });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") assert.equal(result.data.entries.length, 1);
});

test("human validation read accepts only scoped suppression-aware aggregates", async () => {
  const studyId = "human-study-1";
  const buildSha = "b".repeat(40);
  let requested = "";
  const result = await fetchPlaytestingHumanValidation(
    workspaceId,
    studyId,
    buildSha,
    config,
    {
      fetchImpl: (async (input) => {
        requested = String(input);
        return response({
          schema: "autodev-control-playtesting-human-validation-v1",
          workspaceId,
          studyId,
          buildSha,
          preference: null,
          summary: {
            revision: 2,
            benchmarkId: "benchmark-1",
            instrument: "miniPXI",
            measurementVersion: "playtesting-measurement-v2",
            suppressionState: "suppressed",
            retainedParticipants: null,
            items: [
              {
                itemId: "ENJ",
                suppressionState: "suppressed",
                mean: null,
                respondentCount: null,
                missingCount: null,
                categoryCounts: null,
                unit: "native-Likert-minus3-plus3"
              }
            ],
            constructs: [],
            pairedDifferences: []
          }
        });
      }) as typeof fetch
    }
  );
  assert.equal(result.kind, "ok");
  assert.match(requested, /human-studies\/human-study-1\/validation/u);
  assert.match(requested, /workspaceId=owner%2Fgame/u);
  assert.match(requested, /buildSha=b{40}/u);

  const leaksIdentity = await fetchPlaytestingHumanValidation(
    workspaceId,
    studyId,
    buildSha,
    config,
    {
      fetchImpl: (async () =>
        response({
          schema: "autodev-control-playtesting-human-validation-v1",
          workspaceId,
          studyId,
          buildSha,
          preference: null,
          summary: {
            revision: 1,
            benchmarkId: null,
            instrument: "miniPXI",
            measurementVersion: "measurement-v1",
            suppressionState: "unsuppressed",
            retainedParticipants: 5,
            items: [
              {
                itemId: "ENJ",
                suppressionState: "unsuppressed",
                mean: 1,
                respondentCount: 5,
                missingCount: 0,
                categoryCounts: { "1": 5 },
                unit: "native-Likert-minus3-plus3",
                participantId: "must-not-cross-boundary"
              }
            ],
            constructs: [],
            pairedDifferences: []
          }
        })) as typeof fetch
    }
  );
  assert.equal(leaksIdentity.kind, "invalid-response");
});

test("Playtesting frame fetch accepts only bounded inert raster image bytes", async () => {
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00
  ]);
  let authorization = "";
  let actor = "";
  const result = await fetchPlaytestingFrame(
    workspaceId,
    "episode-1",
    "frame-1",
    config,
    {
      fetchImpl: (async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization") ?? "";
        actor = headers.get("x-autodev-actor") ?? "";
        return new Response(signature, {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }) as typeof fetch
    }
  );
  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal(result.data.mediaType, "image/png");
    assert.deepEqual(result.data.bytes, signature);
  }
  assert.equal(authorization, `Bearer ${config.serviceToken}`);
  assert.equal(actor, "autodev-local");
});

test("Playtesting frame fetch refuses non-local paths and active content types", async () => {
  const invalidPath = await fetchControlApiBinary(
    "https://attacker.example/steal-token",
    config,
    {
      fetchImpl: (async () => {
        throw new Error("must not issue a request");
      }) as typeof fetch
    }
  );
  assert.equal(invalidPath.kind, "invalid-response");

  const activeContent = await fetchPlaytestingFrame(
    workspaceId,
    "episode-1",
    "frame-1",
    config,
    {
      fetchImpl: (async () =>
        new Response("<svg onload=alert(1)>", {
          status: 200,
          headers: { "content-type": "image/svg+xml" }
        })) as typeof fetch
    }
  );
  assert.equal(activeContent.kind, "invalid-response");
});
