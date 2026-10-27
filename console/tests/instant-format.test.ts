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
  instantClock,
  instantDate,
  instantLabel,
  isReadableInstant,
  splitInstant
} from "../src/components/ui/instant.ts";
import { EvaluationsView } from "../src/features/evaluations/EvaluationsView.ts";
import { UsageView } from "../src/features/usage/UsageView.ts";

const SPAN_ID = "0123456789abcdef";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const TIMESTAMP = "2026-10-07T12:00:00.000Z";

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

test("an instant has one rendering", () => {
  // The Console used to answer "when did this happen" in seven spellings. The
  // memory records table read a record's update as `2/11/2026`, which is
  // ambiguous outside the United States and carries no time; the memory detail
  // lines beside it read `2/11/2026, 3:00:12 AM`, which is worse, because
  // `toLocaleString()` renders in the *server's* zone rather than the
  // operator's; the GitHub page printed the raw wire value with its
  // milliseconds; the evaluations table spoke the zone as `Z` and the usage
  // trace spoke the same zone as `UTC`.
  //
  // An instant is one quantity, so it has one rendering.
  assert.equal(instantLabel(TIMESTAMP), "2026-10-07 12:00:00 UTC");
  assert.equal(instantDate(TIMESTAMP), "2026-10-07");
  assert.equal(instantClock(TIMESTAMP), "12:00:00 UTC");
  assert.equal(splitInstant(TIMESTAMP).date, "2026-10-07");
  assert.equal(splitInstant(TIMESTAMP).clock, "12:00:00");
  assert.equal(splitInstant(TIMESTAMP).offset, "Z");

  // A date with no clock is a date, and it is not padded with a time the
  // source never carried.
  assert.equal(instantLabel("2026-10-07"), "2026-10-07");
  assert.equal(instantClock("2026-10-07"), "");

  // A source that stated a zone that is not UTC keeps it: relabelling
  // `+02:00` as `Z` would be a claim about the data rather than about its
  // formatting.
  assert.equal(
    instantLabel("2026-10-07T12:00:00+02:00"),
    "2026-10-07 12:00:00 +02:00"
  );

  // A value that is not an instant at all is shown whole: a value that cannot
  // be cut into parts is not cut into parts.
  assert.equal(
    instantLabel("when the runtime said so"),
    "when the runtime said so"
  );
  assert.equal(
    instantDate("when the runtime said so"),
    "when the runtime said so"
  );
  assert.equal(isReadableInstant(TIMESTAMP), true);
  assert.equal(isReadableInstant("2026-10-07 12:00:00"), true);
  assert.equal(isReadableInstant("when the runtime said so"), false);

  // A moment the Console was not given is not a moment, and asking the owner
  // for one must not take the page down. The cohorts view is rendered by the
  // Memory page, which always narrows the collection to a window, and by the
  // acceptance, which renders the view on its own -- and the second one has no
  // window to give. A formatter that threw there would take the whole page
  // down over a row that was never going to be read.
  assert.equal(instantDate(undefined), "");
  assert.equal(instantLabel(undefined), "");
  assert.equal(instantClock(undefined), "");
  assert.equal(isReadableInstant(undefined), false);
});

test("the same instant reads the same on the Usage trace and the Evaluations trace", () => {
  // The two panels read the same source value, so they have to render it the
  // same way. The Evaluations table splits the instant into a date and a
  // clock so a narrow column can fold between them, and the Usage table
  // joins them onto one line -- but the parts are the same parts, spelled the
  // same way, or the same moment reads two ways on two screens.
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

  for (const markup of [usage, evaluations]) {
    assert.ok(markup.includes("2026-10-07"), "the date reads as an ISO date");
    assert.ok(markup.includes("12:00:00 UTC"), "the clock names its zone");
  }
  // The raw wire value is still there, in the attributes that want it: the
  // machine-readable form belongs in `dateTime`, and the whole value belongs on
  // the title, so a truncated or a misread one can be recovered. What must not
  // happen is the *text* a reader sees being the raw value, and that is a
  // question about the rendered page rather than about the markup -- the
  // browser acceptance asks it.
});

test("an instant has one owner, so no view can spell one of its own", () => {
  // A view that formats an instant itself is how the seven spellings drifted
  // apart in the first place: a locale call in a view is a second owner of a
  // quantity the Console renders in several places.
  //
  // The rule is about instants, not about numbers. `toLocaleString()` on a
  // count is a thousands separator and stays; `toLocaleString()` on a Date is
  // a rendering of a moment in the server's own zone, and the Console has one
  // owner for that now.
  const consoleRoot = join(import.meta.dirname, "..");
  const owner = join(consoleRoot, "src", "components", "ui", "instant.ts");
  const offenders: string[] = [];
  for (const dir of ["src", "app"]) {
    for (const relative of readdirSync(join(consoleRoot, dir), {
      recursive: true
    })) {
      const file = join(consoleRoot, dir, relative.toString());
      if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
      if (!statSync(file).isFile()) continue;
      if (file === owner) continue;
      const source = readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        const trimmed = line.trim();
        // A comment quoting the old spelling is documentation of the rule, not
        // a second owner of it.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (trimmed.includes("toLocaleDateString(")) {
          offenders.push(`${relative.toString()}:${index + 1} ${trimmed}`);
        }
        if (/new Date\([^)]*\)\.toLocaleString\(/u.test(trimmed)) {
          offenders.push(`${relative.toString()}:${index + 1} ${trimmed}`);
        }
        if (
          /function (?:format|split|instant)\w*Instant\w*\s*\(/u.test(trimmed)
        ) {
          offenders.push(`${relative.toString()}:${index + 1} ${trimmed}`);
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Render an instant through components/ui/instant.ts, not with a locale call of its own: ${offenders.join(" | ")}`
  );
});
