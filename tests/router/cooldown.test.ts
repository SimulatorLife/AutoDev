import assert from "node:assert/strict";
import test from "node:test";

import {
  COOLDOWN_CONFIG,
  hardCooldownBlocksAttempt,
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

test("typed cooldown persistence restores only future hard entries and keeps their deadlines", () => {
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
  // The restored deadline is the one that was persisted, not a fresh window.
  assert.equal(
    restored.get("claude", NOW + 1)?.until,
    persisted.find((entry) => entry.provider === "claude")?.until
  );
});

test("a hard cooldown with a reset days out stays blocking past the hard ceiling", () => {
  // A weekly quota that resets in three days is a fact the provider reported,
  // not a router-chosen window: the route stays ineligible until that reset,
  // however far past the router's own hard ceiling the reset falls.
  const cooldowns = new ProviderCooldowns();
  const resetsAt = new Date(NOW + 3 * 86_400_000).toISOString();
  const hard = cooldowns.cooldownProvider("claude", {
    now: NOW,
    failureClass: "quota_exhausted",
    resetsAt,
    structured: true
  });
  assert.equal(hard.kind, "hard");
  assert.equal(hard.cooldownUntil, Date.parse(resetsAt));
  assert.ok(hard.durationMs > COOLDOWN_CONFIG.hardCooldownMaxMs);

  const sevenHoursLater = NOW + 7 * 3_600_000;
  const entry = cooldowns.get("claude", sevenHoursLater);
  assert.equal(entry?.kind, "hard");
  assert.equal(entry?.until, Date.parse(resetsAt));
  assert.equal(hardCooldownBlocksAttempt(entry, sevenHoursLater), true);
  assert.equal(cooldowns.allowsLastResort(entry, sevenHoursLater), false);
  assert.equal(
    cooldowns.nextRetryMs(
      [{ provider: "claude", model: "claude-opus-5-5" }],
      sevenHoursLater
    ),
    Date.parse(resetsAt) - sevenHoursLater
  );

  // The entry lapses when the reset arrives: the provider's own deadline
  // revalidates the route, and nothing else keeps it out.
  assert.equal(cooldowns.get("claude", Date.parse(resetsAt)), null);
});

test("a restored hard cooldown keeps the deadline it was persisted with", () => {
  const source = new ProviderCooldowns();
  const resetsAt = new Date(NOW + 3 * 86_400_000).toISOString();
  source.cooldownProvider("claude", {
    now: NOW,
    failureClass: "quota_exhausted",
    resetsAt,
    structured: true
  });
  const persisted = source.persistedHardEntries();

  // The router restarts seven hours later: the restored cooldown still ends
  // at the provider's reset instead of starting a fresh window.
  const restartedAt = NOW + 7 * 3_600_000;
  const restored = new ProviderCooldowns();
  restored.restoreHardEntries(persisted, restartedAt);
  const entry = restored.get("claude", restartedAt + 1);
  assert.equal(entry?.kind, "hard");
  assert.equal(entry?.until, Date.parse(resetsAt));
  assert.equal(entry?.resetsAt, resetsAt);
  assert.equal(entry?.since, NOW);
  assert.equal(hardCooldownBlocksAttempt(entry, restartedAt + 1), true);
  assert.equal(restored.allowsLastResort(entry, restartedAt + 1), false);
});

test("Antigravity model-family routes keep independent cooldown state", () => {
  const cooldowns = new ProviderCooldowns();
  cooldowns.cooldownProvider("antigravity-claude-gpt", {
    now: NOW,
    model: "claude-opus-5-5-high",
    failureClass: "quota_exhausted",
    structured: true
  });
  // A response on the Claude/GPT-OSS route cools that route...
  assert.equal(cooldowns.get("antigravity-claude-gpt", NOW)?.kind, "hard");
  assert.equal(
    cooldowns.get("antigravity-claude-gpt", NOW, "gpt-oss-120b-medium")?.kind,
    "hard"
  );
  // ...while the Gemini and Argon routes keep serving.
  assert.equal(cooldowns.get("antigravity-gemini", NOW), null);
  assert.equal(cooldowns.get("antigravity-argon", NOW), null);

  // A hard limit persists and restores against its own provider.
  const restored = new ProviderCooldowns();
  restored.restoreHardEntries(cooldowns.persistedHardEntries(), NOW);
  assert.equal(restored.get("antigravity-claude-gpt", NOW + 1)?.kind, "hard");
  assert.equal(restored.get("antigravity-gemini", NOW + 1), null);

  // A success on the provider clears it.
  cooldowns.clearAfterSuccess(
    "antigravity-claude-gpt",
    "claude-sonnet-5-5-medium"
  );
  assert.equal(cooldowns.get("antigravity-claude-gpt", NOW), null);
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

test("structured hard cooldown without resetsAt escalates exponentially and resets on success", () => {
  const cooldowns = new ProviderCooldowns();
  const first = cooldowns.cooldownProvider("claude", {
    now: NOW,
    failureClass: "quota_exhausted",
    structured: true
  });
  assert.equal(first.kind, "hard");
  assert.equal(first.streak, 1);
  assert.equal(first.durationMs, COOLDOWN_CONFIG.hardCooldownMs);

  const second = cooldowns.cooldownProvider("claude", {
    now: NOW + first.durationMs,
    failureClass: "quota_exhausted",
    structured: true
  });
  assert.equal(second.kind, "hard");
  assert.equal(second.streak, 2);
  assert.equal(second.durationMs, COOLDOWN_CONFIG.hardCooldownMs * 2);

  cooldowns.clearAfterSuccess("claude", "claude-opus-5-5");
  const afterSuccess = cooldowns.cooldownProvider("claude", {
    now: NOW + first.durationMs + 1000,
    failureClass: "quota_exhausted",
    structured: true
  });
  assert.equal(afterSuccess.streak, 1);
  assert.equal(afterSuccess.durationMs, COOLDOWN_CONFIG.hardCooldownMs);
});
