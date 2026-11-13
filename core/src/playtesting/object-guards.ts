/** Structural guard for object-shaped Playtesting values. */
export function isPlainObject(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
