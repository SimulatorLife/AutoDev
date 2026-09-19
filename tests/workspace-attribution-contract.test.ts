import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getRouterStatus, ingestAgentEvents, resetRouterTelemetry } from "../src/router/http.ts";
import { recordRouterEvent } from "../src/router/events.ts";
import { autodevEnrichOtlpPayload, ingestOtelSignal, resetOtelTelemetry } from "../src/router/otel.ts";
import { noteBridgeRequest, resetSubagentTelemetry } from "../src/router/subagents.ts";
import { attributionDiagnosticsStatus, registerWorkspaceId, resetAttributionDiagnostics, safePrivacyWorkspace } from "../src/router/usage.ts";

type JsonObject = Record<string, unknown>;
type Operation = JsonObject & { op: string };
type Scenario = { operations: Operation[] };
type Contract = { schema: string; scenarios: Record<string, Scenario> };
type Attribute = { key: string; value?: { stringValue?: string } };
type ResourceLog = {
  resource?: { attributes?: Attribute[] };
  scopeLogs?: Array<{ logRecords?: Array<{ attributes?: Attribute[] }> }>;
};
type OperationState = { enriched?: { resourceLogs?: ResourceLog[] } | undefined };

const contract = await import("./fixtures/contracts/workspace-attribution-contract.json", { with: { type: "json" } }).then((m) => (m.default ?? m) as Contract);
assert.equal(contract.schema, "autodev-workspace-attribution-v1");

const attrs = (entries: ReadonlyArray<readonly [string, unknown]>) => entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
const point = (entries: ReadonlyArray<readonly [string, unknown]>, value: unknown) => ({ attributes: attrs(entries), startTimeUnixNano: "1", timeUnixNano: "2", asInt: String(value) });
const stringValue = (op: Operation, key: string): string => String(op[key]);
const numberValue = (op: Operation, key: string): number => Number(op[key]);

function resetAll() {
  resetOtelTelemetry();
  resetRouterTelemetry();
  resetSubagentTelemetry();
  resetAttributionDiagnostics();
}

function workspace(key: string): unknown {
  const status = getRouterStatus() as JsonObject;
  const usage = status.usage as JsonObject;
  const byWorkspace = usage.byWorkspace as JsonObject;
  return byWorkspace[key];
}

function pathValue(object: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? (value as JsonObject)[part] : undefined, object);
}

function runOperation(name: string, op: Operation, state: OperationState): void {
  if (op.op === "record") {
    recordRouterEvent({ phase: stringValue(op, "phase"), requestId: stringValue(op, "requestId"), provider: "claude", model: "sonnet", workspace: { key: stringValue(op, "workspace") }, outcome: "success", elapsedMs: 1 });
    return;
  }
  if (op.op === "bridgeRequest") {
    noteBridgeRequest(stringValue(op, "requestId"), { activitySubject: `req:${stringValue(op, "requestId")}`, provider: stringValue(op, "provider"), model: stringValue(op, "model"), role: stringValue(op, "role"), workspace: stringValue(op, "workspace") });
    return;
  }
  if (op.op === "bridgeEvents") {
    ingestAgentEvents({ requestId: stringValue(op, "requestId"), events: op.events });
    return;
  }
  if (op.op === "register") {
    registerWorkspaceId(op.id, op.workspace);
    return;
  }
  if (op.op === "metric") {
    ingestOtelSignal("metrics", {
      resourceMetrics: [{
        resource: { attributes: attrs([["workspace_id", stringValue(op, "workspaceId")]]) },
        scopeMetrics: [{
          metrics: [{
            name: "codex.tool_result",
            sum: { aggregationTemporality: 1, dataPoints: [point([["tool", stringValue(op, "tool")], ["status", "ok"]], numberValue(op, "value"))] },
          }],
        }],
      }],
    });
    return;
  }
  if (op.op === "privacyHelper") {
    assert.equal(safePrivacyWorkspace(op.path), op.expected, `${name}: privacy normalization`);
    assert.equal(safePrivacyWorkspace(op.path).includes("/Users/"), false);
    return;
  }
  if (op.op === "ambiguousMetric") {
    ingestOtelSignal("metrics", {
      resourceMetrics: [{
        resource: { attributes: attrs([["workspace_id", stringValue(op, "first")], ["workspace.id", stringValue(op, "second")]]) },
        scopeMetrics: [{
          metrics: [{
            name: "codex.tool_result",
            sum: { aggregationTemporality: 1, dataPoints: [point([["tool", stringValue(op, "tool")]], numberValue(op, "value"))] },
          }],
        }],
      }],
    });
    return;
  }
  if (op.op === "trace") {
    const spans = op.spans as Array<{ name: string; server: string }>;
    ingestOtelSignal("traces", { resourceSpans: [ { scopeSpans: [ { spans: spans.map((span) => ({ name: span.name, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: attrs([["server_name", span.server], ["workspace", stringValue(op, "workspace")]]) })) } ] } ] });
    return;
  }
  if (op.op === "enrich") {
    const payload = op.payload as { logs: unknown };
    state.enriched = autodevEnrichOtlpPayload("logs", payload.logs) as OperationState["enriched"];
    return;
  }
  if (op.op === "assert") {
    assert.deepEqual(pathValue(workspace(stringValue(op, "workspace")), stringValue(op, "field")), op.expected, `${name}: ${stringValue(op, "workspace")}.${stringValue(op, "field")}`);
    return;
  }
  if (op.op === "diagnostics") {
    assert.deepEqual(pathValue(attributionDiagnosticsStatus(), stringValue(op, "field")), op.expected, `${name}: diagnostics.${stringValue(op, "field")}`);
    return;
  }
  if (op.op === "assertAbsentWorkspace") {
    assert.equal(workspace(stringValue(op, "workspace")), undefined, `${name}: workspace ${stringValue(op, "workspace")} must not be guessed`);
    return;
  }
  if (op.op === "assertEnrichedNoPrompt") {
    const emitted: Attribute[] = [];
    for (const resourceLog of state.enriched?.resourceLogs ?? []) {
      emitted.push(...(resourceLog.resource?.attributes ?? []));
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) emitted.push(...(record.attributes ?? []));
      }
    }
    assert.equal(emitted.filter((entry) => entry.key.startsWith("autodev.")).some((entry) => JSON.stringify(entry).includes("secret")), false, `${name}: prompt content must not enter autodev attributes`);
    const workspaceAttribute = emitted.find((entry) => entry.key === "autodev.workspace");
    assert.equal(workspaceAttribute?.value?.stringValue, stringValue(op, "expectedWorkspace"));
    return;
  }
  throw new Error(`${name}: unknown operation ${op.op}`);
}

describe("workspace attribution contract", () => {
  for (const [name, scenario] of Object.entries(contract.scenarios)) {
    test(name, () => {
      resetAll();
      const state: OperationState = {};
      try {
        for (const op of scenario.operations) runOperation(name, op, state);
      } finally {
        resetAll();
      }
    });
  }
});
