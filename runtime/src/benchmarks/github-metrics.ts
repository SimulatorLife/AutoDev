import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";

import {
  collectMetrics,
  type CollectMetricsOptions,
  type PullSummary
} from "../telemetry/github-metrics.ts";

interface BenchmarkOptions {
  readonly iterations: number;
  readonly delayMs: number;
}

interface BenchmarkSummary {
  readonly samples: number;
  readonly min_ms: number;
  readonly median_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
}

const REPOSITORIES = ["owner/repo-a", "owner/repo-b", "owner/repo-c"];
const DEFAULT_ITERATIONS = 7;
const DEFAULT_DELAY_MS = 25;

function parseOptions(args: readonly string[]): BenchmarkOptions {
  const values = new Map(
    args.map((argument) => {
      const separator = argument.indexOf("=");
      if (!argument.startsWith("--") || separator === -1) {
        throw new Error(
          "Usage: pnpm run bench:github-metrics -- --iterations=7 --delay-ms=25"
        );
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    })
  );
  const iterations = Number(values.get("iterations") ?? DEFAULT_ITERATIONS);
  const delayMs = Number(values.get("delay-ms") ?? DEFAULT_DELAY_MS);
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    !Number.isFinite(delayMs) ||
    delayMs < 0
  ) {
    throw new RangeError(
      "Benchmark values are outside their supported bounds."
    );
  }
  return { iterations, delayMs };
}

function summarize(values: readonly number[]): BenchmarkSummary {
  const sorted = [...values].sort((left, right) => left - right);
  const minimum = sorted[0];
  const maximum = sorted.at(-1);
  if (minimum === undefined || maximum === undefined) {
    throw new Error("A performance summary requires at least one sample.");
  }
  const percentile = (quantile: number): number =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)
    ]!;
  return {
    samples: sorted.length,
    min_ms: Number(minimum.toFixed(2)),
    median_ms: Number(percentile(0.5).toFixed(2)),
    p95_ms: Number(percentile(0.95).toFixed(2)),
    max_ms: Number(maximum.toFixed(2))
  };
}

function createFakeGitHub(delayMs: number): {
  readonly github: CollectMetricsOptions["github"];
  readonly counts: { calls: number; active: number; peakConcurrent: number };
} {
  const counts = { calls: 0, active: 0, peakConcurrent: 0 };
  const withRead = async <T>(result: T): Promise<T> => {
    counts.calls += 1;
    counts.active += 1;
    counts.peakConcurrent = Math.max(counts.peakConcurrent, counts.active);
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
      return result;
    } finally {
      counts.active -= 1;
    }
  };
  const github: CollectMetricsOptions["github"] = {
    paginate: async <T>(_method: unknown, _params: Record<string, unknown>) =>
      (await withRead([
        {
          conclusion: "success",
          status: "completed",
          display_title: `Run for ${REPOSITORIES[0]}`
        }
      ])) as T[],
    rest: {
      actions: { listWorkflowRuns: {} },
      pulls: {
        list: (params) => {
          const fullName = `${params.owner}/${params.repo}`;
          const index = REPOSITORIES.indexOf(fullName);
          const createdAt = new Date(Date.now() - index * 1000).toISOString();
          const pull: PullSummary = {
            number: index + 1,
            title: `Codex: ${fullName}`,
            html_url: `https://github.com/${fullName}/pull/${index + 1}`,
            state: "open",
            created_at: createdAt,
            labels: [{ name: "codex" }],
            head: { ref: "codex/benchmark" }
          };
          return withRead({ data: [pull] });
        }
      }
    }
  };
  return { github, counts };
}

async function main(): Promise<void> {
  const { iterations, delayMs } = parseOptions(
    process.argv.slice(2).filter((argument) => argument !== "--")
  );
  const { github, counts } = createFakeGitHub(delayMs);
  const collect = () =>
    collectMetrics({
      github,
      owner: "owner",
      autoDevRepo: "AutoDev",
      repositories: REPOSITORIES,
      lookbackDays: 90,
      generatedAt: "2026-10-09T12:00:00.000Z"
    });
  const validateResult = (
    metrics: Awaited<ReturnType<typeof collect>>
  ): void => {
    if (
      metrics.totals.agentInvokes !== 5 ||
      metrics.totals.agentInvokesSucceeded !== 5 ||
      metrics.totals.agentPrsRaised !== REPOSITORIES.length ||
      metrics.recentPrs.map(({ repository }) => repository).join(",") !==
        REPOSITORIES.join(",")
    ) {
      throw new Error("Metrics totals or repository order changed.");
    }
  };

  validateResult(await collect());
  const samples: number[] = [];
  /* eslint-disable no-await-in-loop -- benchmark samples must run without competing with one another */
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    validateResult(await collect());
    samples.push(performance.now() - started);
  }
  /* eslint-enable no-await-in-loop */
  const expectedReads = (iterations + 1) * (5 + REPOSITORIES.length);
  if (counts.calls !== expectedReads || counts.active !== 0) {
    throw new Error(
      "The fake GitHub read count or completion invariant changed."
    );
  }
  process.stdout.write(
    JSON.stringify(
      {
        iterations,
        fakeReadDelayMs: delayMs,
        readsPerIteration: 5 + REPOSITORIES.length,
        fakeReads: counts.calls,
        peakConcurrentReads: counts.peakConcurrent,
        resultInvariant: "totals and repository order preserved",
        total: summarize(samples),
        loadAverage: loadavg().map((value) => Number(value.toFixed(2)))
      },
      null,
      2
    ) + "\n"
  );
}

await main();
