import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import {
  assertMemoryInjectionOutcomeCohortFilter,
  assertMemoryInjectionUseCohortFilter,
  assertMemorySessionOutcomeCohortFilter,
  type ControlApiMemoryCohortsResponse,
  type ControlApiMemoryExperienceDetailResponse,
  type ControlApiMemoryExperiencesResponse,
  type ControlApiMemoryHistoryResponse,
  type ControlApiMemoryInjectionOutcomesResponse,
  type ControlApiMemoryInjectionUseAssessmentsResponse,
  type ControlApiMemoryRecordDetailResponse,
  type ControlApiMemoryRecordsResponse,
  type ControlApiMemoryStatusResponse,
  type ControlApiMemoryUseCohortsResponse,
  type ControlApiMemoryWhyResponse,
  type EvidenceReference,
  MEMORY_EVIDENCE_KINDS,
  EXPERIENCE_OUTCOMES,
  type ExperienceEnvelope,
  MEMORY_EXECUTION_MODES,
  isMemoryExperiencePurgeReason,
  MEMORY_INJECTION_RESULTS,
  MEMORY_KINDS,
  MEMORY_MAX_TIME_WINDOW_MS,
  MEMORY_OUTCOME_REPORT_KINDS,
  MEMORY_REASON_CODES,
  MEMORY_SESSION_COHORT_ASSIGNED_MODES,
  MEMORY_STATUSES,
  MEMORY_USE_COHORT_ASSIGNED_MODES,
  MEMORY_USE_KINDS,
  type MemoryActor,
  type MemoryInjectionOutcomeCohortFilter,
  type MemoryInjectionOutcomeCohortPage,
  type MemoryInjectionUseCohortFilter,
  type MemoryKind,
  type MemoryOutcomeReport,
  type MemoryOutcomeReportKind,
  type MemoryReadContext,
  type MemoryReasonCode,
  type MemoryRecord,
  type MemoryScope,
  type MemorySessionOutcomeCohortFilter,
  type MemorySessionOutcomeReport,
  type MemoryStatus,
  type MemoryUseKind
} from "@simulatorlife/autodev-core";
import {
  type MemoryAssessmentCohortReader,
  type MemoryAssessmentReader,
  type MemoryAssessmentRecorder,
  MAX_CLAIM_LENGTH,
  MAX_EVIDENCE_REVISION_CHARACTERS,
  MAX_EVIDENCE_URI_CHARACTERS,
  MAX_QUERY_LENGTH,
  MemoryAuthorizationError,
  MemoryConflictError,
  type MemoryExperienceCaptureInput,
  type MemoryExperiencePurger,
  type MemoryProposalInput,
  type MemoryService,
  type MemorySkillPromotionArtifact,
  MemoryValidationError
} from "@simulatorlife/autodev-runtime/memory";

import {
  createOrchestratorMemoryService,
  currentRouterMemoryMode,
  observeMemoryStorageStatus,
  trustedMemoryContextForSession
} from "../router/memory-injection.ts";
import { errorBody, sendJson } from "../router/proxy.ts";
import { readControlApiJsonObject } from "./body.ts";
import {
  type ClaudeCodeWorkspaceBinding,
  loadClaudeCodeCaptureBinding,
  resolveClaudeCodeTranscriptBinding,
  resolveClaudeCodeWorkspaceBinding
} from "./claude-code-binding.ts";

const MEMORY_PATH_PREFIX = "/control/memory/";
const MEMORY_CAPTURE_PATH = `${MEMORY_PATH_PREFIX}capture`;
const MEMORY_CLAUDE_CAPTURE_PATH = `${MEMORY_PATH_PREFIX}claude-code/capture`;
const CLAUDE_CODE_BINDING_PROVIDER = "claude-code" as const;
const CLAUDE_CODE_CAPTURE_ACTOR = "autodev-claude-code-session-end";
const CODEX_CAPTURE_ACTOR = "autodev-codex-session-end";
const MAX_NATIVE_CAPTURE_PATH_LENGTH = 4096;
const MEMORY_CAPTURE_ACTION = "capture_experience";
const MEMORY_PROMOTE_SKILL_ACTION = "promote-skill";
const MEMORY_EXPERIENCE_RESOURCE = "/control/memory/experiences";
const MEMORY_COHORT_RESOURCE = "/control/memory/cohorts";
const MEMORY_SESSION_COHORT_RESOURCE = "/control/memory/session-cohorts";
const MEMORY_USE_COHORT_RESOURCE = "/control/memory/use-cohorts";
const MEMORY_EXPERIENCE_NOT_FOUND = "Memory experience was not found.";
const MAX_NATIVE_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_FILTER_VALUE = 256;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE_OFFSET = 100_000;
const MAX_EVIDENCE_REFERENCES = 64;
const MAX_EXPERIENCE_IDS = 64;
/**
 * The longest task an operator may put in a research body.
 *
 * Deliberately its own constant rather than a restatement of the claim or query
 * bounds it once sat between: `MemoryService.research` requires only a non-empty
 * task and bounds no other field at this boundary, so this is a limit on what
 * this API will accept rather than one it is forwarding. The claim and query
 * bounds it used to serve are owned by the service and imported from there,
 * because the service is what refuses them and a local copy could be edited
 * without the rule that enforces it noticing.
 */
const MAX_RESEARCH_TASK_CHARACTERS = 4000;
const MEMORY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const MEMORY_RECORDS_ROUTE = "records" as const;
const MEMORY_EXPERIENCES_ROUTE = "experiences" as const;
const MEMORY_COHORTS_ROUTE = "cohorts" as const;
const MEMORY_SESSION_COHORTS_ROUTE = "session-cohorts" as const;
const MEMORY_USE_COHORTS_ROUTE = "use-cohorts" as const;
const MEMORY_STATUS_ROUTE = "status" as const;
const MEMORY_STATUS_PATH = `${MEMORY_PATH_PREFIX}${MEMORY_STATUS_ROUTE}`;
const MEMORY_PURGE_ACTION = "purge" as const;
const MEMORY_OUTCOMES_ACTION = "outcomes" as const;
const MEMORY_SESSION_OUTCOME_ACTION = "session-outcome" as const;
const MEMORY_SESSION_OUTCOMES_ACTION = "session-outcomes" as const;
const MEMORY_USE_ASSESSMENTS_ACTION = "use-assessments" as const;
const MEMORY_TASK_HISTORY_ACCESS_REQUIRED =
  "Operator task-history access is required.";
const MEMORY_EXPERIENCE_ID_REQUIRED = "An experience id is required.";
const MEMORY_FILTERS_INVALID = "Memory filters are invalid or incomplete.";
const MEMORY_CONTROL_API_ORIGIN = "http://127.0.0.1";
const PAGE_NUMBER_PATTERN = /^(0|[1-9]\d{0,8})$/u;


type MemoryControlRoute = {
  readonly resource:
    | typeof MEMORY_RECORDS_ROUTE
    | typeof MEMORY_EXPERIENCES_ROUTE
    | typeof MEMORY_COHORTS_ROUTE
    | typeof MEMORY_SESSION_COHORTS_ROUTE
    | typeof MEMORY_USE_COHORTS_ROUTE
    | typeof MEMORY_STATUS_ROUTE;
  readonly id?: string;
  readonly action?:
    | "history"
    | "why"
    | "verify"
    | "invalidate"
    | "revise"
    | "supersede"
    | typeof MEMORY_PURGE_ACTION
    | typeof MEMORY_OUTCOMES_ACTION
    | typeof MEMORY_SESSION_OUTCOME_ACTION
    | typeof MEMORY_SESSION_OUTCOMES_ACTION
    | typeof MEMORY_USE_ASSESSMENTS_ACTION
    | typeof MEMORY_PROMOTE_SKILL_ACTION;
};

interface MemoryControlActor {
  readonly actor: string;
  readonly role: "viewer" | "operator";
}

interface MemoryControlAudit {
  (input: {
    readonly action: string;
    readonly resource: string;
    readonly outcome: "ok" | "denied" | "error";
    readonly changes: Record<string, unknown> | null;
    readonly reason?: string;
  }): void;
}

class MemoryScopeAccessError extends Error {}

function sendMemoryError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  sendJson(
    response,
    status,
    errorBody(message, "autodev_memory_control_error", { code }),
    { "cache-control": "no-store" }
  );
}

function parseRoute(pathname: string): MemoryControlRoute | null {
  if (!pathname.startsWith(MEMORY_PATH_PREFIX)) return null;
  const parts = pathname.slice(MEMORY_PATH_PREFIX.length).split("/");
  const resource = parts[0];
  if (
    resource !== MEMORY_RECORDS_ROUTE &&
    resource !== MEMORY_EXPERIENCES_ROUTE &&
    resource !== MEMORY_COHORTS_ROUTE &&
    resource !== MEMORY_SESSION_COHORTS_ROUTE &&
    resource !== MEMORY_USE_COHORTS_ROUTE &&
    resource !== MEMORY_STATUS_ROUTE
  )
    return null;
  if (
    (resource === MEMORY_COHORTS_ROUTE ||
      resource === MEMORY_SESSION_COHORTS_ROUTE ||
      resource === MEMORY_USE_COHORTS_ROUTE ||
      resource === MEMORY_STATUS_ROUTE) &&
    parts.length !== 1
  )
    return null;
  if (parts.length === 1) return { resource };
  if (parts.length > 3 || !parts[1]) return null;
  let id: string;
  try {
    id = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (!MEMORY_ID_PATTERN.test(id)) return null;
  if (parts.length === 2) return { resource, id };
  const action = parts[2];
  const recordAction =
    resource === MEMORY_RECORDS_ROUTE &&
    [
      "history",
      "why",
      "verify",
      "invalidate",
      "revise",
      "supersede",
      MEMORY_PROMOTE_SKILL_ACTION
    ].includes(action ?? "");
  const experienceAction =
    resource === MEMORY_EXPERIENCES_ROUTE &&
    (action === MEMORY_PURGE_ACTION ||
      action === MEMORY_OUTCOMES_ACTION ||
      action === MEMORY_SESSION_OUTCOME_ACTION ||
      action === MEMORY_SESSION_OUTCOMES_ACTION ||
      action === MEMORY_USE_ASSESSMENTS_ACTION);
  if (!recordAction && !experienceAction) return null;
  return {
    resource,
    id,
    action: action as NonNullable<MemoryControlRoute["action"]>
  };
}

function oneFilter(
  params: URLSearchParams,
  name: string,
  required = false
): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw new TypeError(`Duplicate '${name}' filter.`);
  const value = values[0]?.trim();
  if (!value && required) throw new TypeError(`'${name}' filter is required.`);
  if (
    value &&
    (value.length > MAX_FILTER_VALUE || hasControlCharacters(value))
  ) {
    throw new TypeError(`Invalid '${name}' filter.`);
  }
  return value;
}

function hasControlCharacters(value: string, allowLineBreaks = false): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      (code <= 31 &&
        (!allowLineBreaks || (code !== 9 && code !== 10 && code !== 13))) ||
      code === 127
    ) {
      return true;
    }
  }
  return false;
}

function pageNumber(
  params: URLSearchParams,
  name: string,
  fallback: number
): number {
  const raw = oneFilter(params, name);
  if (raw === undefined) return fallback;
  if (!PAGE_NUMBER_PATTERN.test(raw))
    throw new TypeError(`Invalid '${name}' filter.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value))
    throw new TypeError(`Invalid '${name}' filter.`);
  return value;
}

function valuesFromQuery<T extends string>(
  params: URLSearchParams,
  name: string,
  allowed: readonly T[]
): readonly T[] {
  const raw = params.getAll(name);
  const values = raw
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  if (values.some((value) => !allowed.includes(value as T)))
    throw new TypeError(`Invalid '${name}' filter.`);
  return [...new Set(values as T[])];
}

function readContext(
  params: URLSearchParams,
  actor: MemoryControlActor
): MemoryReadContext {
  const workspaceId = oneFilter(params, "workspaceId", true)!;
  const repositoryId = oneFilter(params, "repositoryId");
  const role = oneFilter(params, "role");
  const taskId = oneFilter(params, "taskId");
  const runId = oneFilter(params, "runId");
  const agentId = oneFilter(params, "agentId");
  if ((taskId === undefined) !== (runId === undefined))
    throw new TypeError("'taskId' and 'runId' must be supplied together.");
  if (agentId && !taskId)
    throw new TypeError("'agentId' requires task and run filters.");
  const globalRequests = params.getAll("includeGlobal");
  if (
    globalRequests.length > 1 ||
    (globalRequests.length === 1 &&
      globalRequests[0] !== "true" &&
      globalRequests[0] !== "false")
  ) {
    throw new TypeError("Invalid 'includeGlobal' filter.");
  }
  const canReadGlobal =
    globalRequests[0] === "true" &&
    actor.role === "operator" &&
    process.env.AUTODEV_MEMORY_READ_GLOBAL === "1";
  if (globalRequests[0] === "true" && !canReadGlobal)
    throw new MemoryScopeAccessError("Global memory access is not granted.");
  const historyRequests = params.getAll("includeTaskHistory");
  if (
    historyRequests.length > 1 ||
    (historyRequests.length === 1 &&
      historyRequests[0] !== "true" &&
      historyRequests[0] !== "false")
  ) {
    throw new TypeError("Invalid 'includeTaskHistory' filter.");
  }
  const canReadTaskHistory =
    historyRequests[0] === "true" &&
    actor.role === "operator" &&
    process.env.AUTODEV_MEMORY_READ_TASK_HISTORY === "1";
  if (historyRequests[0] === "true" && !canReadTaskHistory)
    throw new MemoryScopeAccessError("Task history access is not granted.");
  return {
    workspaceId,
    ...(repositoryId ? { repositoryId } : {}),
    ...(role ? { role } : {}),
    ...(taskId ? { taskId, runId: runId! } : {}),
    ...(agentId ? { agentId } : {}),
    canReadGlobal,
    canReadTaskHistory
  };
}

function pagination(params: URLSearchParams): {
  limit: number;
  offset: number;
} {
  const limit = pageNumber(params, "limit", 50);
  const offset = pageNumber(params, "offset", 0);
  if (limit < 1 || limit > MAX_PAGE_SIZE)
    throw new TypeError("'limit' must be between 1 and 100.");
  if (offset > MAX_PAGE_OFFSET)
    throw new TypeError("'offset' exceeds the memory browsing bound.");
  return { limit, offset };
}

/**
 * The list `query` filter.
 *
 * Carries no length check of its own: `oneFilter` has already bounded every
 * filter value at `MAX_FILTER_VALUE`, so a comparison against the service's
 * much larger query bound could only ever be false. There was one here, and it
 * made this function read as though the search filter were bounded at 4000
 * characters when the number an operator actually meets is 256 -- the query
 * bound belongs to the research body's query, which is validated separately.
 */
function queryText(params: URLSearchParams): string | undefined {
  return oneFilter(params, "query");
}

/**
 * The bounded time window a list request asked for.
 *
 * Optional on purpose, because a list with no window is a legitimate request --
 * it is what every caller sent before the Console could express one. Supplied,
 * it is all-or-nothing and bounded: half a window is a since-query written as a
 * range, and the two are the same filter in two costumes, so an unambiguous
 * form is required rather than inferred. The 365-day ceiling is the same bound
 * the cohort reads carry, so one window rule governs every Memory time filter
 * instead of a per-route pair of them.
 */
function occurredWindow(params: URLSearchParams): {
  occurredFrom?: string;
  occurredUntil?: string;
} {
  const from = oneFilter(params, "occurredFrom");
  const until = oneFilter(params, "occurredUntil");
  if (from === undefined && until === undefined) return {};
  if (from === undefined || until === undefined) {
    throw new TypeError(
      "'occurredFrom' and 'occurredUntil' must be supplied together."
    );
  }
  const fromMs = Date.parse(from);
  const untilMs = Date.parse(until);
  if (!Number.isFinite(fromMs) || !Number.isFinite(untilMs)) {
    throw new TypeError("The memory time window must be valid timestamps.");
  }
  if (untilMs < fromMs) {
    throw new TypeError(
      "'occurredUntil' must be greater than or equal to 'occurredFrom'."
    );
  }
  if (untilMs - fromMs > MEMORY_MAX_TIME_WINDOW_MS) {
    throw new TypeError("The memory time window exceeds the 365-day maximum.");
  }
  return { occurredFrom: from, occurredUntil: until };
}

function parseFilters(
  params: URLSearchParams,
  actor: MemoryControlActor,
  resource: MemoryControlRoute["resource"]
): {
  readonly context: MemoryReadContext;
  readonly page: { limit: number; offset: number };
  readonly query?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly statuses?: readonly MemoryStatus[];
  readonly memoryModes?: readonly (typeof MEMORY_EXECUTION_MODES)[number][];
  readonly outcomes?: readonly (typeof EXPERIENCE_OUTCOMES)[number][];
  readonly occurredFrom?: string;
  readonly occurredUntil?: string;
} {
  const context = readContext(params, actor);
  const page = pagination(params);
  const query = queryText(params);
  const kinds = valuesFromQuery(params, "kind", MEMORY_KINDS);
  const statuses = valuesFromQuery(params, "status", MEMORY_STATUSES);
  if (
    resource === MEMORY_RECORDS_ROUTE &&
    (params.has("memoryMode") || params.has("outcome"))
  ) {
    throw new TypeError("Experience-only filters cannot be used for records.");
  }
  // The mirror of the check above, and for the same reason. `kind` and `status`
  // describe a durable record's lifecycle; an experience has neither. They were
  // parsed, validated and then dropped on the way to the service, so a caller
  // filtering experiences by status got the whole unfiltered collection with a
  // 200 and no indication the filter had been ignored. Refusing is the same
  // answer the route already gives for the other direction.
  if (
    resource === MEMORY_EXPERIENCES_ROUTE &&
    (params.has("kind") || params.has("status"))
  ) {
    throw new TypeError("Record-only filters cannot be used for experiences.");
  }
  const memoryModes = valuesFromQuery(
    params,
    "memoryMode",
    MEMORY_EXECUTION_MODES
  );
  const outcomes = valuesFromQuery(params, "outcome", EXPERIENCE_OUTCOMES);
  return {
    context,
    page,
    ...(query ? { query } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(statuses.length > 0 ? { statuses } : {}),
    ...(memoryModes.length > 0 ? { memoryModes } : {}),
    ...(outcomes.length > 0 ? { outcomes } : {}),
    ...occurredWindow(params)
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  input: Record<string, unknown>,
  allowed: readonly string[]
): void {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new MemoryValidationError("Memory mutation has unsupported fields.");
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  maxCharacters = MAX_FILTER_VALUE,
  allowLineBreaks = false
): string {
  const value = input[key];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxCharacters ||
    hasControlCharacters(value, allowLineBreaks)
  ) {
    throw new MemoryValidationError(`Memory field '${key}' is invalid.`);
  }
  return value.trim();
}

function stringList(
  value: unknown,
  field: string,
  maximum: number
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum)
    throw new MemoryValidationError(`Memory field '${field}' is invalid.`);
  const result = value.map((item) => {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.trim().length > MAX_FILTER_VALUE ||
      hasControlCharacters(item)
    ) {
      throw new MemoryValidationError(`Memory field '${field}' is invalid.`);
    }
    return item.trim();
  });
  return [...new Set(result)];
}

function memoryIdList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_EXPERIENCE_IDS) {
    throw new MemoryValidationError("Injection-use memory ids are invalid.");
  }
  const ids = value.map((item) => {
    if (
      typeof item !== "string" ||
      !item.trim() ||
      item.trim().length > MAX_FILTER_VALUE ||
      hasControlCharacters(item)
    ) {
      throw new MemoryValidationError("Injection-use memory ids are invalid.");
    }
    return item.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new MemoryValidationError("Injection-use memory ids are duplicated.");
  }
  return ids;
}

function evidenceReferences(value: unknown): readonly EvidenceReference[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_EVIDENCE_REFERENCES
  ) {
    throw new MemoryValidationError("Memory evidence references are invalid.");
  }
  return value.map((entry) => {
    if (!isObject(entry) || !MEMORY_EVIDENCE_KINDS.includes(entry.kind as never))
      throw new MemoryValidationError("Memory evidence reference is invalid.");
    const uri = requiredString(entry, "uri", MAX_EVIDENCE_URI_CHARACTERS);
    const revision = entry.revision;
    const observedAt = entry.observedAt;
    if (
      revision !== undefined &&
      (typeof revision !== "string" ||
        revision.length > MAX_EVIDENCE_REVISION_CHARACTERS)
    ) {
      throw new MemoryValidationError("Memory evidence revision is invalid.");
    }
    if (
      observedAt !== undefined &&
      (typeof observedAt !== "string" ||
        !Number.isFinite(Date.parse(observedAt)))
    ) {
      throw new MemoryValidationError("Memory evidence timestamp is invalid.");
    }
    return {
      kind: entry.kind as EvidenceReference["kind"],
      uri,
      ...(typeof revision === "string" ? { revision } : {}),
      ...(typeof observedAt === "string" ? { observedAt } : {})
    };
  });
}

function outcomeEvidenceReferences(
  value: unknown
): readonly EvidenceReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFERENCES) {
    throw new MemoryValidationError(
      "Memory outcome evidence references are invalid."
    );
  }
  return value.length === 0 ? [] : evidenceReferences(value);
}

function experienceOutcomeContext(
  experience: ExperienceEnvelope,
  context: MemoryReadContext
): MemoryReadContext {
  return {
    workspaceId: experience.workspaceId,
    ...(experience.repositoryId
      ? { repositoryId: experience.repositoryId }
      : {}),
    ...(experience.agentRole ? { role: experience.agentRole } : {}),
    taskId: experience.taskId,
    runId: experience.runId,
    agentId: experience.agentId,
    canReadGlobal: false,
    canReadTaskHistory: context.canReadTaskHistory === true
  };
}

function requireTaskHistoryOperator(
  actor: MemoryControlActor,
  context: MemoryReadContext
): void {
  if (actor.role !== "operator" || context.canReadTaskHistory !== true) {
    throw new MemoryAuthorizationError(
      "Operator task-history access is required for memory outcome reports."
    );
  }
}

function memoryScope(value: unknown, context: MemoryReadContext): MemoryScope {
  if (!isObject(value) || typeof value.kind !== "string")
    throw new MemoryValidationError("Memory scope is invalid.");
  if (value.kind === "global") {
    if (!context.canReadGlobal)
      throw new MemoryScopeAccessError("Global memory write is not granted.");
    exactKeys(value, ["kind"]);
    return { kind: "global" };
  }

  const workspaceId = requiredString(value, "workspaceId");
  if (workspaceId !== context.workspaceId)
    throw new MemoryScopeAccessError("Memory scope does not match workspace.");

  switch (value.kind) {
    case "workspace": {
      exactKeys(value, ["kind", "workspaceId"]);
      return { kind: "workspace", workspaceId };
    }
    case "repository": {
      const repositoryId = requiredString(value, "repositoryId");
      assertRepositoryScope(repositoryId, context);
      exactKeys(value, ["kind", "workspaceId", "repositoryId"]);
      return { kind: "repository", workspaceId, repositoryId };
    }
    case "role": {
      const role = requiredString(value, "role");
      const repositoryId = optionalString(value, "repositoryId");
      if (repositoryId) assertRepositoryScope(repositoryId, context);
      exactKeys(value, ["kind", "workspaceId", "role", "repositoryId"]);
      return {
        kind: "role",
        workspaceId,
        role,
        ...(repositoryId ? { repositoryId } : {})
      };
    }
    case "task": {
      const { taskId, runId } = requireMatchingTaskScope(value, context);
      exactKeys(value, ["kind", "workspaceId", "taskId", "runId"]);
      return { kind: "task", workspaceId, taskId, runId };
    }
    case "agent": {
      const { taskId, runId } = requireMatchingTaskScope(value, context);
      const agentId = requiredString(value, "agentId");
      if (agentId !== context.agentId)
        throw new MemoryScopeAccessError("Memory scope does not match agent.");
      exactKeys(value, ["kind", "workspaceId", "taskId", "runId", "agentId"]);
      return { kind: "agent", workspaceId, taskId, runId, agentId };
    }
    default: {
      throw new MemoryValidationError("Memory scope kind is invalid.");
    }
  }
}

function optionalString(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  return input[key] === undefined ? undefined : requiredString(input, key);
}

function assertRepositoryScope(
  repositoryId: string,
  context: MemoryReadContext
): void {
  if (context.repositoryId && repositoryId !== context.repositoryId)
    throw new MemoryScopeAccessError("Memory scope does not match repository.");
}

function requireMatchingTaskScope(
  input: Record<string, unknown>,
  context: MemoryReadContext
): { taskId: string; runId: string } {
  const taskId = requiredString(input, "taskId");
  const runId = requiredString(input, "runId");
  if (taskId !== context.taskId || runId !== context.runId)
    throw new MemoryScopeAccessError("Memory scope does not match task/run.");
  return { taskId, runId };
}

function proposalInput(
  value: Record<string, unknown>,
  context: MemoryReadContext
): MemoryProposalInput {
  exactKeys(value, ["kind", "scope", "claim", "experienceIds", "evidence"]);
  if (!MEMORY_KINDS.includes(value.kind as MemoryKind))
    throw new MemoryValidationError("Memory kind is invalid.");
  const claim = requiredString(value, "claim", MAX_CLAIM_LENGTH);
  const experienceIds = stringList(
    value.experienceIds,
    "experienceIds",
    MAX_EXPERIENCE_IDS
  );
  return {
    kind: value.kind as MemoryKind,
    scope: memoryScope(value.scope, context),
    claim,
    experienceIds,
    evidence: evidenceReferences(value.evidence)
  };
}

function researchRequest(
  body: Record<string, unknown>,
  context: MemoryReadContext,
  defaultTaskId: string
) {
  exactKeys(body, ["task", "query", "taskId", "relevantPaths"]);
  const taskId =
    body.taskId === undefined ? defaultTaskId : requiredString(body, "taskId");
  const task = requiredString(body, "task", MAX_RESEARCH_TASK_CHARACTERS);
  const query = requiredString(body, "query", MAX_QUERY_LENGTH);
  let relevantPaths: readonly string[] | undefined;
  if (body.relevantPaths !== undefined) {
    relevantPaths = stringList(
      body.relevantPaths,
      "relevantPaths",
      MAX_EVIDENCE_REFERENCES
    );
  }
  return {
    taskId,
    task,
    query,
    context,
    maxPacketCharacters: 0,
    ...(relevantPaths ? { relevantPaths } : {})
  };
}

function isMemoryReasonCode(value: string): value is MemoryReasonCode {
  return MEMORY_REASON_CODES.includes(value as MemoryReasonCode);
}

function actorForControl(actor: MemoryControlActor): MemoryActor {
  return { id: actor.actor, authority: "root" };
}

function sendBodyError(
  response: ServerResponse,
  result: Extract<
    Awaited<ReturnType<typeof readControlApiJsonObject>>,
    { ok: false }
  >
): void {
  sendMemoryError(response, result.status, result.code, result.message);
}

async function serveExperience(
  service: MemoryService,
  route: MemoryControlRoute,
  filters: ReturnType<typeof parseFilters>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (route.id) {
    const experience = await service.getExperience(route.id, filters.context);
    if (!experience) {
      // Audited like every sibling that 404s here. Whether the experience is
      // absent or simply outside the caller's scope, the wire answer is the same
      // 404 — that is the point of it — so the trail has to carry the reason the
      // answer cannot carry.
      auditMemoryFailure(audit, route, "denied", "experience_not_visible");
      sendMemoryError(
        response,
        404,
        "autodev_memory_not_found",
        MEMORY_EXPERIENCE_NOT_FOUND
      );
      return;
    }
    sendJson(
      response,
      200,
      {
        schema: "autodev-memory-experience-v1",
        experience
      } satisfies ControlApiMemoryExperienceDetailResponse,
      { "cache-control": "no-store" }
    );
    return;
  }
  const result = await service.listExperiences({
    context: filters.context,
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.memoryModes ? { memoryModes: filters.memoryModes } : {}),
    ...(filters.outcomes ? { outcomes: filters.outcomes } : {}),
    ...(filters.occurredFrom ? { occurredFrom: filters.occurredFrom } : {}),
    ...(filters.occurredUntil ? { occurredUntil: filters.occurredUntil } : {}),
    ...filters.page
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-experiences-v1",
      ...result
    } satisfies ControlApiMemoryExperiencesResponse,
    { "cache-control": "no-store" }
  );
}

async function serveExperienceOutcomes(
  service: MemoryAssessmentReader,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  filters: ReturnType<typeof parseFilters>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  try {
    requireTaskHistoryOperator(actor, filters.context);
  } catch {
    auditMemoryFailure(audit, route, "denied", "task_history_not_granted");
    sendMemoryError(
      response,
      403,
      "autodev_memory_task_history_forbidden",
      MEMORY_TASK_HISTORY_ACCESS_REQUIRED
    );
    return;
  }
  if (!route.id) throw new MemoryValidationError(MEMORY_EXPERIENCE_ID_REQUIRED);
  const experience = await service.getExperience(route.id, filters.context);
  if (!experience) {
    // The same reason as every sibling 404 on an experience, for the same reason:
    // the wire answer must not distinguish absent from out-of-scope.
    auditMemoryFailure(audit, route, "denied", "experience_not_visible");
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      MEMORY_EXPERIENCE_NOT_FOUND
    );
    return;
  }
  const context = experienceOutcomeContext(experience, filters.context);
  const page = await service.listInjectionOutcomeJoins({
    context,
    includeUnreported: true,
    ...(filters.memoryModes ? { memoryModes: filters.memoryModes } : {}),
    ...(filters.outcomes ? { outcomeKinds: filters.outcomes } : {}),
    ...filters.page
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-injection-outcomes-v1",
      experienceId: experience.id,
      ...page
    } satisfies ControlApiMemoryInjectionOutcomesResponse,
    { "cache-control": "no-store" }
  );
}

async function serveExperienceInjectionUseAssessments(
  service: MemoryAssessmentReader,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  filters: ParsedMemoryUseAssessmentFilters,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  // Masked by the filter. `parseMemoryUseAssessmentFilters` refuses an operator
  // without the grant before this function is called, on the same condition this
  // gate checks, so it cannot fire and no test drives it — which is why this
  // route answers `scope_filter_forbidden` where its sibling reads answer
  // `task_history_not_granted`. It is kept because the filter is request parsing
  // and this is route authorization: if the filter is ever relaxed, this is the
  // layer that should still refuse. Do not write a test here expecting it to run.
  try {
    requireTaskHistoryOperator(actor, filters.context);
  } catch {
    auditMemoryFailure(audit, route, "denied", "task_history_not_granted");
    sendMemoryError(
      response,
      403,
      "autodev_memory_task_history_forbidden",
      MEMORY_TASK_HISTORY_ACCESS_REQUIRED
    );
    return;
  }
  if (!route.id) throw new MemoryValidationError(MEMORY_EXPERIENCE_ID_REQUIRED);
  const experience = await service.getExperience(route.id, filters.context);
  if (!experience) {
    auditMemoryFailure(audit, route, "denied", "experience_not_visible");
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      MEMORY_EXPERIENCE_NOT_FOUND
    );
    return;
  }
  const page = await service.listInjectionUseJoins({
    context: experienceOutcomeContext(experience, filters.context),
    includeUnassessed: true,
    ...(filters.memoryModes.length > 0
      ? { memoryModes: filters.memoryModes }
      : {}),
    ...(filters.useKinds.length > 0 ? { useKinds: filters.useKinds } : {}),
    ...filters.page
  });
  const items = page.items.map(({ injection, use, sessionInjectionCount }) => ({
    injection: {
      id: injection.id,
      memoryMode: injection.memoryMode,
      injectionResult: injection.injectionResult,
      packetCharacterCount: injection.packetCharacterCount,
      memoryIds: injection.memoryIds,
      occurredAt: injection.occurredAt
    },
    sessionInjectionCount,
    use:
      use === null
        ? null
        : {
            useKind: use.useKind,
            usedMemoryIds: use.usedMemoryIds,
            reportedAt: use.reportedAt,
            evidence: use.evidence
          }
  }));
  audit({
    action: "read_injection_use_assessments",
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "ok",
    changes: null
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-injection-use-assessments-v1",
      experienceId: experience.id,
      items,
      total: page.total,
      limit: page.limit,
      offset: page.offset
    } satisfies ControlApiMemoryInjectionUseAssessmentsResponse,
    { "cache-control": "no-store" }
  );
}

async function reportExperienceOutcome(
  service: MemoryAssessmentRecorder,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  context: MemoryReadContext,
  body: Record<string, unknown>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (!route.id) throw new MemoryValidationError(MEMORY_EXPERIENCE_ID_REQUIRED);
  try {
    requireTaskHistoryOperator(actor, context);
  } catch {
    // Caught like every sibling. Uncaught, this reached the generic handler and
    // answered `scope_or_authority_forbidden`, which names neither the task
    // history grant nor this route — so an operator auditing a refused outcome
    // report was told "scope or authority" about a grant that was simply absent.
    auditMemoryFailure(audit, route, "denied", "task_history_not_granted");
    sendMemoryError(
      response,
      403,
      "autodev_memory_task_history_forbidden",
      MEMORY_TASK_HISTORY_ACCESS_REQUIRED
    );
    return;
  }
  const experience = await service.getExperience(route.id, context);
  if (!experience) {
    auditMemoryFailure(audit, route, "denied", "experience_not_visible");
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      MEMORY_EXPERIENCE_NOT_FOUND
    );
    return;
  }
  exactKeys(body, [
    "correlationToken",
    "outcomeKind",
    "reportKind",
    "evidence"
  ]);
  const correlationToken = requiredString(
    body,
    "correlationToken",
    MAX_FILTER_VALUE
  );
  if (!EXPERIENCE_OUTCOMES.includes(body.outcomeKind as never)) {
    throw new MemoryValidationError("Memory outcome kind is invalid.");
  }
  if (!MEMORY_OUTCOME_REPORT_KINDS.includes(body.reportKind as never)) {
    throw new MemoryValidationError("Memory outcome report kind is invalid.");
  }
  const outcomeKind = body.outcomeKind as MemoryOutcomeReport["outcomeKind"];
  const reportKind = body.reportKind as MemoryOutcomeReportKind;
  const evidence = outcomeEvidenceReferences(body.evidence);
  if (outcomeKind !== "unknown" && evidence.length === 0) {
    throw new MemoryValidationError(
      "Non-unknown outcome reports require at least one evidence reference."
    );
  }
  const reportContext = experienceOutcomeContext(experience, context);
  const trustedActor = actorForControl(actor);
  const id = `memory-outcome-${createHash("sha256")
    .update(`${experience.id}\u0000${correlationToken}`)
    .digest("hex")
    .slice(0, 32)}`;
  const report: MemoryOutcomeReport = {
    id,
    workspaceId: experience.workspaceId,
    ...(experience.repositoryId
      ? { repositoryId: experience.repositoryId }
      : {}),
    scope: experience.scope,
    taskId: experience.taskId,
    runId: experience.runId,
    agentId: experience.agentId,
    correlationToken,
    outcomeKind,
    reportKind,
    reportedAt: new Date().toISOString(),
    reporterId: trustedActor.id,
    reporterAuthority: trustedActor.authority,
    reasonCode:
      outcomeKind === "unknown" ? "reporter_unknown" : "reporter_supplied",
    evidence
  };
  const result = await service.recordOutcomeReport({
    report,
    actor: trustedActor,
    context: reportContext
  });
  audit({
    action: "report_outcome",
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "ok",
    changes: {
      outcomeKind,
      reportKind,
      appended: result.appended
    }
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-outcome-report-v1",
      experienceId: experience.id,
      reportId: result.id,
      appended: result.appended
    },
    { "cache-control": "no-store" }
  );
}

async function reportExperienceInjectionUse(
  service: MemoryAssessmentRecorder,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  context: MemoryReadContext,
  body: Record<string, unknown>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (!route.id) throw new MemoryValidationError(MEMORY_EXPERIENCE_ID_REQUIRED);
  try {
    requireTaskHistoryOperator(actor, context);
  } catch {
    auditMemoryFailure(audit, route, "denied", "task_history_not_granted");
    sendMemoryError(
      response,
      403,
      "autodev_memory_task_history_forbidden",
      MEMORY_TASK_HISTORY_ACCESS_REQUIRED
    );
    return;
  }
  const experience = await service.getExperience(route.id, context);
  if (!experience) {
    auditMemoryFailure(audit, route, "denied", "experience_not_visible");
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      MEMORY_EXPERIENCE_NOT_FOUND
    );
    return;
  }
  exactKeys(body, ["injectionEventId", "useKind", "usedMemoryIds", "evidence"]);
  const injectionEventId = requiredString(
    body,
    "injectionEventId",
    MAX_FILTER_VALUE
  );
  if (!MEMORY_USE_KINDS.includes(body.useKind as never)) {
    throw new MemoryValidationError("Memory injection-use kind is invalid.");
  }
  const usedMemoryIds = memoryIdList(body.usedMemoryIds);
  const evidence = outcomeEvidenceReferences(body.evidence);
  const result = await service.recordInjectionUseReport({
    experienceId: experience.id,
    injectionEventId,
    useKind: body.useKind as MemoryUseKind,
    usedMemoryIds,
    evidence,
    actor: actorForControl(actor),
    context
  });
  audit({
    action: "report_injection_use",
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "ok",
    changes: {
      useKind: body.useKind as MemoryUseKind,
      usedMemoryCount: usedMemoryIds.length,
      appended: result.appended
    }
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-injection-use-report-v1",
      experienceId: experience.id,
      injectionEventId,
      appended: result.appended
    },
    { "cache-control": "no-store" }
  );
}

async function reportExperienceSessionOutcome(
  service: MemoryAssessmentRecorder,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  context: MemoryReadContext,
  body: Record<string, unknown>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (!route.id) throw new MemoryValidationError(MEMORY_EXPERIENCE_ID_REQUIRED);
  try {
    requireTaskHistoryOperator(actor, context);
  } catch {
    auditMemoryFailure(audit, route, "denied", "task_history_not_granted");
    sendMemoryError(
      response,
      403,
      "autodev_memory_task_history_forbidden",
      MEMORY_TASK_HISTORY_ACCESS_REQUIRED
    );
    return;
  }
  const experience = await service.getExperience(route.id, context);
  if (!experience) {
    auditMemoryFailure(audit, route, "denied", "experience_not_visible");
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      MEMORY_EXPERIENCE_NOT_FOUND
    );
    return;
  }
  if (!experience.repositoryId) {
    throw new MemoryValidationError(
      "Session outcome report requires repository-scoped experience."
    );
  }
  exactKeys(body, ["outcomeKind", "reportKind", "evidence"]);
  if (!EXPERIENCE_OUTCOMES.includes(body.outcomeKind as never)) {
    throw new MemoryValidationError("Memory outcome kind is invalid.");
  }
  if (!MEMORY_OUTCOME_REPORT_KINDS.includes(body.reportKind as never)) {
    throw new MemoryValidationError("Memory outcome report kind is invalid.");
  }
  const outcomeKind =
    body.outcomeKind as MemorySessionOutcomeReport["outcomeKind"];
  const reportKind = body.reportKind as MemoryOutcomeReportKind;
  const evidence = outcomeEvidenceReferences(body.evidence);
  if (outcomeKind !== "unknown" && evidence.length === 0) {
    throw new MemoryValidationError(
      "Non-unknown outcome reports require at least one evidence reference."
    );
  }
  const reportContext = experienceOutcomeContext(experience, context);
  const trustedActor = actorForControl(actor);
  const id = `memory-session-outcome-${createHash("sha256")
    .update(
      `${experience.workspaceId}\u0000${experience.repositoryId}\u0000${experience.taskId}`
    )
    .digest("hex")
    .slice(0, 32)}`;
  const report: MemorySessionOutcomeReport = {
    id,
    workspaceId: experience.workspaceId,
    repositoryId: experience.repositoryId,
    taskId: experience.taskId,
    outcomeKind,
    reportKind,
    reportedAt: new Date().toISOString(),
    reporterId: trustedActor.id,
    reporterAuthority: trustedActor.authority,
    reasonCode:
      outcomeKind === "unknown" ? "reporter_unknown" : "reporter_supplied",
    evidence
  };
  const result = await service.recordSessionOutcomeReport({
    report,
    actor: trustedActor,
    context: reportContext
  });
  audit({
    action: "report_session_outcome",
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "ok",
    changes: {
      outcomeKind,
      reportKind,
      appended: result.appended
    }
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-session-outcome-report-v1",
      experienceId: experience.id,
      reportId: result.id,
      appended: result.appended
    },
    { "cache-control": "no-store" }
  );
}

async function serveExperienceSessionOutcome(
  service: MemoryAssessmentReader,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  context: MemoryReadContext,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (!route.id) throw new MemoryValidationError(MEMORY_EXPERIENCE_ID_REQUIRED);
  try {
    requireTaskHistoryOperator(actor, context);
  } catch {
    auditMemoryFailure(audit, route, "denied", "task_history_not_granted");
    sendMemoryError(
      response,
      403,
      "autodev_memory_task_history_forbidden",
      MEMORY_TASK_HISTORY_ACCESS_REQUIRED
    );
    return;
  }
  const experience = await service.getExperience(route.id, context);
  if (!experience) {
    auditMemoryFailure(audit, route, "denied", "experience_not_visible");
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      MEMORY_EXPERIENCE_NOT_FOUND
    );
    return;
  }
  if (!experience.repositoryId) {
    throw new MemoryValidationError(
      "Session outcome report requires repository-scoped experience."
    );
  }
  const report = await service.getSessionOutcomeReport(
    experience.workspaceId,
    experience.repositoryId,
    experience.taskId,
    context
  );
  if (!report) {
    auditMemoryFailure(audit, route, "denied", "report_not_found");
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      "No session outcome report exists for this session."
    );
    return;
  }
  audit({
    action: "read_session_outcome",
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "ok",
    changes: null
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-session-outcome-report-v1",
      experienceId: experience.id,
      report
    },
    { "cache-control": "no-store" }
  );
}

async function serveRecord(
  service: MemoryService,
  route: MemoryControlRoute,
  filters: ReturnType<typeof parseFilters>,
  response: ServerResponse
): Promise<void> {
  if (route.id) {
    if (route.action === "history") {
      const history = await service.history(route.id, filters.context);
      if (!history) {
        sendMemoryError(
          response,
          404,
          "autodev_memory_not_found",
          "Memory record was not found."
        );
        return;
      }
      // Projected rather than spread. The route used to answer `history` with
      // the repository's own shape -- `{ memory, relatedMemories, events }` --
      // while the wire contract declares `transitions`, so every real response
      // failed the Console's guard and the record detail page refused to open
      // at all. Naming the fields is what makes the two sides agree, and it
      // keeps `events` from leaking onto the wire under a name no client reads.
      sendJson(
        response,
        200,
        {
          schema: "autodev-memory-history-v1",
          memory: history.memory,
          relatedMemories: history.relatedMemories,
          transitions: history.events
        } satisfies ControlApiMemoryHistoryResponse,
        { "cache-control": "no-store" }
      );
      return;
    }
    if (route.action === "why") {
      const why = await service.why(route.id, filters.context);
      if (!why) {
        sendMemoryError(
          response,
          404,
          "autodev_memory_not_found",
          "Memory record was not found."
        );
        return;
      }
      // `sourceExperiences` only, and not the events: this is the explanation
      // of what this reader can still resolve, and the transitions already have
      // their own response.
      sendJson(
        response,
        200,
        {
          schema: "autodev-memory-why-v1",
          memory: why.memory,
          relatedMemories: why.relatedMemories,
          sourceExperiences: why.sourceExperiences
        } satisfies ControlApiMemoryWhyResponse,
        { "cache-control": "no-store" }
      );
      return;
    }
    const memory = await service.get(route.id, filters.context);
    if (!memory) {
      sendMemoryError(
        response,
        404,
        "autodev_memory_not_found",
        "Memory record was not found."
      );
      return;
    }
    sendJson(
      response,
      200,
      {
        schema: "autodev-memory-record-v1",
        memory
      } satisfies ControlApiMemoryRecordDetailResponse,
      { "cache-control": "no-store" }
    );
    return;
  }
  const result = await service.listMemories({
    context: filters.context,
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.kinds ? { kinds: filters.kinds } : {}),
    ...(filters.statuses ? { statuses: filters.statuses } : {}),
    ...(filters.occurredFrom ? { occurredFrom: filters.occurredFrom } : {}),
    ...(filters.occurredUntil ? { occurredUntil: filters.occurredUntil } : {}),
    ...filters.page
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-records-v1",
      ...result
    } satisfies ControlApiMemoryRecordsResponse,
    { "cache-control": "no-store" }
  );
}

async function purgeMemoryExperience(
  service: MemoryExperiencePurger,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  context: MemoryReadContext,
  body: Record<string, unknown>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (!route.id)
    throw new MemoryValidationError("A memory experience id is required.");
  exactKeys(body, ["reason"]);
  const reason = requiredString(body, "reason");
  if (!isMemoryExperiencePurgeReason(reason))
    throw new MemoryValidationError("Memory purge reason is invalid.");
  const purge = await service.purgeExperience(
    route.id,
    reason,
    actorForControl(actor),
    context
  );
  if (purge === "not_visible") {
    audit({
      action: MEMORY_PURGE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "denied",
      changes: null,
      reason: "experience_not_visible"
    });
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      MEMORY_EXPERIENCE_NOT_FOUND
    );
    return;
  }
  if (purge === "referenced_by_memory") {
    audit({
      action: MEMORY_PURGE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "error",
      changes: null,
      reason: "experience_referenced_by_memory"
    });
    sendMemoryError(
      response,
      409,
      "autodev_memory_experience_referenced",
      "A durable memory still cites this experience."
    );
    return;
  }
  audit({
    action: MEMORY_PURGE_ACTION,
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "ok",
    changes: { reason, result: purge }
  });
  sendJson(
    response,
    200,
    { schema: "autodev-memory-experience-purge-v1", result: purge },
    { "cache-control": "no-store" }
  );
}

async function mutateMemory(
  service: MemoryService,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  context: MemoryReadContext,
  body: Record<string, unknown>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  const memoryActor = actorForControl(actor);
  let result: {
    memory: MemoryRecord;
    skill?: MemorySkillPromotionArtifact;
    changes: Record<string, unknown> | null;
  };

  if (route.resource !== MEMORY_RECORDS_ROUTE)
    throw new MemoryValidationError(
      "Experience capture uses its dedicated route."
    );
  if (!route.id && !route.action) {
    const proposal = proposalInput(body, context);
    result = {
      memory: await service.propose(proposal, memoryActor, context),
      changes: { kind: proposal.kind, scope: proposal.scope.kind }
    };
  } else {
    if (!route.id)
      throw new MemoryValidationError("A memory record id is required.");
    switch (route.action) {
      case "revise": {
        exactKeys(body, ["claim", "experienceIds", "evidence"]);
        const claim = requiredString(body, "claim", MAX_CLAIM_LENGTH);
        const experienceIds = stringList(
          body.experienceIds,
          "experienceIds",
          MAX_EXPERIENCE_IDS
        );
        const evidence = evidenceReferences(body.evidence);
        result = {
          memory: await service.revise(
            route.id,
            { claim, experienceIds, evidence },
            memoryActor,
            context
          ),
          changes: { action: "revise" }
        };
        break;
      }
      case "verify": {
        const verification = researchRequest(body, context, route.id);
        const memory = await service.verifyAndPromote(
          route.id,
          memoryActor,
          verification
        );
        result = {
          memory,
          changes: { action: "verify", status: memory.status }
        };
        break;
      }
      case "invalidate": {
        exactKeys(body, ["evidence", "reasonCode"]);
        const evidence = evidenceReferences(body.evidence);
        const reasonCode =
          body.reasonCode === undefined
            ? undefined
            : requiredString(body, "reasonCode");
        if (reasonCode && !isMemoryReasonCode(reasonCode))
          throw new MemoryValidationError(
            "Memory invalidation reason is invalid."
          );
        const memory = await service.invalidate(
          route.id,
          memoryActor,
          context,
          evidence,
          reasonCode as MemoryReasonCode | undefined
        );
        result = {
          memory,
          changes: {
            action: "invalidate",
            ...(reasonCode ? { reasonCode } : {})
          }
        };
        break;
      }
      case "supersede": {
        exactKeys(body, [
          "priorId",
          "task",
          "query",
          "taskId",
          "relevantPaths"
        ]);
        const priorId = requiredString(body, "priorId");
        const verification = researchRequest(
          {
            task: body.task,
            query: body.query,
            taskId: body.taskId,
            relevantPaths: body.relevantPaths
          },
          context,
          route.id
        );
        result = {
          memory: await service.supersede(
            route.id,
            priorId,
            memoryActor,
            verification
          ),
          changes: { action: "supersede" }
        };
        break;
      }
      case MEMORY_PROMOTE_SKILL_ACTION: {
        exactKeys(body, [
          "skillName",
          "description",
          "content",
          "task",
          "query",
          "taskId",
          "relevantPaths"
        ]);
        const skillName = requiredString(body, "skillName");
        const description = requiredString(body, "description", 512);
        const content = requiredString(body, "content", 20_000, true);
        const verification = researchRequest(
          {
            task: body.task,
            query: body.query,
            taskId: body.taskId,
            relevantPaths: body.relevantPaths
          },
          context,
          route.id
        );
        const promotion = await service.promoteProcedureToSkill(
          route.id,
          { name: skillName, description, content },
          memoryActor,
          verification
        );
        result = {
          memory: promotion.memory,
          skill: promotion.skill,
          changes: {
            action: MEMORY_PROMOTE_SKILL_ACTION,
            kind: promotion.memory.kind,
            skillName: promotion.skill.name,
            skillRevision: promotion.skill.revision
          }
        };
        break;
      }
      default: {
        throw new MemoryValidationError("Unsupported memory lifecycle action.");
      }
    }
  }

  audit({
    action: route.action ?? "propose",
    resource: "/control/memory/records",
    outcome: "ok",
    changes: result.changes
  });
  sendJson(
    response,
    200,
    result.skill
      ? {
          schema: "autodev-memory-skill-promotion-v1",
          memory: result.memory,
          skill: result.skill
        }
      : { schema: "autodev-memory-record-v1", memory: result.memory },
    { "cache-control": "no-store" }
  );
}

async function captureCodexExperience(
  request: IncomingMessage,
  response: ServerResponse,
  actor: MemoryControlActor,
  audit: MemoryControlAudit,
  dependencies: MemoryControlApiDependencies
): Promise<void> {
  if (actor.role !== "operator") {
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "denied",
      changes: null,
      reason: "viewer_cannot_capture"
    });
    sendMemoryError(
      response,
      403,
      "autodev_memory_capture_forbidden",
      "Operator access is required for native trajectory capture."
    );
    return;
  }
  const parsed = await readControlApiJsonObject(request);
  if (!parsed.ok) {
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "error",
      changes: null,
      reason: "invalid_body"
    });
    sendBodyError(response, parsed);
    return;
  }

  try {
    exactKeys(parsed.body, ["sessionId", "transcriptPath", "cwd"]);
    const sessionId = requiredString(parsed.body, "sessionId");
    if (!MEMORY_ID_PATTERN.test(sessionId))
      throw new MemoryValidationError("Codex session id is invalid.");
    const cwd = requiredString(parsed.body, "cwd", 4096);
    const transcriptPath = requiredString(parsed.body, "transcriptPath", 4096);
    if (!path.isAbsolute(cwd) || !path.isAbsolute(transcriptPath))
      throw new MemoryValidationError("Codex session paths must be absolute.");

    const trusted = trustedMemoryContextForSession(sessionId, cwd);
    if (!trusted) {
      audit({
        action: MEMORY_CAPTURE_ACTION,
        resource: MEMORY_EXPERIENCE_RESOURCE,
        outcome: "denied",
        changes: null,
        reason: "session_scope_not_observed"
      });
      sendMemoryError(
        response,
        403,
        "autodev_memory_capture_scope_forbidden",
        "The router has not observed this session in the requested workspace."
      );
      return;
    }

    const codexHome =
      process.env.CODEX_HOME?.trim() || path.join(homedir(), ".codex");
    const sessionsRoot = await realpath(path.join(codexHome, "sessions"));
    const safeTranscriptPath = await realpath(transcriptPath);
    const relativePath = path.relative(sessionsRoot, safeTranscriptPath);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new MemoryValidationError(
        "Transcript must be inside the Codex sessions directory."
      );
    }
    const metadata = await stat(safeTranscriptPath);
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_NATIVE_TRANSCRIPT_BYTES
    ) {
      throw new MemoryValidationError("Codex transcript size is invalid.");
    }
    const transcript = await readFile(safeTranscriptPath, "utf8");
    if (Buffer.byteLength(transcript, "utf8") > MAX_NATIVE_TRANSCRIPT_BYTES)
      throw new MemoryValidationError("Codex transcript size is invalid.");

    const service = (
      dependencies.createMemoryService ?? createOrchestratorMemoryService
    )();
    if (!service) {
      // Audited, because the hook that fired this sees only a 503. Without an
      // entry, "capture was refused" and "capture never happened" are the same
      // fact in the trail, and this is the one failure an operator has no other
      // way to diagnose.
      audit({
        action: MEMORY_CAPTURE_ACTION,
        resource: MEMORY_EXPERIENCE_RESOURCE,
        outcome: "error",
        changes: null,
        reason: "memory_unavailable"
      });
      sendMemoryError(
        response,
        503,
        "autodev_memory_unavailable",
        "Memory storage is not configured."
      );
      return;
    }
    const context: MemoryReadContext = {
      workspaceId: trusted.workspaceId,
      repositoryId: trusted.repositoryId,
      role: "orchestrator",
      taskId: sessionId,
      runId: sessionId,
      agentId: sessionId,
      canReadGlobal: false
    };
    const experienceId = `codex-session-${createHash("sha256")
      .update(sessionId)
      .digest("hex")}`;
    const trajectoryUri = `codex://session/${encodeURIComponent(sessionId)}`;
    const transcriptDigest = createHash("sha256")
      .update(transcript, "utf8")
      .digest("hex");
    const startedAt =
      Number.isFinite(metadata.birthtimeMs) && metadata.birthtimeMs > 0
        ? new Date(metadata.birthtimeMs).toISOString()
        : new Date(metadata.mtimeMs).toISOString();
    const experience: Omit<ExperienceEnvelope, "trajectory"> = {
      id: experienceId,
      workspaceId: trusted.workspaceId,
      repositoryId: trusted.repositoryId,
      scope: {
        kind: "task",
        workspaceId: trusted.workspaceId,
        taskId: sessionId,
        runId: sessionId
      },
      taskId: sessionId,
      runId: sessionId,
      taskKind: "interactive_session",
      taskReference: { kind: "trajectory", uri: trajectoryUri },
      agentId: sessionId,
      agentRole: "orchestrator",
      startedAt,
      completedAt: new Date().toISOString(),
      outcome: "unknown",
      memoryMode: currentRouterMemoryMode({
        sessionKey: sessionId,
        sessionScope: trusted.sessionScope,
        workspace: {
          key: trusted.repositoryId,
          cwd: trusted.root,
          workspace_id: trusted.workspaceId
        }
      }),
      evidence: [{ kind: "trajectory", uri: trajectoryUri }]
    };
    const captured = await captureExperienceIdempotently(
      service,
      { source: "codex", transcript, trajectoryUri, experience },
      transcriptDigest,
      context,
      CODEX_CAPTURE_ACTOR
    );
    if (!captured) {
      respondToDuplicateCapture(response, audit, "codex");
      return;
    }
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "ok",
      changes: { source: "codex", outcome: "unknown" }
    });
    sendJson(
      response,
      200,
      { schema: "autodev-memory-capture-v1", captured: true },
      { "cache-control": "no-store" }
    );
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      audit({
        action: MEMORY_CAPTURE_ACTION,
        resource: MEMORY_EXPERIENCE_RESOURCE,
        outcome: "error",
        changes: null,
        reason: "invalid_capture"
      });
      sendMemoryError(
        response,
        400,
        "autodev_memory_capture_invalid",
        "Native trajectory capture input is invalid."
      );
      return;
    }
    if (error instanceof MemoryConflictError) {
      audit({
        action: MEMORY_CAPTURE_ACTION,
        resource: MEMORY_EXPERIENCE_RESOURCE,
        outcome: "error",
        changes: null,
        reason: "captured_transcript_conflict"
      });
      sendMemoryError(
        response,
        409,
        "autodev_memory_capture_conflict",
        "Native transcript conflicts with the previously captured session."
      );
      return;
    }
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "error",
      changes: null,
      reason: "capture_failed"
    });
    sendMemoryError(
      response,
      503,
      "autodev_memory_capture_failed",
      "Native trajectory capture could not be completed."
    );
  }
}

/**
 * Capture one Claude Code SessionEnd event. Scope authority comes
 * exclusively from the operator-owned binding file:
 *
 * 1. The hook-supplied `cwd` is matched by realpath against exactly one
 *    `[[workspace]]` entry; an ambiguous or missing match fails closed.
 * 2. The hook-supplied `transcriptPath` is matched by realpath against
 *    the operator-owned transcript root; symlink/".." escapes fail
 *    closed.
 * 3. The hook-supplied `session_id` only sets the session/run/agent
 *    identity; `outcome` stays "unknown" because no task signal was
 *    reported. No transcript payload is persisted.
 */
interface ClaudeCodeCaptureInput {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
}

class ClaudeCodeCaptureValidationError extends MemoryValidationError {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

async function captureClaudeCodeExperience(
  request: IncomingMessage,
  response: ServerResponse,
  actor: MemoryControlActor,
  audit: MemoryControlAudit,
  dependencies: MemoryControlApiDependencies
): Promise<void> {
  if (actor.role !== "operator") {
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "denied",
      changes: null,
      reason: "viewer_cannot_capture"
    });
    sendMemoryError(
      response,
      403,
      "autodev_memory_capture_forbidden",
      "Operator access is required for native trajectory capture."
    );
    return;
  }

  const parsedBody = await readControlApiJsonObject(request);
  if (!parsedBody.ok) {
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "error",
      changes: null,
      reason: "invalid_body"
    });
    sendBodyError(response, parsedBody);
    return;
  }

  try {
    const input = parseClaudeCodeCaptureInput(parsedBody.body);
    const result = await persistClaudeCodeExperience(input, dependencies);
    if (result === "unavailable") {
      // As on the Codex route: the caller is a hook that will only ever see the
      // 503, so the audit entry is the only place this can be seen from.
      audit({
        action: MEMORY_CAPTURE_ACTION,
        resource: MEMORY_EXPERIENCE_RESOURCE,
        outcome: "error",
        changes: null,
        reason: "memory_unavailable"
      });
      sendMemoryError(
        response,
        503,
        "autodev_memory_unavailable",
        "Memory storage is not configured."
      );
      return;
    }
    if (result === "duplicate") {
      respondToDuplicateCapture(response, audit, CLAUDE_CODE_BINDING_PROVIDER);
      return;
    }
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "ok",
      changes: { source: CLAUDE_CODE_BINDING_PROVIDER, outcome: "unknown" }
    });
    sendJson(
      response,
      200,
      { schema: "autodev-memory-capture-v1", captured: true },
      { "cache-control": "no-store" }
    );
  } catch (error) {
    respondToClaudeCodeCaptureError(response, audit, error);
  }
}

function parseClaudeCodeCaptureInput(
  body: Record<string, unknown>
): ClaudeCodeCaptureInput {
  exactKeys(body, ["sessionId", "transcriptPath", "cwd"]);
  const sessionId = requiredString(body, "sessionId");
  if (!MEMORY_ID_PATTERN.test(sessionId))
    throw new MemoryValidationError("Claude Code session id is invalid.");
  const cwd = requiredString(body, "cwd", MAX_NATIVE_CAPTURE_PATH_LENGTH);
  const transcriptPath = requiredString(
    body,
    "transcriptPath",
    MAX_NATIVE_CAPTURE_PATH_LENGTH
  );
  if (!path.isAbsolute(cwd) || !path.isAbsolute(transcriptPath)) {
    throw new MemoryValidationError("Claude Code paths must be absolute.");
  }
  return { sessionId, transcriptPath, cwd };
}

async function persistClaudeCodeExperience(
  input: ClaudeCodeCaptureInput,
  dependencies: MemoryControlApiDependencies
): Promise<"captured" | "duplicate" | "unavailable"> {
  const binding = requireClaudeCodeBinding();
  const workspace = requireClaudeCodeWorkspace(binding, input.cwd);
  const transcriptPath = requireClaudeCodeTranscript(
    workspace,
    input.transcriptPath,
    input.sessionId
  );
  const service = (
    dependencies.createMemoryService ?? createOrchestratorMemoryService
  )();
  if (!service) return "unavailable";
  const transcript = await readClaudeCodeTranscript(transcriptPath);

  const context: MemoryReadContext = {
    workspaceId: workspace.workspaceId,
    repositoryId: workspace.repositoryId,
    role: "orchestrator",
    taskId: input.sessionId,
    runId: input.sessionId,
    agentId: input.sessionId,
    canReadGlobal: false
  };
  const trajectoryUri = claudeCodeTrajectoryUri(input.sessionId);
  const experience = claudeCodeExperienceEnvelope(
    input,
    workspace,
    transcript.metadata,
    trajectoryUri
  );
  const transcriptDigest = createHash("sha256")
    .update(transcript.contents, "utf8")
    .digest("hex");
  const captured = await captureExperienceIdempotently(
    service,
    {
      source: CLAUDE_CODE_BINDING_PROVIDER,
      transcript: transcript.contents,
      trajectoryUri,
      experience
    },
    transcriptDigest,
    context,
    CLAUDE_CODE_CAPTURE_ACTOR
  );
  return captured ? "captured" : "duplicate";
}

function requireClaudeCodeBinding() {
  const result = loadClaudeCodeCaptureBinding();
  if (!result.ok) {
    throw new ClaudeCodeCaptureValidationError(
      result.failure,
      result.failureMessage ??
        "Claude Code capture is not configured. Author the operator-owned binding file."
    );
  }
  if (!result.binding.optIn) {
    throw new ClaudeCodeCaptureValidationError(
      "claude_binding_disabled",
      "Claude Code capture is opted out in the operator binding file."
    );
  }
  return result.binding;
}

function requireClaudeCodeWorkspace(
  binding: ReturnType<typeof requireClaudeCodeBinding>,
  cwd: string
) {
  const result = resolveClaudeCodeWorkspaceBinding(binding, cwd);
  if (!result.ok || !result.workspace) {
    throw new ClaudeCodeCaptureValidationError(
      result.failure ?? "workspace_unauthorized",
      result.failureMessage ??
        "Claude Code hook cwd does not match any operator-authorized workspace root."
    );
  }
  return result.workspace;
}

function requireClaudeCodeTranscript(
  workspace: ClaudeCodeWorkspaceBinding,
  transcriptPath: string,
  sessionId: string
): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(transcriptPath);
  } catch {
    throw new ClaudeCodeCaptureValidationError(
      "transcript_root_escape",
      "Claude Code transcript path failed to realpath."
    );
  }
  const result = resolveClaudeCodeTranscriptBinding(
    workspace,
    canonicalPath,
    sessionId
  );
  if (!result.ok) {
    throw new ClaudeCodeCaptureValidationError(
      result.failure ?? "transcript_root_escape",
      result.failureMessage ??
        "Claude Code transcript must remain beneath the operator-configured transcript root."
    );
  }
  return canonicalPath;
}

async function readClaudeCodeTranscript(filePath: string) {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch {
    throw new MemoryValidationError(
      "Claude Code transcript is unavailable for reading."
    );
  }

  try {
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await handle.stat();
    } catch {
      throw new MemoryValidationError(
        "Claude Code transcript is unavailable for stat."
      );
    }
    if (
      !metadata.isFile() ||
      metadata.size <= 0 ||
      metadata.size > MAX_NATIVE_TRANSCRIPT_BYTES
    ) {
      throw new MemoryValidationError(
        "Claude Code transcript size is invalid."
      );
    }

    // Read no more than the configured ceiling plus one byte, even if the
    // file grows after `stat`. This bounds memory use at the source instead
    // of checking an arbitrarily large read after allocation.
    const buffer = Buffer.allocUnsafe(MAX_NATIVE_TRANSCRIPT_BYTES + 1);
    let bytesRead: number;
    try {
      ({ bytesRead } = await handle.read(buffer, 0, buffer.length, 0));
    } catch {
      throw new MemoryValidationError(
        "Claude Code transcript is unavailable for reading."
      );
    }
    if (
      bytesRead <= 0 ||
      bytesRead !== metadata.size ||
      bytesRead > MAX_NATIVE_TRANSCRIPT_BYTES
    ) {
      throw new MemoryValidationError(
        "Claude Code transcript size is invalid."
      );
    }
    return {
      contents: buffer.subarray(0, bytesRead).toString("utf8"),
      metadata
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function claudeCodeTrajectoryUri(sessionId: string): string {
  return `claude-code://session/${encodeURIComponent(sessionId)}`;
}

function claudeCodeExperienceEnvelope(
  input: ClaudeCodeCaptureInput,
  workspace: ReturnType<typeof requireClaudeCodeWorkspace>,
  metadata: Awaited<ReturnType<typeof stat>>,
  trajectoryUri: string
): Omit<ExperienceEnvelope, "trajectory"> {
  const birthtimeMs = Number(metadata.birthtimeMs);
  const startedAt =
    Number.isFinite(birthtimeMs) && birthtimeMs > 0
      ? new Date(birthtimeMs).toISOString()
      : new Date(Number(metadata.mtimeMs)).toISOString();
  return {
    id: `claude-code-session-${createHash("sha256")
      .update(workspace.workspaceId)
      .update("\0")
      .update(workspace.repositoryId)
      .update("\0")
      .update(input.sessionId)
      .digest("hex")}`,
    workspaceId: workspace.workspaceId,
    repositoryId: workspace.repositoryId,
    scope: {
      kind: "task",
      workspaceId: workspace.workspaceId,
      taskId: input.sessionId,
      runId: input.sessionId
    },
    taskId: input.sessionId,
    runId: input.sessionId,
    taskKind: "interactive_session",
    taskReference: { kind: "trajectory", uri: trajectoryUri },
    agentId: input.sessionId,
    agentRole: "unknown",
    startedAt,
    completedAt: new Date().toISOString(),
    outcome: "unknown",
    // Claude Code's session id is not an AutoDev Router session key, so
    // this capture cannot claim which memory mode the request cohort used.
    memoryMode: "unknown",
    evidence: [{ kind: "trajectory", uri: trajectoryUri }]
  };
}

function respondToClaudeCodeCaptureError(
  response: ServerResponse,
  audit: MemoryControlAudit,
  error: unknown
): void {
  if (error instanceof MemoryValidationError) {
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "error",
      changes: null,
      reason:
        error instanceof ClaudeCodeCaptureValidationError
          ? error.reason
          : "invalid_capture"
    });
    sendMemoryError(
      response,
      400,
      "autodev_memory_capture_invalid",
      "Native trajectory capture input is invalid."
    );
    return;
  }
  if (error instanceof MemoryConflictError) {
    audit({
      action: MEMORY_CAPTURE_ACTION,
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "error",
      changes: null,
      reason: "captured_transcript_conflict"
    });
    sendMemoryError(
      response,
      409,
      "autodev_memory_capture_conflict",
      "Native transcript conflicts with the previously captured session."
    );
    return;
  }
  audit({
    action: MEMORY_CAPTURE_ACTION,
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "error",
    changes: null,
    reason: "capture_failed"
  });
  sendMemoryError(
    response,
    503,
    "autodev_memory_capture_failed",
    "Native trajectory capture could not be completed."
  );
}

async function captureExperienceIdempotently(
  service: MemoryService,
  input: MemoryExperienceCaptureInput,
  transcriptDigest: string,
  context: MemoryReadContext,
  actorId: string
): Promise<boolean> {
  const matchesCapture = (existing: ExperienceEnvelope | null): boolean =>
    existing?.trajectory.uri === input.trajectoryUri &&
    existing.trajectory.digest === transcriptDigest;
  const existing = await service.getExperience(input.experience.id, context);
  if (existing) {
    if (matchesCapture(existing)) return false;
    throw new MemoryConflictError(
      "Native transcript differs from its captured version."
    );
  }

  try {
    await service.captureExperience(
      input,
      { id: actorId, authority: "system" },
      context
    );
    return true;
  } catch (error) {
    if (!(error instanceof MemoryConflictError)) throw error;
    const concurrentlyCaptured = await service.getExperience(
      input.experience.id,
      context
    );
    if (matchesCapture(concurrentlyCaptured)) return false;
    throw error;
  }
}

function respondToDuplicateCapture(
  response: ServerResponse,
  audit: MemoryControlAudit,
  source: "codex" | typeof CLAUDE_CODE_BINDING_PROVIDER
): void {
  audit({
    action: MEMORY_CAPTURE_ACTION,
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "ok",
    changes: { source, duplicate: true }
  });
  sendJson(
    response,
    200,
    { schema: "autodev-memory-capture-v1", captured: false },
    { "cache-control": "no-store" }
  );
}

function auditMemoryFailure(
  audit: MemoryControlAudit,
  route: MemoryControlRoute,
  outcome: "denied" | "error",
  reason: string
): void {
  audit({
    action: route.action ?? "propose",
    resource: `/control/memory/${route.resource}`,
    outcome,
    changes: null,
    reason
  });
}

function allowedMethod(
  route: MemoryControlRoute,
  method: string
): string | null {
  const isLifecycleAction = [
    "verify",
    "invalidate",
    "revise",
    "supersede",
    MEMORY_PROMOTE_SKILL_ACTION
  ].includes(route.action ?? "");
  const experiencePurge =
    route.resource === MEMORY_EXPERIENCES_ROUTE &&
    Boolean(route.id) &&
    route.action === MEMORY_PURGE_ACTION;
  const experienceOutcomes =
    route.resource === MEMORY_EXPERIENCES_ROUTE &&
    Boolean(route.id) &&
    route.action === MEMORY_OUTCOMES_ACTION;
  const experienceSessionOutcomes =
    route.resource === MEMORY_EXPERIENCES_ROUTE &&
    Boolean(route.id) &&
    (route.action === MEMORY_SESSION_OUTCOME_ACTION ||
      route.action === MEMORY_SESSION_OUTCOMES_ACTION);
  const experienceUseAssessments =
    route.resource === MEMORY_EXPERIENCES_ROUTE &&
    Boolean(route.id) &&
    route.action === MEMORY_USE_ASSESSMENTS_ACTION;
  const mutatingAction = isLifecycleAction || experiencePurge;
  const canPost =
    experiencePurge ||
    experienceOutcomes ||
    experienceSessionOutcomes ||
    experienceUseAssessments ||
    (route.resource === MEMORY_RECORDS_ROUTE &&
      ((!route.id && !route.action) || isLifecycleAction));
  if (method === "GET" && mutatingAction) return "POST";
  if (method === "POST" && !canPost) return "GET";
  if (method !== "GET" && method !== "POST")
    // A mutating action is POST-only, so `mutatingAction` answers before
    // `canPost` is consulted — otherwise a POST-only route would advertise GET
    // alongside the POST it does accept. Every remaining route that accepts POST
    // is enumerated by `canPost`, which is why the per-action list this used to
    // repeat is gone: `POST /control/memory/records` proposes a memory, so the
    // records collection accepts it without being a mutating action, and the
    // explicit list did not mention it.
    return mutatingAction ? "POST" : canPost ? "GET, POST" : "GET";
  return null;
}

function rejectUnsupportedOrUnauthorizedMethod(
  route: MemoryControlRoute,
  method: string,
  actor: MemoryControlActor,
  response: ServerResponse,
  audit: MemoryControlAudit
): boolean {
  const allow = allowedMethod(route, method);
  if (allow) {
    if (method !== "GET") {
      audit({
        action: method.toLowerCase(),
        resource: "/control/memory",
        outcome: "denied",
        changes: null,
        // The verb is the reason, whoever sent it. A viewer gets the identical
        // 405 and the identical `Allow` an operator does, so recording this as
        // `viewer_cannot_mutate` named a cause that was not the cause — and sent
        // an operator auditing it looking for a permissions fault that an
        // operator would have hit identically. The viewer's own refusal is the
        // one below, which is reached when the method is fine and the caller is
        // not.
        reason: "unsupported_memory_method"
      });
    }
    response.setHeader("allow", allow);
    sendMemoryError(
      response,
      405,
      "autodev_memory_method_not_allowed",
      "Method is not supported for this memory route."
    );
    return true;
  }
  if (method === "POST" && actor.role !== "operator") {
    auditMemoryFailure(audit, route, "denied", "viewer_cannot_mutate");
    sendMemoryError(
      response,
      403,
      "autodev_memory_viewer_forbidden",
      "Operator access is required for memory lifecycle actions."
    );
    return true;
  }
  return false;
}

function sendFilterError(response: ServerResponse, error: unknown): void {
  if (error instanceof MemoryScopeAccessError) {
    sendMemoryError(
      response,
      403,
      "autodev_memory_scope_forbidden",
      "Global or cross-scope memory access is not granted."
    );
    return;
  }
  sendMemoryError(
    response,
    400,
    "autodev_memory_invalid_filter",
    MEMORY_FILTERS_INVALID
  );
}

function dispatchMemoryMutation(
  service: MemoryService,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  context: MemoryReadContext,
  body: Record<string, unknown>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (route.resource !== MEMORY_EXPERIENCES_ROUTE) {
    return mutateMemory(service, route, actor, context, body, response, audit);
  }
  switch (route.action) {
    case MEMORY_USE_ASSESSMENTS_ACTION: {
      return reportExperienceInjectionUse(
        service,
        route,
        actor,
        context,
        body,
        response,
        audit
      );
    }
    case MEMORY_OUTCOMES_ACTION: {
      return reportExperienceOutcome(
        service,
        route,
        actor,
        context,
        body,
        response,
        audit
      );
    }
    case MEMORY_SESSION_OUTCOME_ACTION:
    case MEMORY_SESSION_OUTCOMES_ACTION: {
      return reportExperienceSessionOutcome(
        service,
        route,
        actor,
        context,
        body,
        response,
        audit
      );
    }
    case MEMORY_PURGE_ACTION: {
      return purgeMemoryExperience(
        service,
        route,
        actor,
        context,
        body,
        response,
        audit
      );
    }
    default: {
      return mutateMemory(
        service,
        route,
        actor,
        context,
        body,
        response,
        audit
      );
    }
  }
}

async function mutateRequest(
  response: ServerResponse,
  service: MemoryService,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  context: MemoryReadContext,
  body: Record<string, unknown>,
  audit: MemoryControlAudit
): Promise<void> {
  try {
    await dispatchMemoryMutation(
      service,
      route,
      actor,
      context,
      body,
      response,
      audit
    );
  } catch (error) {
    if (
      error instanceof MemoryAuthorizationError ||
      error instanceof MemoryScopeAccessError
    ) {
      auditMemoryFailure(
        audit,
        route,
        "denied",
        "scope_or_authority_forbidden"
      );
      sendMemoryError(
        response,
        403,
        "autodev_memory_forbidden",
        "Memory lifecycle action is not authorized."
      );
      return;
    }
    if (error instanceof MemoryConflictError) {
      auditMemoryFailure(audit, route, "error", "concurrent_update");
      sendMemoryError(
        response,
        409,
        "autodev_memory_conflict",
        "Memory changed concurrently; reload its current history."
      );
      return;
    }
    if (error instanceof MemoryValidationError || error instanceof TypeError) {
      auditMemoryFailure(audit, route, "error", "invalid_request");
      sendMemoryError(
        response,
        400,
        "autodev_memory_invalid_request",
        "Memory request failed validation."
      );
      return;
    }
    auditMemoryFailure(audit, route, "error", "operation_failed");
    sendMemoryError(
      response,
      503,
      "autodev_memory_operation_failed",
      "Memory operation could not be completed."
    );
  }
}

function parseRouteFilters(
  request: IncomingMessage,
  pathname: string,
  route: MemoryControlRoute,
  actor: MemoryControlActor
): ReturnType<typeof parseFilters> {
  const params = new URL(request.url ?? pathname, MEMORY_CONTROL_API_ORIGIN)
    .searchParams;
  if (
    route.action === MEMORY_OUTCOMES_ACTION &&
    ["taskId", "runId", "agentId"].some((key) => params.has(key))
  ) {
    throw new TypeError(
      "Outcome session identity is derived from the captured experience."
    );
  }
  return parseFilters(params, actor, route.resource);
}

function parseInjectionOutcomeCohortFilter(
  request: IncomingMessage,
  pathname: string,
  actor: MemoryControlActor
): MemoryInjectionOutcomeCohortFilter {
  const params = new URL(request.url ?? pathname, MEMORY_CONTROL_API_ORIGIN)
    .searchParams;
  const allowed = new Set([
    "workspaceId",
    "repositoryId",
    "includeTaskHistory",
    "occurredFrom",
    "occurredUntil",
    "memoryMode",
    "injectionResult",
    "reportKind",
    "outcomeKind"
  ]);
  if ([...params.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError(
      "Cohort reads accept only workspace/repository/time and bounded cohort filters."
    );
  }

  const context = readContext(params, actor);
  if (actor.role !== "operator" || context.canReadTaskHistory !== true) {
    throw new MemoryScopeAccessError(
      "Operator task-history access is required for memory outcome cohorts."
    );
  }
  if (!context.repositoryId) {
    throw new TypeError("Cohort reads require a repository scope.");
  }

  const memoryModes = valuesFromQuery(
    params,
    "memoryMode",
    MEMORY_EXECUTION_MODES
  );
  const injectionResults = valuesFromQuery(
    params,
    "injectionResult",
    MEMORY_INJECTION_RESULTS
  );
  const reportKinds = valuesFromQuery(
    params,
    "reportKind",
    MEMORY_OUTCOME_REPORT_KINDS
  );
  const outcomeKinds = valuesFromQuery(
    params,
    "outcomeKind",
    EXPERIENCE_OUTCOMES
  );
  const filter: MemoryInjectionOutcomeCohortFilter = {
    context,
    occurredFrom: oneFilter(params, "occurredFrom", true)!,
    occurredUntil: oneFilter(params, "occurredUntil", true)!,
    ...(memoryModes.length > 0 ? { memoryModes } : {}),
    ...(injectionResults.length > 0 ? { injectionResults } : {}),
    ...(reportKinds.length > 0 ? { reportKinds } : {}),
    ...(outcomeKinds.length > 0 ? { outcomeKinds } : {})
  };
  assertMemoryInjectionOutcomeCohortFilter(filter);
  return filter;
}

async function serveInjectionOutcomeCohorts(
  service: MemoryAssessmentCohortReader,
  filter: MemoryInjectionOutcomeCohortFilter,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  const page = await service.aggregateInjectionOutcomeCohorts(filter);
  audit({
    action: "read_cohorts",
    resource: MEMORY_COHORT_RESOURCE,
    outcome: "ok",
    changes: null
  });
  sendJson(response, 200, page satisfies MemoryInjectionOutcomeCohortPage, {
    "cache-control": "no-store"
  });
}

function parseSessionOutcomeCohortFilter(
  request: IncomingMessage,
  pathname: string,
  actor: MemoryControlActor
): MemorySessionOutcomeCohortFilter {
  const params = new URL(request.url ?? pathname, MEMORY_CONTROL_API_ORIGIN)
    .searchParams;
  const allowed = new Set([
    "workspaceId",
    "repositoryId",
    "includeTaskHistory",
    "occurredFrom",
    "occurredUntil",
    "memoryMode",
    "injectionResult",
    "reportKind",
    "outcomeKind"
  ]);
  if ([...params.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError(
      "Cohort reads accept only workspace/repository/time and bounded cohort filters."
    );
  }

  const context = readContext(params, actor);
  if (actor.role !== "operator" || context.canReadTaskHistory !== true) {
    throw new MemoryScopeAccessError(
      "Operator task-history access is required for memory outcome cohorts."
    );
  }
  if (!context.repositoryId) {
    throw new TypeError("Cohort reads require a repository scope.");
  }

  const memoryModes = valuesFromQuery(
    params,
    "memoryMode",
    MEMORY_SESSION_COHORT_ASSIGNED_MODES
  );
  const injectionResults = valuesFromQuery(
    params,
    "injectionResult",
    MEMORY_INJECTION_RESULTS
  );
  const reportKinds = valuesFromQuery(
    params,
    "reportKind",
    MEMORY_OUTCOME_REPORT_KINDS
  );
  const outcomeKinds = valuesFromQuery(
    params,
    "outcomeKind",
    EXPERIENCE_OUTCOMES
  );
  const filter: MemorySessionOutcomeCohortFilter = {
    context,
    occurredFrom: oneFilter(params, "occurredFrom", true)!,
    occurredUntil: oneFilter(params, "occurredUntil", true)!,
    ...(memoryModes.length > 0 ? { memoryModes } : {}),
    ...(injectionResults.length > 0 ? { injectionResults } : {}),
    ...(reportKinds.length > 0 ? { reportKinds } : {}),
    ...(outcomeKinds.length > 0 ? { outcomeKinds } : {})
  };
  assertMemorySessionOutcomeCohortFilter(filter);
  return filter;
}

interface ParsedMemoryUseAssessmentFilters {
  readonly context: MemoryReadContext;
  readonly memoryModes: readonly (typeof MEMORY_USE_COHORT_ASSIGNED_MODES)[number][];
  readonly useKinds: readonly MemoryUseKind[];
  readonly page: { readonly limit: number; readonly offset: number };
}

function parseMemoryUseAssessmentFilters(
  request: IncomingMessage,
  pathname: string,
  actor: MemoryControlActor
): ParsedMemoryUseAssessmentFilters {
  const params = new URL(request.url ?? pathname, MEMORY_CONTROL_API_ORIGIN)
    .searchParams;
  const allowed = new Set([
    "workspaceId",
    "repositoryId",
    "includeTaskHistory",
    "memoryMode",
    "useKind",
    "limit",
    "offset"
  ]);
  if ([...params.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError(
      "Use-assessment reads accept only repository/history scope, pagination, and bounded use filters."
    );
  }
  const context = readContext(params, actor);
  if (actor.role !== "operator" || context.canReadTaskHistory !== true) {
    throw new MemoryScopeAccessError(
      "Operator task-history access is required for injection-use assessments."
    );
  }
  if (!context.repositoryId) {
    throw new TypeError(
      "Injection-use assessment reads require repository scope."
    );
  }
  return {
    context,
    memoryModes: valuesFromQuery(
      params,
      "memoryMode",
      MEMORY_USE_COHORT_ASSIGNED_MODES
    ),
    useKinds: valuesFromQuery(params, "useKind", MEMORY_USE_KINDS),
    page: pagination(params)
  };
}

function parseInjectionUseCohortFilter(
  request: IncomingMessage,
  pathname: string,
  actor: MemoryControlActor
): MemoryInjectionUseCohortFilter {
  const params = new URL(request.url ?? pathname, MEMORY_CONTROL_API_ORIGIN)
    .searchParams;
  const allowed = new Set([
    "workspaceId",
    "repositoryId",
    "includeTaskHistory",
    "occurredFrom",
    "occurredUntil",
    "memoryMode",
    "useKind"
  ]);
  if ([...params.keys()].some((key) => !allowed.has(key))) {
    throw new TypeError(
      "Use-cohort reads accept only workspace/repository/time and bounded use filters."
    );
  }
  const context = readContext(params, actor);
  if (actor.role !== "operator" || context.canReadTaskHistory !== true) {
    throw new MemoryScopeAccessError(
      "Operator task-history access is required for injection-use cohorts."
    );
  }
  if (!context.repositoryId) {
    throw new TypeError("Injection-use cohorts require repository scope.");
  }
  const memoryModes = valuesFromQuery(
    params,
    "memoryMode",
    MEMORY_USE_COHORT_ASSIGNED_MODES
  );
  const useKinds = valuesFromQuery(params, "useKind", MEMORY_USE_KINDS);
  const filter: MemoryInjectionUseCohortFilter = {
    context,
    occurredFrom: oneFilter(params, "occurredFrom", true)!,
    occurredUntil: oneFilter(params, "occurredUntil", true)!,
    ...(memoryModes.length > 0 ? { memoryModes } : {}),
    ...(useKinds.length > 0 ? { useKinds } : {})
  };
  assertMemoryInjectionUseCohortFilter(filter);
  return filter;
}

async function serveSessionOutcomeCohorts(
  service: MemoryAssessmentCohortReader,
  filter: MemorySessionOutcomeCohortFilter,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  const page = await service.aggregateSessionOutcomeCohorts(filter);
  audit({
    action: "read_session_cohorts",
    resource: MEMORY_SESSION_COHORT_RESOURCE,
    outcome: "ok",
    changes: null
  });
  sendJson(response, 200, page satisfies ControlApiMemoryCohortsResponse, {
    "cache-control": "no-store"
  });
}

async function serveInjectionUseCohorts(
  service: MemoryAssessmentCohortReader,
  filter: MemoryInjectionUseCohortFilter,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  const page = await service.aggregateInjectionUseCohorts(filter);
  audit({
    action: "read_injection_use_cohorts",
    resource: MEMORY_USE_COHORT_RESOURCE,
    outcome: "ok",
    changes: null
  });
  sendJson(response, 200, page satisfies ControlApiMemoryUseCohortsResponse, {
    "cache-control": "no-store"
  });
}

type ParsedMemoryControlFilters =
  | {
      readonly kind: typeof MEMORY_COHORTS_ROUTE;
      readonly cohort: MemoryInjectionOutcomeCohortFilter;
    }
  | {
      readonly kind: typeof MEMORY_SESSION_COHORTS_ROUTE;
      readonly cohort: MemorySessionOutcomeCohortFilter;
    }
  | {
      readonly kind: typeof MEMORY_USE_COHORTS_ROUTE;
      readonly cohort: MemoryInjectionUseCohortFilter;
    }
  | {
      readonly kind: typeof MEMORY_USE_ASSESSMENTS_ACTION;
      readonly filters: ParsedMemoryUseAssessmentFilters;
    }
  | {
      readonly kind: "standard";
      readonly filters: ReturnType<typeof parseFilters>;
    };

function parseMemoryRequestFilters(
  request: IncomingMessage,
  pathname: string,
  route: MemoryControlRoute,
  actor: MemoryControlActor
): ParsedMemoryControlFilters {
  if (route.resource === MEMORY_COHORTS_ROUTE) {
    return {
      kind: MEMORY_COHORTS_ROUTE,
      cohort: parseInjectionOutcomeCohortFilter(request, pathname, actor)
    };
  }
  if (route.resource === MEMORY_SESSION_COHORTS_ROUTE) {
    return {
      kind: MEMORY_SESSION_COHORTS_ROUTE,
      cohort: parseSessionOutcomeCohortFilter(request, pathname, actor)
    };
  }
  if (route.resource === MEMORY_USE_COHORTS_ROUTE) {
    return {
      kind: MEMORY_USE_COHORTS_ROUTE,
      cohort: parseInjectionUseCohortFilter(request, pathname, actor)
    };
  }
  if (
    route.resource === MEMORY_EXPERIENCES_ROUTE &&
    route.action === MEMORY_USE_ASSESSMENTS_ACTION
  ) {
    return {
      kind: MEMORY_USE_ASSESSMENTS_ACTION,
      filters: parseMemoryUseAssessmentFilters(request, pathname, actor)
    };
  }
  return {
    kind: "standard",
    filters: parseRouteFilters(request, pathname, route, actor)
  };
}

function memoryContextForRequest(
  parsedFilters: ParsedMemoryControlFilters
): MemoryReadContext {
  if (
    parsedFilters.kind === MEMORY_COHORTS_ROUTE ||
    parsedFilters.kind === MEMORY_SESSION_COHORTS_ROUTE ||
    parsedFilters.kind === MEMORY_USE_COHORTS_ROUTE
  ) {
    return parsedFilters.cohort.context;
  }
  if (parsedFilters.kind === MEMORY_USE_ASSESSMENTS_ACTION) {
    return parsedFilters.filters.context;
  }
  return parsedFilters.filters.context;
}

function serveMemoryReadRoute(
  service: MemoryService,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  filters: ReturnType<typeof parseFilters>,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (
    route.resource === MEMORY_EXPERIENCES_ROUTE &&
    route.action === MEMORY_OUTCOMES_ACTION
  ) {
    return serveExperienceOutcomes(
      service,
      route,
      actor,
      filters,
      response,
      audit
    );
  }
  if (
    route.resource === MEMORY_EXPERIENCES_ROUTE &&
    (route.action === MEMORY_SESSION_OUTCOME_ACTION ||
      route.action === MEMORY_SESSION_OUTCOMES_ACTION)
  ) {
    return serveExperienceSessionOutcome(
      service,
      route,
      actor,
      filters.context,
      response,
      audit
    );
  }
  if (route.resource === MEMORY_EXPERIENCES_ROUTE)
    return serveExperience(service, route, filters, response, audit);
  return serveRecord(service, route, filters, response);
}

function serveMemoryRequestRead(
  service: MemoryService,
  route: MemoryControlRoute,
  actor: MemoryControlActor,
  parsedFilters: ParsedMemoryControlFilters,
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  if (parsedFilters.kind === MEMORY_COHORTS_ROUTE) {
    return serveInjectionOutcomeCohorts(
      service,
      parsedFilters.cohort,
      response,
      audit
    );
  }
  if (parsedFilters.kind === MEMORY_SESSION_COHORTS_ROUTE) {
    return serveSessionOutcomeCohorts(
      service,
      parsedFilters.cohort,
      response,
      audit
    );
  }
  if (parsedFilters.kind === MEMORY_USE_COHORTS_ROUTE) {
    return serveInjectionUseCohorts(
      service,
      parsedFilters.cohort,
      response,
      audit
    );
  }
  if (parsedFilters.kind === MEMORY_USE_ASSESSMENTS_ACTION) {
    return serveExperienceInjectionUseAssessments(
      service,
      route,
      actor,
      parsedFilters.filters,
      response,
      audit
    );
  }
  return serveMemoryReadRoute(
    service,
    route,
    actor,
    parsedFilters.filters,
    response,
    audit
  );
}

/**
 * Storage status is answered before anything that needs storage.
 *
 * Every other route on this API resolves a service first and answers the same
 * `503 autodev_memory_unavailable` whether storage was never configured or is
 * configured and down, so the one read whose whole job is to tell those apart
 * cannot go through that path -- it would report the answer to a question it
 * was built to answer. It also takes no `workspaceId`: it describes this
 * Runtime's own storage rather than any workspace's memory, which is why it
 * needs no task-history grant either. It is an administration read, so it is
 * audited like one.
 */
async function serveMemoryStorageStatus(
  response: ServerResponse,
  audit: MemoryControlAudit
): Promise<void> {
  const status = await observeMemoryStorageStatus();
  audit({
    action: "read_storage_status",
    resource: MEMORY_STATUS_ROUTE,
    outcome: "ok",
    changes: { state: status.state, embeddings: status.embeddings }
  });
  sendJson(
    response,
    200,
    {
      schema: "autodev-memory-status-v1",
      storage: {
        state: status.state,
        backend: "postgresql",
        embeddings: status.embeddings,
        probeTimeoutMs: status.probeTimeoutMs
      }
    } satisfies ControlApiMemoryStatusResponse,
    { "cache-control": "no-store" }
  );
}

export interface MemoryControlApiDependencies {
  readonly createMemoryService?: () => MemoryService | null;
}

/**
 * The memory routes that answer without a parsed route.
 *
 * Both capture endpoints are POST-only and identical apart from the adapter they
 * hand the body to, and the storage-status read is a read rather than a capture.
 * They are dispatched together because they share the one thing that made them
 * separate branches in the first place: none of them can go through
 * `parseRoute`, which requires a workspace-scoped collection route.
 *
 * The capture endpoints resolve the service through the caller's injected
 * factory, exactly as the routed reads and writes below do. They used to call
 * `createOrchestratorMemoryService` directly, which meant the only way to reach
 * a successful capture — including the idempotent-duplicate reply and the 409 a
 * differing replay earns — was with a live store behind it.
 *
 * Returns `true` when the path was one of these, so the caller stops. `false`
 * means the path belongs to the routed API below.
 */
async function servePathWithoutStorage(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
  actor: MemoryControlActor,
  audit: MemoryControlAudit,
  dependencies: MemoryControlApiDependencies
): Promise<boolean> {
  const method = (request.method ?? "GET").toUpperCase();
  const capture =
    pathname === MEMORY_CAPTURE_PATH
      ? captureCodexExperience
      : pathname === MEMORY_CLAUDE_CAPTURE_PATH
        ? captureClaudeCodeExperience
        : null;
  if (capture) {
    if (method !== "POST") {
      response.setHeader("allow", "POST");
      sendMemoryError(
        response,
        405,
        "autodev_memory_method_not_allowed",
        "Native capture requires POST."
      );
      return true;
    }
    await capture(request, response, actor, audit, dependencies);
    return true;
  }
  if (pathname === MEMORY_STATUS_PATH) {
    if (method !== "GET") {
      response.setHeader("allow", "GET");
      sendMemoryError(
        response,
        405,
        "autodev_memory_method_not_allowed",
        "Method is not supported for this memory route."
      );
      return true;
    }
    await serveMemoryStorageStatus(response, audit);
    return true;
  }
  return false;
}

export async function handleMemoryControlApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: MemoryControlActor,
  audit: MemoryControlAudit,
  dependencies: MemoryControlApiDependencies = {}
): Promise<boolean> {
  if (!pathname.startsWith(MEMORY_PATH_PREFIX)) return false;
  if (
    await servePathWithoutStorage(
    pathname,
    request,
    response,
    actor,
    audit,
    dependencies
  )
  ) {
    return true;
  }
  const route = parseRoute(pathname);
  if (!route) {
    sendMemoryError(
      response,
      404,
      "autodev_memory_unknown_path",
      "Unknown memory path."
    );
    return true;
  }
  const method = (request.method ?? "GET").toUpperCase();
  if (
    rejectUnsupportedOrUnauthorizedMethod(route, method, actor, response, audit)
  ) {
    return true;
  }

  let parsedFilters: ParsedMemoryControlFilters;
  try {
    parsedFilters = parseMemoryRequestFilters(request, pathname, route, actor);
  } catch (error) {
    // A refused filter is still a request someone made against this resource,
    // and it leaves no other trace: the read never reaches the service, so the
    // audit trail is the only record that a caller was probing windows it
    // cannot read. Auditing here rather than in `sendFilterError` keeps the
    // route on the entry, which is what makes the refusal attributable.
    const scopeRefusal = error instanceof MemoryScopeAccessError;
    auditMemoryFailure(
      audit,
      route,
      scopeRefusal ? "denied" : "error",
      scopeRefusal ? "scope_filter_forbidden" : "invalid_filter"
    );
    sendFilterError(response, error);
    return true;
  }

  let mutationBody: Record<string, unknown> | undefined;
  if (method === "POST") {
    const parsed = await readControlApiJsonObject(request);
    if (!parsed.ok) {
      auditMemoryFailure(audit, route, "error", "invalid_body");
      sendBodyError(response, parsed);
      return true;
    }
    mutationBody = parsed.body;
  }

  const service = (
    dependencies.createMemoryService ?? createOrchestratorMemoryService
  )();
  if (!service) {
    // Audited for reads as well as writes. Reads are audited when they succeed,
    // so a read that cannot even start would otherwise be the one outcome on
    // this route with no trace at all — and "storage is not configured" is a
    // deployment fault whose only symptom is a page that will not load.
    auditMemoryFailure(audit, route, "error", "memory_unavailable");
    sendMemoryError(
      response,
      503,
      "autodev_memory_unavailable",
      "Memory storage is not configured."
    );
    return true;
  }
  if (method === "POST") {
    await mutateRequest(
      response,
      service,
      route,
      actor,
      memoryContextForRequest(parsedFilters),
      mutationBody!,
      audit
    );
    return true;
  }
  try {
    await serveMemoryRequestRead(
      service,
      route,
      actor,
      parsedFilters,
      response,
      audit
    );
  } catch (error) {
    // A read is audited when it succeeds, so a failed one has to be audited
    // too — otherwise the trail shows an operator a clean record of reads that
    // in fact fell over. The causes stay apart because they ask for different
    // next moves: a refusal is the caller's business and will fail identically
    // on retry, a rejected request is theirs to fix, and a failed operation is
    // the store's, where retrying is the answer.
    //
    // Authorization and scope are classified exactly as `mutateRequest`
    // classifies them. The service re-checks authority per record, so it can
    // raise these from a read; answering 503 for one would tell an operator
    // their permissions problem is a broken install.
    if (
      error instanceof MemoryAuthorizationError ||
      error instanceof MemoryScopeAccessError
    ) {
      auditMemoryFailure(audit, route, "denied", "scope_or_authority_forbidden");
      sendMemoryError(
        response,
        403,
        "autodev_memory_forbidden",
        "Memory access is not granted for this reader."
      );
      return true;
    }
    if (error instanceof MemoryValidationError) {
      auditMemoryFailure(audit, route, "error", "invalid_request");
      sendMemoryError(
        response,
        400,
        "autodev_memory_invalid_request",
        "Memory request failed validation."
      );
      return true;
    }
    auditMemoryFailure(audit, route, "error", "operation_failed");
    sendMemoryError(
      response,
      503,
      "autodev_memory_operation_failed",
      "Memory operation could not be completed."
    );
  }
  return true;
}
