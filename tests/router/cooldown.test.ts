import assert from "node:assert/strict";
import test from "node:test";

import {
  COOLDOWN_CONFIG,
  ProviderCooldowns
} from "../../src/router/cooldown.ts";

const NOW = 1_700_000_000_000;

test("typed cooldowns preserve config, probe, transient, and hard ladders", () => {
  const cooldowns = new ProviderCooldowns();
  assert.equal(
    cooldowns.cooldownProvider("claude", {
      now: NOW,
      failureClass: "authentication"
    }).kind,
    "config"
  );
  cooldowns.clear("claude");
  assert.equal(
    cooldowns.cooldownProvider("claude", {
      now: NOW,
      failureClass: "probe_unavailable"
    }).durationMs,
    COOLDOWN_CONFIG.probeCooldownMs
  );
  cooldowns.clear("claude");
  assert.equal(
    cooldowns.cooldownProvider("claude", { now: NOW }).durationMs,
    COOLDOWN_CONFIG.providerCooldownMs
  );
  const reset = new Date(NOW + 3_600_000).toISOString();
  const hard = cooldowns.cooldownProvider("claude", {
    now: NOW,
    failureClass: "quota_exhausted",
    resetsAt: reset,
    structured: true
  });
  assert.equal(hard.kind, "hard");
  assert.equal(hard.cooldownUntil, NOW + 3_600_000);
});

test("typed cooldowns keep monotonic deadlines, last-resort policy, and retry summaries", () => {
  const cooldowns = new ProviderCooldowns(undefined, {
    isProviderEnabled: (provider) => provider !== "disabled"
  });
  const reset = new Date(NOW + 3_600_000).toISOString();
  cooldowns.cooldownProvider("claude", {
    now: NOW,
    failureClass: "quota_exhausted",
    resetsAt: reset,
    structured: true
  });
  cooldowns.cooldownProvider("claude", {
    now: NOW,
    failureClass: "authentication"
  });
  const entry = cooldowns.get("claude", NOW + 1);
  assert.equal(entry?.kind, "hard");
  assert.equal(cooldowns.allowsLastResort(entry, NOW + 1), false);
  assert.equal(cooldowns.nextRetryMs(["claude"], NOW + 1), 3_599_999);
  assert.deepEqual(cooldowns.summary(["claude", "disabled"], NOW + 1), [
    {
      provider: "claude",
      state: "hard",
      failureClass: "quota_exhausted",
      resetsAt: reset,
      retryAfterMs: 3_599_999
    },
    {
      provider: "disabled",
      state: "disabled",
      failureClass: "provider_disabled",
      resetsAt: null,
      retryAfterMs: 0
    }
  ]);
});

test("typed cooldown persistence restores only future hard entries and clamps them", () => {
  const source = new ProviderCooldowns();
  source.cooldownProvider("claude", {
    now: NOW,
    failureClass: "quota_exhausted",
    structured: true
  });
  source.cooldownProvider("minimax", { now: NOW, failureClass: "throttled" });
  const persisted = source.persistedHardEntries();
  assert.deepEqual(
    persisted.map((entry) => entry.provider),
    ["claude"]
  );

  const restored = new ProviderCooldowns();
  restored.restoreHardEntries(
    [...persisted, { provider: "expired", kind: "hard", until: NOW - 1 }],
    NOW
  );
  assert.equal(restored.isCooling("claude", NOW + 1), true);
  assert.equal(restored.isCooling("minimax", NOW + 1), false);
  assert.equal(restored.isCooling("expired", NOW + 1), false);
});
