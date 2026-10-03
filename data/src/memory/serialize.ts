import type {
  ExperienceEnvelope,
  MemoryInjectionEvent,
  MemoryLifecycleEvent,
  MemoryOutcomeReport,
  MemoryRecord,
  MemorySessionOutcomeReport
} from "@simulatorlife/autodev-core";

import { scopeToColumns } from "./scope-sql.ts";

/** Row values for inserting one memory_experiences record. */
export function experienceToRow(
  experience: ExperienceEnvelope
): Record<string, unknown> {
  const scope = scopeToColumns(experience.scope);
  return {
    id: experience.id,
    workspace_id: experience.workspaceId,
    repository_id: experience.repositoryId ?? null,
    ...scope,
    task_id: experience.taskId,
    run_id: experience.runId,
    task_kind: experience.taskKind ?? null,
    task_reference: experience.taskReference
      ? JSON.stringify(experience.taskReference)
      : null,
    plan_reference: experience.planReference
      ? JSON.stringify(experience.planReference)
      : null,
    agent_id: experience.agentId,
    agent_role: experience.agentRole ?? null,
    provider: experience.provider ?? null,
    model: experience.model ?? null,
    branch: experience.branch ?? null,
    base_commit: experience.baseCommit ?? null,
    head_commit: experience.headCommit ?? null,
    started_at: experience.startedAt,
    completed_at: experience.completedAt ?? null,
    outcome: experience.outcome,
    memory_mode: experience.memoryMode ?? null,
    validation_state: experience.validation?.state ?? null,
    validation_evidence: JSON.stringify(experience.validation?.evidence ?? []),
    trajectory_format: experience.trajectory.format,
    trajectory_uri: experience.trajectory.uri,
    trajectory_digest: experience.trajectory.digest ?? null,
    trajectory_record_count: experience.trajectory.recordCount ?? null,
    evidence: JSON.stringify(experience.evidence)
  };
}

/** Row values for inserting/updating one memory_records snapshot. */
export function memoryRecordToRow(
  record: MemoryRecord
): Record<string, unknown> {
  const scope = scopeToColumns(record.scope);
  return {
    id: record.id,
    kind: record.kind,
    ...scope,
    claim: record.claim,
    status: record.status,
    provenance: JSON.stringify(record.provenance),
    validity_state: record.validity.state,
    validity_valid_from: record.validity.validFrom ?? null,
    validity_valid_to: record.validity.validTo ?? null,
    validity_detail: JSON.stringify({
      checkedAt: record.validity.checkedAt,
      verificationSource: record.validity.verificationSource,
      evidence: record.validity.evidence
    }),
    supersedes: JSON.stringify(record.supersedes ?? []),
    superseded_by: JSON.stringify(record.supersededBy ?? []),
    created_at: record.createdAt,
    updated_at: record.updatedAt
  };
}

/** Row values for inserting one memory_lifecycle_events record. */
export function lifecycleEventToRow(
  event: MemoryLifecycleEvent
): Record<string, unknown> {
  return {
    id: event.id,
    memory_id: event.memoryId,
    action: event.action,
    actor_id: event.actorId,
    occurred_at: event.occurredAt,
    from_status: event.fromStatus ?? null,
    to_status: event.toStatus,
    reason_code: event.reasonCode,
    evidence: JSON.stringify(event.evidence),
    related_memory_ids: JSON.stringify(event.relatedMemoryIds)
  };
}


/** Row values for inserting one `memory_injection_events` row. */
export function injectionEventToRow(
  event: MemoryInjectionEvent
): Record<string, unknown> {
  const scope = scopeToColumns(event.scope);
  return {
    id: event.id,
    workspace_id: event.workspaceId,
    repository_id: event.repositoryId ?? null,
    ...scope,
    task_id: event.taskId,
    run_id: event.runId,
    agent_id: event.agentId,
    agent_role: event.agentRole ?? null,
    correlation_token: event.correlationToken,
    memory_mode: event.memoryMode,
    injection_result: event.injectionResult,
    packet_character_count: event.packetCharacterCount,
    packet_token_count: event.packetTokenCount ?? null,
    memory_ids: JSON.stringify(event.memoryIds),
    occurred_at: event.occurredAt,
    reason_code: event.reasonCode,
    evidence: JSON.stringify(event.evidence),
    recorded_by: event.recordedBy
  };
}

/** Row values for inserting one `memory_outcome_reports` row. */
export function outcomeReportToRow(
  report: MemoryOutcomeReport
): Record<string, unknown> {
  const scope = scopeToColumns(report.scope);
  return {
    id: report.id,
    workspace_id: report.workspaceId,
    repository_id: report.repositoryId ?? null,
    ...scope,
    task_id: report.taskId,
    run_id: report.runId,
    agent_id: report.agentId,
    correlation_token: report.correlationToken,
    outcome_kind: report.outcomeKind,
    report_kind: report.reportKind,
    reported_at: report.reportedAt,
    reporter_id: report.reporterId,
    reporter_authority: report.reporterAuthority,
    reason_code: report.reasonCode,
    evidence: JSON.stringify(report.evidence)
  };
}

/** Row values for inserting one `memory_session_outcome_reports` row. */
export function sessionOutcomeReportToRow(
  report: MemorySessionOutcomeReport
): Record<string, unknown> {
  return {
    id: report.id,
    workspace_id: report.workspaceId,
    repository_id: report.repositoryId,
    task_id: report.taskId,
    outcome_kind: report.outcomeKind,
    report_kind: report.reportKind,
    reported_at: report.reportedAt,
    reporter_id: report.reporterId,
    reporter_authority: report.reporterAuthority,
    reason_code: report.reasonCode,
    evidence: JSON.stringify(report.evidence)
  };
}

/** Builds a parameterized INSERT statement from an ordered column map. */
export function buildInsert(
  table: string,
  row: Record<string, unknown>,
  casts: Readonly<Record<string, string>> = {}
): { text: string; params: unknown[] } {
  const columns = Object.keys(row);
  const placeholders = columns.map((column, index) => {
    const cast = casts[column];
    return cast ? `$${index + 1}::${cast}` : `$${index + 1}`;
  });
  const text = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;
  return { text, params: columns.map((column) => row[column]) };
}
