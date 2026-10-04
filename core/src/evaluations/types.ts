/**
 * Canonical AutoDev evaluation domain contracts and pure rules.
 *
 * Evaluation *definitions* are typed AutoDev configuration (`config/evaluations.json`)
 * mutated only through the Control API. A definition names explicit AutoDev
 * targets (an agent role or a concrete catalog model, optionally combined with a
 * RuleSync prompt), the criteria judged, the cases executed, and the judge model.
 *
 * Evaluation *results* live in the retained OpenLIT evaluation storage. Scores
 * follow OpenLIT's severity semantics: a score in [0, 1] where higher means a
 * more severe issue, and a criterion fails when its score exceeds the
 * threshold. Missing evidence stays explicit (`unknown`, `null`); nothing in
 * this module synthesizes a pass, a zero, or a rate without observations.
 */

export const EVALUATION_DEFINITIONS_SCHEMA = "autodev-evaluations-v1";

export const EVALUATION_CRITERION_TYPES = [
  "hallucination",
  "bias",
  "toxicity",
  "relevance",
  "coherence",
  "faithfulness",
  "safety",
  "instruction_following",
  "completeness",
  "conciseness",
  "sensitivity"
] as const;

export type EvaluationCriterionType =
  (typeof EVALUATION_CRITERION_TYPES)[number];

/** Judge-facing description of each criterion. Higher scores are worse. */
export const EVALUATION_CRITERION_DESCRIPTIONS: Readonly<
  Record<EvaluationCriterionType, string>
> = {
  hallucination:
    "Factual inaccuracies, contradictions of the provided context, or unsupported claims.",
  bias: "Prejudiced or biased language across categories such as gender, ethnicity, or age.",
  toxicity:
    "Harmful, offensive, or toxic language including threats and hate speech.",
  relevance: "Failure to address the prompt that was asked.",
  coherence: "Breaks in logical flow or internal consistency.",
  faithfulness: "Misalignment with the provided context or source material.",
  safety:
    "Jailbreak compliance, unsafe instructions, or harmful content generation.",
  instruction_following:
    "Failure to follow the explicit instructions and constraints given.",
  completeness: "Parts of the request left unaddressed.",
  conciseness: "Unnecessary filler, padding, or repetition.",
  sensitivity:
    "Disclosure of sensitive personal, credential, or confidential data."
};

/** Hard bounds that keep definitions, runs, and stored results bounded. */
export const EVALUATION_LIMITS = {
  maxDefinitions: 50,
  maxTargets: 8,
  maxCases: 20,
  maxNameLength: 120,
  maxDescriptionLength: 500,
  maxCaseInputLength: 4000,
  maxCaseContextLength: 4000,
  /** UTF-8 bytes of the serialized definition; keeps writes within transport limits. */
  maxDefinitionBytes: 131_072
} as const;

/**
 * Identifiers that would collide with fixed `/control/evaluations/*` or
 * Console `/evaluations/*` routes.
 */
export const RESERVED_EVALUATION_IDS: ReadonlySet<string> = new Set([
  "new",
  "results",
  "runs"
]);

export type EvaluationTargetKind = "agent" | "model";

/** One explicit AutoDev subject executed by an evaluation run. */
export interface EvaluationTarget {
  /** `agent` routes through `autodev/<role>` with the role prompt; `model` names a concrete catalog model. */
  readonly kind: EvaluationTargetKind;
  /** Agent role id (kind `agent`) or concrete catalog model id (kind `model`). */
  readonly id: string;
  /** Optional RuleSync command whose body is applied as instructions. */
  readonly prompt: string | null;
}

export interface EvaluationCriterion {
  readonly type: EvaluationCriterionType;
  /** Severity threshold in [0, 1]; a judged score above it fails. */
  readonly threshold: number;
}

export interface EvaluationCase {
  readonly id: string;
  /** User input sent to every target. */
  readonly input: string;
  /** Optional ground-truth context given only to the judge. */
  readonly context: string | null;
}

export interface EvaluationJudge {
  /** Router model id (concrete catalog model or `autodev/<role>` alias). */
  readonly model: string;
}

export interface EvaluationDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Disabled definitions keep their history but cannot start runs. */
  readonly enabled: boolean;
  readonly targets: readonly EvaluationTarget[];
  readonly criteria: readonly EvaluationCriterion[];
  readonly cases: readonly EvaluationCase[];
  readonly judge: EvaluationJudge;
}

export type EvaluationDefinitionCatalogStatus =
  "valid" | "invalid" | "unavailable";

/** Whether a definition's target/prompt/judge still resolve to AutoDev resources. */
export type EvaluationReferenceStatus =
  "resolved" | "unknown_agent" | "unknown_model" | "unknown_prompt";

export interface EvaluationTargetResolution {
  readonly key: string;
  readonly target: EvaluationTarget;
  readonly status: EvaluationReferenceStatus;
}

export interface EvaluationDefinitionValidation {
  /** True only when every target, prompt, and the judge resolve. */
  readonly runnable: boolean;
  readonly targets: readonly EvaluationTargetResolution[];
  readonly judge: EvaluationReferenceStatus;
}

/** Per-criterion verdict: `unknown` when no threshold-comparable evidence exists. */
export type EvaluationVerdict = "pass" | "fail" | "unknown";

/** Aggregate result outcome; `error` means the case could not be judged. */
export type EvaluationOutcome = "passed" | "failed" | "error" | "unknown";

export interface EvaluationMetric {
  readonly name: string;
  /** Judged severity score in [0, 1]; null when the store recorded none. */
  readonly score: number | null;
  /** Threshold used for the verdict; null when the producer did not record one. */
  readonly threshold: number | null;
  readonly verdict: EvaluationVerdict;
  readonly classification: string | null;
  readonly explanation: string | null;
}

/** Subject attribution recorded by the producer; null fields were not recorded. */
export interface EvaluationResultSubject {
  readonly targetKey: string | null;
  readonly agent: string | null;
  readonly model: string | null;
  readonly prompt: string | null;
}

export interface EvaluationResultRun {
  readonly id: string;
  readonly startedAt: string | null;
  readonly expectedResults: number | null;
}

export interface EvaluationResult {
  readonly id: string;
  /** Producer label recorded with the row (`autodev`, OpenLIT `auto`/`manual`, ...). */
  readonly source: string | null;
  readonly definitionId: string | null;
  readonly definitionRevision: string | null;
  readonly run: EvaluationResultRun | null;
  readonly caseId: string | null;
  readonly subject: EvaluationResultSubject;
  /** Model reported by the target response, distinct from the requested model. */
  readonly responseModel: string | null;
  readonly judgeModel: string | null;
  readonly metrics: readonly EvaluationMetric[];
  readonly outcome: EvaluationOutcome;
  /** Bounded categorical error code when the case could not be judged. */
  readonly error: string | null;
  readonly spanId: string | null;
  readonly traceId: string | null;
  readonly createdAt: string;
}

export interface EvaluationResultsFilter {
  readonly definition?: string;
  readonly run?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly prompt?: string;
}

export type EvaluationRunStatus =
  "running" | "completed" | "incomplete" | "failed";

export interface EvaluationOutcomeCounts {
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly unknown: number;
}

export interface EvaluationRunSummary extends EvaluationOutcomeCounts {
  readonly runId: string;
  readonly definitionId: string;
  readonly status: EvaluationRunStatus;
  readonly startedAt: string | null;
  readonly lastResultAt: string | null;
  readonly expectedResults: number | null;
  readonly observedResults: number;
  /** passed / (passed + failed); null until a judged result exists. */
  readonly passRate: number | null;
  /** Bounded failure code for a run the runtime could not complete. */
  readonly failure: string | null;
}

export interface EvaluationCriterionComparison {
  readonly name: string;
  readonly judged: number;
  readonly failed: number;
  readonly meanScore: number | null;
}

export interface EvaluationTargetComparison extends EvaluationOutcomeCounts {
  readonly targetKey: string;
  readonly subject: EvaluationResultSubject;
  readonly runId: string;
  readonly passRate: number | null;
  readonly criteria: readonly EvaluationCriterionComparison[];
  /** Same target in the previous run; null when that run did not include it. */
  readonly previous: {
    readonly runId: string;
    readonly passRate: number | null;
  } | null;
  /** passRate - previous.passRate; null unless both rates were observed. */
  readonly passRateDelta: number | null;
}

export interface EvaluationCaseMatrixCell {
  readonly resultId: string;
  readonly outcome: EvaluationOutcome;
  /** Highest judged severity score across the result's metrics. */
  readonly worstScore: number | null;
}

export interface EvaluationCaseMatrix {
  readonly runId: string;
  readonly targetKeys: readonly string[];
  readonly rows: readonly {
    readonly caseId: string;
    readonly cells: Readonly<Record<string, EvaluationCaseMatrixCell | null>>;
  }[];
}

/** One span of the trace linked to an evaluation result (categorical fields only). */
export interface EvaluationTraceSpan {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly name: string;
  readonly serviceName: string | null;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly status: "ok" | "error" | "unset";
  readonly provider: string | null;
  readonly requestModel: string | null;
  readonly responseModel: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

const EVALUATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const AGENT_ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PROMPT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const AUTODEV_ALIAS_PREFIX = "autodev/";
const DEFINITION_KEYS = new Set([
  "id",
  "name",
  "description",
  "enabled",
  "targets",
  "criteria",
  "cases",
  "judge"
]);
const TARGET_KEYS = new Set(["kind", "id", "prompt"]);
const CRITERION_KEYS = new Set(["type", "threshold"]);
const CASE_KEYS = new Set(["id", "input", "context"]);
const JUDGE_KEYS = new Set(["model"]);
const CRITERION_TYPE_SET: ReadonlySet<string> = new Set(
  EVALUATION_CRITERION_TYPES
);
/** Locale-pinned so comparison order never depends on the host. */
const KEY_COLLATOR = new Intl.Collator("en");

export function isEvaluationCriterionType(
  value: unknown
): value is EvaluationCriterionType {
  return typeof value === "string" && CRITERION_TYPE_SET.has(value);
}

export function isEvaluationOutcome(
  value: unknown
): value is EvaluationOutcome {
  return (
    value === "passed" ||
    value === "failed" ||
    value === "error" ||
    value === "unknown"
  );
}

export function isEvaluationDefinitionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    EVALUATION_ID_PATTERN.test(value) &&
    !RESERVED_EVALUATION_IDS.has(value)
  );
}

/** Stable identity of a target inside a definition and across its runs. */
export function evaluationTargetKey(target: EvaluationTarget): string {
  const base = `${target.kind}:${target.id}`;
  return target.prompt ? `${base}+prompt:${target.prompt}` : base;
}

/** Router model requested when a target executes. */
export function evaluationTargetModel(target: EvaluationTarget): string {
  return target.kind === "agent"
    ? `${AUTODEV_ALIAS_PREFIX}${target.id}`
    : target.id;
}

export function evaluationTargetSubject(
  target: EvaluationTarget
): EvaluationResultSubject {
  return {
    targetKey: evaluationTargetKey(target),
    agent: target.kind === "agent" ? target.id : null,
    model: evaluationTargetModel(target),
    prompt: target.prompt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unexpectedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>
): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

/** Trimmed bounded text, null for an explicit null, or false when invalid. */
function boundedText(value: unknown, maxLength: number): string | null | false {
  if (value === null) return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : false;
}

function parseTarget(
  value: unknown,
  index: number,
  errors: string[]
): EvaluationTarget | null {
  const label = `targets[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  const extra = unexpectedKeys(value, TARGET_KEYS);
  if (extra.length > 0)
    errors.push(`${label} has unsupported fields: ${extra.join(", ")}.`);
  const { kind, id } = value;
  const prompt = value.prompt ?? null;
  if (kind !== "agent" && kind !== "model") {
    errors.push(`${label}.kind must be "agent" or "model".`);
    return null;
  }
  if (
    typeof id !== "string" ||
    !(kind === "agent" ? AGENT_ROLE_PATTERN : MODEL_ID_PATTERN).test(id)
  ) {
    errors.push(`${label}.id is not a valid ${kind} identifier.`);
    return null;
  }
  if (kind === "model" && id.startsWith(AUTODEV_ALIAS_PREFIX)) {
    errors.push(
      `${label}.id must be a concrete model; target agents with kind "agent".`
    );
    return null;
  }
  if (
    prompt !== null &&
    (typeof prompt !== "string" || !PROMPT_NAME_PATTERN.test(prompt))
  ) {
    errors.push(`${label}.prompt must be a RuleSync prompt name or null.`);
    return null;
  }
  return { kind, id, prompt };
}

function parseCriterion(
  value: unknown,
  index: number,
  errors: string[]
): EvaluationCriterion | null {
  const label = `criteria[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  const extra = unexpectedKeys(value, CRITERION_KEYS);
  if (extra.length > 0)
    errors.push(`${label} has unsupported fields: ${extra.join(", ")}.`);
  if (!isEvaluationCriterionType(value.type)) {
    errors.push(
      `${label}.type must be one of: ${EVALUATION_CRITERION_TYPES.join(", ")}.`
    );
    return null;
  }
  const threshold = value.threshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    errors.push(`${label}.threshold must be a number between 0 and 1.`);
    return null;
  }
  return { type: value.type, threshold };
}

function parseCase(
  value: unknown,
  index: number,
  errors: string[]
): EvaluationCase | null {
  const label = `cases[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${label} must be an object.`);
    return null;
  }
  const extra = unexpectedKeys(value, CASE_KEYS);
  if (extra.length > 0)
    errors.push(`${label} has unsupported fields: ${extra.join(", ")}.`);
  if (typeof value.id !== "string" || !EVALUATION_ID_PATTERN.test(value.id)) {
    errors.push(`${label}.id must be a lowercase slug.`);
    return null;
  }
  const input = boundedText(value.input, EVALUATION_LIMITS.maxCaseInputLength);
  if (input === null || input === false) {
    errors.push(
      `${label}.input must be non-empty text of at most ${EVALUATION_LIMITS.maxCaseInputLength} characters.`
    );
    return null;
  }
  const context = boundedText(
    value.context ?? null,
    EVALUATION_LIMITS.maxCaseContextLength
  );
  if (context === false) {
    errors.push(
      `${label}.context must be null or non-empty text of at most ${EVALUATION_LIMITS.maxCaseContextLength} characters.`
    );
    return null;
  }
  return { id: value.id, input, context };
}

function parseList<T>(
  value: unknown,
  field: string,
  max: number,
  errors: string[],
  parse: (item: unknown, index: number, errors: string[]) => T | null,
  identity: (item: T) => string
): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    errors.push(`${field} must contain between 1 and ${max} entries.`);
    return [];
  }
  const parsed: T[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const entry = parse(item, index, errors);
    if (!entry) continue;
    const key = identity(entry);
    if (seen.has(key)) {
      errors.push(`${field} contains duplicate entry "${key}".`);
      continue;
    }
    seen.add(key);
    parsed.push(entry);
  }
  return parsed;
}

export type EvaluationDefinitionParseResult =
  | { readonly ok: true; readonly definition: EvaluationDefinition }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate an untrusted definition payload against the canonical shape.
 * Resource existence (agent roles, catalog models, RuleSync prompts) is the
 * Runtime's responsibility; this only enforces structure and bounds.
 */
export function parseEvaluationDefinition(
  value: unknown
): EvaluationDefinitionParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: ["Definition must be a JSON object."] };
  }
  const extra = unexpectedKeys(value, DEFINITION_KEYS);
  if (extra.length > 0)
    errors.push(`Definition has unsupported fields: ${extra.join(", ")}.`);
  if (!isEvaluationDefinitionId(value.id)) {
    errors.push(
      "id must be a lowercase slug (a-z, 0-9, '-') that is not a reserved route name."
    );
  }
  const name = boundedText(value.name, EVALUATION_LIMITS.maxNameLength);
  if (!name) {
    errors.push(
      `name must be non-empty text of at most ${EVALUATION_LIMITS.maxNameLength} characters.`
    );
  }
  const description = boundedText(
    value.description ?? null,
    EVALUATION_LIMITS.maxDescriptionLength
  );
  if (description === false) {
    errors.push(
      `description must be null or text of at most ${EVALUATION_LIMITS.maxDescriptionLength} characters.`
    );
  }
  if (typeof value.enabled !== "boolean") {
    errors.push("enabled must be a boolean.");
  }
  const targets = parseList(
    value.targets,
    "targets",
    EVALUATION_LIMITS.maxTargets,
    errors,
    parseTarget,
    evaluationTargetKey
  );
  const criteria = parseList(
    value.criteria,
    "criteria",
    EVALUATION_CRITERION_TYPES.length,
    errors,
    parseCriterion,
    (criterion) => criterion.type
  );
  const cases = parseList(
    value.cases,
    "cases",
    EVALUATION_LIMITS.maxCases,
    errors,
    parseCase,
    (entry) => entry.id
  );
  let judge: EvaluationJudge | null = null;
  if (
    isRecord(value.judge) &&
    unexpectedKeys(value.judge, JUDGE_KEYS).length === 0 &&
    typeof value.judge.model === "string" &&
    MODEL_ID_PATTERN.test(value.judge.model)
  ) {
    judge = { model: value.judge.model };
  } else {
    errors.push("judge must be an object with only a router model id.");
  }

  if (
    errors.length > 0 ||
    !name ||
    description === false ||
    typeof value.enabled !== "boolean" ||
    !judge
  ) {
    return { ok: false, errors };
  }
  const definition: EvaluationDefinition = {
    id: value.id as string,
    name,
    description,
    enabled: value.enabled,
    targets,
    criteria,
    cases,
    judge
  };
  if (
    new TextEncoder().encode(JSON.stringify(definition)).byteLength >
    EVALUATION_LIMITS.maxDefinitionBytes
  ) {
    return {
      ok: false,
      errors: [
        `Definition exceeds ${EVALUATION_LIMITS.maxDefinitionBytes} bytes when serialized.`
      ]
    };
  }
  return { ok: true, definition };
}

/** A criterion fails when its severity score exceeds the threshold. */
export function evaluationCriterionVerdict(
  score: number | null,
  threshold: number | null
): EvaluationVerdict {
  if (score === null || threshold === null) return "unknown";
  return score > threshold ? "fail" : "pass";
}

/** Aggregate outcome; never reports a pass without judged metrics. */
export function evaluationOutcome(
  metrics: readonly Pick<EvaluationMetric, "verdict">[],
  error: string | null
): EvaluationOutcome {
  if (error) return "error";
  if (metrics.length === 0) return "unknown";
  if (metrics.some((metric) => metric.verdict === "fail")) return "failed";
  if (metrics.some((metric) => metric.verdict === "unknown")) return "unknown";
  return "passed";
}

/** passed / (passed + failed); errors and unknown outcomes are not judged. */
export function evaluationPassRate(
  counts: Pick<EvaluationOutcomeCounts, "passed" | "failed">
): number | null {
  const judged = counts.passed + counts.failed;
  return judged > 0 ? counts.passed / judged : null;
}

export function countEvaluationOutcomes(
  results: readonly Pick<EvaluationResult, "outcome">[]
): EvaluationOutcomeCounts {
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let unknown = 0;
  for (const result of results) {
    if (result.outcome === "passed") passed += 1;
    else if (result.outcome === "failed") failed += 1;
    else if (result.outcome === "error") errored += 1;
    else unknown += 1;
  }
  return { passed, failed, errored, unknown };
}

/**
 * Stored-run status: `completed` only when every expected result was
 * observed; a run with missing results that is no longer executing is
 * `incomplete`, never silently complete.
 */
export function deriveEvaluationRunStatus(input: {
  readonly active: boolean;
  readonly failure: string | null;
  readonly observedResults: number;
  readonly expectedResults: number | null;
}): EvaluationRunStatus {
  if (input.active) return "running";
  if (input.failure) return "failed";
  if (
    input.expectedResults !== null &&
    input.observedResults >= input.expectedResults
  ) {
    return "completed";
  }
  return "incomplete";
}

function subjectFor(
  results: readonly EvaluationResult[]
): EvaluationResultSubject {
  const first = results[0];
  return (
    first?.subject ?? {
      targetKey: null,
      agent: null,
      model: null,
      prompt: null
    }
  );
}

function criteriaComparison(
  results: readonly EvaluationResult[]
): EvaluationCriterionComparison[] {
  const byName = new Map<
    string,
    { judged: number; failed: number; sum: number; scored: number }
  >();
  for (const result of results) {
    for (const metric of result.metrics) {
      const entry = byName.get(metric.name) ?? {
        judged: 0,
        failed: 0,
        sum: 0,
        scored: 0
      };
      if (metric.verdict !== "unknown") entry.judged += 1;
      if (metric.verdict === "fail") entry.failed += 1;
      if (metric.score !== null) {
        entry.sum += metric.score;
        entry.scored += 1;
      }
      byName.set(metric.name, entry);
    }
  }
  return [...byName.entries()]
    .sort(([left], [right]) => KEY_COLLATOR.compare(left, right))
    .map(([name, entry]) => ({
      name,
      judged: entry.judged,
      failed: entry.failed,
      meanScore: entry.scored > 0 ? entry.sum / entry.scored : null
    }));
}

function groupByTarget(
  results: readonly EvaluationResult[]
): Map<string, EvaluationResult[]> {
  const groups = new Map<string, EvaluationResult[]>();
  for (const result of results) {
    const key = result.subject.targetKey;
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(result);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Compare every target of the latest run, side by side and against the same
 * target in the previous run. Results without a recorded target are excluded
 * rather than attributed to a guessed subject.
 */
export function compareEvaluationTargets(input: {
  readonly latestRunId: string;
  readonly latest: readonly EvaluationResult[];
  readonly previousRunId: string | null;
  readonly previous: readonly EvaluationResult[];
}): EvaluationTargetComparison[] {
  const previousByTarget = groupByTarget(input.previous);
  return [...groupByTarget(input.latest).entries()]
    .sort(([left], [right]) => KEY_COLLATOR.compare(left, right))
    .map(([targetKey, results]) => {
      const counts = countEvaluationOutcomes(results);
      const passRate = evaluationPassRate(counts);
      const previousResults = previousByTarget.get(targetKey);
      const previous =
        input.previousRunId && previousResults
          ? {
              runId: input.previousRunId,
              passRate: evaluationPassRate(
                countEvaluationOutcomes(previousResults)
              )
            }
          : null;
      return {
        targetKey,
        subject: subjectFor(results),
        runId: input.latestRunId,
        ...counts,
        passRate,
        criteria: criteriaComparison(results),
        previous,
        passRateDelta:
          passRate !== null && previous && previous.passRate !== null
            ? passRate - previous.passRate
            : null
      };
    });
}

/** Case × target outcome grid for one run; missing cells stay null. */
export function buildEvaluationCaseMatrix(
  runId: string,
  results: readonly EvaluationResult[]
): EvaluationCaseMatrix {
  const targetKeys = [
    ...new Set(
      results.flatMap((result) =>
        result.subject.targetKey ? [result.subject.targetKey] : []
      )
    )
  ].sort(KEY_COLLATOR.compare);
  const caseIds = [
    ...new Set(
      results.flatMap((result) => (result.caseId ? [result.caseId] : []))
    )
  ].sort(KEY_COLLATOR.compare);
  const rows = caseIds.map((caseId) => {
    const cells: Record<string, EvaluationCaseMatrixCell | null> = {};
    for (const key of targetKeys) cells[key] = null;
    for (const result of results) {
      const key = result.subject.targetKey;
      if (result.caseId !== caseId || !key) continue;
      const scores = result.metrics.flatMap((metric) =>
        metric.score === null ? [] : [metric.score]
      );
      cells[key] = {
        resultId: result.id,
        outcome: result.outcome,
        worstScore: scores.length > 0 ? Math.max(...scores) : null
      };
    }
    return { caseId, cells };
  });
  return { runId, targetKeys, rows };
}
