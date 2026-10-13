/**
 * `playtest.triageFindings`, driven through the real MCP server.
 *
 * Triage was a Core policy with no executor: §9's ordering existed, was tested
 * in Core, and nothing in Runtime or Console ever ran it over the findings the
 * system actually stores. This crosses the MCP boundary with a findings
 * repository so the ranked output and its explanations are the real handler's.
 *
 * The repository is the only substituted seam.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPlaytestFindingIdentity,
  type PlaytestFinding
} from "@simulatorlife/autodev-core";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  createPlaytestMcpServer,
  createPlaytestRunControl,
  type PlaytestingRepositoryOps,
  type PlaytestMcpSession
} from "../src/playtesting/mcp.ts";

const WORKSPACE_ID = "owner/triage-fixture";

function finding(
  overrides: Partial<PlaytestFinding> & { findingId: string }
): PlaytestFinding {
  return {
    identity: buildPlaytestFindingIdentity({
      workspaceId: WORKSPACE_ID,
      mechanicKey: "action-execution",
      failureSignature: {
        events: ["action.rejected"],
        witness: overrides.findingId
      },
      scope: { scenarioFamily: "onboarding" }
    }),
    fingerprint: "a".repeat(64),
    version: 1,
    title: overrides.findingId,
    description: "A freshly advertised action was refused by the engine.",
    severity: "major",
    status: "open",
    verificationStage: "not-yet-validated",
    evidenceStatus: "verified",
    affectedEpisodes: 5,
    totalEligibleEpisodes: 100,
    affectedOpportunities: null,
    totalEligibleOpportunities: null,
    affectedCohorts: ["novice"],
    evidenceRefs: [{ kind: "episode", id: "episode-17", step: 23 }],
    experimentIds: [],
    issueRefs: [],
    lastVerifiedBuild: null,
    nextReviewAt: null,
    ...overrides,
    findingId: overrides.findingId
  };
}

interface RankedRow {
  rank: number;
  finding: PlaytestFinding;
  effectiveSeverity: string;
  priorityScoreKey: string;
  explanation: string;
  override: { author: string; reason: string } | null;
}

interface Harness {
  readonly call: (args: unknown) => Promise<Record<string, unknown>>;
  /** Refusals arrive as `isError` payloads rather than thrown errors. */
  readonly callExpectingRefusal: (args: unknown) => Promise<string>;
  readonly cleanup: () => void;
}

async function harness(
  rows: readonly PlaytestFinding[],
  role: PlaytestMcpSession["role"] = "operator"
): Promise<Harness> {
  const tmpRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "playtest-triage-run-"))
  );
  const artifactsDir = path.join(tmpRoot, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifacts = new PlaytestArtifactStore({
    workspaceId: WORKSPACE_ID,
    rootDirectory: artifactsDir
  });
  const repository = {
    async listFindings() {
      return { rows: [...rows], total: rows.length, nextCursor: null };
    }
  } as unknown as PlaytestingRepositoryOps;

  const playtestRunControl = createPlaytestRunControl({
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: repository,
    readWorkspaceCatalog: () => ({
      status: "valid",
      workspaces: [
        {
          id: WORKSPACE_ID,
          baseBranch: "main",
          enabled: true,
          agentRoles: null
        }
      ]
    })
  });
  // Findings are readable by root, orchestrator, validator and operator --
  // deliberately not the reviewer role, matching playtest.findings.
  const session: PlaytestMcpSession = {
    workspaceId: WORKSPACE_ID,
    role,
    actor: `${role}-1`
  };
  const server = createPlaytestMcpServer({
    sessionProvider: { current: () => session },
    artifactStoreForWorkspace: () => artifacts,
    playtestRepository: repository,
    playtestRunControl
  });

  const invoke = async (args: unknown) => {
    const tools = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
    return (await tools["playtest.triageFindings"]!.handler(args)) as {
      isError?: boolean;
      content: { type: string; text?: string }[];
    };
  };

  return {
    call: async (args: unknown) => {
      const result = await invoke(args);
      assert.equal(result.isError, undefined, "triage must not error");
      const text = result.content.find((part) => part.text)?.text ?? "{}";
      return JSON.parse(text) as Record<string, unknown>;
    },
    callExpectingRefusal: async (args: unknown) => {
      const result = await invoke(args);
      assert.equal(
        result.isError,
        true,
        "a refusal must arrive as an error rather than as an empty result"
      );
      return result.content.find((part) => part.text)?.text ?? "";
    },
    cleanup: () => rmSync(tmpRoot, { recursive: true, force: true })
  };
}

test("findings are ranked by the contract's order and say why", async () => {
  const api = await harness([
    finding({
      findingId: "finding-minor-friction",
      severity: "minor",
      title: "Minor friction"
    }),
    finding({
      findingId: "finding-catastrophic",
      severity: "catastrophic",
      title: "Catastrophic harm"
    }),
    finding({
      findingId: "finding-major",
      severity: "major",
      title: "Major progress harm"
    })
  ]);
  try {
    const result = await api.call({ workspaceId: WORKSPACE_ID });
    const ranked = result.ranked as RankedRow[];

    assert.equal(result.persisted, false);
    assert.equal(result.rankedFindings, 3);
    assert.equal(result.examinedFindings, 3);
    assert.deepEqual(result.overridesNotInPage, []);
    // Explicit about the window: a truncated page must not read as the full
    // set of findings worth working on.
    assert.equal(result.nextCursor, null);

    assert.deepEqual(
      ranked.map((row) => row.finding.findingId),
      ["finding-catastrophic", "finding-major", "finding-minor-friction"]
    );
    assert.deepEqual(
      ranked.map((row) => row.rank),
      [1, 2, 3]
    );
    for (const row of ranked) {
      assert.ok(row.explanation.length > 0, "every row explains itself");
      assert.ok(row.priorityScoreKey.length > 0);
    }
    assert.match(ranked[0]!.explanation, /^CATASTROPHIC: Catastrophic harm/u);
    assert.match(ranked[0]!.explanation, /Exposure rate: 5%/u);
  } finally {
    api.cleanup();
  }
});

test("an unmeasured exposure survives the boundary as unmeasured", async () => {
  // The defect this guards: exposure was reported as 0, which reads as "rarely
  // exposed" and produced a fabricated worst-case priority score.
  const api = await harness([
    finding({
      findingId: "finding-unmeasured",
      affectedEpisodes: null,
      totalEligibleEpisodes: null,
      affectedOpportunities: null,
      totalEligibleOpportunities: null,
      affectedCohorts: []
    })
  ]);
  try {
    const result = await api.call({ workspaceId: WORKSPACE_ID });
    const row = (result.ranked as RankedRow[])[0]!;
    assert.match(row.priorityScoreKey, /_unmeasured$/u);
    assert.doesNotMatch(row.priorityScoreKey, /_1\.0000$/u);
    assert.match(row.explanation, /Exposure rate: not measured/u);
  } finally {
    api.cleanup();
  }
});

test("an operator override is applied, attributed, and never persisted", async () => {
  const api = await harness([
    finding({ findingId: "finding-major", severity: "major" }),
    finding({ findingId: "finding-minor", severity: "minor" })
  ]);
  try {
    const result = await api.call({
      workspaceId: WORKSPACE_ID,
      overrides: [
        {
          findingId: "finding-minor",
          author: "operator@example.com",
          reason: "blocks the tutorial on first run for every cohort",
          forcedSeverity: "catastrophic"
        }
      ]
    });
    const ranked = result.ranked as RankedRow[];

    // The override outranks the finding it was applied to.
    assert.equal(ranked[0]?.finding.findingId, "finding-minor");
    assert.equal(ranked[0]?.effectiveSeverity, "catastrophic");
    assert.equal(ranked[0]?.override?.author, "operator@example.com");
    assert.match(
      ranked[0]!.explanation,
      /Operator override by operator@example\.com/u
    );
    // Ranking is a reading; the tool records nothing.
    assert.equal(result.persisted, false);
  } finally {
    api.cleanup();
  }
});

test("an override naming a finding outside the page is reported, not ignored", async () => {
  const api = await harness([finding({ findingId: "finding-present" })]);
  try {
    const result = await api.call({
      workspaceId: WORKSPACE_ID,
      overrides: [
        {
          findingId: "finding-that-does-not-exist",
          author: "operator@example.com",
          reason: "typo in the id",
          forcedSeverity: "minor"
        }
      ]
    });
    // An inert override is a mistake worth surfacing; failing the call would
    // hide a real ranking, and applying it silently would be a lie.
    assert.deepEqual(result.overridesNotInPage, [
      "finding-that-does-not-exist"
    ]);
    assert.equal((result.ranked as RankedRow[]).length, 1);
  } finally {
    api.cleanup();
  }
});

test("triage refuses a cross-workspace read from a role that may not cross", async () => {
  // Root, orchestrator and operator may read across workspaces by design.
  // `validator` is in the findings reader set but not the cross-workspace
  // allowlist, so it is the role whose refusal this assertion is about.
  const api = await harness(
    [finding({ findingId: "finding-present" })],
    "validator"
  );
  try {
    const text = await api.callExpectingRefusal({
      workspaceId: "other/workspace"
    });
    // The message is redacted by the shared error layer, so assert the
    // machine-readable code rather than prose.
    const payload = JSON.parse(text) as { error: { category: string } };
    assert.equal(payload.error.category, "authorization");
  } finally {
    api.cleanup();
  }
});

test("triage refuses a role that may not read findings at all", async () => {
  // The reviewer role is excluded from FINDING_READER_ROLES, so the refusal
  // happens before any repository read.
  const api = await harness(
    [finding({ findingId: "finding-present" })],
    "playtest-analyst"
  );
  try {
    const text = await api.callExpectingRefusal({ workspaceId: WORKSPACE_ID });
    const payload = JSON.parse(text) as { error: { category: string } };
    assert.equal(payload.error.category, "authorization");
  } finally {
    api.cleanup();
  }
});
