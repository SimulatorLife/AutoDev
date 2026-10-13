/**
 * `autodev playtest init` and `autodev playtest check`.
 *
 * Onboarding a game should cost one declarative config, not a scattered set of
 * root-level manifests plus a hand-maintained digest generator. `init` lays out
 * the standard `.autodev/` tree and writes the hash chain; `check` verifies the
 * same tree end to end before a workspace is approved.
 *
 * Scaffolding ships no invented measurement intent. An empty rubric is reported
 * as empty rather than filled with plausible defaults, because a metric registry
 * AutoDev made up would silently become the game's own stated intent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  assertPlaytestObservationContract,
  derivedBenchmarkDigests,
  observationSchemaHash,
  type PlaytestObservationContract,
  playtestFileHash,
  playtestManifestHash,
  withObservationSchemaHash
} from "@simulatorlife/autodev-core";
import { unsupportedChoice } from "./command-choice.ts";

export const PLAYTESTS_SUBCOMMANDS = ["init", "check"] as const;
export type PlaytestSubcommand = (typeof PLAYTESTS_SUBCOMMANDS)[number];

/** The canonical integration directory a repository advertises support in. */
export const PLAYTESTS_INTEGRATION_DIR = ".autodev";
export const PLAYTESTS_CONFIG_FILE = "playtest.config.json";
export const PLAYTESTS_OBSERVATION_FILE = "playtest.observation.json";
export const PLAYTESTS_RUBRIC_FILE = "playtest.rubric.json";

export type PlaytestProblemSeverity = "error" | "warning";
export type PlaytestProblemCode =
  | "missing-file"
  | "invalid-json"
  | "invalid-contract"
  | "hash-mismatch"
  | "empty-rubric"
  | "empty-observation-fields";

export interface PlaytestCheckProblem {
  readonly severity: PlaytestProblemSeverity;
  readonly code: PlaytestProblemCode;
  /** Checkout-relative, so the message names a path the operator can open. */
  readonly file: string;
  readonly message: string;
}

export interface PlaytestCheckReport {
  readonly problems: readonly PlaytestCheckProblem[];
  readonly hashes: Readonly<Record<string, string>>;
}

export interface PlaytestCommandBackend {
  init(args?: readonly string[]): number;
  check(args?: readonly string[]): number;
}



function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeErrorLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** The benchmark the config declares, resolved beside the config itself. */
function declaredBenchmarkPath(checkoutRoot: string): string | null {
  const root = integrationRoot(checkoutRoot);
  const config = readJsonFile(path.join(root, PLAYTESTS_CONFIG_FILE));
  if (!config.ok || !isPlainRecord(config.value)) return null;
  const analysis = config.value.analysis;
  if (!isPlainRecord(analysis) || typeof analysis.benchmark !== "string") {
    return null;
  }
  const declared = analysis.benchmark;
  if (declared.length === 0 || path.isAbsolute(declared)) return null;
  // The declared name is the same relative reference the config's other
  // manifests use, so it must stay inside the integration directory.
  const resolved = path.resolve(root, declared);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return existsSync(resolved) ? resolved : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integrationRoot(checkoutRoot: string): string {
  return path.join(checkoutRoot, PLAYTESTS_INTEGRATION_DIR);
}

function readJsonFile(file: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Verify one integration directory.
 *
 * Reads only; it never repairs. `init` writes, `check` reports, so a check that
 * silently fixed a digest would be indistinguishable from an integration that
 * was already correct.
 */
export function checkPlaytestIntegration(checkoutRoot: string): PlaytestCheckReport {
  const problems: PlaytestCheckProblem[] = [];
  const hashes: Record<string, string> = {};
  const root = integrationRoot(checkoutRoot);
  for (const name of [PLAYTESTS_CONFIG_FILE, PLAYTESTS_OBSERVATION_FILE, PLAYTESTS_RUBRIC_FILE]) {
    const file = path.join(root, name);
    const relative = path.posix.join(PLAYTESTS_INTEGRATION_DIR, name);
    if (!existsSync(file)) {
      problems.push({
        severity: "error",
        code: "missing-file",
        file: relative,
        message: `Run "autodev playtest init" to create ${relative}.`
      });
      continue;
    }
    const parsed = readJsonFile(file);
    if (!parsed.ok) {
      problems.push({
        severity: "error",
        code: "invalid-json",
        file: relative,
        message: `${relative} is not valid JSON: ${parsed.message}`
      });
      continue;
    }
    hashes[name] = playtestManifestHash(parsed.value);

    if (name === PLAYTESTS_OBSERVATION_FILE) {
      // The same assertion approval applies, so `check` cannot pass a contract
      // that would later be rejected, or reject one approval would accept.
      try {
        assertPlaytestObservationContract(parsed.value);
      } catch (error) {
        problems.push({
          severity: "error",
          code: "invalid-contract",
          file: relative,
          message: `${relative} does not satisfy the observation contract: ${
            error instanceof Error ? error.message : String(error)
          }`
        });
        continue;
      }
      const contract = parsed.value;
      const expected = observationSchemaHash(contract);
      if (contract.schemaHash.toLowerCase() !== expected.toLowerCase()) {
        // The game does not maintain this digest; `autodev playtest check
        // --write-hashes` regenerates it from the contract's own content.
        problems.push({
          severity: "error",
          code: "hash-mismatch",
          file: relative,
          message: `${relative} records schemaHash ${contract.schemaHash} but its content hashes to ${expected}. Run "autodev playtest check --write-hashes" to regenerate it.`
        });
      }
    }

    if (name === PLAYTESTS_RUBRIC_FILE) {
      const rubric = parsed.value as { metrics?: unknown };
      if (!Array.isArray(rubric.metrics) || rubric.metrics.length === 0) {
        // Empty is reported as empty. A generated placeholder registry would
        // read as the game's own measurement intent.
        problems.push({
          severity: "warning",
          code: "empty-rubric",
          file: relative,
          message: `${relative} declares no metrics. AutoDev does not invent them; add the game's own dimensions, or the analysis will have nothing to score.`
        });
      }
    }
  }

  // The benchmark repeats the rubric and observation digests. Nothing in the
  // repository tells a game which rubric its benchmark points at, so those three
  // fields are verified here rather than trusted.
  const digests = derivedDigests(checkoutRoot);
  const benchmarkPath = declaredBenchmarkPath(checkoutRoot);
  if (benchmarkPath && digests) {
    const relative = path.relative(checkoutRoot, benchmarkPath);
    const parsed = readJsonFile(benchmarkPath);
    if (!parsed.ok) {
      problems.push({
        severity: "error",
        code: "invalid-json",
        file: relative,
        message: `${relative} is not valid JSON: ${parsed.message}`
      });
    } else if (isPlainRecord(parsed.value)) {
      const benchmark = parsed.value;
      const expected = derivedBenchmarkDigests(digests);
      for (const [field, value] of Object.entries(expected)) {
        if (
          typeof benchmark[field] !== "string" ||
          benchmark[field]!.toLowerCase() !== value.toLowerCase()
        ) {
          problems.push({
            severity: "error",
            code: "hash-mismatch",
            file: relative,
            message: `${relative} records ${field} as ${String(benchmark[field])} but it is derived as ${value}. Run "autodev playtest check --write-hashes" to regenerate it.`
          });
        }
      }
    }
  }
  return { problems, hashes };
}

/**
 * The digests AutoDev derives for this integration: the rubric's own bytes,
 * and the benchmark's cross-references to it and to the observation contract.
 *
 * The benchmark repeats these three fields, which is exactly why a game
 * hand-maintains them: nothing in the repo told it which rubric it was pointing
 * at. They are read here and written by `--write-hashes`.
 */
function derivedDigests(checkoutRoot: string): {
  readonly rubricHash: string;
  readonly observationSchemaHash: string;
} | null {
  const root = integrationRoot(checkoutRoot);
  const rubricFile = path.join(root, PLAYTESTS_RUBRIC_FILE);
  const observationFile = path.join(root, PLAYTESTS_OBSERVATION_FILE);
  if (!existsSync(rubricFile) || !existsSync(observationFile)) return null;
  const observation = readJsonFile(observationFile);
  if (!observation.ok) return null;
  let contract: PlaytestObservationContract;
  try {
    assertPlaytestObservationContract(observation.value);
    contract = observation.value;
  } catch {
    return null;
  }
  return {
    rubricHash: playtestFileHash(readFileSync(rubricFile)),
    observationSchemaHash: contract.schemaHash
  };
}

/**
 * Regenerate every digest this command owns, from the files' own content.
 *
 * Reads the rubric's bytes rather than a re-encoding, so what is written is
 * what approval will compare against.
 */
export function writePlaytestHashes(checkoutRoot: string): PlaytestCheckReport {
  const root = integrationRoot(checkoutRoot);
  const observationFile = path.join(root, PLAYTESTS_OBSERVATION_FILE);
  const report = checkPlaytestIntegration(checkoutRoot);
  const digests = derivedDigests(checkoutRoot);

  if (digests && existsSync(observationFile)) {
    const parsed = readJsonFile(observationFile);
    if (parsed.ok) {
      try {
        assertPlaytestObservationContract(parsed.value);
        const { schemaHash: _previous, ...content } = parsed.value;
        writeFileSync(
          observationFile,
          `${JSON.stringify(withObservationSchemaHash(content), null, 2)}\n`,
          "utf8"
        );
      } catch {
        // Reported by the check below; nothing to regenerate.
      }
    }
  }

  if (digests) {
    const benchmarkPath = declaredBenchmarkPath(checkoutRoot);
    if (benchmarkPath) {
      const parsed = readJsonFile(benchmarkPath);
      if (parsed.ok && isPlainRecord(parsed.value)) {
        writeFileSync(
          benchmarkPath,
          `${JSON.stringify(
            {
              ...parsed.value,
              ...derivedBenchmarkDigests({
                rubricHash: digests.rubricHash,
                observationSchemaHash: digests.observationSchemaHash
              })
            },
            null,
            2
          )}\n`,
          "utf8"
        );
      }
    }
  }
  return checkPlaytestIntegration(checkoutRoot);
}

/**
 * Lay out the standard tree. Nothing here encodes measurement intent: the
 * rubric starts empty and says so, because a metric AutoDev invented would be
 * indistinguishable from one the game chose.
 */
export function initPlaytestIntegration(checkoutRoot: string): number {
  const root = integrationRoot(checkoutRoot);
  mkdirSync(root, { recursive: true });

  const configPath = path.join(root, PLAYTESTS_CONFIG_FILE);
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          adapter: {
            transport: "stdio-jsonl",
            command: ["./adapter", "--stdio-jsonl"]
          },
          modes: ["headless"],
          scenarios: ["default"],
          scenarioFamilies: { default: "general" },
          policies: ["random"],
          budget: {
            episodes: 10,
            maxStepsPerEpisode: 200,
            workers: 1,
            wallTimeMinutes: 10
          },
          analysis: {
            rubric: PLAYTESTS_RUBRIC_FILE,
            observationContract: PLAYTESTS_OBSERVATION_FILE,
            benchmark: null,
            critic: "playtest-analyst",
            maxReviewedSessions: 4,
            reviewSelection: {
              surveillanceSessions: 2,
              discoverySessions: 2,
              discoverySignal: null
            },
            visualCapture: "off",
            counterfactuals: "off",
            understandingProbes: "off",
            learningCohorts: "off",
            humanCalibration: "off"
          },
          reporting: { githubIssues: "disabled" }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  const observationPath = path.join(root, PLAYTESTS_OBSERVATION_FILE);
  if (!existsSync(observationPath)) {
    const contract = withObservationSchemaHash({
      schemaVersion: 1 as const,
      mode: "headless" as const,
      cohort: "default",
      visibilityMode: "structured" as const,
      // One required placeholder so the contract is well formed; the game
      // replaces it with what a player can actually observe.
      fields: [
        {
          fieldPath: "replace-with-observable-field",
          unit: null,
          displayRounding: null,
          revelationTiming: "before-action" as const,
          playerRuleRef: "replace-with-the-rule-a-player-can-see"
        }
      ],
      uiEquivalence: "unverified" as const,
      conformanceFixtureHash: null
    });
    writeFileSync(
      observationPath,
      `${JSON.stringify(contract, null, 2)}\n`,
      "utf8"
    );
  }

  const rubricPath = path.join(root, PLAYTESTS_RUBRIC_FILE);
  if (!existsSync(rubricPath)) {
    writeFileSync(
      rubricPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          // Deliberately empty. AutoDev will not guess the game's quality
          // dimensions; an invented metric would read as the game's own.
          metrics: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  writeLine(
    `initialised Playtesting integration in ${PLAYTESTS_INTEGRATION_DIR}/; run "autodev playtest check" before requesting approval`
  );
  return 0;
}

function checkoutRootFrom(args: readonly string[]): string {
  const index = args.indexOf("--checkout-root");
  if (index >= 0 && index + 1 < args.length) {
    return path.resolve(args[index + 1]!);
  }
  return process.cwd();
}

function reportCheck(checkoutRoot: string, writeHashes: boolean): number {
  const report = writeHashes
    ? writePlaytestHashes(checkoutRoot)
    : checkPlaytestIntegration(checkoutRoot);
  for (const problem of report.problems) {
    const line = `${problem.severity}: ${problem.message}`;
    if (problem.severity === "error") writeErrorLine(line);
    else writeLine(line);
  }
  const errors = report.problems.filter(
    (problem) => problem.severity === "error"
  );
  if (errors.length > 0) {
    writeErrorLine(
      `playtest check failed: ${String(errors.length)} blocking ${errors.length === 1 ? "problem" : "problems"}`
    );
    return 1;
  }
  writeLine("playtest check passed");
  return 0;
}

export const defaultPlaytestBackend: PlaytestCommandBackend = {
  init: (args = []) => initPlaytestIntegration(checkoutRootFrom(args)),
  check: (args = []) =>
    reportCheck(
      checkoutRootFrom(args),
      args.includes("--write-hashes")
    )
};

export function dispatchPlaytestCommand(
  subcommand: string,
  args: readonly string[] = [],
  backend: PlaytestCommandBackend = defaultPlaytestBackend
): number {
  if (subcommand === "init") return backend.init(args);
  if (subcommand === "check") return backend.check(args);
  throw unsupportedChoice(
    "playtest subcommand",
    subcommand,
    PLAYTESTS_SUBCOMMANDS
  );
}