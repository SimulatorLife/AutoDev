/**
 * Detection and validation helpers for Codex/LLM context-compaction turns.
 *
 * Mid-turn local compaction appends a summarization prompt as a `user` message
 * immediately after pending tool outputs (`function_call_output` /
 * `custom_tool_call_output`). Bridges and the router must recognize this so
 * they treat compaction as a fresh plain-text summarization turn rather than
 * continuing a parked tool turn, exposing tools, or skipping post-compaction
 * orchestrator bootstrap recovery.
 */

import { isRecord } from "./object-guards.ts";

export const ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER =
  "# Root orchestrator bootstrap";

export const COMPACTED_SUMMARY_PREFIX =
  "Another language model started to solve this problem";

export const COMPACTION_SYSTEM_PROMPT =
  "You are performing context compaction for an ongoing engineering session. Produce a concise, structured plain-text handoff summary covering progress, key decisions, constraints, modified files, test results, blockers, and next steps. Preserve active/parked child agent IDs (with roles and statuses), the confirmed delegation/tool surface, and verified file paths or numeric measurements so the resumed session does not re-read orchestration docs, re-probe ALL_TOOLS, or re-open already-analyzed files or screenshots. Do not call tools or continue executing the task.";

const LOCAL_COMPACTION_PROMPT_MARKERS = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION",
  "Include:\n- Current progress and key decisions made",
  "# Context Compaction\n\nCondense the conversation above into a structured checkpoint"
] as const;

const COMPACTED_ITEM_TYPES = new Set([
  "compacted",
  "compaction",
  "compaction_summary"
]);

/** Collect visible text from a message/content value without throwing on odd shapes. */
export function extractItemText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => extractItemText(entry)).join("\n");
  }
  if (!isRecord(value)) return "";
  const parts: string[] = [];
  if (typeof value.text === "string") parts.push(value.text);
  if (typeof value.message === "string") parts.push(value.message);
  if (value.content !== undefined) {
    const contentText = extractItemText(value.content);
    if (contentText) parts.push(contentText);
  }
  return parts.join("\n");
}

function textMatchesCompactionPrompt(text: string): boolean {
  return LOCAL_COMPACTION_PROMPT_MARKERS.some((marker) =>
    text.includes(marker)
  );
}

/** True when `item` is a user-authored Responses message. */
function isUserMessageItem(item: unknown): item is Record<string, unknown> {
  if (!isRecord(item)) return false;
  return (
    (item.type === undefined || item.type === "message") && item.role === "user"
  );
}

/** Find the latest user message text in a Responses `input` value, if any. */
function latestUserInputText(input: unknown): string {
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (isUserMessageItem(item)) return extractItemText(item);
  }
  return "";
}

/**
 * True when a Responses `input` value is requesting context compaction rather
 * than normal continuation or tool execution.
 */
export function isCompactionInput(input: unknown): boolean {
  const latestUser = latestUserInputText(input);
  return latestUser.length > 0 && textMatchesCompactionPrompt(latestUser);
}

/**
 * True when a Responses request payload is a context-compaction / handoff
 * summarization turn.
 */
export function isCompactionRequest(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (
    typeof payload.instructions === "string" &&
    payload.instructions.includes("CONTEXT CHECKPOINT COMPACTION")
  ) {
    return true;
  }
  return isCompactionInput(payload.input);
}

/**
 * True when a Responses `input` carries a compacted history replacement item
 * from an earlier compaction pass.
 */
export function hasCompactedHistorySummary(input: unknown): boolean {
  if (typeof input === "string") {
    return (
      input.includes(COMPACTED_SUMMARY_PREFIX) ||
      input.includes("<compacted-summary>")
    );
  }
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (COMPACTED_ITEM_TYPES.has(String(item.type))) return true;
    const text = extractItemText(item);
    if (
      text.includes(COMPACTED_SUMMARY_PREFIX) ||
      text.includes("<compacted-summary>")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when the payload already contains the root orchestrator bootstrap in
 * `instructions` or in any developer/system message inside `input`.
 */
export function hasRootBootstrap(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (
    typeof payload.instructions === "string" &&
    payload.instructions.includes(ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER)
  ) {
    return true;
  }
  if (typeof payload.input === "string") {
    return payload.input.includes(ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER);
  }
  if (!Array.isArray(payload.input)) return false;
  for (const item of payload.input) {
    if (!isRecord(item)) continue;
    const role = String(item.role ?? "");
    if (role !== "developer" && role !== "system" && role !== "user") continue;
    if (extractItemText(item).includes(ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER)) {
      return true;
    }
  }
  return false;
}

/**
 * True when an orchestrator request resumed after mid-turn compaction without
 * the root delegation bootstrap present in the active context window.
 */
export function needsPostCompactionBootstrap(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (isCompactionRequest(payload)) return false;
  return (
    hasCompactedHistorySummary(payload.input) && !hasRootBootstrap(payload)
  );
}

/**
 * True when a compaction response produced no usable summary text or tried to
 * emit tool calls instead of returning a plain-text checkpoint summary.
 */
export function isInvalidCompactionResponse(
  outputText: string,
  toolCallCount: number
): boolean {
  return toolCallCount > 0 || outputText.trim().length === 0;
}

/** Extract assistant output text from a buffered Responses JSON envelope. */
export function responseOutputText(response: unknown): string {
  if (!isRecord(response)) return "";
  if (typeof response.output_text === "string") return response.output_text;
  const target = isRecord(response.response) ? response.response : response;
  if (typeof target.output_text === "string") return target.output_text;
  if (!Array.isArray(target.output)) return "";
  const parts: string[] = [];
  for (const item of target.output) {
    if (!isRecord(item) || item.type !== "message") continue;
    const text = extractItemText(item.content);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Inject `bootstrapContent` into a routed orchestrator payload after a
 * mid-turn compaction dropped the initial `UserPromptSubmit` context.
 */
export function injectRootBootstrapIntoPayload(
  payload: Record<string, unknown>,
  bootstrapContent: string
): Record<string, unknown> {
  if (!Array.isArray(payload.input)) {
    const existing =
      typeof payload.instructions === "string"
        ? payload.instructions.trimEnd()
        : "";
    return {
      ...payload,
      instructions: existing
        ? `${existing}\n\n${bootstrapContent}`
        : bootstrapContent
    };
  }
  const developerItem = {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: bootstrapContent }]
  };
  const input = [...payload.input];
  const compactedIndex = input.findIndex((item) =>
    hasCompactedHistorySummary([item])
  );
  const insertAt = compactedIndex === -1 ? 0 : compactedIndex + 1;
  input.splice(insertAt, 0, developerItem);
  return { ...payload, input };
}
