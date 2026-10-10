/** Load and bind target-owned playtest files to one exact Workspaces approval. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import path from "node:path";

import {
  assertPlaytestBenchmark,
  assertPlaytestGameConfiguration,
  assertPlaytestObservationContract,
  assertWorkspacePlaytestApproval,
  expandPlaytestRegistry,
  PLAYTESTS_MEASUREMENT_VERSION,
  playtestBenchmarkHashInput,
  type PlaytestBenchmark,
  type PlaytestGameConfiguration,
  type PlaytestMetricRegistry,
  type PlaytestObservationContract,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";

const CONFIG_FILENAME = "playtest.config.json";
const CONFIG_LABEL = "playtest.config.json";
const CONFIG_UNAVAILABLE = "config-unavailable" as const;
const MAX_TARGET_FILE_BYTES = 1024 * 1024;

export type ApprovedConfigurationFailure =
  | "invalid-approval"
  | "checkout-unavailable"
  | "config-unavailable"
  | "config-too-large"
  | "config-invalid"
  | "config-hash-mismatch"
  | "target-file-unavailable"
  | "target-file-too-large"
  | "target-file-invalid"
  | "command-mismatch"
  | "scenario-mismatch"
  | "policy-mismatch"
  | "budget-mismatch"
  | "benchmark-mismatch";

export class ApprovedPlaytestConfigurationError extends Error {
  readonly category: ApprovedConfigurationFailure;

  constructor(category: ApprovedConfigurationFailure, message: string) {
    super(message);
    this.name = "ApprovedPlaytestConfigurationError";
    this.category = category;
  }
}

export interface ApprovedPlaytestDefinition {
  readonly configuration: PlaytestGameConfiguration;
  readonly configHash: string;
  readonly observationContract: PlaytestObservationContract;
  readonly rubric: PlaytestMetricRegistry;
  readonly rubricHash: string;
  readonly benchmark: PlaytestBenchmark | null;
  readonly benchmarkHash: string | null;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function fail(category: ApprovedConfigurationFailure, message: string): never {
  throw new ApprovedPlaytestConfigurationError(category, message);
}

function targetFileCategory(
  isConfig: boolean,
  tooLarge: boolean
): ApprovedConfigurationFailure {
  if (isConfig) return tooLarge ? "config-too-large" : CONFIG_UNAVAILABLE;
  return tooLarge ? "target-file-too-large" : "target-file-unavailable";
}

function assertNoSymlinkPath(
  root: string,
  file: string,
  label: string,
  category: ApprovedConfigurationFailure
): void {
  const segments = path.relative(root, file).split(path.sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      fail(category, `${label} could not be inspected safely.`);
    }
    const isFinal = index === segments.length - 1;
    if (entry.isSymbolicLink()) {
      fail(category, `${label} cannot traverse symbolic links.`);
    }
    if ((!isFinal && !entry.isDirectory()) || (isFinal && !entry.isFile())) {
      fail(
        category,
        `${label} must be a regular file inside the approved checkout.`
      );
    }
  }
}

function openApprovedWorkspaceFile(
  root: string,
  file: string,
  label: string,
  category: ApprovedConfigurationFailure
): number {
  if (typeof constants.O_NOFOLLOW !== "number") {
    return fail(
      category,
      "The runtime cannot safely open target files without following symlinks."
    );
  }
  try {
    if (!isWithin(root, realpathSync(file))) {
      fail(category, `${label} escaped its approved checkout.`);
    }
    return openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    return fail(category, `${label} could not be opened safely.`);
  }
}

function readOpenedWorkspaceFile(
  descriptor: number,
  label: string,
  isConfig: boolean
): Buffer {
  const unavailable = targetFileCategory(isConfig, false);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) fail(unavailable, `${label} is not a regular file.`);
    if (opened.size > MAX_TARGET_FILE_BYTES) {
      fail(
        targetFileCategory(isConfig, true),
        `${label} exceeds the 1 MiB limit.`
      );
    }
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength !== opened.size) {
      fail(unavailable, `${label} changed while being read.`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    return fail(unavailable, `${label} could not be read safely.`);
  } finally {
    closeSync(descriptor);
  }
}

/** Read a small regular target file while refusing symlink traversal. */
function readApprovedWorkspaceFile(
  root: string,
  relativePath: string,
  label: string,
  isConfig = false
): Buffer {
  const category = targetFileCategory(isConfig, false);
  const file = path.resolve(root, relativePath);
  if (!isWithin(root, file) || file === root) {
    fail(category, `${label} must resolve inside the approved checkout.`);
  }
  assertNoSymlinkPath(root, file, label, category);
  const descriptor = openApprovedWorkspaceFile(root, file, label, category);
  return readOpenedWorkspaceFile(descriptor, label, isConfig);
}

function assertMatchesApproval(
  configuration: PlaytestGameConfiguration,
  approval: WorkspacePlaytestApproval
): void {
  if (
    configuration.adapter.command.length !== approval.adapterCommand.length ||
    configuration.adapter.command.some(
      (argument, index) => argument !== approval.adapterCommand[index]
    )
  ) {
    fail(
      "command-mismatch",
      "The config adapter command differs from the exact operator approval."
    );
  }
  if (
    approval.allowedScenarios.some(
      (scenario) => !configuration.scenarios.includes(scenario)
    )
  ) {
    fail(
      "scenario-mismatch",
      "Approval includes a scenario absent from the checked-in config."
    );
  }
  if (
    approval.allowedPolicies.some(
      (policy) => !configuration.policies.includes(policy)
    )
  ) {
    fail(
      "policy-mismatch",
      "Approval includes a policy absent from the checked-in config."
    );
  }
  if (
    approval.limits.episodeCount > configuration.budget.episodes ||
    approval.limits.maxStepsPerEpisode >
      configuration.budget.maxStepsPerEpisode ||
    approval.limits.workerCount > configuration.budget.workers ||
    approval.limits.wallTimeMs >
      configuration.budget.wallTimeMinutes * 60_000 ||
    approval.limits.critiqueCount > configuration.analysis.maxReviewedSessions
  ) {
    fail(
      "budget-mismatch",
      "Workspace approval exceeds the checked-in playtest budget."
    );
  }
}

function assertBenchmarkMatchesTarget(input: {
  readonly benchmark: PlaytestBenchmark;
  readonly approval: WorkspacePlaytestApproval;
  readonly configuration: PlaytestGameConfiguration;
  readonly observationContract: PlaytestObservationContract;
  readonly rubric: PlaytestMetricRegistry;
  readonly rubricHash: string;
}): void {
  const {
    benchmark,
    approval,
    configuration,
    observationContract,
    rubric,
    rubricHash
  } = input;
  const configurationMetrics = new Set([
    ...rubric.metricDefinitions.map((metric) => metric.metricId),
    ...rubric.dimensionRubrics.map((dimension) => dimension.dimensionId)
  ]);
  if (
    benchmark.workspaceId !== approval.workspaceId ||
    benchmark.measurementVersion !== PLAYTESTS_MEASUREMENT_VERSION ||
    benchmark.rubricHash !== rubricHash ||
    benchmark.metricRegistryHash !== rubricHash ||
    benchmark.observationSchemaHash !== observationContract.schemaHash ||
    !configuration.modes.includes(benchmark.captureMode) ||
    benchmark.scenarioInventory.some(
      (scenario) =>
        !configuration.scenarios.includes(scenario.scenarioId) ||
        configuration.scenarioFamilies[scenario.scenarioId] !== scenario.family
    ) ||
    Object.keys(benchmark.policyVersions).some(
      (policyId) => !configuration.policies.includes(policyId)
    ) ||
    [...benchmark.primaryMetricIds, ...benchmark.guardrailMetricIds].some(
      (metricId) => !configurationMetrics.has(metricId)
    )
  ) {
    fail(
      "benchmark-mismatch",
      "The benchmark does not match the approved workspace, target configuration, and measurement sources."
    );
  }
}

/**
 * Read exact target-owned files, validate their schemas and bind the config's
 * raw-byte SHA-256 to the approval. This performs no execution.
 */
export function loadApprovedPlaytestDefinition(
  approval: WorkspacePlaytestApproval
): ApprovedPlaytestDefinition {
  try {
    assertWorkspacePlaytestApproval(approval);
  } catch {
    fail("invalid-approval", "Workspace playtesting approval is invalid.");
  }
  if (approval.revokedAt !== null) {
    fail(
      "invalid-approval",
      "Workspace playtesting approval has been revoked."
    );
  }

  let root: string;
  try {
    root = path.resolve(approval.checkoutRoot);
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      fail(
        "checkout-unavailable",
        "Approved checkout root must be a real directory."
      );
    }
    if (realpathSync(root) !== root) {
      fail(
        "checkout-unavailable",
        "Approved checkout root must not resolve through a symlink."
      );
    }
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    fail("checkout-unavailable", "Approved checkout root is unavailable.");
  }

  const configBytes = readApprovedWorkspaceFile(
    root,
    CONFIG_FILENAME,
    CONFIG_LABEL,
    true
  );
  const configHash = createHash("sha256").update(configBytes).digest("hex");
  if (configHash !== approval.playtestConfigHash.toLowerCase()) {
    fail(
      "config-hash-mismatch",
      "Checked-in playtest.config.json does not match the approved SHA-256."
    );
  }

  let configuration: PlaytestGameConfiguration;
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(configBytes)
    );
    assertPlaytestGameConfiguration(parsed);
    configuration = parsed;
  } catch {
    fail(
      "config-invalid",
      "Checked-in playtest.config.json is invalid or unsupported."
    );
  }
  assertMatchesApproval(configuration, approval);

  let observationContract: PlaytestObservationContract;
  try {
    const observationBytes = readApprovedWorkspaceFile(
      root,
      configuration.analysis.observationContract,
      configuration.analysis.observationContract
    );
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(observationBytes)
    );
    assertPlaytestObservationContract(parsed);
    if (!configuration.modes.includes(parsed.mode)) {
      throw new TypeError(
        "Observation mode is not enabled by the target config."
      );
    }
    observationContract = parsed;
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    fail(
      "target-file-invalid",
      "The target observation contract is invalid or incompatible."
    );
  }

  const rubricBytes = readApprovedWorkspaceFile(
    root,
    configuration.analysis.rubric,
    configuration.analysis.rubric
  );
  let rubric: PlaytestMetricRegistry;
  try {
    rubric = expandPlaytestRegistry(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rubricBytes))
    );
    if (rubric.workspaceId !== approval.workspaceId) {
      throw new TypeError("The metric registry belongs to another workspace.");
    }
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    fail(
      "target-file-invalid",
      "The target rubric or metric registry is invalid."
    );
  }
  const rubricHash = createHash("sha256").update(rubricBytes).digest("hex");

  let benchmark: PlaytestBenchmark | null = null;
  let benchmarkHash: string | null = null;
  if (configuration.analysis.benchmark !== null) {
    try {
      const benchmarkBytes = readApprovedWorkspaceFile(
        root,
        configuration.analysis.benchmark,
        configuration.analysis.benchmark
      );
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(benchmarkBytes)
      );
      assertPlaytestBenchmark(parsed);
      const contentHash = createHash("sha256")
        .update(playtestBenchmarkHashInput(parsed))
        .digest("hex");
      if (contentHash !== parsed.contentHash.toLowerCase()) {
        throw new TypeError("The benchmark content hash is invalid.");
      }
      assertBenchmarkMatchesTarget({
        benchmark: parsed,
        approval,
        configuration,
        observationContract,
        rubric,
        rubricHash
      });
      benchmark = parsed;
      benchmarkHash = contentHash;
    } catch (error) {
      if (error instanceof ApprovedPlaytestConfigurationError) throw error;
      fail(
        "target-file-invalid",
        "The target benchmark is invalid or incompatible."
      );
    }
  }
  return {
    configuration,
    configHash,
    observationContract,
    rubric,
    rubricHash,
    benchmark,
    benchmarkHash
  };
}
