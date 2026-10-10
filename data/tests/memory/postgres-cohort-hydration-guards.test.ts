import assert from "node:assert/strict";
import test from "node:test";

import { PostgresMemoryRepository } from "../../src/memory/postgres-memory-repository.ts";
import { MemoryHydrationError } from "../../src/memory/errors.ts";
import { makeContext } from "./fixtures/builders.ts";
import type {
  MemoryConnectionPool,
  MemoryQueryResult
} from "../../src/memory/query-client.ts";

/**
 * The cohort aggregates refuse to hydrate a cell that cannot exist.
 *
 * `aggregateInjectionOutcomeCohorts` groups by
 * `(memoryMode, injectionResult, sessionCardinality, reportKind, outcomeKind)`
 * and counts exposures and reports per cell. Two things about a row are
 * impossible rather than merely unusual: a cell reporting more outcomes than it
 * has exposures, and a session cardinality outside `single | multiple`.
 *
 * Left unchecked, the first renders as a report rate above 100% — a rate the
 * Console's own cohort cards would then divide into — and the second puts an
 * unnameable value into an enumerated field. Both fail loudly instead, naming
 * the table and column, because a silently-wrong cell is indistinguishable from
 * a finding.
 *
 * The rows come from a `GROUP BY … COUNT(…)` query, so a fake pool seeded with
 * consistent tables cannot produce them: the SQL would never emit them. These
 * cases feed the hydration step directly, which is the step being guarded — the
 * point is that the repository does not take the query's word for it.
 */

type CohortRow = Record<string, unknown>;

const cohortFilterBase = {
  context: makeContext({ workspaceId: "ws-1", repositoryId: "repo-1" }),
  occurredFrom: "2025-12-31T00:00:00.000Z",
  occurredUntil: "2026-01-10T00:00:00.000Z"
};

/** Answers the cohort query with exactly the rows given. */
function poolReturning(rows: CohortRow[]): MemoryConnectionPool {
  // Generic because `MemoryQueryable.query` is: each caller narrows to the row
  // type it expects, so a stub cannot declare one shape for every query.
  const query = async <Row extends Record<string, unknown>>() =>
    ({ rows, rowCount: rows.length }) as unknown as MemoryQueryResult<Row>;
  return {
    query,
    connect: async () => ({ query, release: () => {} }),
    end: async () => {}
  };
}

function wellFormedCell(overrides: CohortRow = {}): CohortRow {
  return {
    memory_mode: "jit",
    injection_result: "injected",
    session_cardinality: "single",
    report_kind: "task",
    outcome_kind: "success",
    exposure_count: "4",
    report_count: "2",
    ...overrides
  };
}

const useCohortFilterBase = {
  context: makeContext({ workspaceId: "ws-1", repositoryId: "repo-1" }),
  occurredFrom: "2025-12-31T00:00:00.000Z",
  occurredUntil: "2026-01-10T00:00:00.000Z"
};

function useCell(overrides: CohortRow = {}): CohortRow {
  return {
    memory_mode: "jit",
    session_cardinality: "single",
    use_kind: "used",
    exposure_count: "4",
    ...overrides
  };
}

test("a well-formed cohort cell hydrates, so the cases below are reaching it", () => {
  // Without this the two refusals could be passing on a stub that never got as
  // far as the cell map at all.
  return assert.doesNotReject(async () => {
    const repository = new PostgresMemoryRepository({
      pool: poolReturning([wellFormedCell()])
    });
    const page =
      await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);

    assert.equal(page.cells.length, 1);
    assert.equal(page.cells[0]?.exposureCount, 4);
    assert.equal(page.cells[0]?.reportCount, 2);
  });
});

test("a cell claiming more reports than exposures is refused", async () => {
  const repository = new PostgresMemoryRepository({
    pool: poolReturning([
      wellFormedCell({ exposure_count: "3", report_count: "7" })
    ])
  });

  await assert.rejects(
    repository.aggregateInjectionOutcomeCohorts(cohortFilterBase),
    (error: unknown) =>
      error instanceof MemoryHydrationError &&
      /report_count 7 exceeds exposure_count 3/u.test(error.message)
  );
});

test("a cell with an unknown session cardinality is refused", async () => {
  const repository = new PostgresMemoryRepository({
    pool: poolReturning([wellFormedCell({ session_cardinality: "many" })])
  });

  await assert.rejects(
    repository.aggregateInjectionOutcomeCohorts(cohortFilterBase),
    (error: unknown) =>
      error instanceof MemoryHydrationError &&
      /expected "single" or "multiple", got many/u.test(error.message)
  );
});

test("a cell where every exposure is reported is legal", async () => {
  // The boundary. `report_count === exposure_count` means every exposure was
  // reported on, which is the best case rather than an impossible one — so the
  // comparison has to be strict `>`. Nothing else here pins that: the well-formed
  // cell above is under-reported, and a guard loosened from `>` to `>=` would
  // still pass every other case in this file.
  const repository = new PostgresMemoryRepository({
    pool: poolReturning([
      wellFormedCell({ exposure_count: "6", report_count: "6" })
    ])
  });

  const page =
    await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);

  assert.equal(page.cells.length, 1);
  assert.equal(page.cells[0]?.reportCount, 6);
});

test("a use-cohort cell with an unknown session cardinality is refused", async () => {
  // The same guard, duplicated in the other aggregate. It is a separate copy in
  // a separate method, so covering one says nothing about the other — which is
  // why this is not folded into the outcome-cohort cases above.
  const repository = new PostgresMemoryRepository({
    pool: poolReturning([useCell({ session_cardinality: "one" })])
  });

  await assert.rejects(
    repository.aggregateInjectionUseCohorts(useCohortFilterBase),
    (error: unknown) =>
      error instanceof MemoryHydrationError &&
      /expected "single" or "multiple", got one/u.test(error.message)
  );
});

test("a use-cohort cell in an ineligible mode is refused", async () => {
  // Use cohorts are built only from actually-injected eligible packets, so a
  // `disabled` row cannot come from the query. The Console reads these cells as
  // assessment coverage; a disabled arm folded in would dilute the denominator
  // with sessions that were given no packet to assess.
  const repository = new PostgresMemoryRepository({
    pool: poolReturning([useCell({ memory_mode: "disabled" })])
  });

  await assert.rejects(
    repository.aggregateInjectionUseCohorts(useCohortFilterBase),
    (error: unknown) =>
      error instanceof MemoryHydrationError &&
      /expected eligible use mode, got disabled/u.test(error.message)
  );
});

test("a null session cardinality is refused rather than read as unknown", async () => {
  // The obvious neighbouring case: a LEFT JOIN produces NULL here, and the
  // default a cell would fall back to is an enumerated value that means
  // something specific. Passing it through as `undefined` would drop the cell's
  // cardinality from the tuple it was grouped by.
  const repository = new PostgresMemoryRepository({
    pool: poolReturning([wellFormedCell({ session_cardinality: null })])
  });

  await assert.rejects(
    repository.aggregateInjectionOutcomeCohorts(cohortFilterBase),
    (error: unknown) =>
      error instanceof MemoryHydrationError &&
      /session_cardinality/u.test(error.message)
  );
});
/**
 * `parseCohortCount` is the primitive every guard above is built on, and it had
 * no failing test of its own. Each case in this file feeds it a well-formed
 * count — `"4"`, `"2"`, `"3"` — because that is what the query can emit, so a
 * version that dropped its check and returned `Number(value)` outright would
 * pass all of them.
 *
 * The driver's own shape is the positive control and has to stay legal:
 * `COUNT(...)::bigint` arrives as a *string*, and `Number("4") === 4` is the
 * whole reason this function exists rather than a plain cast.
 */
test("a count that is not a non-negative integer is refused, not coerced", async () => {
  for (const [label, value] of [
    ["a non-numeric string", "not-a-number"],
    ["a negative count", "-1"],
    ["a fractional count", "1.5"],
    ["a missing count", undefined],
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["a null count", null],
    ["a boolean", true]
  ] as const) {
    const repository = new PostgresMemoryRepository({
      pool: poolReturning([wellFormedCell({ exposure_count: value })])
    });

    await assert.rejects(
      repository.aggregateInjectionOutcomeCohorts(cohortFilterBase),
      (error: unknown) =>
        error instanceof MemoryHydrationError &&
        /expected a non-negative safe integer/u.test(error.message),
      `${label} must be refused rather than coerced`
    );
  }
});

test("a bigint string and a zero count are both legal, so the guard is not 'reject everything'", async () => {
  for (const [label, value] of [
    ["a driver bigint string", "4"],
    ["zero", "0"],
    ["a large-but-safe count", "9007199254740991"]
  ] as const) {
    const repository = new PostgresMemoryRepository({
      pool: poolReturning([
        wellFormedCell({ exposure_count: value, report_count: "0" })
      ])
    });

    const page =
      await repository.aggregateInjectionOutcomeCohorts(cohortFilterBase);
    assert.equal(
      page.cells[0]?.exposureCount,
      Number(value),
      `${label} must still hydrate`
    );
  }
});

test("a use-cohort cell with an unknown use kind is refused", async () => {
  // The third enumerated field on this row, and the only one of the three that
  // the cases above leave alone: `session_cardinality` and `memory_mode` are
  // both refused above, while `use_kind` sits beside them behind a `?? null`
  // and a membership test that nothing could reach. A cell grouped by an
  // unrecognised use kind is what the Console reads as assessment coverage.
  const repository = new PostgresMemoryRepository({
    pool: poolReturning([useCell({ use_kind: "maybe" })])
  });

  await assert.rejects(
    repository.aggregateInjectionUseCohorts(useCohortFilterBase),
    (error: unknown) =>
      error instanceof MemoryHydrationError &&
      /expected a bounded use kind, got maybe/u.test(error.message)
  );

  // The positive control, and it is the reason the check is `useKind !== null
  // && ...`: a LEFT JOIN produces NULL here for an exposure nobody assessed,
  // which is a real and common cell rather than a malformed one.
  const unreported = new PostgresMemoryRepository({
    pool: poolReturning([useCell({ use_kind: null })])
  });
  const page =
    await unreported.aggregateInjectionUseCohorts(useCohortFilterBase);
  assert.equal(
    page.cells[0]?.useKind,
    null,
    "an exposure with no assessment must hydrate with a null use kind"
  );
});
