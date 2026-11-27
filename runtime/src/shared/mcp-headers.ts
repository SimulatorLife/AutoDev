/**
Canonical MCP HTTP header references and backend-only credential resolution.
RuleSync projections keep references; only the remote transport resolves them.
*/
import { validateHeaderName, validateHeaderValue } from "node:http";

import { isRecord } from "@simulatorlife/autodev-core";

import { readRuntimeSecret, resolveManagedSecret } from "./runtime-secrets.ts";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u;
// Match malformed/unclosed placeholders too, so they cannot escape validation.
const ENVIRONMENT_TEMPLATE = /\$\{[^}]*(?:\}|$)/gu;

// The MCP SDK owns these protocol/stream headers, and the HTTP client owns
// connection and message framing. Configuration must not override either.
const TRANSPORT_HEADERS = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export interface RemoteBackendSpec {
  url: string;
  bearer_token_env_var?: string | undefined;
  http_headers?: Record<string, string> | undefined;
}

export function environmentVariableName(value: string): string | null {
  return ENVIRONMENT_REFERENCE.exec(value)?.[1] ?? null;
}

/**
Use native HTTP validation and case-insensitive Headers semantics.
*/
function addDeclaredHeader(
  headers: Headers,
  name: string,
  value: string
): void {
  try {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    if (TRANSPORT_HEADERS.has(name.toLowerCase()) || headers.has(name)) {
      throw new Error("Conflicting header");
    }
    headers.set(name, value);
  } catch {
    // Native exceptions can contain header names/values. Do not propagate
    // them across the tool boundary, even as a nested cause.
    throw new Error("Invalid or conflicting remote MCP header declaration.");
  }
}

/**
Codex's env_http_headers table as unresolved AutoDev references.
*/
export function codexEnvironmentHeaders(
  value: unknown
): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const checked = new Headers();
  const entries: Array<[string, string]> = [];
  try {
    for (const [name, variable] of Object.entries(value)) {
      if (typeof variable !== "string" || !ENVIRONMENT_NAME.test(variable)) {
        return null;
      }
      const reference = `\${${variable}}`;
      addDeclaredHeader(checked, name, reference);
      entries.push([name, reference]);
    }
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

/**
Resolve credentials immediately before opening the SDK transport. Missing
credentials, invalid references, case-insensitive collisions and attempts
to override SDK-owned headers fail closed, never yielding a partial table.
*/
export function resolveRemoteMcpHeaders(
  spec: RemoteBackendSpec,
  server: string,
  environment_: NodeJS.ProcessEnv = process.env
): Headers {
  // Do not let a variable lookup fall through to Object.prototype.
  const environment: NodeJS.ProcessEnv = Object.assign(
    Object.create(null),
    environment_
  );
  const resolveSecret = (name: string): string => {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error("Invalid remote MCP credential reference.");
    }
    let value: string | null;
    try {
      value =
        resolveManagedSecret(name, environment) ??
        readRuntimeSecret(name, environment);
    } catch {
      throw new Error("Remote MCP credential resolution failed.");
    }
    if (!value) {
      const label = /^[A-Za-z0-9_.-]+$/u.test(server) ? server : "unknown";
      throw new Error(
        `Missing credential for remote MCP server ${label}: ${name}`
      );
    }
    return value;
  };
  const headers = new Headers();
  if (spec.bearer_token_env_var !== undefined) {
    addDeclaredHeader(
      headers,
      "Authorization",
      `Bearer ${resolveSecret(spec.bearer_token_env_var)}`
    );
  }
  for (const [name, declared] of Object.entries(spec.http_headers ?? {})) {
    const resolved = declared.replaceAll(ENVIRONMENT_TEMPLATE, (reference) => {
      const variable = environmentVariableName(reference);
      if (!variable)
        throw new Error("Invalid remote MCP credential reference.");
      return resolveSecret(variable);
    });
    addDeclaredHeader(headers, name, resolved);
  }
  return headers;
}
