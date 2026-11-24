/**
 * Direct `opencli` site adapters and output parsing for `github-worker` web
 * tasks and model discovery.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";

import { isRecord } from "@simulatorlife/autodev-core";
import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import {
  OPENCLI_SITES,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

type JsonRecord = Record<string, unknown>;

export function attachedPromptFileName(): string {
  return `turn-${randomBytes(6).toString("hex")}.md`;
}

export function attachedPromptMessage(fileName: string): string {
  return `Read the attached file ${fileName} and respond exactly as it instructs.`;
}

export function typedPromptMarker(fileName: string): string {
  return `AutoDev turn ${path.basename(fileName, path.extname(fileName))}.`;
}

const UPLOADS_REFUSED =
  /\b0 of \d+ file input\(s\) on the page accept this file/u;

export function uploadsRefused(error: unknown): boolean {
  return (
    error instanceof OpencliCommandError && UPLOADS_REFUSED.test(error.message)
  );
}

export const UPLOADS_EXHAUSTED = "UPLOADS_EXHAUSTED";

export interface OpencliInvocation {
  readonly prompt: string;
  readonly promptFile: string;
  readonly typed: boolean;
  readonly conversationId: string | null;
  readonly siteModel: string;
  readonly selectModel: boolean;
  readonly siteThinking: string | null;
  readonly timeoutSeconds: number;
}

export const GEMINI_THINKING_LEVELS = Object.freeze(["low", "medium", "high"]);

export type OpencliExec = (args: readonly string[]) => Promise<JsonRecord[]>;

export interface OpencliReply {
  readonly response: string;
  readonly conversationId: string | null;
  readonly thinking?: string | null;
  readonly modelSelected: boolean;
}

export interface OpencliSiteSpec {
  readonly site: OpencliSite;
  readonly attachesPrompt: boolean;
  readonly models:
    readonly string[] | ((exec: OpencliExec) => Promise<string[]>);
  turn(invocation: OpencliInvocation, exec: OpencliExec): Promise<OpencliReply>;
}

const GEMINI_REPLY_PREFIX = "💬 ";
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

function answeredIn(
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

const GEMINI_MODEL_SELECTION_FAILURE =
  /Gemini model discovery returned no selectable models|Gemini model selection|Failed to open (?:Gemini )?model picker|model picker button was not found|Failed to click Gemini model picker|not found in picker menu/u;

function isGeminiModelSelectionFailure(error: unknown): boolean {
  return (
    error instanceof OpencliCommandError &&
    GEMINI_MODEL_SELECTION_FAILURE.test(error.message)
  );
}

const GEMINI_THINKING_SELECTION_FAILURE =
  /Could not select thinking level|--thinking must be one of|--thinking '[^']*' is not (?:currently )?available/u;

function isGeminiThinkingSelectionFailure(error: unknown): boolean {
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

function firstRow(rows: JsonRecord[]): JsonRecord {
  const row = rows[0];
  if (!row) {
    throw new OpencliCommandError(
      "opencli returned no result row",
      "INVALID_OUTPUT",
      null
    );
  }
  return row;
}

export const OPENCLI_SITE_SPECS: Readonly<
  Record<OpencliSite, OpencliSiteSpec>
> = {
  chatgpt: {
    site: "chatgpt",
    attachesPrompt: true,
    models: CHATGPT_MODELS,
    turn: async (invocation, exec) => {
      let modelSelected = true;
      if (invocation.selectModel) {
        try {
          await exec([
            "chatgpt",
            "model",
            invocation.siteModel,
            ...JSON_FORMAT
          ]);
        } catch (error) {
          writeErrorLine(
            `opencli chatgpt could not switch to ${invocation.siteModel}: ${errorMessage(error)}`
          );
          modelSelected = false;
        }
      }
      const reply = replyFromRow(
        firstRow(
          await exec([
            "chatgpt",
            "ask-file",
            invocation.typed
              ? typedPromptMarker(invocation.promptFile)
              : attachedPromptMessage(path.basename(invocation.promptFile)),
            "--file",
            invocation.promptFile,
            ...(invocation.typed ? ["--inline", "true"] : []),
            ...(invocation.conversationId
              ? ["--conversation", invocation.conversationId]
              : ["--new", "true"]),
            "--timeout",
            String(invocation.timeoutSeconds),
            ...JSON_FORMAT
          ])
        )
      );
      return answeredIn("ChatGPT", invocation.conversationId, {
        ...reply,
        modelSelected
      });
    }
  },
  gemini: {
    site: "gemini",
    attachesPrompt: false,
    models: async (exec) => {
      const rows = await exec(["gemini", "models", ...JSON_FORMAT]);
      return rows
        .map((row) => (typeof row.model === "string" ? row.model.trim() : ""))
        .filter((model) => model !== "");
    },
    turn: async (invocation, exec) => {
      const ask = (model: string | null, thinking: string | null) =>
        exec([
          "gemini",
          "ask",
          invocation.prompt,
          ...(model === null ? [] : ["--model", model]),
          ...(thinking == null ? [] : ["--thinking", thinking]),
          ...(invocation.conversationId
            ? ["--conversation", invocation.conversationId]
            : ["--new", "true"]),
          "--timeout",
          String(invocation.timeoutSeconds),
          ...JSON_FORMAT
        ]);
      let rows: JsonRecord[];
      let thinking: string | null = invocation.siteThinking;
      let modelSelected = true;
      try {
        rows = await ask(
          invocation.selectModel ? invocation.siteModel : null,
          invocation.siteThinking
        );
      } catch (error) {
        if (isGeminiThinkingSelectionFailure(error)) {
          writeErrorLine(
            `opencli gemini could not switch to ${invocation.siteThinking}: ${errorMessage(error)}`
          );
          rows = await ask(
            invocation.selectModel ? invocation.siteModel : null,
            null
          );
          thinking = null;
        } else if (isGeminiModelSelectionFailure(error)) {
          writeErrorLine(
            `opencli gemini could not switch to ${invocation.siteModel}: ${errorMessage(error)}`
          );
          rows = await ask(null, null);
          thinking = null;
          modelSelected = false;
        } else {
          throw geminiModelLimit(error) ?? error;
        }
      }
      const row = firstRow(rows);
      const { response } = replyFromRow(row);
      return answeredIn("Gemini", invocation.conversationId, {
        response: response.startsWith(GEMINI_REPLY_PREFIX)
          ? response.slice(GEMINI_REPLY_PREFIX.length)
          : response,
        conversationId: geminiConversationId(row.url),
        thinking,
        modelSelected
      });
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
