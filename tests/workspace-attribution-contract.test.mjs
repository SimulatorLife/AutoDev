import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  autodevEnrichOtlpPayload,
  attributionDiagnosticsStatus,
  getRouterStatus,
  ingestAgentEvents,
  ingestOtelSignal,
  noteBridgeRequest,
  recordRouterEvent,
  registerWorkspaceId,
  resetAttributionDiagnostics,
  resetOtelTelemetry,
  resetRouterTelemetry,
  resetSubagentTelemetry,
  safePrivacyWorkspace,
} from "../scripts/codex-model-router.mjs";

const contract = await import("./fixtures/contracts/workspace-attribution-contract.json", { with: { type: "json" } }).then((m) => m.default ?? m);
assert.equal(contract.schema, "autodev-workspace-attribution-v1");

const attrs = (entries) => entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
const point = (entries, value) => ({ attributes: attrs(entries), startTimeUnixNano: "1", timeUnixNano: "2", asInt: String(value) });

function resetAll() {
  resetOtelTelemetry();
  resetRouterTelemetry();
  resetSubagentTelemetry();
  resetAttributionDiagnostics();
}

function workspace(key) {
  return getRouterStatus().usage.byWorkspace[key];
}

function pathValue(object, path) {
  return path.split(".").reduce((value, part) => value?.[part], object);
}

function runOperation(name, op, state) {
  if (op.op === "record") {
    recordRouterEvent({ phase: op.phase, requestId: op.requestId, provider: "claude", model: "sonnet", workspace: { key: op.workspace }, outcome: "success", elapsedMs: 1 });
    return;
  }
  if (op.op === "bridgeRequest") {
    noteBridgeRequest(op.requestId, { provider: op.provider, model: op.model, role: op.role, workspace: op.workspace });
    return;
  }
  if (op.op === "bridgeEvents") {
    ingestAgentEvents({ requestId: op.requestId, events: op.events });
    return;
  }
  if (op.op === "register") {
    registerWorkspaceId(op.id, op.workspace);
    return;
  }
  if (op.op === "metric") {
    ingestOtelSignal("metrics", { resourceMetrics: [ { resource: { attributes: attrs([["workspace_id", op.workspaceId]]) }, scopeMetrics: [ { metrics: [ { name: "codex.tool_result", sum: { aggregationTemporality: 1, dataPoints: [ point([["tool", op.tool], ["status", "ok"]], op.value) ] } } ] } ] } ] });
    return;
  }
  if (op.op === "privacyHelper") {
    assert.equal(safePrivacyWorkspace(op.path), op.expected, `${name}: privacy normalization`);
    assert.equal(safePrivacyWorkspace(op.path).includes("/Users/"), false);
    return;
  }
  if (op.op === "ambiguousMetric") {
    ingestOtelSignal("metrics", { resourceMetrics: [ { resource: { attributes: attrs([["workspace_id", op.first], ["workspace.id", op.second]]) }, scopeMetrics: [ { metrics: [ { name: "codex.tool_result", sum: { aggregationTemporality: 1, dataPoints: [ point([["tool", op.tool]], op.value) ] } } ] } ] } ] });
    return;
  }
  if (op.op === "trace") {
    ingestOtelSignal("traces", { resourceSpans: [ { scopeSpans: [ { spans: op.spans.map((span) => ({ name: span.name, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: attrs([["server_name", span.server], ["workspace", op.workspace]]) })) } ] } ] });
    return;
  }
  if (op.op === "enrich") {
    state.enriched = autodevEnrichOtlpPayload("logs", op.payload.logs);
    return;
  }
  if (op.op === "assert") {
    assert.deepEqual(pathValue(workspace(op.workspace), op.field), op.expected, `${name}: ${op.workspace}.${op.field}`);
    return;
  }
  if (op.op === "diagnostics") {
    assert.deepEqual(pathValue(attributionDiagnosticsStatus(), op.field), op.expected, `${name}: diagnostics.${op.field}`);
    return;
  }
  if (op.op === "assertAbsentWorkspace") {
    assert.equal(workspace(op.workspace), undefined, `${name}: workspace ${op.workspace} must not be guessed`);
    return;
  }
  if (op.op === "assertEnrichedNoPrompt") {
    const emitted = [];
    for (const resourceLog of state.enriched.resourceLogs ?? []) {
      emitted.push(...(resourceLog.resource?.attributes ?? []));
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) emitted.push(...(record.attributes ?? []));
      }
    }
    assert.equal(emitted.filter((entry) => entry.key.startsWith("autodev.")).some((entry) => JSON.stringify(entry).includes("secret")), false, `${name}: prompt content must not enter autodev attributes`);
    const workspaceAttribute = emitted.find((entry) => entry.key === "autodev.workspace");
    assert.equal(workspaceAttribute?.value?.stringValue, op.expectedWorkspace);
    return;
  }
  throw new Error(`${name}: unknown operation ${op.op}`);
}

describe("workspace attribution contract", () => {
  for (const [name, scenario] of Object.entries(contract.scenarios)) {
    test(name, () => {
      resetAll();
      const state = {};
      try {
        for (const op of scenario.operations) runOperation(name, op, state);
      } finally {
        resetAll();
      }
    });
  }
});
