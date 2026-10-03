import {
  type EvidenceReference,
  EXPERIENCE_OUTCOMES as CORE_EXPERIENCE_OUTCOMES,
  type ExperienceEnvelope,
  type ExperienceOutcome,
  MEMORY_EXECUTION_MODES,
  MEMORY_INJECTION_EVENT_REASON_CODES,
  MEMORY_INJECTION_RESULTS,
  MEMORY_OUTCOME_REPORT_KINDS,
  MEMORY_OUTCOME_REPORT_REASON_CODES,
  MEMORY_REASON_CODES,
  type MemoryAuthority,
  type MemoryExecutionMode,
  type MemoryInjectionEvent,
  type MemoryInjectionEventReasonCode,
  type MemoryInjectionResult,
  type MemoryKind,
  type MemoryLifecycleAction,
  type MemoryLifecycleEvent,
  type MemoryOutcomeReport,
  type MemoryOutcomeReportKind,
  type MemoryOutcomeReportReasonCode,
  type MemoryProvenance,
  type MemoryReasonCode,
  type MemoryRecord,
  type MemorySessionOutcomeReport,
  type MemoryStatus,
  type MemoryValidationState,
  type MemoryValidity
} from "@simulatorlife/autodev-core";

import { MemoryHydrationError } from "./errors.ts";
import { columnsToScope } from "./scope-sql.ts";

const MEMORY_EXECUTION_MODE_SET: ReadonlySet<string> = new Set(
  MEMORY_EXECUTION_MODES
);
const EXPERIENCE_OUTCOMES: ReadonlySet<string> = new Set(
  CORE_EXPERIENCE_OUTCOMES
);
const MEMORY_KINDS: ReadonlySet<string> = new Set([
  "episodic",
  "semantic",
  "procedural"
]);
const MEMORY_STATUSES: ReadonlySet<string> = new Set([
  "proposed",
  "active",
  "superseded",
  "invalidated",
  "uncertain"
]);
const VALIDATION_STATES: ReadonlySet<string> = new Set([
  "unverified",
  "verified",
  "uncertain",
  "contradicted"
]);
const MEMORY_REASON_CODE_SET: ReadonlySet<string> = new Set(
  MEMORY_REASON_CODES
);
const LIFECYCLE_ACTIONS: ReadonlySet<string> = new Set([
  "proposed",
  "verified",
  "revised",
  "invalidated",
  "superseded",
  "promoted",
  "procedure_promoted"
]);
const MEMORY_INJECTION_RESULT_SET: ReadonlySet<string> = new Set(
  MEMORY_INJECTION_RESULTS
);
const MEMORY_INJECTION_EVENT_REASON_SET: ReadonlySet<string> = new Set(
  MEMORY_INJECTION_EVENT_REASON_CODES
);
const MEMORY_OUTCOME_REPORT_KIND_SET: ReadonlySet<string> = new Set(
  MEMORY_OUTCOME_REPORT_KINDS
);
const MEMORY_OUTCOME_REPORT_REASON_SET: ReadonlySet<string> = new Set(
  MEMORY_OUTCOME_REPORT_REASON_CODES
);
const MEMORY_AUTHORITY_SET: ReadonlySet<string> = new Set([
  "worker",
  "root",
  "curator",
  "system"
]);
const EVIDENCE_KINDS: ReadonlySet<string> = new Set([
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
]);

const INTEGER_STRING_PATTERN = /^-?\d+$/u;

function fail(table: string, column: string, detail: string): never {
  throw new MemoryHydrationError(table, column, detail);
}

function requireEnum<T extends string>(
  table: string,
  column: string,
  value: unknown,
  allowed: ReadonlySet<string>
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    fail(
      table,
      column,
      `expected one of [${[...allowed].join(", ")}], got ${JSON.stringify(value)}`
    );
  }
  return value as T;
}

function requireString(table: string, column: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(table, column, "expected a non-empty string");
  }
  return value;
}

function optionalString(
  table: string,
  column: string,
  value: unknown
): string | undefined {
  let result: string | undefined;
  if (value !== null && value !== undefined) {
    if (typeof value !== "string") {
      fail(table, column, "expected a string or null");
    }
    result = value;
  }
  return result;
}

function requireIsoString(
  table: string,
  column: string,
  value: unknown
): string {
  const text = requireString(
    table,
    column,
    value instanceof Date ? value.toISOString() : value
  );
  if (Number.isNaN(Date.parse(text))) {
    fail(
      table,
      column,
      `expected an ISO-8601 timestamp, got ${JSON.stringify(text)}`
    );
  }
  return text;
}

function optionalIsoString(
  table: string,
  column: string,
  value: unknown
): string | undefined {
  let result: string | undefined;
  if (value !== null && value !== undefined) {
    result = requireIsoString(table, column, value);
  }
  return result;
}

function requireJson(table: string, column: string, value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      fail(table, column, `invalid JSON: ${(error as Error).message}`);
    }
  }
  if (value === null || value === undefined) {
    fail(table, column, "expected JSON content, got null/undefined");
  }
  return value;
}

function parseEvidenceList(
  table: string,
  column: string,
  raw: unknown
): EvidenceReference[] {
  const value = requireJson(table, column, raw);
  if (!Array.isArray(value)) fail(table, column, "expected a JSON array");
  return value.map((entry, index) =>
    parseEvidence(table, `${column}[${index}]`, entry)
  );
}

function parseEvidence(
  table: string,
  path: string,
  raw: unknown
): EvidenceReference {
  if (typeof raw !== "object" || raw === null)
    fail(table, path, "expected an object");
  const entry = raw as Record<string, unknown>;
  const kind = requireEnum<EvidenceReference["kind"]>(
    table,
    `${path}.kind`,
    entry.kind,
    EVIDENCE_KINDS
  );
  const uri = requireString(table, `${path}.uri`, entry.uri);
  const revision = optionalString(table, `${path}.revision`, entry.revision);
  const observedAt = optionalIsoString(
    table,
    `${path}.observedAt`,
    entry.observedAt
  );
  return {
    kind,
    uri,
    ...(revision === undefined ? {} : { revision }),
    ...(observedAt === undefined ? {} : { observedAt })
  };
}

/** Validates and maps a memory_experiences row into an ExperienceEnvelope. */
export function hydrateExperienceRow(
  row: Record<string, unknown>
): ExperienceEnvelope {
  const table = "memory_experiences";
  const outcome = requireEnum<ExperienceOutcome>(
    table,
    "outcome",
    row.outcome,
    EXPERIENCE_OUTCOMES
  );
  const memoryMode =
    row.memory_mode === null || row.memory_mode === undefined
      ? undefined
      : requireEnum<MemoryExecutionMode>(
          table,
          "memory_mode",
          row.memory_mode,
          MEMORY_EXECUTION_MODE_SET
        );
  const validationState = row.validation_state;
  const validation =
    validationState === null || validationState === undefined
      ? undefined
      : {
          state: requireEnum<"passed" | "failed" | "partial" | "not_run">(
            table,
            "validation_state",
            validationState,
            new Set(["passed", "failed", "partial", "not_run"])
          ),
          evidence: parseEvidenceList(
            table,
            "validation_evidence",
            row.validation_evidence ?? "[]"
          )
        };

  const repositoryId = optionalString(
    table,
    "repository_id",
    row.repository_id
  );
  const taskKind = optionalString(table, "task_kind", row.task_kind);
  const agentRole = optionalString(table, "agent_role", row.agent_role);
  const provider = optionalString(table, "provider", row.provider);
  const model = optionalString(table, "model", row.model);
  const branch = optionalString(table, "branch", row.branch);
  const baseCommit = optionalString(table, "base_commit", row.base_commit);
  const headCommit = optionalString(table, "head_commit", row.head_commit);
  const completedAt = optionalIsoString(
    table,
    "completed_at",
    row.completed_at
  );
  const trajectoryDigest = optionalString(
    table,
    "trajectory_digest",
    row.trajectory_digest
  );
  const trajectoryRecordCount =
    row.trajectory_record_count === null ||
    row.trajectory_record_count === undefined
      ? undefined
      : Number(row.trajectory_record_count);
  const taskReference =
    row.task_reference === null || row.task_reference === undefined
      ? undefined
      : parseEvidence(
          table,
          "task_reference",
          requireJson(table, "task_reference", row.task_reference)
        );
  const planReference =
    row.plan_reference === null || row.plan_reference === undefined
      ? undefined
      : parseEvidence(
          table,
          "plan_reference",
          requireJson(table, "plan_reference", row.plan_reference)
        );

  return {
    id: requireString(table, "id", row.id),
    workspaceId: requireString(table, "workspace_id", row.workspace_id),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    scope: columnsToScope(table, row),
    taskId: requireString(table, "task_id", row.task_id),
    runId: requireString(table, "run_id", row.run_id),
    ...(taskKind === undefined ? {} : { taskKind }),
    ...(taskReference === undefined ? {} : { taskReference }),
    ...(planReference === undefined ? {} : { planReference }),
    agentId: requireString(table, "agent_id", row.agent_id),
    ...(agentRole === undefined ? {} : { agentRole }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(branch === undefined ? {} : { branch }),
    ...(baseCommit === undefined ? {} : { baseCommit }),
    ...(headCommit === undefined ? {} : { headCommit }),
    startedAt: requireIsoString(table, "started_at", row.started_at),
    ...(completedAt === undefined ? {} : { completedAt }),
    outcome,
    ...(memoryMode === undefined ? {} : { memoryMode }),
    ...(validation === undefined ? {} : { validation }),
    trajectory: {
      format: requireString(table, "trajectory_format", row.trajectory_format),
      uri: requireString(table, "trajectory_uri", row.trajectory_uri),
      ...(trajectoryDigest === undefined ? {} : { digest: trajectoryDigest }),
      ...(trajectoryRecordCount === undefined
        ? {}
        : { recordCount: trajectoryRecordCount })
    },
    evidence: parseEvidenceList(table, "evidence", row.evidence ?? "[]")
  };
}

function parseProvenance(table: string, raw: unknown): MemoryProvenance {
  const value = requireJson(table, "provenance", raw) as Record<
    string,
    unknown
  >;
  const experienceIds = value.experienceIds;
  if (
    !Array.isArray(experienceIds) ||
    experienceIds.some((id) => typeof id !== "string")
  ) {
    fail(table, "provenance.experienceIds", "expected a string array");
  }
  const verificationSource = optionalString(
    table,
    "provenance.verificationSource",
    value.verificationSource
  );
  const lastVerifiedAt = optionalIsoString(
    table,
    "provenance.lastVerifiedAt",
    value.lastVerifiedAt
  );
  return {
    experienceIds: experienceIds as string[],
    evidence: parseEvidenceList(
      table,
      "provenance.evidence",
      value.evidence ?? []
    ),
    createdBy: requireString(table, "provenance.createdBy", value.createdBy),
    createdAt: requireIsoString(table, "provenance.createdAt", value.createdAt),
    ...(verificationSource === undefined ? {} : { verificationSource }),
    ...(lastVerifiedAt === undefined ? {} : { lastVerifiedAt })
  };
}

function parseValidity(
  table: string,
  row: Record<string, unknown>
): MemoryValidity {
  const detail = requireJson(
    table,
    "validity_detail",
    row.validity_detail ?? "{}"
  ) as Record<string, unknown>;
  const validFrom = optionalIsoString(
    table,
    "validity_valid_from",
    row.validity_valid_from
  );
  const validTo = optionalIsoString(
    table,
    "validity_valid_to",
    row.validity_valid_to
  );
  const checkedAt = optionalIsoString(
    table,
    "validity_detail.checkedAt",
    detail.checkedAt
  );
  const verificationSource = optionalString(
    table,
    "validity_detail.verificationSource",
    detail.verificationSource
  );
  return {
    state: requireEnum<MemoryValidationState>(
      table,
      "validity_state",
      row.validity_state,
      VALIDATION_STATES
    ),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validTo === undefined ? {} : { validTo }),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(verificationSource === undefined ? {} : { verificationSource }),
    evidence: parseEvidenceList(
      table,
      "validity_detail.evidence",
      detail.evidence ?? []
    )
  };
}

function parseIdArray(table: string, column: string, raw: unknown): string[] {
  const value = requireJson(table, column, raw ?? "[]");
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    fail(table, column, "expected a JSON array of strings");
  }
  return value as string[];
}

/** Validates and maps a memory_records row into a MemoryRecord. */
export function hydrateMemoryRecordRow(
  row: Record<string, unknown>
): MemoryRecord {
  const table = "memory_records";
  const supersedes = parseIdArray(table, "supersedes", row.supersedes);
  const supersededBy = parseIdArray(table, "superseded_by", row.superseded_by);
  return {
    id: requireString(table, "id", row.id),
    kind: requireEnum<MemoryKind>(table, "kind", row.kind, MEMORY_KINDS),
    scope: columnsToScope(table, row),
    claim: requireString(table, "claim", row.claim),
    status: requireEnum<MemoryStatus>(
      table,
      "status",
      row.status,
      MEMORY_STATUSES
    ),
    provenance: parseProvenance(table, row.provenance),
    validity: parseValidity(table, row),
    ...(supersedes.length > 0 ? { supersedes } : {}),
    ...(supersededBy.length > 0 ? { supersededBy } : {}),
    createdAt: requireIsoString(table, "created_at", row.created_at),
    updatedAt: requireIsoString(table, "updated_at", row.updated_at)
  };
}

/** Validates and maps a memory_lifecycle_events row into a MemoryLifecycleEvent. */
export function hydrateLifecycleEventRow(
  row: Record<string, unknown>
): MemoryLifecycleEvent {
  const table = "memory_lifecycle_events";
  const fromStatus = optionalString(table, "from_status", row.from_status);
  return {
    id: requireString(table, "id", row.id),
    memoryId: requireString(table, "memory_id", row.memory_id),
    action: requireEnum<MemoryLifecycleAction>(
      table,
      "action",
      row.action,
      LIFECYCLE_ACTIONS
    ),
    actorId: requireString(table, "actor_id", row.actor_id),
    occurredAt: requireIsoString(table, "occurred_at", row.occurred_at),
    ...(fromStatus === undefined
      ? {}
      : {
          fromStatus: requireEnum<MemoryStatus>(
            table,
            "from_status",
            fromStatus,
            MEMORY_STATUSES
          )
        }),
    toStatus: requireEnum<MemoryStatus>(
      table,
      "to_status",
      row.to_status,
      MEMORY_STATUSES
    ),
    reasonCode: requireEnum<MemoryReasonCode>(
      table,
      "reason_code",
      row.reason_code,
      MEMORY_REASON_CODE_SET
    ),
    evidence: parseEvidenceList(table, "evidence", row.evidence ?? "[]"),
    relatedMemoryIds: parseIdArray(
      table,
      "related_memory_ids",
      row.related_memory_ids
    )
  };
}


/** Hydrate one `memory_injection_events` row. */
export function hydrateInjectionEventRow(
  row: Record<string, unknown>
): MemoryInjectionEvent {
  const table = "memory_injection_events";
  const agentRole = optionalString(table, "agent_role", row.agent_role);
  const packetTokenCount = row.packet_token_count;
  return {
    id: requireString(table, "id", row.id),
    workspaceId: requireString(table, "workspace_id", row.workspace_id),
    ...(row.repository_id === null || row.repository_id === undefined
      ? {}
      : { repositoryId: requireString(table, "repository_id", row.repository_id) }),
    scope: columnsToScope(table, row),
    taskId: requireString(table, "task_id", row.task_id),
    runId: requireString(table, "run_id", row.run_id),
    agentId: requireString(table, "agent_id", row.agent_id),
    ...(agentRole === undefined ? {} : { agentRole }),
    correlationToken: requireString(
      table,
      "correlation_token",
      row.correlation_token
    ),
    memoryMode: requireEnum<MemoryExecutionMode>(
      table,
      "memory_mode",
      row.memory_mode,
      MEMORY_EXECUTION_MODE_SET
    ),
    injectionResult: requireEnum<MemoryInjectionResult>(
      table,
      "injection_result",
      row.injection_result,
      MEMORY_INJECTION_RESULT_SET
    ),
    packetCharacterCount: requireNonNegativeInteger(
      table,
      "packet_character_count",
      row.packet_character_count
    ),
    ...(packetTokenCount === null || packetTokenCount === undefined
      ? {}
      : {
          packetTokenCount: requireNonNegativeInteger(
            table,
            "packet_token_count",
            packetTokenCount
          )
        }),
    memoryIds: parseIdArray(table, "memory_ids", row.memory_ids),
    occurredAt: requireIsoString(table, "occurred_at", row.occurred_at),
    reasonCode: requireEnum<MemoryInjectionEventReasonCode>(
      table,
      "reason_code",
      row.reason_code,
      MEMORY_INJECTION_EVENT_REASON_SET
    ),
    evidence: parseEvidenceList(table, "evidence", row.evidence ?? "[]"),
    recordedBy: requireString(table, "recorded_by", row.recorded_by)
  };
}

function requireNonNegativeInteger(
  table: string,
  column: string,
  value: unknown
): number {
  if (typeof value === "string") {
    if (!INTEGER_STRING_PATTERN.test(value)) {
      fail(table, column, `expected an integer, got ${JSON.stringify(value)}`);
    }
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(table, column, `expected a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Hydrate one `memory_outcome_reports` row. */
export function hydrateOutcomeReportRow(
  row: Record<string, unknown>
): MemoryOutcomeReport {
  const table = "memory_outcome_reports";
  const repositoryId = optionalString(table, "repository_id", row.repository_id);
  const agentRole = optionalString(table, "agent_role", row.agent_role);
  return {
    id: requireString(table, "id", row.id),
    workspaceId: requireString(table, "workspace_id", row.workspace_id),
    ...(repositoryId === undefined
      ? {}
      : { repositoryId }),
    scope: columnsToScope(table, row),
    taskId: requireString(table, "task_id", row.task_id),
    runId: requireString(table, "run_id", row.run_id),
    agentId: requireString(table, "agent_id", row.agent_id),
    ...(agentRole === undefined ? {} : { agentRole }),
    correlationToken: requireString(
      table,
      "correlation_token",
      row.correlation_token
    ),
    outcomeKind: requireEnum<ExperienceOutcome>(
      table,
      "outcome_kind",
      row.outcome_kind,
      EXPERIENCE_OUTCOMES
    ),
    reportKind: requireEnum<MemoryOutcomeReportKind>(
      table,
      "report_kind",
      row.report_kind,
      MEMORY_OUTCOME_REPORT_KIND_SET
    ),
    reportedAt: requireIsoString(table, "reported_at", row.reported_at),
    reporterId: requireString(table, "reporter_id", row.reporter_id),
    reporterAuthority: requireEnum<MemoryAuthority>(
      table,
      "reporter_authority",
      row.reporter_authority,
      MEMORY_AUTHORITY_SET
    ),
    reasonCode: requireEnum<MemoryOutcomeReportReasonCode>(
      table,
      "reason_code",
      row.reason_code,
      MEMORY_OUTCOME_REPORT_REASON_SET
    ),
    evidence: parseEvidenceList(table, "evidence", row.evidence ?? "[]")
  };
}

/** Hydrate one `memory_session_outcome_reports` row. */
export function hydrateSessionOutcomeReportRow(
  row: Record<string, unknown>
): MemorySessionOutcomeReport {
  const table = "memory_session_outcome_reports";
  return {
    id: requireString(table, "id", row.id),
    workspaceId: requireString(table, "workspace_id", row.workspace_id),
    repositoryId: requireString(table, "repository_id", row.repository_id),
    taskId: requireString(table, "task_id", row.task_id),
    outcomeKind: requireEnum<ExperienceOutcome>(
      table,
      "outcome_kind",
      row.outcome_kind,
      EXPERIENCE_OUTCOMES
    ),
    reportKind: requireEnum<MemoryOutcomeReportKind>(
      table,
      "report_kind",
      row.report_kind,
      MEMORY_OUTCOME_REPORT_KIND_SET
    ),
    reportedAt: requireIsoString(table, "reported_at", row.reported_at),
    reporterId: requireString(table, "reporter_id", row.reporter_id),
    reporterAuthority: requireEnum<MemoryAuthority>(
      table,
      "reporter_authority",
      row.reporter_authority,
      MEMORY_AUTHORITY_SET
    ),
    reasonCode: requireEnum<MemoryOutcomeReportReasonCode>(
      table,
      "reason_code",
      row.reason_code,
      MEMORY_OUTCOME_REPORT_REASON_SET
    ),
    evidence: parseEvidenceList(table, "evidence", row.evidence ?? "[]")
  };
}
