import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AGENT_ACTIVITY_KINDS,
  AGENT_ACTIVITY_STATES,
} from "../src/agents/agent-activity.ts";

import {
  agentActivity,
  agentsStatus,
  concurrencyStatus,
  projectLiveAgents,
  recordConcurrencyDenial,
  releaseSubagentSlot,
  resetConcurrencyTelemetry,
  tryAcquireSubagentSlot,
} from "../scripts/codex-model-router.mjs";

// The router's slot kind and process-fallback tag are documented in
// scripts/codex-model-router.mjs (SUBAGENT_SLOT_KIND = "subagent_slot",
// PROCESS_FALLBACK_SESSION_KEY = "process-scope"). The router does not
// re-export these constants, so the contract test pins them locally to
// keep the test host-independent and to assert the contract rather than
// the router's module-export shape.
const SUBAGENT_SLOT_KIND = "subagent_slot";
const PROCESS_FALLBACK_SESSION_KEY = "process-scope";

const contract = await import("./fixtures/contracts/agent-reconciliation-contract.json", { with: { type: "json" } }).then((m) => m.default ?? m);

assert.equal(contract.schema, "autodev-agent-reconciliation-contract-v1", "agent reconciliation contract must match its schema tag");
assert.equal(contract.statusAgentsSchema, "autodev-agent-status-v1", "the projected status.agents schema tag is frozen");

const SCENARIOS = contract.scenarios;

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split(".")) cur = cur?.[part];
  return cur;
}

function evalOps(name, operations, ctx) {
  for (const op of operations) {
    switch (op.op) {
      case "status_field": {
        const value = getPath(ctx.status, op.field);
        assert.equal(value, op.expected, `${name}: ${op.field}`);
        break;
      }
      case "status_deep_equal": {
        const value = getPath(ctx.status, op.field);
        assert.deepEqual(value, op.expected, `${name}: ${op.field}`);
        break;
      }
      case "status_no_key": {
        assert.equal(Object.hasOwn(ctx.status, op.key), false, `${name}: ${op.key} must not appear on status.agents`);
        break;
      }
      case "status_shape": {
        const target = op.field ? ctx.status?.[op.field] : ctx.status;
        const keys = Object.keys(target ?? {}).sort();
        assert.deepEqual(keys, [...op.expected].sort(), `${name}: shape${op.field ? ` of ${op.field}` : ""}`);
        break;
      }
      default:
        throw new Error(`${name}: unknown op ${op.op}`);
    }
  }
}

function runScenario(name, scenario) {
  let slotSequence = 0;
  resetConcurrencyTelemetry();
  agentActivity.reset();
  try {
    for (const op of scenario.operations ?? []) {
      switch (op.op) {
        case "beginAgent": {
          agentActivity.beginRequest(op.subject, {
            requestId: op.requestId,
            kind: op.kind,
            provider: op.provider ?? null,
            model: op.model ?? null,
            role: op.role ?? null,
            origin: op.origin ?? null,
            workspace: op.workspace ?? null,
          });
          break;
        }
        case "applyLifecycle": {
          agentActivity.applyLifecycleEvent(op.subject, { state: op.state });
          break;
        }
        case "beginSlot": {
          slotSequence += 1;
          const subject = op.subject ?? `subagent_slot:${op.sessionKey}:${slotSequence}`;
          agentActivity.beginRequest(subject, {
            requestId: subject,
            kind: SUBAGENT_SLOT_KIND,
            tag: op.sessionKey,
          });
          break;
        }
        case "acquire": {
          const denial = tryAcquireSubagentSlot(op.sessionKey);
          if (denial !== null && denial !== "max_concurrent_threads_per_session") {
            throw new Error(`${name}: unexpected denial ${denial}`);
          }
          break;
        }
        case "release": {
          releaseSubagentSlot(op.sessionKey);
          break;
        }
        case "recordDenial": {
          recordConcurrencyDenial({
            requestId: op.requestId,
            role: op.role,
            requestedModel: op.requestedModel,
            sessionScope: op.sessionScope,
            reason: op.reason,
          });
          break;
        }
        case "status_field":
        case "status_deep_equal":
        case "status_no_key":
        case "status_shape": {
          const status = agentsStatus(Date.now());
          evalOps(name, [op], { status });
          break;
        }
        default:
          throw new Error(`${name}: unknown op ${op.op}`);
      }
    }
    // Final trailing status assert against the schema and slot shape.
    const status = agentsStatus(Date.now());
    evalOps(name, [{ op: "status_field", field: "schema", expected: "autodev-agent-status-v1" }], { status });
    evalOps(name, [{ op: "status_field", field: "reconciledWithConcurrency", expected: true }], { status });
  } finally {
    resetConcurrencyTelemetry();
    agentActivity.reset();
  }
}

describe("agent reconciliation contract: constants and module surface", () => {
  test("status.agents schema tag is frozen", () => {
    assert.equal(contract.statusAgentsSchema, "autodev-agent-status-v1");
  });

  test("agentsStatus(at) exposes the frozen contract projection", () => {
    assert.equal(typeof agentsStatus, "function");
    const at = Date.now();
    const status = agentsStatus(at);
    assert.equal(status.schema, "autodev-agent-status-v1");
    assert.equal(typeof status.canonicalLiveCount, "number");
    assert.equal(typeof status.missingProvider, "number");
    assert.equal(typeof status.missingModel, "number");
    assert.equal(status.reconciledWithConcurrency, true);
    assert.equal(status.slotVsAgent.agentLive, status.canonicalLiveCount);
  });

  test("agentsStatus(at) and projectLiveAgents(at) agree on the canonical live count", () => {
    const at = Date.now();
    const status = agentsStatus(at);
    const projection = projectLiveAgents(at);
    assert.equal(status.canonicalLiveCount, projection.canonicalTotal);
    assert.equal(status.missingProvider, projection.missingProvider);
    assert.equal(status.missingModel, projection.missingModel);
  });

  test("agentsStatus(at) and concurrencyStatus(at) share the same `at` for slot reconciliation", () => {
    const at = Date.now();
    const agents = agentsStatus(at);
    const concurrency = concurrencyStatus(at);
    assert.equal(agents.slotVsAgent.admissionSlots, concurrency.activeSubagentThreads);
    assert.equal(agents.slotVsAgent.activeAdmissionSessions, concurrency.activeSessions);
    assert.equal(agents.slotVsAgent.processFallbackActiveThreads, concurrency.processFallbackActiveThreads);
  });

  test("AGENT_ACTIVITY_KINDS exposes only session and bridge_subagent", () => {
    assert.deepEqual([...AGENT_ACTIVITY_KINDS].sort(), [ "bridge_subagent", "session" ]);
  });

  test("AGENT_ACTIVITY_STATES includes the eight documented tracker states", () => {
    assert.deepEqual([...AGENT_ACTIVITY_STATES].sort(), [
      "active",
      "failed",
      "finished",
      "resumed",
      "stale",
      "subagent_wait",
      "tool_wait",
      "user_wait",
    ]);
  });

  test("status.agents.slotVsAgent.admissionSlots is sourced from the same tracker as concurrency.activeSubagentThreads", () => {
    agentActivity.reset();
    resetConcurrencyTelemetry();
    try {
      tryAcquireSubagentSlot("reconcile-slot-x");
      tryAcquireSubagentSlot("reconcile-slot-y");
      const status = agentsStatus(Date.now());
      assert.equal(status.canonicalLiveCount, 0);
      assert.equal(status.slotVsAgent.admissionSlots, 2);
      assert.equal(status.slotVsAgent.activeAdmissionSessions, 2);
    } finally {
      resetConcurrencyTelemetry();
      agentActivity.reset();
    }
  });

  test("status.agents exposes concrete liveByProvider and liveByModel partitions", () => {
    agentActivity.reset();
    try {
      agentActivity.beginRequest("session:routed", {
        requestId: "req-routed",
        provider: "minimax",
        model: "MiniMax-M3",
        role: "worker",
        origin: "subagent",
        workspace: "AutoDev",
      });
      const status = agentsStatus(Date.now());
      assert.deepEqual(status.liveByProvider, { minimax: 1 });
      assert.deepEqual(status.liveByModel, { "minimax/MiniMax-M3": 1 });
      assert.equal(status.missingProvider, 0);
      assert.equal(status.missingModel, 0);
    } finally {
      agentActivity.reset();
    }
  });
});

describe("agent reconciliation contract: liveByRole / liveByOrigin / liveByWorkspace retain explicit unattributed residual", () => {
  test("role-less activity reconciles to the unattributed residual", () => {
    agentActivity.reset();
    try {
      agentActivity.beginRequest("session:routed-role", {
        requestId: "req-r",
        provider: "claude",
        model: "sonnet",
        role: "worker",
        origin: "subagent",
        workspace: "AutoDev",
      });
      agentActivity.beginRequest("session:roleless", {
        requestId: "req-rl",
        role: null,
        origin: "direct",
        workspace: "AutoDev",
      });
      const status = agentsStatus(Date.now());
      assert.deepEqual(status.liveByRole, { worker: 1, unattributed: 1 });
      assert.deepEqual(status.liveByOrigin, { subagent: 1, direct: 1 });
      assert.deepEqual(status.liveByWorkspace, { AutoDev: 2 });
      assert.equal(status.missingProvider, 1);
      assert.equal(status.missingModel, 1);
    } finally {
      agentActivity.reset();
    }
  });
});

describe("agent reconciliation contract: scenarios", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    test(name, () => {
      runScenario(name, scenario);
    });
  }
});
