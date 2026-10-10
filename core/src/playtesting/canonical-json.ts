/** Deterministic, strict JSON encoding for hashes of Playtesting manifests. */

export function canonicalPlaytestJson(value: unknown): string {
  return encode(value, new Set());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "Canonical Playtest JSON cannot contain non-finite numbers."
      );
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value))
      throw new TypeError("Canonical Playtest JSON cannot be cyclic.");
    ancestors.add(value);
    const encoded =
      "[" + value.map((item) => encode(item, ancestors)).join(",") + "]";
    ancestors.delete(value);
    return encoded;
  }
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical Playtest JSON requires plain objects.");
    }
    if (ancestors.has(value))
      throw new TypeError("Canonical Playtest JSON cannot be cyclic.");
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    const encoded =
      "{" +
      Object.keys(record)
        .sort()
        .map(
          (key) => JSON.stringify(key) + ":" + encode(record[key], ancestors)
        )
        .join(",") +
      "}";
    ancestors.delete(value);
    return encoded;
  }
  throw new TypeError("Canonical Playtest JSON contains an unsupported value.");
}
