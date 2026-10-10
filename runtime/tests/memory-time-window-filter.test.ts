import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_MAX_TIME_WINDOW_MS } from "@simulatorlife/autodev-core";
import type { MemoryService } from "@simulatorlife/autodev-runtime/memory";

import { handleMemoryControlApiRequest } from "../src/control-api/memory.ts";
import {
  makeRequest,
  type RecordedResponse,
  responseBody,
  responseRecorder
} from "./support/control-api-harness.ts";

/**
 * The optional `occurredFrom`/`occurredUntil` window on every generic memory
 * read. It had no test at all.
 *
 * The bound is the interesting part. `occurredWindow` caps a window at 365 days,
 * and the core type layer enforces the same ceiling for callers that skip the
 * route — so the question this file answers is which of those two actually
 * refuses an over-wide window arriving over HTTP, and whether the route's copy is
 * doing anything at all.
 *
 * It is. An over-wide window over HTTP is refused at the filter, before a store
 * is resolved, which means it costs a 400 rather than a full-table scan of a
 * year-plus of events. Removing the route's copy would not change the wire answer
 * — the core would catch it — but it would move the refusal from a cheap filter
 * rejection to a service call that has already built the request, so the test
 * asserts on the filter's answer and on the fact that the store is never asked.
 *
 * The four refusals are all `invalid_filter`, which is the point: they are
 * malformed requests, not authorization failures, and an operator reading the
 * trail should not be sent looking for a permissions fault. What separates them
 * from each other is the message, and that is what the assertions below name.
 */

const READS = [
  { label: "records", path: "/control/memory/records" },
  { label: "experiences", path: "/control/memory/experiences" }
] as const;

interface AuditEntry {
  readonly action: string;
  readonly resource: string;
  readonly outcome: "ok" | "denied" | "error";
  readonly changes: Record<string, unknown> | null;
  readonly reason?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
  readonly audits: AuditEntry[];
}

/** The store answers, and records the request it was given. */
function recordingService() {
  const requests: Record<string, unknown>[] = [];
  const service = {
    async listExperiences(request: Record<string, unknown>) {
      requests.push(request);
      return { items: [], total: 0, limit: 25, offset: 0 };
    },
    async listMemories(request: Record<string, unknown>) {
      requests.push(request);
      return { items: [], total: 0, limit: 25, offset: 0 };
    }
  } as unknown as MemoryService;
  return { service, requests };
}

async function call(
  route: (typeof READS)[number],
  query: Record<string, string>,
  service = recordingService().service
): Promise<CallResult> {
  const audits: AuditEntry[] = [];
  const response: RecordedResponse = responseRecorder();
  const search = new URLSearchParams({ workspaceId: "ws-1", ...query });
  const suffix = search.toString();
  await handleMemoryControlApiRequest(
    makeRequest("GET", `${route.path}?${suffix}`),
    response,
    route.path,
    { actor: "test-operator", role: "operator" },
    (entry) => audits.push(entry as AuditEntry),
    { createMemoryService: () => service }
  );
  return {
    status: response.statusCode,
    body: responseBody(response),
    audits
  };
}

function errorCode(body: Record<string, unknown> | null): unknown {
  const envelope = body?.error;
  return typeof envelope === "object" && envelope !== null
    ? (envelope as Record<string, unknown>).code
    : undefined;
}

function errorMessage(body: Record<string, unknown> | null): string {
  const envelope = body?.error;
  return typeof envelope === "object" && envelope !== null
    ? String((envelope as Record<string, unknown>).message)
    : "";
}

const FROM = "2026-01-01T00:00:00.000Z";
const UNTIL = "2026-06-01T00:00:00.000Z";

test("a half-supplied window is refused", async () => {
  // Both ends or neither. A one-sided window reads like a filter but means
  // "everything after this" or "everything before this", which is a scan of the
  // whole retention horizon — so the route refuses rather than guessing which.
  //
  // This pins the refusal, not which of two guards produced it. The validator
  // checks that both ends are present and then that both parse, and a one-sided
  // window satisfies neither: the missing end is `undefined`, and
  // `Date.parse(undefined)` is `NaN`, so the parseability guard fires on its
  // own. Removing either guard leaves this green; removing both turns it red.
  // Both messages are deliberately generic on the wire, so there is nothing in
  // the response that could tell them apart.
  for (const route of READS) {
    for (const query of [{ occurredFrom: FROM }, { occurredUntil: UNTIL }]) {
      const { status, body } = await call(route, query);

      assert.equal(
        status,
        400,
        `${route.label}: ${JSON.stringify(query)} was not refused`
      );
      assert.equal(errorCode(body), "autodev_memory_invalid_filter");
    }
  }
});

test("an unparseable timestamp is refused", async () => {
  for (const route of READS) {
    for (const query of [
      { occurredFrom: "not-a-date", occurredUntil: UNTIL },
      { occurredFrom: FROM, occurredUntil: "not-a-date" }
    ]) {
      const { status, body } = await call(route, query);

      assert.equal(
        status,
        400,
        `${route.label}: ${JSON.stringify(query)} was not refused`
      );
      assert.equal(errorCode(body), "autodev_memory_invalid_filter");
    }
  }
});

test("an inverted window is refused", async () => {
  // `until` before `from`. A repository would answer this with an empty page
  // rather than an error, so the route has to refuse it — otherwise a caller
  // reads "no events in this window" when they asked for an impossible one.
  for (const route of READS) {
    const { status, body } = await call(route, {
      occurredFrom: UNTIL,
      occurredUntil: FROM
    });

    assert.equal(
      status,
      400,
      `${route.label}: an inverted window was accepted`
    );
    assert.equal(errorCode(body), "autodev_memory_invalid_filter");
  }
});

test("a window wider than the maximum is refused before the store is asked", async () => {
  // The bound. One millisecond over is enough — a ceiling that rounds would let a
  // caller walk the horizon open a day at a time.
  const width = MEMORY_MAX_TIME_WINDOW_MS + 1;
  const from = new Date(Date.UTC(2024, 0, 1)).toISOString();
  const until = new Date(Date.UTC(2024, 0, 1) + width).toISOString();
  assert.ok(
    Date.parse(until) - Date.parse(from) > MEMORY_MAX_TIME_WINDOW_MS,
    "the fixture must exceed the ceiling by construction"
  );

  for (const route of READS) {
    const { service, requests } = recordingService();
    const { status, body, audits } = await call(
      route,
      { occurredFrom: from, occurredUntil: until },
      service
    );

    assert.equal(
      status,
      400,
      `${route.label}: an over-wide window was accepted ${JSON.stringify(body)}`
    );
    assert.equal(errorCode(body), "autodev_memory_invalid_filter");
    // The refusal has to happen at the filter. The core enforces the same
    // ceiling, so if the store were asked the answer would still be a refusal —
    // but as a service error after the request was built, not as a 400.
    assert.equal(
      requests.length,
      0,
      `${route.label}: the store was asked to scan an over-wide window`
    );
    assert.equal(
      audits.at(-1)?.reason,
      "invalid_filter",
      `${route.label}: the refusal was not audited as a filter error`
    );
  }
});

test("a window exactly at the maximum is accepted", async () => {
  // The other edge. `>` and not `>=`: a caller asking for precisely the horizon
  // the bound names is inside it, and a test that only tried something wider
  // would not notice a bound that had quietly become exclusive.
  const from = new Date(Date.UTC(2024, 0, 1)).toISOString();
  const until = new Date(
    Date.UTC(2024, 0, 1) + MEMORY_MAX_TIME_WINDOW_MS
  ).toISOString();
  assert.equal(
    Date.parse(until) - Date.parse(from),
    MEMORY_MAX_TIME_WINDOW_MS,
    "the fixture must sit exactly on the ceiling"
  );

  for (const route of READS) {
    const { service, requests } = recordingService();
    const { status, body } = await call(
      route,
      { occurredFrom: from, occurredUntil: until },
      service
    );

    assert.equal(
      status,
      200,
      `${route.label}: a window exactly on the bound was refused ${JSON.stringify(body)}`
    );
    assert.equal(requests.length, 1, `${route.label}: the store was not asked`);
  }
});

test("an accepted window reaches the store as both bounds", async () => {
  // The accepting arm. The two filters are forwarded as a pair and the service
  // is what applies them; a filter that parsed but was dropped on the way would
  // answer 200 with the whole unfiltered collection, which is the failure the
  // experiences route already refuses for record-only filters.
  for (const route of READS) {
    const { service, requests } = recordingService();
    const { status, body } = await call(
      route,
      { occurredFrom: FROM, occurredUntil: UNTIL },
      service
    );

    assert.equal(status, 200, `${route.label}: ${JSON.stringify(body)}`);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.occurredFrom, FROM);
    assert.equal(requests[0]?.occurredUntil, UNTIL);
  }
});

test("no window means no window is forwarded", async () => {
  // The absent arm, and the one that a validator can silently break by always
  // returning a pair. Sending `occurredFrom: undefined` is not the same as
  // sending nothing, and only one of them means "no time filter".
  for (const route of READS) {
    const { service, requests } = recordingService();
    const { status } = await call(route, {}, service);

    assert.equal(status, 200, route.label);
    assert.equal(
      Object.hasOwn(requests[0] ?? {}, "occurredFrom"),
      false,
      `${route.label}: an absent window was forwarded as a present one`
    );
    assert.equal(
      Object.hasOwn(requests[0] ?? {}, "occurredUntil"),
      false,
      `${route.label}: an absent window was forwarded as a present one`
    );
  }
});

test("a repeated window bound is refused rather than one of the two winning", async () => {
  // `oneFilter` refuses a repeated parameter. Letting the last one win would
  // mean the window the caller sees in their own URL is not the window that ran.
  for (const route of READS) {
    const search = new URLSearchParams({
      workspaceId: "ws-1",
      occurredFrom: FROM,
      occurredUntil: UNTIL
    });
    search.append("occurredFrom", "2026-02-01T00:00:00.000Z");

    const audits: AuditEntry[] = [];
    const response: RecordedResponse = responseRecorder();
    await handleMemoryControlApiRequest(
      makeRequest("GET", `${route.path}?${search.toString()}`),
      response,
      route.path,
      { actor: "test-operator", role: "operator" },
      (entry) => audits.push(entry as AuditEntry),
      { createMemoryService: () => recordingService().service }
    );

    assert.equal(
      response.statusCode,
      400,
      `${route.label}: a repeated bound was accepted`
    );
    assert.equal(
      errorCode(responseBody(response)),
      "autodev_memory_invalid_filter"
    );
  }
});

test("a window refusal is a filter error, not an authorization refusal", async () => {
  // The distinction the audit trail has to carry. A malformed window is the
  // caller's mistake; an authorization refusal is a permissions fact. Sending an
  // operator to the second when the first is what happened wastes the one thing
  // the trail is for.
  const { status, body, audits } = await call(READS[0], { occurredFrom: FROM });

  assert.equal(status, 400);
  assert.equal(errorCode(body), "autodev_memory_invalid_filter");
  assert.equal(audits.at(-1)?.outcome, "error");
  assert.notEqual(audits.at(-1)?.outcome, "denied");
  assert.equal(audits.at(-1)?.reason, "invalid_filter");
  // The wire message is deliberately generic; the four causes share a code and
  // are told apart by this one line.
  assert.equal(errorMessage(body), "Memory filters are invalid or incomplete.");
});
