// The router sanitises every OpenTelemetry dimension, metric label and
// aggregation key through `safeMetricLabel`. This module has no router-internal
// imports so every router module can depend on it without creating a cycle.

// Strip ASCII control characters from a metric label without using a
// regular expression. `eslint-plugin-regexp/no-control-regex` rejects raw
// control characters inside regex character classes, so we walk the string
// once with `charCodeAt`.
function stripAsciiControlCharacters(value: string): string {
  let stripped = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) continue;
    stripped += value[index];
  }
  return stripped;
}

/**
Reduce an arbitrary value to a bounded, control-character-free label that
is safe to use as an OpenTelemetry dimension or aggregation key.
*/
export function safeMetricLabel(value: unknown, fallback = "unknown"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return stripAsciiControlCharacters(value.trim()).slice(0, 100) || fallback;
}
