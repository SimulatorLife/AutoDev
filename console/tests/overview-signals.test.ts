import assert from "node:assert/strict";
import test from "node:test";

import type {
  ControlApiProviderRecord,
  ControlApiProvidersResponse,
  UsageMetricsData
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  countProviderVerdicts,
  type OverviewReaders,
  readOverview
} from "../app/overview/overview-reads.ts";
import type {
  OverviewData,
  OverviewProviderVerdicts
} from "../src/features/overview/overview-types.ts";
import { OverviewSignals } from "../src/features/overview/OverviewSignals.ts";

const NO_CONFIG_CODE = "autodev_control_api_disabled";

const provider = (
  id: string,
  overrides: Partial<ControlApiProviderRecord> = {}
): ControlApiProviderRecord =>
  ({
    id,
    route: "route",
    credential: { envKey: null, configured: true },
    disabled: false,
    health: null,
    ...overrides
  }) as unknown as ControlApiProviderRecord;

test("provider verdict counts keep disabled and unobserved providers out of Ready", () => {
  const counts = countProviderVerdicts({
    quotaAxi: null,
    providers: [
      provider("a", { disabled: true }),
      provider("b"),
      provider("c", { route: null })
    ]
  });
  assert.equal(counts.total, 3);
  assert.equal(counts.ready, 0);
  assert.equal(counts.notObserved, 1);
  assert.equal(counts.needsAttention, 2);
  assert.equal(counts.quotaExhausted, null);
  assert.equal(counts.quotaEvidence, "missing");
});

type QuotaReport = NonNullable<ControlApiProvidersResponse["quotaAxi"]>;
type QuotaEntry = QuotaReport["providers"][number];

const exhaustedEntry = (overrides: Partial<QuotaEntry> = {}): QuotaEntry =>
  ({
    provider: "claude",
    windows: [
      { id: "five_hour", label: "5-hour", kind: "session", percentRemaining: 0 }
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
  }) as QuotaEntry;

const report = (
  providers: QuotaEntry[],
  generatedAt = new Date().toISOString()
): QuotaReport => ({ generatedAt, schemaVersion: 5, providers });

const claude = provider("claude");

test("fresh quota evidence yields an observed exhausted count", () => {
  const counts = countProviderVerdicts({
    quotaAxi: report([exhaustedEntry()]),
    providers: [claude, provider("b")]
  });
  assert.equal(counts.quotaEvidence, "fresh");
  assert.equal(counts.quotaExhausted, 1);
  assert.equal(counts.notObserved, 1);
});

test("fresh quota with no exhausted scope is an observed zero", () => {
  const counts = countProviderVerdicts({
    quotaAxi: report([
      exhaustedEntry({
        quotaSemantics: { status: "known", effectiveAvailability: [] }
      })
    ]),
    providers: [claude]
  });
  assert.equal(counts.quotaEvidence, "fresh");
  assert.equal(counts.quotaExhausted, 0);
});

test("stale, invalid-timestamp and partial quota evidence never read as a confident zero", () => {
  const stale = countProviderVerdicts({
    quotaAxi: report([
      exhaustedEntry({ state: { status: "fresh", stale: true } })
    ]),
    providers: [claude]
  });
  assert.equal(stale.quotaEvidence, "stale");
  assert.equal(stale.quotaExhausted, null);

  const invalid = countProviderVerdicts({
    quotaAxi: report([exhaustedEntry()], "not-a-date"),
    providers: [claude]
  });
  assert.equal(invalid.quotaEvidence, "invalid");
  assert.equal(invalid.quotaExhausted, null);

  const partial = countProviderVerdicts({
    quotaAxi: report([
      exhaustedEntry(),
      exhaustedEntry({
        provider: "codex",
        state: { status: "unavailable" } as never
      })
    ]),
    providers: [claude]
  });
  assert.equal(partial.quotaEvidence, "partial");
  assert.equal(partial.quotaExhausted, 1);
});

test("low percentages alone are never counted as exhaustion", () => {
  const counts = countProviderVerdicts({
    quotaAxi: report([
      exhaustedEntry({
        quotaSemantics: { status: "known", effectiveAvailability: [] }
      })
    ]),
    providers: [claude]
  });
  assert.equal(counts.quotaExhausted, 0);
});

test("exhausted count is classified by typed verdict, not label", () => {
  const counts = countProviderVerdicts({
    quotaAxi: report([exhaustedEntry()]),
    providers: [
      claude,
      provider("signed-out", {
        credential: { envKey: "Quota exhausted", configured: false }
      } as never)
    ]
  });
  assert.equal(counts.quotaExhausted, 1);
  assert.equal(counts.needsAttention, 1);
});

test("without a Control API credential the control sources are not configured, never empty", async () => {
  const data = await readOverview(null);
  for (const source of [data.liveActivity, data.providers, data.failures]) {
    assert.deepEqual(source, {
      status: "not-configured",
      code: NO_CONFIG_CODE,
      message: "The Control API credential is not configured."
    });
  }
});

const METRICS = {
  logicalRequests: 12,
  physicalAttempts: 0,
  failedAttempts: null,
  mcpErrors: 3,
  p95LatencyMs: 1234.4,
  estimatedCostUsd: 1.5
} as unknown as UsageMetricsData;

const OK_PROVIDER_VERDICTS: OverviewProviderVerdicts = {
  total: 5,
  ready: 2,
  quotaExhausted: 1,
  notObserved: 1,
  unavailable: 1,
  needsAttention: 0,
  quotaEvidence: "fresh"
};

const OK_DATA: OverviewData = {
  liveActivity: {
    status: "ok",
    data: {
      activeSessions: {
        schema: "autodev-usage-active-sessions-v3",
        lifecycle: "ready",
        lifecycleChangedAt: null,
        activeSessions: 4,
        identifiedSessionCount: 2,
        activeSubagentThreads: 5,
        inFlightRequests: 0,
        sessionIdentities: [],
        sessionIdentitiesPartial: false,
        unattributedLiveActivityCount: 1
      },
      liveAgents: null
    }
  },
  providers: { status: "ok", data: OK_PROVIDER_VERDICTS },
  failures: {
    status: "ok",
    data: {
      scannedSessions: 3,
      scanLimit: 10,
      toolFailures: 2,
      routerFailures: 1,
      failingSessionCount: 1,
      failingSessions: [
        {
          id: "sess-1",
          lastWrite: "2026-11-19T10:30:00.000Z",
          toolFailures: 2,
          routerFailures: 1
        }
      ]
    }
  },
  telemetry: { status: "ok", data: METRICS }
};

test("overview renders distinct live facts, verdicts, failures and telemetry", () => {
  const html = renderToStaticMarkup(
    React.createElement(OverviewSignals, { data: OK_DATA })
  );
  assert.match(html, /Active runtime sessions<\/dt><dd[^>]*>4</u);
  assert.match(html, /Identified sessions<\/dt><dd[^>]*>2</u);
  assert.match(html, /Running agents<\/dt><dd[^>]*>Not observed</u);
  assert.match(html, /In-flight requests<\/dt><dd[^>]*>0</u);
  assert.match(html, /no total session count is available/u);
  assert.match(html, /Quota exhausted<\/dt><dd[^>]*>1</u);
  assert.match(html, /Ready<\/dt><dd[^>]*>2</u);
  assert.match(html, /sess-1/u);
  assert.match(html, /<time[^>]*dateTime="2026-11-19T10:30:00.000Z"/u);
  assert.match(html, />2026-11-19 10:30:00 UTC<\/time>/u);
  assert.match(html, /Failed attempts<\/dt><dd[^>]*>Not observed</u);
  assert.match(html, /Provider attempts<\/dt><dd[^>]*>0</u);
  assert.match(html, /up to 5 minutes old/u);
});

test("overview reports quota evidence quality and marks unusable counts not observed", () => {
  const render = (
    quotaEvidence: "stale" | "invalid" | "missing",
    quotaExhausted: number | null
  ) =>
    renderToStaticMarkup(
      React.createElement(OverviewSignals, {
        data: {
          ...OK_DATA,
          providers: {
            status: "ok",
            data: {
              ...OK_PROVIDER_VERDICTS,
              quotaExhausted,
              quotaEvidence
            }
          }
        }
      })
    );
  assert.match(
    render("stale", null),
    /Quota exhausted<\/dt><dd[^>]*>Not observed<\/dd><p[^>]*>No fresh quota reading/u
  );
  assert.match(
    render("invalid", null),
    /timestamp invalid; exhaustion not observed/u
  );
  assert.match(render("missing", null), /No quota report observed/u);
  assert.doesNotMatch(
    render("stale", null),
    /Quota exhausted<\/dt><dd[^>]*>0</u
  );
});

test("overview unavailable notices are not live regions and the failure list has an explicit role", () => {
  const html = renderToStaticMarkup(
    React.createElement(OverviewSignals, {
      data: {
        ...OK_DATA,
        providers: { status: "unavailable", code: "c", message: "m" }
      }
    })
  );
  assert.doesNotMatch(html, /role="status"/u);
  const ok = renderToStaticMarkup(
    React.createElement(OverviewSignals, { data: OK_DATA })
  );
  assert.match(ok, /<ul[^>]*role="list"/u);
  assert.match(ok, /by write time, not a time window/u);
  assert.doesNotMatch(ok, /24[- ]hour[^.]*rollout/iu);
});

test("overview keeps unavailable sources separate from zero", () => {
  const html = renderToStaticMarkup(
    React.createElement(OverviewSignals, {
      data: {
        ...OK_DATA,
        providers: {
          status: "unavailable",
          code: "autodev_control_api_timeout",
          message: "slow"
        },
        telemetry: {
          status: "not-configured",
          code: "autodev_usage_credentials_disabled",
          message: "missing"
        }
      }
    })
  );
  assert.match(html, /data-overview-source-status="unavailable"/u);
  assert.match(html, /data-overview-source-status="not-configured"/u);
  assert.match(html, /autodev_control_api_timeout/u);
  assert.doesNotMatch(
    html,
    /Provider verdicts[\s\S]*Ready<\/dt>[\s\S]*Telemetry/u
  );
});

const CONFIG = { baseUrl: "http://control.test", token: "t" } as never;

const ok = <T>(data: T) => ({ kind: "ok" as const, data });

function readers(overrides: Partial<OverviewReaders> = {}) {
  const calls = { runtime: 0, providers: 0, fleetScan: 0, telemetry: 0 };
  const started: string[] = [];
  const gate = Promise.withResolvers<void>();
  const slow =
    <A extends unknown[], R>(name: keyof typeof calls, value: () => R) =>
    async (..._arguments: A): Promise<Awaited<R>> => {
      calls[name] += 1;
      started.push(name);
      if (started.length === 4) gate.resolve();
      // Resolves only once all four sources have started: proves parallelism.
      await gate.promise;
      return value() as Awaited<R>;
    };
  const result = {
    runtime: slow("runtime", () =>
      ok({
        lifecycle: { state: "ready", changedAt: "x", draining: false },
        concurrency: { activeSessions: 0, activeSubagentThreads: 3 },
        inFlightRequestCount: 0,
        liveAgents: null,
        liveSessions: null
      })
    ),
    providers: slow("providers", () =>
      ok({
        quotaAxi: null,
        providers: [provider("a"), provider("b", { disabled: true })]
      })
    ),
    fleetScan: slow("fleetScan", () =>
      ok({
        limit: 10,
        sessions: [
          { id: "quiet", lastWrite: "w", toolFailures: 0, routerFailures: 0 },
          { id: "bad", lastWrite: "w", toolFailures: 2, routerFailures: 1 }
        ]
      })
    ),
    telemetry: slow("telemetry", () => ({
      kind: "ok",
      data: { metrics: METRICS }
    })),
    ...overrides
  } as unknown as OverviewReaders;
  return { calls, result };
}

test("readOverview reads each source once, in parallel, and projects values", async () => {
  const { calls, result } = readers();
  const data = await readOverview(CONFIG, result);
  assert.deepEqual(calls, {
    runtime: 1,
    providers: 1,
    fleetScan: 1,
    telemetry: 1
  });
  assert.equal(data.liveActivity.status, "ok");
  if (data.liveActivity.status === "ok") {
    // Observed zero stays zero; a missing agent source stays null.
    assert.equal(data.liveActivity.data.activeSessions.activeSessions, 0);
    assert.equal(
      data.liveActivity.data.activeSessions.activeSubagentThreads,
      3
    );
    assert.equal(data.liveActivity.data.liveAgents, null);
  }
  assert.equal(data.providers.status === "ok" && data.providers.data.total, 2);
  assert.equal(
    data.providers.status === "ok" && data.providers.data.needsAttention,
    1
  );
  assert.equal(
    data.failures.status === "ok" && data.failures.data.failingSessionCount,
    1
  );
  assert.equal(
    data.failures.status === "ok" && data.failures.data.toolFailures,
    2
  );
  assert.equal(data.telemetry.status === "ok" && data.telemetry.data, METRICS);
});

test("readOverview keeps failed and thrown sources unavailable, not zero", async () => {
  const { result } = readers();
  const data = await readOverview(CONFIG, {
    ...result,
    runtime: async () => ({
      kind: "http-error",
      status: 503,
      code: "x",
      message: "busy"
    }),
    providers: async () => ({
      kind: "unreachable",
      message: "down"
    }),
    fleetScan: async () => {
      throw new Error("boom");
    },
    telemetry: async () => ({ kind: "unreachable" })
  } as unknown as OverviewReaders);
  assert.equal(data.liveActivity.status, "unavailable");
  assert.equal(data.providers.status, "unavailable");
  assert.equal(data.failures.status, "unavailable");
  assert.equal(
    data.failures.status === "unavailable" && data.failures.message,
    "boom"
  );
  assert.equal(data.telemetry.status, "unavailable");
});
