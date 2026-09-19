import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ingestAgentEvents, resetRouterTelemetry } from "../src/router/http.ts";
import { ingestOtelSignal, resetOtelTelemetry } from "../src/router/otel.ts";
import {
  closeBridgeSubagentsForRequest,
  noteBridgeRequest,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  spawnFailureStatus,
  subagentStatus,
  UNATTRIBUTED_SUBAGENT_ROLE,
} from "../src/router/subagents.ts";

type JsonObject = Record<string, unknown>;
type Operation = JsonObject & { op: string };
type Scenario = { operations: Operation[] };
type Contract = {
  schema: string;
  canonicalMechanisms: string[];
  unattributedSubagentRole: string;
  inheritedChildModels: string[];
  recentCap: number;
  scenarios: Record<string, Scenario>;
};

const value = <T>(op: Operation, key: string): T => op[key] as T;
const has = (op: Operation, key: string): boolean => Object.hasOwn(op, key);
const currentStatus = (): JsonObject => subagentStatus() as unknown as JsonObject;
const recentStatus = (): Array<JsonObject> => (currentStatus().recent ?? []) as Array<JsonObject>;


const contract = await import("./fixtures/contracts/native-vs-bridge-child-counts.json", { with: { type: "json" } }).then((m) => (m.default ?? m) as Contract);

assert.equal(contract.schema, "autodev-native-vs-bridge-child-counts-v1", "native-vs-bridge child count contract must match its schema tag");
assert.deepEqual(contract.canonicalMechanisms, [ "router_alias", "bridge_native" ], "the canonical mechanism ordering is frozen");
assert.equal(contract.unattributedSubagentRole, UNATTRIBUTED_SUBAGENT_ROLE, "the router's roleless bridge role matches the contract");
assert.deepEqual([...contract.inheritedChildModels].sort(), [ "default", "inherit", "parent", "self" ], "the inherited-child-model list is frozen");
assert.equal(contract.recentCap, 50, "the recent-list cap is frozen");

const SCENARIOS = contract.scenarios;

function attrs(entries: ReadonlyArray<readonly [string, unknown]>) {
  return entries.map(([key, item]) => ({ key, value: { stringValue: String(item) } }));
}

function pathValue(object: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => current && typeof current === "object" ? (current as JsonObject)[part] : undefined, object);
}

function resetAll() {
  resetSubagentTelemetry();
  resetOtelTelemetry();
  resetRouterTelemetry();
}

function runOperation(name: string, op: Operation): void {
  if (op.op === "assert_keys") {
    assert.deepEqual(Object.keys(currentStatus()).sort(), [...value<string[]>(op, "expected")].sort(), `${name}: subagentStatus() keys`);
    return;
  }
  if (op.op === "assert_field") {
    const field = value<string>(op, "field");
    const note = value<string | undefined>(op, "note");
    assert.equal(pathValue(currentStatus(), field), op.expected, `${name}: ${field}${note ? ` (${note})` : ""}`);
    return;
  }
  if (op.op === "assert_deep_equal") {
    assert.deepEqual(pathValue(currentStatus(), value<string>(op, "field")), op.expected, `${name}: ${value<string>(op, "field")}`);
    return;
  }
  if (op.op === "assert_recent_length") {
    assert.equal(recentStatus().length, value<number>(op, "expected"), `${name}: recent.length${value<string | undefined>(op, "note") ? ` (${value<string>(op, "note")})` : ""}`);
    return;
  }
  if (op.op === "assert_recent_field") {
    const row = recentStatus()[value<number>(op, "index")];
    assert.ok(row, `${name}: recent[${value<number>(op, "index")}] exists`);
    assert.equal(row[value<string>(op, "field")], op.expected, `${name}: recent[${value<number>(op, "index")}].${value<string>(op, "field")}`);
    return;
  }
  if (op.op === "assert_recent_deep_equal") {
    const row = recentStatus()[value<number>(op, "index")];
    assert.ok(row, `${name}: recent[${value<number>(op, "index")}] exists`);
    assert.deepEqual(row[value<string>(op, "field")], op.expected, `${name}: recent[${value<number>(op, "index")}].${value<string>(op, "field")}`);
    return;
  }
  if (op.op === "assert_recent_absent") {
    const found = recentStatus().some((row) => row.requestId === value<string>(op, "requestId"));
    assert.equal(found, false, `${name}: ${value<string>(op, "requestId")} must not appear in recent${value<string | undefined>(op, "note") ? ` (${value<string>(op, "note")})` : ""}`);
    return;
  }
  if (op.op === "assert_spawn_failure_total_at_least") {
    assert.equal(spawnFailureStatus().total >= value<number>(op, "value"), true, `${name}: spawnFailures.total >= ${value<number>(op, "value")}${value<string | undefined>(op, "note") ? ` (${value<string>(op, "note")})` : ""}`);
    return;
  }
  if (op.op === "assert_spawn_failure_by_reason") {
    assert.equal(spawnFailureStatus().byReason[value<string>(op, "reason")] ?? 0, value<number>(op, "value"), `${name}: spawnFailures.byReason.${value<string>(op, "reason")}`);
    return;
  }
  if (op.op === "bridge_request") {
    noteBridgeRequest(value<string>(op, "requestId"), { activitySubject: `req:${value<string>(op, "requestId")}`, provider: value<string>(op, "provider"), model: value<string>(op, "model"), role: value<string | null | undefined>(op, "role") ?? null, workspace: value<string>(op, "workspace") });
    return;
  }
  if (op.op === "ingest_events") {
    const result = ingestAgentEvents({ requestId: value<string>(op, "requestId"), events: value<unknown>(op, "events") });
    if (has(op, "expect")) assert.deepEqual(result, op.expect, `${name}: ingestAgentEvents result`);
    return;
  }
  if (op.op === "record_subagent_spawn") {
    const entry = recordSubagentSpawn({ mechanism: value<string>(op, "mechanism"), provider: value<string | null | undefined>(op, "provider") ?? null, role: value<string | null | undefined>(op, "role") ?? null, tool: value<string | null | undefined>(op, "tool") ?? null, requestId: value<string>(op, "requestId"), workspace: value<string | null | undefined>(op, "workspace") ?? null, count: value<number | undefined>(op, "count") ?? 1 });
    if (entry === null) throw new Error(`${name}: recordSubagentSpawn returned null unexpectedly`);
    return;
  }
  if (op.op === "record_subagent_spawn_returns_null") {
    const entry = recordSubagentSpawn({ mechanism: value<string>(op, "mechanism"), provider: value<string | null | undefined>(op, "provider") ?? null, role: value<string | null | undefined>(op, "role") ?? null, tool: value<string | null | undefined>(op, "tool") ?? null, requestId: value<string>(op, "requestId"), workspace: value<string | null | undefined>(op, "workspace") ?? null, count: value<number | undefined>(op, "count") ?? 1 });
    assert.equal(entry, null, `${name}: recordSubagentSpawn must return null for ${op.mechanism}`);
    return;
  }
  if (op.op === "record_subagent_spawn_repeat") {
    for (let i = 0; i < value<number>(op, "count"); i += 1) {
      const requestId = `${value<string>(op, "prefix")}${value<number>(op, "startIndex") + i}`;
      const entry = recordSubagentSpawn({ mechanism: value<string>(op, "mechanism"), provider: value<string | null | undefined>(op, "provider") ?? null, role: value<string | null | undefined>(op, "role") ?? null, tool: value<string | null | undefined>(op, "tool") ?? null, requestId, workspace: value<string | null | undefined>(op, "workspace") ?? null, count: 1 });
      if (entry === null) throw new Error(`${name}: recordSubagentSpawn returned null unexpectedly`);
    }
    return;
  }
  if (op.op === "close_bridge_for_request") {
    const closed = closeBridgeSubagentsForRequest(value<string>(op, "requestId"), value<string>(op, "outcome"), value<number | null | undefined>(op, "elapsedMs") ?? null);
    if (has(op, "expectClosed")) assert.equal(closed, op.expectClosed, `${name}: closeBridgeSubagentsForRequest returned ${closed}`);
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
                        startTimeUnixNano: String(1_000_000_000 + value<number>(op, "total")),
                        timeUnixNano: String(1_000_000_000 + value<number>(op, "total")),
                        asInt: String(value<number>(op, "total")),
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
    noteBridgeRequest(value<string>(op, "requestId"), { activitySubject: `req:${value<string>(op, "requestId")}`, provider: value<string>(op, "provider"), model: value<string>(op, "model"), role: null, workspace: value<string>(op, "workspace") });
    const children = Array.from({ length: value<number>(op, "totalChildren") }, (_, i) => ({ id: `seed.${i}`, model: "inherit" }));
    const perBatch = 50;
    for (let offset = 0; offset < children.length; offset += perBatch) {
      const batch = children.slice(offset, offset + perBatch);
      ingestAgentEvents({
        requestId: value<string>(op, "requestId"),
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
