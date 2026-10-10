import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server.js";

import * as revokeRoute from "../app/api/workspaces/[owner]/[repository]/playtesting-approval/revoke/route.ts";
import * as approvalRoute from "../app/api/workspaces/[owner]/[repository]/playtesting-approval/route.ts";

/**
 * The Console-side form routes for the Workspaces-owned exact-build
 * playtesting approval boundary.
 *
 * Every case here is one the operator-facing form can actually produce:
 * a well-formed approval or revocation, a Runtime refusal because the
 * credential is not an operator, a Runtime refusal because the workspace is
 * disabled, a revision conflict from a stale page, and a malformed
 * submission the route must refuse before contacting Runtime at all. The
 * route never decides whether an approval is accepted -- only Runtime does
 * -- so each case is pinned by what the route *sent*, not by inventing an
 * outcome.
 */

const WORKSPACE_ID = "SimulatorLife/FixtureGame";
const [WORKSPACE_OWNER, WORKSPACE_REPOSITORY] = WORKSPACE_ID.split("/");
const RETURN_TO = `/workspaces/${WORKSPACE_OWNER}/${WORKSPACE_REPOSITORY}`;
const APPROVAL_PATH = `/api/workspaces/${WORKSPACE_OWNER}/${WORKSPACE_REPOSITORY}/playtesting-approval`;
const REVOKE_PATH = `${APPROVAL_PATH}/revoke`;

function params(workspaceId: string = WORKSPACE_ID): {
  params: Promise<{ owner: string; repository: string }>;
} {
  const [owner, repository] = workspaceId.split("/");
  return {
    params: Promise.resolve({
      owner: owner ?? "",
      repository: repository ?? ""
    })
  };
}

function request(
  path: string,
  fields: Record<string, string>,
  accept = "*/*"
): NextRequest {
  return new NextRequest(`http://console.test${path}`, {
    method: "POST",
    headers: {
      accept,
      origin: "http://console.test",
      host: "console.test",
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(fields).toString()
  });
}

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly body: string;
}

async function withMockedFetch<T>(
  respond: () => Response,
  run: () => Promise<T>
): Promise<{ readonly sent: Sent[]; readonly result: T }> {
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.AUTODEV_CONTROL_API_TOKEN;
  process.env.AUTODEV_CONTROL_API_TOKEN = "p".repeat(64);
  const sent: Sent[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    sent.push({
      url: String((input as Request).url ?? input),
      method: init?.method ?? "GET",
      body: String(init?.body ?? "")
    });
    return respond();
  }) as typeof fetch;
  try {
    const result = await run();
    return { sent, result };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) {
      delete process.env.AUTODEV_CONTROL_API_TOKEN;
    } else {
      process.env.AUTODEV_CONTROL_API_TOKEN = previousToken;
    }
  }
}

const APPROVE_FIELDS = {
  workspaceId: WORKSPACE_ID,
  expectedRevision: "",
  returnTo: RETURN_TO,
  checkoutRoot: "/home/operator/games/fixture",
  workingDirectory: "server",
  buildSha: "a".repeat(40),
  gameBuild: "fixture-game-1.0.0",
  playtestConfigHash: "e".repeat(64),
  adapterImageDigest: "fixture/adapter@sha256:" + "f".repeat(64),
  adapterCommand: "node, server.js",
  allowedScenarios: "tutorial, level-1",
  allowedPolicies: "random, heuristic",
  cpuCores: "1",
  memoryBytes: "134217728",
  processCount: "2",
  wallTimeMs: "60000",
  artifactBytes: "1048576",
  workerCount: "1",
  episodeCount: "10",
  maxStepsPerEpisode: "500",
  critiqueCount: "5",
  retentionDays: "30",
  issueReporting: "disabled",
  humanStudyAllowed: "false"
} as const;

function okApprovalResponse(): Response {
  return Response.json(
    {
      schema: "autodev-control-workspace-playtest-approval-v1",
      workspaceId: WORKSPACE_ID,
      workspaceEnabled: true,
      approval: {
        schema: "autodev-workspace-playtest-approval-v1",
        workspaceId: WORKSPACE_ID,
        revision: 1,
        approvalId: "synthetic-approval-1",
        checkoutRoot: "/tmp/synthetic-game",
        buildSha: "a".repeat(40),
        gameBuild: "fixture-game-1",
        playtestConfigHash: "b".repeat(64),
        adapterImageDigest: "fixture/adapter@sha256:" + "c".repeat(64),
        workingDirectory: "server",
        adapterCommand: ["node", "adapter.mjs"],
        allowedScenarios: ["tutorial"],
        allowedPolicies: ["random"],
        limits: {
          cpuCores: 1,
          memoryBytes: 134_217_728,
          processCount: 2,
          wallTimeMs: 60_000,
          artifactBytes: 1_048_576,
          workerCount: 1,
          episodeCount: 10,
          maxStepsPerEpisode: 20,
          critiqueCount: 0
        },
        retentionDays: 30,
        issueReporting: "disabled",
        humanStudyAllowed: false,
        approvedAt: "2026-10-10T00:00:00.000Z",
        approvedBy: "synthetic-operator",
        revokedAt: null,
        revokedBy: null,
        revocationReason: null
      }
    },
    { status: 200 }
  );
}

test("a well-formed approval reaches the exact playtesting-approval endpoint", async () => {
  const { sent, result } = await withMockedFetch(okApprovalResponse, () =>
    approvalRoute.POST(
      request(APPROVAL_PATH, {
        ...APPROVE_FIELDS
      }),
      params()
    )
  );

  assert.equal(sent.length, 1, "the submission should be one request");
  assert.match(
    sent[0]?.url ?? "",
    /\/control\/workspaces\/SimulatorLife%2FFixtureGame\/playtesting-approval$/u
  );
  assert.equal(sent[0]?.method, "POST");
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), RETURN_TO);
});

test("approval route returns a typed JSON result for in-place Console submission", async () => {
  const { result } = await withMockedFetch(okApprovalResponse, () =>
    approvalRoute.POST(
      request(APPROVAL_PATH, { ...APPROVE_FIELDS }, "application/json"),
      params()
    )
  );
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "ok");
  assert.equal(body.data.approval.approvalId, "synthetic-approval-1");
  assert.equal(result.headers.get("location"), null);
});

test("an in-place revision conflict returns the freshly read approval state", async () => {
  let callCount = 0;
  const active = (await okApprovalResponse().json()) as {
    schema: string;
    workspaceId: string;
    workspaceEnabled: boolean;
    approval: Record<string, unknown>;
  };
  const latest = {
    ...active,
    approval: { ...active.approval, revision: 2 }
  };
  const { sent, result } = await withMockedFetch(
    () => {
      callCount += 1;
      return callCount === 1
        ? Response.json(
            {
              error: {
                code: "autodev_workspace_playtesting_conflict",
                message: "stale revision"
              }
            },
            { status: 409 }
          )
        : Response.json(latest);
    },
    () =>
      approvalRoute.POST(
        request(APPROVAL_PATH, { ...APPROVE_FIELDS }, "application/json"),
        params()
      )
  );

  assert.equal(sent.length, 2, "conflicts re-read the authoritative approval");
  assert.equal(result.status, 409);
  const body = await result.json();
  assert.equal(body.kind, "refused");
  assert.equal(body.refusal, "conflicted");
  assert.equal(body.currentApproval.approval.revision, 2);
});

test("the sent approval body carries the whole exact-build grant, nothing else", async () => {
  const { sent } = await withMockedFetch(okApprovalResponse, () =>
    approvalRoute.POST(
      request(APPROVAL_PATH, {
        ...APPROVE_FIELDS
      }),
      params()
    )
  );
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;

  assert.deepEqual(
    new Set(Object.keys(body)),
    new Set([
      "expectedRevision",
      "checkoutRoot",
      "buildSha",
      "gameBuild",
      "playtestConfigHash",
      "adapterImageDigest",
      "workingDirectory",
      "adapterCommand",
      "allowedScenarios",
      "allowedPolicies",
      "limits",
      "retentionDays",
      "issueReporting",
      "humanStudyAllowed"
    ])
  );
  assert.equal(body.expectedRevision, null);
  assert.deepEqual(body.adapterCommand, ["node", "server.js"]);
  assert.deepEqual(body.allowedScenarios, ["tutorial", "level-1"]);
  assert.deepEqual(body.limits, {
    cpuCores: 1,
    memoryBytes: 134_217_728,
    processCount: 2,
    wallTimeMs: 60_000,
    artifactBytes: 1_048_576,
    workerCount: 1,
    episodeCount: 10,
    maxStepsPerEpisode: 500,
    critiqueCount: 5
  });
  assert.equal(body.humanStudyAllowed, false);
});

test("a re-approval carries the prior revision as the optimistic-concurrency token", async () => {
  const { sent } = await withMockedFetch(okApprovalResponse, () =>
    approvalRoute.POST(
      request(APPROVAL_PATH, {
        ...APPROVE_FIELDS,
        expectedRevision: "3"
      }),
      params()
    )
  );
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body.expectedRevision, 3);
});

test("a missing identity field is refused before the request, with no reason invented", async () => {
  const { sent, result } = await withMockedFetch(okApprovalResponse, () =>
    approvalRoute.POST(
      request(APPROVAL_PATH, {
        ...APPROVE_FIELDS,
        checkoutRoot: ""
      }),
      params()
    )
  );

  assert.equal(
    sent.length,
    0,
    "a malformed approval must not reach the Runtime"
  );
  assert.equal(result.status, 303);
  const location = result.headers.get("location") ?? "";
  assert.match(
    location,
    /^\/workspaces\/SimulatorLife\/FixtureGame\?control=failed$/u
  );
  assert.doesNotMatch(
    location,
    /refusal=/u,
    "a route-local refusal must not claim a Runtime reason it never asked for"
  );
});

test("a non-operator credential is reported as forbidden", async () => {
  const { sent, result } = await withMockedFetch(
    () =>
      Response.json(
        {
          error: {
            message: "Operator approval is required.",
            code: "autodev_workspace_playtesting_forbidden"
          }
        },
        { status: 403 }
      ),
    () =>
      approvalRoute.POST(
        request(APPROVAL_PATH, {
          ...APPROVE_FIELDS
        }),
        params()
      )
  );

  assert.equal(sent.length, 1, "the Runtime should have been asked");
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /refusal=forbidden/u);
});

test("a disabled workspace's approval attempt is reported as forbidden, not a conflict", async () => {
  const { sent, result } = await withMockedFetch(
    () =>
      Response.json(
        {
          error: {
            message:
              "A disabled workspace cannot receive a playtesting approval.",
            code: "autodev_workspace_playtesting_disabled"
          }
        },
        { status: 409 }
      ),
    () =>
      approvalRoute.POST(
        request(APPROVAL_PATH, {
          ...APPROVE_FIELDS
        }),
        params()
      )
  );

  assert.equal(sent.length, 1);
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /refusal=forbidden/u);
});

test("a stale approval is reported as a revision conflict", async () => {
  const { sent, result } = await withMockedFetch(
    () =>
      Response.json(
        {
          error: {
            message:
              "Workspace playtest approval changed; reload it before writing.",
            code: "autodev_workspace_playtesting_conflict"
          }
        },
        { status: 409 }
      ),
    () =>
      approvalRoute.POST(
        request(APPROVAL_PATH, {
          ...APPROVE_FIELDS,
          expectedRevision: "1"
        }),
        params()
      )
  );

  assert.equal(sent.length, 1);
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /refusal=conflicted/u);
});

const REVOKE_FIELDS = {
  workspaceId: WORKSPACE_ID,
  approvalId: "11111111-1111-1111-1111-111111111111",
  expectedRevision: "1",
  reason: "Build superseded; revoking before re-approving v2.",
  returnTo: RETURN_TO
} as const;

function okRevokeResponse(): Response {
  return Response.json(
    {
      schema: "autodev-control-workspace-playtest-approval-v1",
      workspaceId: WORKSPACE_ID,
      workspaceEnabled: true,
      approval: {
        schema: "autodev-workspace-playtest-approval-v1",
        workspaceId: WORKSPACE_ID,
        revision: 2,
        approvalId: "synthetic-approval-1",
        checkoutRoot: "/tmp/synthetic-game",
        buildSha: "a".repeat(40),
        gameBuild: "fixture-game-1",
        playtestConfigHash: "b".repeat(64),
        adapterImageDigest: "fixture/adapter@sha256:" + "c".repeat(64),
        workingDirectory: "server",
        adapterCommand: ["node", "adapter.mjs"],
        allowedScenarios: ["tutorial"],
        allowedPolicies: ["random"],
        limits: {
          cpuCores: 1,
          memoryBytes: 134_217_728,
          processCount: 2,
          wallTimeMs: 60_000,
          artifactBytes: 1_048_576,
          workerCount: 1,
          episodeCount: 10,
          maxStepsPerEpisode: 20,
          critiqueCount: 0
        },
        retentionDays: 30,
        issueReporting: "disabled",
        humanStudyAllowed: false,
        approvedAt: "2026-10-10T00:00:00.000Z",
        approvedBy: "synthetic-operator",
        revokedAt: "2026-10-10T01:00:00.000Z",
        revokedBy: "synthetic-operator",
        revocationReason: "synthetic usability fixture"
      }
    },
    { status: 200 }
  );
}

test("a well-formed revocation reaches the exact revoke endpoint", async () => {
  const { sent, result } = await withMockedFetch(okRevokeResponse, () =>
    revokeRoute.POST(request(REVOKE_PATH, { ...REVOKE_FIELDS }), params())
  );

  assert.equal(sent.length, 1);
  assert.match(
    sent[0]?.url ?? "",
    /\/control\/workspaces\/SimulatorLife%2FFixtureGame\/playtesting-approval\/revoke$/u
  );
  const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
  assert.deepEqual(body, {
    expectedRevision: 1,
    approvalId: REVOKE_FIELDS.approvalId,
    reason: REVOKE_FIELDS.reason
  });
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), RETURN_TO);
});

test("revocation route returns a typed JSON result for in-place Console submission", async () => {
  const { result } = await withMockedFetch(okRevokeResponse, () =>
    revokeRoute.POST(
      request(REVOKE_PATH, { ...REVOKE_FIELDS }, "application/json"),
      params()
    )
  );
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.equal(body.kind, "ok");
  assert.equal(body.data.approval.revokedAt, "2026-10-10T01:00:00.000Z");
  assert.equal(result.headers.get("location"), null);
});

test("a revoke with no reason is refused before the request", async () => {
  const { sent, result } = await withMockedFetch(okRevokeResponse, () =>
    revokeRoute.POST(
      request(REVOKE_PATH, { ...REVOKE_FIELDS, reason: "" }),
      params()
    )
  );

  assert.equal(
    sent.length,
    0,
    "a refused revocation must not reach the Runtime"
  );
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), `${RETURN_TO}?control=failed`);
});

test("a revoked approval that already changed is reported as a conflict", async () => {
  const { sent, result } = await withMockedFetch(
    () =>
      Response.json(
        {
          error: {
            message:
              "Workspace playtest approval changed; reload it before writing.",
            code: "autodev_workspace_playtesting_conflict"
          }
        },
        { status: 409 }
      ),
    () => revokeRoute.POST(request(REVOKE_PATH, { ...REVOKE_FIELDS }), params())
  );

  assert.equal(sent.length, 1);
  assert.equal(result.status, 303);
  assert.match(result.headers.get("location") ?? "", /refusal=conflicted/u);
});

test("a cross-origin submission is refused before any request is made", async () => {
  const crossOriginRequest = new NextRequest(
    `http://console.test${APPROVAL_PATH}`,
    {
      method: "POST",
      headers: {
        origin: "http://attacker.test",
        host: "console.test",
        "sec-fetch-site": "cross-site",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ ...APPROVE_FIELDS }).toString()
    }
  );
  const { sent, result } = await withMockedFetch(okApprovalResponse, () =>
    approvalRoute.POST(crossOriginRequest, params())
  );

  assert.equal(
    sent.length,
    0,
    "a cross-origin submission must never reach the Runtime"
  );
  assert.equal(result.status, 303);
  assert.equal(result.headers.get("location"), "/workspaces?control=failed");
});
