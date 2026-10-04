import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import {
  buildEvaluationCaseMatrix,
  compareEvaluationTargets,
  CONTROL_API_EVALUATION_DETAIL_SCHEMA,
  CONTROL_API_EVALUATION_RESULT_SCHEMA,
  CONTROL_API_EVALUATIONS_SCHEMA,
  type ControlApiEvaluationDefinitionRecord,
  type ControlApiEvaluationDefinitionWriteResponse,
  type ControlApiEvaluationDetailResponse,
  type ControlApiEvaluationResultResponse,
  type ControlApiEvaluationRunResponse,
  type ControlApiEvaluationsResponse,
  deriveEvaluationRunStatus,
  EVALUATION_CRITERION_TYPES,
  EVALUATION_LIMITS,
  type EvaluationDefinition,
  type EvaluationDefinitionValidation,
  evaluationPassRate,
  type EvaluationReferenceStatus,
  type EvaluationResult,
  type EvaluationResultsFilter,
  type EvaluationRunSummary,
  evaluationTargetKey,
  evaluationTargetModel,
  evaluationTargetSubject,
  isEvaluationDefinitionId,
  parseEvaluationDefinition
} from "@simulatorlife/autodev-core";
import {
  EvaluationDefinitionRepository,
  type EvaluationDefinitionWriteFailure,
  EvaluationRepository,
  RuleSyncRepository,
  type StoredEvaluationRun
} from "@simulatorlife/autodev-data";

import {
  compareTimestamps,
  EvaluationRunner,
  type EvaluationRunPlan,
  type EvaluationRunTarget
} from "../evaluations/runner.ts";
import { errorBody, sendJson } from "../router/proxy.ts";
import { RoutedResponsesClient } from "../router/routed-responses.ts";
import { getDefaultExecutionContract } from "../router/subagents.ts";
import { readControlApiJsonObject } from "./body.ts";

export const EVALUATIONS_PATH = "/control/evaluations";
const RESULTS_PREFIX = `${EVALUATIONS_PATH}/results/`;
const DEFINITION_PATH = /^\/control\/evaluations\/([a-z0-9][a-z0-9-]{0,63})$/u;
const RUNS_PATH = /^\/control\/evaluations\/([a-z0-9][a-z0-9-]{0,63})\/runs$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REVISION_PATTERN = /^[0-9a-f]{16}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const AGENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const PROMPT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const LIMIT_PATTERN = /^\d{1,3}$/u;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;
const AUTODEV_ALIAS_PREFIX = "autodev/";
const CONTROL_VARY_HEADER = "Authorization, X-AutoDev-Actor";
const DEFAULT_RESULTS_LIMIT = 100;
const MAX_RESULTS_LIMIT = 500;
const COLLECTION_RUNS_LIMIT = 50;
const DETAIL_RUNS_LIMIT = 20;
const RUN_RESULTS_LIMIT = 500;
const MAX_REPORTED_ERRORS = 5;
const TARGET_TIMEOUT_MS = 300_000;
const JUDGE_TIMEOUT_MS = 120_000;
const ROUTED_RESPONSE_MAX_BYTES = 1_048_576;
/** A bounded definition plus its small write envelope. */
const DEFINITION_WRITE_MAX_BYTES = EVALUATION_LIMITS.maxDefinitionBytes + 4096;

interface EvaluationControlActor {
  readonly actor: string;
  readonly role: "viewer" | "operator";
}

type EvaluationControlAudit = (input: {
  readonly action: string;
  readonly resource: string;
  readonly outcome: "ok" | "denied" | "error";
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}) => void;

export interface EvaluationControlApiDependencies {
  readonly repositoryRoot: string;
  readonly definitions: EvaluationDefinitionRepository;
  readonly store: Pick<
    EvaluationRepository,
    | "listResults"
    | "listRuns"
    | "getResult"
    | "listTraceSpans"
    | "insertResults"
  >;
  readonly runner: EvaluationRunner;
  /** Agent roles declared by the execution contract. */
  readonly agentRoles: () => readonly string[];
}

let dependencyOverride: EvaluationControlApiDependencies | null = null;
let defaultDependencies: EvaluationControlApiDependencies | null = null;

export function setEvaluationControlApiDependenciesForTests(
  dependencies: EvaluationControlApiDependencies | null
): void {
  dependencyOverride = dependencies;
}

function dependenciesFor(
  repositoryRoot: string
): EvaluationControlApiDependencies {
  if (dependencyOverride) return dependencyOverride;
  if (defaultDependencies?.repositoryRoot === repositoryRoot)
    return defaultDependencies;
  const store = new EvaluationRepository();
  const target = new RoutedResponsesClient({
    timeoutMs: TARGET_TIMEOUT_MS,
    maxResponseBytes: ROUTED_RESPONSE_MAX_BYTES
  });
  const judge = new RoutedResponsesClient({
    timeoutMs: JUDGE_TIMEOUT_MS,
    maxResponseBytes: ROUTED_RESPONSE_MAX_BYTES
  });
  defaultDependencies = {
    repositoryRoot,
    definitions: new EvaluationDefinitionRepository(repositoryRoot),
    store,
    runner: new EvaluationRunner({
      createResponse: (request, purpose) =>
        (purpose === "target" ? target : judge).create(request),
      insertResults: (records) => store.insertResults(records)
    }),
    agentRoles: () => Object.keys(getDefaultExecutionContract().roles ?? {})
  };
  return defaultDependencies;
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    status,
    errorBody(message, "autodev_control_api_error", { code }),
    { "cache-control": "no-store", vary: CONTROL_VARY_HEADER }
  );
}

function sendBody(
  response: ServerResponse,
  status: number,
  body: object
): void {
  sendJson(response, status, body as Record<string, unknown>, {
    "cache-control": "no-store",
    vary: CONTROL_VARY_HEADER
  });
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function methodNotAllowed(
  route: {
    readonly response: ServerResponse;
    readonly audit: EvaluationControlAudit;
  },
  method: string,
  pathname: string,
  allow: string,
  message: string
): void {
  if (STATE_CHANGING_METHODS.has(method)) {
    route.audit({
      action: method.toLowerCase(),
      resource: pathname,
      outcome: "denied",
      changes: null,
      reason: "method_not_allowed"
    });
  }
  route.response.setHeader("allow", allow);
  sendError(
    route.response,
    405,
    "autodev_control_api_method_not_allowed",
    message
  );
}

/** AutoDev resources an evaluation definition may reference. */
interface EvaluationReferences {
  readonly agents: ReadonlyMap<string, string>;
  readonly models: ReadonlySet<string>;
  readonly prompts: ReadonlyMap<string, string>;
}

function loadReferences(
  dependencies: EvaluationControlApiDependencies
): EvaluationReferences {
  const root = dependencies.repositoryRoot;
  const models = new Set<string>();
  const catalogPath = path.join(
    root,
    "config",
    "catalogs",
    "codex-model-catalog.json"
  );
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models?: unknown;
    };
    if (Array.isArray(catalog.models)) {
      for (const model of catalog.models) {
        const slug = (model as { slug?: unknown } | null)?.slug;
        if (typeof slug === "string" && slug.trim()) models.add(slug);
      }
    }
  } catch {
    // An unreadable catalog resolves no model; definitions report unknown_model.
  }
  const agents = new Map<string, string>();
  for (const role of dependencies.agentRoles()) {
    const promptPath = path.join(
      root,
      "agents",
      "prompts",
      "roles",
      `${role}.md`
    );
    if (!AGENT_PATTERN.test(role) || !existsSync(promptPath)) continue;
    try {
      const text = readFileSync(promptPath, "utf8").trim();
      if (text && models.has(`${AUTODEV_ALIAS_PREFIX}${role}`))
        agents.set(role, text);
    } catch {
      // Unreadable role prompt: the agent does not resolve.
    }
  }
  const prompts = new Map<string, string>();
  for (const command of new RuleSyncRepository(root).loadCommands()) {
    const body = (command.content ?? "").replace(FRONTMATTER, "").trim();
    if (body) prompts.set(command.name, body);
  }
  return { agents, models, prompts };
}

function targetStatus(
  target: EvaluationDefinition["targets"][number],
  references: EvaluationReferences
): EvaluationReferenceStatus {
  if (target.kind === "agent" && !references.agents.has(target.id))
    return "unknown_agent";
  if (
    target.kind === "model" &&
    (target.id.startsWith(AUTODEV_ALIAS_PREFIX) ||
      !references.models.has(target.id))
  )
    return "unknown_model";
  if (target.prompt && !references.prompts.has(target.prompt))
    return "unknown_prompt";
  return "resolved";
}

function validateReferences(
  definition: EvaluationDefinition,
  references: EvaluationReferences
): EvaluationDefinitionValidation {
  const targets = definition.targets.map((target) => ({
    key: evaluationTargetKey(target),
    target,
    status: targetStatus(target, references)
  }));
  const judge: EvaluationReferenceStatus = references.models.has(
    definition.judge.model
  )
    ? "resolved"
    : "unknown_model";
  return {
    runnable:
      judge === "resolved" &&
      targets.every((target) => target.status === "resolved"),
    targets,
    judge
  };
}

function unresolvedMessage(validation: EvaluationDefinitionValidation): string {
  const problems = [
    ...validation.targets
      .filter((target) => target.status !== "resolved")
      .map((target) => `${target.key}: ${target.status}`),
    ...(validation.judge === "resolved" ? [] : [`judge: ${validation.judge}`])
  ];
  return `Definition references unknown AutoDev resources (${problems
    .slice(0, MAX_REPORTED_ERRORS)
    .join("; ")}).`;
}

function runPlan(
  definition: EvaluationDefinition,
  revision: string,
  references: EvaluationReferences
): EvaluationRunPlan {
  const targets: EvaluationRunTarget[] = definition.targets.map((target) => {
    const instructions = [
      target.kind === "agent" ? references.agents.get(target.id) : undefined,
      target.prompt ? references.prompts.get(target.prompt) : undefined
    ].filter(Boolean);
    return {
      target,
      subject: evaluationTargetSubject(target),
      model: evaluationTargetModel(target),
      instructions: instructions.length > 0 ? instructions.join("\n\n") : null
    };
  });
  return { definition, revision, targets };
}

function storedRunSummary(run: StoredEvaluationRun): EvaluationRunSummary {
  return {
    runId: run.runId,
    definitionId: run.definitionId,
    status: deriveEvaluationRunStatus({
      active: false,
      failure: null,
      observedResults: run.observedResults,
      expectedResults: run.expectedResults
    }),
    startedAt: run.startedAt,
    lastResultAt: run.lastResultAt,
    expectedResults: run.expectedResults,
    observedResults: run.observedResults,
    passed: run.passed,
    failed: run.failed,
    errored: run.errored,
    unknown: run.unknown,
    passRate: evaluationPassRate(run),
    failure: null
  };
}

/** In-process run state is authoritative for runs this Runtime executed. */
function mergeRuns(
  stored: readonly StoredEvaluationRun[],
  live: readonly EvaluationRunSummary[]
): EvaluationRunSummary[] {
  const merged = new Map<string, EvaluationRunSummary>();
  for (const run of stored) merged.set(run.runId, storedRunSummary(run));
  for (const run of live) merged.set(run.runId, run);
  const startedAt = (run: EvaluationRunSummary): string =>
    run.startedAt ?? run.lastResultAt ?? "";
  // Newest first.
  return [...merged.values()].sort((left, right) =>
    compareTimestamps(startedAt(right), startedAt(left))
  );
}

function parseFilter(search: URLSearchParams):
  | {
      readonly ok: true;
      readonly filter: EvaluationResultsFilter;
      readonly limit: number;
    }
  | { readonly ok: false; readonly message: string } {
  const allowed = new Set([
    "definition",
    "run",
    "agent",
    "model",
    "prompt",
    "limit"
  ]);
  for (const key of search.keys()) {
    if (!allowed.has(key) || search.getAll(key).length > 1)
      return { ok: false, message: `Unsupported evaluation filter "${key}".` };
  }
  const filter: {
    definition?: string;
    run?: string;
    agent?: string;
    model?: string;
    prompt?: string;
  } = {};
  const checks: ReadonlyArray<
    [keyof typeof filter, (value: string) => boolean]
  > = [
    ["definition", isEvaluationDefinitionId],
    ["run", (value) => UUID_PATTERN.test(value)],
    ["agent", (value) => AGENT_PATTERN.test(value)],
    ["model", (value) => MODEL_PATTERN.test(value)],
    ["prompt", (value) => PROMPT_PATTERN.test(value)]
  ];
  for (const [key, valid] of checks) {
    const value = search.get(key);
    if (value === null) continue;
    if (!valid(value))
      return { ok: false, message: `Invalid evaluation filter "${key}".` };
    filter[key] = value;
  }
  const rawLimit = search.get("limit");
  const limit =
    rawLimit === null
      ? DEFAULT_RESULTS_LIMIT
      : LIMIT_PATTERN.test(rawLimit)
        ? Number(rawLimit)
        : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS_LIMIT) {
    return {
      ok: false,
      message: `limit must be an integer between 1 and ${MAX_RESULTS_LIMIT}.`
    };
  }
  return { ok: true, filter, limit };
}

async function collectionView(
  dependencies: EvaluationControlApiDependencies,
  search: URLSearchParams,
  response: ServerResponse
): Promise<void> {
  const parsed = parseFilter(search);
  if (!parsed.ok) {
    sendError(
      response,
      400,
      "autodev_control_api_invalid_filter",
      parsed.message
    );
    return;
  }
  const catalog = dependencies.definitions.readCatalog();
  const references = loadReferences(dependencies);
  const [results, storedRuns] = await Promise.all([
    dependencies.store.listResults(parsed.filter, parsed.limit),
    dependencies.store.listRuns({ limit: COLLECTION_RUNS_LIMIT })
  ]);
  const runs = mergeRuns(
    storedRuns.status === "available" ? storedRuns.value : [],
    dependencies.runner.summaries()
  );
  const definitions: ControlApiEvaluationDefinitionRecord[] =
    catalog.definitions.map(({ definition, revision }) => ({
      definition,
      revision,
      validation: validateReferences(definition, references),
      latestRun: runs.find((run) => run.definitionId === definition.id) ?? null
    }));
  const unavailable =
    results.status === "unavailable"
      ? results
      : storedRuns.status === "unavailable"
        ? storedRuns
        : null;
  const body: ControlApiEvaluationsResponse = {
    schema: CONTROL_API_EVALUATIONS_SCHEMA,
    definitionsSource: "config/evaluations.json",
    catalogStatus: catalog.status,
    catalogErrors: catalog.errors,
    definitions,
    criterionTypes: EVALUATION_CRITERION_TYPES,
    resultsSource: "openlit_evaluation",
    resultsStatus: unavailable ? "unavailable" : "available",
    resultsMessage: unavailable?.message ?? null,
    filter: parsed.filter,
    results: results.status === "available" ? results.value : [],
    runs
  };
  sendBody(response, 200, body);
}

function findDefinition(
  dependencies: EvaluationControlApiDependencies,
  id: string,
  response: ServerResponse
): { definition: EvaluationDefinition; revision: string } | null {
  const catalog = dependencies.definitions.readCatalog();
  if (catalog.status !== "valid") {
    sendError(
      response,
      503,
      "autodev_control_api_evaluation_catalog_unavailable",
      `config/evaluations.json is ${catalog.status}.`
    );
    return null;
  }
  const entry = catalog.definitions.find(
    (candidate) => candidate.definition.id === id
  );
  if (!entry) {
    sendError(
      response,
      404,
      "autodev_control_api_unknown_evaluation",
      "Unknown evaluation definition."
    );
    return null;
  }
  return entry;
}

/** Detail accepts at most one `run` UUID; null signals an invalid query. */
function requestedRunId(
  search: URLSearchParams
): { readonly run: string | null } | null {
  const run = search.get("run");
  if (
    [...search.keys()].some((key) => key !== "run") ||
    search.getAll("run").length > 1 ||
    (run !== null && !UUID_PATTERN.test(run))
  ) {
    return null;
  }
  return { run };
}

interface RunEvidence {
  readonly resultsStatus: "available" | "unavailable";
  readonly resultsMessage: string | null;
  readonly comparisons: ControlApiEvaluationDetailResponse["comparisons"];
  readonly caseMatrix: ControlApiEvaluationDetailResponse["caseMatrix"];
  readonly results: EvaluationResult[];
}

/** Results of the selected run compared target by target with the previous run. */
async function runEvidence(
  dependencies: EvaluationControlApiDependencies,
  id: string,
  selected: EvaluationRunSummary | null,
  previous: EvaluationRunSummary | null
): Promise<RunEvidence> {
  const empty = {
    resultsStatus: "available" as const,
    resultsMessage: null,
    comparisons: [],
    caseMatrix: null,
    results: []
  };
  if (!selected) return empty;
  const [latest, prior] = await Promise.all([
    dependencies.store.listResults(
      { definition: id, run: selected.runId },
      RUN_RESULTS_LIMIT
    ),
    previous
      ? dependencies.store.listResults(
          { definition: id, run: previous.runId },
          RUN_RESULTS_LIMIT
        )
      : Promise.resolve({ status: "available" as const, value: [] })
  ]);
  if (latest.status === "unavailable" || prior.status === "unavailable") {
    const failed = latest.status === "unavailable" ? latest : prior;
    return {
      ...empty,
      resultsStatus: "unavailable",
      resultsMessage: failed.status === "unavailable" ? failed.message : null
    };
  }
  return {
    ...empty,
    comparisons: compareEvaluationTargets({
      latestRunId: selected.runId,
      latest: latest.value,
      previousRunId: previous?.runId ?? null,
      previous: prior.value
    }),
    caseMatrix: buildEvaluationCaseMatrix(selected.runId, latest.value),
    results: latest.value
  };
}

async function detailView(
  dependencies: EvaluationControlApiDependencies,
  id: string,
  search: URLSearchParams,
  response: ServerResponse
): Promise<void> {
  const requested = requestedRunId(search);
  if (!requested) {
    sendError(
      response,
      400,
      "autodev_control_api_invalid_filter",
      "Evaluation detail accepts only a run UUID filter."
    );
    return;
  }
  const entry = findDefinition(dependencies, id, response);
  if (!entry) return;
  const storedRuns = await dependencies.store.listRuns({
    definition: id,
    limit: DETAIL_RUNS_LIMIT
  });
  const runs = mergeRuns(
    storedRuns.status === "available" ? storedRuns.value : [],
    dependencies.runner.summaries(id)
  );
  const selectedIndex =
    requested.run === null
      ? 0
      : runs.findIndex((run) => run.runId === requested.run);
  if (selectedIndex === -1) {
    sendError(
      response,
      404,
      "autodev_control_api_unknown_evaluation_run",
      "Unknown evaluation run for this definition."
    );
    return;
  }
  const selected = runs[selectedIndex] ?? null;
  const evidence =
    storedRuns.status === "available"
      ? await runEvidence(
          dependencies,
          id,
          selected,
          runs[selectedIndex + 1] ?? null
        )
      : {
          resultsStatus: "unavailable" as const,
          resultsMessage: storedRuns.message,
          comparisons: [],
          caseMatrix: null,
          results: []
        };
  const body: ControlApiEvaluationDetailResponse = {
    schema: CONTROL_API_EVALUATION_DETAIL_SCHEMA,
    definition: entry.definition,
    revision: entry.revision,
    validation: validateReferences(
      entry.definition,
      loadReferences(dependencies)
    ),
    runs,
    selectedRunId: selected?.runId ?? null,
    ...evidence
  };
  sendBody(response, 200, body);
}

async function resultView(
  dependencies: EvaluationControlApiDependencies,
  id: string,
  response: ServerResponse
): Promise<void> {
  const read = await dependencies.store.getResult(id);
  if (read.status === "unavailable") {
    sendError(
      response,
      503,
      "autodev_control_api_evaluation_store_unavailable",
      read.message
    );
    return;
  }
  if (!read.value) {
    sendError(
      response,
      404,
      "autodev_control_api_unknown_evaluation_result",
      "Unknown evaluation result."
    );
    return;
  }
  const result = read.value;
  const spans =
    result.traceId || result.spanId
      ? await dependencies.store.listTraceSpans({
          traceId: result.traceId,
          spanId: result.spanId
        })
      : null;
  const body: ControlApiEvaluationResultResponse = {
    schema: CONTROL_API_EVALUATION_RESULT_SCHEMA,
    result,
    traceStatus:
      spans === null
        ? "not_observed"
        : spans.status === "unavailable"
          ? "unavailable"
          : spans.value.length > 0
            ? "available"
            : "not_observed",
    traceMessage: spans?.status === "unavailable" ? spans.message : null,
    spans: spans?.status === "available" ? spans.value : []
  };
  sendBody(response, 200, body);
}

const WRITE_FAILURES: Readonly<
  Record<EvaluationDefinitionWriteFailure, { status: number; code: string }>
> = {
  catalog_unavailable: {
    status: 503,
    code: "autodev_control_api_evaluation_catalog_unavailable"
  },
  catalog_invalid: {
    status: 409,
    code: "autodev_control_api_evaluation_catalog_invalid"
  },
  revision_conflict: {
    status: 409,
    code: "autodev_control_api_revision_conflict"
  },
  not_found: { status: 404, code: "autodev_control_api_unknown_evaluation" },
  limit_exceeded: {
    status: 409,
    code: "autodev_control_api_evaluation_limit"
  },
  persistence_failed: {
    status: 500,
    code: "autodev_control_api_persistence_failed"
  }
};

interface MutationContext {
  readonly dependencies: EvaluationControlApiDependencies;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly actor: EvaluationControlActor;
  readonly audit: EvaluationControlAudit;
  readonly action: string;
  readonly resource: string;
}

function deny(
  context: MutationContext,
  status: number,
  code: string,
  message: string,
  reason: string,
  changes: Record<string, unknown> | null = null
): void {
  context.audit({
    action: context.action,
    resource: context.resource,
    outcome: status >= 500 ? "error" : "denied",
    changes,
    reason
  });
  sendError(context.response, status, code, message);
}

async function operatorBody(
  context: MutationContext,
  keys: readonly string[],
  maxBytes?: number
): Promise<Record<string, unknown> | null> {
  if (context.actor.role !== "operator") {
    deny(
      context,
      403,
      "autodev_control_api_viewer_forbidden",
      "Operator access is required to change evaluations.",
      "viewer_cannot_mutate"
    );
    return null;
  }
  const parsed = await readControlApiJsonObject(context.request, maxBytes);
  if (!parsed.ok) {
    deny(context, parsed.status, parsed.code, parsed.message, parsed.code);
    return null;
  }
  const bodyKeys = Object.keys(parsed.body);
  if (
    bodyKeys.length !== keys.length ||
    bodyKeys.some((key) => !keys.includes(key))
  ) {
    deny(
      context,
      400,
      "autodev_control_api_bad_body",
      `Body must contain exactly: ${keys.join(", ")}.`,
      "invalid_body"
    );
    return null;
  }
  return parsed.body;
}

async function putDefinition(
  context: MutationContext,
  id: string
): Promise<void> {
  const body = await operatorBody(
    context,
    ["definition", "expectedRevision"],
    DEFINITION_WRITE_MAX_BYTES
  );
  if (!body) return;
  const expectedRevision = body.expectedRevision;
  if (
    expectedRevision !== null &&
    (typeof expectedRevision !== "string" ||
      !REVISION_PATTERN.test(expectedRevision))
  ) {
    deny(
      context,
      400,
      "autodev_control_api_bad_body",
      "expectedRevision must be a definition revision or null.",
      "invalid_body"
    );
    return;
  }
  const parsed = parseEvaluationDefinition(body.definition);
  if (!parsed.ok) {
    deny(
      context,
      400,
      "autodev_control_api_invalid_evaluation",
      `Invalid evaluation definition: ${parsed.errors
        .slice(0, MAX_REPORTED_ERRORS)
        .join(" ")}`,
      "invalid_definition"
    );
    return;
  }
  if (parsed.definition.id !== id) {
    deny(
      context,
      400,
      "autodev_control_api_invalid_evaluation",
      "Definition id must match the request path.",
      "id_mismatch"
    );
    return;
  }
  const validation = validateReferences(
    parsed.definition,
    loadReferences(context.dependencies)
  );
  if (!validation.runnable) {
    deny(
      context,
      422,
      "autodev_control_api_unresolved_evaluation_reference",
      unresolvedMessage(validation),
      "unresolved_reference"
    );
    return;
  }
  const written = context.dependencies.definitions.upsert(
    parsed.definition,
    expectedRevision
  );
  if (!written.ok) {
    const failure = WRITE_FAILURES[written.reason];
    deny(
      context,
      failure.status,
      failure.code,
      written.message,
      written.reason
    );
    return;
  }
  context.audit({
    action: context.action,
    resource: context.resource,
    outcome: "ok",
    changes: {
      definitionId: id,
      result: written.result,
      previousRevision: expectedRevision,
      revision: written.revision
    }
  });
  const responseBody: ControlApiEvaluationDefinitionWriteResponse = {
    schema: "autodev-control-evaluation-definition-v1",
    result: written.result === "created" ? "created" : "updated",
    definitionId: id,
    revision: written.revision
  };
  sendBody(
    context.response,
    written.result === "created" ? 201 : 200,
    responseBody
  );
}

async function deleteDefinition(
  context: MutationContext,
  id: string
): Promise<void> {
  const body = await operatorBody(context, ["expectedRevision"]);
  if (!body) return;
  if (
    typeof body.expectedRevision !== "string" ||
    !REVISION_PATTERN.test(body.expectedRevision)
  ) {
    deny(
      context,
      400,
      "autodev_control_api_bad_body",
      "expectedRevision must be the definition revision.",
      "invalid_body"
    );
    return;
  }
  if (context.dependencies.runner.isActive(id)) {
    deny(
      context,
      409,
      "autodev_control_api_evaluation_run_active",
      "A run of this definition is in progress.",
      "run_active"
    );
    return;
  }
  const written = context.dependencies.definitions.delete(
    id,
    body.expectedRevision
  );
  if (!written.ok) {
    const failure = WRITE_FAILURES[written.reason];
    deny(
      context,
      failure.status,
      failure.code,
      written.message,
      written.reason
    );
    return;
  }
  context.audit({
    action: context.action,
    resource: context.resource,
    outcome: "ok",
    changes: {
      definitionId: id,
      result: "deleted",
      previousRevision: body.expectedRevision
    }
  });
  const responseBody: ControlApiEvaluationDefinitionWriteResponse = {
    schema: "autodev-control-evaluation-definition-v1",
    result: "deleted",
    definitionId: id,
    revision: null
  };
  sendBody(context.response, 200, responseBody);
}

async function startRun(context: MutationContext, id: string): Promise<void> {
  const body = await operatorBody(context, ["idempotencyKey"]);
  if (!body) return;
  const idempotencyKey = body.idempotencyKey;
  if (
    typeof idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    deny(
      context,
      400,
      "autodev_control_api_bad_body",
      "idempotencyKey must be 8-128 URL-safe characters.",
      "invalid_body"
    );
    return;
  }
  const catalog = context.dependencies.definitions.readCatalog();
  const entry =
    catalog.status === "valid"
      ? catalog.definitions.find((candidate) => candidate.definition.id === id)
      : undefined;
  if (catalog.status !== "valid") {
    deny(
      context,
      503,
      "autodev_control_api_evaluation_catalog_unavailable",
      `config/evaluations.json is ${catalog.status}.`,
      "catalog_unavailable"
    );
    return;
  }
  if (!entry) {
    deny(
      context,
      404,
      "autodev_control_api_unknown_evaluation",
      "Unknown evaluation definition.",
      "unknown_evaluation"
    );
    return;
  }
  if (!entry.definition.enabled) {
    deny(
      context,
      409,
      "autodev_control_api_evaluation_disabled",
      "Disabled evaluation definitions cannot start runs.",
      "definition_disabled"
    );
    return;
  }
  const references = loadReferences(context.dependencies);
  const validation = validateReferences(entry.definition, references);
  if (!validation.runnable) {
    deny(
      context,
      422,
      "autodev_control_api_unresolved_evaluation_reference",
      unresolvedMessage(validation),
      "unresolved_reference"
    );
    return;
  }
  const started = context.dependencies.runner.start(
    runPlan(entry.definition, entry.revision, references),
    idempotencyKey
  );
  if (!started.ok) {
    deny(
      context,
      started.reason === "runner_busy" ? 429 : 409,
      `autodev_control_api_evaluation_${started.reason}`,
      started.message,
      started.reason
    );
    return;
  }
  context.audit({
    action: context.action,
    resource: context.resource,
    outcome: "ok",
    changes: {
      definitionId: id,
      revision: entry.revision,
      runId: started.run.runId,
      result: started.result
    }
  });
  const responseBody: ControlApiEvaluationRunResponse = {
    schema: "autodev-control-evaluation-run-v1",
    result: started.result,
    run: started.run
  };
  sendBody(
    context.response,
    started.result === "accepted" ? 202 : 200,
    responseBody
  );
}

interface EvaluationRoute {
  readonly dependencies: EvaluationControlApiDependencies;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly actor: EvaluationControlActor;
  readonly audit: EvaluationControlAudit;
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
}

function mutation(route: EvaluationRoute, action: string): MutationContext {
  return {
    dependencies: route.dependencies,
    request: route.request,
    response: route.response,
    actor: route.actor,
    audit: route.audit,
    action,
    resource: route.pathname
  };
}

async function routeCollection(route: EvaluationRoute): Promise<void> {
  if (route.method !== "GET") {
    methodNotAllowed(
      route,
      route.method,
      route.pathname,
      "GET",
      "The evaluation collection is read via GET."
    );
    return;
  }
  await collectionView(route.dependencies, route.search, route.response);
}

async function routeResult(route: EvaluationRoute, id: string): Promise<void> {
  if (!UUID_PATTERN.test(id)) {
    sendError(
      route.response,
      404,
      "autodev_control_api_unknown_evaluation_result",
      "Unknown evaluation result."
    );
    return;
  }
  if (route.method !== "GET") {
    methodNotAllowed(
      route,
      route.method,
      route.pathname,
      "GET",
      "Evaluation results are read-only."
    );
    return;
  }
  await resultView(route.dependencies, id, route.response);
}

async function routeRuns(route: EvaluationRoute, id: string): Promise<void> {
  if (route.method !== "POST") {
    methodNotAllowed(
      route,
      route.method,
      route.pathname,
      "POST",
      "Evaluation runs are started via POST."
    );
    return;
  }
  await startRun(mutation(route, "start_evaluation_run"), id);
}

async function routeDefinition(
  route: EvaluationRoute,
  id: string
): Promise<void> {
  if (route.method === "GET") {
    await detailView(route.dependencies, id, route.search, route.response);
  } else if (route.method === "PUT") {
    await putDefinition(mutation(route, "put_evaluation_definition"), id);
  } else if (route.method === "DELETE") {
    await deleteDefinition(mutation(route, "delete_evaluation_definition"), id);
  } else {
    methodNotAllowed(
      route,
      route.method,
      route.pathname,
      "GET, PUT, DELETE",
      "Evaluation definitions support GET, PUT, and DELETE."
    );
  }
}

function definitionIdFrom(match: RegExpMatchArray | null): string | null {
  const id = match?.[1];
  return isEvaluationDefinitionId(id) ? id : null;
}

/**
 * Typed `/control/evaluations` resource family: GET collection/detail/result
 * reads, operator-only definition PUT/DELETE, and run POST. No other method
 * or path is accepted.
 */
export async function handleEvaluationsControlApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: EvaluationControlActor,
  audit: EvaluationControlAudit,
  repositoryRoot: string
): Promise<boolean> {
  if (
    pathname !== EVALUATIONS_PATH &&
    !pathname.startsWith(`${EVALUATIONS_PATH}/`)
  )
    return false;
  const route: EvaluationRoute = {
    dependencies: dependenciesFor(repositoryRoot),
    request,
    response,
    actor,
    audit,
    method: (request.method ?? "GET").toUpperCase(),
    pathname,
    search: new URL(request.url ?? "/", "http://127.0.0.1").searchParams
  };
  const runsId = definitionIdFrom(pathname.match(RUNS_PATH));
  const definitionId = definitionIdFrom(pathname.match(DEFINITION_PATH));
  if (pathname === EVALUATIONS_PATH) await routeCollection(route);
  else if (pathname.startsWith(RESULTS_PREFIX))
    await routeResult(route, pathname.slice(RESULTS_PREFIX.length));
  else if (runsId) await routeRuns(route, runsId);
  else if (definitionId) await routeDefinition(route, definitionId);
  else
    sendError(
      response,
      404,
      "autodev_control_api_unknown_path",
      "Unknown Control API path."
    );
  return true;
}
