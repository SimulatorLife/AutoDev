import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type {
  EvaluationResult,
  UsageTraceDetail,
  UsageTraceSpan
} from "@simulatorlife/autodev-core";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  InlineDisplayToggle,
  nextRepresentationIndex
} from "../src/components/ui/InlineDisplayToggle.ts";
import { InstantDisplay } from "../src/components/ui/InstantDisplay.ts";
import {
  instantLabel,
  isReadableInstant,
  localInstantText,
  relativeInstantText
} from "../src/components/ui/instant.ts";
import {
  measureRepresentations,
  measureText
} from "../src/components/ui/measure.ts";
import { EvaluationsView } from "../src/features/evaluations/EvaluationsView.ts";
import { UsageView } from "../src/features/usage/UsageView.ts";

const SPAN_ID = "0123456789abcdef";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const TIMESTAMP = "2026-10-07T12:00:00.000Z";
const AT = Date.parse(TIMESTAMP);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function traceDetail(): UsageTraceDetail {
  return {
    schema: "autodev-openlit-trace-detail-v1",
    traceId: TRACE_ID,
    selectedSpanId: SPAN_ID,
    partial: false,
    spans: [
      {
        spanId: SPAN_ID,
        parentSpanId: null,
        spanName: "autodev.logical_request",
        serviceName: "autodev-router",
        timestamp: TIMESTAMP,
        durationNs: 940_000_000,
        statusCode: "OK"
      }
    ] satisfies readonly UsageTraceSpan[]
  };
}

const evaluation: EvaluationResult = {
  id: "run-1",
  spanId: SPAN_ID,
  agentRole: "orchestrator",
  promptName: "review",
  model: "gpt-6-luna",
  metrics: [],
  passed: null,
  timestamp: TIMESTAMP
};

test("relative time reads how far a moment is from now, truncated, in both directions", () => {
  assert.equal(relativeInstantText(TIMESTAMP, AT + 3 * HOUR), "3 hours ago");
  // Fifty-nine minutes ago has not yet been an hour ago.
  assert.equal(
    relativeInstantText(TIMESTAMP, AT + 59 * MINUTE),
    "59 minutes ago"
  );
  assert.equal(relativeInstantText(TIMESTAMP, AT + 1 * MINUTE), "1 minute ago");
  assert.equal(relativeInstantText(TIMESTAMP, AT + 2 * DAY), "2 days ago");
  assert.equal(relativeInstantText(TIMESTAMP, AT + 400 * DAY), "1 year ago");
  // A moment that is now has just passed; a quota reset is still ahead.
  assert.equal(relativeInstantText(TIMESTAMP, AT), "0 seconds ago");
  assert.equal(
    relativeInstantText(TIMESTAMP, AT - 20 * MINUTE),
    "in 20 minutes"
  );
  // A value that is not an instant is shown whole.
  assert.equal(
    relativeInstantText("when the runtime said so", AT),
    "when the runtime said so"
  );
});

test("local time is the full date and time in the operator's zone, never a fixed one", () => {
  assert.equal(
    localInstantText(TIMESTAMP, "America/New_York"),
    "Oct 7, 2026, 8:00 AM"
  );
  assert.equal(
    localInstantText(TIMESTAMP, "Asia/Tokyo"),
    "Oct 7, 2026, 9:00 PM"
  );
  assert.equal(
    localInstantText("when the runtime said so", "UTC"),
    "when the runtime said so"
  );
});

test("the storage form names its zone and leaves a non-instant whole", () => {
  // The pre-hydration text: the server has neither the operator's clock nor
  // their zone, so it writes the instant in the form it is stored in.
  assert.equal(instantLabel(TIMESTAMP), "2026-10-07 12:00:00 UTC");
  assert.equal(instantLabel("2026-10-07"), "2026-10-07");
  assert.equal(
    instantLabel("2026-10-07T12:00:00+02:00"),
    "2026-10-07 12:00:00 +02:00"
  );
  assert.equal(
    instantLabel("when the runtime said so"),
    "when the runtime said so"
  );
  assert.equal(instantLabel(undefined), "");
  assert.equal(isReadableInstant(TIMESTAMP), true);
  assert.equal(isReadableInstant("2026-10-07 12:00:00"), true);
  assert.equal(isReadableInstant("when the runtime said so"), false);
  assert.equal(isReadableInstant(undefined), false);
});

test("InstantDisplay server-renders the machine value and its storage form, never a server-zone local time", () => {
  const markup = renderToStaticMarkup(
    React.createElement(InstantDisplay, { value: TIMESTAMP, label: "Started" })
  );
  assert.equal(
    markup,
    `<time dateTime="${TIMESTAMP}">2026-10-07 12:00:00 UTC</time>`
  );
  // A value that is not an instant claims no \`dateTime\`.
  assert.equal(
    renderToStaticMarkup(
      React.createElement(InstantDisplay, { value: "when the runtime said so" })
    ),
    "<time>when the runtime said so</time>"
  );
  // A moment the source did not record is not observed, not an empty cell.
  for (const value of [null, undefined, ""]) {
    assert.equal(
      renderToStaticMarkup(React.createElement(InstantDisplay, { value })),
      "<span>Not observed</span>"
    );
  }
  // A calendar date names a day, not a moment, so it never becomes a relative
  // or local time (which, west of UTC, would read as the previous day).
  assert.equal(
    renderToStaticMarkup(
      React.createElement(InstantDisplay, { value: "2026-10-07" })
    ),
    '<time dateTime="2026-10-07">2026-10-07</time>'
  );
});

test("the inline display toggle cycles representations behind a labelled native button", () => {
  assert.equal(nextRepresentationIndex(0, 3), 1);
  assert.equal(nextRepresentationIndex(2, 3), 0);
  assert.equal(nextRepresentationIndex(0, 0), 0);

  const markup = renderToStaticMarkup(
    React.createElement(InlineDisplayToggle, {
      label: "Started",
      dataAttribute: "instant",
      representations: [
        { id: "relative", text: "3 hours ago", name: "relative time" },
        {
          id: "local",
          text: "Oct 7, 2026, 8:00 AM",
          name: "local date and time"
        }
      ]
    })
  );
  assert.match(markup, /^<button type="button"/u);
  assert.match(markup, /underline decoration-dotted/u);
  assert.match(markup, /cursor-pointer/u);
  assert.match(markup, /data-inline-display-toggle="instant"/u);
  assert.match(markup, /data-representation="relative"/u);
  assert.match(
    markup,
    /aria-label="Started: 3 hours ago. Activate to show local date and time."/u
  );
  assert.match(markup, />3 hours ago<\/button>$/u);

  // One representation changes nothing when activated, so it is not a control.
  const single = renderToStaticMarkup(
    React.createElement(InlineDisplayToggle, {
      label: "Size",
      representations: [{ id: "bytes", text: "12 bytes", name: "bytes" }]
    })
  );
  assert.doesNotMatch(single, /<button/u);
  assert.match(single, />12 bytes<\/span>$/u);
});

test("a size cycles the measurements its source took, and an unmeasured unit says so", () => {
  assert.equal(measureText({ id: "bytes", value: 1200 }), "1,200 bytes");
  assert.equal(measureText({ id: "characters", value: 1 }), "1 character");
  assert.equal(measureText({ id: "tokens", value: 0 }), "0 tokens");
  assert.equal(
    measureText({ id: "tokens", value: null }),
    "Not observed (tokens)"
  );
  assert.deepEqual(
    measureRepresentations([
      { id: "bytes", value: 1200 },
      { id: "characters", value: 1188 }
    ]),
    [
      { id: "bytes", text: "1,200 bytes", name: "bytes" },
      { id: "characters", text: "1,188 characters", name: "characters" }
    ]
  );
});

test("the same instant reads the same on the Usage trace and the Evaluations trace", () => {
  // Both panels read the same source value through the same component, so the
  // same moment cannot read two ways on two screens.
  const detail = traceDetail();
  const usage = renderToStaticMarkup(
    React.createElement(UsageView, {
      selection: { range: "24H", values: {} },
      traceLookup: { kind: "observed", detail }
    })
  );
  const evaluations = renderToStaticMarkup(
    React.createElement(EvaluationsView, {
      evaluations: [evaluation],
      filters: {
        outcome: "all",
        role: "",
        model: "",
        prompt: "",
        from: "",
        until: ""
      },
      filterOptions: { roles: [], models: [], prompts: [] },
      selection: evaluation.id,
      spanId: SPAN_ID,
      traceLookup: { kind: "observed", detail }
    })
  );
  const rendered = `<time dateTime="${TIMESTAMP}">2026-10-07 12:00:00 UTC</time>`;
  for (const markup of [usage, evaluations]) {
    assert.ok(
      markup.includes(rendered),
      "the instant renders through InstantDisplay"
    );
  }
});

test("an instant has one owner, so no view can spell one of its own", () => {
  // A view that formats an instant itself is how the Console came to answer
  // "when did this happen" in seven spellings. Every timestamp renders through
  // InstantDisplay, which alone reads the formatting owner, instant.ts.
  //
  // The rule is about instants, not about numbers. \`toLocaleString()\` on a
  // count is a thousands separator and stays; on a Date it is a rendering of a
  // moment in the server's own zone.
  const consoleRoot = join(import.meta.dirname, "..");
  const ui = join(consoleRoot, "src", "components", "ui");
  const owners = new Set([
    join(ui, "instant.ts"),
    join(ui, "InstantDisplay.ts")
  ]);
  const offenders: string[] = [];
  for (const dir of ["src", "app"]) {
    for (const relative of readdirSync(join(consoleRoot, dir), {
      recursive: true
    })) {
      const file = join(consoleRoot, dir, relative.toString());
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (!statSync(file).isFile()) continue;
      if (owners.has(file)) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        // A comment quoting the old spelling is documentation of the rule.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        const offence =
          trimmed.includes("toLocaleDateString(") ||
          trimmed.includes("toLocaleTimeString(") ||
          trimmed.includes("Intl.DateTimeFormat(") ||
          trimmed.includes("Intl.RelativeTimeFormat(") ||
          /new Date\([^)]*\)\.toLocaleString\(/u.test(trimmed) ||
          /function (?:format|split|instant)\w*(?:Instant|Timestamp)\w*\s*\(/u.test(
            trimmed
          ) ||
          /from "[./]*(?:components\/ui\/)?instant\.ts"/u.test(trimmed);
        if (offence)
          offenders.push(`${relative.toString()}:${index + 1} ${trimmed}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Render an instant through components/ui/InstantDisplay.ts, not a formatter of its own: ${offenders.join(" | ")}`
  );
});
