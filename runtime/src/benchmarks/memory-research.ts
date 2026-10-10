import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import type {
  EvidenceReference,
  MemoryReadContext,
  MemoryRecord,
  MemoryRepository,
  MemoryResearchRequest,
  MemorySearchHit,
  MemorySearchRequest
} from "@simulatorlife/autodev-core";

import { GitWorkingTreeMemoryVerifier } from "../memory/git-curation.ts";
import {
  type MemoryCurrentStateVerifier,
  type MemoryReconstructor,
  MemoryService
} from "../memory/service.ts";

interface BenchmarkOptions {
  readonly candidates: readonly number[];
  readonly iterations: number;
  readonly reconstructionDelayMs: number;
}

interface BenchmarkSummary {
  readonly samples: number;
  readonly min_ms: number;
  readonly median_ms: number;
  readonly p95_ms: number;
  readonly max_ms: number;
}

interface BenchmarkScenario {
  readonly repositoryRoot: string;
  readonly head: string;
  readonly candidates: number;
  readonly iterations: number;
  readonly reconstructionDelayMs: number;
}

const DEFAULT_CANDIDATES = [2];
const DEFAULT_ITERATIONS = 5;
const DEFAULT_RECONSTRUCTION_DELAY_MS = 25;
const TIMESTAMP = "2026-09-30T12:00:00.000Z";

function benchmarkOptions(args: readonly string[]): BenchmarkOptions {
  const values = new Map(
    args.map((argument) => {
      const separator = argument.indexOf("=");
      if (!argument.startsWith("--") || separator === -1) {
        throw new Error(
          "Usage: pnpm run bench:memory -- --candidates=2,40 --iterations=5 --reconstruction-delay-ms=25"
        );
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    })
  );
  const candidates = (values.get("candidates") ?? DEFAULT_CANDIDATES.join(","))
    .split(",")
    .map(Number);
  const iterations = Number(values.get("iterations") ?? DEFAULT_ITERATIONS);
  const reconstructionDelayMs = Number(
    values.get("reconstruction-delay-ms") ?? DEFAULT_RECONSTRUCTION_DELAY_MS
  );
  if (
    candidates.some(
      (value) => !Number.isInteger(value) || value < 1 || value > 40
    ) ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    !Number.isFinite(reconstructionDelayMs) ||
    reconstructionDelayMs < 0
  ) {
    throw new RangeError(
      "Benchmark values are outside their supported bounds."
    );
  }
  return { candidates, iterations, reconstructionDelayMs };
}

function runGit(repositoryRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function memoryRecord(
  id: string,
  evidence: readonly EvidenceReference[]
): MemoryRecord {
  return {
    id,
    kind: "semantic",
    scope: {
      kind: "repository",
      workspaceId: "benchmark-workspace",
      repositoryId: "benchmark/repo"
    },
    claim: `Benchmark guidance ${id}.`,
    status: "active",
    provenance: {
      experienceIds: [`experience-${id}`],
      evidence,
      createdBy: "root",
      createdAt: TIMESTAMP,
      lastVerifiedAt: TIMESTAMP,
      verificationSource: "performance-benchmark"
    },
    validity: { state: "verified", checkedAt: TIMESTAMP, evidence },
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  };
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

async function benchmarkResearch({
  repositoryRoot,
  head,
  candidates,
  iterations,
  reconstructionDelayMs
}: BenchmarkScenario): Promise<Record<string, unknown>> {
  const fileEvidence: EvidenceReference = {
    kind: "file",
    uri: pathToFileURL(path.join(repositoryRoot, "src", "feature.ts")).href
  };
  const commitEvidence: EvidenceReference = {
    kind: "commit",
    uri: `git://benchmark%2Frepo/commit/${head}`,
    revision: head
  };
  const evidence: readonly EvidenceReference[] = [commitEvidence, fileEvidence];
  const memories: readonly MemoryRecord[] = Array.from(
    { length: candidates },
    (_, index) =>
      memoryRecord(`candidate-${String(index).padStart(3, "0")}`, evidence)
  );
  const repository = {
    searchMemories: (
      request: MemorySearchRequest
    ): Promise<readonly MemorySearchHit[]> =>
      Promise.resolve(
        memories
          .slice(0, request.limit ?? memories.length)
          .map((memory, index) => ({
            memory,
            score: candidates - index,
            matchedSignals: ["lexical"] as const
          }))
      )
  } as unknown as MemoryRepository;

  let activeValidations = 0;
  let peakValidations = 0;
  const validationMs: number[] = [];
  const gitVerifier = new GitWorkingTreeMemoryVerifier({
    repositories: { resolve: () => repositoryRoot }
  });
  const verifier: MemoryCurrentStateVerifier = {
    verify: async (input) => {
      const started = performance.now();
      activeValidations += 1;
      peakValidations = Math.max(peakValidations, activeValidations);
      try {
        return await gitVerifier.verify(input);
      } finally {
        activeValidations -= 1;
        validationMs.push(performance.now() - started);
      }
    }
  };

  let activeReconstructions = 0;
  let peakReconstructions = 0;
  const reconstructionMs: number[] = [];
  const reconstructor: MemoryReconstructor = {
    reconstruct: async ({ memory }) => {
      const started = performance.now();
      activeReconstructions += 1;
      peakReconstructions = Math.max(
        peakReconstructions,
        activeReconstructions
      );
      try {
        if (reconstructionDelayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, reconstructionDelayMs);
          });
        }
        return {
          disposition: "retain",
          guidance: memory.claim,
          rationale: "Deterministic synthetic benchmark result."
        };
      } finally {
        activeReconstructions -= 1;
        reconstructionMs.push(performance.now() - started);
      }
    }
  };
  const service = new MemoryService({
    repository,
    verifier,
    reconstructor,
    maxResearchCandidates: candidates,
    now: () => TIMESTAMP
  });

  const research = async (run: string | number): Promise<number> => {
    const taskId = `benchmark-task-${run}`;
    const runId = `benchmark-run-${run}`;
    const context: MemoryReadContext = {
      workspaceId: "benchmark-workspace",
      repositoryId: "benchmark/repo",
      role: "orchestrator",
      taskId,
      runId,
      canReadGlobal: false
    };
    const started = performance.now();
    const request: MemoryResearchRequest = {
      taskId,
      task: "Review the current feature behavior.",
      query: "current feature behavior",
      context,
      maxPacketCharacters: candidates === 2 ? 4000 : 24_000
    };
    const packet = await service.research(request);
    const elapsedMs = performance.now() - started;
    if (packet.entries.length !== candidates) {
      throw new Error(
        `Expected ${candidates} packet entries, received ${packet.entries.length}.`
      );
    }
    return elapsedMs;
  };

  await research("warmup");
  const totalMs: number[] = [];
  /* eslint-disable no-await-in-loop -- each sequential sample must not contend with another benchmark run */
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    totalMs.push(await research(iteration));
  }
  /* eslint-enable no-await-in-loop */
  return {
    candidates,
    iterations,
    reconstructionDelayMs,
    gitVerifier: "real local Git CLI in a temporary repository",
    reconstructor: "synthetic fixed-delay adapter (not a live provider)",
    total: summarize(totalMs),
    validationStage: summarize(
      validationMs.slice(candidates, candidates * (iterations + 1))
    ),
    reconstructionStage: summarize(
      reconstructionMs.slice(candidates, candidates * (iterations + 1))
    ),
    peakConcurrentValidations: peakValidations,
    peakConcurrentReconstructions: peakReconstructions
  };
}

const options = benchmarkOptions(
  process.argv.slice(2).filter((arg) => arg !== "--")
);
const root = await mkdtemp(
  path.join(tmpdir(), "autodev-memory-research-bench-")
);
try {
  await mkdir(path.join(root, "src"));
  await writeFile(
    path.join(root, "src", "feature.ts"),
    "export const feature = true;\n"
  );
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["config", "user.name", "AutoDev benchmark"]);
  runGit(root, ["config", "user.email", "benchmark@example.invalid"]);
  runGit(root, ["add", "src/feature.ts"]);
  runGit(root, ["commit", "-q", "-m", "Add benchmark feature"]);
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const measurements = [];
  /* eslint-disable no-await-in-loop -- candidate scenarios share one temporary repository and must be measured without contention */
  for (const candidates of options.candidates) {
    measurements.push(
      await benchmarkResearch({
        ...options,
        candidates,
        repositoryRoot: root,
        head
      })
    );
  }
  /* eslint-enable no-await-in-loop */
  process.stdout.write(
    JSON.stringify(
      {
        loadAverage: loadavg().map((value) => Number(value.toFixed(2))),
        measurements
      },
      null,
      2
    ) + "\n"
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
