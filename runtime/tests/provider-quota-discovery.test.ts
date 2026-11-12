import assert from "node:assert/strict";
import test from "node:test";

import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";

import {
  buildClaudeSubscriptionQuota,
  CLAUDE_CONFIGURED_MODELS,
  clearProviderQuotaCacheForTests,
  createProviderQuotaDiscoveryService,
  DEFAULT_QUOTA_PROVIDERS,
  MINIMAX_CONFIGURED_MODELS,
  overlayRouterCooldownsOnQuota,
  parseAntigravityAvailableModelsQuota,
  parseClaudeOAuthUsage,
  parseClaudeRateLimitEvent,
  parseCodexResponseRateLimitHeaders,
  parseCodexWhamUsage,
  parseCopilotUserQuota,
  parseMinimaxQuotaOutput,
  PROVIDER_QUOTA_REFRESH_INTERVAL_MS,
  readClaudePlanMetadata,
  readMinimaxAuth,
  readPersistedClaudeRateLimit,
  syncQuotaToCooldowns
} from "../src/providers/quota-discovery.ts";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");

test("parseMinimaxQuotaOutput parses 5h and weekly windows from mmx quota --output json", () => {
  const raw = `Coding Plan Quota (https://platform.minimax.io/user-center/payment/coding-plan)
{
  "model_remains": [
    {
      "model_name": "general",
      "start_time": 1794218400000,
      "end_time": 1794236400000,
      "remains_time": 11524143,
      "current_interval_remaining_percent": 65,
      "weekly_start_time": 1794200400000,
      "weekly_end_time": 1794805200000,
      "weekly_remains_time": 580324143,
      "current_weekly_remaining_percent": 82
    }
  ],
  "base_resp": {
    "status_code": 0,
    "status_msg": "success"
  }
}`;
  const quota = parseMinimaxQuotaOutput(raw, NOW);
  assert.ok(quota);
  assert.equal(quota.provider, "minimax");
  assert.equal(quota.status, "ok");
  assert.equal(quota.summaryStatus, "available");
  assert.equal(quota.windows.length, 2);
  assert.equal(quota.windows[0]?.kind, "five_hour");
  assert.equal(quota.windows[0]?.usedPercent, 35);
  assert.equal(quota.windows[0]?.remainingPercent, 65);
  assert.equal(
    quota.windows[0]?.resetsAt,
    new Date(1_794_236_400_000).toISOString()
  );
  assert.equal(quota.windows[1]?.kind, "weekly");
  assert.equal(quota.windows[1]?.usedPercent, 18);
  assert.equal(quota.windows[1]?.remainingPercent, 82);
  assert.equal(
    quota.windows[1]?.resetsAt,
    new Date(1_794_805_200_000).toISOString()
  );
  assert.equal(quota.models?.length, 3);
  assert.equal(quota.models?.[0]?.model, "MiniMax-M3");
  assert.equal(quota.models?.[0]?.usedPercent, 35);
  assert.equal(quota.models?.[1]?.model, "MiniMax-M3.1-Flash-Preview");
  assert.equal(quota.models?.[2]?.model, "MiniMax-M2.7");
  assert.equal(quota.models?.[2]?.usedPercent, 35);
});

test("parseCodexWhamUsage and parseCodexResponseRateLimitHeaders parse 5h and weekly limits", () => {
  const wham = parseCodexWhamUsage(
    {
      plan_type: "pro",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 24,
          limit_window_seconds: 18_000,
          reset_at: 1_794_236_324
        },
        secondary_window: {
          used_percent: 41,
          limit_window_seconds: 604_800,
          reset_at: 1_794_718_944
        }
      }
    },
    NOW
  );
  assert.ok(wham);
  assert.equal(wham.provider, "codex");
  assert.equal(wham.plan, "pro");
  assert.equal(wham.summaryStatus, "available");
  assert.equal(wham.windows.length, 2);
  assert.equal(wham.windows[0]?.kind, "five_hour");
  assert.equal(wham.windows[0]?.usedPercent, 24);
  assert.equal(wham.windows[0]?.remainingPercent, 76);
  assert.equal(wham.windows[1]?.kind, "weekly");
  assert.equal(wham.windows[1]?.usedPercent, 41);
  assert.equal(wham.windows[1]?.remainingPercent, 59);

  const fromHeaders = parseCodexResponseRateLimitHeaders(
    new Headers({
      "x-codex-primary-used-percent": "88",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1794236324",
      "x-codex-secondary-used-percent": "52",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1794718944",
      "x-codex-plan-type": "pro"
    }),
    NOW
  );
  assert.ok(fromHeaders);
  assert.equal(fromHeaders.summaryStatus, "warning");
  assert.equal(fromHeaders.windows[0]?.usedPercent, 88);
  assert.equal(fromHeaders.windows[1]?.usedPercent, 52);
});

test("parseAntigravityAvailableModelsQuota separates first_party Gemini and third_party Claude pools", () => {
  const quota = parseAntigravityAvailableModelsQuota(
    {
      models: {
        "gemini-3.8-flash-tiered": {
          displayName: "Gemini 3.8 Flash",
          quotaInfo: {
            remainingFraction: 0.41,
            resetTime: "2026-11-09T15:32:07Z"
          }
        },
        "claude-opus-5-5-high": {
          displayName: "Claude Opus 5.5 (High)",
          quotaInfo: {
            resetTime: "2026-11-11T18:06:00Z"
          }
        },
        "claude-sonnet-5-5-medium": {
          displayName: "Claude Sonnet 5.5 (Medium)",
          quotaInfo: {
            resetTime: "2026-11-11T18:06:00Z"
          }
        }
      }
    },
    NOW
  );
  assert.ok(quota);
  assert.equal(quota.provider, "antigravity");
  assert.equal(quota.summaryStatus, "available");
  assert.equal(quota.pools?.length, 2);

  const geminiPool = quota.pools?.find((pool) => pool.pool === "first_party");
  const claudePool = quota.pools?.find((pool) => pool.pool === "third_party");
  assert.ok(geminiPool);
  assert.ok(claudePool);
  assert.equal(geminiPool.status, "available");
  assert.equal(geminiPool.usedPercent, 59);
  assert.equal(geminiPool.remainingPercent, 41);
  assert.ok(geminiPool.models.includes("gemini-3.8-flash-high"));

  assert.equal(claudePool.status, "exhausted");
  assert.equal(claudePool.usedPercent, 100);
  assert.equal(claudePool.remainingPercent, 0);
  assert.equal(claudePool.resetsAt, "2026-11-11T18:06:00.000Z");
});

test("parseCopilotUserQuota and Claude parsers build structured quota snapshots", () => {
  const copilot = parseCopilotUserQuota(
    {
      copilot_plan: "individual",
      quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
      quota_snapshots: {
        premium_interactions: {
          entitlement: 300,
          remaining: 240,
          percent_remaining: 80,
          unlimited: false
        },
        chat: {
          unlimited: true
        }
      }
    },
    NOW
  );
  assert.ok(copilot);
  assert.equal(copilot.provider, "copilot");
  assert.equal(copilot.plan, "individual");
  assert.equal(copilot.windows[0]?.usedPercent, 20);
  assert.equal(copilot.windows[0]?.used, 60);
  assert.equal(copilot.windows[0]?.limit, 300);
  assert.equal(copilot.windows[1]?.status, "unlimited");

  const claudeOAuth = parseClaudeOAuthUsage(
    {
      five_hour: {
        utilization: 45,
        resets_at: "2026-11-09T16:00:00Z"
      },
      seven_day: {
        utilization: 72,
        resets_at: "2026-11-14T00:00:00Z"
      }
    },
    NOW
  );
  assert.ok(claudeOAuth);
  assert.equal(claudeOAuth.windows.length, 2);
  assert.equal(claudeOAuth.windows[0]?.usedPercent, 45);
  assert.equal(claudeOAuth.windows[1]?.usedPercent, 72);

  const claudeEvent = parseClaudeRateLimitEvent(
    {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.85,
      resetsAt: 1_794_240_000
    },
    NOW
  );
  assert.ok(claudeEvent);
  assert.equal(claudeEvent.summaryStatus, "warning");
  assert.equal(claudeEvent.windows[0]?.usedPercent, 85);
});

test("parseClaudeRateLimitEvent reports the 5-hour window alongside the weekly window the event names", () => {
  const nowSec = Math.floor(NOW / 1000);
  const quota = parseClaudeRateLimitEvent(
    {
      status: "allowed_warning",
      rateLimitType: "seven_day",
      resetsAt: nowSec + 86_400,
      unifiedWindows: {
        five_hour: { utilization: 0.4, resetsAt: nowSec + 3_600 },
        seven_day: { utilization: 0.9, resetsAt: nowSec + 86_400 }
      }
    },
    NOW
  );
  assert.ok(quota);
  assert.deepEqual(
    quota.windows.map((w) => [w.id, w.kind, w.status, w.usedPercent]),
    [
      ["claude-5h", "five_hour", "available", 40],
      ["claude-weekly", "weekly", "warning", 90]
    ]
  );
  assert.equal(quota.summaryStatus, "warning");
  assert.equal(quota.models?.[0]?.windows.length, 2);
});

test("parseClaudeRateLimitEvent rolls over windows whose reset time has passed", () => {
  const nowSec = Math.floor(NOW / 1000);
  const quota = parseClaudeRateLimitEvent(
    {
      status: "rejected",
      rateLimitType: "seven_day",
      resetsAt: nowSec - 60,
      unifiedWindows: {
        five_hour: { utilization: 0.7, resetsAt: nowSec - 7_200 },
        seven_day: { utilization: 1, resetsAt: nowSec - 60 }
      }
    },
    NOW
  );
  assert.ok(quota);
  assert.deepEqual(
    quota.windows.map((w) => [w.id, w.status, w.usedPercent, w.resetsAt]),
    [
      ["claude-5h", "available", 0, null],
      ["claude-weekly", "available", 0, null]
    ]
  );
  assert.equal(quota.summaryStatus, "available");
});

test("syncQuotaToCooldowns cools only exhausted subprovider pools and leaves healthy pools uncooled", () => {
  COOLDOWNS.clearAll();
  clearProviderQuotaCacheForTests();
  try {
    const quota = parseAntigravityAvailableModelsQuota(
      {
        models: {
          "gemini-3.8-flash-tiered": {
            displayName: "Gemini 3.8 Flash",
            quotaInfo: {
              remainingFraction: 0.5,
              resetTime: "2026-11-09T16:00:00Z"
            }
          },
          "claude-opus-5-5-high": {
            displayName: "Claude Opus 5.5 (High)",
            quotaInfo: {
              resetTime: "2026-11-11T18:06:00Z"
            }
          }
        }
      },
      NOW
    )!;
    syncQuotaToCooldowns(quota, NOW);

    assert.equal(
      COOLDOWNS.get("antigravity", NOW),
      null,
      "provider-wide Antigravity cooldown must remain null while first_party Gemini has remaining quota"
    );
    assert.equal(
      COOLDOWNS.get("antigravity", NOW, "gemini-3.8-flash-high"),
      null,
      "Gemini models in first_party pool must remain available"
    );
    const claudeCooldown = COOLDOWNS.get(
      "antigravity",
      NOW,
      "claude-opus-5-5-high"
    );
    assert.ok(claudeCooldown, "Claude pool must be cooled down until reset");
    assert.equal(claudeCooldown.pool, "third_party");

    const overlaid = overlayRouterCooldownsOnQuota("antigravity", quota, NOW);
    assert.ok(overlaid);
    const thirdParty = overlaid.pools?.find((p) => p.pool === "third_party");
    assert.equal(thirdParty?.status, "exhausted");
    assert.ok(thirdParty?.cooldown);
    assert.equal(thirdParty?.cooldown.scope, "pool");
    assert.equal(thirdParty?.cooldown.pool, "third_party");
  } finally {
    COOLDOWNS.clearAll();
    clearProviderQuotaCacheForTests();
  }
});

test("createProviderQuotaDiscoveryService manages lifecycle and snapshots", async () => {
  assert.equal(PROVIDER_QUOTA_REFRESH_INTERVAL_MS, 60_000);
  assert.deepEqual(DEFAULT_QUOTA_PROVIDERS, [
    "antigravity",
    "codex",
    "minimax",
    "copilot",
    "claude"
  ]);

  const customNow = 1_000_000;
  const service = createProviderQuotaDiscoveryService({
    providers: ["antigravity"],
    intervalMs: 500,
    now: () => customNow
  });

  const snapInitial = service.snapshot();
  assert.equal(typeof snapInitial, "object");

  service.start();
  // Double-start is safe
  service.start();

  await service.refresh();
  const snapAfter = service.snapshot();
  assert.ok("antigravity" in snapAfter);

  service.stop();
  // Double-stop is safe
  service.stop();
});

test("parseMinimaxQuotaOutput handles direct REST API JSON payload and matches models", () => {
  const payload = {
    model_remains: [
      {
        model_name: "general",
        start_time: 1794254400000,
        end_time: 1794268800000,
        remains_time: 10507443,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_status: 1,
        current_interval_remaining_percent: 100,
        weekly_start_time: 1794182400000,
        weekly_end_time: 1794787200000,
        weekly_remains_time: 528907443,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 60
      },
      {
        model_name: "video",
        start_time: 1794182400000,
        end_time: 1794268800000,
        remains_time: 10507443,
        current_interval_remaining_percent: 100,
        current_weekly_remaining_percent: 100
      }
    ],
    base_resp: {
      status_code: 0,
      status_msg: "success"
    }
  };

  const quota = parseMinimaxQuotaOutput(payload, NOW, "minimax-token-plan-api");
  assert.ok(quota);
  assert.equal(quota.provider, "minimax");
  assert.equal(quota.status, "ok");
  assert.equal(quota.source, "minimax-token-plan-api");
  assert.equal(quota.summaryStatus, "available");
  assert.equal(quota.windows.length, 2);
  assert.equal(quota.windows[0]?.kind, "five_hour");
  assert.equal(quota.windows[0]?.usedPercent, 0);
  assert.equal(quota.windows[0]?.remainingPercent, 100);
  assert.equal(quota.windows[1]?.kind, "weekly");
  assert.equal(quota.windows[1]?.usedPercent, 40);
  assert.equal(quota.windows[1]?.remainingPercent, 60);

  assert.equal(quota.models?.length, MINIMAX_CONFIGURED_MODELS.length);
  for (const m of quota.models!) {
    assert.equal(m.status, "available");
    assert.equal(m.usedPercent, 0);
    assert.equal(m.remainingPercent, 100);
    assert.equal(m.windows.length, 2);
  }
});

test("readMinimaxAuth prioritizes environment variable over config.json", async () => {
  const authFromEnv = await readMinimaxAuth({
    MINIMAX_API_KEY: "test-api-key-12345"
  });
  assert.ok(authFromEnv);
  assert.equal(authFromEnv.token, "test-api-key-12345");
  assert.equal(authFromEnv.baseUrl, "https://api.minimax.io");
});

test("readClaudePlanMetadata and buildClaudeSubscriptionQuota generate canonical Pro quota", async () => {
  const planMeta = {
    plan: "Claude Pro Plan",
    billingType: "stripe_subscription",
    rateLimitTier: "default_claude_ai",
    displayName: "Developer"
  };

  const quota = buildClaudeSubscriptionQuota(planMeta, NOW);
  assert.ok(quota);
  assert.equal(quota.provider, "claude");
  assert.equal(quota.status, "ok");
  assert.equal(quota.source, "claude-plan-subscription");
  assert.equal(quota.plan, "Claude Pro Plan");
  assert.equal(quota.summaryStatus, "available");
  assert.equal(quota.windows.length, 2);
  assert.equal(quota.windows[0]?.kind, "five_hour");
  assert.equal(quota.windows[0]?.status, "available");
  assert.equal(quota.windows[1]?.kind, "weekly");
  assert.equal(quota.windows[1]?.status, "available");

  assert.equal(quota.models?.length, CLAUDE_CONFIGURED_MODELS.length);
  for (const m of quota.models!) {
    assert.equal(m.status, "available");
    assert.equal(m.windows.length, 2);
  }
});
