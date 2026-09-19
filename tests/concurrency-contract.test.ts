import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  type ConcurrencyDenialRecord,
  concurrencyStatus,
  parseConcurrencyConfig,
  PROCESS_FALLBACK_SESSION_KEY,
  recordConcurrencyDenial,
  releaseSubagentSlot,
  resetConcurrencyTelemetry,
  tryAcquireSubagentSlot
} from "../src/router/concurrency.ts";

type JsonRecord = Record<string, any>;

const contract = await import(
  "./fixtures/contracts/concurrency-contract.json",
  { with: { type: "json" } }
).then((m) => (m.default ?? m) as JsonRecord);

assert.equal(
  contract.schema,
  "autodev-concurrency-contract-v1",
  "concurrency contract must match its schema tag"
);
assert.equal(
  contract.canonicalKey,
  "max_concurrent_threads_per_session",
  "canonical key is frozen"
);
assert.equal(contract.legacyAlias, "max_threads", "legacy alias is frozen");
assert.equal(
  contract.denialReason,
  "max_concurrent_threads_per_session",
  "denial reason is frozen"
);

const SCENARIOS = contract.scenarios as Record<string, JsonRecord>;

function getPath(obj: any, dotted: string): any {
  let cur = obj;
  for (const part of dotted.split(".")) cur = cur?.[part];
  return cur;
}

function runParseScenario(name: string, scenario: JsonRecord): Promise<void> {
  if (!scenario.missing && typeof scenario.source !== "string") {
    throw new Error(`${name}: parse scenarios must declare source or missing`);
  }
  return (async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "autodev-concurrency-contract-")
    );
    const configFile = join(directory, "config.toml");
    try {
      if (scenario.missing) {
        await rm(configFile, { force: true });
      } else {
        await writeFile(configFile, scenario.source);
      }
      const result = parseConcurrencyConfig(configFile) as JsonRecord;
      assert.equal(
        Object.hasOwn(result, "maxThreads"),
        false,
        `${name}: result must not expose maxThreads`
      );
      for (const [key, value] of Object.entries(scenario.expected)) {
        assert.equal(result[key], value, `${name}: ${key}`);
      }
      assert.equal(
        Object.keys(result).sort().join(","),
        ["file", ...Object.keys(scenario.expected)].sort().join(","),
        `${name}: result key set`
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
}

function runAdmissionScenario(name: string, scenario: JsonRecord): void {
  resetConcurrencyTelemetry();
  try {
    const configuredLimit = scenario.configuredLimit;
    if (!Number.isInteger(configuredLimit) || configuredLimit <= 0) {
      throw new Error(`${name}: configuredLimit must be a positive integer`);
    }
    for (const op of scenario.operations ?? []) {
      switch (op.op) {
        case "acquire": {
          const denial = tryAcquireSubagentSlot(op.sessionKey);
          if (Object.hasOwn(op, "expected"))
            assert.equal(
              denial,
              op.expected,
              `${name}: acquire ${op.sessionKey} returns expected denial`
            );
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
            timestamp: new Date().toISOString()
          } as ConcurrencyDenialRecord);
          break;
        }
        case "status_field": {
          const value = getPath(concurrencyStatus(), op.field);
          assert.equal(value, op.expected, `${name}: ${op.field}`);
          break;
        }
        case "status_shape": {
          const keys = Object.keys(concurrencyStatus()).sort();
          assert.deepEqual(
            keys,
            [...op.expected].sort(),
            `${name}: status shape`
          );
          break;
        }
        case "status_no_key": {
          assert.equal(
            Object.hasOwn(concurrencyStatus(), op.key),
            false,
            `${name}: ${op.key} must not appear on /status`
          );
          break;
        }
        default: {
          throw new Error(`${name}: unknown op ${op.op}`);
        }
      }
    }
  } finally {
    resetConcurrencyTelemetry();
  }
}

describe("concurrency contract parser scenarios", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (!("source" in scenario) && !scenario.missing) continue;
    test(name, async () => {
      await runParseScenario(name, scenario);
    });
  }
});

describe("concurrency contract admission scenarios", () => {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    if (!("configuredLimit" in scenario)) continue;
    const actualLimit = concurrencyStatus().effectivePerSessionLimit;
    const limitMatches = actualLimit === scenario.configuredLimit;
    test(
      name,
      {
        skip: limitMatches
          ? false
          : `requires effective limit ${scenario.configuredLimit}; host has ${actualLimit ?? "no configured limit"}`
      },
      () => {
        runAdmissionScenario(name, scenario);
      }
    );
  }
});

describe("concurrency contract constants", () => {
  test("process-fallback bucket key is frozen", () => {
    assert.equal(PROCESS_FALLBACK_SESSION_KEY, "process-scope");
  });
  test("denial reason is the canonical Codex key", () => {
    assert.equal(contract.denialReason, "max_concurrent_threads_per_session");
  });
  test("legacy alias is named for removal, not fallback", () => {
    assert.equal(contract.legacyAlias, "max_threads");
  });
});
