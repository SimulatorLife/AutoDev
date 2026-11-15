import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiProviderRecord,
  ControlApiProvidersResponse
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ProviderModelDiscoveryState } from "../src/features/providers/provider-model-discovery.ts";
import { exhaustedQuotaByProvider } from "../src/features/providers/ProviderQuota.ts";
import { ProvidersView } from "../src/features/providers/ProvidersView.ts";
import { fetchProviders } from "../src/lib/server/control-api.ts";

const emptyDiscovery: ProviderModelDiscoveryState = {
  status: "unavailable",
  message: "No provider model discovery was observed."
};

const ANTIGRAVITY_ROW_IDS = [
  "antigravity-gemini",
  "antigravity-argon",
  "antigravity-claude-gpt"
] as const;

type QuotaAxiProvider = NonNullable<
  ControlApiProvidersResponse["quotaAxi"]
>["providers"][number];

const NO_CONVERGENCE = {
  convergence: "not-observed" as const,
  desiredGeneration: null,
  observedGeneration: null,
  lastApplyAt: null,
  lastObservationAt: null,
  lastError: null,
  explanation: "Not observed."
};

function providerRecord(id: string): ControlApiProviderRecord {
  const role = {
    priority: "disabled" as const,
    model: null,
    mutable: false,
    convergence: NO_CONVERGENCE
  };
  return {
    id,
    links: { usage: null, documentation: null },
    route: null,
    credential: { envKey: null, configured: false },
    disabled: false,
    roles: { orchestrator: role, subagent: role },
    agentLimits: null,
    agentModels: [],
    models: [],
    priorities: [],
    orchestratorReasoningEffort: null,
    health: null,
    reconciliation: { status: NO_CONVERGENCE, history: [] }
  } as unknown as ControlApiProviderRecord;
}

function healthyProviderRecord(id: string): ControlApiProviderRecord {
  return {
    ...providerRecord(id),
    route: { pattern: ".*", baseUrl: "https://example.test", healthUrl: null },
    credential: { envKey: null, configured: true },
    health: {
      cooldown: null,
      failureStreak: 0,
      probeFailureStreak: 0,
      lastCheck: null,
      inFlightRequests: 0,
      activeAgents: 0,
      attempts: 1,
      successes: 1,
      failures: 0,
      lastSuccessAt: new Date().toISOString(),
      lastFailure: null
    }
  } as unknown as ControlApiProviderRecord;
}

function exhaustedQuotaProvider(
  overrides: Partial<QuotaAxiProvider> = {}
): QuotaAxiProvider {
  return {
    provider: "claude",
    windows: [
      {
        id: "five_hour",
        label: "5-hour",
        kind: "session",
        percentRemaining: 0
      }
    ],
    state: { status: "fresh", stale: false },
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          boundedBy: ["five_hour"],
          limitingWindowIds: ["five_hour"],
          runway: {
            status: "exhausted_now",
            usableRunwaySeconds: 0,
            limitingWindowId: "five_hour"
          }
        }
      ]
    },
    ...overrides
  };
}

function quotaReport(
  providers: readonly QuotaAxiProvider[],
  generatedAt = new Date().toISOString()
): NonNullable<ControlApiProvidersResponse["quotaAxi"]> {
  return { generatedAt, schemaVersion: 5, providers: [...providers] };
}

function renderProvidersView(
  quotaAxi: NonNullable<ControlApiProvidersResponse["quotaAxi"]> | null,
  providerIds: readonly string[] = [...ANTIGRAVITY_ROW_IDS, "codex"],
  providerRecords: readonly ControlApiProviderRecord[] = providerIds.map(
    providerRecord
  )
): string {
  const response = {
    schema: "autodev-control-providers-v5",
    orchestratorTier: "orchestrator",
    tiers: [],
    providers: providerRecords,
    quotaAxi
  } as unknown as ControlApiProvidersResponse;
  return renderToStaticMarkup(
    React.createElement(ProvidersView, {
      providers: response,
      models: { status: "unavailable", message: "Not observed" },
      modelDiscovery: emptyDiscovery
    })
  );
}

test("a fresh, known exhausted quota scope gives a healthy provider a yellow non-ready status", () => {
  const markup = renderProvidersView(
    quotaReport([exhaustedQuotaProvider()]),
    ["claude"],
    [healthyProviderRecord("claude")]
  );
  const row = rowFor(markup, "claude");

  assert.match(row, /data-status="unavailable"/u);
  assert.match(row, />Quota exhausted</u);
  assert.match(row, /bg-warning/u);
  assert.match(
    row,
    /title="Quota exhausted — Quota scope all_models is exhausted \(limiting window: five_hour\)\. This scoped report does not change Runtime health or routing\."/u
  );
  assert.doesNotMatch(row, />Ready</u);
  assert.match(
    markup,
    /data-stat-grid="4">[\s\S]*?<dt[^>]*>Ready<\/dt>[\s\S]*?<span[^>]*>0<\/span>/u
  );
});

test("quota status ignores raw percentages, stale or unknown scopes, and unrecognized limiters", () => {
  const unknownScope = exhaustedQuotaProvider({
    quotaSemantics: {
      status: "unknown",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "unknown",
          boundedBy: ["five_hour"],
          runway: {
            status: "exhausted_now",
            limitingWindowId: "five_hour"
          }
        }
      ]
    }
  });
  const conflict = exhaustedQuotaProvider({
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          boundedBy: ["five_hour"],
          boundConflict: {
            exhaustedWindowIds: ["five_hour"],
            liveWindowIds: ["other"]
          },
          runway: {
            status: "exhausted_now",
            limitingWindowId: "five_hour"
          }
        }
      ]
    }
  });
  const mismatchedLimiter = exhaustedQuotaProvider({
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          boundedBy: [],
          runway: {
            status: "exhausted_now",
            limitingWindowId: "five_hour"
          }
        }
      ]
    }
  });
  const stale = exhaustedQuotaProvider({
    state: { status: "stale", stale: true }
  });
  const unknownLimiter = exhaustedQuotaProvider({
    quotaSemantics: {
      status: "known",
      effectiveAvailability: [
        {
          scope: "all_models",
          status: "known",
          boundedBy: ["not_reported"],
          runway: {
            status: "exhausted_now",
            limitingWindowId: "not_reported"
          }
        }
      ]
    }
  });

  for (const entry of [
    stale,
    unknownScope,
    conflict,
    mismatchedLimiter,
    unknownLimiter
  ]) {
    assert.equal(
      exhaustedQuotaByProvider(quotaReport([entry])).has("claude"),
      false
    );
  }
  assert.equal(
    exhaustedQuotaByProvider(quotaReport([exhaustedQuotaProvider()], "bad"))
      .size,
    0
  );
  // A raw zero percentage is not an exhaustion verdict without known runway.
  assert.equal(
    exhaustedQuotaByProvider(
      quotaReport([
        exhaustedQuotaProvider({
          quotaSemantics: { status: "unknown", effectiveAvailability: [] }
        })
      ])
    ).size,
    0
  );
});

test("an exhausted agy quota scope changes only the route named by its known limiting window", () => {
  const markup = renderProvidersView(
    quotaReport([
      {
        provider: "agy",
        windows: [
          { id: "gemini_weekly", label: "Gemini weekly", kind: "weekly" },
          { id: "claude_gpt_5h", label: "Claude/GPT 5-hour", kind: "session" },
          { id: "unclassified", label: "Unclassified", kind: "unknown" }
        ],
        state: { status: "fresh", stale: false },
        quotaSemantics: {
          status: "partial",
          effectiveAvailability: [
            {
              scope: "gemini",
              status: "known",
              boundedBy: ["gemini_weekly"],
              runway: {
                status: "exhausted_now",
                limitingWindowId: "gemini_weekly"
              }
            },
            {
              scope: "claude_gpt",
              status: "known",
              boundedBy: ["claude_gpt_5h"],
              runway: {
                status: "exhausted_now",
                limitingWindowId: "claude_gpt_5h"
              }
            },
            {
              scope: "unknown_scope",
              status: "known",
              boundedBy: ["unclassified"],
              runway: {
                status: "exhausted_now",
                limitingWindowId: "unclassified"
              }
            }
          ]
        }
      }
    ]),
    [...ANTIGRAVITY_ROW_IDS],
    ANTIGRAVITY_ROW_IDS.map(healthyProviderRecord)
  );

  assert.match(
    rowFor(markup, "antigravity-gemini"),
    /data-status="unavailable"/u
  );
  assert.match(
    rowFor(markup, "antigravity-claude-gpt"),
    /data-status="unavailable"/u
  );
  assert.match(rowFor(markup, "antigravity-argon"), /data-status="ready"/u);
  assert.doesNotMatch(rowFor(markup, "antigravity-argon"), /Quota exhausted/u);
});

/** The table row whose provider-id link is `id`. */
function rowFor(markup: string, id: string): string {
  const rows = markup.match(/<tr[\s\S]*?<\/tr>/gu) ?? [];
  const row = rows.find((candidate) => candidate.includes(`>${id}<`));
  assert.ok(row, `no row for provider ${id}`);
  return row;
}

function quotaBlockFor(row: string, id: string): string {
  const marker = `data-provider-quota="${id}"`;
  const start = row.indexOf(marker);
  assert.notEqual(start, -1, `no quota block for ${id}`);
  const cellEnd = row.indexOf("</td>", start);
  assert.notEqual(cellEnd, -1, `unterminated quota cell for ${id}`);
  return row.slice(start, cellEnd);
}

function progressBarsIn(markup: string): string[] {
  return markup.match(/role="progressbar"[\s\S]*?<\/div><\/div>/gu) ?? [];
}

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

test("provider rows show compact remaining usage bars and refresh times across windows", () => {
  const markup = renderProvidersView(
    {
      generatedAt: new Date().toISOString(),
      schemaVersion: 5,
      providers: [
        {
          provider: "claude",
          windows: [
            {
              id: "five_hour",
              label: "5-hour",
              kind: "session",
              percentRemaining: 72,
              resetsAt: futureIso(2 * 60 * 60 * 1000)
            },
            {
              id: "seven_day",
              label: "7-day",
              kind: "weekly",
              percentRemaining: 41,
              resetsAt: futureIso(2 * 24 * 60 * 60 * 1000)
            }
          ],
          state: { status: "fresh", stale: false }
        },
        {
          provider: "codex",
          windows: [
            {
              id: "weekly",
              label: "week",
              kind: "weekly",
              percentUsed: 25,
              resetText: "Resets tomorrow"
            }
          ],
          state: { status: "fresh", stale: false }
        },
        {
          provider: "cursor",
          windows: [],
          state: { status: "fresh", stale: false }
        }
      ]
    },
    ["claude", "codex", "cursor"]
  );

  const claudeQuota = quotaBlockFor(rowFor(markup, "claude"), "claude");
  assert.equal(progressBarsIn(claudeQuota).length, 2);
  assert.match(claudeQuota, />5h 72%</u);
  assert.match(claudeQuota, />7d 41%</u);
  assert.match(claudeQuota, />in 2h</u);
  assert.match(claudeQuota, />in 2d</u);
  assert.match(claudeQuota, /bg-accent/u);
  assert.match(claudeQuota, /text-fg-secondary/u);
  assert.doesNotMatch(claudeQuota, /bg-warning|bg-error/u);

  const codexQuota = quotaBlockFor(rowFor(markup, "codex"), "codex");
  assert.equal(progressBarsIn(codexQuota).length, 1);
  assert.match(codexQuota, />7d 75%</u);
  assert.match(codexQuota, />Resets tomorrow</u);
  assert.match(codexQuota, /bg-accent/u);

  const cursorRow = rowFor(markup, "cursor");
  assert.doesNotMatch(cursorRow, /data-provider-quota/u);
  assert.equal(progressBarsIn(cursorRow).length, 0);
});

test("a provider whose quota read was refused says so instead of showing nothing", () => {
  // Claude's quota endpoint was refusing every read, and the row it produced
  // was empty -- the same empty row a provider quota-axi has no source for
  // produces. The report carries the reason and the moment to retry it, so
  // the row says both: the usage is not missing, it could not be read.
  const markup = renderProvidersView(
    quotaReport([
      {
        provider: "claude",
        windows: [],
        state: {
          status: "rate_limited",
          stale: false,
          error: "Claude quota endpoint rate limited",
          retryAfter: futureIso(58 * 60 * 1000)
        }
      }
    ]),
    ["claude"]
  );

  const row = rowFor(markup, "claude");
  assert.match(row, /data-provider-quota-state="claude"/u);
  assert.match(row, />Quota rate limited</u);
  assert.match(row, /in 58m/u);
  assert.match(row, /Claude quota endpoint rate limited/u);
  assert.equal(progressBarsIn(row).length, 0);
});

test("a quota read state never becomes a quota verdict", () => {
  // The read state says what is missing from the usage cell. It is not a
  // statement about the provider: the row's Status verdict still comes from
  // health, credentials and the exhaustion scopes alone.
  const markup = renderProvidersView(
    quotaReport([
      {
        provider: "claude",
        windows: [],
        state: {
          status: "rate_limited",
          stale: false,
          error: "Claude quota endpoint rate limited"
        }
      }
    ]),
    ["claude"],
    [healthyProviderRecord("claude")]
  );

  const row = rowFor(markup, "claude");
  assert.match(row, />Quota rate limited</u);
  assert.doesNotMatch(row, />Quota exhausted</u);
  assert.doesNotMatch(row, /data-status="unavailable"/u);
  assert.match(row, /data-status="ready"/u);
});

test("the shared Antigravity quota source reports its read state on each of its rows", () => {
  const markup = renderProvidersView(
    quotaReport([
      {
        provider: "agy",
        windows: [],
        state: { status: "rate_limited", stale: false }
      }
    ]),
    [...ANTIGRAVITY_ROW_IDS]
  );

  for (const id of ANTIGRAVITY_ROW_IDS) {
    const row = rowFor(markup, id);
    assert.match(row, new RegExp(`data-provider-quota-state="${id}"`, "u"));
    assert.match(row, />Quota rate limited</u);
  }
});

test("usage bars use blue when available, yellow over 95% used, and red at 100% used", () => {
  const markup = renderProvidersView(
    {
      generatedAt: new Date().toISOString(),
      schemaVersion: 5,
      providers: [
        {
          provider: "claude",
          windows: [
            {
              id: "five_hour",
              label: "5-hour",
              kind: "session",
              percentRemaining: 5,
              resetsAt: futureIso(45 * 60 * 1000)
            }
          ],
          state: { status: "fresh", stale: false }
        },
        {
          provider: "codex",
          windows: [
            {
              id: "weekly",
              label: "Weekly",
              kind: "weekly",
              percentRemaining: 4,
              resetsAt: futureIso(90 * 60 * 1000)
            }
          ],
          state: { status: "fresh", stale: false }
        },
        {
          provider: "minimax",
          windows: [
            {
              id: "model:general:5h",
              label: "general 5h",
              kind: "model",
              percentUsed: 97.5,
              resetsAt: futureIso(150 * 60 * 1000)
            },
            {
              id: "model:general:7d",
              label: "general 7d",
              kind: "model",
              percentUsed: 120,
              resetsAt: futureIso(-1000)
            }
          ],
          state: { status: "fresh", stale: false }
        },
        {
          provider: "copilot",
          windows: [
            {
              id: "premium_interactions",
              label: "premium interactions",
              kind: "monthly",
              percentRemaining: 0,
              resetsAt: futureIso(5 * 60 * 1000)
            }
          ],
          state: { status: "fresh", stale: false }
        }
      ]
    },
    ["claude", "codex", "minimax", "copilot"]
  );

  // 95% used (5% remaining) is still available -> blue
  const claudeQuota = quotaBlockFor(rowFor(markup, "claude"), "claude");
  assert.match(claudeQuota, />5h 5%</u);
  assert.match(claudeQuota, />in 45m</u);
  assert.match(claudeQuota, /bg-accent/u);
  assert.match(claudeQuota, /text-fg-secondary/u);
  assert.match(claudeQuota, /aria-valuenow="5"/u);
  assert.match(claudeQuota, /style="width:5%"/u);
  assert.doesNotMatch(claudeQuota, /bg-warning|bg-error/u);

  // 96% used (4% remaining) is over 95% used -> yellow
  const codexQuota = quotaBlockFor(rowFor(markup, "codex"), "codex");
  assert.match(codexQuota, />7d 4%</u);
  assert.match(codexQuota, />in 1h 30m</u);
  assert.match(codexQuota, /bg-warning/u);
  assert.match(codexQuota, /text-warning/u);
  assert.match(codexQuota, /aria-valuenow="4"/u);
  assert.match(codexQuota, /style="width:4%"/u);
  assert.doesNotMatch(codexQuota, /bg-accent|bg-error/u);

  // Mixed warning (>95% via percentUsed fallback) + exhausted (100%+ clamped)
  const minimaxQuota = quotaBlockFor(rowFor(markup, "minimax"), "minimax");
  assert.match(minimaxQuota, />5h 3%</u);
  assert.match(minimaxQuota, />in 2h 30m</u);
  assert.match(minimaxQuota, />7d 0%</u);
  assert.match(minimaxQuota, />resetting</u);
  assert.match(minimaxQuota, /bg-warning/u);
  assert.match(minimaxQuota, /text-warning/u);
  assert.match(minimaxQuota, /bg-error/u);
  assert.match(minimaxQuota, /text-error/u);
  assert.match(minimaxQuota, /style="width:100%"/u);

  // 100% used (0% remaining) -> red bar at full width so exhaustion is visible
  const copilotQuota = quotaBlockFor(rowFor(markup, "copilot"), "copilot");
  assert.match(copilotQuota, />premium interactions 0%</u);
  assert.match(copilotQuota, />in 5m</u);
  assert.match(copilotQuota, /bg-error/u);
  assert.match(copilotQuota, /text-error/u);
  assert.match(copilotQuota, /aria-valuenow="0"/u);
  assert.match(copilotQuota, /style="width:100%"/u);
});

test("agy quota windows map only to their matching Antigravity route rows", () => {
  const markup = renderProvidersView(
    {
      generatedAt: new Date().toISOString(),
      schemaVersion: 5,
      providers: [
        {
          provider: "agy",
          windows: [
            {
              id: "gemini_5h",
              label: "Gemini 5-hour",
              kind: "session",
              percentRemaining: 96,
              resetsAt: futureIso(3 * 60 * 60 * 1000)
            },
            {
              id: "gemini_weekly",
              label: "Gemini weekly",
              kind: "weekly",
              percentRemaining: 98,
              resetsAt: futureIso(6 * 24 * 60 * 60 * 1000)
            },
            {
              id: "gemini_argon_5h",
              label: "Gemini Argon 5-hour",
              kind: "session",
              percentRemaining: 50,
              resetsAt: futureIso(4 * 60 * 60 * 1000)
            },
            {
              id: "gemini_argon_weekly",
              label: "Gemini Argon weekly",
              kind: "weekly",
              percentRemaining: 66,
              resetsAt: futureIso(5 * 24 * 60 * 60 * 1000)
            },
            {
              id: "claude_gpt_5h",
              label: "Claude/GPT 5-hour",
              kind: "session",
              percentRemaining: 3,
              resetsAt: futureIso(2 * 60 * 60 * 1000)
            },
            {
              id: "claude_gpt_weekly",
              label: "Claude/GPT weekly",
              kind: "weekly",
              percentRemaining: 0,
              resetsAt: futureIso(4 * 24 * 60 * 60 * 1000)
            },
            {
              id: "model:gemini-pro:5h",
              label: "Gemini Pro 5-hour",
              kind: "model",
              percentRemaining: 90
            },
            {
              id: "model:claude-opus:weekly",
              label: "Claude Opus weekly share",
              kind: "model",
              shareOf: "claude_gpt_weekly",
              percentUsed: 60
            },
            {
              id: "gemini_unmeasured",
              label: "Gemini unmeasured",
              kind: "unknown"
            }
          ],
          state: { status: "fresh", stale: false }
        }
      ]
    },
    [...ANTIGRAVITY_ROW_IDS]
  );

  const geminiQuota = quotaBlockFor(
    rowFor(markup, "antigravity-gemini"),
    "antigravity-gemini"
  );
  assert.equal(progressBarsIn(geminiQuota).length, 2);
  assert.match(geminiQuota, />5h 96%</u);
  assert.match(geminiQuota, />7d 98%</u);
  assert.doesNotMatch(geminiQuota, /50%|66%|\b3%|\b0%|90%|60%|unmeasured/u);

  const argonQuota = quotaBlockFor(
    rowFor(markup, "antigravity-argon"),
    "antigravity-argon"
  );
  assert.equal(progressBarsIn(argonQuota).length, 2);
  assert.match(argonQuota, />5h 50%</u);
  assert.match(argonQuota, />7d 66%</u);
  assert.doesNotMatch(argonQuota, /96%|98%|\b3%|\b0%/u);

  const claudeGptQuota = quotaBlockFor(
    rowFor(markup, "antigravity-claude-gpt"),
    "antigravity-claude-gpt"
  );
  assert.equal(progressBarsIn(claudeGptQuota).length, 2);
  assert.match(claudeGptQuota, />5h 3%</u);
  assert.match(claudeGptQuota, />7d 0%</u);
  assert.match(claudeGptQuota, /bg-warning/u);
  assert.match(claudeGptQuota, /bg-error/u);
  assert.doesNotMatch(claudeGptQuota, /96%|98%|50%|66%|60%/u);
});

test("provider rows omit verbose quota debug metadata and raw ISO timestamps", () => {
  const resetsAt = futureIso(3 * 60 * 60 * 1000);
  const markup = renderProvidersView(
    {
      generatedAt: new Date().toISOString(),
      schemaVersion: 5,
      providers: [
        {
          provider: "agy",
          windows: [
            {
              id: "session",
              label: "Session",
              kind: "session",
              percentRemaining: 80,
              resetsAt,
              pace: {
                status: "ahead",
                reservePercentPoints: -10,
                burnMultiple: 1.5
              }
            }
          ],
          quotaSemantics: {
            status: "unknown",
            effectiveAvailability: [
              { scope: "account", status: "unknown", boundedBy: ["session"] }
            ]
          },
          state: {
            status: "stale",
            stale: true,
            refreshedAt: "2026-11-13T11:00:00.000Z"
          }
        }
      ]
    },
    [...ANTIGRAVITY_ROW_IDS, "codex"]
  );

  for (const id of ANTIGRAVITY_ROW_IDS) {
    const quota = quotaBlockFor(rowFor(markup, id), id);
    assert.equal(progressBarsIn(quota).length, 1);
    assert.match(quota, />5h 80%</u);
    assert.match(quota, />in 3h</u);
  }

  assert.doesNotMatch(
    markup,
    /Quota:|Quota semantics|Status: stale|Stale:|Refreshed:|Pace:|Used: Not reported|No windows reported|Quota report|quota-axi-overview|JSON\.stringify/u
  );
  // Visible DOM text never contains raw wire ISO strings.
  const visibleText = markup
    .replaceAll(/title="[^"]*"/gu, "")
    .replaceAll(/<[^>]+>/gu, " ");
  assert.doesNotMatch(
    visibleText,
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u,
    "raw ISO timestamp must not appear in visible quota text"
  );
  assert.doesNotMatch(rowFor(markup, "codex"), /Not reported/u);
});

test("fetchProviders passes the quota-axi report through without reshaping it", async () => {
  const quotaAxi: NonNullable<ControlApiProvidersResponse["quotaAxi"]> = {
    generatedAt: "2026-11-13T12:00:00.000Z",
    schemaVersion: 5,
    providers: [
      {
        provider: "agy",
        windows: [{ id: "unknown", label: "Unknown", kind: "unknown" }],
        quotaSemantics: {
          status: "unknown",
          effectiveAvailability: [
            { scope: "account", status: "unknown", boundedBy: [] }
          ]
        },
        state: { status: "stale", stale: true }
      }
    ]
  };
  const response: ControlApiProvidersResponse = {
    schema: "autodev-control-providers-v5",
    orchestratorTier: "orchestrator",
    tiers: [],
    providers: [],
    quotaAxi
  };

  const result = await fetchProviders(
    { baseUrl: "http://control-api.test", serviceToken: "test-token" },
    { fetchImpl: async () => Response.json(response) }
  );

  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") return;
  assert.deepEqual(result.data.quotaAxi, quotaAxi);
});
