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

import { errorMessage } from "@simulatorlife/autodev-runtime/shared/error-message";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
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
  nestedToolNames,
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
 * model` names them (opencli 2.0.3's `CHATGPT_MODEL_TARGETS`; the command also
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

/** opencli's chat was not the one the turn named. */
export const CHAT_MISMATCH = "CHAT_MISMATCH";

/**
 * The reply, once it is shown to belong to the chat the turn continued.
 *
 * Several agents and sessions take turns in one browser tab per site, and
 * anything else driving that tab can move it between commands. A reply the
 * site gave in another chat answered a conversation this agent never saw;
 * recording it would also file another agent's chat under this one. It fails
 * the turn instead -- after sending, so it is not retried into the same chat.
 */
function answeredIn(
  site: string,
  expected: string | null,
  reply: OpencliReply
): OpencliReply {
  if (
    expected !== null &&
    reply.conversationId !== null &&
    reply.conversationId !== expected
  )
    throw new OpencliCommandError(
      `${site} answered in chat ${reply.conversationId}, not ${expected}`,
      CHAT_MISMATCH,
      null
    );
  return reply;
}

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
 * Every served site's adapter contract, checked against opencli 2.0.3.
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
 *   `--model`, and the chat with `--conversation <id>` or `--new` (AutoDev's
 *   opencli patch), which it opens and confirms on the sending page right
 *   before sending. The reply row carries the URL of the page that answered
 *   (`url`), which names the chat; a separate `status` could read another
 *   Gemini tab. `ask` also decorates every reply with a speech bubble, which
 *   is the adapter's, not the model's, and is removed. Its models are listed
 *   by `gemini models`.
 *
 * On both sites one command is the whole turn: it opens the chat, stops a
 * reply an interrupted turn left running there, and confirms on the page
 * that sends -- right before sending -- that it shows the turn's chat (a new
 * one for a fresh turn). Someone clicking in the tab, or anything else
 * driving the browser between turns, can then only fail a turn before its
 * prompt is sent, never redirect it. The bridge also runs a site's turns one
 * at a time, and checks that the reply came from the chat it continued.
 */
export const OPENCLI_SITE_SPECS: Readonly<
  Record<OpencliSite, OpencliSiteSpec>
> = {
  chatgpt: {
    site: "chatgpt",
    attachesPrompt: true,
    models: () => Promise.resolve([...CHATGPT_MODELS]),
    turn: async (invocation, exec) => {
      if (invocation.selectModel) {
        try {
          await exec([
            "chatgpt",
            "model",
            invocation.siteModel,
            ...JSON_FORMAT
          ]);
        } catch (error) {
          // The site's intelligence level is a preference, not the turn. The
          // picker needs a visible page, so a switch fails whenever the tab
          // is in the background -- which is how a machine runs when nobody
          // is watching it -- and a turn must not die of that: the site
          // keeps the level it has, the way Gemini's does when its model
          // picker is out of reach. A failure here is not the provider
          // being broken, and must not be reported as one.
          writeErrorLine(
            `opencli chatgpt could not switch to ${invocation.siteModel}: ${errorMessage(error)}`
          );
        }
      }
      const reply = replyFromRow(
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
      return answeredIn("ChatGPT", invocation.conversationId, reply);
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
      const ask = (model: string | null) =>
        exec([
          "gemini",
          "ask",
          invocation.prompt,
          ...(model === null ? [] : ["--model", model]),
          // opencli opens the chat, stops a reply an interrupted turn left
          // running, and confirms the chat on the sending page right before
          // sending (AutoDev's patch): nothing that moves the tab between
          // commands can redirect the prompt.
          ...(invocation.conversationId
            ? ["--conversation", invocation.conversationId]
            : ["--new", "true"]),
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
      // The chat comes from the page `ask` answered on (its `url`), never from
      // a later `status`: with more than one Gemini tab open, `status` can
      // bind another tab, and a subagent's follow-ups were then sent into an
      // older chat belonging to other sessions.
      const row = firstRow(rows);
      const { response } = replyFromRow(row);
      return answeredIn("Gemini", invocation.conversationId, {
        response: response.startsWith(GEMINI_REPLY_PREFIX)
          ? response.slice(GEMINI_REPLY_PREFIX.length)
          : response,
        conversationId: geminiConversationId(row.url)
      });
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

/** A heading in a code-mode tool's description: a server group or one nested tool. */
const CODE_MODE_HEADING = /^(#{2,3}) /u;
const NESTED_TOOL_HEADING = /^### `([^`]+)`/u;
/** The longest summary a compacted nested tool keeps. */
const COMPACT_SUMMARY_CHARS = 160;

/** The first prose line of a nested tool's section, cut to a summary. */
function sectionSummary(body: readonly string[]): string {
  const line =
    body.find((text) => {
      const trimmed = text.trim();
      return (
        trimmed !== "" &&
        !trimmed.startsWith("```") &&
        !trimmed.startsWith("declare ")
      );
    }) ?? "";
  const trimmed = line.trim();
  return trimmed.length > COMPACT_SUMMARY_CHARS
    ? `${trimmed.slice(0, COMPACT_SUMMARY_CHARS - 1)}…`
    : trimmed;
}

/** How much of each MCP tool a compacted reference keeps. */
export type ToolReferenceDetail = "summaries" | "names";

/**
 * A code-mode tool's description with its MCP tools named, not documented.
 *
 * `exec`'s description documents every nested tool -- a description and a
 * TypeScript declaration each -- and a root orchestrator in the Codex app has
 * enough connector and MCP tools that its first prompt reached 300 KB. Gemini
 * takes its prompt through the composer, which did not finish taking 300 KB
 * in 270 s, so no Gemini root could start (session
 * `01a1b914-9431-7620-ad4a-e6362957b1e6`). Codex itself leaves deferred tools
 * out of a subagent's description and points to `ALL_TOOLS`; this does the
 * same for MCP tools: the built-in tools (commands, files, delegation) keep
 * their full sections, and every `mcp__*` tool keeps its name -- with its
 * summary line, or alone when even summaries do not fit -- and how to read
 * the rest.
 */
export function compactCodeModeDescription(
  description: string,
  detail: ToolReferenceDetail = "summaries"
): string {
  const { preamble, sections } = codeModeSections(description);
  const out = [...preamble];
  let compacted = 0;
  let names: string[] = [];
  const flushNames = () => {
    if (names.length > 0)
      out.push(names.map((name) => `\`${name}\``).join(", "));
    names = [];
  };
  for (const { heading, body } of sections) {
    const name = NESTED_TOOL_HEADING.exec(heading)?.[1];
    if (name?.startsWith("mcp__")) {
      compacted += 1;
      if (detail === "names") names.push(name);
      else out.push(namedTool(name, sectionSummary(body)));
      continue;
    }
    flushNames();
    out.push(
      "",
      heading,
      ...(name === undefined ? groupNotes(body, detail) : body)
    );
  }
  flushNames();
  if (compacted > 0)
    out.push(
      "",
      `The ${compacted} \`mcp__*\` tools above are listed by name only, to keep this message short. Before calling one, read its full description inside \`exec\`: \`text(ALL_TOOLS.find((tool) => tool.name === "NAME").description)\`.`
    );
  return out.join("\n").replaceAll(/\n{3,}/gu, "\n\n");
}

/** A description's lines before its first heading, then each heading's section. */
function codeModeSections(description: string): {
  preamble: string[];
  sections: Array<{ heading: string; body: string[] }>;
} {
  const preamble: string[] = [];
  const sections: Array<{ heading: string; body: string[] }> = [];
  for (const line of description.split("\n")) {
    if (CODE_MODE_HEADING.test(line))
      sections.push({ heading: line, body: [] });
    else (sections.at(-1)?.body ?? preamble).push(line);
  }
  return { preamble, sections };
}

function namedTool(name: string, summary: string): string {
  return `- \`${name}\`${summary ? `: ${summary}` : ""}`;
}

/** A server group's notes, cut to their first line, or dropped with names only. */
function groupNotes(
  body: readonly string[],
  detail: ToolReferenceDetail
): string[] {
  const summary = sectionSummary(body);
  return summary && detail === "summaries" ? [summary] : [];
}

/** The tools with every code-mode description compacted. */
export function compactCodexTools(
  tools: readonly CodexTool[],
  detail: ToolReferenceDetail = "summaries"
): CodexTool[] {
  return tools.map((tool) =>
    tool.kind === "custom"
      ? {
          ...tool,
          description: compactCodeModeDescription(tool.description, detail)
        }
      : tool
  );
}

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
        tool.kind === "custom" ? nestedToolNames(tool.description) : [];
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

/** What the prompt says about the part of the conversation it left out. */
export function transcriptOmissionMarker(dropped: number): string {
  return `[${dropped} earlier message${dropped === 1 ? "" : "s"} of this conversation left out to keep it within the site's limit]`;
}

/** Room the omission marker needs, so the transcript can be sized around it. */
const OMISSION_MARKER_BYTES = 200;

/**
 * The conversation, shortened to what a site's limit allows.
 *
 * A conversation grows with every tool result, and a chat that is new has to
 * carry all of it: the prompt a site gets is the whole conversation. The
 * limit is on the whole prompt, and the tool reference is not what fills it
 * -- the tool results are. So what is left out is the middle of the
 * conversation: the task and the most recent turns are what the next call
 * needs, and the turns between them are the ones a later turn is least
 * likely to read. The model is told that they are gone, rather than left to
 * find a conversation with a hole in it.
 */
export function compactTranscript(
  segments: readonly string[],
  budgetBytes: number
): { readonly text: string; readonly dropped: number } {
  const joined = segments.join("\n\n");
  if (segments.length === 0 || Buffer.byteLength(joined) <= budgetBytes)
    return { text: joined, dropped: 0 };
  const first = segments[0]!;
  let size = Buffer.byteLength(first);
  const kept: string[] = [];
  for (let index = segments.length - 1; index >= 1; index -= 1) {
    const segment = segments[index]!;
    const cost = Buffer.byteLength(segment) + 2;
    if (size + cost + OMISSION_MARKER_BYTES > budgetBytes) break;
    size += cost;
    kept.unshift(segment);
  }
  const dropped = segments.length - 1 - kept.length;
  // Nothing was left out: the conversation fits once the head is counted
  // against the limit, or the first message alone is larger than it is.
  if (dropped <= 0) return { text: joined, dropped: 0 };
  return {
    text: [first, transcriptOmissionMarker(dropped), ...kept].join("\n\n"),
    dropped
  };
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

  /**
   * An entry belongs to one site and one Codex thread. The transcript digest
   * alone identified a chat by its content, so two threads whose transcripts
   * began alike -- subagents spawned with the same task -- could resolve to
   * one chat; the thread makes every agent's chats its own.
   */
  private key(scope: OpencliChatScope, digest: string): string {
    return `${scope.site}:${scope.thread ?? NO_THREAD}:${digest}`;
  }

  /** The longest recorded prefix of `digests` in this site and thread. */
  find(
    scope: OpencliChatScope,
    digests: readonly string[]
  ): ConversationResume | null {
    for (let index = digests.length - 1; index >= 0; index -= 1) {
      const digest = digests[index];
      if (digest === undefined) continue;
      const conversationId = this.entries.get(this.key(scope, digest));
      if (conversationId === undefined) continue;
      return { conversationId, seen: index + 1, digest };
    }
    return null;
  }

  /** Spend an entry once the turn that continued from it has succeeded. */
  consume(scope: OpencliChatScope, digest: string): void {
    if (this.entries.delete(this.key(scope, digest))) this.save();
  }

  record(
    scope: OpencliChatScope,
    digest: string,
    conversationId: string
  ): void {
    const key = this.key(scope, digest);
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
const LEDGER_KEY_PATTERN = /^[a-z]+:[\w.-]{1,128}:[0-9a-f]{64}$/u;
/** The thread part of a key for a request that named no Codex thread. */
const NO_THREAD = "-";

/** Whose chats an entry belongs to: one site, one Codex thread (agent). */
export interface OpencliChatScope {
  readonly site: OpencliSite;
  /** The Codex thread; null when the request named none. */
  readonly thread: string | null;
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
