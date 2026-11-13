import assert from "node:assert/strict";
import test from "node:test";

import { COOLDOWNS } from "@simulatorlife/autodev-runtime/router/cooldown";

import {
  buildClaudeSubscriptionQuota,
  CLAUDE_CONFIGURED_MODELS,
  clearProviderQuotaCacheForTests,
  createProviderQuotaDiscoveryService,
  DEFAULT_QUOTA_PROVIDERS,
  mergeAntigravityQuotas,
  MINIMAX_CONFIGURED_MODELS,
  overlayRouterCooldownsOnQuota,
  parseAntigravityAvailableModelsQuota,
  parseAntigravityQuotaSummary,
  parseClaudeOAuthUsage,
  parseClaudeRateLimitEvent,
  parseCodexResponseRateLimitHeaders,
  parseCodexWhamUsage,
  parseCopilotUserQuota,
  parseMinimaxQuotaOutput,
  PROVIDER_QUOTA_REFRESH_INTERVAL_MS,
  readMinimaxAuth,
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

test("parseAntigravityAvailableModelsQuota splits one response into a quota per Antigravity provider", () => {
  const quotas = parseAntigravityAvailableModelsQuota(
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
        },
        "gpt-oss-120b-medium": {
          displayName: "GPT OSS 120B (Medium)",
          quotaInfo: {
            remainingFraction: 0.2,
            resetTime: "2026-11-09T14:00:00Z"
          }
        }
      }
    },
    NOW
  );
  assert.deepEqual(Object.keys(quotas).sort(), [
    "antigravity-argon",
    "antigravity-claude-gpt",
    "antigravity-gemini"
  ]);

  const gemini = quotas["antigravity-gemini"];
  assert.ok(gemini);
  assert.equal(gemini.provider, "antigravity-gemini");
  assert.equal(gemini.summaryStatus, "available");
  assert.deepEqual(
    gemini.windows.map((w) => [w.kind, w.usedPercent]),
    [["five_hour", 59]]
  );
  assert.ok(gemini.models?.some((m) => m.model === "gemini-3.8-flash-high"));
  assert.ok(gemini.models?.every((m) => !m.model.includes("argon")));

  // The tiered Flash quota names the Argon efforts too; they are Argon's own.
  const argon = quotas["antigravity-argon"];
  assert.ok(argon);
  assert.deepEqual(
    argon.models?.map((m) => m.model),
    ["gemini-4-argon-low", "gemini-4-argon-medium", "gemini-4-argon-high"]
  );

  // Claude and GPT-OSS share one quota with a 5-hour and a weekly window; the
  // provider is out while either is.
  const claudeGpt = quotas["antigravity-claude-gpt"];
  assert.ok(claudeGpt);
  assert.equal(claudeGpt.summaryStatus, "exhausted");
  assert.deepEqual(
    claudeGpt.windows.map((w) => [w.kind, w.status, w.usedPercent]),
    [
      ["five_hour", "available", 80],
      ["weekly", "exhausted", 100]
    ]
  );
  assert.equal(
    claudeGpt.windows.find((w) => w.kind === "weekly")?.resetsAt,
    "2026-11-11T18:06:00.000Z"
  );
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
        five_hour: { utilization: 0.4, resetsAt: nowSec + 3600 },
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

test("parseClaudeRateLimitEvent reports a window whose reset has passed as unreported, not 0%", () => {
  const nowSec = Math.floor(NOW / 1000);
  const quota = parseClaudeRateLimitEvent(
    {
      status: "allowed",
      rateLimitType: "seven_day",
      resetsAt: nowSec + 86_400,
      unifiedWindows: {
        five_hour: { utilization: 0.7, resetsAt: nowSec - 7200 },
        seven_day: { utilization: 0.38, resetsAt: nowSec + 86_400 }
      }
    },
    NOW
  );
  assert.ok(quota);
  assert.deepEqual(
    quota.windows.map((w) => [w.id, w.status, w.usedPercent, w.resetsAt]),
    [
      ["claude-5h", "unavailable", null, null],
      [
        "claude-weekly",
        "available",
        38,
        new Date((nowSec + 86_400) * 1000).toISOString()
      ]
    ]
  );
  assert.equal(quota.summaryStatus, "available");
});

test("parseClaudeRateLimitEvent yields no quota when every window has rolled over since the event", () => {
  const nowSec = Math.floor(NOW / 1000);
  const quota = parseClaudeRateLimitEvent(
    {
      status: "rejected",
      rateLimitType: "seven_day",
      resetsAt: nowSec - 60,
      unifiedWindows: {
        five_hour: { utilization: 0, resetsAt: nowSec - 7200 },
        seven_day: { utilization: 1, resetsAt: nowSec - 60 }
      }
    },
    NOW
  );
  assert.equal(quota, null);
});

test("an Antigravity model's own quota entry outranks the tiered Flash entry", () => {
  const quotas = parseAntigravityAvailableModelsQuota(
    {
      models: {
        "gemini-3.8-flash-tiered": {
          quotaInfo: { resetTime: "2026-11-11T18:06:00Z" }
        },
        "gemini-4-argon-high": {
          displayName: "Gemini 4 Argon (High)",
          quotaInfo: {
            remainingFraction: 0.9,
            resetTime: "2026-11-09T14:00:00Z"
          }
        }
      }
    },
    NOW
  );
  // Argon High reports its own quota, which is not the exhausted Flash one.
  assert.equal(
    quotas["antigravity-argon"]?.models?.find(
      (m) => m.model === "gemini-4-argon-high"
    )?.usedPercent,
    10
  );
  assert.equal(quotas["antigravity-gemini"]?.summaryStatus, "exhausted");
});

test("the Antigravity quota summary gives each provider its 5-hour and weekly limits", () => {
  // The shape `v1internal:retrieveUserQuotaSummary` returns: one group per
  // metered model family, each with a 5-hour and a weekly bucket.
  const summary = parseAntigravityQuotaSummary(
    {
      groups: [
        {
          displayName: "Claude and GPT models",
          description:
            "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              bucketId: "3p-weekly",
              window: "weekly",
              resetTime: "2026-11-15T18:06:00Z",
              remainingFraction: 0.486_058_8
            },
            {
              bucketId: "3p-5h",
              window: "5h",
              resetTime: "2026-11-09T15:31:44Z",
              remainingFraction: 0.9884
            }
          ]
        },
        {
          displayName: "Gemini models",
          buckets: [
            // proto3 JSON omits a zero remaining fraction.
            { window: "5h", resetTime: "2026-11-09T13:00:00Z" },
            {
              window: "weekly",
              resetTime: "2026-11-08T00:00:00Z",
              remainingFraction: 0
            }
          ]
        },
        {
          displayName: "Gemini Argon",
          buckets: [{ window: "5h", remainingFraction: 1, disabled: true }]
        }
      ]
    },
    NOW
  );
  assert.deepEqual(
    summary["antigravity-claude-gpt"]?.map((w) => [
      w.id,
      w.kind,
      w.label,
      w.usedPercent,
      w.resetsAt
    ]),
    [
      [
        "antigravity-claude-gpt-five_hour",
        "five_hour",
        "5-hour limit",
        1.2,
        "2026-11-09T15:31:44.000Z"
      ],
      [
        "antigravity-claude-gpt-weekly",
        "weekly",
        "Weekly limit",
        51.4,
        "2026-11-15T18:06:00.000Z"
      ]
    ]
  );
  // An omitted fraction is a spent window; a weekly reset already past is a
  // fresh one.
  assert.deepEqual(
    summary["antigravity-gemini"]?.map((w) => [w.kind, w.usedPercent]),
    [
      ["five_hour", 100],
      ["weekly", 0]
    ]
  );
  // A disabled bucket states no limit.
  assert.equal(summary["antigravity-argon"], undefined);

  const merged = mergeAntigravityQuotas(
    parseAntigravityAvailableModelsQuota(
      {
        models: {
          "claude-opus-5-5-high": {
            quotaInfo: {
              remainingFraction: 0.486_058_8,
              resetTime: "2026-11-15T18:06:00Z"
            }
          },
          "gemini-4-argon-high": {
            quotaInfo: {
              remainingFraction: 0.5,
              resetTime: "2026-11-09T14:00:00Z"
            }
          }
        }
      },
      NOW
    ),
    summary,
    NOW
  );
  // The provider keeps its models and takes both windows from the summary.
  assert.deepEqual(
    merged["antigravity-claude-gpt"]?.windows.map((w) => w.kind),
    ["five_hour", "weekly"]
  );
  assert.equal(merged["antigravity-claude-gpt"]?.summaryStatus, "available");
  assert.ok(
    merged["antigravity-claude-gpt"]?.models?.some(
      (m) => m.model === "claude-opus-5-5-high"
    )
  );
  // A group the summary names with no models listed still gets its windows.
  assert.equal(merged["antigravity-gemini"]?.summaryStatus, "exhausted");
  // A provider the summary does not name keeps the window its models imply,
  // and states the limit nothing reported as not observed rather than
  // dropping it.
  assert.deepEqual(
    merged["antigravity-argon"]?.windows.map((w) => [
      w.kind,
      w.status,
      w.usedPercent
    ]),
    [
      ["five_hour", "available", 50],
      ["weekly", "unavailable", null]
    ]
  );
  assert.equal(merged["antigravity-argon"]?.summaryStatus, "available");
});

test("syncQuotaToCooldowns cools only the exhausted Antigravity provider", () => {
  COOLDOWNS.clearAll();
  clearProviderQuotaCacheForTests();
  try {
    const quotas = parseAntigravityAvailableModelsQuota(
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
    );
    for (const quota of Object.values(quotas)) syncQuotaToCooldowns(quota, NOW);

    assert.equal(
      COOLDOWNS.get("antigravity-gemini", NOW),
      null,
      "Gemini keeps serving while the Claude/GPT-OSS quota is spent"
    );
    const claudeCooldown = COOLDOWNS.get("antigravity-claude-gpt", NOW);
    assert.ok(claudeCooldown, "Claude/GPT-OSS is cooled down until reset");
    assert.equal(claudeCooldown.failureClass, "quota_exhausted");
    assert.equal(claudeCooldown.resetsAt, "2026-11-11T18:06:00.000Z");

    const overlaid = overlayRouterCooldownsOnQuota(
      "antigravity-claude-gpt",
      quotas["antigravity-claude-gpt"]!,
      NOW
    );
    assert.equal(overlaid?.summaryStatus, "exhausted");
  } finally {
    COOLDOWNS.clearAll();
    clearProviderQuotaCacheForTests();
  }
});

test("createProviderQuotaDiscoveryService manages lifecycle and snapshots", async () => {
  assert.equal(PROVIDER_QUOTA_REFRESH_INTERVAL_MS, 60_000);
  assert.deepEqual(DEFAULT_QUOTA_PROVIDERS, [
    "antigravity-gemini",
    "antigravity-argon",
    "antigravity-claude-gpt",
    "codex",
    "minimax",
    "copilot",
    "claude"
  ]);

  const customNow = 1_000_000;
  const service = createProviderQuotaDiscoveryService({
    providers: ["antigravity-gemini"],
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
  assert.ok("antigravity-gemini" in snapAfter);

  service.stop();
  // Double-stop is safe
  service.stop();
});

test("parseMinimaxQuotaOutput handles direct REST API JSON payload and matches models", () => {
  const payload = {
    model_remains: [
      {
        model_name: "general",
        start_time: 1_794_254_400_000,
        end_time: 1_794_268_800_000,
        remains_time: 10_507_443,
        current_interval_total_count: 0,
        current_interval_usage_count: 0,
        current_interval_status: 1,
        current_interval_remaining_percent: 100,
        weekly_start_time: 1_794_182_400_000,
        weekly_end_time: 1_794_787_200_000,
        weekly_remains_time: 528_907_443,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 60
      },
      {
        model_name: "video",
        start_time: 1_794_182_400_000,
        end_time: 1_794_268_800_000,
        remains_time: 10_507_443,
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

test("buildClaudeSubscriptionQuota names the plan but reports no usage", async () => {
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
  assert.equal(quota.summaryStatus, "unavailable");
  assert.deepEqual(
    quota.windows.map((w) => [w.kind, w.status, w.usedPercent]),
    [
      ["five_hour", "unavailable", null],
      ["weekly", "unavailable", null]
    ]
  );

  assert.equal(quota.models?.length, CLAUDE_CONFIGURED_MODELS.length);
  for (const m of quota.models!) {
    assert.equal(m.status, "unavailable");
    assert.equal(m.usedPercent, null);
    assert.equal(m.windows.length, 2);
  }
});
