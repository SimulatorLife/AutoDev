/** Structural guard for non-null, non-array object values decoded from storage or user input. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
