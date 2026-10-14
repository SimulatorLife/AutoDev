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
  type PlaytestAdapterBinding,
  type PlaytestBenchmark,
  playtestBenchmarkHashInput,
  type PlaytestGameConfiguration,
  type PlaytestJsonSchema,
  type PlaytestMetricRegistry,
  type PlaytestObservationContract,
  PLAYTESTS_INTEGRATION_DIR,
  PLAYTESTS_MEASUREMENT_VERSION,
  resolvePlaytestAdapterBinding,
  usesGenericPlaytestAdapter,
  type WorkspacePlaytestApproval
} from "@simulatorlife/autodev-core";

import { observationSchemaHash, playtestManifestHash } from "./hash-chain.ts";

/**
 * The one integration file a target game checks in, resolved against the
 * approved checkout root.
 *
 * `.autodev/playtest.config.json` is the canonical location so a repository
 * advertises AutoDev Playtesting support through one recognizable directory.
 * Every other manifest it references resolves relative to this file's own
 * directory, so that directory is self-contained and relocatable.
 */
const CONFIG_PATH = `${PLAYTESTS_INTEGRATION_DIR}/playtest.config.json`;
const CONFIG_LABEL = CONFIG_PATH;
const CONFIG_UNAVAILABLE = "config-unavailable" as const;
const TARGET_FILE_INVALID = "target-file-invalid" as const;
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

/**
 * Read a small regular target file while refusing symlink traversal.
 *
 * `relativePath` is always interpreted against the approved checkout root, so
 * the symlink and containment checks keep walking from that root even when the
 * caller resolved the path against the config's own directory.
 */
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

/**
 * Rewrites a config-declared manifest path into a checkout-root-relative one.
 *
 * Manifests are declared relative to the config file itself, which is what
 * makes `.autodev/` a self-contained, relocatable integration directory.
 *
 * Core's `assertRelativeConfigPath` already rejects `..`, absolute and
 * control-character paths, so a well-formed config cannot reach outside its
 * directory. This containment check is the Runtime's own independent boundary:
 * a containment rule enforced only by the validator that produced the value is
 * not a boundary. Failing closed here turns a misconfiguration into an
 * explicit refusal instead of a read from somewhere unexpected.
 */
function readConfigRelativeManifest(
  root: string,
  configDirectory: string,
  declaredPath: string,
  label: string
): Buffer {
  const resolved = path.resolve(configDirectory, declaredPath);
  if (!isWithin(configDirectory, resolved)) {
    fail(
      "target-file-unavailable",
      `${label} must stay inside the ${CONFIG_LABEL} directory.`
    );
  }
  return readApprovedWorkspaceFile(root, path.relative(root, resolved), label);
}

function assertMatchesApproval(
  configuration: PlaytestGameConfiguration,
  approval: WorkspacePlaytestApproval
): void {
  if (!usesGenericPlaytestAdapter(configuration.adapter.command)) {
    fail(
      "command-mismatch",
      "Approved Playtesting requires AutoDev's generic adapter; game-written protocol adapters are not supported."
    );
  }
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
    configuration.analysis.maxReviewedSessions > approval.limits.critiqueCount
  ) {
    fail(
      "budget-mismatch",
      "The target critique plan exceeds the approved workspace critique budget."
    );
  }
}

function loadApprovedAdapterBinding(root: string): PlaytestAdapterBinding {
  const label = `${PLAYTESTS_INTEGRATION_DIR}/playtest.binding.json`;
  const bytes = readApprovedWorkspaceFile(root, label, label);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail(TARGET_FILE_INVALID, "The target adapter binding is invalid.");
  }
  const resolution = resolvePlaytestAdapterBinding(value);
  if (resolution.kind === "rejected") {
    fail(
      TARGET_FILE_INVALID,
      "The target adapter binding is invalid: " + resolution.message
    );
  }
  return value as PlaytestAdapterBinding;
}

function assertObservationSchemaMatchesBinding(
  contract: PlaytestObservationContract,
  binding: PlaytestAdapterBinding
): void {
  const expected = observationSchemaHash(
    binding.schemas.observation as PlaytestJsonSchema
  );
  if (contract.schemaHash.toLowerCase() !== expected.toLowerCase()) {
    fail(
      TARGET_FILE_INVALID,
      "The observation contract schemaHash does not match the adapter binding's observation schema."
    );
  }
}

function assertBenchmarkMatchesTarget(input: {
  readonly benchmark: PlaytestBenchmark;
  readonly approval: WorkspacePlaytestApproval;
  readonly configuration: PlaytestGameConfiguration;
  readonly binding: PlaytestAdapterBinding;
  readonly observationContract: PlaytestObservationContract;
  readonly rubric: PlaytestMetricRegistry;
  readonly rubricHash: string;
}): void {
  const {
    benchmark,
    approval,
    configuration,
    binding,
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
    benchmark.actionSchemaHash !==
      playtestManifestHash(binding.schemas.action) ||
    benchmark.eventSchemaHash !== playtestManifestHash(binding.schemas.event) ||
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
function resolveApprovedCheckoutRoot(
  approval: WorkspacePlaytestApproval
): string {
  try {
    const root = path.resolve(approval.checkoutRoot);
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
    return root;
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    throw fail(
      "checkout-unavailable",
      "Approved checkout root is unavailable."
    );
  }
}

function loadApprovedConfiguration(
  root: string,
  approval: WorkspacePlaytestApproval
): {
  configuration: PlaytestGameConfiguration;
  configHash: string;
  configDirectory: string;
} {
  const configBytes = readApprovedWorkspaceFile(
    root,
    CONFIG_PATH,
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
  return {
    configuration,
    configHash,
    configDirectory: path.dirname(path.resolve(root, CONFIG_PATH))
  };
}

function loadApprovedObservationContract(
  root: string,
  configDirectory: string,
  configuration: PlaytestGameConfiguration
): PlaytestObservationContract {
  try {
    const observationBytes = readConfigRelativeManifest(
      root,
      configDirectory,
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
    return parsed;
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    throw fail(
      TARGET_FILE_INVALID,
      "The target observation contract is invalid or incompatible."
    );
  }
}

function loadApprovedRubric(
  root: string,
  configDirectory: string,
  configuration: PlaytestGameConfiguration,
  approval: WorkspacePlaytestApproval,
  binding: PlaytestAdapterBinding
): { rubric: PlaytestMetricRegistry; rubricHash: string } {
  const rubricBytes = readConfigRelativeManifest(
    root,
    configDirectory,
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
    if (
      rubric.eventSchemaHash !== playtestManifestHash(binding.schemas.event)
    ) {
      throw new TypeError(
        "The metric registry event schema hash does not match the adapter binding."
      );
    }
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    fail(
      TARGET_FILE_INVALID,
      "The target rubric or metric registry is invalid."
    );
  }
  const rubricHash = createHash("sha256").update(rubricBytes).digest("hex");
  return { rubric, rubricHash };
}

function loadApprovedBenchmark(
  root: string,
  configDirectory: string,
  configuration: PlaytestGameConfiguration,
  approval: WorkspacePlaytestApproval,
  binding: PlaytestAdapterBinding,
  observationContract: PlaytestObservationContract,
  rubric: PlaytestMetricRegistry,
  rubricHash: string
): { benchmark: PlaytestBenchmark | null; benchmarkHash: string | null } {
  if (configuration.analysis.benchmark === null) {
    return { benchmark: null, benchmarkHash: null };
  }
  try {
    const benchmarkBytes = readConfigRelativeManifest(
      root,
      configDirectory,
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
      binding,
      observationContract,
      rubric,
      rubricHash
    });
    return { benchmark: parsed, benchmarkHash: contentHash };
  } catch (error) {
    if (error instanceof ApprovedPlaytestConfigurationError) throw error;
    throw fail(
      TARGET_FILE_INVALID,
      "The target benchmark is invalid or incompatible" +
        (error instanceof Error ? ": " + error.message : ".")
    );
  }
}

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

  const root = resolveApprovedCheckoutRoot(approval);
  const { configuration, configHash, configDirectory } =
    loadApprovedConfiguration(root, approval);
  const binding = loadApprovedAdapterBinding(root);
  const observationContract = loadApprovedObservationContract(
    root,
    configDirectory,
    configuration
  );
  assertObservationSchemaMatchesBinding(observationContract, binding);
  const { rubric, rubricHash } = loadApprovedRubric(
    root,
    configDirectory,
    configuration,
    approval,
    binding
  );
  const { benchmark, benchmarkHash } = loadApprovedBenchmark(
    root,
    configDirectory,
    configuration,
    approval,
    binding,
    observationContract,
    rubric,
    rubricHash
  );

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
