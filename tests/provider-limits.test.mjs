import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyCliLimit,
  HARD_LIMIT_CLASSES,
  incompleteDetails,
  INCOMPLETE_REASON_INTERRUPTED,
  INCOMPLETE_REASON_PROVIDER_LIMIT,
  INCOMPLETE_REASON_TIMEOUT,
  isHardLimitClass,
  LIMIT_HEADER_CLASS,
  LIMIT_HEADER_RESETS_AT,
  LIMIT_HEADER_SOURCE,
  LIMIT_HEADER_TYPE,
  LIMIT_SOURCE_INFERRED,
  LIMIT_SOURCE_REPORTED,
  limitPayload,
  limitResponseHeaders,
  normalizeResetsAt,
  readLimitHeaders,
  retryAfterSecondsFromLimit,
  terminalIncompleteEvents,
  truncationNotice,
} from "../scripts/codex/lib/provider-limits.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("normalizes the shapes providers actually state a reset in", () => {
  assert.equal(normalizeResetsAt(1757174400), "2025-09-06T16:00:00.000Z");
  assert.equal(normalizeResetsAt(1757174400000), "2025-09-06T16:00:00.000Z");
  assert.equal(normalizeResetsAt("1757174400"), "2025-09-06T16:00:00.000Z");
  assert.equal(normalizeResetsAt("2026-09-06T15:40:00Z"), "2026-09-06T15:40:00.000Z");
  // A wrong reset time is worse than none: the router stops routing to a
  // provider until whatever it is handed, so anything unparseable is dropped
  // rather than guessed.
  for (const rubbish of [ "garbage", "", null, undefined, {}, Number.NaN ]) {
    assert.equal(normalizeResetsAt(rubbish), null);
  }
});

test("a limit read out of a CLI error message is only ever inferred", () => {
  const quota = classifyCliLimit("agy exited with code 1: quota exceeded for this account");
  assert.equal(quota.limitClass, "quota_exhausted");
  assert.equal(quota.source, LIMIT_SOURCE_INFERRED);

  const throttled = classifyCliLimit("copilot: 429 too many requests");
  assert.equal(throttled.limitClass, "throttled");

  const session = classifyCliLimit("session limit reached for this account");
  assert.equal(session.limitClass, "session_limit");

  assert.equal(classifyCliLimit("agy exited on SIGSEGV"), null);
  assert.equal(classifyCliLimit(""), null);

  // Hard classes hold a provider back for a long window, and a bridge shipping a
  // 4000-character stderr tail must never be able to trigger one. Two things
  // stop it, and both are load-bearing: a bare mention is not a match at all,
  // and even a real match is only ever `inferred`.
  assert.equal(classifyCliLimit("Traceback ... KeyError: 'quota' ... at line 22"), null);
  assert.equal(classifyCliLimit("wrote quota.json and exited"), null);
  assert.ok(isHardLimitClass(quota.limitClass));
  assert.notEqual(quota.source, LIMIT_SOURCE_REPORTED);
});

test("limit headers round-trip through the reader the router uses", () => {
  const limit = { limitClass: "quota_exhausted", limitType: "weekly", resetsAt: "2026-09-06T15:40:00.000Z", source: LIMIT_SOURCE_REPORTED };
  const headers = limitResponseHeaders(limit);
  assert.deepEqual(headers, {
    [LIMIT_HEADER_CLASS]: "quota_exhausted",
    [LIMIT_HEADER_TYPE]: "weekly",
    [LIMIT_HEADER_RESETS_AT]: "2026-09-06T15:40:00.000Z",
    [LIMIT_HEADER_SOURCE]: LIMIT_SOURCE_REPORTED,
  });
  assert.deepEqual(readLimitHeaders(new Headers(headers)), limit);
  assert.deepEqual(limitResponseHeaders(null), {});
  assert.equal(readLimitHeaders(new Headers()), null);

  // An absent reset stays absent rather than becoming an empty header the
  // reader would have to treat as a value.
  assert.equal(LIMIT_HEADER_RESETS_AT in limitResponseHeaders({ limitClass: "throttled" }), false);
  assert.equal(retryAfterSecondsFromLimit({ limitClass: "throttled" }), null);
  assert.equal(retryAfterSecondsFromLimit(limit, Date.parse("2026-09-06T15:39:00.000Z")), 60);
});

test("an incomplete turn carries its work, and says plainly that it is partial", () => {
  const limit = { limitClass: "session_limit", limitType: "session", resetsAt: "2026-09-06T15:40:00.000Z", source: LIMIT_SOURCE_REPORTED };
  const events = terminalIncompleteEvents({
    responseId: "resp_1",
    itemId: "msg_1",
    reasoningId: "rs_1",
    text: "the work so far",
    reasoningText: "thinking",
    reason: INCOMPLETE_REASON_PROVIDER_LIMIT,
    limit,
    provider: "claude",
  });
  assert.deepEqual(events.map(([ name ]) => name), [
    "response.output_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const completed = events.at(-1)[ 1 ].response;
  assert.equal(completed.status, "incomplete");
  assert.deepEqual(completed.incomplete_details, { reason: INCOMPLETE_REASON_PROVIDER_LIMIT, provider_limit: limitPayload(limit) });
  assert.match(completed.output_text, /^the work so far/);
  // A partial answer read as a complete one is worse than a failure, so the
  // notice has to be in the text a model will actually read.
  assert.match(completed.output_text, /\[Incomplete: The claude provider reached its session limit/);
  assert.match(completed.output_text, /nothing after it ran/);
  assert.match(completed.output_text, /resets at 2026-09-06T15:40:00\.000Z/);
  for (const item of completed.output) assert.equal(item.status, "incomplete");

  assert.match(truncationNotice({ reason: INCOMPLETE_REASON_TIMEOUT }), /timed out/);
  assert.match(truncationNotice({ reason: INCOMPLETE_REASON_INTERRUPTED }), /stopped unexpectedly/);
  assert.deepEqual(incompleteDetails(INCOMPLETE_REASON_INTERRUPTED), { reason: INCOMPLETE_REASON_INTERRUPTED });
});

test("the Python bridge mirrors this vocabulary exactly", () => {
  // The Claude bridge is Python and cannot import the module above, so it
  // restates these literals. The router reads what that bridge writes, and a
  // drift between the two would not fail anywhere -- it would quietly stop the
  // router from recognising a declared limit. Hence this guard.
  const bridge = read("scripts/codex-claude-cli-responses-proxy.py");
  const literals = [
    LIMIT_HEADER_CLASS,
    LIMIT_HEADER_TYPE,
    LIMIT_HEADER_RESETS_AT,
    LIMIT_HEADER_SOURCE,
    LIMIT_SOURCE_REPORTED,
    LIMIT_SOURCE_INFERRED,
    INCOMPLETE_REASON_PROVIDER_LIMIT,
    INCOMPLETE_REASON_TIMEOUT,
    INCOMPLETE_REASON_INTERRUPTED,
    ...HARD_LIMIT_CLASSES,
  ];
  for (const literal of literals) {
    assert.match(bridge, new RegExp(`"${literal}"`), `the Python bridge must define ${literal}`);
  }
  for (const name of [ "normalize_resets_at", "classify_cli_limit", "limit_response_headers", "retry_after_seconds_from_limit", "limit_payload", "incomplete_details", "truncation_notice", "terminal_incomplete_events" ]) {
    assert.match(bridge, new RegExp(`def ${name}\\(`), `the Python bridge must implement ${name}`);
  }
  // Both sides emit the same event ordering; the Python list is the one place
  // that could silently reorder.
  const pythonOrder = [ ...bridge.matchAll(/\n {8}\("(response\.[a-z_.]+)", \{"type"/g) ].map((match) => match[ 1 ]);
  assert.deepEqual(pythonOrder, terminalIncompleteEvents({ responseId: "r", itemId: "i", reasoningId: "rs" }).map(([ name ]) => name));
});
