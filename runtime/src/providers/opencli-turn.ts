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

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import {
  OPENCLI_SITES,
  type OpencliSite
} from "@simulatorlife/autodev-runtime/shared/provider-model-ids";
import {
  MULTI_AGENT_CLOSE_TOOL,
  MULTI_AGENT_SPAWN_TOOL,
  MULTI_AGENT_WAIT_TOOL
} from "@simulatorlife/autodev-runtime/shared/tool-names";

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
 * The file name a turn's prompt is attached under: unique per turn.
 *
 * ChatGPT renames an upload whose name it has seen before
 * (`turn(20261106-183651).md`), and opencli recognises its own attachment
 * chip only by the name it uploaded (or a `name (N).ext` copy suffix), so a
 * reused name left `ask-file` waiting for a chip it never matched -- every
 * turn after the first few failed with "new ready attachment chips did not
 * appear". A fresh name per turn is never renamed.
 */
export function attachedPromptFileName(): string {
  return `turn-${randomBytes(6).toString("hex")}.md`;
}

/**
 * The short message sent alongside an attached prompt file.
 *
 * It is plain text with no Markdown, so the site's reply detection -- which
 * pairs the visible user bubble with the prompt it was given -- always
 * matches. A transcript typed into the composer does not: the site renders its
 * Markdown (fences become labelled code blocks), the bubble no longer equals
 * the prompt, and opencli waits out its timeout on a reply that already
 * arrived.
 */
export function attachedPromptMessage(fileName: string): string {
  return `Read the attached file ${fileName} and respond exactly as it instructs.`;
}

export interface OpencliInvocation {
  /** The prompt as text, for a site that takes it on the command line. */
  readonly prompt: string;
  /** Where the prompt was written, for a site that takes it as an attachment. */
  readonly promptFile: string;
  /** The site conversation to continue, or null to start a new one. */
  readonly conversationId: string | null;
  /** The site's own model name the turn asks (`advanced`, `3.1-pro`). */
  readonly siteModel: string;
  /**
   * Whether the site's model has to be switched before asking. A site whose
   * model is an account setting (ChatGPT) is switched only when the turn asks
   * for a different one than the bridge last selected.
   */
  readonly selectModel: boolean;
  readonly timeoutSeconds: number;
}

/**
 * Runs one opencli command and returns the rows of its JSON result. The
 * bridge supplies it: it owns the process, the cancellation, and waiting out a
 * site session the daemon is still releasing.
 */
export type OpencliExec = (args: readonly string[]) => Promise<JsonRecord[]>;

export interface OpencliSiteSpec {
  readonly site: OpencliSite;
  /** Whether the prompt travels as an attached file rather than as argv. */
  readonly attachesPrompt: boolean;
  /** The site models this account can be asked, as opencli names them. */
  models(exec: OpencliExec): Promise<string[]>;
  /**
   * One turn: the commands that deliver the prompt into the right site
   * conversation with the right model and read back the reply, and the
   * conversation it is in.
   */
  turn(invocation: OpencliInvocation, exec: OpencliExec): Promise<OpencliReply>;
}

const GEMINI_REPLY_PREFIX = "💬 ";
const GEMINI_CONVERSATION_PATTERN = /\/app\/([\w-]+)/u;
const JSON_FORMAT = ["-f", "json"] as const;

/**
 * ChatGPT's selectable models and intelligence levels, as `opencli chatgpt
 * model` names them (opencli 2.0.2's `CHATGPT_MODEL_TARGETS`; the command also
 * takes aliases such as `thinking` for `advanced`, which are not separate
 * models). ChatGPT has no model-list command, so this is the list.
 */
export const CHATGPT_MODELS = Object.freeze([
  "fast",
  "balanced",
  "advanced",
  // opencli's `xhigh` alias for Very High: an id ending `-high` would read
  // as an effort variant of `opencli-chatgpt-very` (agy's id convention).
  "xhigh",
  "pro",
  "gpt-5.6-pro"
]);

/** opencli could not open or read Gemini's model picker, so selected no model. */
const GEMINI_MODEL_SELECTION_FAILURE =
  /Gemini model discovery returned no selectable models|Gemini model selection|Failed to open model picker|not found in picker menu/u;

function isGeminiModelSelectionFailure(error: unknown): boolean {
  return (
    error instanceof OpencliCommandError &&
    GEMINI_MODEL_SELECTION_FAILURE.test(error.message)
  );
}

/** The conversation a Gemini `/app/<id>` URL names, or null for any other page. */
export function geminiConversationId(url: unknown): string | null {
  return typeof url === "string"
    ? (GEMINI_CONVERSATION_PATTERN.exec(url)?.[1] ?? null)
    : null;
}

function firstRow(rows: JsonRecord[]): JsonRecord {
  const row = rows[0];
  if (!row)
    throw new OpencliCommandError(
      "opencli returned no result row",
      "INVALID_OUTPUT",
      null
    );
  return row;
}

/**
 * Every served site's adapter contract, checked against opencli 2.0.2.
 *
 * Both sites continue a conversation, so a turn after the first sends only
 * what the site has not seen. Without that, every request re-sends the whole
 * transcript, which grows with every tool output until it no longer fits:
 * a Gemini worker turn was refused after ~25 tool calls once its prompt
 * passed the command-line limit.
 *
 * - ChatGPT takes the prompt as an attachment (`ask-file`), which keeps the
 *   reply detection reliable and whitespace exact, and names the conversation
 *   to continue with `--conversation`; the reply row carries its id. Its model
 *   is an account setting switched with `chatgpt model <level>`.
 * - Gemini's `ask` takes the prompt on the command line, the model with
 *   `--model`, and continues whichever conversation its tab shows. A continued
 *   turn therefore opens the conversation first (`detail <id>`), and every turn
 *   reads the conversation id back from the tab (`status`), since `ask` does
 *   not report it. The bridge runs a site's turns one at a time, so nothing
 *   moves the tab in between. `ask` also decorates every reply with a speech
 *   bubble, which is the adapter's, not the model's, and is removed. Its models
 *   are listed by `gemini models`.
 */
export const OPENCLI_SITE_SPECS: Readonly<
  Record<OpencliSite, OpencliSiteSpec>
> = {
  chatgpt: {
    site: "chatgpt",
    attachesPrompt: true,
    models: () => Promise.resolve([...CHATGPT_MODELS]),
    turn: async (invocation, exec) => {
      if (invocation.selectModel)
        await exec(["chatgpt", "model", invocation.siteModel, ...JSON_FORMAT]);
      return replyFromRow(
        firstRow(
          await exec([
            "chatgpt",
            "ask-file",
            attachedPromptMessage(path.basename(invocation.promptFile)),
            "--file",
            invocation.promptFile,
            ...(invocation.conversationId
              ? ["--conversation", invocation.conversationId]
              : ["--new", "true"]),
            "--timeout",
            String(invocation.timeoutSeconds),
            ...JSON_FORMAT
          ])
        )
      );
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
      if (invocation.conversationId)
        await exec([
          "gemini",
          "detail",
          invocation.conversationId,
          ...JSON_FORMAT
        ]);
      const ask = (model: string | null) =>
        exec([
          "gemini",
          "ask",
          invocation.prompt,
          ...(model === null ? [] : ["--model", model]),
          ...(invocation.conversationId ? [] : ["--new", "true"]),
          "--timeout",
          String(invocation.timeoutSeconds),
          ...JSON_FORMAT
        ]);
      let rows: JsonRecord[];
      try {
        rows = await ask(invocation.siteModel);
      } catch (error) {
        // Gemini's model picker does not render in a hidden or covered
        // window, and opencli then cannot select any model -- before anything
        // is sent. A root turn failed outright that way; it is asked with the
        // model the site already has instead.
        if (!isGeminiModelSelectionFailure(error)) throw error;
        rows = await ask(null);
      }
      const { response } = replyFromRow(firstRow(rows));
      const status = firstRow(await exec(["gemini", "status", ...JSON_FORMAT]));
      return {
        response: response.startsWith(GEMINI_REPLY_PREFIX)
          ? response.slice(GEMINI_REPLY_PREFIX.length)
          : response,
        conversationId: geminiConversationId(status.Url)
      };
    }
  }
};

// A site added to OPENCLI_PROVIDER_SITES without a spec would route to a
// bridge that cannot serve it; fail at load instead.
for (const site of OPENCLI_SITES)
  if (!Object.hasOwn(OPENCLI_SITE_SPECS, site))
    throw new Error(`opencli site ${site} has no adapter spec`);

const RESPONSE_RULES = [
  "## How to respond",
  "You are the model behind a Codex coding agent working on the user's machine. You cannot see that machine and cannot run anything yourself: you act only by requesting tool calls, which the agent executes in its own sandbox. Their results arrive in the next message.",
  "You know nothing about the machine's files, directories, commands, or state except what tool results in the conversation show. Never guess or assume them: when the task needs such a fact and no tool result states it yet, your reply must be the tool calls that find it out.",
  "Your own chat tools -- this site's Python or code sandbox, file search, browsing -- run somewhere else, not on the agent's machine. They cannot see its repository, its files, or its tools, so never use them to check whether a path, a file, or a tool exists. A repository path or a function on `tools` (such as the `multi_agent_v1__*` delegation functions) is checked only through a tool call to the agent, for example `exec` running `text(typeof tools.multi_agent_v1__spawn_agent)`. Never report a capability or path as unavailable unless a tool result in this conversation shows it.",
  "Reply in exactly one of two ways:",
  '1. To act, write one or more tool calls, each in exactly this form, with only the tool\'s input between the tags:\n\n<tool_call name="TOOL_NAME">\nINPUT\n</tool_call>\n\nFor a tool that takes raw text (such as `exec`, whose input is JavaScript source), INPUT is that text, with no Markdown fences. For a tool that takes JSON arguments, INPUT is one JSON object matching its schema. You may write a short note before the calls. Stop after the last call: do not invent its result.',
  "2. When the task is done, or you need nothing more from the tools, reply with your final answer as plain text and no tool_call tags.",
  "Never write a <tool_output> block yourself; only the agent produces those."
].join("\n\n");

const CONTINUATION_HEADER =
  "The conversation so far is in this chat's earlier messages. What follows is everything new since your last reply: the results of your tool calls and any new messages.";

function toolsSection(tools: readonly CodexTool[]): string {
  return tools.length > 0
    ? `## Tools\n\n${codexToolReference(tools)}`
    : "## Tools\n\nNo tools are available on this turn: answer in plain text.";
}

/**
 * The role prompt the bridge adds for a role whose instructions Codex does not
 * carry whole.
 *
 * A root orchestrator's policy reaches Codex as the root-delegation hook's
 * additional context, and Codex truncates it (an opencli-gemini root turn
 * received "Warning: truncated output (original token count: 6282)" and only
 * the first ~10 KB) -- the delegation half did not survive, and the model did
 * every step itself. The CLI bridges add the full role prompt from the router's
 * role header; this is the same for opencli, and it travels with every turn
 * because a site does not keep an earlier attachment in context.
 */
function roleSection(role: string | null): string[] {
  return role ? [`## Your role\n\n${role}`] : [];
}

const NEXT_REPLY =
  "Write the agent's next reply to the conversation above, following the response rules.";

/** The first prompt of a site conversation: everything the model needs. */
export function renderOpencliPrompt(
  instructions: string,
  tools: readonly CodexTool[],
  transcript: string,
  role: string | null = null
): string {
  return [
    "# Codex agent turn",
    RESPONSE_RULES,
    ...(instructions.trim()
      ? [`## Instructions\n\n${instructions.trim()}`]
      : []),
    ...roleSection(role),
    toolsSection(tools),
    `## Conversation\n\n${transcript}`,
    NEXT_REPLY
  ].join("\n\n");
}

const CONTINUATION_RULES =
  'Same rules as this chat\'s first message: to act, reply with <tool_call name="TOOL_NAME">INPUT</tool_call> blocks (raw JavaScript for `exec`, one JSON object for a function tool) and stop after the last call; when the task is done, reply in plain text with no tags. Nothing about the machine is known except what tool results show, and your own chat tools (Python, file search) cannot see it.';

const ORCHESTRATOR_REMINDER = `You are still the root orchestrator, under the full role instructions in this chat's first message: delegate substantive work to child agents with \`tools.${MULTI_AGENT_SPAWN_TOOL}\` inside \`exec\`, follow them with \`tools.${MULTI_AGENT_WAIT_TOOL}\`, and close finished ones with \`tools.${MULTI_AGENT_CLOSE_TOOL}\`.`;

/**
 * A call-shaped identifier in a code-mode tool's description (`exec_command(`).
 * Codex's tool names are snake_case, so only names with an underscore count.
 */
const NESTED_TOOL_PATTERN = /\b([a-z]\w*)\(/gu;

/**
 * Every tool by name, with the functions `exec` exposes: a reminder, not a
 * reference. The full reference is in the conversation's first message.
 */
export function toolIndex(tools: readonly CodexTool[]): string {
  if (tools.length === 0)
    return "No tools are available on this turn: answer in plain text.";
  return tools
    .map((tool) => {
      const description = tool.description.trim();
      const newline = description.indexOf("\n");
      const summary =
        newline === -1 ? description : description.slice(0, newline);
      const nested =
        tool.kind === "custom"
          ? [
              ...new Set(
                Array.from(
                  tool.description.matchAll(NESTED_TOOL_PATTERN),
                  (match) => match[1] ?? ""
                ).filter((name) => name.includes("_"))
              )
            ]
          : [];
      return `- \`${tool.name}\`${summary ? `: ${summary}` : ""}${nested.length > 0 ? ` Functions on \`tools\`: ${nested.map((name) => `\`${name}\``).join(", ")}.` : ""}`;
    })
    .join("\n");
}

/**
 * A follow-up prompt inside a continued site conversation.
 *
 * A chat keeps its own history, so the first message of a conversation
 * carries everything -- rules, instructions, role, the full tool reference,
 * the transcript -- and a follow-up carries only what is new: the results of
 * the model's calls and any new messages. Re-sending the reference and role
 * on every turn made each attachment tens of kilobytes for one tool output.
 * The follow-up still restates the call syntax, names every tool (and the
 * functions `exec` exposes), and for an orchestrator says it is still
 * orchestrating: given only a tool output, ChatGPT once read a spawn result
 * as a document and said it could not wait for the child, when the next step
 * was a `wait_agent` call it no longer had in view.
 */
export function renderOpencliContinuation(
  tools: readonly CodexTool[],
  delta: string,
  orchestrator = false
): string {
  return [
    "# Codex agent turn (continued)",
    CONTINUATION_RULES,
    ...(orchestrator ? [ORCHESTRATOR_REMINDER] : []),
    `## Tools\n\n${toolIndex(tools)}`,
    `## New in the conversation\n\n${CONTINUATION_HEADER}\n\n${delta}`,
    NEXT_REPLY
  ].join("\n\n");
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
  /** The recorded prefix this resumes from, to spend once the turn succeeds. */
  readonly digest: string;
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
 * An entry is spent when the turn that continued from it succeeds, not when
 * the turn starts. A retry of a failed turn therefore continues the same web
 * conversation -- at worst re-sending the new items the site already saw --
 * instead of starting a fresh chat with the whole transcript in one huge
 * attachment, which is what a router retry after a headers timeout did: the
 * model, handed that attachment, said its delegation tools did not exist.
 */
export class OpencliConversationLedger {
  private readonly entries = new Map<string, string>();
  private readonly maxEntries: number;
  private readonly file: string | null;

  /**
   * `file` keeps the ledger across bridge restarts. Held only in memory, it
   * was lost on every deploy, crash or reboot, and the next message in an
   * AutoDev session -- a user's "Continue" an hour later -- started a new chat
   * with the whole transcript as its first message (225 KB in one case)
   * instead of continuing the chat the session had been using.
   */
  constructor(options: { maxEntries?: number; file?: string | null } = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    this.file = options.file ?? null;
    this.load();
  }

  private key(site: OpencliSite, digest: string): string {
    return `${site}:${digest}`;
  }

  /** The longest recorded prefix of `digests` for this site. */
  find(
    site: OpencliSite,
    digests: readonly string[]
  ): ConversationResume | null {
    for (let index = digests.length - 1; index >= 0; index -= 1) {
      const digest = digests[index];
      if (digest === undefined) continue;
      const conversationId = this.entries.get(this.key(site, digest));
      if (conversationId === undefined) continue;
      return { conversationId, seen: index + 1, digest };
    }
    return null;
  }

  /** Spend an entry once the turn that continued from it has succeeded. */
  consume(site: OpencliSite, digest: string): void {
    if (this.entries.delete(this.key(site, digest))) this.save();
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
    this.save();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Read the saved ledger; an unreadable file is an empty ledger, not a failure. */
  private load(): void {
    if (this.file === null || !existsSync(this.file)) return;
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const entries =
        isRecord(saved) && Array.isArray(saved.entries) ? saved.entries : [];
      for (const entry of entries.slice(-this.maxEntries)) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          LEDGER_KEY_PATTERN.test(entry[0]) &&
          typeof entry[1] === "string" &&
          entry[1].length > 0
        )
          this.entries.set(entry[0], entry[1]);
      }
    } catch {
      this.entries.clear();
    }
  }

  /** Write the ledger atomically, oldest entry first, so eviction order survives. */
  private save(): void {
    if (this.file === null) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      writeFileSync(
        temporary,
        JSON.stringify({ schema: LEDGER_SCHEMA, entries: [...this.entries] }),
        { mode: 0o600 }
      );
      renameSync(temporary, this.file);
    } catch {
      // A ledger that cannot be written still serves this process; the next
      // restart then starts fresh chats, which is the state before persisting.
    }
  }
}

const LEDGER_SCHEMA = "autodev-opencli-conversations-v1";
const LEDGER_KEY_PATTERN = /^[a-z]+:[0-9a-f]{64}$/u;

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
 * The rows of opencli's JSON envelope: `{ ok: true, data: [rows] }`, or the
 * typed failure in `{ ok: false, error: { code, message, exitCode, hint } }`.
 */
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
  const data = Array.isArray(envelope.data) ? envelope.data : [envelope.data];
  return data.filter(isRecord);
}

/**
 * The reply an `ask` row carries. `ask` names the conversation
 * `conversationId`, `ask-file` names it `conversation_id`; both are read.
 */
export function replyFromRow(row: JsonRecord): OpencliReply {
  const response = stringField(row, "response");
  if (response === null)
    throw new OpencliCommandError(
      "opencli returned an empty reply",
      "EMPTY_RESPONSE",
      null
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
