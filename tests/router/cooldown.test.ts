import assert from "node:assert/strict";
import test from "node:test";

import {
  COOLDOWN_CONFIG,
  ProviderCooldowns
} from "@simulatorlife/autodev-runtime/router/cooldown";

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

test("an inferred quota keeps the window the provider reported", () => {
  // An inferred limit -- one read out of a CLI's stderr -- never earns a hard
  // cooldown, so it stays on the transient ladder and is retried long before
  // the window agy named. The deadline must stay short; the reported window is
  // still a fact about the provider and has to survive into the entry, because
  // it is what the reader is shown in place of a number derived from a failure
  // streak. Dropping it is what produced a quota saying "resets in 24m43s"
  // surfacing as "retry in 480s".
  const cooldowns = new ProviderCooldowns();
  const reset = new Date(NOW + 24 * 60_000 + 43_000).toISOString();
  const inferred = cooldowns.cooldownProvider("antigravity", {
    now: NOW,
    failureClass: "quota_exhausted",
    resetsAt: reset,
    structured: false,
    model: "gemini-3.8-flash-high"
  });
  assert.equal(inferred.kind, "transient");
  // The retry deadline is the ladder's, not the provider's.
  assert.equal(inferred.cooldownUntil, NOW + inferred.durationMs);
  assert.ok(inferred.durationMs < 24 * 60_000);
  // The window the provider stated is retained for display.
  assert.equal(inferred.resetsAt, reset);
  assert.equal(cooldowns.get("antigravity", NOW + 1)?.resetsAt, reset);
});

test("typed cooldowns keep monotonic deadlines, last-resort policy, and retry summaries", () => {
  const cooldowns = new ProviderCooldowns(undefined, {
    isProviderEnabled: (provider, _role) => provider !== "disabled"
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
  assert.equal(
    cooldowns.nextRetryMs(
      [{ provider: "claude", model: "claude-opus-5-5" }],
      NOW + 1
    ),
    3_599_999
  );
  assert.deepEqual(
    cooldowns.summary(
      [
        { provider: "claude", model: "claude-opus-5-5" },
        { provider: "disabled", model: "disabled-model" }
      ],
      NOW + 1
    ),
    [
      {
        provider: "claude",
        model: "claude-opus-5-5",
        state: "hard",
        failureClass: "quota_exhausted",
        resetsAt: reset,
        retryAfterMs: 3_599_999,
        detail: null
      },
      {
        provider: "disabled",
        model: "disabled-model",
        state: "disabled",
        failureClass: "provider_disabled",
        resetsAt: null,
        retryAfterMs: 0,
        detail: null
      }
    ]
  );
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

test("Antigravity quota cooldowns isolate Gemini and shared Claude pool", () => {
  const cooldowns = new ProviderCooldowns();
  const claude = "claude-opus-5-5-high";
  const sonnet = "claude-sonnet-5-5-medium";
  const gemini = "gemini-3-pro";
  cooldowns.cooldownProvider("antigravity", {
    now: NOW,
    model: claude,
    failureClass: "quota_exhausted",
    structured: true,
    scope: "pool"
  });
  assert.equal(cooldowns.get("antigravity", NOW, claude)?.kind, "hard");
  assert.equal(cooldowns.get("antigravity", NOW, sonnet)?.kind, "hard");
  assert.equal(cooldowns.get("antigravity", NOW, gemini), null);
  assert.ok(
    cooldowns.nextRetryMs([{ provider: "antigravity", model: sonnet }], NOW) > 0
  );
  cooldowns.clearAfterSuccess("antigravity", gemini);
  assert.equal(cooldowns.get("antigravity", NOW, sonnet)?.kind, "hard");
  cooldowns.clearAfterSuccess("antigravity", sonnet);
  assert.equal(cooldowns.get("antigravity", NOW, sonnet), null);
});

test("Antigravity pool transient quota and success clearing are scoped", () => {
  const cooldowns = new ProviderCooldowns();
  const claude = "claude-opus-5-5-high";
  const sonnet = "claude-sonnet-5-5-medium";
  const gemini = "gemini-3-pro";
  const failure = cooldowns.cooldownProvider("antigravity", {
    now: NOW,
    model: claude,
    failureClass: "quota_exhausted",
    scope: "pool"
  });
  assert.equal(failure.kind, "transient");
  assert.equal(failure.durationMs, COOLDOWN_CONFIG.providerCooldownMs);
  assert.equal(cooldowns.get("antigravity", NOW, sonnet)?.kind, "transient");
  assert.equal(cooldowns.get("antigravity", NOW, gemini), null);
  const geminiFailure = cooldowns.cooldownProvider("antigravity", {
    now: NOW,
    model: gemini,
    failureClass: "quota_exhausted",
    scope: "pool"
  });
  assert.equal(geminiFailure.durationMs, COOLDOWN_CONFIG.providerCooldownMs);
  assert.equal(cooldowns.get("antigravity", NOW, gemini)?.kind, "transient");
  cooldowns.clearAfterSuccess("antigravity", gemini);
  assert.equal(cooldowns.get("antigravity", NOW, gemini), null);
  assert.equal(cooldowns.get("antigravity", NOW, claude)?.kind, "transient");
  cooldowns.clearAfterSuccess("antigravity", sonnet);
  assert.equal(cooldowns.get("antigravity", NOW, sonnet), null);
});

test("Antigravity pool hard limits persist with pool; provider limits stay global", () => {
  const source = new ProviderCooldowns();
  source.cooldownProvider("antigravity", {
    now: NOW,
    model: "claude-opus-5-5-high",
    failureClass: "quota_exhausted",
    structured: true,
    scope: "pool"
  });
  source.cooldownProvider("claude", {
    now: NOW,
    failureClass: "quota_exhausted",
    structured: true
  });
  const entries = source.persistedHardEntries();
  assert.equal(
    entries.find((entry) => entry.provider === "antigravity")?.pool,
    "third_party"
  );
  const restored = new ProviderCooldowns();
  restored.restoreHardEntries(entries, NOW);
  assert.equal(
    restored.get("antigravity", NOW + 1, "claude-sonnet-5-5-medium")?.kind,
    "hard"
  );
  assert.equal(restored.get("antigravity", NOW + 1, "gemini-3-pro"), null);
  assert.equal(
    restored.get("claude", NOW + 1, "claude-opus-5-5")?.kind,
    "hard"
  );
});

test("retry deadlines ignore non-retryable model configuration cooldowns", () => {
  const cooldowns = new ProviderCooldowns();
  cooldowns.cooldownProvider("claude", {
    now: NOW,
    failureClass: "invalid_model",
    model: "claude-opus-5-5"
  });
  assert.equal(
    cooldowns.nextRetryMs(
      [{ provider: "claude", model: "claude-opus-5-5" }],
      NOW
    ),
    0
  );
});
