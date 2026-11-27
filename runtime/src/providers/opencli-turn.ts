/**
OpenCLI's site adapters: the models each site offers, and the parsing of
what it answers.

The role turn itself is composed in `opencli-role.ts`. This module owns
only what both the turn and the model discovery share.
*/
import { isRecord } from "@simulatorlife/autodev-core";
import {
  OPENCLI_SITES,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

type JsonRecord = Record<string, unknown>;

export type OpencliExec = (arguments_: readonly string[]) => Promise<JsonRecord[]>;

export interface OpencliReply {
  readonly response: string;
  readonly conversationId: string | null;
}

export interface OpencliSiteSpec {
  readonly site: OpencliSite;
  readonly models:
    readonly string[] | ((exec: OpencliExec) => Promise<string[]>);
}

export const GEMINI_REPLY_PREFIX = "💬 ";
export const GEMINI_THINKING_LEVELS = Object.freeze(["low", "medium", "high"]);
const GEMINI_CONVERSATION_PATTERN = /\/app\/([\w-]+)/u;
const JSON_FORMAT = ["-f", "json"] as const;

export const CHATGPT_MODELS = Object.freeze([
  "fast",
  "balanced",
  "advanced",
  "xhigh",
  "pro",
  "gpt-5.6-pro"
]);

export const CHAT_MISMATCH = "CHAT_MISMATCH";

export function answeredIn(
  site: string,
  expected: string | null,
  reply: OpencliReply
): OpencliReply {
  if (
    expected !== null &&
    reply.conversationId !== null &&
    reply.conversationId !== expected
  ) {
    throw new OpencliCommandError(
      `${site} answered in chat ${reply.conversationId}, not ${expected}`,
      CHAT_MISMATCH,
      null
    );
  }
  return reply;
}

/**
Whether one opencli invocation needs the browser's foreground.

OpenCLI refuses native input -- a real mouse or key event -- on a page the
browser does not consider visible, so an operation that changes something
chosen from the ChatGPT composer's own UI needs the browser's active tab.

Three ChatGPT operations are chosen that way. Attaching an app and enabling
a site tool open the composer's menu and click an entry in it, with no
other way to reach them. Selecting a model opens the reasoning slider or the
model menu; the site can also be told its level through its own settings
API, but only for the models that API covers -- for the rest the visible
picker is the only path, and the command fails without one.

Everything else runs without the foreground. The plain prompt is typed
through the page's own input with a scripted fallback when the page is not
visible, and Gemini's adapter never clicks natively at all. Serializing
every command behind the foreground would make the dedicated browser's tab
pool meaningless and would let a read-only discovery command block a live
turn, so the requirement is derived from the command itself.
*/
export function opencliCommandRequiresForeground(
  arguments_: readonly string[]
): boolean {
  // Only the ChatGPT adapter clicks natively, and only when it is asked to
  // change the conversation's model, its attached app or a site tool.
  if (arguments_[0] !== "chatgpt" || arguments_[1] !== "ask") return false;
  return (
    arguments_.includes("--model") ||
    arguments_.includes("--app") ||
    arguments_.includes("--deep-research") ||
    arguments_.includes("--web-search")
  );
}

const GEMINI_MODEL_SELECTION_FAILURE =
  /Gemini model discovery returned no selectable models|Gemini model selection|Failed to open (?:Gemini )?model picker|model picker button was not found|Failed to click Gemini model picker|not found in picker menu/u;

export function isGeminiModelSelectionFailure(error: unknown): boolean {
  return (
    error instanceof OpencliCommandError &&
    GEMINI_MODEL_SELECTION_FAILURE.test(error.message)
  );
}

const GEMINI_THINKING_SELECTION_FAILURE =
  /Could not select thinking level|--thinking must be one of|--thinking '[^']*' is not (?:currently )?available/u;

export function isGeminiThinkingSelectionFailure(error: unknown): boolean {
  return (
    error instanceof OpencliCommandError &&
    GEMINI_THINKING_SELECTION_FAILURE.test(error.message)
  );
}

const GEMINI_MODEL_LIMIT = "MODEL_LIMIT";
const GEMINI_LIMITED_MODEL = /^Gemini model "([^"]+)" is out of usage/u;
const GEMINI_LIMIT_RESETS =
  /Limit resets ([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{1,2}):(\d{2})\s*([AP]M)\b/iu;
const MONTHS = Object.freeze([
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec"
]);
const GEMINI_RESET_HORIZON_MS = 45 * 24 * 60 * 60 * 1000;

function geminiLimitReset(
  month: string,
  day: string,
  hour12: number,
  minute: number,
  meridiem: string,
  now: number
): string | null {
  const monthIndex = MONTHS.indexOf(month.toLowerCase());
  if (monthIndex === -1 || hour12 < 1 || hour12 > 12 || minute > 59) {
    return null;
  }
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  const at = (year: number) =>
    new Date(year, monthIndex, Number(day), hour, minute).getTime();
  const year = new Date(now).getFullYear();
  const reset = [at(year), at(year + 1)].find(
    (candidate) =>
      candidate >= now && candidate - now <= GEMINI_RESET_HORIZON_MS
  );
  return reset === undefined ? null : new Date(reset).toISOString();
}

export function geminiModelLimit(
  error: unknown,
  now = Date.now()
): OpencliCommandError | null {
  if (
    !(error instanceof OpencliCommandError) ||
    error.code !== GEMINI_MODEL_LIMIT
  ) {
    return null;
  }
  const model = GEMINI_LIMITED_MODEL.exec(error.message)?.[1];
  const resets = GEMINI_LIMIT_RESETS.exec(error.message);
  const resetsAt = resets
    ? geminiLimitReset(
        resets[1] ?? "",
        resets[2] ?? "",
        Number(resets[3]),
        Number(resets[4]),
        resets[5] ?? "",
        now
      )
    : null;
  return new OpencliCommandError(
    `Gemini usage limit reached${model ? ` for ${model}` : ""}${resetsAt ? `; resets at ${resetsAt}` : ""}`,
    GEMINI_MODEL_LIMIT,
    error.exitCode
  );
}

export function geminiConversationId(url: unknown): string | null {
  return typeof url === "string"
    ? (GEMINI_CONVERSATION_PATTERN.exec(url)?.[1] ?? null)
    : null;
}

export const OPENCLI_SITE_SPECS: Readonly<
  Record<OpencliSite, OpencliSiteSpec>
> = {
  chatgpt: {
    site: "chatgpt",
    models: CHATGPT_MODELS
  },
  gemini: {
    site: "gemini",
    models: async (exec) => {
      const rows = await exec(["gemini", "models", ...JSON_FORMAT]);
      return rows
        .map((row) => (typeof row.model === "string" ? row.model.trim() : ""))
        .filter((model) => model !== "");
    }
  }
};

for (const site of OPENCLI_SITES) {
  if (!Object.hasOwn(OPENCLI_SITE_SPECS, site)) {
    throw new Error(`opencli site ${site} has no adapter spec`);
  }
}

export class OpencliCommandError extends Error {
  readonly code: string;
  readonly exitCode: number | null;

  constructor(message: string, code: string, exitCode: number | null) {
    super(message);
    this.name = "OpencliCommandError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function stringField(record: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function parseOpencliOutput(
  stdout: string,
  exitCode: number | null
): JsonRecord[] {
  const trimmed = stdout.trim();
  let envelope: unknown;
  try {
    envelope = JSON.parse(trimmed.slice(trimmed.indexOf("{")));
  } catch {
    throw new OpencliCommandError(
      `opencli returned no JSON result (exit ${exitCode ?? "signal"}): ${trimmed.slice(-500) || "empty output"}`,
      "INVALID_OUTPUT",
      exitCode
    );
  }
  if (!isRecord(envelope)) {
    throw new OpencliCommandError(
      "opencli returned a non-object result",
      "INVALID_OUTPUT",
      exitCode
    );
  }
  if (envelope.ok !== true) {
    const error = isRecord(envelope.error) ? envelope.error : {};
    const message = stringField(error, "message") ?? "opencli command failed";
    const hint = stringField(error, "hint");
    throw new OpencliCommandError(
      hint ? `${message} (${hint})` : message,
      stringField(error, "code") ?? "COMMAND_EXEC",
      typeof error.exitCode === "number" ? error.exitCode : exitCode
    );
  }
  const data = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  return data.filter(isRecord);
}

export function replyFromRow(
  row: JsonRecord
): Pick<OpencliReply, "response" | "conversationId"> {
  const response = stringField(row, "response");
  if (response === null) {
    throw new OpencliCommandError(
      "opencli returned an empty reply",
      "EMPTY_RESPONSE",
      null
    );
  }
  return {
    response,
    conversationId: stringField(row, "conversationId", "conversation_id")
  };
}
