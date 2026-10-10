/**
 * Direct test harness for the Playtesting statistical worker.
 *
 * These tests spawn the locked Python worker with hand-rolled JSON-RPC
 * envelopes and verify each branch of the contract:
 *
 *   statistics.bootstrap -> PlaytestNumericInterval matching the §4
 *     expected bounds within tolerance.
 *   statistics.multipletests -> corrected p-values and rejections for a
 *     small synthetic BH family.
 *   statistics.manifest -> library version, expected fixture intervals.
 *   statistics.<unknown-method> -> -32602 "invalid-input" envelope.
 *   bootstrap with non-finite values -> -32602 "invalid-input" envelope.
 *
 * The tests also pin the exact fixture expected bounds because Core
 * tests in `@simulatorlife/autodev-core` consumed the same numbers;
 * degrading these would silently invalidate the production classification
 * logic.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { resolvePlaytestStatEnvironment } from "../src/playtesting/statistics/environment.ts";
import {
  EXPECTED_LOCK_TAG,
  EXPECTED_SCIENTIFIC_LOCK
} from "../src/playtesting/statistics/lock-manifest.ts";

interface JsonRpcResponse {
  readonly id: string | null;
  readonly result?: Record<string, unknown>;
  readonly error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
}

async function callWorker(
  request: object,
  timeoutMs = 60_000
): Promise<JsonRpcResponse> {
  const env = resolvePlaytestStatEnvironment();
  const args = [
    "run",
    "--frozen",
    "--project",
    env.projectRoot,
    "--no-progress",
    "python",
    "-m",
    env.workerModule
  ];
  const child = spawn("uv", args, {
    cwd: env.projectRoot,
    env: {
      ...process.env,
      UV_NO_CACHE: "1",
      UV_FROZEN: "1",
      PYTHONHASHSEED: "0"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stdout: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  child.stdin?.end(JSON.stringify(request) + "\n");

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(
        new Error(
          `Worker timed out after ${timeoutMs} ms; stderr tail: ${stderr.slice(-512)}`
        )
      );
    }, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const blob = Buffer.concat(stdout).toString("utf8");
  for (const line of blob.split(/\r?\n/u)) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      if (parsed.jsonrpc === "2.0") {
        return JSON.parse(line) as JsonRpcResponse;
      }
    } catch {
      continue;
    }
  }
  throw new Error(
    `Worker emitted no JSON-RPC envelope; stderr tail: ${stderr.slice(-512)}`
  );
}

const PRIMARIES = Array.from({ length: 10 })
  .fill(1)
  .concat(Array.from({ length: 90 }).fill(0));
const GUARDRAILS = Array.from({ length: 30 })
  .fill(-1)
  .concat(Array.from({ length: 70 }).fill(0));

test("worker manifest returns the locked library tag and §4 fixture bounds", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.manifest",
    params: {}
  });
  assert.equal(response.id, id);
  assert.ok(response.result);
  assert.equal(response.result.libraryVersion, EXPECTED_LOCK_TAG);
  const expected = response.result.expectedFixtures as {
    completion: { lower: number; upper: number };
    clarity: { lower: number; upper: number };
  };
  assert.ok(Math.abs(expected.completion.lower - 0.05) < 0.01);
  assert.ok(Math.abs(expected.completion.upper - 0.16) < 0.01);
  assert.ok(Math.abs(expected.clarity.lower - -0.39) < 0.01);
  assert.ok(Math.abs(expected.clarity.upper - -0.21) < 0.01);
});

test("worker bootstrap returns the §4 completion primary bounds exactly", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.bootstrap",
    params: {
      array: PRIMARIES,
      resamples: 100_000,
      confidenceLevel: 0.95,
      seed: 42
    }
  });
  assert.equal(response.id, id);
  const interval = response.result!.interval as Record<string, unknown>;
  assert.equal(interval.method, "percentile-bootstrap");
  assert.equal(interval.libraryVersion, EXPECTED_LOCK_TAG);
  assert.equal(interval.confidenceLevel, 0.95);
  assert.equal(interval.resamples, 100_000);
  assert.equal(interval.seed, "42");
  const lower = interval.lower as number;
  const upper = interval.upper as number;
  assert.equal(Math.abs(lower - 0.05) < 0.005, true, `lower=${lower}`);
  assert.equal(Math.abs(upper - 0.16) < 0.005, true, `upper=${upper}`);
});

test("worker bootstrap returns the §4 clarity guardrail bounds exactly", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.bootstrap",
    params: {
      array: GUARDRAILS,
      resamples: 100_000,
      confidenceLevel: 0.95,
      seed: 42
    }
  });
  const interval = response.result!.interval as Record<string, unknown>;
  const lower = interval.lower as number;
  const upper = interval.upper as number;
  assert.equal(Math.abs(lower - -0.39) < 0.005, true, `lower=${lower}`);
  assert.equal(Math.abs(upper - -0.21) < 0.005, true, `upper=${upper}`);
});

test("worker bootstrap rejects NaN input with a stable invalid-input envelope", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.bootstrap",
    params: { array: [Number.NaN, 0, 1], seed: 42 }
  });
  assert.ok(response.error, "expected an error envelope for NaN input");
  assert.equal(response.error!.code, -32_602);
  assert.equal(response.error!.data?.category, "invalid-input");
});

test("worker bootstrap rejects non-positive resamples with a stable error envelope", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.bootstrap",
    params: { array: [1, 0, 0], resamples: 0, seed: 42 }
  });
  assert.ok(response.error, "expected an error envelope for resamples=0");
  assert.equal(response.error!.code, -32_602);
  assert.equal(response.error!.data?.category, "invalid-input");
});

test("worker bootstrap rejects confidenceLevel outside (0,1)", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.bootstrap",
    params: { array: [1, 0], confidenceLevel: 1, seed: 42 }
  });
  assert.ok(response.error);
  assert.equal(response.error!.code, -32_602);
});

test("worker multipletests applies Benjamini-Hochberg FDR", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.multipletests",
    params: {
      pvalues: [0.001, 0.01, 0.04, 0.5],
      alpha: 0.05,
      method: "fdr_bh"
    }
  });
  const result = response.result!.multipletests as Record<string, unknown>;
  assert.equal(result.method, "fdr_bh");
  // BH adjusts each p to p*(n/rank) bounded to [0,1]; for the
  // ordered set [0.001, 0.01, 0.04, 0.5] at alpha=0.05 the critical
  // values are 0.05*rank/4 = 0.0125, 0.025, 0.0375, 0.05. Only the
  // first two ranks cross the threshold; index 2 (p=0.04) exceeds its
  // BH critical (0.0375) and is therefore not rejected.
  assert.deepEqual(result.rejected, [true, true, false, false]);
  // Adjusted p-values must match BH's expected sequence.
  const pAdj = result.pAdjusted as number[];
  assert.equal(pAdj.length, 4);
  assert.ok(Math.abs(pAdj[0]! - 0.004) < 1e-9);
  assert.ok(Math.abs(pAdj[1]! - 0.02) < 1e-9);
  assert.ok(Math.abs(pAdj[2]! - 0.053_333_333_333) < 1e-3);
  assert.ok(Math.abs(pAdj[3]! - 0.5) < 1e-9);
});

test("worker multipletests rejects unsupported method names", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.multipletests",
    params: { pvalues: [0.01, 0.5], method: "unsupported-method" }
  });
  assert.ok(response.error);
  assert.equal(response.error!.code, -32_602);
  assert.equal(response.error!.data?.category, "invalid-input");
});

test("worker rejects unknown method names as invalid-input", async () => {
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.not-a-real-method",
    params: {}
  });
  assert.ok(response.error);
  assert.equal(response.error!.code, -32_602);
});

test("worker emits manifest libraryVersion derived from resolved packages, not declared pins", async () => {
  // Confirms the runtime check is on the *resolved* versions: if a
  // future change drops and rebinds a transitive dependency, the worker
  // reports whatever scikit / statsmodels / numpy uv actually installed.
  const id = randomUUID();
  const response = await callWorker({
    jsonrpc: "2.0",
    id,
    method: "statistics.manifest",
    params: {}
  });
  const tag = response.result!.libraryVersion as string;
  assert.ok(tag.includes(`scipy-${EXPECTED_SCIENTIFIC_LOCK.scipy}`));
  assert.ok(tag.includes(`numpy-${EXPECTED_SCIENTIFIC_LOCK.numpy}`));
  assert.ok(
    tag.includes(`statsmodels-${EXPECTED_SCIENTIFIC_LOCK.statsmodels}`)
  );
});
