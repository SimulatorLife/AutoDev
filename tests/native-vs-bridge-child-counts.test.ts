import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ingestAgentEvents, resetRouterTelemetry } from "../src/router/http.ts";
import { ingestOtelSignal, resetOtelTelemetry } from "../src/router/otel.ts";
import { CONFIGURED_ORCHESTRATOR_MODEL } from "../src/router/routing.ts";
import {
  closeBridgeSubagentsForRequest,
  noteBridgeRequest,
  recordSubagentSpawn,
  resetSubagentTelemetry,
  spawnFailureStatus,
  subagentStatus,
  UNATTRIBUTED_SUBAGENT_ROLE
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
const currentStatus = (): JsonObject =>
  subagentStatus() as unknown as JsonObject;
const recentStatus = (): Array<JsonObject> =>
  (currentStatus().recent ?? []) as Array<JsonObject>;

const contract = await import(
  "./fixtures/contracts/native-vs-bridge-child-counts.json",
  { with: { type: "json" } }
).then((m) => (m.default ?? m) as Contract);

assert.equal(
  contract.schema,
  "autodev-native-vs-bridge-child-counts-v1",
  "native-vs-bridge child count contract must match its schema tag"
);
assert.deepEqual(
  contract.canonicalMechanisms,
  ["router_alias", "bridge_native"],
  "the canonical mechanism ordering is frozen"
);
assert.equal(
  contract.unattributedSubagentRole,
  UNATTRIBUTED_SUBAGENT_ROLE,
  "the router's roleless bridge role matches the contract"
);
assert.deepEqual(
  [...contract.inheritedChildModels].sort(),
  ["default", "inherit", "parent", "self"],
  "the inherited-child-model list is frozen"
);
assert.equal(contract.recentCap, 50, "the recent-list cap is frozen");

const SCENARIOS = contract.scenarios;

function attrs(entries: ReadonlyArray<readonly [string, unknown]>) {
  return entries.map(([key, item]) => ({
    key,
    value: { stringValue: String(item) }
  }));
}

function pathValue(object: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === "object"
          ? (current as JsonObject)[part]
          : undefined,
      object
    );
}

function resetAll() {
  resetSubagentTelemetry();
  resetOtelTelemetry();
  resetRouterTelemetry();
}

type OperationHandler = (name: string, op: Operation) => void;

const noteSuffix = (op: Operation): string =>
  value<string | undefined>(op, "note")
    ? ` (${value<string>(op, "note")})`
    : "";

function spawnInput(
  op: Operation,
  requestId: string,
  count: number
): Parameters<typeof recordSubagentSpawn>[0] {
  return {
    mechanism: value<string>(op, "mechanism"),
    provider: value<string | null | undefined>(op, "provider") ?? null,
    role: value<string | null | undefined>(op, "role") ?? null,
    tool: value<string | null | undefined>(op, "tool") ?? null,
    requestId,
    workspace: value<string | null | undefined>(op, "workspace") ?? null,
    count
  };
}

function recordExpectedSpawn(
  name: string,
  input: Parameters<typeof recordSubagentSpawn>[0]
): void {
  if (recordSubagentSpawn(input) === null)
    throw new Error(`${name}: recordSubagentSpawn returned null unexpectedly`);
}

function assertRecentRow(
  name: string,
  op: Operation,
  compare: (actual: unknown, expected: unknown, message: string) => void
): void {
  const row = recentStatus()[value<number>(op, "index")];
  assert.ok(row, `${name}: recent[${value<number>(op, "index")}] exists`);
  compare(
    row[value<string>(op, "field")],
    op.expected,
    `${name}: recent[${value<number>(op, "index")}].${value<string>(op, "field")}`
  );
}

function ingestOtelMultiAgentSpawn(total: number): void {
  ingestOtelSignal("metrics", {
    resourceMetrics: [
      {
        resource: { attributes: attrs([["service.name", "codex"]]) },
        scopeMetrics: [
          {
            metrics: [
              {
                name: "codex.multi_agent.spawn",
                sum: {
                  aggregationTemporality: 1,
                  dataPoints: [
                    {
                      attributes: attrs([
                        ["agent_role", "explorer"],
                        ["requested_model", CONFIGURED_ORCHESTRATOR_MODEL],
                        ["status", "success"]
                      ]),
                      startTimeUnixNano: String(1_000_000_000 + total),
                      timeUnixNano: String(1_000_000_000 + total),
                      asInt: String(total)
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  });
}

function seedBridgeChildrenOverflow(op: Operation): void {
  noteBridgeRequest(value<string>(op, "requestId"), {
    activitySubject: `req:${value<string>(op, "requestId")}`,
    provider: value<string>(op, "provider"),
    model: value<string>(op, "model"),
    role: null,
    workspace: value<string>(op, "workspace")
  });
  const children = Array.from(
    { length: value<number>(op, "totalChildren") },
    (_, i) => ({ id: `seed.${i}`, model: "inherit" })
  );
  const perBatch = 50;
  for (let offset = 0; offset < children.length; offset += perBatch) {
    const batch = children.slice(offset, offset + perBatch);
    ingestAgentEvents({
      requestId: value<string>(op, "requestId"),
      events: [
        {
          type: "subagent_spawn",
          tool: "invoke_subagent",
          role: op.role,
          count: batch.length,
          children: batch
        }
      ]
    });
  }
}

const OPERATION_HANDLERS: Record<string, OperationHandler> = {
  assert_keys: (name, op) =>
    assert.deepEqual(
      Object.keys(currentStatus()).sort(),
      [...value<string[]>(op, "expected")].sort(),
      `${name}: subagentStatus() keys`
    ),
  assert_field: (name, op) => {
    const field = value<string>(op, "field");
    assert.equal(
      pathValue(currentStatus(), field),
      op.expected,
      `${name}: ${field}${noteSuffix(op)}`
    );
  },
  assert_deep_equal: (name, op) =>
    assert.deepEqual(
      pathValue(currentStatus(), value<string>(op, "field")),
      op.expected,
      `${name}: ${value<string>(op, "field")}`
    ),
  assert_recent_length: (name, op) =>
    assert.equal(
      recentStatus().length,
      value<number>(op, "expected"),
      `${name}: recent.length${noteSuffix(op)}`
    ),
  assert_recent_field: (name, op) => assertRecentRow(name, op, assert.equal),
  assert_recent_deep_equal: (name, op) =>
    assertRecentRow(name, op, assert.deepEqual),
  assert_recent_absent: (name, op) => {
    const found = recentStatus().some(
      (row) => row.requestId === value<string>(op, "requestId")
    );
    assert.equal(
      found,
      false,
      `${name}: ${value<string>(op, "requestId")} must not appear in recent${noteSuffix(op)}`
    );
  },
  assert_spawn_failure_total_at_least: (name, op) =>
    assert.equal(
      spawnFailureStatus().total >= value<number>(op, "value"),
      true,
      `${name}: spawnFailures.total >= ${value<number>(op, "value")}${noteSuffix(op)}`
    ),
  assert_spawn_failure_by_reason: (name, op) =>
    assert.equal(
      spawnFailureStatus().byReason[value<string>(op, "reason")] ?? 0,
      value<number>(op, "value"),
      `${name}: spawnFailures.byReason.${value<string>(op, "reason")}`
    ),
  bridge_request: (_name, op) =>
    noteBridgeRequest(value<string>(op, "requestId"), {
      activitySubject: `req:${value<string>(op, "requestId")}`,
      provider: value<string>(op, "provider"),
      model: value<string>(op, "model"),
      role: value<string | null | undefined>(op, "role") ?? null,
      workspace: value<string>(op, "workspace")
    }),
  ingest_events: (name, op) => {
    const result = ingestAgentEvents({
      requestId: value<string>(op, "requestId"),
      events: value<unknown>(op, "events")
    });
    if (has(op, "expect"))
      assert.deepEqual(result, op.expect, `${name}: ingestAgentEvents result`);
  },
  record_subagent_spawn: (name, op) =>
    recordExpectedSpawn(
      name,
      spawnInput(
        op,
        value<string>(op, "requestId"),
        value<number | undefined>(op, "count") ?? 1
      )
    ),
  record_subagent_spawn_returns_null: (name, op) =>
    assert.equal(
      recordSubagentSpawn(
        spawnInput(
          op,
          value<string>(op, "requestId"),
          value<number | undefined>(op, "count") ?? 1
        )
      ),
      null,
      `${name}: recordSubagentSpawn must return null for ${op.mechanism}`
    ),
  record_subagent_spawn_repeat: (name, op) => {
    for (let i = 0; i < value<number>(op, "count"); i += 1)
      recordExpectedSpawn(
        name,
        spawnInput(
          op,
          `${value<string>(op, "prefix")}${value<number>(op, "startIndex") + i}`,
          1
        )
      );
  },
  close_bridge_for_request: (name, op) => {
    const closed = closeBridgeSubagentsForRequest(
      value<string>(op, "requestId"),
      value<string>(op, "outcome"),
      value<number | null | undefined>(op, "elapsedMs") ?? null
    );
    if (has(op, "expectClosed"))
      assert.equal(
        closed,
        op.expectClosed,
        `${name}: closeBridgeSubagentsForRequest returned ${closed}`
      );
  },
  ingest_otel_multi_agent_spawn: (_name, op) =>
    ingestOtelMultiAgentSpawn(value<number>(op, "total")),
  seed_bridge_children_overflow: (_name, op) => seedBridgeChildrenOverflow(op)
};

function runOperation(name: string, op: Operation): void {
  const handler = Object.hasOwn(OPERATION_HANDLERS, op.op)
    ? OPERATION_HANDLERS[op.op]
    : undefined;
  if (!handler) throw new Error(`${name}: unknown op ${op.op}`);
  handler(name, op);
}

describe("native-vs-bridge child count contract: constants and module surface", () => {
  test("schema tag is frozen", () => {
    assert.equal(contract.schema, "autodev-native-vs-bridge-child-counts-v1");
  });

  test("canonical mechanisms cover the documented two paths", () => {
    assert.deepEqual(contract.canonicalMechanisms, [
      "router_alias",
      "bridge_native"
    ]);
  });

  test("UNATTRIBUTED_SUBAGENT_ROLE matches the contract's roleless bridge role", () => {
    assert.equal(UNATTRIBUTED_SUBAGENT_ROLE, contract.unattributedSubagentRole);
  });

  test("inherited-child-model list covers every alias the router collapses", () => {
    assert.deepEqual([...contract.inheritedChildModels].sort(), [
      "default",
      "inherit",
      "parent",
      "self"
    ]);
  });

  test("recent-cap constant matches the contract", () => {
    assert.equal(contract.recentCap, 50);
  });

  test("subagentStatus() exposes the canonical projection key set", () => {
    resetAll();
    try {
      const keys = Object.keys(subagentStatus()).sort();
      assert.deepEqual(keys, [
        "byMechanism",
        "byProvider",
        "byRole",
        "byStatus",
        "codexNativeSpawns",
        "recent",
        "spawnCapableProviders",
        "total"
      ]);
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
      assert.deepEqual(status.byMechanism, {
        bridge_native: 0,
        router_alias: 0
      });
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
