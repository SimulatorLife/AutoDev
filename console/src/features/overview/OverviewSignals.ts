import type { UsageMetricsData } from "@simulatorlife/autodev-core";
import React from "react";

import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PAGE_SECTION_STACK_CLASS } from "../../components/layout/PageBody.ts";
import {
  DETAIL_PANEL_CLASS,
  NESTED_PANEL_CLASS
} from "../../components/layout/Panel.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import { InstantDisplay } from "../../components/ui/InstantDisplay.ts";
import {
  MONO_META_CLASS,
  MUTED_META_CLASS,
  NUMERIC_VALUE_CLASS
} from "../../components/ui/text-classes.ts";
import type {
  OverviewData,
  OverviewFailures,
  OverviewLiveActivity,
  OverviewProviderVerdicts,
  OverviewRead
} from "./overview-types.ts";

const h = React.createElement;

const FACT_GRID_CLASS =
  "grid list-none grid-cols-2 gap-3 p-0 m-0 sm:grid-cols-3 xl:grid-cols-6";

/**
An observed count, or the unobserved label: never a defaulted zero.
*/
function count(value: number | null | undefined): string {
  return value === null || value === undefined
    ? NOT_OBSERVED_LABEL
    : value.toLocaleString("en-US");
}

function fact(label: string, value: string, note?: string): React.JSX.Element {
  return h(
    "div",
    { key: label, className: `${NESTED_PANEL_CLASS} min-w-0` },
    h("dt", { className: MUTED_META_CLASS }, label),
    h(
      "dd",
      { className: "m-0 mt-1 text-lg font-semibold tabular-nums text-fg" },
      value
    ),
    note === undefined
      ? null
      : h("p", { className: `${MUTED_META_CLASS} mt-1` }, note)
  );
}

function facts(items: readonly React.JSX.Element[]): React.JSX.Element {
  return h("dl", { className: FACT_GRID_CLASS }, items);
}

/**
Why a source has nothing to show; distinct from an observed zero.
*/
function sourceNotice(
  read: Exclude<OverviewRead<unknown>, { readonly status: "ok" }>
): React.JSX.Element {
  return h(
    "p",
    {
      className: "text-sm text-warning",
      "data-overview-source-status": read.status
    },
    read.status === "not-configured" ? "Not configured: " : "Unavailable: ",
    read.message,
    " ",
    h("span", { className: MONO_META_CLASS }, read.code),
    ". No value is shown until the source reports one."
  );
}

function section(
  id: string,
  title: string,
  body: React.ReactNode,
  detail?: string
): React.JSX.Element {
  return h(
    "section",
    {
      key: id,
      "aria-labelledby": `overview-signal-${id}`,
      "data-overview-signal": id,
      className: `${DETAIL_PANEL_CLASS} flex flex-col gap-3`
    },
    h(
      "h2",
      {
        id: `overview-signal-${id}`,
        className: `${SECTION_HEADING_CLASS} mb-0`
      },
      title
    ),
    detail === undefined
      ? null
      : h("p", { className: MUTED_META_CLASS }, detail),
    body
  );
}

function liveActivityBody(data: OverviewLiveActivity): React.JSX.Element {
  const { activeSessions, liveAgents } = data;
  const unattributed = activeSessions.unattributedLiveActivityCount;
  return h(
    React.Fragment,
    null,
    facts([
      fact("Active runtime sessions", count(activeSessions.activeSessions)),
      fact(
        "Identified sessions",
        count(activeSessions.identifiedSessionCount),
        "Source-confirmed IDs only"
      ),
      fact("Running agents", count(liveAgents?.count)),
      fact("Subagent threads", count(activeSessions.activeSubagentThreads)),
      fact("In-flight requests", count(activeSessions.inFlightRequests)),
      fact(
        "Unattributed live activity",
        count(unattributed),
        "Activity records without a session ID"
      )
    ]),
    h(
      "p",
      { className: MUTED_META_CLASS },
      "These are separate measurements and are not added together.",
      unattributed !== null && unattributed > 0
        ? " Live activity without a session ID exists, so no total session count is available."
        : null,
      activeSessions.lifecycle === "draining"
        ? " The Runtime is draining."
        : null
    )
  );
}

const QUOTA_EVIDENCE_NOTE: Readonly<
  Record<OverviewProviderVerdicts["quotaEvidence"], string | undefined>
> = {
  fresh: "From fresh quota readings",
  partial: "Fresh readings only; some quota readings are stale or unreadable",
  stale: "No fresh quota reading; exhaustion not observed",
  invalid: "Quota report timestamp invalid; exhaustion not observed",
  missing: "No quota report observed"
};

function providersBody(data: OverviewProviderVerdicts): React.JSX.Element {
  return h(
    React.Fragment,
    null,
    facts([
      fact("Providers", count(data.total)),
      fact("Ready", count(data.ready)),
      fact(
        "Quota exhausted",
        count(data.quotaExhausted),
        QUOTA_EVIDENCE_NOTE[data.quotaEvidence]
      ),
      fact("Not observed", count(data.notObserved), "No health evidence yet"),
      fact("Unavailable", count(data.unavailable), "Failing or cooling down"),
      fact(
        "Needs attention",
        count(data.needsAttention),
        "Disabled or misconfigured"
      )
    ]),
    h(
      "p",
      { className: MUTED_META_CLASS },
      "Each provider counts once, under its single Providers verdict."
    )
  );
}

function failuresBody(data: OverviewFailures): React.JSX.Element {
  return h(
    React.Fragment,
    null,
    facts([
      fact(
        "Sessions scanned",
        count(data.scannedSessions),
        `Newest ${data.scanLimit} rollout sessions at most, by write time`
      ),
      fact("Sessions with failures", count(data.failingSessionCount)),
      fact("Tool failures", count(data.toolFailures)),
      fact("Router failures", count(data.routerFailures))
    ]),
    data.failingSessions.length === 0
      ? h(
          "p",
          { className: MUTED_META_CLASS },
          "No failures in the scanned sessions."
        )
      : h(
          "ul",
          {
            role: "list",
            className: "m-0 flex list-none flex-col gap-1 p-0",
            "aria-label": "Recent failing sessions"
          },
          data.failingSessions.map((row) =>
            h(
              "li",
              { key: row.id, className: "flex flex-wrap gap-x-3 text-sm" },
              h("span", { className: MONO_META_CLASS }, row.id),
              h(
                "span",
                { className: NUMERIC_VALUE_CLASS },
                `${row.toolFailures} tool, ${row.routerFailures} router`
              ),
              h(InstantDisplay, { value: row.lastWrite, label: "Last written" })
            )
          )
        )
  );
}

function telemetryBody(metrics: UsageMetricsData): React.JSX.Element {
  return h(
    React.Fragment,
    null,
    facts([
      fact("Logical requests", count(metrics.logicalRequests)),
      fact("Provider attempts", count(metrics.physicalAttempts)),
      fact("Failed attempts", count(metrics.failedAttempts)),
      fact("MCP errors", count(metrics.mcpErrors)),
      fact(
        "P95 latency",
        metrics.p95LatencyMs === null
          ? NOT_OBSERVED_LABEL
          : `${Math.round(metrics.p95LatencyMs).toLocaleString("en-US")} ms`
      ),
      fact(
        "Estimated cost",
        metrics.estimatedCostUsd === null
          ? NOT_OBSERVED_LABEL
          : `$${metrics.estimatedCostUsd.toFixed(2)}`,
        "Pricing-catalog estimate"
      )
    ])
  );
}

function sourceBody<T>(
  value: OverviewRead<T>,
  body: (data: T) => React.JSX.Element
): React.JSX.Element {
  return value.status === "ok" ? body(value.data) : sourceNotice(value);
}

/**
The Overview's live signals: one section per authoritative source.
*/
export function OverviewSignals({
  data
}: {
  readonly data: OverviewData;
}): React.JSX.Element {
  return h(
    "div",
    { className: PAGE_SECTION_STACK_CLASS, "data-overview-signals": "" },
    section(
      "live",
      "Live activity",
      sourceBody(data.liveActivity, liveActivityBody),
      "Current Runtime state."
    ),
    section(
      "providers",
      "Provider verdicts",
      sourceBody(data.providers, providersBody),
      "Current Providers verdicts."
    ),
    section(
      "failures",
      "Recent failures",
      sourceBody(data.failures, failuresBody),
      "Bounded scan of the newest rollout sessions by write time, not a time window."
    ),
    section(
      "telemetry",
      "Telemetry, last 24 hours",
      sourceBody(data.telemetry, telemetryBody),
      "Fixed 24-hour window; cached, so it may be up to 5 minutes old."
    )
  );
}
