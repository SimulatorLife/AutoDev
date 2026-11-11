"use client";

import {
  isOpenTelemetrySpanId,
  isOpenTelemetryTraceId,
  safeAutoDevSessionId,
  type UsageFilterSelection,
  type UsageSessionEvidence,
  type UsageSessionQuerySelection,
  type UsageSessionSpanSummary
} from "@simulatorlife/autodev-core";
import React, { useState } from "react";

import { Button } from "../../components/forms/Button.ts";
import { CALLOUT_WARNING_CLASS } from "../../components/layout/Callout.ts";
import { SECTION_HEADING_CLASS } from "../../components/layout/Heading.ts";
import { PAGE_SECTION_STACK_CLASS } from "../../components/layout/PageBody.ts";
import { LIST_PANEL_CLASS } from "../../components/layout/Panel.ts";
import { NOT_OBSERVED_LABEL } from "../../components/status/StatusBadge.ts";
import {
  type ColumnDef,
  DataTable
} from "../../components/tables/DataTable.ts";
import { TraceStatus } from "../../components/traces/TraceStatus.ts";
import { formatSpanDuration } from "../../components/ui/duration.ts";
import {
  FIELD_GROUP_CLASS,
  TEXT_CONTROL_CLASS
} from "../../components/ui/field-classes.ts";
import { instantLabel } from "../../components/ui/instant.ts";
import {
  MUTED_BODY_CLASS,
  MUTED_META_CLASS
} from "../../components/ui/text-classes.ts";

const SESSION_LOOKUP_SCHEMA = "autodev-console-session-usage-v1" as const;
const SESSION_LOOKUP_KIND = {
  OK: "ok",
  INVALID_SESSION_ID: "invalid-session-id",
  UNAVAILABLE: "unavailable",
  INVALID_RESPONSE: "invalid-response"
} as const;
type SessionLookupKind =
  (typeof SESSION_LOOKUP_KIND)[keyof typeof SESSION_LOOKUP_KIND];
type SessionLookupStatus = "idle" | "loading" | SessionLookupKind | "observed";
const SESSION_LOOKUP_KINDS = new Set<string>(
  Object.values(SESSION_LOOKUP_KIND)
);

interface SessionLookupReply {
  readonly schema: typeof SESSION_LOOKUP_SCHEMA;
  readonly kind: SessionLookupKind;
  readonly data?: UsageSessionEvidence | undefined;
}

interface SessionUsageLookupProps {
  readonly selection: UsageFilterSelection;
}

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
const COST_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6
});

function sessionSelection(
  selection: UsageFilterSelection
): UsageSessionQuerySelection | null {
  if (selection.range === "ACTIVE_SESSIONS") return null;
  if (selection.range === "CUSTOM") {
    return selection.customRange
      ? { range: "CUSTOM", customRange: selection.customRange }
      : null;
  }
  return { range: selection.range };
}

function safeCount(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : COUNT_FORMATTER.format(value);
}

function safeCost(value: number | null): string {
  return value === null ? NOT_OBSERVED_LABEL : COST_FORMATTER.format(value);
}

function eventSummary(span: UsageSessionSpanSummary): string {
  const events: string[] = [];
  if (span.requestKind === "compaction") {
    events.push(
      span.compactionProvider
        ? "Compaction served by " + span.compactionProvider
        : "Compaction; provider not attributed"
    );
  }
  if (span.hopRoute) {
    events.push(
      span.hopReason
        ? "Provider hop " + span.hopRoute + " (" + span.hopReason + ")"
        : "Provider hop " + span.hopRoute
    );
  }
  return events.length > 0
    ? events.join(" · ")
    : "No reported compaction or provider hop";
}

const SESSION_COLUMNS: readonly ColumnDef<UsageSessionSpanSummary>[] = [
  {
    id: "operation",
    header: "Operation",
    weight: 120,
    align: "tokens",
    cell: (span) => span.operationName
  },
  {
    id: "time",
    header: "Time (UTC)",
    weight: 180,
    align: "tokens",
    cell: (span) => instantLabel(span.timestamp)
  },
  {
    id: "provider",
    header: "Provider",
    weight: 100,
    align: "tokens",
    cell: (span) => span.provider ?? NOT_OBSERVED_LABEL
  },
  {
    id: "requested-model",
    header: "Requested model",
    weight: 140,
    align: "tokens",
    cell: (span) => span.requestedModel ?? NOT_OBSERVED_LABEL
  },
  {
    id: "agent-role",
    header: "Agent role",
    weight: 100,
    align: "tokens",
    cell: (span) => span.role ?? NOT_OBSERVED_LABEL
  },
  {
    id: "workspace",
    header: "Workspace",
    weight: 150,
    align: "tokens",
    cell: (span) => span.workspace ?? "Not attributed"
  },
  {
    id: "status",
    header: "Status",
    weight: 70,
    cell: (span) =>
      React.createElement(TraceStatus, { statusCode: span.statusCode })
  },
  {
    id: "duration",
    header: "Duration",
    weight: 90,
    cell: (span) => formatSpanDuration(span.durationNs)
  },
  {
    id: "tokens",
    header: "Input / output",
    weight: 120,
    align: "tokens",
    cell: (span) =>
      safeCount(span.inputTokens) + " / " + safeCount(span.outputTokens)
  },
  {
    id: "cost",
    header: "Estimated cost",
    weight: 110,
    align: "tokens",
    cell: (span) => safeCost(span.costUsd)
  },
  {
    id: "context",
    header: "Compaction / hop",
    weight: 220,
    align: "prose",
    cell: eventSummary
  }
];

const SESSION_SPAN_KEYS = new Set([
  "spanId",
  "traceId",
  "parentSpanId",
  "operationName",
  "timestamp",
  "durationNs",
  "statusCode",
  "provider",
  "requestedModel",
  "role",
  "workspace",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "costUsd",
  "requestKind",
  "compactionProvider",
  "hopRoute",
  "hopFrom",
  "hopTo",
  "hopReason"
]);
const SESSION_SPAN_STATUSES = new Set(["OK", "ERROR", "UNSET", "UNKNOWN"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableCount(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isNullableCost(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isFinite(value) && value >= 0)
  );
}

function isSessionSpanSummary(
  value: unknown
): value is UsageSessionSpanSummary {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== SESSION_SPAN_KEYS.size ||
    Object.keys(value).some((key) => !SESSION_SPAN_KEYS.has(key)) ||
    typeof value.spanId !== "string" ||
    !isOpenTelemetrySpanId(value.spanId) ||
    typeof value.traceId !== "string" ||
    !isOpenTelemetryTraceId(value.traceId) ||
    (value.parentSpanId !== null &&
      (typeof value.parentSpanId !== "string" ||
        !isOpenTelemetrySpanId(value.parentSpanId))) ||
    typeof value.operationName !== "string" ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.durationNs !== "number" ||
    !Number.isSafeInteger(value.durationNs) ||
    value.durationNs < 0 ||
    typeof value.statusCode !== "string" ||
    !SESSION_SPAN_STATUSES.has(value.statusCode) ||
    !isNullableString(value.provider) ||
    !isNullableString(value.requestedModel) ||
    !isNullableString(value.role) ||
    !isNullableString(value.workspace) ||
    !isNullableCount(value.inputTokens) ||
    !isNullableCount(value.outputTokens) ||
    !isNullableCount(value.cacheReadInputTokens) ||
    !isNullableCost(value.costUsd) ||
    !isNullableString(value.requestKind) ||
    !isNullableString(value.compactionProvider) ||
    !isNullableString(value.hopRoute) ||
    !isNullableString(value.hopFrom) ||
    !isNullableString(value.hopTo) ||
    !isNullableString(value.hopReason)
  ) {
    return false;
  }
  return true;
}

function isSessionReply(value: unknown): value is SessionLookupReply {
  if (!isRecord(value)) return false;
  if (
    value.schema !== SESSION_LOOKUP_SCHEMA ||
    !SESSION_LOOKUP_KINDS.has(String(value.kind))
  ) {
    return false;
  }
  const expectedKeys =
    value.kind === SESSION_LOOKUP_KIND.OK
      ? ["schema", "kind", "data"]
      : ["schema", "kind"];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    Object.keys(value).some((key) => !expectedKeys.includes(key))
  ) {
    return false;
  }
  if (value.kind !== SESSION_LOOKUP_KIND.OK) return true;
  return (
    isRecord(value.data) &&
    Object.keys(value.data).length === 2 &&
    Object.hasOwn(value.data, "partial") &&
    Object.hasOwn(value.data, "spans") &&
    typeof value.data.partial === "boolean" &&
    Array.isArray(value.data.spans) &&
    value.data.spans.length <= 200 &&
    value.data.spans.every(isSessionSpanSummary)
  );
}

export function SessionUsageLookup({
  selection
}: SessionUsageLookupProps): React.JSX.Element {
  const [sessionId, setSessionId] = useState("");
  const [status, setStatus] = useState<SessionLookupStatus>("idle");
  const [evidence, setEvidence] = useState<UsageSessionEvidence | null>(null);
  const querySelection = sessionSelection(selection);

  const submit = async (
    event: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    event.preventDefault();
    const validatedSessionId = safeAutoDevSessionId(sessionId);
    if (!validatedSessionId) {
      setEvidence(null);
      setStatus(SESSION_LOOKUP_KIND.INVALID_SESSION_ID);
      return;
    }
    if (!querySelection) {
      setEvidence(null);
      setStatus(SESSION_LOOKUP_KIND.UNAVAILABLE);
      return;
    }

    setStatus("loading");
    setEvidence(null);
    try {
      const response = await fetch("/api/usage/session", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sessionId: validatedSessionId,
          selection: querySelection
        }),
        cache: "no-store"
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setStatus(SESSION_LOOKUP_KIND.INVALID_RESPONSE);
        return;
      }
      if (!isSessionReply(body)) {
        setStatus(SESSION_LOOKUP_KIND.INVALID_RESPONSE);
        return;
      }
      if (body.kind === SESSION_LOOKUP_KIND.OK) {
        setEvidence(body.data ?? null);
        setStatus("observed");
      } else {
        setStatus(body.kind);
      }
    } catch {
      setStatus(SESSION_LOOKUP_KIND.UNAVAILABLE);
    }
  };

  return React.createElement(
    "section",
    {
      className: PAGE_SECTION_STACK_CLASS,
      "data-feature": "usage-session-lookup",
      "data-session-lookup-state": status
    },
    React.createElement(
      "div",
      { className: "flex flex-col gap-2" },
      React.createElement(
        "h2",
        { className: SECTION_HEADING_CLASS },
        "Session activity"
      ),
      React.createElement(
        "p",
        { className: MUTED_BODY_CLASS },
        "Inspect source-confirmed spans for one exact session. Session IDs are not listed as filter options or used as metric dimensions; the ID stays out of the URL."
      )
    ),
    React.createElement(
      "form",
      {
        className: LIST_PANEL_CLASS + " flex flex-wrap items-end gap-3",
        method: "post",
        action: "/api/usage/session",
        onSubmit: submit
      },
      React.createElement(
        "label",
        { className: FIELD_GROUP_CLASS, htmlFor: "usage-session-id" },
        React.createElement(
          "span",
          { className: MUTED_META_CLASS },
          "Session ID"
        ),
        React.createElement("input", {
          id: "usage-session-id",
          name: "sessionId",
          type: "text",
          autoComplete: "off",
          spellCheck: false,
          maxLength: 128,
          value: sessionId,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            setSessionId(event.currentTarget.value),
          className: TEXT_CONTROL_CLASS
        })
      ),
      React.createElement(
        Button,
        {
          type: "submit",
          variant: "primary",
          disabled: status === "loading" || !querySelection,
          testId: "usage-session-lookup"
        },
        status === "loading" ? "Looking up session" : "Inspect session"
      ),
      querySelection
        ? null
        : React.createElement(
            "span",
            { className: MUTED_META_CLASS, role: "status" },
            "Session history requires a historical Usage scope."
          )
    ),
    status === SESSION_LOOKUP_KIND.INVALID_SESSION_ID
      ? React.createElement(
          "p",
          { className: CALLOUT_WARNING_CLASS, role: "status" },
          "Enter a valid source-confirmed session ID."
        )
      : null,
    status === SESSION_LOOKUP_KIND.UNAVAILABLE
      ? React.createElement(
          "p",
          { className: CALLOUT_WARNING_CLASS, role: "status" },
          "Session telemetry is unavailable for this read."
        )
      : null,
    status === SESSION_LOOKUP_KIND.INVALID_RESPONSE
      ? React.createElement(
          "p",
          { className: CALLOUT_WARNING_CLASS, role: "status" },
          "The session telemetry response was invalid."
        )
      : null,
    evidence?.partial
      ? React.createElement(
          "p",
          { className: CALLOUT_WARNING_CLASS, role: "status" },
          "This session result is partial; the source reached its 200-span bound."
        )
      : null,
    status === "observed" && evidence?.spans.length === 0
      ? React.createElement(
          "p",
          { className: MUTED_BODY_CLASS, role: "status" },
          "No source-confirmed spans were observed for this session in the selected scope."
        )
      : null,
    status === "observed" && evidence && evidence.spans.length > 0
      ? React.createElement(DataTable<UsageSessionSpanSummary>, {
          data: evidence.spans,
          columns: SESSION_COLUMNS,
          keyExtractor: (span: UsageSessionSpanSummary) => span.spanId,
          emptyMessage:
            "No source-confirmed spans were observed for this session.",
          label: "Session activity spans"
        })
      : null
  );
}
