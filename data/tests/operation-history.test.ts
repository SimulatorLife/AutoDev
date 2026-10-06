import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  auditEnvelopeToHistoryEntry,
  auditEnvelopesToHistory,
  boundReconciliationError,
  isControlApiAuditEnvelope,
  reconcileDiffSummary,
  reconcileDiffWithIdentifier
} from "@simulatorlife/autodev-data";

function envelope(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema: "autodev-control-api-audit-v1",
    timestamp: "2026-01-01T00:00:00.000Z",
    routerInstanceId: "router-1",
    actor: "operator-a",
    actorVerified: true,
    actorRole: "operator",
    action: "patch_provider_role",
    resource: "/control/providers/claude/roles/orchestrator",
    outcome: "ok",
    changes: { enabled: false, previous: true },
    desiredGeneration: "orchestrator:enabled=false",
    observedGeneration: "orchestrator:enabled=false",
    restartRequired: false,
    ...overrides
  };
}

function asEnvelope(value: Record<string, unknown>) {
  if (!isControlApiAuditEnvelope(value)) {
    throw new Error("Expected canonical audit envelope");
  }
  return value;
}

describe("isControlApiAuditEnvelope", () => {
  test("accepts the canonical redacted envelope", () => {
    assert.equal(isControlApiAuditEnvelope(envelope()), true);
  });

  test("rejects entries with mismatched schema", () => {
    assert.equal(isControlApiAuditEnvelope({ ...envelope(), schema: "other" }), false);
  });

  test("rejects entries that carry raw prompt text in changes", () => {
    assert.equal(
      isControlApiAuditEnvelope({
        ...envelope(),
        changes: { promptBody: "# raw markdown body" }
      }),
      false
    );
  });
});

describe("auditEnvelopeToHistoryEntry", () => {
  test("redacts fields to their bounded Console length", () => {
    const longResource = "/control/" + "a".repeat(400);
    const entry = auditEnvelopeToHistoryEntry(
      asEnvelope({ ...envelope(), resource: longResource })
    );
    assert.ok(entry.resource.length <= 200);
    assert.equal(entry.action, "patch_provider_role");
    assert.equal(entry.actor, "operator-a");
    assert.equal(entry.outcome, "ok");
  });

  test("preserves the bounded redacted reason code", () => {
    const entry = auditEnvelopeToHistoryEntry(
      asEnvelope({ ...envelope(), outcome: "error", reason: "revision_conflict" })
    );
    assert.equal(entry.outcome, "error");
    assert.equal(entry.reason, "revision_conflict");
  });
});

describe("auditEnvelopesToHistory", () => {
  test("filters out non-audit envelopes and bounds the result", () => {
    const valid = Array.from({ length: 12 }, () => envelope());
    const invalid = { schema: "garbage" };
    const result = auditEnvelopesToHistory([...valid, invalid]);
    assert.equal(result.length, 10);
    for (const entry of result) {
      assert.equal(entry.action, "patch_provider_role");
    }
  });
});

describe("reconcileDiff helpers", () => {
  test("summary bounds the diff summary string", () => {
    const long = "x".repeat(400);
    const diff = reconcileDiffSummary({ summary: long });
    assert.ok(diff.summary.length <= 160);
    assert.equal(diff.identifier, "");
  });

  test("identifier helper bounds the identifier too", () => {
    const diff = reconcileDiffWithIdentifier({
      summary: "ok",
      identifier: "z".repeat(128)
    });
    assert.ok(diff.identifier.length <= 64);
  });
});

describe("boundReconciliationError", () => {
  test("truncates overlong messages", () => {
    assert.equal(
      boundReconciliationError("x".repeat(400))!.length <= 160,
      true
    );
    assert.equal(boundReconciliationError(null), null);
  });
});
