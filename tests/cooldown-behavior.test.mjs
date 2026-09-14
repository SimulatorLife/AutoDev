import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

import {
  cooldownAllowsLastResort,
  cooldownProvider,
  clearProviderCooldown,
  nextProviderRetryMs,
  providerCooldownSummary,
  resetDisabledProvidersForTests,
  setProviderEnabled,
} from "../scripts/codex-model-router.mjs";

const contract = JSON.parse(
  await readFile(new URL("./fixtures/contracts/cooldown-behavior.json", import.meta.url), "utf8"),
);

assert.equal(contract.schema, "autodev-cooldown-behavior-v1", "cooldown behavior contract must match its schema tag");
assert.equal(typeof contract.now, "number", "cooldown behavior contract must fix `now` to an epoch millisecond value");

const NOW = contract.now;
const PROVIDERS = [ "claude", "antigravity", "minimax", "copilot", "codex" ];

function cleanState() {
  for (const provider of PROVIDERS) clearProviderCooldown(provider);
  resetDisabledProvidersForTests();
}

function applySetup(setup) {
  for (const step of setup ?? []) {
    if (step && typeof step === "object" && typeof step.disable === "string") {
      setProviderEnabled(step.disable, false);
      continue;
    }
    cooldownProvider(step.provider, { now: NOW, ...(step.args ?? {}) });
  }
}

function runScenario(name, scenario) {
  cleanState();
  applySetup(scenario.setup);

  // Ladder scenarios pin every rung of the probe/transient escalation.
  if (scenario.expectedStreaks) {
    assert.equal(
      scenario.setup.length,
      scenario.expectedStreaks.length,
      `${name}: ladder setup length must match expected streak length`,
    );
    for (let i = 0; i < scenario.setup.length; i += 1) {
      const step = scenario.setup[i];
      const expected = scenario.expectedStreaks[i];
      cleanState();
      // Replay the preceding setup steps so the per-provider streak counter
      // is at the right rung, then call cooldownProvider once with step i's
      // args and assert the return shape matches the expected streak.
      for (let j = 0; j < i; j += 1) {
        const inner = scenario.setup[j];
        cooldownProvider(inner.provider, { now: NOW, ...(inner.args ?? {}) });
      }
      const final = cooldownProvider(step.provider, { now: NOW, ...(step.args ?? {}) });
      assert.equal(final.provider, step.provider, `${name}: ladder step returns the expected provider`);
      assert.equal(final.kind, expected.kind, `${name}: ladder step ${i + 1} kind`);
      assert.equal(final.streak, expected.streak, `${name}: ladder step ${i + 1} streak`);
      assert.equal(final.durationMs, expected.durationMs, `${name}: ladder step ${i + 1} durationMs`);
    }
    return;
  }

  // Last-resort scenarios drive cooldownAllowsLastResort with a hand-built entry.
  if ("entry" in scenario) {
    const at = NOW + (scenario.atDeltaMs ?? 0);
    assert.equal(
      cooldownAllowsLastResort(scenario.entry, at),
      scenario.expected,
      `${name}: cooldownAllowsLastResort decision`,
    );
    return;
  }

  // Summary scenarios pin the structured providerCooldownSummary shape.
  if ("providers" in scenario && Array.isArray(scenario.expected)) {
    const at = NOW + (scenario.atDeltaMs ?? 0);
    assert.deepEqual(
      providerCooldownSummary(scenario.providers, at),
      scenario.expected,
      `${name}: providerCooldownSummary shape`,
    );
    return;
  }

  // Retry scenarios pin the nextProviderRetryMs return value.
  if ("providers" in scenario && typeof scenario.expected === "number") {
    const at = NOW + (scenario.atDeltaMs ?? 0);
    assert.equal(
      nextProviderRetryMs(scenario.providers, at),
      scenario.expected,
      `${name}: nextProviderRetryMs returns the earliest remaining ms`,
    );
    return;
  }

  // Single-result scenarios: either a `cooldownProvider` return shape (kind,
  // streak, durationMs, cooldownUntilDeltaMs, resetsAt) or a summary-style
  // single-provider snapshot (state, failureClass, resetsAt, retryAfterMs).
  if ("state" in scenario.expected) {
    assert.deepEqual(
      providerCooldownSummary([ "claude" ], NOW + 1)[0],
      scenario.expected,
      `${name}: single-provider providerCooldownSummary shape`,
    );
    return;
  }

  cleanState();
  const last = scenario.setup.at(-1) ?? { provider: "claude", args: {} };
  const final = cooldownProvider(last.provider, { now: NOW, ...(last.args ?? {}) });
  assert.equal(final.kind, scenario.expected.kind, `${name}: cooldownProvider kind`);
  assert.equal(final.streak, scenario.expected.streak, `${name}: cooldownProvider streak`);
  assert.equal(final.durationMs, scenario.expected.durationMs, `${name}: cooldownProvider durationMs`);
  assert.equal(final.cooldownUntil, NOW + scenario.expected.cooldownUntilDeltaMs, `${name}: cooldownProvider cooldownUntil`);
  assert.equal(final.resetsAt, scenario.expected.resetsAt, `${name}: cooldownProvider resetsAt`);
}

describe("cooldown behavior", () => {
  test("contract constants match the live cooldown ceilings", () => {
    assert.equal(contract.constants.providerCooldownMs, 30_000);
    assert.equal(contract.constants.providerCooldownMaxMs, 600_000);
    assert.equal(contract.constants.hardCooldownMs, 900_000);
    assert.equal(contract.constants.hardCooldownMaxMs, 21_600_000);
    assert.equal(contract.constants.probeCooldownMs, 5_000);
    assert.equal(contract.constants.probeCooldownMaxMs, 30_000);
  });

  for (const [ name, scenario ] of Object.entries(contract.scenarios)) {
    test(`${name}`, () => {
      try {
        runScenario(name, scenario);
      } finally {
        cleanState();
      }
    });
  }

  test("cooldownProvider return shape covers config/probe/transient/hard", () => {
    try {
      cleanState();
      const cfg = cooldownProvider("claude", { now: NOW, failureClass: "authentication" });
      assert.deepEqual(Object.keys(cfg).sort(), [ "cooldownUntil", "durationMs", "kind", "provider", "resetsAt", "streak" ].sort());
      assert.equal(cfg.provider, "claude");
      assert.equal(cfg.kind, "config");
      assert.equal(cfg.streak, 0);
      assert.equal(cfg.durationMs, contract.constants.providerCooldownMs);
      assert.equal(cfg.cooldownUntil, NOW + cfg.durationMs);
      assert.equal(cfg.resetsAt, null);

      cleanState();
      const probe = cooldownProvider("antigravity", { now: NOW, failureClass: "probe_unavailable" });
      assert.equal(probe.kind, "probe");
      assert.equal(probe.streak, 1);
      assert.equal(probe.durationMs, contract.constants.probeCooldownMs);
      assert.equal(probe.cooldownUntil, NOW + probe.durationMs);
      assert.equal(probe.resetsAt, null);

      cleanState();
      const trans = cooldownProvider("claude", { now: NOW });
      assert.equal(trans.kind, "transient");
      assert.equal(trans.streak, 1);
      assert.equal(trans.durationMs, contract.constants.providerCooldownMs);
      assert.equal(trans.cooldownUntil, NOW + trans.durationMs);
      assert.equal(trans.resetsAt, null);

      cleanState();
      const reset = new Date(NOW + 3_600_000).toISOString();
      const hard = cooldownProvider("claude", { now: NOW, failureClass: "quota_exhausted", resetsAt: reset, structured: true });
      assert.equal(hard.kind, "hard");
      assert.equal(hard.streak, 0);
      assert.equal(hard.durationMs, 3_600_000);
      assert.equal(hard.cooldownUntil, NOW + 3_600_000);
      assert.equal(hard.resetsAt, reset);
    } finally {
      cleanState();
    }
  });

  test("clearProviderCooldown wipes both cooldowns and the failure/probe streaks", () => {
    try {
      cooldownProvider("claude", { now: NOW, failureClass: "probe_unavailable" });
      cooldownProvider("claude", { now: NOW });
      clearProviderCooldown("claude");
      assert.deepEqual(providerCooldownSummary([ "claude" ], NOW + 1), [
        { provider: "claude", state: "available", failureClass: null, resetsAt: null, retryAfterMs: 0 },
      ]);
      const fresh = cooldownProvider("claude", { now: NOW });
      assert.equal(fresh.kind, "transient");
      assert.equal(fresh.streak, 1);
      assert.equal(fresh.durationMs, contract.constants.providerCooldownMs);
    } finally {
      cleanState();
    }
  });

  test("every fixture scenario stays within the contract ceilings", () => {
    for (const [ name, scenario ] of Object.entries(contract.scenarios)) {
      try {
        cleanState();
        applySetup(scenario.setup);
        if (scenario.expectedStreaks) continue;
        if ("providers" in scenario && Array.isArray(scenario.expected)) {
          const rows = providerCooldownSummary(scenario.providers, NOW + (scenario.atDeltaMs ?? 0));
          for (const row of rows) {
            assert.ok([ "available", "config", "probe", "transient", "hard", "disabled" ].includes(row.state), `${name}: state must be a known cooldown kind`);
            assert.equal(typeof row.provider, "string");
            assert.equal(typeof row.retryAfterMs, "number");
          }
          continue;
        }
        if ("entry" in scenario) continue;
        const last = scenario.setup.at(-1);
        if (!last) continue;
        cleanState();
        const sentinel = last.provider === "antigravity" ? "claude" : "antigravity";
        const final = cooldownProvider(sentinel, { now: NOW, ...(last.args ?? {}) });
        assert.ok(final.durationMs <= Math.max(
          contract.constants.providerCooldownMaxMs,
          contract.constants.hardCooldownMaxMs,
          contract.constants.probeCooldownMaxMs,
        ), `${name}: durationMs must respect the contract ceilings`);
      } finally {
        cleanState();
      }
    }
  });
});
