/**
 * The one owner of "this value is a keyed object" and "this value is a count".
 *
 * The Runtime, the Data layer and the Console all read JSON out of requests,
 * model responses, tool calls and stored records, and the first questions
 * about every one of them are the same: is this a keyed object rather than a
 * list, a string, or nothing at all, and is this field a non-negative integer
 * count within safe bounds? Every module that asked those questions kept its
 * own answer, and the answers drifted until some of them accepted an array
 * and some did not -- so the same payload was a record in one place and a
 * list of records in another.
 *
 * The answer is one pair of guards: an object that is neither null nor an
 * array, and a safe non-negative integer no larger than its ceiling.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCount(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= max
  );
}
