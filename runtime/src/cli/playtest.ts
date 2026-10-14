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
  expandPlaytestRegistry,
  type PlaytestAdapterBinding,
  type PlaytestJsonSchema,
  type PlaytestObservationContract,
  PLAYTESTS_GENERIC_ADAPTER_COMMAND,
  PLAYTESTS_INTEGRATION_DIR,
  PLAYTESTS_REQUIRED_BINDINGS,
  resolvePlaytestAdapterBinding,
  unboundPlaytestMethods,
  usesGenericPlaytestAdapter
} from "@simulatorlife/autodev-core";

import {
  derivedBenchmarkDigests,
  observationSchemaHash,
  playtestBenchmarkContentHash,
  playtestFileHash,
  playtestManifestHash,
  withObservationSchemaHash
} from "../playtesting/hash-chain.ts";
import { PLAYTESTS_BUILTIN_POLICY_IDS } from "../playtesting/policies.ts";
import { unsupportedChoice } from "./command-choice.ts";
import {
  formatConformanceReport,
  runPlaytestConformance
} from "./playtest-conformance.ts";
import {
  PLAYTESTS_SCAFFOLD_BODY_COUNT,
  scaffoldAdapterModule,
  scaffoldBinding
} from "./playtest-scaffold.ts";

export const PLAYTESTS_SUBCOMMANDS = ["init", "check", "conformance"] as const;
export type PlaytestSubcommand = (typeof PLAYTESTS_SUBCOMMANDS)[number];

export const PLAYTESTS_CONFIG_FILE = "playtest.config.json";
export const PLAYTESTS_OBSERVATION_FILE = "playtest.observation.json";
export const PLAYTESTS_RUBRIC_FILE = "playtest.rubric.json";
export const PLAYTESTS_BINDING_FILE = "playtest.binding.json";
const SCAFFOLD_FACTORY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const SCAFFOLD_ADAPTER_SCHEMAS: PlaytestAdapterBinding["schemas"] = {
  observation: { type: "object", properties: {} },
  action: { type: "object", properties: {} },
  event: { type: "object", properties: {} }
};

export type PlaytestProblemSeverity = "error" | "warning";
export type PlaytestProblemCode =
  | "missing-file"
  | "invalid-json"
  | "invalid-contract"
  | "invalid-rubric"
  | "hash-mismatch"
  | "empty-rubric"
  | "empty-observation-fields"
  | "invalid-binding"
  | "incomplete-binding"
  | "unknown-policy";

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
  /**
   * Async because the episode is real: it loads the game's entry module and
   * speaks the protocol to it, so it cannot be answered synchronously.
   */
  conformance(args?: readonly string[]): number | Promise<number>;
}

function writeLine(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeErrorLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** The adapter command the config declares, or null when it declares none. */
function configAdapterCommand(checkoutRoot: string): readonly string[] | null {
  const config = readJsonFile(
    path.join(integrationRoot(checkoutRoot), PLAYTESTS_CONFIG_FILE)
  );
  if (!config.ok || !isPlainRecord(config.value)) return null;
  const adapter = config.value.adapter;
  if (!isPlainRecord(adapter) || !Array.isArray(adapter.command)) return null;
  return adapter.command.every((entry) => typeof entry === "string")
    ? (adapter.command as string[])
    : null;
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

function readJsonFile(
  file: string
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
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
const REQUIRED_PLAYTEST_FILES = [
  PLAYTESTS_CONFIG_FILE,
  PLAYTESTS_OBSERVATION_FILE,
  PLAYTESTS_RUBRIC_FILE
] as const;

type RequiredPlaytestFile = (typeof REQUIRED_PLAYTEST_FILES)[number];

/**
 * Verify one integration directory.
 *
 * Reads only; it never repairs. init writes, check reports, so a check that
 * silently fixed a digest would be indistinguishable from an integration that
 * was already correct.
 */
export function checkPlaytestIntegration(
  checkoutRoot: string
): PlaytestCheckReport {
  const problems: PlaytestCheckProblem[] = [];
  const hashes: Record<string, string> = {};
  const files = readRequiredPlaytestFiles(checkoutRoot, problems, hashes);
  const binding = checkAdapterBinding(checkoutRoot, problems);

  checkObservationContract(
    files.get(PLAYTESTS_OBSERVATION_FILE),
    binding,
    problems
  );
  checkMetricRegistry(files.get(PLAYTESTS_RUBRIC_FILE), problems);
  checkBenchmarkDigests(checkoutRoot, problems);
  checkDeclaredPolicies(checkoutRoot, problems);

  return { problems, hashes };
}

function readRequiredPlaytestFiles(
  checkoutRoot: string,
  problems: PlaytestCheckProblem[],
  hashes: Record<string, string>
): ReadonlyMap<RequiredPlaytestFile, unknown> {
  const root = integrationRoot(checkoutRoot);
  const files = new Map<RequiredPlaytestFile, unknown>();
  for (const name of REQUIRED_PLAYTEST_FILES) {
    const file = path.join(root, name);
    const relative = path.posix.join(PLAYTESTS_INTEGRATION_DIR, name);
    if (!existsSync(file)) {
      problems.push({
        severity: "error",
        code: "missing-file",
        file: relative,
        message: 'Run "autodev playtest init" to create ' + relative + "."
      });
      continue;
    }
    const parsed = readJsonFile(file);
    if (!parsed.ok) {
      problems.push({
        severity: "error",
        code: "invalid-json",
        file: relative,
        message: relative + " is not valid JSON: " + parsed.message
      });
      continue;
    }
    hashes[name] = playtestManifestHash(parsed.value);
    files.set(name, parsed.value);
  }
  return files;
}

function checkObservationContract(
  value: unknown,
  binding: PlaytestAdapterBinding | null,
  problems: PlaytestCheckProblem[]
): void {
  if (value === undefined) return;
  const relative = path.posix.join(
    PLAYTESTS_INTEGRATION_DIR,
    PLAYTESTS_OBSERVATION_FILE
  );
  let contract: PlaytestObservationContract;
  try {
    assertPlaytestObservationContract(value);
    contract = value;
  } catch (error) {
    problems.push({
      severity: "error",
      code: "invalid-contract",
      file: relative,
      message:
        relative +
        " does not satisfy the observation contract: " +
        (error instanceof Error ? error.message : String(error))
    });
    return;
  }
  if (binding === null) return;
  const expected = observationSchemaHash(
    binding.schemas.observation as PlaytestJsonSchema
  );
  if (contract.schemaHash.toLowerCase() !== expected.toLowerCase()) {
    problems.push({
      severity: "error",
      code: "hash-mismatch",
      file: relative,
      message:
        relative +
        " records schemaHash " +
        contract.schemaHash +
        " but the adapter binding's observation schema hashes to " +
        expected +
        '. Run "autodev playtest check --write-hashes" to regenerate it.'
    });
  }
}

function checkMetricRegistry(
  value: unknown,
  problems: PlaytestCheckProblem[]
): void {
  const relative = path.posix.join(
    PLAYTESTS_INTEGRATION_DIR,
    PLAYTESTS_RUBRIC_FILE
  );
  if (
    !isPlainRecord(value) ||
    value.schemaVersion !== 2 ||
    !Array.isArray(value.metricDefinitions)
  ) {
    problems.push({
      severity: "error",
      code: "invalid-rubric",
      file: relative,
      message:
        relative +
        " must be a v2 metric registry with a metricDefinitions array."
    });
    return;
  }
  if (value.metricDefinitions.length === 0 && Object.keys(value).length === 2) {
    problems.push({
      severity: "warning",
      code: "empty-rubric",
      file: relative,
      message:
        relative +
        " declares no metrics. AutoDev does not invent them; add the game's own dimensions, or the analysis will have nothing to score."
    });
    return;
  }
  try {
    expandPlaytestRegistry(value);
  } catch (error) {
    problems.push({
      severity: "error",
      code: "invalid-rubric",
      file: relative,
      message:
        relative +
        " is not a valid v2 metric registry: " +
        (error instanceof Error ? error.message : String(error))
    });
  }
}

function checkAdapterBinding(
  checkoutRoot: string,
  problems: PlaytestCheckProblem[]
): PlaytestAdapterBinding | null {
  const bindingFile = path.join(
    integrationRoot(checkoutRoot),
    PLAYTESTS_BINDING_FILE
  );
  const relative = path.posix.join(
    PLAYTESTS_INTEGRATION_DIR,
    PLAYTESTS_BINDING_FILE
  );
  if (!existsSync(bindingFile)) {
    problems.push({
      severity: "error",
      code: "missing-file",
      file: relative,
      message:
        'No adapter binding is declared. Run "autodev playtest init" and bind the game-owned methods; game-written protocol adapters are not supported.'
    });
    return null;
  }
  const parsed = readJsonFile(bindingFile);
  if (!parsed.ok) {
    problems.push({
      severity: "error",
      code: "invalid-json",
      file: relative,
      message: relative + " is not valid JSON: " + parsed.message
    });
    return null;
  }
  const resolution = resolvePlaytestAdapterBinding(parsed.value);
  if (resolution.kind === "rejected") {
    problems.push({
      severity: "error",
      code: "invalid-binding",
      file: relative,
      message:
        relative + " is not a usable adapter binding: " + resolution.message
    });
    return null;
  }

  const binding = parsed.value as PlaytestAdapterBinding;
  const command = configAdapterCommand(checkoutRoot);
  if (command !== null && !usesGenericPlaytestAdapter(command)) {
    problems.push({
      severity: "error",
      code: "invalid-binding",
      file: relative,
      message:
        "An adapter binding must use AutoDev's generic adapter command; game-written protocol adapters are not supported."
    });
  }

  const optional = unboundPlaytestMethods(binding).filter(
    (method) => !PLAYTESTS_REQUIRED_BINDINGS.includes(method)
  );
  if (optional.length > 0) {
    problems.push({
      severity: "warning",
      code: "incomplete-binding",
      file: relative,
      message:
        relative +
        " does not bind " +
        optional.join(", ") +
        "; those protocol methods are unavailable for this game."
    });
  }
  return binding;
}

function checkBenchmarkDigests(
  checkoutRoot: string,
  problems: PlaytestCheckProblem[]
): void {
  const digests = derivedDigests(checkoutRoot);
  const benchmarkPath = declaredBenchmarkPath(checkoutRoot);
  if (benchmarkPath === null || digests === null) return;
  const relative = path.relative(checkoutRoot, benchmarkPath);
  const parsed = readJsonFile(benchmarkPath);
  if (!parsed.ok) {
    problems.push({
      severity: "error",
      code: "invalid-json",
      file: relative,
      message: relative + " is not valid JSON: " + parsed.message
    });
    return;
  }
  if (!isPlainRecord(parsed.value)) return;

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
        message:
          relative +
          " records " +
          field +
          " as " +
          String(benchmark[field]) +
          " but it is derived as " +
          value +
          '. Run "autodev playtest check --write-hashes" to regenerate it.'
      });
    }
  }
  const expectedContentHash = playtestBenchmarkContentHash(benchmark as never);
  if (
    typeof benchmark.contentHash !== "string" ||
    benchmark.contentHash.toLowerCase() !== expectedContentHash.toLowerCase()
  ) {
    problems.push({
      severity: "error",
      code: "hash-mismatch",
      file: relative,
      message:
        relative +
        " records contentHash as " +
        String(benchmark.contentHash) +
        " but its content hashes to " +
        expectedContentHash +
        '. Run "autodev playtest check --write-hashes" to regenerate it.'
    });
  }
}

function checkDeclaredPolicies(
  checkoutRoot: string,
  problems: PlaytestCheckProblem[]
): void {
  const configFile = path.posix.join(
    PLAYTESTS_INTEGRATION_DIR,
    PLAYTESTS_CONFIG_FILE
  );
  for (const policyId of configPolicies(checkoutRoot)) {
    if (PLAYTESTS_BUILTIN_POLICY_IDS.has(policyId)) continue;
    problems.push({
      severity: "error",
      code: "unknown-policy",
      file: configFile,
      message:
        configFile +
        ' declares policy "' +
        policyId +
        '", which AutoDev cannot run. Supported policies: ' +
        [...PLAYTESTS_BUILTIN_POLICY_IDS].join(", ") +
        "."
    });
  }
}

/** The policies the checked-in config declares, or none when it declares none. */
function configPolicies(checkoutRoot: string): readonly string[] {
  const config = readJsonFile(
    path.join(integrationRoot(checkoutRoot), PLAYTESTS_CONFIG_FILE)
  );
  if (!config.ok || !isPlainRecord(config.value)) return [];
  const { policies } = config.value;
  return Array.isArray(policies) &&
    policies.every((entry) => typeof entry === "string")
    ? (policies as string[])
    : [];
}

function readAdapterBinding(
  checkoutRoot: string
): PlaytestAdapterBinding | null {
  const parsed = readJsonFile(
    path.join(integrationRoot(checkoutRoot), PLAYTESTS_BINDING_FILE)
  );
  if (!parsed.ok) return null;
  const resolution = resolvePlaytestAdapterBinding(parsed.value);
  return resolution.kind === "resolved"
    ? (parsed.value as PlaytestAdapterBinding)
    : null;
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
  readonly actionSchemaHash: string;
  readonly eventSchemaHash: string;
} | null {
  const root = integrationRoot(checkoutRoot);
  const rubricFile = path.join(root, PLAYTESTS_RUBRIC_FILE);
  const observationFile = path.join(root, PLAYTESTS_OBSERVATION_FILE);
  const binding = readAdapterBinding(checkoutRoot);
  if (!existsSync(rubricFile) || !existsSync(observationFile) || !binding) {
    return null;
  }
  const observation = readJsonFile(observationFile);
  if (!observation.ok) return null;
  try {
    assertPlaytestObservationContract(observation.value);
  } catch {
    return null;
  }
  return {
    rubricHash: playtestFileHash(readFileSync(rubricFile)),
    observationSchemaHash: observationSchemaHash(
      binding.schemas.observation as PlaytestJsonSchema
    ),
    actionSchemaHash: playtestManifestHash(binding.schemas.action),
    eventSchemaHash: playtestManifestHash(binding.schemas.event)
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
  const digests = derivedDigests(checkoutRoot);

  if (digests && existsSync(observationFile)) {
    const parsed = readJsonFile(observationFile);
    const binding = readAdapterBinding(checkoutRoot);
    if (parsed.ok && binding) {
      try {
        assertPlaytestObservationContract(parsed.value);
        const { schemaHash: _previous, ...content } = parsed.value;
        writeFileSync(
          observationFile,
          `${JSON.stringify(
            withObservationSchemaHash(
              content,
              binding.schemas.observation as PlaytestJsonSchema
            ),
            null,
            2
          )}\n`,
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
        const { contentHash: _previous, ...content } = parsed.value;
        const updated = {
          ...content,
          ...derivedBenchmarkDigests(digests)
        };
        writeFileSync(
          benchmarkPath,
          `${JSON.stringify(
            {
              ...updated,
              contentHash: playtestBenchmarkContentHash(updated as never)
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
            // AutoDev's adapter, not a game-written one. The game declares
            // bindings; AutoDev speaks the protocol.
            command: [...PLAYTESTS_GENERIC_ADAPTER_COMMAND]
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

  const declaredBinding = readAdapterBinding(checkoutRoot);
  const observationSchema =
    declaredBinding?.schemas.observation ??
    SCAFFOLD_ADAPTER_SCHEMAS.observation;
  const observationPath = path.join(root, PLAYTESTS_OBSERVATION_FILE);
  if (!existsSync(observationPath)) {
    const contract = withObservationSchemaHash(
      {
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
      },
      observationSchema as PlaytestJsonSchema
    );
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
          schemaVersion: 2,
          // Deliberately empty. AutoDev will not guess the game's quality
          // dimensions; an invented metric would read as the game's own.
          metricDefinitions: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  // The binding is scaffolded, not the game. Its placeholders name what the
  // game must replace; nothing here encodes the game's measurement intent.
  const bindingPath = path.join(root, PLAYTESTS_BINDING_FILE);
  if (!existsSync(bindingPath)) {
    writeFileSync(
      bindingPath,
      `${JSON.stringify(
        {
          schema: "autodev-playtest-adapter-binding-v1",
          schemaVersion: 1,
          tier: "declarative",
          entry: "adapter.js",
          factory: "createGame",
          // Placeholders, clearly marked: a game must declare what its own
          // schemas are rather than inherit these.
          schemas: SCAFFOLD_ADAPTER_SCHEMAS,
          // No `capabilities` binding: AutoDev derives the advertisement from
          // these schemas, so a game-supplied one would never be called.
          bindings: {
            reset: { export: "reset" },
            observe: { export: "observe" },
            legalActions: { export: "legalActions" },
            step: { export: "step" },
            outcome: { export: "outcome" }
          }
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
  if (index !== -1 && index + 1 < args.length) {
    return path.resolve(args[index + 1]!);
  }
  return process.cwd();
}

/**
 * Write the generated-scaffold pair: the module whose bodies throw, and the
 * binding that declares AutoDev wrote them.
 *
 * Never overwrites. A game that has started implementing must not have its work
 * replaced by a fresh set of stubs, so a second `--scaffold` is reported rather
 * than silently regenerating over the top.
 */
function reportScaffold(checkoutRoot: string, args: readonly string[]): number {
  const root = integrationRoot(checkoutRoot);
  const factory = scaffoldFactoryFrom(args);
  const fileName = "adapter.js";
  const modulePath = path.join(root, fileName);
  const bindingPath = path.join(root, PLAYTESTS_BINDING_FILE);
  if (existsSync(modulePath) || existsSync(bindingPath)) {
    writeErrorLine(
      `${PLAYTESTS_INTEGRATION_DIR}/${fileName} or ${PLAYTESTS_BINDING_FILE} already exists; not regenerating over work in progress.`
    );
    return 1;
  }
  // The manifests the rest of the pipeline needs, so a scaffolded game is
  // onboarded by this one command rather than by `init` plus a second run.
  initPlaytestIntegration(checkoutRoot);
  // init writes a `declarative` binding; the scaffold replaces it with one that
  // says AutoDev generated the bodies.
  writeFileSync(
    modulePath,
    scaffoldAdapterModule({ factory, fileName }),
    "utf8"
  );
  writeFileSync(bindingPath, scaffoldBinding({ factory, fileName }), "utf8");
  writeLine(
    `generated ${PLAYTESTS_INTEGRATION_DIR}/${fileName} with ${PLAYTESTS_SCAFFOLD_BODY_COUNT} throwing bodies; replace each one, then run "autodev playtest conformance".`
  );
  return 0;
}

/** `--factory <name>`, defaulting to the conventional export name. */
function scaffoldFactoryFrom(args: readonly string[]): string {
  const index = args.indexOf("--factory");
  const declared = index === -1 ? undefined : args[index + 1];
  return declared && SCAFFOLD_FACTORY_PATTERN.test(declared)
    ? declared
    : "createGame";
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
  init: (args = []) =>
    args.includes("--scaffold")
      ? reportScaffold(checkoutRootFrom(args), args)
      : initPlaytestIntegration(checkoutRootFrom(args)),
  check: (args = []) =>
    reportCheck(checkoutRootFrom(args), args.includes("--write-hashes")),
  conformance: (args = []) => reportConformance(checkoutRootFrom(args))
};

/**
 * Run the game's own episode and report where it stopped.
 *
 * Asynchronous because the episode is real: it loads the game's entry module
 * and speaks the protocol to it. Exit code is non-zero when it does not hold
 * up, so onboarding a game can gate on it.
 */
async function reportConformance(checkoutRoot: string): Promise<number> {
  const report = await runPlaytestConformance(checkoutRoot);
  const text = formatConformanceReport(report);
  if (report.ok) {
    writeLine(text);
    return 0;
  }
  writeErrorLine(text);
  return 1;
}

export function dispatchPlaytestCommand(
  subcommand: string,
  args: readonly string[] = [],
  backend: PlaytestCommandBackend = defaultPlaytestBackend
): number | Promise<number> {
  if (subcommand === "init") return backend.init(args);
  if (subcommand === "check") return backend.check(args);
  if (subcommand === "conformance") return backend.conformance(args);
  throw unsupportedChoice(
    "playtest subcommand",
    subcommand,
    PLAYTESTS_SUBCOMMANDS
  );
}

export { PLAYTESTS_INTEGRATION_DIR } from "@simulatorlife/autodev-core";
