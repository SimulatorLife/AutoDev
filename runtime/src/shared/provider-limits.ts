import {
  headerValue,
  LIMIT_HEADER_RESETS_AT,
  normalizeResetsAt,
  readResetAtFromHeaders,
  resetsAtFromDuration
} from "./provider-reset-headers.ts";

export { type ProviderTransientFailureClass } from "@simulatorlife/autodev-core";

// Shared vocabulary for provider usage limits and for closing a turn that a
// limit cut short.
//
// Two problems live here. The first is that "this provider is out of usage
// until Tuesday" and "this provider blipped a 503" used to be indistinguishable
// by the time they reached the router: every bridge reported both as prose, and
// the router re-derived a class by matching keywords against that prose. The
// headers below carry the distinction structurally instead, including the
// provider's own reset time when it stated one.
//
// The second is that a turn cut short by a limit used to end as a bare
// `response.failed`, discarding every token the model had already produced.
// `terminalIncompleteEvents` closes such a turn as a well-formed *incomplete*
// response carrying that work, so the parent reads what its child actually did
// rather than an error string. All three bridges emit the same ordering through
// this one implementation so all typed provider bridges cannot drift; each bridge imports these
// literals and `tests/provider-limits.test.ts` asserts the typed bridge uses this boundary.

export const LIMIT_HEADER_CLASS = "x-autodev-limit-class";
export const LIMIT_HEADER_TYPE = "x-autodev-limit-type";
export const LIMIT_HEADER_SOURCE = "x-autodev-limit-source";

// How the limit was established. `reported` means the provider itself said so
// -- a Claude `rate_limit_event`, an upstream response carrying these headers.
// `inferred` means a bridge matched free text, which stays on the transient
// ladder unless a hard-limit class also carries a stated future reset
// (bounded by `hardCooldownMaxMs`). `reported` is never capped.
export const LIMIT_SOURCE_REPORTED = "reported";
export const LIMIT_SOURCE_INFERRED = "inferred";

// Why a turn stopped before it finished. Carried as
// `response.incomplete_details.reason` on the terminal event.
export const INCOMPLETE_REASON_PROVIDER_LIMIT = "provider_limit";
export const INCOMPLETE_REASON_TIMEOUT = "provider_timeout";
export const INCOMPLETE_REASON_INTERRUPTED = "provider_interrupted";
// The upstream closed the connection while the provider was in the middle of
// executing a tool that spawns sub-agents (agy: invoke_subagent /
// manage_subagents; claude: Agent / Task). This is distinct from
// INCOMPLETE_REASON_INTERRUPTED, which the router reaches for when the
// provider's response stream simply stopped without telling us why: the
// truncation notice needs to point operators at the right cause so they do not
// chase a phantom provider stall when the cause was a per-session timeout the
// router hit because agy was waiting on its own children. Currently delivered
// only through bridge log lines and any future re-attach path; the router still
// emits the generic INCOMPLETE_REASON_INTERRUPTED for now because the upstream
// is gone by the time this is known and the SSE socket it would have travelled
// out of is already closed.
export const INCOMPLETE_REASON_CLIENT_DISCONNECTED = "client_disconnected";

// Re-export the canonical Core hard limit classes

/** A bounded, provider-supplied failure classification safe to return downstream. */
export interface ProviderFailureDiagnostic {
  code: string;
  phase?: string;
  tool?: string;
}

export type LimitClass =
  | "quota_exhausted"
  | "session_limit"
  | "throttled"
  | "capacity"
  | (string & {});
export type LimitSource =
  typeof LIMIT_SOURCE_REPORTED | typeof LIMIT_SOURCE_INFERRED;
export interface ProviderLimit {
  limitClass: LimitClass;
  limitType?: string | null;
  resetsAt?: string | null;
  source?: LimitSource;
  exitCode?: number | null;
}

const CLI_LIMIT_PATTERNS = Object.freeze([
  {
    limitClass: "quota_exhausted",
    limitType: "quota",
    pattern:
      /quota (?:exceeded|exhausted|reached)|quota limit|out of (?:credit|quota)|insufficient (?:credit|quota|fund)|billing|usage limit reached|weekly limit/i
  },
  {
    limitClass: "session_limit",
    limitType: "session",
    pattern: /session limit|concurrent session|session capacity/i
  },
  {
    limitClass: "throttled",
    limitType: "rate",
    // A 429 is a status only when it stands as a number of its own. A bare
    // `429` also matched inside chat UUIDs, ids and byte counts ("tab shows
    // chat 6a429c1e-...", "prompt is 64291 bytes"), so a refusal that named
    // one was read as the site throttling the account and cooled the provider
    // down.
    pattern:
      /rate.?limit|too many requests|(?<![\w.-])429(?![\w.-])(?!\s*(?:bytes?|ms|seconds?|KB)\b)/i
  }
]);

const RESETS_AT_PATTERN =
  /reset(?:s|ting)?(?: at| on| in)?[:\s]+([0-9TZ:.\-+ ]{4,40})/i;

/**
 * Best-effort classification of a CLI failure message. Always reports
 * `inferred`: this reads free text, so a bare keyword without a stated future
 * reset stays on the transient ladder rather than locking a provider out. When
 * the message states a future reset window (absolute or relative), the router
 * holds a hard-limit class as a `hard` cooldown up to `hardCooldownMaxMs`.
 */
export function classifyCliLimit(
  message: unknown,
  exitCode: number | null = null,
  now = Date.now()
): ProviderLimit | null {
  const text = String(message ?? "");
  if (!text.trim()) return null;
  const match = CLI_LIMIT_PATTERNS.find(({ pattern }) => pattern.test(text));
  if (!match) return null;
  const absoluteMatch = text.match(RESETS_AT_PATTERN);
  const absoluteResetsAt = absoluteMatch?.[1]
    ? normalizeResetsAt(absoluteMatch[1].trim())
    : null;
  return {
    limitClass: match.limitClass,
    limitType: match.limitType,
    // A stated duration is a window relative to *now*, so it resolves against
    // the same clock the router cools down against.
    resetsAt: absoluteResetsAt ?? resetsAtFromDuration(text, now),
    source: LIMIT_SOURCE_INFERRED,
    exitCode: Number.isInteger(exitCode) ? exitCode : null
  };
}

/** Response headers describing a limit. Absent fields are omitted, never sent empty. */
export function limitResponseHeaders(
  limit: ProviderLimit | null | undefined
): Record<string, string> {
  if (!limit || typeof limit !== "object" || !limit.limitClass) return {};
  const headers: Record<string, string> = {
    [LIMIT_HEADER_CLASS]: limit.limitClass
  };
  if (limit.limitType) headers[LIMIT_HEADER_TYPE] = limit.limitType;
  if (limit.resetsAt) headers[LIMIT_HEADER_RESETS_AT] = limit.resetsAt;
  headers[LIMIT_HEADER_SOURCE] =
    limit.source === LIMIT_SOURCE_REPORTED
      ? LIMIT_SOURCE_REPORTED
      : LIMIT_SOURCE_INFERRED;
  return headers;
}

/**
 * The inverse of `limitResponseHeaders`, for the router reading a failed
 * upstream response. Returns null when the provider said nothing structural, so
 * the caller can tell "no limit reported" from "limit reported without a reset".
 *
 * Accepts any header bag -- a `Headers`, a plain record, or a substitute
 * implementation of either shape -- because what reaches this point came off a
 * pluggable fetch and was never more specific than `unknown`.
 */
export function readLimitHeaders(headers: unknown): ProviderLimit | null {
  const limitClass = headerValue(headers, LIMIT_HEADER_CLASS);
  if (!limitClass) return null;
  const source = headerValue(headers, LIMIT_HEADER_SOURCE);
  return {
    limitClass: limitClass.toLowerCase(),
    limitType: headerValue(headers, LIMIT_HEADER_TYPE)?.toLowerCase() ?? null,
    resetsAt:
      normalizeResetsAt(headerValue(headers, LIMIT_HEADER_RESETS_AT)) ??
      readResetAtFromHeaders(headers),
    source:
      source === LIMIT_SOURCE_REPORTED
        ? LIMIT_SOURCE_REPORTED
        : LIMIT_SOURCE_INFERRED
  };
}

/** Seconds until the limit's stated reset, or null when it stated none. */
export function retryAfterSecondsFromLimit(
  limit: ProviderLimit | null | undefined,
  now = Date.now()
): number | null {
  if (!limit?.resetsAt) return null;
  const resetsAtMs = Date.parse(limit.resetsAt);
  if (Number.isNaN(resetsAtMs)) return null;
  return Math.max(1, Math.ceil((resetsAtMs - now) / 1000));
}

/**
 * The wire shape of a limit, used identically for
 * `incomplete_details.provider_limit` and for `error.limit` on a non-streamed
 * failure, so the router reads one shape wherever it finds it.
 */
export function limitPayload(
  limit: ProviderLimit | null | undefined
): Record<string, string | null> | null {
  if (!limit?.limitClass) return null;
  return {
    class: limit.limitClass,
    type: limit.limitType ?? null,
    resets_at: limit.resetsAt ?? null,
    source: limit.source ?? LIMIT_SOURCE_INFERRED
  };
}

export function incompleteDetails(
  reason: string,
  limit: ProviderLimit | null = null,
  providerFailure: ProviderFailureDiagnostic | null = null
): Record<string, unknown> {
  const details: Record<string, unknown> = { reason };
  const payload = limitPayload(limit);
  if (payload) details.provider_limit = payload;
  if (providerFailure) details.provider_failure = providerFailure;
  return details;
}

/** Why the turn stopped, phrased to follow "The provider". */
function truncationCause(limit: ProviderLimit | null, reason: string): string {
  if (limit?.limitClass === "capacity") return "was over capacity";
  if (reason === INCOMPLETE_REASON_TIMEOUT) return "timed out";
  if (reason === INCOMPLETE_REASON_INTERRUPTED) return "stopped unexpectedly";
  if (reason === INCOMPLETE_REASON_CLIENT_DISCONNECTED)
    return "was disconnected mid-delegation";
  if (limit?.limitClass === "session_limit") return "reached its session limit";
  if (limit?.limitClass === "throttled") return "was rate limited";
  return "ran out of usage";
}

/**
 * The sentence appended to a truncated turn's text. The consumer is a model
 * deciding what to do next, so it has to say plainly that the work is partial
 * and that nothing after it ran -- a partial answer read as a complete one is
 * worse than a failure.
 */
export function truncationNotice({
  provider = null,
  limit = null,
  reason = INCOMPLETE_REASON_PROVIDER_LIMIT,
  providerFailure = null
}: {
  provider?: string | null;
  limit?: ProviderLimit | null;
  reason?: string;
  providerFailure?: ProviderFailureDiagnostic | null;
} = {}): string {
  const who = provider ? `The ${provider} provider` : "The provider";
  const cause =
    providerFailure?.code === "AGY_PERMISSION_DENIED"
      ? `was blocked because a required ${providerFailure.tool === "read_file" ? "read_file " : "tool "}permission was denied in headless mode`
      : truncationCause(limit, reason);
  const resets = limit?.resetsAt ? ` Usage resets at ${limit.resetsAt}.` : "";
  return `\n\n[Incomplete: ${who} ${cause} and this turn stopped here. Everything above is work that finished; nothing after it ran.${resets}]`;
}

/**
 * The ordered terminal events that close a turn cut short, mirroring the
 * success path each bridge already emits so a consumer needs no special case
 * beyond reading `status`. `response` is the caller's own payload object (their
 * usage and metadata shape differs); status and incomplete_details are set here.
 *
 * Returns [eventName, payload] pairs for the caller to emit in order, followed
 * by the caller writing `data: [DONE]`.
 */
export function terminalIncompleteEvents({
  responseId,
  itemId,
  reasoningId,
  text = "",
  reasoningText = "",
  reason = INCOMPLETE_REASON_PROVIDER_LIMIT,
  limit = null,
  providerFailure = null,
  provider = null,
  response = null
}: {
  responseId: string;
  itemId: string;
  reasoningId: string;
  text?: string;
  reasoningText?: string;
  reason?: string;
  limit?: ProviderLimit | null;
  providerFailure?: ProviderFailureDiagnostic | null;
  provider?: string | null;
  response?: Record<string, unknown> | null;
}): Array<[string, Record<string, unknown>]> {
  const notice = truncationNotice({ provider, limit, reason, providerFailure });
  const finalText = `${text}${notice}`;
  const details = incompleteDetails(reason, limit, providerFailure);
  const completedReasoning = {
    id: reasoningId,
    type: "reasoning",
    status: "incomplete",
    summary: [{ type: "summary_text", text: reasoningText }],
    content: []
  };
  const completedMessage = {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "incomplete",
    content: [{ type: "output_text", text: finalText, annotations: [] }]
  };
  const payload = {
    ...(response ?? {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      output: []
    }),
    id: responseId,
    status: "incomplete",
    incomplete_details: details,
    output: [completedReasoning, completedMessage],
    output_text: finalText
  };
  return [
    // The notice goes out as a delta first so a client rendering the stream
    // live sees it in place, not only in the terminal snapshot.
    [
      "response.output_text.delta",
      {
        type: "response.output_text.delta",
        item_id: itemId,
        delta: notice,
        content_index: 0,
        output_index: 1
      }
    ],
    ...reasoningDoneEvents(completedReasoning, reasoningText),
    ...messageDoneEvents(completedMessage, finalText),
    ["response.completed", { type: "response.completed", response: payload }]
  ];
}

type TerminalEvent = [string, Record<string, unknown>];
const OUTPUT_ITEM_DONE = "response.output_item.done";

/** The events that close the reasoning item at output index 0. */
function reasoningDoneEvents(
  item: { id: string },
  reasoningText: string
): TerminalEvent[] {
  return [
    [
      "response.reasoning_summary_text.done",
      {
        type: "response.reasoning_summary_text.done",
        item_id: item.id,
        output_index: 0,
        summary_index: 0,
        text: reasoningText
      }
    ],
    [
      "response.reasoning_summary_part.done",
      {
        type: "response.reasoning_summary_part.done",
        item_id: item.id,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: reasoningText }
      }
    ],
    [OUTPUT_ITEM_DONE, { type: OUTPUT_ITEM_DONE, output_index: 0, item }]
  ];
}

/** The events that close the assistant message item at output index 1. */
function messageDoneEvents(
  item: { id: string },
  finalText: string
): TerminalEvent[] {
  return [
    [
      "response.output_text.done",
      {
        type: "response.output_text.done",
        item_id: item.id,
        text: finalText,
        content_index: 0,
        output_index: 1
      }
    ],
    [
      "response.content_part.done",
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 1,
        content_index: 0,
        part: { type: "output_text", text: finalText, annotations: [] }
      }
    ],
    [OUTPUT_ITEM_DONE, { type: OUTPUT_ITEM_DONE, output_index: 1, item }]
  ];
}

export {
  LIMIT_HEADER_RESETS_AT,
  type LimitHeaders,
  normalizeResetsAt,
  readResetAtFromHeaders
} from "./provider-reset-headers.ts";
export {
  PROVIDER_HARD_LIMIT_CLASSES as HARD_LIMIT_CLASSES,
  isHardLimitClass,
  isTransientFailureClass,
  PROVIDER_HARD_LIMIT_CLASSES,
  PROVIDER_TRANSIENT_FAILURE_CLASSES,
  type ProviderHardLimitClass
} from "@simulatorlife/autodev-core";
