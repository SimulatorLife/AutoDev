/**
 * The one owner of "this value is a keyed object".
 *
 * The Runtime reads JSON out of requests, model responses, tool calls and
 * stored records, and the first question about every one of them is the
 * same: is this a keyed object rather than a list, a string, or nothing at
 * all? Every module that asked it kept its own answer, and the answers
 * drifted until some of them accepted an array and some did not -- so the
 * same payload was a record in one place and a list of records in another.
 *
 * The answer is one guard: an object that is neither null nor an array.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
