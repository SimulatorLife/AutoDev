import { type PlaytestGameMode, PLAYTESTS_GAME_MODES } from "./types.ts";

const CONFIG_PATH_SEPARATOR_PATTERN = /[\\/]/u;
const CONFIG_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:|\\\\)/u;

export interface PlaytestGameConfiguration {
  readonly schemaVersion: 1;
  readonly adapter: {
    readonly transport: "stdio-jsonl";
    readonly command: readonly string[];
  };
  readonly modes: readonly PlaytestGameMode[];
  readonly scenarios: readonly string[];
  /** Explicit game-owned scenario-id to scenario-family mapping. */
  readonly scenarioFamilies: Readonly<Record<string, string>>;
  readonly policies: readonly string[];
  readonly budget: {
    readonly episodes: number;
    readonly maxStepsPerEpisode: number;
    readonly workers: number;
    readonly wallTimeMinutes: number;
  };
  readonly analysis: {
    readonly rubric: string;
    readonly observationContract: string;
    readonly benchmark: string | null;
    readonly critic: string;
    readonly maxReviewedSessions: number;
    readonly visualCapture: "off" | "on-anomaly" | "sampled" | "all";
    readonly counterfactuals: "off" | "targeted" | "all";
    readonly understandingProbes: "off" | "sampled";
    readonly learningCohorts: "off" | "tracked";
    readonly humanCalibration: "off" | "optional" | "required";
  };
  readonly reporting: {
    readonly githubIssues: "disabled" | "review";
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  name: string
): void {
  const known = new Set(keys);
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new TypeError(name + " contains an unknown field.");
  }
}

function assertNonEmptyStrings(
  value: unknown,
  name: string
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0
    )
  ) {
    throw new TypeError(
      name + " must be a non-empty array of non-empty strings."
    );
  }
}

function assertNonNegativeInteger(
  value: unknown,
  name: string,
  maximum: number
): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > maximum
  ) {
    throw new TypeError(
      name + " must be a non-negative integer within the supported limit."
    );
  }
}

function assertUniqueStrings(
  value: unknown,
  name: string
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0
    )
  ) {
    throw new TypeError(
      name + " must be a non-empty array of non-empty strings."
    );
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(name + " entries must be unique.");
  }
}

function assertPositiveInteger(
  value: unknown,
  name: string,
  maximum: number
): void {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new TypeError(
      name + " must be a positive integer within the supported limit."
    );
  }
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function assertRelativeConfigPath(
  value: unknown,
  name: string
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.trim() ||
    value.length > 1024 ||
    value === "." ||
    hasControlCharacters(value) ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    CONFIG_ABSOLUTE_PATH_PATTERN.test(value) ||
    value.split(CONFIG_PATH_SEPARATOR_PATTERN).includes("..")
  ) {
    throw new TypeError(name + " must be a bounded workspace-relative path.");
  }
}

function assertOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string
): asserts value is T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(name + " has an unsupported value.");
  }
}

/** Validate the target-owned playtest.config.json contract without executing commands. */
export function assertPlaytestGameConfiguration(
  value: unknown
): asserts value is PlaytestGameConfiguration {
  if (!isRecord(value))
    throw new TypeError("Playtest configuration must be an object.");
  assertOnlyKeys(
    value,
    [
      "schemaVersion",
      "adapter",
      "modes",
      "scenarios",
      "scenarioFamilies",
      "policies",
      "budget",
      "analysis",
      "reporting"
    ],
    "Playtest configuration"
  );
  if (value.schemaVersion !== 1)
    throw new TypeError("Playtest schemaVersion must be 1.");

  if (!isRecord(value.adapter))
    throw new TypeError("Playtest adapter configuration must be an object.");
  assertOnlyKeys(value.adapter, ["transport", "command"], "Playtest adapter");
  if (value.adapter.transport !== "stdio-jsonl") {
    throw new TypeError(
      "Only the v1 stdio-jsonl adapter transport is supported."
    );
  }
  assertNonEmptyStrings(value.adapter.command, "adapter.command");
  if (
    value.adapter.command.length > 128 ||
    value.adapter.command.some(
      (argument) => argument.length > 4096 || argument.includes("\0")
    )
  ) {
    throw new TypeError("adapter.command exceeds the supported bound.");
  }

  if (!Array.isArray(value.modes) || value.modes.length === 0) {
    throw new TypeError("Playtest modes must be a non-empty array.");
  }
  for (const mode of value.modes) {
    assertOneOf(mode, PLAYTESTS_GAME_MODES, "Playtest mode");
  }
  if (new Set(value.modes).size !== value.modes.length) {
    throw new TypeError("Playtest modes must be unique.");
  }
  assertUniqueStrings(value.scenarios, "Playtest scenarios");
  if (!isRecord(value.scenarioFamilies)) {
    throw new TypeError(
      "Playtest scenarioFamilies must map every scenario to a family."
    );
  }
  const scenarioIds = new Set(value.scenarios);
  const scenarioFamilies = value.scenarioFamilies as Readonly<
    Record<string, unknown>
  >;
  if (
    Object.keys(scenarioFamilies).length !== scenarioIds.size ||
    Object.keys(scenarioFamilies).some(
      (scenarioId) =>
        !scenarioIds.has(scenarioId) ||
        typeof scenarioFamilies[scenarioId] !== "string" ||
        (scenarioFamilies[scenarioId] as string).trim().length === 0
    )
  ) {
    throw new TypeError(
      "Playtest scenarioFamilies must map every scenario to a non-empty family."
    );
  }
  assertUniqueStrings(value.policies, "Playtest policies");

  if (!isRecord(value.budget))
    throw new TypeError("Playtest budget must be an object.");
  assertOnlyKeys(
    value.budget,
    ["episodes", "maxStepsPerEpisode", "workers", "wallTimeMinutes"],
    "Playtest budget"
  );
  assertPositiveInteger(value.budget.episodes, "budget.episodes", 1_000_000);
  assertPositiveInteger(
    value.budget.maxStepsPerEpisode,
    "budget.maxStepsPerEpisode",
    100_000
  );
  assertPositiveInteger(value.budget.workers, "budget.workers", 32);
  assertPositiveInteger(
    value.budget.wallTimeMinutes,
    "budget.wallTimeMinutes",
    1440
  );

  if (!isRecord(value.analysis))
    throw new TypeError("Playtest analysis must be an object.");
  assertOnlyKeys(
    value.analysis,
    [
      "rubric",
      "observationContract",
      "benchmark",
      "critic",
      "maxReviewedSessions",
      "visualCapture",
      "counterfactuals",
      "understandingProbes",
      "learningCohorts",
      "humanCalibration"
    ],
    "Playtest analysis"
  );
  assertRelativeConfigPath(value.analysis.rubric, "analysis.rubric");
  assertRelativeConfigPath(
    value.analysis.observationContract,
    "analysis.observationContract"
  );
  if (value.analysis.benchmark !== null) {
    assertRelativeConfigPath(value.analysis.benchmark, "analysis.benchmark");
  }
  if (
    typeof value.analysis.critic !== "string" ||
    value.analysis.critic.trim().length === 0
  ) {
    throw new TypeError(
      "analysis.critic must name auto or a configured critic."
    );
  }
  assertNonNegativeInteger(
    value.analysis.maxReviewedSessions,
    "analysis.maxReviewedSessions",
    100_000
  );
  assertOneOf(
    value.analysis.visualCapture,
    ["off", "on-anomaly", "sampled", "all"],
    "analysis.visualCapture"
  );
  assertOneOf(
    value.analysis.counterfactuals,
    ["off", "targeted", "all"],
    "analysis.counterfactuals"
  );
  assertOneOf(
    value.analysis.understandingProbes,
    ["off", "sampled"],
    "analysis.understandingProbes"
  );
  assertOneOf(
    value.analysis.learningCohorts,
    ["off", "tracked"],
    "analysis.learningCohorts"
  );
  assertOneOf(
    value.analysis.humanCalibration,
    ["off", "optional", "required"],
    "analysis.humanCalibration"
  );

  if (!isRecord(value.reporting))
    throw new TypeError("Playtest reporting must be an object.");
  assertOnlyKeys(value.reporting, ["githubIssues"], "Playtest reporting");
  assertOneOf(
    value.reporting.githubIssues,
    ["disabled", "review"],
    "reporting.githubIssues"
  );
}
