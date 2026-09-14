import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  closeBridgeSubagentsForRequest,
  ingestAgentEvents,
  ingestOtelSignal,
  noteBridgeRequest,
  recordSubagentSpawn,
  resetOtelTelemetry,
  resetRouterTelemetry,
  resetSubagentTelemetry,
  spawnFailureStatus,
  subagentStatus,
  UNATTRIBUTED_SUBAGENT_ROLE,
} from "../scripts/codex-model-router.mjs";

const contract = await import("./fixtures/contracts/native-vs-bridge-child-counts.json", { with: { type: "json" } }).then((m) => m.default ?? m);

assert.equal(contract.schema, "autodev-native-vs-bridge-child-counts-v1", "native-vs-bridge child count contract must match its schema tag");
assert.deepEqual(contract.canonicalMechanisms, [ "router_alias", "bridge_native" ], "the canonical mechanism ordering is frozen");
assert.equal(contract.unattributedSubagentRole, UNATTRIBUTED_SUBAGENT_ROLE, "the router's roleless bridge role matches the contract");
assert.deepEqual([...contract.inheritedChildModels].sort(), [ "default", "inherit", "parent", "self" ], "the inherited-child-model list is frozen");
assert.equal(contract.recentCap, 50, "the recent-list cap is frozen");

const SCENARIOS = contract.scenarios;

function attrs(entries) {
  return entries.map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
}

function pathValue(object, path) {
  return path.split(".").reduce((value, part) => value?.[part], object);
}

function resetAll() {
  resetSubagentTelemetry();
  resetOtelTelemetry();
  resetRouterTelemetry();
}

function runOperation(name, op) {
  if (op.op === "assert_keys") {
    assert.deepEqual(Object.keys(subagentStatus()).sort(), [...op.expected].sort(), `${name}: subagentStatus() keys`);
    return;
  }
  if (op.op === "assert_field") {
    assert.equal(pathValue(subagentStatus(), op.field), op.expected, `${name}: ${op.field}${op.note ? ` (${op.note})` : ""}`);
    return;
  }
  if (op.op === "assert_deep_equal") {
    assert.deepEqual(pathValue(subagentStatus(), op.field), op.expected, `${name}: ${op.field}`);
    return;
  }
  if (op.op === "assert_recent_length") {
    assert.equal(subagentStatus().recent.length, op.expected, `${name}: recent.length${op.note ? ` (${op.note})` : ""}`);
    return;
  }
  if (op.op === "assert_recent_field") {
    const row = subagentStatus().recent[op.index];
    assert.ok(row, `${name}: recent[${op.index}] exists`);
    assert.equal(row[op.field], op.expected, `${name}: recent[${op.index}].${op.field}`);
    return;
  }
  if (op.op === "assert_recent_deep_equal") {
    const row = subagentStatus().recent[op.index];
    assert.ok(row, `${name}: recent[${op.index}] exists`);
    assert.deepEqual(row[op.field], op.expected, `${name}: recent[${op.index}].${op.field}`);
    return;
  }
  if (op.op === "assert_recent_absent") {
    const found = subagentStatus().recent.some((row) => row.requestId === op.requestId);
    assert.equal(found, false, `${name}: ${op.requestId} must not appear in recent${op.note ? ` (${op.note})` : ""}`);
    return;
  }
  if (op.op === "assert_spawn_failure_total_at_least") {
    assert.equal(spawnFailureStatus().total >= op.value, true, `${name}: spawnFailures.total >= ${op.value}${op.note ? ` (${op.note})` : ""}`);
    return;
  }
  if (op.op === "assert_spawn_failure_by_reason") {
    assert.equal(spawnFailureStatus().byReason[op.reason] ?? 0, op.value, `${name}: spawnFailures.byReason.${op.reason}`);
    return;
  }
  if (op.op === "bridge_request") {
    noteBridgeRequest(op.requestId, { provider: op.provider, model: op.model, role: op.role ?? null, workspace: op.workspace });
    return;
  }
  if (op.op === "ingest_events") {
    const result = ingestAgentEvents({ requestId: op.requestId, events: op.events });
    if (Object.hasOwn(op, "expect")) assert.deepEqual(result, op.expect, `${name}: ingestAgentEvents result`);
    return;
  }
  if (op.op === "record_subagent_spawn") {
    const entry = recordSubagentSpawn({ mechanism: op.mechanism, provider: op.provider ?? null, role: op.role ?? null, tool: op.tool ?? null, requestId: op.requestId, workspace: op.workspace ?? null, count: op.count ?? 1 });
    if (entry === null) throw new Error(`${name}: recordSubagentSpawn returned null unexpectedly`);
    return;
  }
  if (op.op === "record_subagent_spawn_returns_null") {
    const entry = recordSubagentSpawn({ mechanism: op.mechanism, provider: op.provider ?? null, role: op.role ?? null, tool: op.tool ?? null, requestId: op.requestId, workspace: op.workspace ?? null, count: op.count ?? 1 });
    assert.equal(entry, null, `${name}: recordSubagentSpawn must return null for ${op.mechanism}`);
    return;
  }
  if (op.op === "record_subagent_spawn_repeat") {
    for (let i = 0; i < op.count; i += 1) {
      const requestId = `${op.prefix}${op.startIndex + i}`;
      const entry = recordSubagentSpawn({ mechanism: op.mechanism, provider: op.provider ?? null, role: op.role ?? null, tool: op.tool ?? null, requestId, workspace: op.workspace ?? null, count: 1 });
      if (entry === null) throw new Error(`${name}: recordSubagentSpawn returned null unexpectedly`);
    }
    return;
  }
  if (op.op === "close_bridge_for_request") {
    const closed = closeBridgeSubagentsForRequest(op.requestId, op.outcome, op.elapsedMs ?? null);
    if (Object.hasOwn(op, "expectClosed")) assert.equal(closed, op.expectClosed, `${name}: closeBridgeSubagentsForRequest returned ${closed}`);
    return;
  }
  if (op.op === "ingest_otel_multi_agent_spawn") {
    ingestOtelSignal("metrics", {
      resourceMetrics: [
        {
          resource: { attributes: attrs([ [ "service.name", "codex" ] ]) },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "codex.multi_agent.spawn",
                  sum: {
                    aggregationTemporality: 1,
                    dataPoints: [
                      {
                        attributes: attrs([ [ "agent_role", "explorer" ], [ "requested_model", "gpt-5.6-luna" ], [ "status", "success" ] ]),
                        startTimeUnixNano: String(1_000_000_000 + op.total),
                        timeUnixNano: String(1_000_000_000 + op.total),
                        asInt: String(op.total),
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    return;
  }
  if (op.op === "seed_bridge_children_overflow") {
    noteBridgeRequest(op.requestId, { provider: op.provider, model: op.model, role: null, workspace: op.workspace });
    const children = Array.from({ length: op.totalChildren }, (_, i) => ({ id: `seed.${i}`, model: "inherit" }));
    const perBatch = 50;
    for (let offset = 0; offset < children.length; offset += perBatch) {
      const batch = children.slice(offset, offset + perBatch);
      ingestAgentEvents({
        requestId: op.requestId,
        events: [
          { type: "subagent_spawn", tool: "invoke_subagent", role: op.role, count: batch.length, children: batch },
        ],
      });
    }
    return;
  }
  throw new Error(`${name}: unknown op ${op.op}`);
}

describe("native-vs-bridge child count contract: constants and module surface", () => {
  test("schema tag is frozen", () => {
    assert.equal(contract.schema, "autodev-native-vs-bridge-child-counts-v1");
  });

  test("canonical mechanisms cover the documented two paths", () => {
    assert.deepEqual(contract.canonicalMechanisms, [ "router_alias", "bridge_native" ]);
  });

  test("UNATTRIBUTED_SUBAGENT_ROLE matches the contract's roleless bridge role", () => {
    assert.equal(UNATTRIBUTED_SUBAGENT_ROLE, contract.unattributedSubagentRole);
  });

  test("inherited-child-model list covers every alias the router collapses", () => {
    assert.deepEqual([...contract.inheritedChildModels].sort(), [ "default", "inherit", "parent", "self" ]);
  });

  test("recent-cap constant matches the contract", () => {
    assert.equal(contract.recentCap, 50);
  });

  test("subagentStatus() exposes the canonical projection key set", () => {
    resetAll();
    try {
      const keys = Object.keys(subagentStatus()).sort();
      assert.deepEqual(keys, [ "byMechanism", "byProvider", "byRole", "byStatus", "codexNativeSpawns", "recent", "spawnCapableProviders", "total" ]);
    } finally {
      resetAll();
    }
  });

  test("subagentStatus() on a fresh tracker reports zero counts and empty recent", () => {
    resetAll();
    try {
      const status = subagentStatus();
      assert.equal(status.total, 0);
      assert.equal(status.codexNativeSpawns, 0);
      assert.deepEqual(status.byMechanism, { bridge_native: 0, router_alias: 0 });
      assert.deepEqual(status.byStatus, {});
      assert.deepEqual(status.byProvider, {});
      assert.deepEqual(status.byRole, {});
      assert.deepEqual(status.recent, []);
    } finally {
      resetAll();
    }
  });
});

describe("native-vs-bridge child count contract: scenarios", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
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
