/** Authenticated router-to-agent bridge context header names. */
export const AGENT_ROLE_HEADER = "x-autodev-agent-role";
export const READ_ONLY_HEADER = "x-autodev-read-only";

/**
 * Optional router-to-bridge context carrying the selected skill body for
 * child threads; it is sent only on role-routed requests.
 */
export const SKILL_CONTEXT_HEADER = "x-autodev-skill-context";
export const CODEX_SESSION_HEADER = "x-autodev-codex-session";
export const PROVIDER_HOP_HEADER = "x-autodev-provider-hop";

/**
 * True when the router flagged this request as an orchestrator hop to a
 * different provider than the one that previously served the thread/turn.
 */
export function isProviderHopHeader(headers: unknown): boolean {
  const value = contextHeaderValue(headers, PROVIDER_HOP_HEADER, {
    lowercase: true
  });
  return value === "1" || value === "true";
}

/**
 * The raw value of one inbound context header, or undefined when it was not
 * sent. Names match case-insensitively: Node lowercases inbound header names,
 * but LiteLLM and other intermediaries can preserve the case the router sent.
 * `name` must already be lowercase. Array-valued headers yield their first
 * element.
 */
export function readContextHeader(headers: unknown, name: string): unknown {
  const record =
    headers && typeof headers === "object"
      ? (headers as Record<string, unknown>)
      : {};
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name
  );
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One inbound context header as a trimmed string, or null when it is missing,
 * empty, or not a string. `lowercase` also lowercases the trimmed value for
 * enum-like headers.
 */
export function contextHeaderValue(
  headers: unknown,
  name: string,
  options: { readonly lowercase?: boolean } = {}
): string | null {
  const value = readContextHeader(headers, name);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return options.lowercase ? trimmed.toLowerCase() : trimmed;
}
