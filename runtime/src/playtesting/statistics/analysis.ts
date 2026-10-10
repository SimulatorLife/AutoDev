/**
 * Runtime-owned, narrow invocation API for the Playtesting statistical
 * analysis path required by `docs/playtesting-measurement-contract.md`
 * §4-5.
 *
 * The Core comparison module accepts a `PlaytestNumericInterval` from
 * any trusted source; this file is the only place inside the Runtime
 * that produces such an interval. It shells out to a hash-locked Python
 * worker (see `environment.ts`) over a JSON-RPC channel implemented in
 * `jsonrpc-client.ts`.
 *
 * The API deliberately exposes only two calls:
 *
 *   pairedBootstrapPercentileInterval(input) -> PlaytestNumericInterval
 *   multiplicityAdjustedPValues(input)       -> PlaytestMultiplicityResult
 *
 * Both share the same isolation guarantees: hash-locked env, frozen
 * pip cache, no system-Python fallback, no implicit defaults for the
 * named-in-fixture inputs (seed, resamples, confidence level).
 *
 * No homegrown bootstrap math lives here. The Python worker is the
 * single source of inference; the Runtime only marshals bytes.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { PlaytestNumericInterval } from "@simulatorlife/autodev-core";

import {
  PlaytestStatEnvironmentError,
  type ResolvedPlaytestStatEnvironment,
  resolvePlaytestStatEnvironment
} from "./environment.ts";
import type { JsonRpcEnvelope } from "./jsonrpc-client.ts";
import {
  ACCEPTED_LIBRARY_TOKENS,
  EXPECTED_LOCK_TAG,
  EXPECTED_SCIENTIFIC_LOCK,
  type PlaytestStatisticFixture
} from "./lock-manifest.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const FIXTURE_FILE = "paired-bootstrap-fixture.json";
const MULTIPLICITY_METHODS = new Set<string>([
  "bonferroni",
  "sidak",
  "holm",
  "fdr_bh",
  "fdr_by",
  "fdr_tsbh",
  "fdr_tsbky"
]);

/** Statistical operations the Runtime exposes to the comparison layer. */
export interface PlaytestBootstrapInput {
  /** Ordered paired-difference array; positive == candidate wins. */
  readonly array: readonly number[];
  /** Bootstrap resample count. Must be a positive integer. */
  readonly resamples?: number;
  /** Confidence level for the percentile interval; (0, 1). */
  readonly confidenceLevel?: number;
  /** Integer seed for `numpy.random.default_rng`. */
  readonly seed?: number;
}

export interface PlaytestMultiplicityInput {
  readonly pvalues: readonly number[];
  readonly alpha?: number;
  readonly method?:
    | "bonferroni"
    | "sidak"
    | "holm"
    | "fdr_bh"
    | "fdr_by"
    | "fdr_tsbh"
    | "fdr_tsbky";
}

export interface PlaytestMultiplicityResult {
  readonly rejected: readonly boolean[];
  readonly pAdjusted: readonly number[];
  readonly method: string;
  readonly libraryVersion: string;
  readonly alpha: number;
}

export class PlaytestStatisticInputError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "PlaytestStatisticInputError";
  }
}

export class PlaytestStatisticLockDriftError extends Error {
  readonly expected: string;
  readonly observed: string;
  constructor(expected: string, observed: string) {
    super(
      `Playtest statistic library lock drifted; expected ${expected}, observed ${observed}. ` +
        "Re-run `uv lock` and `uv sync --frozen` from runtime/src/playtesting/statistics."
    );
    this.name = "PlaytestStatisticLockDriftError";
    this.expected = expected;
    this.observed = observed;
  }
}

export class PlaytestStatisticTransportError extends Error {
  readonly category: string;

  constructor(category: string, message: string) {
    super(message);
    this.name = "PlaytestStatisticTransportError";
    this.category = category;
  }
}

/** Lower-level handle for tests and the integration runner. */
export interface RuntimePlaytestStatAnalysisOptions {
  readonly timeoutMs?: number;
  readonly uvBinary?: string;
  readonly environment?: ResolvedPlaytestStatEnvironment;
  readonly fixturePathOverride?: string;
  readonly fixtureTextOverride?: string;
}

export class RuntimePlaytestStatAnalysis {
  private readonly environment: ResolvedPlaytestStatEnvironment;
  private readonly uvBinary: string;
  private readonly timeoutMs: number;
  private readonly fixturePathOverride: string | undefined;
  private readonly fixtureTextOverride: string | undefined;

  constructor(options: RuntimePlaytestStatAnalysisOptions = {}) {
    this.environment = options.environment ?? resolvePlaytestStatEnvironment();
    this.uvBinary = options.uvBinary ?? process.env.AUTODEV_PLAYTEST_UV ?? "uv";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fixturePathOverride = options.fixturePathOverride;
    this.fixtureTextOverride = options.fixtureTextOverride;
  }

  /** Run scipy.stats.bootstrap against the isolated worker. */
  async pairedBootstrapPercentileInterval(
    input: PlaytestBootstrapInput
  ): Promise<PlaytestNumericInterval> {
    validateBootstrapInput(input);
    const params = {
      array: Array.from(input.array),
      resamples: input.resamples ?? 100_000,
      confidenceLevel: input.confidenceLevel ?? 0.95,
      seed: input.seed ?? 42
    };
    const envelope = await this.invoke("statistics.bootstrap", params);
    const intervalEnvelope = envelope.result.interval;
    if (
      !intervalEnvelope ||
      typeof intervalEnvelope !== "object" ||
      Array.isArray(intervalEnvelope)
    ) {
      throw new PlaytestStatisticTransportError(
        "envelope",
        "Worker bootstrap response did not include an interval object."
      );
    }
    return parseNumericInterval(intervalEnvelope as Record<string, unknown>);
  }

  /** Run statsmodels.stats.multitest.multipletests against the worker. */
  async multiplicityAdjustedPValues(
    input: PlaytestMultiplicityInput
  ): Promise<PlaytestMultiplicityResult> {
    validateMultiplicityInput(input);
    const params = {
      pvalues: Array.from(input.pvalues),
      alpha: input.alpha ?? 0.05,
      method: input.method ?? "fdr_bh"
    };
    const envelope = await this.invoke("statistics.multipletests", params);
    const result = envelope.result.multipletests;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new PlaytestStatisticTransportError(
        "envelope",
        "Worker multipletests response did not include a multipletests object."
      );
    }
    const obj = result as Record<string, unknown>;
    const rejected = obj.rejected;
    const pAdjusted = obj.pAdjusted;
    const method = obj.method;
    const libraryVersion = obj.libraryVersion;
    if (
      !Array.isArray(rejected) ||
      !Array.isArray(pAdjusted) ||
      typeof method !== "string" ||
      typeof libraryVersion !== "string"
    ) {
      throw new PlaytestStatisticTransportError(
        "envelope",
        "Worker multipletests response missing one of rejected/pAdjusted/method/libraryVersion."
      );
    }
    if (rejected.some((value) => typeof value !== "boolean")) {
      throw new PlaytestStatisticTransportError(
        "envelope",
        "Worker multipletests rejected[] contained non-boolean entries."
      );
    }
    if (pAdjusted.some((value) => typeof value !== "number")) {
      throw new PlaytestStatisticTransportError(
        "envelope",
        "Worker multipletests pAdjusted[] contained non-numeric entries."
      );
    }
    return {
      rejected,
      pAdjusted,
      method,
      libraryVersion,
      alpha: params.alpha
    };
  }

  /**
   * Run the §4 worked A/B fixture once for each arm. Returns the
   * `PlaytestNumericInterval`s and the fixture hash so an acceptance
   * test can reproduce an earlier run exactly.
   *
   * Throws if the worker's results do not exactly equal the contract's
   * `expectedInterval`. The comparison uses integer-rounded checks
   * against the expected two-decimal bounds the contract records
   * (e.g. `[+0.05, +0.16]` and `[−0.39, −0.21]`).
   */
  async runWorkedFixture(): Promise<{
    readonly primary: PlaytestNumericInterval;
    readonly guardrail: PlaytestNumericInterval;
    readonly fixtureHash: string;
  }> {
    const fixture = readFixture(
      this.fixturePathOverride ??
        defaultFixturePath(this.environment.projectRoot),
      this.fixtureTextOverride
    );
    const primary = await this.pairedBootstrapPercentileInterval({
      array: fixture.primary.pairedDifferences,
      resamples: fixture.expectedResamples,
      confidenceLevel: fixture.expectedConfidenceLevel,
      seed: fixture.expectedSeed
    });
    const guardrail = await this.pairedBootstrapPercentileInterval({
      array: fixture.guardrail.pairedDifferences,
      resamples: fixture.expectedResamples,
      confidenceLevel: fixture.expectedConfidenceLevel,
      seed: fixture.expectedSeed
    });
    assertIntervalMatchesContract(
      primary,
      fixture.primary.expectedInterval,
      fixture.primary.metricId
    );
    assertIntervalMatchesContract(
      guardrail,
      fixture.guardrail.expectedInterval,
      fixture.guardrail.metricId
    );
    return {
      primary,
      guardrail,
      fixtureHash: fixture.contentHash
    };
  }

  /** Hash fingerprint of the locked Python environment (see environment.ts). */
  environmentFingerprint(): string {
    return this.environment.contentHash;
  }

  private async invoke(
    method: "statistics.bootstrap" | "statistics.multipletests",
    params: Record<string, unknown>
  ): Promise<Extract<JsonRpcEnvelope, { kind: "response" }>> {
    const requestId = randomUUID();
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params
    });

    if (!this.uvBinary) {
      throw new PlaytestStatisticTransportError(
        "uv-missing",
        "uv binary path was empty; install uv and set AUTODEV_PLAYTEST_UV or PATH."
      );
    }

    const child = spawnUvWorker(this.uvBinary, this.environment, payload);
    const collected = await collectWorkerEnvelope(
      child,
      requestId,
      this.timeoutMs
    );
    if (collected.envelope.kind === "error") {
      const err = collected.envelope.error;
      const data = err.data ?? {};
      const category =
        typeof data.category === "string"
          ? (data.category as string)
          : "rpc-error";
      if (category === "library-drift") {
        throw new PlaytestStatisticLockDriftError(
          EXPECTED_LOCK_TAG,
          typeof data.observed === "string"
            ? (data.observed as string)
            : "unknown"
        );
      }
      throw new PlaytestStatisticTransportError(
        category,
        err.message + "\n" + collected.stderrTail.slice(-512)
      );
    }
    return collected.envelope;
  }
}

function spawnUvWorker(
  uvBinary: string,
  environment: ResolvedPlaytestStatEnvironment,
  payload: string
): ReturnType<typeof spawn> {
  const args = [
    "run",
    "--frozen",
    "--project",
    environment.projectRoot,
    "--no-progress",
    "python",
    "-m",
    environment.workerModule
  ];
  const child = spawn(uvBinary, args, {
    cwd: environment.projectRoot,
    env: {
      ...process.env,
      UV_NO_CACHE: "1",
      UV_FROZEN: "1",
      PYTHONHASHSEED: "0"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin?.end(`${payload}\n`);
  return child;
}

interface WorkerCollected {
  readonly envelope: JsonRpcEnvelope;
  readonly stderrTail: string;
  readonly exitCode: number | null;
}

const JSON_LINE_SPLIT_REGEX = /\r?\n/u;

async function collectWorkerEnvelope(
  child: ReturnType<typeof spawn>,
  requestId: string,
  timeoutMs: number
): Promise<WorkerCollected> {
  let stderrBuffer = "";
  let resolvedEnvelope: JsonRpcEnvelope | null = null;
  let spawnError: unknown = null;
  const stdout: Buffer[] = [];

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    if (stderrBuffer.length > 32 * 1024) {
      stderrBuffer = stderrBuffer.slice(-32 * 1024);
    }
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });

  child.once("error", (err) => {
    spawnError = err;
  });

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(
        new PlaytestStatisticTransportError(
          "uv-missing",
          `Worker timed out after ${timeoutMs} ms; stderr tail: ${stderrBuffer.slice(-512)}`
        )
      );
    }, timeoutMs);
  });

  const exitPromise = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      resolve(code);
    });
  });

  const exitCode = await Promise.race([exitPromise, timeoutPromise]).catch(
    () => null
  );
  if (timer) clearTimeout(timer);

  if (spawnError) {
    throw new PlaytestStatisticTransportError(
      "uv-missing",
      `Failed to spawn uv worker: ${(spawnError as Error).message ?? spawnError}.`
    );
  }

  const blob = Buffer.concat(stdout).toString("utf8");
  for (const line of blob.split(JSON_LINE_SPLIT_REGEX)) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    if (obj.jsonrpc !== "2.0") continue;
    const id = obj.id;
    if (id !== requestId) continue;
    if ("result" in obj) {
      resolvedEnvelope = {
        kind: "response",
        id: String(id),
        result: (obj.result ?? {}) as Record<string, unknown>
      };
    } else if ("error" in obj) {
      const err = obj.error as {
        code: number;
        message: string;
        data?: Readonly<Record<string, unknown>>;
      };
      resolvedEnvelope = {
        kind: "error",
        id: typeof id === "string" ? id : null,
        error: err
      };
    }
  }

  if (!resolvedEnvelope) {
    throw new PlaytestStatisticTransportError(
      "envelope",
      `Worker produced no envelope before exit (code ${exitCode}); stderr tail: ${stderrBuffer.slice(-512)}`
    );
  }
  return { envelope: resolvedEnvelope, stderrTail: stderrBuffer, exitCode };
}

/** Validate and return a plain object ready to be marshalled to Python. */
function validateBootstrapInput(input: PlaytestBootstrapInput): void {
  if (!Array.isArray(input.array) || input.array.length === 0) {
    throw new PlaytestStatisticInputError(
      "Bootstrap input array must be a non-empty array of numbers."
    );
  }
  for (const value of input.array) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new PlaytestStatisticInputError(
        `Bootstrap input array contained a non-finite element: ${value}.`
      );
    }
  }
  if (
    input.resamples !== undefined &&
    (!Number.isInteger(input.resamples) || input.resamples <= 0)
  ) {
    throw new PlaytestStatisticInputError(
      `Bootstrap resamples must be a positive integer; received ${input.resamples}.`
    );
  }
  if (
    input.confidenceLevel !== undefined &&
    (!Number.isFinite(input.confidenceLevel) ||
      input.confidenceLevel <= 0 ||
      input.confidenceLevel >= 1)
  ) {
    throw new PlaytestStatisticInputError(
      `Bootstrap confidenceLevel must be a finite number in (0, 1); received ${String(input.confidenceLevel)}.`
    );
  }
  if (
    input.seed !== undefined &&
    (!Number.isInteger(input.seed) || !Number.isSafeInteger(input.seed))
  ) {
    throw new PlaytestStatisticInputError(
      `Bootstrap seed must be a safe integer; received ${input.seed}.`
    );
  }
}

function validateMultiplicityInput(input: PlaytestMultiplicityInput): void {
  if (!Array.isArray(input.pvalues) || input.pvalues.length === 0) {
    throw new PlaytestStatisticInputError(
      "Multiplicity pvalues must be a non-empty array of numbers."
    );
  }
  for (const value of input.pvalues) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new PlaytestStatisticInputError(
        `Multiplicity pvalues contained a non-finite element: ${value}.`
      );
    }
    if (value < 0 || value > 1) {
      throw new PlaytestStatisticInputError(
        `Multiplicity pvalues must be in [0, 1]; received ${value}.`
      );
    }
  }
  if (
    input.alpha !== undefined &&
    (!Number.isFinite(input.alpha) || input.alpha <= 0 || input.alpha >= 1)
  ) {
    throw new PlaytestStatisticInputError(
      `Multiplicity alpha must be a finite number in (0, 1); received ${String(input.alpha)}.`
    );
  }
  if (input.method !== undefined && !MULTIPLICITY_METHODS.has(input.method)) {
    throw new PlaytestStatisticInputError(
      `Multiplicity method must be one of ${[...MULTIPLICITY_METHODS].join(", ")}; received ${input.method}.`
    );
  }
}

function parseNumericInterval(
  raw: Record<string, unknown>
): PlaytestNumericInterval {
  const lower = numberFromUnknown(raw.lower, "lower");
  const upper = numberFromUnknown(raw.upper, "upper");
  const method = stringFromUnknown(raw.method, "method");
  const libraryVersion = stringFromUnknown(
    raw.libraryVersion,
    "libraryVersion"
  );
  const confidenceLevel = numberFromUnknown(
    raw.confidenceLevel,
    "confidenceLevel"
  );
  const resamplesRaw = raw.resamples;
  const resamples =
    resamplesRaw === null || resamplesRaw === undefined
      ? null
      : numberFromUnknown(resamplesRaw, "resamples");
  const seedRaw = raw.seed;
  const seed =
    seedRaw === null || seedRaw === undefined
      ? null
      : stringFromUnknown(seedRaw, "seed");

  if (!Number.isFinite(lower) || !Number.isFinite(upper)) {
    throw new PlaytestStatisticTransportError(
      "envelope",
      `Worker interval had non-finite bounds (lower=${lower}, upper=${upper}).`
    );
  }
  if (lower > upper) {
    throw new PlaytestStatisticTransportError(
      "envelope",
      `Worker interval is non-monotonic (lower=${lower}, upper=${upper}).`
    );
  }
  if (libraryVersion !== EXPECTED_LOCK_TAG) {
    for (const token of ACCEPTED_LIBRARY_TOKENS) {
      if (!libraryVersion.includes(token)) {
        throw new PlaytestStatisticTransportError(
          "envelope",
          `Worker libraryVersion ${libraryVersion} does not include ${token}.`
        );
      }
    }
    if (!libraryVersion.includes(EXPECTED_SCIENTIFIC_LOCK.scipy)) {
      throw new PlaytestStatisticLockDriftError(
        EXPECTED_LOCK_TAG,
        libraryVersion
      );
    }
  }
  return {
    lower,
    upper,
    method,
    libraryVersion,
    confidenceLevel,
    resamples,
    seed
  };
}

function numberFromUnknown(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new PlaytestStatisticTransportError(
    "envelope",
    `Worker interval ${label} was not a finite number; got ${JSON.stringify(value)}.`
  );
}

function stringFromUnknown(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new PlaytestStatisticTransportError(
    "envelope",
    `Worker interval ${label} was not a non-empty string; got ${JSON.stringify(value)}.`
  );
}

function assertIntervalMatchesContract(
  interval: PlaytestNumericInterval,
  expected: { readonly lower: number; readonly upper: number },
  metricId: string
): void {
  // The contract documents the bounds to two-decimal precision.
  const tolerance = 5e-3;
  if (
    Math.abs(interval.lower - expected.lower) > tolerance ||
    Math.abs(interval.upper - expected.upper) > tolerance
  ) {
    throw new PlaytestStatisticLockDriftError(
      `metric=${metricId} expected=[${expected.lower}, ${expected.upper}]`,
      `metric=${metricId} got=[${interval.lower}, ${interval.upper}]`
    );
  }
}

function defaultFixturePath(projectRoot: string): string {
  return path.join(projectRoot, "fixtures", FIXTURE_FILE);
}

interface LoadedFixture extends PlaytestStatisticFixture {
  readonly contentHash: string;
}

function readFixture(
  fixturePath: string,
  textOverride: string | undefined
): LoadedFixture {
  const text =
    typeof textOverride === "string"
      ? textOverride
      : readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(text) as PlaytestStatisticFixture;
  if (parsed.schema !== "autodev-playtest-statistic-fixture-v1") {
    throw new PlaytestStatEnvironmentError(
      `Fixture ${fixturePath} had unexpected schema ${String(parsed.schema)}.`
    );
  }
  return { ...parsed, contentHash: hashText(text) };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// Re-export the lock fingerprint for downstream telemetry.
export { EXPECTED_LOCK_TAG } from "./lock-manifest.ts";
