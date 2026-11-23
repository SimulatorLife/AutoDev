/**
 * HTTP headers whose value comes from the environment.
 *
 * AutoDev's MCP surfaces spell an environment-sourced header
 * `{"<Header>": "${VAR}"}`. Codex reads the same header natively as
 * `env_http_headers = { "<Header>" = "VAR" }`, so the two spellings meet where
 * a Codex projection is read: the role configuration keeps Codex's spelling,
 * and every AutoDev-owned surface keeps the reference, so no surface ever
 * holds the credential itself.
 */

/** A header value that is exactly one environment reference. */
const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u;

/**
 * The environment variable a header value names, or null when the value is a
 * literal the server receives as it is.
 */
export function environmentVariableName(value: string): string | null {
  return ENVIRONMENT_REFERENCE.exec(value)?.[1] ?? null;
}

/**
 * Codex's `env_http_headers` table as AutoDev's environment references.
 *
 * Null when the value is not a table of strings: a half-read table would
 * publish a header the operator never declared, so it is refused instead.
 */
export function codexEnvironmentHeaders(
  value: unknown
): Record<string, string> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const headers: Record<string, string> = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header !== "string") return null;
    headers[name] = `\${${header}}`;
  }
  return headers;
}

/**
 * The headers a table carries, with every environment reference resolved
 * against the environment the caller owns.
 *
 * A reference the environment does not answer is kept as it is: the server
 * then receives a reference rather than a credential, which is the outcome the
 * credential being absent would have produced anyway.
 */
export function resolveEnvironmentHeaders(
  headers: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const variable = environmentVariableName(value);
    const credential = variable ? env[variable]?.trim() : undefined;
    resolved[name] = credential ? credential : value;
  }
  return resolved;
}
