import assert from "node:assert/strict";
import test from "node:test";

import type { QuotaAxiResponse } from "quota-axi";

import {
  QUOTA_READ_INTERVAL_MS,
  QuotaPoll,
  type QuotaPollPlan
} from "../src/router/quota-poll.ts";

type QuotaProvider = QuotaAxiResponse["providers"][number];

function report(
  providers: readonly QuotaProvider[],
  generatedAt = "2026-11-15T16:40:18.000Z"
): QuotaAxiResponse {
  return { generatedAt, schemaVersion: 5, providers: [...providers] };
}

function provider(
  name: string,
  overrides: Partial<QuotaProvider> = {}
): QuotaProvider {
  return {
    provider: name,
    windows: [],
    state: { status: "fresh", stale: false },
    ...overrides
  } as QuotaProvider;
}

const NOW = Date.parse("2026-11-15T16:40:18.000Z");
const MINUTE = 60_000;
const CLAUDE_INTERVAL = QUOTA_READ_INTERVAL_MS.claude!;

const SESSION_WINDOW = {
  id: "five_hour",
  label: "session",
  kind: "session",
  percentUsed: 6,
  percentRemaining: 94,
  resetsAt: "2026-11-15T20:40:00.000Z"
} as QuotaProvider["windows"][number];

const RATE_LIMITED_CLAUDE = provider("claude", {
  state: {
    status: "rate_limited",
    stale: false,
    error: "Claude quota endpoint rate limited",
    retryAfter: "2026-11-15T17:38:15.000Z"
  }
});

const FULL_READ: QuotaPollPlan = { providers: null, deferred: new Set() };

/** A poll that has made one full read of `providers` at `at`. */
function pollAfterRead(
  providers: readonly QuotaProvider[],
  at = NOW,
  intervals?: Readonly<Record<string, number>>
): QuotaPoll {
  const poll = new QuotaPoll(intervals);
  assert.deepEqual(poll.plan(at), FULL_READ);
  poll.accept(report(providers), FULL_READ, at);
  return poll;
}

test("the first read asks every provider quota-axi knows", () => {
  const poll = new QuotaPoll();
  assert.equal(poll.report, null);
  assert.deepEqual(poll.plan(NOW), FULL_READ);
});

test("a provider that was refused is not read again before its retry moment", () => {
  const poll = pollAfterRead([RATE_LIMITED_CLAUDE, provider("codex")]);

  const plan = poll.plan(NOW + CLAUDE_INTERVAL + MINUTE);
  assert.deepEqual(plan?.providers, ["codex"]);
  assert.deepEqual([...(plan?.deferred ?? [])], ["claude"]);
});

test("a stale reading served under a refusal is held to the same retry moment", () => {
  // quota-axi answers a refused Claude read with its last good windows marked
  // stale, and the refusal's retry moment rides on that stale entry. Asking
  // again before it is still the request the vendor asked us not to make.
  const poll = pollAfterRead([
    provider("claude", {
      windows: [SESSION_WINDOW],
      state: {
        status: "stale",
        stale: true,
        refreshedAt: "2026-11-15T16:20:00.000Z",
        error: "Claude quota endpoint rate limited",
        retryAfter: "2026-11-15T17:38:15.000Z"
      }
    }),
    provider("codex")
  ]);

  const plan = poll.plan(NOW + CLAUDE_INTERVAL + MINUTE);
  assert.deepEqual(plan?.providers, ["codex"]);
  assert.ok(plan?.deferred.has("claude"));
});

test("a retry moment that has passed is asked again", () => {
  const poll = pollAfterRead([RATE_LIMITED_CLAUDE]);
  assert.deepEqual(
    poll.plan(Date.parse("2026-11-15T17:38:16.000Z")),
    FULL_READ
  );
});

test("a refusal that names no retry moment waits only for the read interval", () => {
  const poll = pollAfterRead([
    provider("claude", { state: { status: "rate_limited", stale: false } })
  ]);

  assert.equal(poll.plan(NOW + MINUTE), null);
  assert.deepEqual(poll.plan(NOW + CLAUDE_INTERVAL), FULL_READ);
});

test("Claude's quota endpoint is read at most once per its read interval", () => {
  // Anthropic's usage endpoint refuses after a handful of reads and holds the
  // refusal for close to an hour, so a sixty-second poll kept Claude's quota
  // unreadable indefinitely. Every other provider is still read every tick.
  assert.ok(CLAUDE_INTERVAL >= 5 * MINUTE);
  const poll = pollAfterRead([
    provider("claude", { windows: [SESSION_WINDOW] }),
    provider("codex")
  ]);

  for (let tick = 1; tick * MINUTE < CLAUDE_INTERVAL; tick += 1) {
    const plan = poll.plan(NOW + tick * MINUTE);
    assert.deepEqual(plan?.providers, ["codex"], `tick ${tick}`);
    poll.accept(report([provider("codex")]), plan!, NOW + tick * MINUTE);
  }
  assert.deepEqual(poll.plan(NOW + CLAUDE_INTERVAL), FULL_READ);
});

test("providers without a read interval are read on every tick", () => {
  const poll = pollAfterRead([
    provider("codex"),
    provider("copilot", { state: { status: "unavailable", stale: false } }),
    provider("minimax", { state: { status: "auth_required", stale: false } })
  ]);

  assert.deepEqual(poll.plan(NOW + MINUTE), FULL_READ);
});

test("a tick on which every provider is waiting reads nothing", () => {
  const poll = pollAfterRead([RATE_LIMITED_CLAUDE]);
  assert.equal(poll.plan(NOW + MINUTE), null);
});

test("a deferred provider keeps its own entry while it waits", () => {
  // The entry is the report's own: its state, its windows, its error and its
  // retry moment are carried forward unchanged, so the Console keeps drawing
  // what was last read and saying why it is not newer.
  const poll = pollAfterRead([RATE_LIMITED_CLAUDE, provider("codex")]);
  const at = NOW + MINUTE;
  const plan = poll.plan(at)!;

  poll.accept(
    report([provider("codex")], "2026-11-15T16:41:18.000Z"),
    plan,
    at
  );
  const merged = poll.report!;
  assert.deepEqual(
    merged.providers.map((entry) => entry.provider),
    ["codex", "claude"]
  );
  assert.deepEqual(
    merged.providers.find((entry) => entry.provider === "claude"),
    RATE_LIMITED_CLAUDE
  );
  assert.equal(merged.generatedAt, "2026-11-15T16:41:18.000Z");
});

test("a read with nothing deferred is the report that was read", () => {
  const poll = pollAfterRead([provider("codex")]);
  const next = report([provider("claude")], "2026-11-15T16:41:18.000Z");
  poll.accept(next, FULL_READ, NOW + MINUTE);
  assert.deepEqual(poll.report, next);
});

test("a restarted router keeps the retry moment and the read interval", () => {
  // Every router restart used to start from an empty record and ask every
  // vendor at once, spending a refused provider's read the moment it came up.
  const before = pollAfterRead([
    RATE_LIMITED_CLAUDE,
    provider("minimax", { windows: [SESSION_WINDOW] })
  ]);
  const persisted = structuredClone(before.persistenceSnapshot());

  const after = new QuotaPoll({
    claude: CLAUDE_INTERVAL,
    minimax: 10 * MINUTE
  });
  assert.equal(after.restore(persisted), true);
  assert.deepEqual(after.report, before.report);
  assert.equal(after.plan(NOW + 2 * MINUTE), null);
  assert.deepEqual(after.plan(NOW + 10 * MINUTE)?.providers, ["minimax"]);
});

test("a malformed persisted record is discarded and the poll reads everything", () => {
  for (const value of [
    null,
    "report",
    { report: { generatedAt: 1, providers: [] }, readAt: {} },
    { report: { generatedAt: "x", providers: [{ provider: "claude" }] } }
  ]) {
    const poll = pollAfterRead([RATE_LIMITED_CLAUDE]);
    assert.equal(poll.restore(value), false);
    assert.equal(poll.report, null);
    assert.deepEqual(poll.plan(NOW), FULL_READ);
  }
});

test("a persisted record with unusable read times keeps only the usable ones", () => {
  const poll = new QuotaPoll();
  assert.equal(
    poll.restore({
      report: report([provider("claude")]),
      readAt: { claude: "yesterday", codex: NOW }
    }),
    true
  );
  assert.deepEqual(poll.persistenceSnapshot().readAt, { codex: NOW });
  assert.deepEqual(poll.plan(NOW + MINUTE), FULL_READ);
});
