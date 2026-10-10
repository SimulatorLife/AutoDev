import assert from "node:assert/strict";
import test from "node:test";

import {
  collectMetrics,
  type CollectMetricsOptions,
  type PullSummary
} from "../src/telemetry/github-metrics.ts";

test("GitHub metrics bound independent reads and preserve aggregation order", async () => {
  const repositories = ["owner/repo-a", "owner/repo-b", "owner/repo-c"];
  const workflowAgents: Readonly<Record<string, string>> = {
    "claude-invoke.yml": "claude",
    "gemini-invoke.yml": "gemini",
    "qwen-invoke.yml": "qwen",
    "minimax-invoke.yml": "mini-max",
    "minimax-codex-invoke.yml": "mini-max-codex"
  };
  let active = 0;
  let peak = 0;
  let reads = 0;
  const withRead = async <T>(result: T): Promise<T> => {
    active += 1;
    peak = Math.max(peak, active);
    reads += 1;
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return result;
    } finally {
      active -= 1;
    }
  };
  const github: CollectMetricsOptions["github"] = {
    paginate: async <T>(_method: unknown, _params: Record<string, unknown>) => {
      const repository = repositories[0];
      return (await withRead([
        {
          conclusion: "success",
          status: "completed",
          display_title: `Run for ${repository}`
        }
      ])) as T[];
    },
    rest: {
      actions: { listWorkflowRuns: {} },
      pulls: {
        list: async (params) => {
          const fullName = `${params.owner}/${params.repo}`;
          const index = repositories.indexOf(fullName);
          const createdAt = new Date(Date.now() - index * 1000).toISOString();
          const pull: PullSummary = {
            number: index + 1,
            title: `Codex: ${fullName}`,
            html_url: `https://github.com/${fullName}/pull/${index + 1}`,
            state: "open",
            created_at: createdAt,
            labels: [{ name: "codex" }],
            head: { ref: "codex/feature" }
          };
          return withRead({ data: [pull] });
        }
      }
    }
  };
  const workflowCalls: string[] = [];
  const originalPaginate = github.paginate;
  github.paginate = async <T>(
    method: unknown,
    params: Record<string, unknown>
  ) => {
    workflowCalls.push(String(params.workflow_id));
    return originalPaginate<T>(method, params);
  };

  const metrics = await collectMetrics({
    github,
    owner: "owner",
    autoDevRepo: "AutoDev",
    repositories,
    lookbackDays: 90,
    generatedAt: "2026-10-09T12:00:00.000Z"
  });

  assert.equal(peak, 4, "two workflow and two repository reads overlap");
  assert.equal(reads, 8);
  assert.deepEqual(workflowCalls, Object.keys(workflowAgents));
  assert.equal(metrics.totals.agentInvokes, 5);
  assert.equal(metrics.totals.agentInvokesSucceeded, 5);
  assert.equal(metrics.totals.agentPrsRaised, 3);
  assert.equal(metrics.perRepository[repositories[0]!]!.agentInvokes.total, 5);
  assert.deepEqual(
    metrics.recentPrs.map(({ repository }) => repository),
    repositories
  );
});

test("GitHub metric collection drains independent reads before propagating an error", async () => {
  let completedRepositoryReads = 0;
  const github: CollectMetricsOptions["github"] = {
    paginate: async () => {
      throw new Error("workflow read failed");
    },
    rest: {
      actions: { listWorkflowRuns: {} },
      pulls: {
        list: async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
          });
          completedRepositoryReads += 1;
          return { data: [] };
        }
      }
    }
  };

  await assert.rejects(
    collectMetrics({
      github,
      owner: "owner",
      autoDevRepo: "AutoDev",
      repositories: ["owner/repo-a", "owner/repo-b", "owner/repo-c"],
      lookbackDays: 90,
      generatedAt: "2026-10-09T12:00:00.000Z"
    }),
    /workflow read failed/u
  );

  assert.equal(completedRepositoryReads, 3);
});
