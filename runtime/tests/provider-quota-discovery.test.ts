import assert from "node:assert/strict";
import test from "node:test";

import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";

import {
  clearProviderQuotaCacheForTests,
  overlayRouterCooldownsOnQuota,
  parseAntigravityAvailableModelsQuota,
  parseClaudeOAuthUsage,
  parseClaudeRateLimitEvent,
  parseCodexResponseRateLimitHeaders,
  parseCodexWhamUsage,
  parseCopilotUserQuota,
  parseMinimaxQuotaOutput,
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
    new Date(1794236400000).toISOString()
  );
  assert.equal(quota.windows[1]?.kind, "weekly");
  assert.equal(quota.windows[1]?.usedPercent, 18);
  assert.equal(quota.windows[1]?.remainingPercent, 82);
  assert.equal(
    quota.windows[1]?.resetsAt,
    new Date(1794805200000).toISOString()
  );
  assert.equal(quota.models?.[0]?.model, "MiniMax-M2.7");
  assert.equal(quota.models?.[0]?.usedPercent, 35);
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
          reset_at: 1794236324
        },
        secondary_window: {
          used_percent: 41,
          limit_window_seconds: 604_800,
          reset_at: 1794718944
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
      resetsAt: 1794240000
    },
    NOW
  );
  assert.ok(claudeEvent);
  assert.equal(claudeEvent.summaryStatus, "warning");
  assert.equal(claudeEvent.windows[0]?.usedPercent, 85);
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
