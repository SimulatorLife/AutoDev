/**
 * Typed adapter that converts the existing Control API audit envelope into
 * the reusable `OperationHistoryEntry` shape.
 *
 * The audit owner is `auditMutation` in `runtime/src/control-api/index.ts`,
 * which already keeps its redacted audit records consistent with the
 * privacy requirements of section 5 of the target state doc. This module
 * deliberately does NOT create a parallel audit store: it reads the same
 * redacted audit envelope shape and projects only the bounded fields the
 * Console renders on its operation history panel.
 *
 * No raw prompt text, tokens, or mutation bodies ever appear in the result;
 * the audit envelope already strips those, and this adapter asserts the
 * shape before forwarding.
 */

import {
  OPERATION_HISTORY_LIMIT,
  type OperationHistoryEntry,
  type ReconciliationDiff
} from "@simulatorlife/autodev-core";

const AUDIT_SCHEMA = "autodev-control-api-audit-v1";
const RESOURCE_MAX_LEN = 200;
const REASON_MAX_LEN = 80;
const SUMMARY_MAX_LEN = 160;
const ERROR_MAX_LEN = 160;
const GENERATION_MAX_LEN = 64;
/** Nesting allowed inside `changes` (e.g. a Memory purge result record). */
const CHANGES_MAX_DEPTH = 2;
/** A redacted change value: one bounded token, never free text or a body. */
const REDACTED_TOKEN = /^\S{0,200}$/u;

function bound(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOutcome(value: unknown): "ok" | "denied" | "error" | null {
  return value === "ok" || value === "denied" || value === "error"
    ? value
    : null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * `auditMutation` records only bounded metadata in `changes`: identifiers,
 * revisions, flags, counts, and small nested records of the same. Any
 * multi-word or oversized string (a prompt body, a free-text note) marks
 * an envelope that did not come through that redaction.
 */
function isRedactedChangeValue(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return REDACTED_TOKEN.test(value);
  if (depth >= CHANGES_MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.every((item) => isRedactedChangeValue(item, depth + 1));
  }
  return (
    isRecord(value) &&
    Object.values(value).every((item) => isRedactedChangeValue(item, depth + 1))
  );
}

/**
 * Single audit envelope as `auditMutation` records it. Only the bounded
 * fields used for Console history need to round-trip; everything else
 * stays in stderr.
 */
export interface ControlApiAuditEnvelope {
  readonly schema: typeof AUDIT_SCHEMA;
  readonly timestamp: string;
  readonly action: string;
  readonly resource: string;
  readonly actor: string | null;
  readonly outcome: "ok" | "denied" | "error";
  /** Redacted reason code; omitted for successful operations. */
  readonly reason?: string;
  readonly changes: Readonly<Record<string, unknown>> | null;
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly restartRequired: boolean;
}

/** Type guard for the redacted audit envelope. */
export function isControlApiAuditEnvelope(
  value: unknown
): value is ControlApiAuditEnvelope {
  return (
    isRecord(value) &&
    value.schema === AUDIT_SCHEMA &&
    typeof value.timestamp === "string" &&
    typeof value.action === "string" &&
    typeof value.resource === "string" &&
    isNullableString(value.actor) &&
    readOutcome(value.outcome) !== null &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.changes === null ||
      (isRecord(value.changes) && isRedactedChangeValue(value.changes, 0))) &&
    isNullableString(value.desiredGeneration) &&
    isNullableString(value.observedGeneration) &&
    typeof value.restartRequired === "boolean"
  );
}

/**
 * Project one audit envelope into the reusable `OperationHistoryEntry`
 * shape. The function is pure and never returns raw prompt text, tokens,
 * or bodies: `changes` itself is not forwarded, only the bounded
 * generations and restart flag the envelope records beside it.
 */
export function auditEnvelopeToHistoryEntry(
  envelope: ControlApiAuditEnvelope
): OperationHistoryEntry {
  return {
    action: envelope.action,
    resource: bound(envelope.resource, RESOURCE_MAX_LEN) ?? "",
    timestamp: envelope.timestamp,
    actor: envelope.actor,
    outcome: envelope.outcome,
    reason: bound(envelope.reason ?? null, REASON_MAX_LEN),
    changes: {
      desiredGeneration: bound(envelope.desiredGeneration, GENERATION_MAX_LEN),
      observedGeneration: bound(
        envelope.observedGeneration,
        GENERATION_MAX_LEN
      ),
      restartRequired: envelope.restartRequired
    }
  };
}

/**
 * Convert and bound a list of raw envelopes into the history shape the
 * Console expects. Newest entries come first; the result is trimmed to the
 * shared Console cap.
 */
export function auditEnvelopesToHistory(
  envelopes: readonly unknown[]
): readonly OperationHistoryEntry[] {
  const entries: OperationHistoryEntry[] = [];
  for (const value of envelopes) {
    if (!isControlApiAuditEnvelope(value)) continue;
    entries.push(auditEnvelopeToHistoryEntry(value));
  }
  return entries.slice(0, OPERATION_HISTORY_LIMIT);
}

/**
 * Normalize a free-form summary into a bounded diff summary string. The
 * Runtime forwards a short label like "Prompt command updated; projection
 * applied" so Console renders the same vocabulary the audit emits.
 */
export function reconcileDiffSummary(input: {
  readonly summary: string;
}): ReconciliationDiff {
  return {
    summary: bound(input.summary, SUMMARY_MAX_LEN) ?? "",
    identifier: ""
  };
}

/**
 * Same as above but with a stable identifier. Used by the patch responses
 * to attach the desired generation hash (e.g. revision) to the diff so the
 * Console can render "what changed and which generation it represents".
 */
export function reconcileDiffWithIdentifier(input: {
  readonly summary: string;
  readonly identifier: string;
}): ReconciliationDiff {
  return {
    summary: bound(input.summary, SUMMARY_MAX_LEN) ?? "",
    identifier: bound(input.identifier, 64) ?? ""
  };
}

/**
 * Bound the redacted last-error string before it travels into the
 * reconciliation status.
 */
export function boundReconciliationError(value: string | null): string | null {
  return bound(value, ERROR_MAX_LEN);
}
