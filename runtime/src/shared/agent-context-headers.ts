/** Authenticated router-to-agent bridge context header names. */
export const AGENT_ROLE_HEADER = "x-autodev-agent-role";
export const SANDBOX_MODE_HEADER = "x-autodev-sandbox-mode";

/**
 * Optional router-to-bridge context carrying the selected skill body for
 * child threads; it is sent only on role-routed requests.
 */
export const SKILL_CONTEXT_HEADER = "x-autodev-skill-context";
export const CODEX_SESSION_HEADER = "x-autodev-codex-session";

/**
 * The raw value of one inbound context header, or undefined when it was not
 * sent. Names match case-insensitively: Node lowercases inbound header names,
 * but LiteLLM and other intermediaries can preserve the case the router sent.
 * `name` must already be lowercase. Array-valued headers yield their first
 * element.
 */
export function readContextHeader(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find(
    (candidate) => candidate.toLowerCase() === name
  );
  if (key === undefined) return undefined;
  const value = record[key];
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
