import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resetCorrelation } from "@simulatorlife/autodev-runtime/router/correlation";
import { recordRouterEvent } from "@simulatorlife/autodev-runtime/router/events";
import {
  getRouterStatus,
  ingestAgentEvents,
  resetRouterTelemetry
} from "@simulatorlife/autodev-runtime/router/http";
import {
  noteBridgeRequest,
  resetSubagentTelemetry
} from "@simulatorlife/autodev-runtime/router/subagents";
import {
  getDefaultUsageTracker,
  safePrivacyWorkspace
} from "@simulatorlife/autodev-runtime/router/usage";

type JsonObject = Record<string, unknown>;
type Operation = JsonObject & { op: string };
type Scenario = { operations: Operation[] };
type Contract = { schema: string; scenarios: Record<string, Scenario> };

const contract = await import(
  "./fixtures/contracts/workspace-attribution-contract.json",
  { with: { type: "json" } }
).then((m) => (m.default ?? m) as Contract);
assert.equal(contract.schema, "autodev-workspace-attribution-v2");

const stringValue = (op: Operation, key: string): string => String(op[key]);

function resetAll() {
  resetCorrelation();
  resetRouterTelemetry();
  resetSubagentTelemetry();
  getDefaultUsageTracker().resetAttributionDiagnostics();
}

function workspace(key: string): unknown {
  const status = getRouterStatus() as JsonObject;
  const usage = status.usage as JsonObject;
  const byWorkspace = usage.byWorkspace as JsonObject;
  return byWorkspace[key];
}

function pathValue(object: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === "object"
          ? (value as JsonObject)[part]
          : undefined,
      object
    );
}

function runAssertOperation(name: string, op: Operation): boolean {
  if (op.op === "privacyHelper") {
    assert.equal(
      safePrivacyWorkspace(op.path),
      op.expected,
      `${name}: privacy normalization`
    );
    assert.equal(safePrivacyWorkspace(op.path).includes("/Users/"), false);
    return true;
  }
  if (op.op === "assert") {
    assert.deepEqual(
      pathValue(
        workspace(stringValue(op, "workspace")),
        stringValue(op, "field")
      ),
      op.expected,
      `${name}: ${stringValue(op, "workspace")}.${stringValue(op, "field")}`
    );
    return true;
  }
  if (op.op === "assertFieldAbsent") {
    assert.equal(
      pathValue(
        workspace(stringValue(op, "workspace")),
        stringValue(op, "field")
      ),
      undefined,
      `${name}: ${stringValue(op, "workspace")}.${stringValue(op, "field")} must not be published`
    );
    return true;
  }
  return false;
}

function runOperation(name: string, op: Operation): void {
  if (runAssertOperation(name, op)) return;
  if (op.op === "record") {
    recordRouterEvent({
      phase: stringValue(op, "phase"),
      requestId: stringValue(op, "requestId"),
      provider: "claude",
      model: "sonnet",
      workspace: { key: stringValue(op, "workspace") },
      outcome: "success",
      elapsedMs: 1
    });
    return;
  }
  if (op.op === "bridgeRequest") {
    noteBridgeRequest(stringValue(op, "requestId"), {
      activitySubject: `req:${stringValue(op, "requestId")}`,
      provider: stringValue(op, "provider"),
      model: stringValue(op, "model"),
      role: stringValue(op, "role"),
      workspace: stringValue(op, "workspace")
    });
    return;
  }
  if (op.op === "bridgeEvents") {
    ingestAgentEvents({
      requestId: stringValue(op, "requestId"),
      events: op.events
    });
    return;
  }
  throw new Error(`${name}: unknown operation ${op.op}`);
}

describe("workspace attribution contract", () => {
  for (const [name, scenario] of Object.entries(contract.scenarios)) {
    test(name, () => {
      resetAll();
      try {
        for (const op of scenario.operations) runOperation(name, op);
      } finally {
        resetAll();
      }
    });
  }
});
