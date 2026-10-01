import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import path from "node:path";

import {
  type EvidenceReference,
  type ExperienceEnvelope,
  MEMORY_KINDS,
  MEMORY_REASON_CODES,
  MEMORY_STATUSES,
  type MemoryActor,
  type MemoryKind,
  type MemoryReadContext,
  type MemoryReasonCode,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStatus
} from "@simulatorlife/autodev-core";
import {
  MemoryAuthorizationError,
  MemoryConflictError,
  type MemoryExperienceCaptureInput,
  type MemoryProposalInput,
  type MemoryService,
  type MemorySkillPromotionArtifact,
  MemoryValidationError
} from "@simulatorlife/autodev-runtime/memory";

import { readControlApiJsonObject } from "./control-api-body.ts";
import {
  createOrchestratorMemoryService,
  trustedMemoryContextForSession
} from "./memory-injection.ts";
import { errorBody, sendJson } from "./proxy.ts";

const MEMORY_PATH_PREFIX = "/control/memory/";
const MEMORY_CAPTURE_PATH = `${MEMORY_PATH_PREFIX}capture`;
const MEMORY_CAPTURE_ACTION = "capture_experience";
const MEMORY_PROMOTE_SKILL_ACTION = "promote-skill";
const MEMORY_EXPERIENCE_RESOURCE = "/control/memory/experiences";
const MAX_NATIVE_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_FILTER_VALUE = 256;
const MAX_PAGE_SIZE = 100;
const MAX_PAGE_OFFSET = 100_000;
const MAX_EVIDENCE_REFERENCES = 64;
const MAX_EXPERIENCE_IDS = 64;
const MAX_CLAIM_CHARACTERS = 4000;
const MEMORY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const PAGE_NUMBER_PATTERN = /^(0|[1-9]\d{0,8})$/u;
const EVIDENCE_KINDS = [
  "trajectory",
  "trace",
  "file",
  "commit",
  "pull_request",
  "issue",
  "rule",
  "skill",
  "document",
  "other"
] as const satisfies readonly EvidenceReference["kind"][];

type MemoryControlRoute = {
  readonly resource: "records" | "experiences";
  readonly id?: string;
  readonly action?:
    | "history"
    | "why"
    | "verify"
    | "invalidate"
    | "revise"
    | "supersede"
    | "purge"
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
  if (resource !== "records" && resource !== "experiences") return null;
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
    resource === "records" &&
    [
      "history",
      "why",
      "verify",
      "invalidate",
      "revise",
      "supersede",
      MEMORY_PROMOTE_SKILL_ACTION
    ].includes(action ?? "");
  const experienceAction = resource === "experiences" && action === "purge";
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

function queryText(params: URLSearchParams): string | undefined {
  const query = oneFilter(params, "query");
  if (query && query.length > MAX_CLAIM_CHARACTERS)
    throw new TypeError("'query' exceeds its character bound.");
  return query;
}

function parseFilters(
  params: URLSearchParams,
  actor: MemoryControlActor
): {
  readonly context: MemoryReadContext;
  readonly page: { limit: number; offset: number };
  readonly query?: string;
  readonly kinds?: readonly MemoryKind[];
  readonly statuses?: readonly MemoryStatus[];
} {
  const context = readContext(params, actor);
  const page = pagination(params);
  const query = queryText(params);
  const kinds = valuesFromQuery(params, "kind", MEMORY_KINDS);
  const statuses = valuesFromQuery(params, "status", MEMORY_STATUSES);
  return {
    context,
    page,
    ...(query ? { query } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(statuses.length > 0 ? { statuses } : {})
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

function evidenceReferences(value: unknown): readonly EvidenceReference[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_EVIDENCE_REFERENCES
  ) {
    throw new MemoryValidationError("Memory evidence references are invalid.");
  }
  return value.map((entry) => {
    if (!isObject(entry) || !EVIDENCE_KINDS.includes(entry.kind as never))
      throw new MemoryValidationError("Memory evidence reference is invalid.");
    const uri = requiredString(entry, "uri", 2048);
    const revision = entry.revision;
    const observedAt = entry.observedAt;
    if (
      revision !== undefined &&
      (typeof revision !== "string" || revision.length > 256)
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
  const claim = requiredString(value, "claim", MAX_CLAIM_CHARACTERS);
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
  const task = requiredString(body, "task", MAX_CLAIM_CHARACTERS);
  const query = requiredString(body, "query", MAX_CLAIM_CHARACTERS);
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
  response: ServerResponse
): Promise<void> {
  if (route.id) {
    const experience = await service.getExperience(route.id, filters.context);
    if (!experience) {
      sendMemoryError(
        response,
        404,
        "autodev_memory_not_found",
        "Memory experience was not found."
      );
      return;
    }
    sendJson(
      response,
      200,
      { schema: "autodev-memory-experience-v1", experience },
      { "cache-control": "no-store" }
    );
    return;
  }
  const result = await service.listExperiences({
    context: filters.context,
    ...(filters.query ? { query: filters.query } : {}),
    ...filters.page
  });
  sendJson(
    response,
    200,
    { schema: "autodev-memory-experiences-v1", ...result },
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
    if (route.action === "history" || route.action === "why") {
      const result =
        route.action === "history"
          ? await service.history(route.id, filters.context)
          : await service.why(route.id, filters.context);
      if (!result) {
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
        { schema: `autodev-memory-${route.action}-v1`, ...result },
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
      { schema: "autodev-memory-record-v1", memory },
      { "cache-control": "no-store" }
    );
    return;
  }
  const result = await service.listMemories({
    context: filters.context,
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.kinds ? { kinds: filters.kinds } : {}),
    ...(filters.statuses ? { statuses: filters.statuses } : {}),
    ...filters.page
  });
  sendJson(
    response,
    200,
    { schema: "autodev-memory-records-v1", ...result },
    { "cache-control": "no-store" }
  );
}

async function purgeMemoryExperience(
  service: MemoryService,
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
  if (reason !== "privacy_request" && reason !== "retention_expired")
    throw new MemoryValidationError("Memory purge reason is invalid.");
  const purge = await service.purgeExperience(
    route.id,
    reason,
    actorForControl(actor),
    context
  );
  if (purge === "not_visible") {
    audit({
      action: "purge",
      resource: MEMORY_EXPERIENCE_RESOURCE,
      outcome: "denied",
      changes: null,
      reason: "experience_not_visible"
    });
    sendMemoryError(
      response,
      404,
      "autodev_memory_not_found",
      "Memory experience was not found."
    );
    return;
  }
  if (purge === "referenced_by_memory") {
    audit({
      action: "purge",
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
    action: "purge",
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

  if (route.resource !== "records")
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
        const claim = requiredString(body, "claim", MAX_CLAIM_CHARACTERS);
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
  audit: MemoryControlAudit
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

    const service = createOrchestratorMemoryService();
    if (!service) {
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
      evidence: [{ kind: "trajectory", uri: trajectoryUri }]
    };
    const captured = await captureCodexExperienceIdempotently(
      service,
      { source: "codex", transcript, trajectoryUri, experience },
      transcriptDigest,
      context
    );
    if (!captured) {
      respondToDuplicateCodexCapture(response, audit);
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

async function captureCodexExperienceIdempotently(
  service: MemoryService,
  input: MemoryExperienceCaptureInput,
  transcriptDigest: string,
  context: MemoryReadContext
): Promise<boolean> {
  const matchesCapture = (existing: ExperienceEnvelope | null): boolean =>
    existing?.trajectory.uri === input.trajectoryUri &&
    existing.trajectory.digest === transcriptDigest;
  const existing = await service.getExperience(input.experience.id, context);
  if (existing) {
    if (matchesCapture(existing)) return false;
    throw new MemoryConflictError(
      "Codex session transcript differs from its captured version."
    );
  }

  try {
    await service.captureExperience(
      input,
      { id: "autodev-codex-session-end", authority: "system" },
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

function respondToDuplicateCodexCapture(
  response: ServerResponse,
  audit: MemoryControlAudit
): void {
  audit({
    action: MEMORY_CAPTURE_ACTION,
    resource: MEMORY_EXPERIENCE_RESOURCE,
    outcome: "ok",
    changes: { source: "codex", duplicate: true }
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
    route.resource === "experiences" &&
    Boolean(route.id) &&
    route.action === "purge";
  const mutatingAction = isLifecycleAction || experiencePurge;
  const canPost =
    experiencePurge ||
    (route.resource === "records" &&
      ((!route.id && !route.action) || isLifecycleAction));
  if (method === "GET" && mutatingAction) return "POST";
  if (method === "POST" && !canPost) return "GET";
  if (method !== "GET" && method !== "POST")
    return mutatingAction ? "POST" : "GET";
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
        reason:
          actor.role === "viewer"
            ? "viewer_cannot_mutate"
            : "unsupported_memory_method"
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
    "Memory filters are invalid or incomplete."
  );
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
    const mutation =
      route.resource === "experiences" && route.action === "purge"
        ? purgeMemoryExperience(
            service,
            route,
            actor,
            context,
            body,
            response,
            audit
          )
        : mutateMemory(service, route, actor, context, body, response, audit);
    await mutation;
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

export async function handleMemoryControlApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  actor: MemoryControlActor,
  audit: MemoryControlAudit
): Promise<boolean> {
  if (!pathname.startsWith(MEMORY_PATH_PREFIX)) return false;
  if (pathname === MEMORY_CAPTURE_PATH) {
    if ((request.method ?? "GET").toUpperCase() !== "POST") {
      response.setHeader("allow", "POST");
      sendMemoryError(
        response,
        405,
        "autodev_memory_method_not_allowed",
        "Native capture requires POST."
      );
      return true;
    }
    await captureCodexExperience(request, response, actor, audit);
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

  let filters: ReturnType<typeof parseFilters>;
  try {
    const params = new URL(request.url ?? pathname, "http://127.0.0.1")
      .searchParams;
    filters = parseFilters(params, actor);
  } catch (error) {
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

  const service = createOrchestratorMemoryService();
  if (!service) {
    if (method === "POST")
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
      filters.context,
      mutationBody!,
      audit
    );
    return true;
  }
  try {
    if (route.resource === "experiences") {
      await serveExperience(service, route, filters, response);
    } else {
      await serveRecord(service, route, filters, response);
    }
  } catch (error) {
    if (error instanceof MemoryValidationError) {
      sendMemoryError(
        response,
        400,
        "autodev_memory_invalid_request",
        "Memory request failed validation."
      );
      return true;
    }
    sendMemoryError(
      response,
      503,
      "autodev_memory_operation_failed",
      "Memory operation could not be completed."
    );
  }
  return true;
}
