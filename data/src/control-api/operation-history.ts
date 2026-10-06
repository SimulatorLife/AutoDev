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

import type {
  OperationHistoryEntry,
  ReconciliationDiff
} from "@simulatorlife/autodev-core";

const AUDIT_SCHEMA = "autodev-control-api-audit-v1";
const RESOURCE_MAX_LEN = 200;
const REASON_MAX_LEN = 80;
const SUMMARY_MAX_LEN = 160;
const ERROR_MAX_LEN = 160;

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

/**
 * Single audit envelope emitted by `auditMutation`. Only the bounded fields
 * used for Console history need to round-trip; everything else stays in stderr.
 *
 * The shape mirrors exactly what `auditMutation` writes: `reason` is omitted
 * entirely when there is none, and the reconciliation generations plus
 * `restartRequired` sit at the top level rather than nested under `changes`.
 * `changes` stays the opaque redacted diff summary the audit owner produced.
 */
export interface ControlApiAuditEnvelope {
  readonly schema: typeof AUDIT_SCHEMA;
  readonly timestamp: string;
  readonly action: string;
  readonly resource: string;
  readonly actor: string | null;
  readonly outcome: "ok" | "denied" | "error";
  readonly reason?: string;
  readonly desiredGeneration: string | null;
  readonly observedGeneration: string | null;
  readonly restartRequired: boolean;
}

/** Type guard for the redacted audit envelope. */
export function isControlApiAuditEnvelope(
  value: unknown
): value is ControlApiAuditEnvelope {
  if (!isRecord(value)) return false;
  if (value.schema !== AUDIT_SCHEMA) return false;
  if (typeof value.timestamp !== "string") return false;
  if (typeof value.action !== "string") return false;
  if (typeof value.resource !== "string") return false;
  if (typeof value.actor !== "string" && value.actor !== null) return false;
  if (readOutcome(value.outcome) === null) return false;
  // `auditMutation` only adds `reason` when one exists, so an absent key is
  // the normal success case rather than a malformed envelope.
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return false;
  }
  if (
    value.desiredGeneration !== null &&
    typeof value.desiredGeneration !== "string"
  ) {
    return false;
  }
  if (
    value.observedGeneration !== null &&
    typeof value.observedGeneration !== "string"
  ) {
    return false;
  }
  if (typeof value.restartRequired !== "boolean") return false;
  return !carriesRawContent(value.changes);
}

/**
 * Keys whose presence in `changes` means the envelope is carrying document or
 * prompt content rather than a redacted field summary. The audit owner is
 * expected to never emit these; refusing the whole envelope is a deliberate
 * fail-closed response so raw bodies can never reach the Console history.
 */
const RAW_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "body",
  "content",
  "markdown",
  "prompt",
  "promptBody",
  "promptText",
  "raw",
  "text"
]);

function carriesRawContent(changes: unknown): boolean {
  if (!isRecord(changes)) return false;
  return Object.keys(changes).some((key) => RAW_CONTENT_KEYS.has(key));
}

/**
 * Project one audit envelope into the reusable `OperationHistoryEntry`
 * shape. The function is pure and never returns raw prompt text, tokens,
 * or bodies; the reconciliation generations are the only change detail that
 * crosses this boundary, and each is bounded.
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
      desiredGeneration: bound(envelope.desiredGeneration, 64),
      observedGeneration: bound(envelope.observedGeneration, 64),
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
  return entries.slice(0, 10);
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
