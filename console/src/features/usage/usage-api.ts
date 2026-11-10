/**
 * The Console's own Usage telemetry contract.
 *
 * The Console reads the Usage telemetry from the server and hands the
 * browser a small, scoped answer: the request breakdown a workspace row
 * needs, the provider attempts one provider's panel needs, the tool calls
 * one tool's panel needs. The whole dashboard is never handed over -- it is
 * an enormous payload, and the surfaces that want one number from it do not
 * need the other forty.
 *
 * This module owns that contract on both sides of the wire: the shape of
 * the answer, the names of the scopes, the rules a request has to satisfy
 * before it is answered at all, and the validation a browser applies to the
 * answer before it renders it. The route that serves it and the islands
 * that read it both take their rules from here, so the two cannot drift
 * into disagreeing about what a payload means.
 *
 * The schema string is versioned. A payload that carries a schema this
 * Console does not know is refused rather than read on a guess: the answer
 * would otherwise be rendered with the wrong vocabulary, and a wrong number
 * in a telemetry panel is worse than no number at all.
 */

import type {
  UsageWorkspaceRequestBreakdown
} from "@simulatorlife/autodev-core";

/** The version of the contract this Console speaks. */
export const USAGE_API_SCHEMA = "autodev-console-usage-v1";

/**
 * The scopes the endpoint answers.
 *
 * Each scope is one question, and each question is answered by one read of
 * the telemetry store. The scopes exist because the surfaces that want
 * telemetry do not want the same slice of it: a workspace row wants one
 * breakdown, a provider panel wants one provider's attempts, and a tool
 * panel wants one tool's calls.
 */
export const USAGE_API_SCOPES = [
  "workspace-requests",
  "provider-usage",
  "tool-usage"
] as const;

export type UsageApiScope = (typeof USAGE_API_SCOPES)[number];

/**
 * The longest provider id the endpoint will read.
 *
 * A provider id is a short identifier, and an unbounded one would let a
 * caller ask the telemetry store about a scope of any size at all. The
 * bound is generous enough for every id the Console knows and short enough
 * that the scope it names is a scope.
 */
export const MAX_USAGE_PROVIDER_ID_LENGTH = 128;

/**
 * What a provider id may look like.
 *
 * The ids in this Console are names -- a vendor name, a role-qualified
 * name -- and the ones that carry a path carry it as a slash. Everything
 * else is a character the id never has, and an id that carries one is not a
 * provider the Console can scope a read to.
 */
const USAGE_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/u;

/**
 * Is this string a provider id the endpoint will scope a read to?
 *
 * The three refusals are the three ways the id fails to name a provider:
 * it names nothing at all, it is longer than any provider id could be, and
 * it carries characters a provider id does not have. Each of them would
 * otherwise become a scope the telemetry store is asked about and answers
 * as an empty set -- which the caller would read as "this provider made no
 * requests", a measurement nobody made.
 */
export function isUsageProviderId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_USAGE_PROVIDER_ID_LENGTH &&
    USAGE_PROVIDER_ID_PATTERN.test(value)
  );
}

/**
 * What the Usage source said about the workspaces' logical requests.
 *
 * The three states are the three the Console keeps apart everywhere it
 * renders this fact: a measured breakdown, a source that answered without
 * one, and a source that could not be read at all. A source that could not
 * be read is not a source that measured nothing.
 */
export type UsageWorkspaceRequestSource =
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-observed" }
  | {
      readonly kind: "observed";
      readonly breakdown: UsageWorkspaceRequestBreakdown;
    };

/**
 * What the Usage source said about one provider's attempts.
 *
 * The attempt breakdowns are the only provider-scoped evidence the Console
 * shows. They are null when the source answered without them, which is not
 * the same as an empty list: an empty list is a measured zero and a null is
 * an absence.
 */
export type UsageProviderAttemptSource =
  | { readonly kind: "not-configured" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "available";
      readonly attemptsByProvider:
        | readonly {
            readonly provider: string;
            readonly count: number;
          }[]
        | null;
      readonly attemptErrorsByProvider:
        | readonly {
            readonly provider: string;
            readonly count: number;
          }[]
        | null;
    };

/**
 * What the Usage source said about tool calls.
 *
 * The calls are grouped by the tool identity the telemetry recorded, and
 * the caller matches them against the identities its own catalogue entry
 * exposes. The rows are the whole breakdown because the matching is the
 * caller's: the catalogue owns the identity of a tool, and the telemetry
 * store only knows the names it recorded.
 */
export type UsageToolCallSource =
  | { readonly kind: "not-configured" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "available";
      readonly callsByTool:
        | readonly {
            readonly tool: string;
            readonly count: number;
          }[]
        | null;
    };

export interface UsageApiWorkspaceRequestsPayload {
  readonly schema: typeof USAGE_API_SCHEMA;
  readonly scope: "workspace-requests";
  readonly source: UsageWorkspaceRequestSource;
}

export interface UsageApiProviderUsagePayload {
  readonly schema: typeof USAGE_API_SCHEMA;
  readonly scope: "provider-usage";
  readonly provider: string;
  readonly source: UsageProviderAttemptSource;
}

export interface UsageApiToolUsagePayload {
  readonly schema: typeof USAGE_API_SCHEMA;
  readonly scope: "tool-usage";
  readonly source: UsageToolCallSource;
}

export type UsageApiPayload =
  | UsageApiWorkspaceRequestsPayload
  | UsageApiProviderUsagePayload
  | UsageApiToolUsagePayload;

/**
 * The address of one scoped read.
 *
 * The scopes are named in the query rather than in the path because the
 * scopes are the questions, not the resources: the endpoint has one
 * resource -- the Console's telemetry -- and three questions about it.
 */
export function usageApiUrl(
  scope: UsageApiScope,
  params: Readonly<Record<string, string>> = {}
): string {
  const search = new URLSearchParams({ scope, ...params });
  return `/api/usage?${search.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCountRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.count === "number" &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0
  );
}

function isToolCountRow(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.tool === "string" &&
    typeof value.count === "number" &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0
  );
}

function isBreakdown(value: unknown): value is UsageWorkspaceRequestBreakdown {
  return (
    isRecord(value) &&
    typeof value.partial === "boolean" &&
    Array.isArray(value.rows) &&
    value.rows.every(
      (row) =>
        isRecord(row) &&
        (row.workspace === null || typeof row.workspace === "string") &&
        typeof row.count === "number" &&
        Number.isSafeInteger(row.count) &&
        row.count >= 0
    )
  );
}

/**
 * Read a payload the browser was handed.
 *
 * The answer is validated rather than trusted: the payload is a JSON body
 * that crossed a network, and a body that does not match the contract is
 * not a smaller answer, it is a different answer. A payload the Console
 * cannot read becomes an unavailable state, which the surfaces render as
 * the absence of evidence rather than as a measurement.
 */
export function parseUsageApiPayload(
  json: unknown
): UsageApiPayload | null {
  if (!isRecord(json)) return null;
  if (json.schema !== USAGE_API_SCHEMA) return null;
  const source = json.source;
  if (!isRecord(source)) return null;
  if (json.scope === "workspace-requests") {
    if (source.kind === "unavailable" || source.kind === "not-observed") {
      return {
        schema: USAGE_API_SCHEMA,
        scope: "workspace-requests",
        source: { kind: source.kind }
      };
    }
    if (source.kind === "observed" && isBreakdown(source.breakdown)) {
      return {
        schema: USAGE_API_SCHEMA,
        scope: "workspace-requests",
        source: { kind: "observed", breakdown: source.breakdown }
      };
    }
    return null;
  }
  if (json.scope === "provider-usage") {
    if (typeof json.provider !== "string") return null;
    if (source.kind === "not-configured" || source.kind === "unavailable") {
      return {
        schema: USAGE_API_SCHEMA,
        scope: "provider-usage",
        provider: json.provider,
        source: { kind: source.kind }
      };
    }
    if (source.kind !== "available") return null;
    const attempts = source.attemptsByProvider;
    const errors = source.attemptErrorsByProvider;
    if (attempts !== null && !Array.isArray(attempts)) return null;
    if (errors !== null && !Array.isArray(errors)) return null;
    if (attempts !== null && !attempts.every(isCountRow)) return null;
    if (errors !== null && !errors.every(isCountRow)) return null;
    return {
      schema: USAGE_API_SCHEMA,
      scope: "provider-usage",
      provider: json.provider,
      source: {
        kind: "available",
        attemptsByProvider: attempts,
        attemptErrorsByProvider: errors
      }
    };
  }
  if (json.scope === "tool-usage") {
    if (source.kind === "not-configured" || source.kind === "unavailable") {
      return {
        schema: USAGE_API_SCHEMA,
        scope: "tool-usage",
        source: { kind: source.kind }
      };
    }
    if (source.kind !== "available") return null;
    const calls = source.callsByTool;
    if (calls !== null && !Array.isArray(calls)) return null;
    if (calls !== null && !calls.every(isToolCountRow)) return null;
    return {
      schema: USAGE_API_SCHEMA,
      scope: "tool-usage",
      source: { kind: "available", callsByTool: calls }
    };
  }
  return null;
}
