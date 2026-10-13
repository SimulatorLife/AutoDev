/**
 * URL helpers for the Agents resource. Every Agents link, toggle return path,
 * and mutation redirect is built here so list rows, detail views, and route
 * handlers agree on one URL shape.
 */

export const AGENTS_PATH = "/agents";

const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const RETURN_PATH_PATTERN = new RegExp(
  String.raw`^/agents(?:/${SEGMENT})?$`,
  "u"
);

export function agentPath(role: string): string {
  return `${AGENTS_PATH}/${encodeURIComponent(role)}`;
}

/** Only Agents pages may be a toggle's return destination. */
export function isAgentsReturnPath(value: string | null): value is string {
  return value !== null && RETURN_PATH_PATTERN.test(value);
}
