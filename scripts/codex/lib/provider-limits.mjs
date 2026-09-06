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
// this one implementation so they cannot drift; the Python bridge mirrors these
// literals and `tests/provider-limits.test.mjs` asserts the two agree.

export const LIMIT_HEADER_CLASS = "x-autodev-limit-class";
export const LIMIT_HEADER_TYPE = "x-autodev-limit-type";
export const LIMIT_HEADER_RESETS_AT = "x-autodev-limit-resets-at";
export const LIMIT_HEADER_SOURCE = "x-autodev-limit-source";

// How the limit was established. `reported` means the provider itself said so
// -- a Claude `rate_limit_event`, an upstream response carrying these headers.
// `inferred` means a bridge matched free text, which is a useful hint but not
// evidence: a CLI's stderr tail can mention "quota" for unrelated reasons. Only
// `reported` corroborates a long hard cooldown in the router.
export const LIMIT_SOURCE_REPORTED = "reported";
export const LIMIT_SOURCE_INFERRED = "inferred";

// Why a turn stopped before it finished. Carried as
// `response.incomplete_details.reason` on the terminal event.
export const INCOMPLETE_REASON_PROVIDER_LIMIT = "provider_limit";
export const INCOMPLETE_REASON_TIMEOUT = "provider_timeout";
export const INCOMPLETE_REASON_INTERRUPTED = "provider_interrupted";

// Classes that mean "this provider will not serve again until its window
// resets", as opposed to a transient failure worth retrying in seconds.
export const HARD_LIMIT_CLASSES = Object.freeze(["quota_exhausted", "session_limit"]);

export function isHardLimitClass(limitClass) {
  return HARD_LIMIT_CLASSES.includes(limitClass);
}

/**
 * Normalize a provider-supplied reset time to an ISO-8601 UTC string. Providers
 * state it as epoch seconds, epoch milliseconds, or an ISO string depending on
 * which CLI produced it. Anything unparseable is dropped rather than guessed:
 * a wrong reset time is worse than none, because the router trusts it.
 */
export function normalizeResetsAt(value) {
  if (value === null || value === undefined || value === "") return null;
  let ms = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds and epoch milliseconds are told apart by magnitude: a
    // seconds value large enough to be ambiguous would be in the year 33658.
    ms = value > 1e11 ? value : value * 1000;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      ms = numeric > 1e11 ? numeric : numeric * 1000;
    } else {
      const parsed = Date.parse(trimmed);
      ms = Number.isNaN(parsed) ? null : parsed;
    }
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const CLI_LIMIT_PATTERNS = Object.freeze([
  { limitClass: "quota_exhausted", limitType: "quota", pattern: /quota (?:exceeded|exhausted)|out of (?:credit|quota)|insufficient (?:credit|quota|fund)|billing|usage limit reached|weekly limit/i },
  { limitClass: "session_limit", limitType: "session", pattern: /session limit|concurrent session|session capacity/i },
  { limitClass: "throttled", limitType: "rate", pattern: /rate.?limit|too many requests|429/i },
]);

const RESETS_AT_PATTERN = /reset(?:s|ting)?(?: at| on| in)?[:\s]+([0-9TZ:.\-+ ]{4,40})/i;

/**
 * Best-effort classification of a CLI failure message. Always reports
 * `inferred`: this reads free text, and a bridge that hands the router a
 * 4000-character stderr tail must not be able to lock a provider out for the
 * hard-cooldown window on the strength of one keyword. It is enough to pick a
 * better HTTP status and a retry hint, which is what it is used for.
 */
export function classifyCliLimit(message, exitCode = null) {
  const text = String(message ?? "");
  if (!text.trim()) return null;
  const match = CLI_LIMIT_PATTERNS.find(({ pattern }) => pattern.test(text));
  if (!match) return null;
  const resetsMatch = text.match(RESETS_AT_PATTERN);
  return {
    limitClass: match.limitClass,
    limitType: match.limitType,
    resetsAt: resetsMatch ? normalizeResetsAt(resetsMatch[1].trim()) : null,
    source: LIMIT_SOURCE_INFERRED,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
  };
}

/** Response headers describing a limit. Absent fields are omitted, never sent empty. */
export function limitResponseHeaders(limit) {
  if (!limit || typeof limit !== "object" || !limit.limitClass) return {};
  const headers = { [LIMIT_HEADER_CLASS]: limit.limitClass };
  if (limit.limitType) headers[LIMIT_HEADER_TYPE] = limit.limitType;
  if (limit.resetsAt) headers[LIMIT_HEADER_RESETS_AT] = limit.resetsAt;
  headers[LIMIT_HEADER_SOURCE] = limit.source === LIMIT_SOURCE_REPORTED ? LIMIT_SOURCE_REPORTED : LIMIT_SOURCE_INFERRED;
  return headers;
}

function headerValue(headers, name) {
  if (!headers) return null;
  const get = typeof headers.get === "function" ? (key) => headers.get(key) : null;
  const raw = get ? get(name) : (() => {
    const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
    return key === undefined ? undefined : headers[key];
  })();
  const single = Array.isArray(raw) ? raw[0] : raw;
  return typeof single === "string" && single.trim() ? single.trim() : null;
}

/**
 * The inverse of `limitResponseHeaders`, for the router reading a failed
 * upstream response. Returns null when the provider said nothing structural, so
 * the caller can tell "no limit reported" from "limit reported without a reset".
 */
export function readLimitHeaders(headers) {
  const limitClass = headerValue(headers, LIMIT_HEADER_CLASS);
  if (!limitClass) return null;
  const source = headerValue(headers, LIMIT_HEADER_SOURCE);
  return {
    limitClass: limitClass.toLowerCase(),
    limitType: headerValue(headers, LIMIT_HEADER_TYPE)?.toLowerCase() ?? null,
    resetsAt: normalizeResetsAt(headerValue(headers, LIMIT_HEADER_RESETS_AT)),
    source: source === LIMIT_SOURCE_REPORTED ? LIMIT_SOURCE_REPORTED : LIMIT_SOURCE_INFERRED,
  };
}

/** Seconds until the limit's stated reset, or null when it stated none. */
export function retryAfterSecondsFromLimit(limit, now = Date.now()) {
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
export function limitPayload(limit) {
  if (!limit?.limitClass) return null;
  return {
    class: limit.limitClass,
    type: limit.limitType ?? null,
    resets_at: limit.resetsAt ?? null,
    source: limit.source ?? LIMIT_SOURCE_INFERRED,
  };
}

export function incompleteDetails(reason, limit = null) {
  const details = { reason };
  const payload = limitPayload(limit);
  if (payload) details.provider_limit = payload;
  return details;
}

/**
 * The sentence appended to a truncated turn's text. The consumer is a model
 * deciding what to do next, so it has to say plainly that the work is partial
 * and that nothing after it ran -- a partial answer read as a complete one is
 * worse than a failure.
 */
export function truncationNotice({ provider = null, limit = null, reason = INCOMPLETE_REASON_PROVIDER_LIMIT } = {}) {
  const who = provider ? `The ${provider} provider` : "The provider";
  const cause = limit?.limitClass === "capacity"
    ? "was over capacity"
    : reason === INCOMPLETE_REASON_TIMEOUT
      ? "timed out"
      : reason === INCOMPLETE_REASON_INTERRUPTED
        ? "stopped unexpectedly"
        : limit?.limitClass === "session_limit"
          ? "reached its session limit"
          : limit?.limitClass === "throttled"
            ? "was rate limited"
            : "ran out of usage";
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
  provider = null,
  response = null,
}) {
  const notice = truncationNotice({ provider, limit, reason });
  const finalText = `${text}${notice}`;
  const details = incompleteDetails(reason, limit);
  const completedReasoning = { id: reasoningId, type: "reasoning", status: "incomplete", summary: [{ type: "summary_text", text: reasoningText }], content: [] };
  const completedMessage = { id: itemId, type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: finalText, annotations: [] }] };
  const payload = {
    ...(response ?? { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), output: [] }),
    id: responseId,
    status: "incomplete",
    incomplete_details: details,
    output: [completedReasoning, completedMessage],
    output_text: finalText,
  };
  return [
    // The notice goes out as a delta first so a client rendering the stream
    // live sees it in place, not only in the terminal snapshot.
    ["response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, delta: notice, content_index: 0, output_index: 1 }],
    ["response.reasoning_summary_text.done", { type: "response.reasoning_summary_text.done", item_id: reasoningId, output_index: 0, summary_index: 0, text: reasoningText }],
    ["response.reasoning_summary_part.done", { type: "response.reasoning_summary_part.done", item_id: reasoningId, output_index: 0, summary_index: 0, part: { type: "summary_text", text: reasoningText } }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: completedReasoning }],
    ["response.output_text.done", { type: "response.output_text.done", item_id: itemId, text: finalText, content_index: 0, output_index: 1 }],
    ["response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 1, content_index: 0, part: { type: "output_text", text: finalText, annotations: [] } }],
    ["response.output_item.done", { type: "response.output_item.done", output_index: 1, item: completedMessage }],
    ["response.completed", { type: "response.completed", response: payload }],
  ];
}
