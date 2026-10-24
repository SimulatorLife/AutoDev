/**
 * Is this failure just "nothing is listening on the ClickHouse port"?
 *
 * `fetch` never reports the socket error. It raises `TypeError: fetch failed`
 * and hides the cause a level or two down -- on `cause` when one address was
 * tried, or inside `errors` when several were and Node wrapped them in an
 * `AggregateError`. A guard that reads only `error.message` therefore never
 * matches, so a sync test that was written to skip when the OpenLIT container
 * is not running instead fails with a connection stack trace that looks like a
 * product defect.
 *
 * A request that did not come back within the client's ceiling is the same
 * thing from the caller's side: the ClickHouse the test wanted is not
 * answering. `AbortSignal.timeout` reports it as a `TimeoutError`, so the
 * guard reads that name as well as the socket codes.
 */
export function isClickHouseUnavailable(error: unknown): boolean {
  for (const candidate of causedErrors(error)) {
    if (codeOf(candidate) === "ECONNREFUSED") return true;
    if (nameOf(candidate) === "TimeoutError") return true;
    if (nameOf(candidate) === "AbortError") return true;
  }
  return false;
}

function* causedErrors(
  error: unknown,
  depth = 0
): Generator<{ code?: unknown; name?: unknown }> {
  if (depth > 5 || typeof error !== "object" || error === null) return;
  yield error;
  const wrapped = error as {
    code?: unknown;
    name?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (Array.isArray(wrapped.errors)) {
    for (const nested of wrapped.errors) yield* causedErrors(nested, depth + 1);
  }
  yield* causedErrors(wrapped.cause, depth + 1);
}

function codeOf(error: { code?: unknown }): unknown {
  return error.code;
}

function nameOf(error: { name?: unknown }): unknown {
  return error.name;
}
