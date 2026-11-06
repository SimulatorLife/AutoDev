/**
 * One Codex turn served by a web chat site through opencli.
 *
 * opencli (`@jackwener/opencli`) drives a chat site -- chatgpt.com,
 * gemini.google.com -- through the user's own signed-in browser and returns
 * the assistant's reply as JSON. A site has no tool-calling API, so the bridge
 * is the model's only way to act: the turn's prompt carries Codex's tool
 * reference and a plain-text call syntax, the reply is parsed for calls, and
 * each call goes back to Codex as a Responses `custom_tool_call` or
 * `function_call` item. Codex runs it in the turn's sandbox with its approvals
 * and hooks, exactly as for any other model, and its next request carries the
 * output.
 *
 * The call syntax is the one `renderCodexTranscript` already uses for earlier
 * calls (`<tool_call name="...">`), so the model reads its own previous calls
 * in the same shape it is asked to write new ones.
 *
 * This module is pure: the prompt, the site's command line, the reply parser,
 * and the conversation ledger. `runtime/src/providers/opencli.ts` owns the
 * process and the HTTP surface.
 */

import { createHash } from "node:crypto";

import {
  OPENCLI_SITES,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";

import {
  type CodexTool,
  codexToolCallItem,
  codexToolReference,
  renderCodexTranscript
} from "./claude-codex-tools.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The short message sent alongside an attached prompt file.
 *
 * It never changes, so the site's reply detection -- which pairs the visible
 * user bubble with the prompt it was given -- always matches. A transcript
 * typed into the composer does not: the site renders its Markdown (fences
 * become labelled code blocks), the bubble no longer equals the prompt, and
 * opencli waits out its timeout on a reply that has already arrived.
 */
export const ATTACHED_PROMPT_MESSAGE =
  "Read the attached file turn.md and respond exactly as it instructs.";

/** The file name the prompt is attached under; the message above names it. */
export const ATTACHED_PROMPT_FILE = "turn.md";

export interface OpencliInvocation {
  /** The prompt as text, for a site that takes it on the command line. */
  readonly prompt: string;
  /** Where the prompt was written, for a site that takes it as an attachment. */
  readonly promptFile: string;
  /** The site conversation to continue, or null to start a new one. */
  readonly conversationId: string | null;
  readonly timeoutSeconds: number;
}

export interface OpencliSiteSpec {
  readonly site: OpencliSite;
  /** Whether the site's adapter can continue a conversation by its id. */
  readonly continues: boolean;
  /** Whether the prompt travels as an attached file rather than as argv. */
  readonly attachesPrompt: boolean;
  /** The opencli arguments for one turn. */
  args(invocation: OpencliInvocation): string[];
}

const JSON_FORMAT = ["-f", "json"] as const;

/**
 * Every served site's adapter contract, checked against opencli 2.0.2's
 * `--help -f json`.
 *
 * - ChatGPT takes the prompt as an attachment (`ask-file`), which keeps the
 *   reply detection reliable and whitespace exact, and continues a
 *   conversation with `--conversation`.
 * - Gemini's `ask` takes the prompt on the command line and offers no way to
 *   name a conversation, so every turn starts a new chat with the whole
 *   transcript.
 */
export const OPENCLI_SITE_SPECS: Readonly<
  Record<OpencliSite, OpencliSiteSpec>
> = {
  chatgpt: {
    site: "chatgpt",
    continues: true,
    attachesPrompt: true,
    args: (invocation) => [
      "chatgpt",
      "ask-file",
      ATTACHED_PROMPT_MESSAGE,
      "--file",
      invocation.promptFile,
      ...(invocation.conversationId
        ? ["--conversation", invocation.conversationId]
        : ["--new", "true"]),
      "--timeout",
      String(invocation.timeoutSeconds),
      ...JSON_FORMAT
    ]
  },
  gemini: {
    site: "gemini",
    continues: false,
    attachesPrompt: false,
    args: (invocation) => [
      "gemini",
      "ask",
      invocation.prompt,
      "--new",
      "true",
      "--timeout",
      String(invocation.timeoutSeconds),
      ...JSON_FORMAT
    ]
  }
};

// A site added to OPENCLI_SITES without a spec would route to a bridge that
// cannot serve it; fail at load instead.
for (const site of OPENCLI_SITES)
  if (!Object.hasOwn(OPENCLI_SITE_SPECS, site))
    throw new Error(`opencli site ${site} has no adapter spec`);

const RESPONSE_RULES = [
  "## How to respond",
  "You are the model behind a Codex coding agent working on the user's machine. You cannot see that machine and cannot run anything yourself: you act only by requesting tool calls, which the agent executes in its own sandbox. Their results arrive in the next message.",
  "You know nothing about the machine's files, directories, commands, or state except what tool results in the conversation show. Never guess or assume them: when the task needs such a fact and no tool result states it yet, your reply must be the tool calls that find it out.",
  "Reply in exactly one of two ways:",
  '1. To act, write one or more tool calls, each in exactly this form, with only the tool\'s input between the tags:\n\n<tool_call name="TOOL_NAME">\nINPUT\n</tool_call>\n\nFor a tool that takes raw text (such as `exec`, whose input is JavaScript source), INPUT is that text, with no Markdown fences. For a tool that takes JSON arguments, INPUT is one JSON object matching its schema. You may write a short note before the calls. Stop after the last call: do not invent its result.',
  "2. When the task is done, or you need nothing more from the tools, reply with your final answer as plain text and no tool_call tags.",
  "Never write a <tool_output> block yourself; only the agent produces those."
].join("\n\n");

const CONTINUATION_RULES =
  "The results of your tool calls, and any new messages, follow. Continue under the same rules: tool_call tags to act, plain text with no tags when you are done.";

/** The first prompt of a site conversation: everything the model needs. */
export function renderOpencliPrompt(
  instructions: string,
  tools: readonly CodexTool[],
  transcript: string
): string {
  return [
    "# Codex agent turn",
    RESPONSE_RULES,
    ...(instructions.trim()
      ? [`## Instructions\n\n${instructions.trim()}`]
      : []),
    tools.length > 0
      ? `## Tools\n\n${codexToolReference(tools)}`
      : "## Tools\n\nNo tools are available on this turn: answer in plain text.",
    `## Conversation\n\n${transcript}`,
    'Write the agent\'s next reply to the conversation above, following the rules under "How to respond".'
  ].join("\n\n");
}

/** A follow-up prompt inside a continued site conversation: only what is new. */
export function renderOpencliContinuation(delta: string): string {
  return `${CONTINUATION_RULES}\n\n${delta}`;
}

/**
 * Each conversation item as the text it renders to, skipping items that render
 * to nothing (reasoning, the tool surface itself).
 */
export function transcriptSegments(input: unknown): string[] {
  if (!Array.isArray(input)) return [renderCodexTranscript(input)];
  const segments: string[] = [];
  for (const item of input) {
    const text = renderCodexTranscript([item]);
    if (text) segments.push(text);
  }
  return segments;
}

/** Rolling digests of every prefix of `segments`: entry `i` covers `segments[0..i]`. */
export function prefixDigests(segments: readonly string[]): string[] {
  const digests: string[] = [];
  let previous = "";
  for (const segment of segments) {
    previous = createHash("sha256")
      .update(previous)
      .update("\0")
      .update(segment)
      .digest("hex");
    digests.push(previous);
  }
  return digests;
}

export interface ConversationResume {
  readonly conversationId: string;
  /** How many leading segments that conversation has already seen. */
  readonly seen: number;
}

/**
 * Which site conversation already holds a prefix of this transcript.
 *
 * Codex re-sends the whole conversation on every request. A site that can
 * continue a conversation only needs what it has not seen -- the tool outputs
 * and messages after its own last reply -- and re-sending a long transcript
 * through a browser composer is the slowest step of a turn. The ledger records,
 * after each reply, the digest of the transcript that reply ends; a later
 * request whose transcript starts with that prefix continues the conversation.
 *
 * An entry is consumed when it is used. Two requests that share a prefix --
 * a retry of the same turn, or a fork -- would otherwise both append to one web
 * conversation and the site's history would no longer match either
 * transcript; the second request starts a fresh conversation instead.
 */
export class OpencliConversationLedger {
  private readonly entries = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 256) {
    this.maxEntries = maxEntries;
  }

  private key(site: OpencliSite, digest: string): string {
    return `${site}:${digest}`;
  }

  /** The longest recorded prefix of `digests` for this site, consuming it. */
  take(
    site: OpencliSite,
    digests: readonly string[]
  ): ConversationResume | null {
    for (let index = digests.length - 1; index >= 0; index -= 1) {
      const digest = digests[index];
      if (digest === undefined) continue;
      const key = this.key(site, digest);
      const conversationId = this.entries.get(key);
      if (conversationId === undefined) continue;
      this.entries.delete(key);
      return { conversationId, seen: index + 1 };
    }
    return null;
  }

  record(site: OpencliSite, digest: string, conversationId: string): void {
    const key = this.key(site, digest);
    this.entries.delete(key);
    this.entries.set(key, conversationId);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface OpencliReply {
  readonly response: string;
  readonly conversationId: string | null;
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

/**
 * The reply in opencli's JSON envelope: `{ ok: true, data: [row] }` or
 * `{ ok: false, error: { code, message, exitCode, hint } }`.
 *
 * `ask` names the conversation `conversationId`, `ask-file` names it
 * `conversation_id`; both are read.
 */
export function parseOpencliOutput(
  stdout: string,
  exitCode: number | null
): OpencliReply {
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
  if (!isRecord(envelope))
    throw new OpencliCommandError(
      "opencli returned a non-object result",
      "INVALID_OUTPUT",
      exitCode
    );
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
  const row = Array.isArray(envelope.data) ? envelope.data[0] : envelope.data;
  if (!isRecord(row))
    throw new OpencliCommandError(
      "opencli returned no reply row",
      "INVALID_OUTPUT",
      exitCode
    );
  const response = stringField(row, "response");
  if (response === null)
    throw new OpencliCommandError(
      "opencli returned an empty reply",
      "EMPTY_RESPONSE",
      exitCode
    );
  return {
    response,
    conversationId: stringField(row, "conversationId", "conversation_id")
  };
}

export interface ParsedToolCall {
  readonly name: string;
  readonly input: string;
}

export interface ParsedReply {
  /** The reply's prose, with every call removed. */
  readonly text: string;
  readonly calls: ParsedToolCall[];
}

const TOOL_CALL_PATTERN =
  /<tool_call\s+name="([\w-]{1,64})"[^>]*>([\s\S]*?)<\/tool_call>/gu;
const FENCED_BODY_PATTERN = /^```[\w-]*\n([\s\S]*?)\n?```$/u;
const LEADING_NEWLINE_PATTERN = /^\r?\n/u;
const TRAILING_NEWLINE_PATTERN = /\r?\n$/u;
const BLANK_RUN_PATTERN = /\n{3,}/gu;

/**
 * The body of one call, as the tool should receive it.
 *
 * A chat model fences code by habit even when told not to; a fence around the
 * whole body is unwrapped, since Codex would otherwise run the backticks.
 */
function callBody(raw: string): string {
  const body = raw
    .replace(LEADING_NEWLINE_PATTERN, "")
    .replace(TRAILING_NEWLINE_PATTERN, "");
  const fenced = FENCED_BODY_PATTERN.exec(body.trim());
  return fenced?.[1] ?? body;
}

/** Split a site reply into its prose and the tool calls it requests. */
export function parseOpencliReply(response: string): ParsedReply {
  const calls: ParsedToolCall[] = [];
  const text = response
    .replaceAll(TOOL_CALL_PATTERN, (_match, name: string, body: string) => {
      calls.push({ name, input: callBody(body) });
      return "";
    })
    .replaceAll(BLANK_RUN_PATTERN, "\n\n")
    .trim();
  return { text, calls };
}

/**
 * The Responses item for one parsed call.
 *
 * A call to a tool Codex did not offer is still sent as a `function_call`:
 * Codex answers an unknown tool with an error output, which tells the model
 * its mistake on the next request instead of ending the turn on prose that
 * looks like a call.
 */
export function opencliToolCallItem(
  call: ParsedToolCall,
  tools: readonly CodexTool[],
  ids: { itemId: string; callId: string }
): JsonRecord {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool?.kind === "custom")
    return codexToolCallItem(tool, { input: call.input }, ids);
  if (tool) {
    let args: unknown;
    try {
      args = JSON.parse(call.input || "{}");
    } catch {
      args = null;
    }
    if (isRecord(args)) return codexToolCallItem(tool, args, ids);
  }
  // Unknown tool, or arguments that are not a JSON object: pass the text as
  // given so Codex reports the error to the model rather than the bridge
  // silently rewriting what it asked for.
  return {
    id: ids.itemId,
    type: "function_call",
    status: "completed",
    call_id: ids.callId,
    name: call.name,
    ...(tool?.namespace ? { namespace: tool.namespace } : {}),
    arguments: call.input
  };
}
