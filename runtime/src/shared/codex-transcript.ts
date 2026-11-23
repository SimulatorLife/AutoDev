/**
 * Provider-neutral Codex tool-surface, transcript-segmentation, and prompt
 * formatting helpers shared across all AutoDev bridges and the router.
 *
 * Bridges adapt model transports without becoming a second agent harness:
 * Codex owns tools, sandbox, approvals, hooks, subagents, and full rollout
 * history. This module projects Codex's tool surface and `payload.input`
 * history cleanly across every text-transcript bridge (`antigravity`,
 * `claude`, `copilot`, `opencli`) as well as native JSON/Responses hops.
 */

import { isRecord } from "@simulatorlife/autodev-core";
import { requestContentParts } from "@simulatorlife/autodev-runtime/shared/request-content";
import { MCP_SERVER_FILESYSTEM } from "@simulatorlife/autodev-runtime/shared/tool-names";

type JsonRecord = Record<string, unknown>;

/** One tool Codex offered on this request, flattened out of any namespace. */
export interface CodexTool {
  kind: "custom" | "function";
  name: string;
  description: string;
  /** JSON schema of a function tool's arguments. */
  parameters: JsonRecord | null;
  /** The namespace Codex grouped the tool under, when it was not `functions`. */
  namespace: string | null;
}

export interface CodexToolSurface {
  tools: CodexTool[];
  /** Codex offered its hosted web search, which only the provider can perform. */
  webSearch: boolean;
}

/** The MCP server name the bridge registers; CLI tools reach it as `mcp__codex__<tool>`. */
export const CODEX_TOOLS_SERVER = "codex";

/**
 * How a bridged model works with files: through the `filesystem` MCP server,
 * the one file surface every provider is offered.
 */
export const FILE_SURFACE_GUIDANCE = `Files are read and edited only through the \`${MCP_SERVER_FILESYSTEM}\` MCP server: \`read_text_file\`, \`read_multiple_files\`, \`read_media_file\`, \`list_directory\`, \`directory_tree\`, \`search_files\` and \`get_file_info\` to read, and, unless the turn is read-only, \`edit_file\`, \`write_file\`, \`create_directory\` and \`move_file\` to change them. It is confined to the workspace; give it absolute paths inside it. Run programs with the shell, but do not read or write files with shell commands.`;

const DEFAULT_NAMESPACE = "functions";
const HOSTED_WEB_SEARCH_TYPES = new Set(["web_search", "web_search_preview"]);
const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_OUTPUT_ITEM_ADDED = "response.output_item.added";
const EVENT_OUTPUT_ITEM_DONE = "response.output_item.done";
const DATA_URL_REGEX = /^data:([^;,]+);base64,(.*)$/su;
const CODEX_OUTPUT_FAILED_REGEX =
  /^(aborted|script (failed|error|timed out)|error\b)/iu;

function parseCodexTool(
  entry: JsonRecord,
  type: "custom" | "function",
  namespace: string | null
): CodexTool | null {
  const definition =
    type === "function" && isRecord(entry.function) ? entry.function : entry;
  const name =
    typeof definition.name === "string" ? definition.name.trim() : "";
  if (!MCP_TOOL_NAME.test(name)) return null;
  return {
    kind: type,
    name,
    description:
      typeof definition.description === "string" ? definition.description : "",
    parameters:
      type === "function" && isRecord(definition.parameters)
        ? definition.parameters
        : null,
    namespace: namespace && namespace !== DEFAULT_NAMESPACE ? namespace : null
  };
}

function collectTools(
  entries: unknown,
  namespace: string | null,
  surface: CodexToolSurface,
  seen: Set<string>
): void {
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isRecord(entry)) continue;
    const type = entry.type;
    if (typeof type === "string" && HOSTED_WEB_SEARCH_TYPES.has(type)) {
      surface.webSearch = true;
      continue;
    }
    if (type === "namespace") {
      const name =
        typeof entry.name === "string" && entry.name.trim()
          ? entry.name.trim()
          : null;
      collectTools(entry.tools, name, surface, seen);
      continue;
    }
    if (type !== "custom" && type !== "function") continue;
    const tool = parseCodexTool(entry, type, namespace);
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    surface.tools.push(tool);
  }
}

/** Every tool Codex offered this turn: top-level `tools` and `additional_tools` items. */
export function codexToolSurface(payload: unknown): CodexToolSurface {
  const surface: CodexToolSurface = { tools: [], webSearch: false };
  if (!isRecord(payload)) return surface;
  const seen = new Set<string>();
  collectTools(payload.tools, null, surface, seen);
  for (const item of Array.isArray(payload.input) ? payload.input : []) {
    if (isRecord(item) && item.type === "additional_tools")
      collectTools(item.tools, null, surface, seen);
  }
  return surface;
}

const NESTED_TOOL_CALL = /\b([a-z]\w*)\(/gu;

/** The functions a code-mode tool's description declares on the `tools` global. */
export function nestedToolNames(description: string): string[] {
  return [
    ...new Set(
      Array.from(
        description.matchAll(NESTED_TOOL_CALL),
        (match) => match[1] ?? ""
      ).filter((name) => name.includes("_"))
    )
  ].sort();
}

/** The full reference for every mirrored tool, for the system prompt. */
export function codexToolReference(tools: readonly CodexTool[]): string {
  return tools
    .map((tool) => {
      const input =
        tool.kind === "custom"
          ? "Input: the tool's raw text, passed as the `input` string (for `exec`, JavaScript source with no markdown fences)."
          : `Arguments (JSON schema): ${JSON.stringify(tool.parameters ?? { type: "object", properties: {} })}`;
      const nested =
        tool.kind === "custom" ? nestedToolNames(tool.description) : [];
      const functions =
        nested.length > 0
          ? `\n\nFunctions on \`tools\`: ${nested.map((name) => `\`${name}\``).join(", ")}.`
          : "";
      return `### \`${tool.name}\`\n\n${tool.description.trim()}\n\n${input}${functions}`;
    })
    .join("\n\n");
}

/**
 * The full reference for every mirrored tool, for a bridge that reaches MCP
 * servers through one generic dispatcher.
 */
export function codexToolReferenceForDispatcher(
  tools: readonly CodexTool[],
  dispatcher: string
): string {
  return [
    "## Codex tools",
    `Your command tools are not your own: they are the Codex agent's, and they run in its sandbox, under its approvals and with its hooks, so every action they take is recorded against this thread. They live on the \`${CODEX_TOOLS_SERVER}\` MCP server, which you reach through your \`${dispatcher}\` dispatcher: \`ServerName\` is \`${CODEX_TOOLS_SERVER}\`, \`ToolName\` is the tool named below, and \`Arguments\` are that tool's own arguments.`,
    codexToolReference(tools)
  ].join("\n\n");
}

/** The MCP `tools/list` entry that stands in for one Codex tool. */
export function mcpToolDefinition(tool: CodexTool): JsonRecord {
  const trimmed = tool.description.trim();
  const newlineIndex = trimmed.indexOf("\n");
  const summary =
    newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex);
  const description = `${summary}\n\nFull reference: the "${tool.name}" section under "Codex tools" in your instructions.`;
  if (tool.kind === "custom") {
    return {
      name: tool.name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          input: { type: "string", description: "The tool's raw input text." }
        },
        required: ["input"]
      }
    };
  }
  return {
    name: tool.name,
    description,
    inputSchema: tool.parameters ?? { type: "object", properties: {} }
  };
}

export interface ToolCallIds {
  itemId: string;
  callId: string;
}

/** The completed Responses output item for one call the model made. */
export function codexToolCallItem(
  tool: CodexTool,
  args: unknown,
  ids: ToolCallIds
): JsonRecord {
  if (tool.kind === "custom") {
    const input =
      isRecord(args) && typeof args.input === "string" ? args.input : "";
    return {
      id: ids.itemId,
      type: "custom_tool_call",
      status: "completed",
      call_id: ids.callId,
      name: tool.name,
      input
    };
  }
  return {
    id: ids.itemId,
    type: "function_call",
    status: "completed",
    call_id: ids.callId,
    name: tool.name,
    ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(isRecord(args) ? args : {})
  };
}

/** The SSE events that stream one call item, emitted whole once the call is known. */
export function codexToolCallEvents(
  item: JsonRecord,
  outputIndex: number
): Array<[string, JsonRecord]> {
  const itemId = String(item.id);
  if (item.type === "custom_tool_call") {
    const input = String(item.input ?? "");
    return [
      [
        EVENT_OUTPUT_ITEM_ADDED,
        {
          type: EVENT_OUTPUT_ITEM_ADDED,
          output_index: outputIndex,
          item: { ...item, input: "", status: "in_progress" }
        }
      ],
      [
        "response.custom_tool_call_input.delta",
        {
          type: "response.custom_tool_call_input.delta",
          item_id: itemId,
          output_index: outputIndex,
          delta: input
        }
      ],
      [
        "response.custom_tool_call_input.done",
        {
          type: "response.custom_tool_call_input.done",
          item_id: itemId,
          output_index: outputIndex,
          input
        }
      ],
      [
        EVENT_OUTPUT_ITEM_DONE,
        { type: EVENT_OUTPUT_ITEM_DONE, output_index: outputIndex, item }
      ]
    ];
  }
  const argumentsText = String(item.arguments ?? "");
  return [
    [
      EVENT_OUTPUT_ITEM_ADDED,
      {
        type: EVENT_OUTPUT_ITEM_ADDED,
        output_index: outputIndex,
        item: { ...item, arguments: "", status: "in_progress" }
      }
    ],
    [
      "response.function_call_arguments.delta",
      {
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: outputIndex,
        delta: argumentsText
      }
    ],
    [
      "response.function_call_arguments.done",
      {
        type: "response.function_call_arguments.done",
        item_id: itemId,
        output_index: outputIndex,
        arguments: argumentsText
      }
    ],
    [
      EVENT_OUTPUT_ITEM_DONE,
      { type: EVENT_OUTPUT_ITEM_DONE, output_index: outputIndex, item }
    ]
  ];
}

const TOOL_CALL_TYPES = new Set(["custom_tool_call", "function_call"]);
const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output"
]);

function appendOutputPart(
  part: unknown,
  content: JsonRecord[],
  addText: (text: string) => void
): void {
  if (typeof part === "string") {
    addText(part);
    return;
  }
  if (!isRecord(part)) return;
  if (typeof part.text === "string") {
    addText(part.text);
    return;
  }
  const url = typeof part.image_url === "string" ? part.image_url : null;
  const match = url ? DATA_URL_REGEX.exec(url) : null;
  if (match)
    content.push({ type: "image", mimeType: match[1], data: match[2] });
}

/** An MCP `tools/call` result carrying what Codex returned for the call. */
export function mcpResultFromCodexOutput(output: unknown): JsonRecord {
  const content: JsonRecord[] = [];
  const addText = (text: string) => {
    if (text) content.push({ type: "text", text });
  };
  if (typeof output === "string") addText(output);
  else if (Array.isArray(output)) {
    for (const part of output) appendOutputPart(part, content, addText);
  } else if (isRecord(output) && typeof output.content === "string")
    addText(output.content);
  else if (output !== undefined && output !== null)
    addText(JSON.stringify(output));
  if (content.length === 0) content.push({ type: "text", text: "(no output)" });
  return { content };
}

/** Whether Codex reported the call as failed rather than run. */
export function codexOutputFailed(output: unknown): boolean {
  const trimmed = outputText(output).trimStart();
  const newlineIndex = trimmed.indexOf("\n");
  const first = newlineIndex === -1 ? trimmed : trimmed.slice(0, newlineIndex);
  return CODEX_OUTPUT_FAILED_REGEX.test(first);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.image_url === "string" || part.type === "input_image")
        return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return textOf(output);
  if (isRecord(output) && typeof output.content === "string")
    return output.content;
  return output === undefined || output === null ? "" : JSON.stringify(output);
}

export function messageText(content: unknown): string {
  return requestContentParts(content)
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

const NON_TASK_USER_PREFIXES = [
  "<subagent_notification>",
  "<turn_aborted>",
  "<environment_context>",
  "<permissions instructions>",
  "# AGENTS.md instructions for ",
  "Another language model started to solve this problem"
];

const OLDER_ASSISTANT_MAX_CHARS = 1500;
const OLDER_ASSISTANT_HEAD_CHARS = 750;
const OLDER_ASSISTANT_TAIL_CHARS = 500;
const PROVIDER_HOP_TRAILING_TOOL_ITEMS = 4;

const CONVERSATION_HISTORY_ITEM_TYPES = new Set([
  ...TOOL_CALL_TYPES,
  ...TOOL_OUTPUT_TYPES
]);

export type CodexTranscriptSegmentKind =
  "developer" | "user" | "assistant" | "tool_call" | "tool_output";

export interface CodexTranscriptSegment {
  readonly kind: CodexTranscriptSegmentKind;
  readonly text: string;
}

export interface CodexTranscriptOptions {
  readonly providerHop?: boolean;
  readonly keepTrailingToolItems?: number;
}

interface RenderedTranscriptEntry {
  readonly kind: CodexTranscriptSegmentKind;
  readonly role?: "user" | "assistant" | "developer" | "system";
  readonly isTaskPrompt: boolean;
  readonly rawText: string;
  readonly rendered: string;
}

export function isTaskUserPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return !NON_TASK_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function renderTranscriptEntries(
  input: readonly unknown[]
): RenderedTranscriptEntry[] {
  const entries: RenderedTranscriptEntry[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      if (item) {
        entries.push({
          kind: "user",
          role: "user",
          isTaskPrompt: isTaskUserPrompt(item),
          rawText: item,
          rendered: `<user>\n${item}\n</user>`
        });
      }
      continue;
    }
    if (!isRecord(item)) continue;
    const type = typeof item.type === "string" ? item.type : "message";
    if (type === "message") {
      const role =
        item.role === "assistant" ||
        item.role === "developer" ||
        item.role === "system"
          ? item.role
          : "user";
      const text = messageText(item.content ?? item.text);
      if (text) {
        entries.push({
          kind:
            role === "assistant"
              ? "assistant"
              : role === "developer" || role === "system"
                ? "developer"
                : "user",
          role,
          isTaskPrompt: role === "user" && isTaskUserPrompt(text),
          rawText: text,
          rendered: `<${role}>\n${text}\n</${role}>`
        });
      }
    } else if (type === "custom_tool_call") {
      entries.push({
        kind: "tool_call",
        isTaskPrompt: false,
        rawText: String(item.input ?? ""),
        rendered: `<tool_call name="${String(item.name)}" call_id="${String(item.call_id)}">\n${String(item.input ?? "")}\n</tool_call>`
      });
    } else if (type === "function_call") {
      entries.push({
        kind: "tool_call",
        isTaskPrompt: false,
        rawText: String(item.arguments ?? ""),
        rendered: `<tool_call name="${String(item.name)}" call_id="${String(item.call_id)}">\n${String(item.arguments ?? "")}\n</tool_call>`
      });
    } else if (TOOL_OUTPUT_TYPES.has(type)) {
      const text = outputText(item.output);
      entries.push({
        kind: "tool_output",
        isTaskPrompt: false,
        rawText: text,
        rendered: `<tool_output call_id="${String(item.call_id)}">\n${text}\n</tool_output>`
      });
    }
  }
  return entries;
}

function isToolActivityEntry(entry: RenderedTranscriptEntry): boolean {
  return entry.kind === "tool_call" || entry.kind === "tool_output";
}

/**
 * Finds the last `assistant` message that actually closed a turn rather than
 * narrating a tool step within an in-progress turn.
 */
function findCompletedTurnBoundary(
  entries: readonly RenderedTranscriptEntry[]
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role !== "assistant") continue;
    let sawToolAfter = false;
    for (let j = i + 1; j < entries.length; j++) {
      const next = entries[j]!;
      if (isToolActivityEntry(next)) {
        sawToolAfter = true;
        break;
      }
      if (next.isTaskPrompt) {
        return sawToolAfter ? -1 : i;
      }
    }
  }
  return -1;
}

function boundTextLength(text: string): string | null {
  if (text.length <= OLDER_ASSISTANT_MAX_CHARS) return null;
  const omitted =
    text.length - OLDER_ASSISTANT_HEAD_CHARS - OLDER_ASSISTANT_TAIL_CHARS;
  const head = text.slice(0, OLDER_ASSISTANT_HEAD_CHARS);
  const tail = text.slice(text.length - OLDER_ASSISTANT_TAIL_CHARS);
  return `${head}\n\n[... ${omitted} chars of earlier reply omitted ...]\n\n${tail}`;
}

function boundOlderAssistantEntry(
  entry: RenderedTranscriptEntry,
  isLastCompletedAssistant: boolean
): string {
  if (isLastCompletedAssistant || entry.role !== "assistant") {
    return entry.rendered;
  }
  const bounded = boundTextLength(entry.rawText);
  return bounded === null
    ? entry.rendered
    : `<assistant>\n${bounded}\n</assistant>`;
}

function renderPriorHistory(
  entries: readonly RenderedTranscriptEntry[]
): string {
  const parts: string[] = [];
  let omittedCalls = 0;
  let omittedOutputs = 0;
  const lastAssistantOffset = entries.findLastIndex(
    (entry) => entry.role === "assistant"
  );
  const flushOmitted = () => {
    if (omittedCalls === 0 && omittedOutputs === 0) return;
    parts.push(
      `[prior tool activity omitted: ${omittedCalls} call(s), ${omittedOutputs} output(s)]`
    );
    omittedCalls = 0;
    omittedOutputs = 0;
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.kind === "tool_call") {
      omittedCalls += 1;
      continue;
    }
    if (entry.kind === "tool_output") {
      omittedOutputs += 1;
      continue;
    }
    flushOmitted();
    parts.push(boundOlderAssistantEntry(entry, i === lastAssistantOffset));
  }
  flushOmitted();
  return parts.join("\n\n");
}

function elideEarlierActiveTurnTools(
  entries: readonly RenderedTranscriptEntry[],
  keepTrailingToolItems: number
): CodexTranscriptSegment[] {
  const toolIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (isToolActivityEntry(entries[i]!)) toolIndices.push(i);
  }
  const cutoff =
    toolIndices.length > keepTrailingToolItems
      ? toolIndices[toolIndices.length - keepTrailingToolItems]!
      : -1;
  const segments: CodexTranscriptSegment[] = [];
  let omittedCalls = 0;
  let omittedOutputs = 0;
  const flushOmitted = () => {
    if (omittedCalls === 0 && omittedOutputs === 0) return;
    segments.push({
      kind: "tool_output",
      text: `[earlier current-turn tool activity omitted: ${omittedCalls} call(s), ${omittedOutputs} output(s)]`
    });
    omittedCalls = 0;
    omittedOutputs = 0;
  };
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (cutoff >= 0 && i < cutoff && isToolActivityEntry(entry)) {
      if (entry.kind === "tool_call") omittedCalls += 1;
      else omittedOutputs += 1;
      continue;
    }
    flushOmitted();
    segments.push({ kind: entry.kind, text: entry.rendered });
  }
  flushOmitted();
  return segments;
}

/**
 * True when `input` carries at least one completed/incomplete prior turn
 * followed by a newer task prompt (as opposed to a single turn or mid-turn
 * tool/steer continuation).
 */
export function hasCompletedPriorTurnWithNewTask(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return findCompletedTurnBoundary(renderTranscriptEntries(input)) >= 0;
}

/**
 * Segments a Codex `input` conversation into cross-provider transcript chunks.
 */
export function renderCodexTranscriptSegments(
  input: unknown,
  options: CodexTranscriptOptions = {}
): CodexTranscriptSegment[] {
  if (typeof input === "string") {
    return input ? [{ kind: "user", text: `<user>\n${input}\n</user>` }] : [];
  }
  if (!Array.isArray(input)) {
    return [
      { kind: "user", text: `<user>\n${JSON.stringify(input ?? "")}\n</user>` }
    ];
  }
  const entries = renderTranscriptEntries(input);
  if (entries.length === 0) return [];

  const keepTrailing =
    options.keepTrailingToolItems ?? PROVIDER_HOP_TRAILING_TOOL_ITEMS;
  const boundaryIdx = findCompletedTurnBoundary(entries);

  if (boundaryIdx < 0) {
    const firstToolIdx = entries.findIndex((entry) =>
      isToolActivityEntry(entry)
    );
    const normalized = entries.map((entry, idx) =>
      firstToolIdx >= 0 && idx > firstToolIdx && entry.isTaskPrompt
        ? {
            ...entry,
            rendered: `<mid_turn_steer>\n${entry.rawText}\n</mid_turn_steer>`
          }
        : entry
    );
    return options.providerHop
      ? elideEarlierActiveTurnTools(normalized, keepTrailing)
      : normalized.map((entry) => ({ kind: entry.kind, text: entry.rendered }));
  }

  const segments: CodexTranscriptSegment[] = [];
  const priorNonSystem: RenderedTranscriptEntry[] = [];
  for (let i = 0; i <= boundaryIdx; i++) {
    const entry = entries[i]!;
    if (entry.kind === "developer") {
      segments.push({ kind: "developer", text: entry.rendered });
    } else {
      priorNonSystem.push(entry);
    }
  }
  const priorBlock = renderPriorHistory(priorNonSystem);
  if (priorBlock) {
    segments.push({
      kind: "user",
      text: `<conversation_history note="Prior turns below are already completed or superseded. Use them as context for follow-ups, but do NOT re-run or re-report earlier tasks on their own—fulfill only the Current User Request below.">\n${priorBlock}\n</conversation_history>`
    });
  }

  const tailEntries = entries.slice(boundaryIdx + 1);
  const firstTailToolOffset = tailEntries.findIndex((entry) =>
    isToolActivityEntry(entry)
  );
  const initialSearchLimit =
    firstTailToolOffset >= 0 ? firstTailToolOffset : tailEntries.length;
  let activeOffset = -1;
  for (let i = initialSearchLimit - 1; i >= 0; i--) {
    if (tailEntries[i]?.isTaskPrompt) {
      activeOffset = i;
      break;
    }
  }
  if (activeOffset < 0) {
    for (let i = tailEntries.length - 1; i >= 0; i--) {
      if (tailEntries[i]?.isTaskPrompt) {
        activeOffset = i;
        break;
      }
    }
  }

  const activeEntries: RenderedTranscriptEntry[] = [];
  for (let i = 0; i < tailEntries.length; i++) {
    const entry = tailEntries[i]!;
    if (i < activeOffset && entry.isTaskPrompt) {
      activeEntries.push({
        ...entry,
        rendered: `<queued_user_request status="unanswered_prior_turn">\n${entry.rawText}\n</queued_user_request>`
      });
    } else if (i === activeOffset) {
      activeEntries.push({
        ...entry,
        rendered: `## Current User Request\nRespond ONLY to the request below.\n\n${entry.rendered}`
      });
    } else if (
      i > activeOffset &&
      firstTailToolOffset >= 0 &&
      i > firstTailToolOffset &&
      entry.isTaskPrompt
    ) {
      activeEntries.push({
        ...entry,
        rendered: `<mid_turn_steer>\n${entry.rawText}\n</mid_turn_steer>`
      });
    } else {
      activeEntries.push(entry);
    }
  }

  const activeSegments = options.providerHop
    ? elideEarlierActiveTurnTools(activeEntries, keepTrailing)
    : activeEntries.map((entry) => ({
        kind: entry.kind,
        text: entry.rendered
      }));
  segments.push(...activeSegments);
  return segments;
}

/** Codex's conversation for this agent, as the text a fresh CLI starts from. */
export function renderCodexTranscript(
  input: unknown,
  options: CodexTranscriptOptions = {}
): string {
  return renderCodexTranscriptSegments(input, options)
    .map((segment) => segment.text)
    .join("\n\n");
}

export function hasConversationHistory(items: readonly unknown[]): boolean {
  return items.some(
    (item) =>
      isRecord(item) &&
      (item.role === "assistant" ||
        CONVERSATION_HISTORY_ITEM_TYPES.has(String(item.type ?? "")))
  );
}

/**
 * Shared prompt formatter for stateless CLI bridges (`antigravity`, `copilot`).
 */
export function formatCodexBridgePrompt(
  input: unknown,
  instructions: unknown,
  options: CodexTranscriptOptions & { readonly taskPrefix?: string } = {}
): string {
  const prefix = options.taskPrefix ?? "";
  const header = `${String(instructions ?? "")}\n\n${prefix}`;
  if (typeof input === "string") return `${header}${input}`;
  if (!Array.isArray(input)) {
    return `${header}${options.taskPrefix ? String(input ?? "") : JSON.stringify(input)}`;
  }
  if (hasConversationHistory(input)) {
    const transcript = renderCodexTranscript(
      input.filter(
        (item) =>
          !isRecord(item) ||
          !["developer", "system"].includes(String(item.role ?? ""))
      ),
      options
    );
    if (transcript.length > 0) return `${header}${transcript}`;
  }
  const userItems = input.filter(
    (item) =>
      isRecord(item) &&
      (item.role === "user" ||
        (item.type === "message" && item.role === "user"))
  );
  const items =
    userItems.length > 0
      ? userItems
      : input.filter(
          (item) =>
            !isRecord(item) ||
            !["developer", "system"].includes(String(item.role ?? ""))
        );
  const task = items
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return String(item ?? "");
      return messageText(item.content ?? item.text ?? "");
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
  return `${header}${task}`;
}

function rawInputItemBoundary(input: readonly unknown[]): number {
  const entries: Array<{
    role?: string;
    isTaskPrompt: boolean;
    isTool: boolean;
    rawIndex: number;
  }> = [];
  for (let idx = 0; idx < input.length; idx++) {
    const item = input[idx];
    if (!isRecord(item)) continue;
    const type = typeof item.type === "string" ? item.type : "message";
    if (type === "message") {
      const role =
        item.role === "assistant" ||
        item.role === "developer" ||
        item.role === "system"
          ? item.role
          : "user";
      const text = messageText(item.content ?? item.text);
      if (!text) continue;
      entries.push({
        role,
        isTaskPrompt: role === "user" && isTaskUserPrompt(text),
        isTool: false,
        rawIndex: idx
      });
    } else if (TOOL_CALL_TYPES.has(type) || TOOL_OUTPUT_TYPES.has(type)) {
      entries.push({ isTaskPrompt: false, isTool: true, rawIndex: idx });
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.role !== "assistant") continue;
    let sawToolAfter = false;
    for (let j = i + 1; j < entries.length; j++) {
      const next = entries[j]!;
      if (next.isTool) {
        sawToolAfter = true;
        break;
      }
      if (next.isTaskPrompt) {
        return sawToolAfter ? -1 : entries[i]!.rawIndex;
      }
    }
  }
  return -1;
}

/**
 * Compacts a Responses `input` array for native JSON/Responses providers
 * (`minimax`, etc.) when an orchestrator hops providers.
 *
 * Strips tool call/output pairs from completed prior turns (and older active-turn
 * pairs beyond the trailing 4 tool items) while preserving call/output pairing
 * for every retained `call_id` so upstream Responses validators never see an
 * orphaned `function_call_output`.
 */
export function elidePriorTurnsForNativePayload(
  input: unknown,
  keepTrailingToolItems = PROVIDER_HOP_TRAILING_TOOL_ITEMS
): unknown {
  if (!Array.isArray(input) || input.length === 0) return input;
  const rawBoundary = rawInputItemBoundary(input);
  const activeStart = rawBoundary >= 0 ? rawBoundary + 1 : 0;

  const activeToolIndices: number[] = [];
  for (let i = activeStart; i < input.length; i++) {
    const item = input[i];
    if (
      isRecord(item) &&
      CONVERSATION_HISTORY_ITEM_TYPES.has(String(item.type ?? ""))
    ) {
      activeToolIndices.push(i);
    }
  }
  let activeToolCutoff =
    activeToolIndices.length > keepTrailingToolItems
      ? activeToolIndices[activeToolIndices.length - keepTrailingToolItems]!
      : -1;
  // Never split a kept tool output from its matching tool call in the active tail.
  if (activeToolCutoff > activeStart) {
    const retainedCallIds = new Set<string>();
    for (let i = activeToolCutoff; i < input.length; i++) {
      const item = input[i];
      if (isRecord(item) && typeof item.call_id === "string") {
        retainedCallIds.add(item.call_id);
      }
    }
    for (let i = activeStart; i < activeToolCutoff; i++) {
      const item = input[i];
      if (
        isRecord(item) &&
        TOOL_CALL_TYPES.has(String(item.type ?? "")) &&
        typeof item.call_id === "string" &&
        retainedCallIds.has(item.call_id)
      ) {
        activeToolCutoff = Math.min(activeToolCutoff, i);
      }
    }
  }

  const out: unknown[] = [];
  let omittedCalls = 0;
  let omittedOutputs = 0;
  const flushOmitted = (scopeLabel: string) => {
    if (omittedCalls === 0 && omittedOutputs === 0) return;
    out.push({
      type: "message",
      role: "assistant",
      content: `[${scopeLabel}: ${omittedCalls} call(s), ${omittedOutputs} output(s)]`
    });
    omittedCalls = 0;
    omittedOutputs = 0;
  };

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const isPrior = i < activeStart;
    const isOmittedActiveTool =
      !isPrior &&
      activeToolCutoff >= 0 &&
      i < activeToolCutoff &&
      isRecord(item) &&
      CONVERSATION_HISTORY_ITEM_TYPES.has(String(item.type ?? ""));
    const isPriorTool =
      isPrior &&
      isRecord(item) &&
      CONVERSATION_HISTORY_ITEM_TYPES.has(String(item.type ?? ""));

    if (isPriorTool || isOmittedActiveTool) {
      if (TOOL_CALL_TYPES.has(String((item as JsonRecord).type ?? ""))) {
        omittedCalls += 1;
      } else {
        omittedOutputs += 1;
      }
      continue;
    }

    flushOmitted(
      isPrior
        ? "prior tool activity omitted"
        : "earlier current-turn tool activity omitted"
    );

    if (
      isPrior &&
      i < rawBoundary &&
      isRecord(item) &&
      item.type === "message" &&
      item.role === "assistant"
    ) {
      const text = messageText(item.content ?? item.text);
      const bounded = boundTextLength(text);
      if (bounded !== null) {
        out.push({ ...item, content: bounded });
        continue;
      }
    }
    out.push(item);
  }
  flushOmitted("earlier current-turn tool activity omitted");
  return out;
}
