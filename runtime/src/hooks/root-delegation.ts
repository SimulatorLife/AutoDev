#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@simulatorlife/autodev-core";
import { isRootOrchestratorModel } from "@simulatorlife/autodev-runtime/agents/orchestrator-policy";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { MULTI_AGENT_SPAWN_TOOL } from "@simulatorlife/autodev-runtime/shared/tool-names";

import {
  appendHookLogRecord,
  logOrchestrationCompliance,
  type ObservedSpawnSummary,
  type OrchestrationClassification,
  type OrchestrationClassificationSource,
  type OrchestrationComplianceObservation,
  type OrchestrationComplianceStatus,
  type OrchestrationTelemetryGap,
  type OrchestrationTelemetryStatus
} from "./hook-log.ts";

type HookInput = {
  model?: unknown;
  session_id?: unknown;
  hook_event_name?: unknown;
  turn_id?: unknown;
  transcript_path?: unknown;
};
const DIRECT_SPAWN_TOOLS = new Set([
  MULTI_AGENT_SPAWN_TOOL,
  "spawn_agent",
  "invoke_subagent",
  "agent"
]);
const EXEC_SPAWN_CALL_PATTERN = new RegExp(
  String.raw`\b(?:tools\.)?${MULTI_AGENT_SPAWN_TOOL}\s*\(`,
  "u"
);
const CLASSIFICATION_LABEL_PATTERN =
  /\b(?:task\s+classification|task\s+complexity|task\s+sizing|task\s+size|classification|complexity|sizing)\s*[:=-]\s*(trivial\/atomic|trivial|atomic|standard|high[- ]risk\/cross[- ]cutting|high[- ]risk|cross[- ]cutting)\b/giu;
const TRIVIAL_CLASSIFICATIONS = new Set([
  "trivial",
  "trivial/atomic",
  "trivial / atomic",
  "atomic"
]);
const HIGH_RISK_CLASSIFICATIONS = new Set([
  "high-risk",
  "high risk",
  "high-risk/cross-cutting",
  "high-risk / cross-cutting",
  "high risk/cross-cutting",
  "cross-cutting"
]);
const FAILURE_STATUS_PATTERN =
  /^(?:error|failed|denied|rejected|unavailable)$/iu;
const FAILURE_TEXT_PATTERN =
  /\b(?:script\s+failed|spawn(?:_agent)?\s+failed|failed\s+to\s+spawn|admission\s+(?:denied|rejected|failed)|capacity\s+(?:exhausted|exceeded|limit|full)|permission\s+denied|tool\s+execution\s+error)\b/iu;
const FAILURE_LINE_PREFIX_PATTERN = /^(?:error|failed|exception)\s*:/imu;
const INLINE_ERROR_JSON_PATTERN = /"isError"\s*:\s*true|"error"\s*:\s*"[^"]+"/u;
const REJECTED_SPAWN_STATUS_PATTERN =
  /["']spawn_status["']\s*:\s*["']rejected["']/iu;

type KnownClassification = Exclude<OrchestrationClassification, "unknown">;
type SpawnOutcome = "succeeded" | "failed" | "unresolved";

interface ComplianceWindowState {
  classification: OrchestrationClassification;
  classificationSource: OrchestrationClassificationSource;
  spawnsById: Map<string, SpawnOutcome>;
  anonymousSpawns: SpawnOutcome[];
  malformedLines: boolean;
}

function trimmedStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeClassification(value: unknown): KnownClassification | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replaceAll(/\s+/gu, " ");
  if (TRIVIAL_CLASSIFICATIONS.has(normalized)) return "trivial";
  if (normalized === "standard") return "standard";
  if (HIGH_RISK_CLASSIFICATIONS.has(normalized)) return "high-risk";
  return null;
}

function extractClassificationFromText(
  text: string
): KnownClassification | null {
  let matched: KnownClassification | null = null;
  const plainText = text.replaceAll("**", "");
  for (const match of plainText.matchAll(CLASSIFICATION_LABEL_PATTERN)) {
    const candidate = normalizeClassification(match[1]);
    if (candidate) matched = candidate;
  }
  return matched;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function isSpawnToolCall(toolName: string, inputOrArguments: unknown): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (DIRECT_SPAWN_TOOLS.has(normalized)) return true;
  if (normalized !== "exec") return false;
  const raw =
    typeof inputOrArguments === "string"
      ? inputOrArguments
      : isRecord(inputOrArguments)
        ? JSON.stringify(inputOrArguments)
        : "";
  return EXEC_SPAWN_CALL_PATTERN.test(raw);
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFailureRecord(record: Record<string, unknown>): boolean {
  if (record.spawn_status === "rejected") return true;
  if (record.isError === true || record.is_error === true) return true;
  if (typeof record.error === "string" && record.error.trim().length > 0) {
    return true;
  }
  if (isRecord(record.error)) return true;
  if (
    typeof record.status === "string" &&
    FAILURE_STATUS_PATTERN.test(record.status.trim())
  ) {
    return true;
  }
  if (record.ok === false) return true;
  return typeof record.exit_code === "number" && record.exit_code !== 0;
}

function isSpawnOutputFailure(
  envelope: Record<string, unknown>,
  output: unknown
): boolean {
  if (isFailureRecord(envelope)) return true;
  if (isRecord(output)) return isFailureRecord(output);
  const text = typeof output === "string" ? output : extractTextContent(output);
  if (!text) return false;
  const parsed = parseJsonRecord(text);
  if (parsed) return isFailureRecord(parsed);
  return (
    REJECTED_SPAWN_STATUS_PATTERN.test(text) ||
    FAILURE_TEXT_PATTERN.test(text) ||
    FAILURE_LINE_PREFIX_PATTERN.test(text) ||
    INLINE_ERROR_JSON_PATTERN.test(text)
  );
}

function recordSpawnAttempt(
  state: ComplianceWindowState,
  callId: string | null,
  outcome: SpawnOutcome = "unresolved"
): void {
  if (callId) state.spawnsById.set(callId, outcome);
  else state.anonymousSpawns.push(outcome);
}

function resolveSpawnOutcome(
  state: ComplianceWindowState,
  callId: string | null,
  isFailed: boolean
): void {
  if (!callId || !state.spawnsById.has(callId)) return;
  state.spawnsById.set(callId, isFailed ? "failed" : "succeeded");
}

function updateClassification(
  state: ComplianceWindowState,
  classification: KnownClassification | null,
  source: Exclude<OrchestrationClassificationSource, "none">
): void {
  if (!classification) return;
  state.classification = classification;
  state.classificationSource = source;
}

function applyResponseItem(
  state: ComplianceWindowState,
  payload: Record<string, unknown>
): void {
  const itemType = payload.type;
  if (itemType === "message" && payload.role === "assistant") {
    updateClassification(
      state,
      extractClassificationFromText(extractTextContent(payload.content)),
      "assistant_message"
    );
    return;
  }
  if (itemType === "function_call" || itemType === "custom_tool_call") {
    const toolName = trimmedStringOrNull(payload.name);
    if (
      toolName &&
      isSpawnToolCall(toolName, payload.input ?? payload.arguments)
    ) {
      recordSpawnAttempt(
        state,
        trimmedStringOrNull(payload.call_id) ?? trimmedStringOrNull(payload.id)
      );
    }
    return;
  }
  if (
    itemType === "function_call_output" ||
    itemType === "custom_tool_call_output"
  ) {
    resolveSpawnOutcome(
      state,
      trimmedStringOrNull(payload.call_id),
      isSpawnOutputFailure(payload, payload.output)
    );
  }
}

function applyEventMessage(
  state: ComplianceWindowState,
  payload: Record<string, unknown>
): void {
  const eventType = payload.type;
  if (
    eventType === "orchestration_classification" ||
    eventType === "task_classification"
  ) {
    updateClassification(
      state,
      normalizeClassification(
        payload.classification ??
          payload.complexity ??
          payload.task_classification
      ),
      "structured_event"
    );
    return;
  }
  if (
    eventType === "task_complete" &&
    typeof payload.last_agent_message === "string"
  ) {
    updateClassification(
      state,
      extractClassificationFromText(payload.last_agent_message),
      "assistant_message"
    );
    return;
  }
  if (eventType === "subagent_spawn") {
    const outcome: SpawnOutcome =
      typeof payload.status === "string"
        ? FAILURE_STATUS_PATTERN.test(payload.status.trim())
          ? "failed"
          : "succeeded"
        : "unresolved";
    recordSpawnAttempt(state, trimmedStringOrNull(payload.id), outcome);
    return;
  }
  if (eventType === "subagent_result") {
    resolveSpawnOutcome(
      state,
      trimmedStringOrNull(payload.id),
      isFailureRecord(payload)
    );
  }
}

function applyClaudeAssistantRecord(
  state: ComplianceWindowState,
  content: unknown
): void {
  updateClassification(
    state,
    extractClassificationFromText(extractTextContent(content)),
    "assistant_message"
  );
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const toolName = trimmedStringOrNull(block.name);
    if (toolName && isSpawnToolCall(toolName, block.input)) {
      recordSpawnAttempt(state, trimmedStringOrNull(block.id));
    }
  }
}

function applyClaudeUserRecord(
  state: ComplianceWindowState,
  content: unknown
): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    resolveSpawnOutcome(
      state,
      trimmedStringOrNull(block.tool_use_id),
      isSpawnOutputFailure(block, block.content)
    );
  }
}

function applyClaudeTranscriptRecord(
  state: ComplianceWindowState,
  record: Record<string, unknown>
): void {
  const message = isRecord(record.message) ? record.message : null;
  if (!message) return;
  if (record.type === "assistant") {
    applyClaudeAssistantRecord(state, message.content);
    return;
  }
  if (record.type === "user") {
    applyClaudeUserRecord(state, message.content);
  }
}

function summarizeSpawns(state: ComplianceWindowState): ObservedSpawnSummary {
  let succeeded = 0;
  let failed = 0;
  let unresolved = 0;
  for (const outcome of [
    ...state.spawnsById.values(),
    ...state.anonymousSpawns
  ]) {
    if (outcome === "succeeded") succeeded += 1;
    else if (outcome === "failed") failed += 1;
    else unresolved += 1;
  }
  return {
    attempted: succeeded + failed + unresolved,
    succeeded,
    failed,
    unresolved
  };
}

/**
 * Evaluate non-blocking orchestration compliance strictly from observed
 * classification, spawn outcomes, and telemetry completeness. Never infers
 * Standard work from file counts or absent spawn evidence.
 */
export function evaluateOrchestrationComplianceStatus(
  classification: OrchestrationClassification,
  spawn: ObservedSpawnSummary,
  telemetryStatus: OrchestrationTelemetryStatus
): OrchestrationComplianceStatus {
  if (telemetryStatus === "incomplete") return "incomplete_telemetry";
  if (classification === "unknown") {
    return spawn.failed > 0 && spawn.succeeded === 0
      ? "delegation_failed"
      : "classification_unknown";
  }
  if (classification === "trivial") {
    return spawn.failed > 0 && spawn.succeeded === 0
      ? "delegation_failed"
      : "compliant";
  }
  if (spawn.succeeded > 0) return "compliant";
  if (spawn.failed > 0) return "delegation_failed";
  return "no_delegation_observed";
}

function applyTranscriptLine(state: ComplianceWindowState, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    state.malformedLines = true;
    return;
  }
  if (!isRecord(parsed)) {
    state.malformedLines = true;
    return;
  }
  if (parsed.type === "compacted" || parsed.subtype === "compact_boundary") {
    state.classification = "unknown";
    state.classificationSource = "none";
    state.spawnsById.clear();
    state.anonymousSpawns.length = 0;
    return;
  }
  if (parsed.type === "response_item" && isRecord(parsed.payload)) {
    applyResponseItem(state, parsed.payload);
    return;
  }
  if (parsed.type === "event_msg" && isRecord(parsed.payload)) {
    applyEventMessage(state, parsed.payload);
    return;
  }
  if (parsed.type === "assistant" || parsed.type === "user") {
    applyClaudeTranscriptRecord(state, parsed);
  }
}

/**
 * Parse observable classification and spawn events from a JSONL transcript for
 * the current context window (resetting at compaction boundaries).
 */
export function observeTranscriptCompliance(
  transcript: string,
  hasMissingTurnIdentity = false
): OrchestrationComplianceObservation {
  const state: ComplianceWindowState = {
    classification: "unknown",
    classificationSource: "none",
    spawnsById: new Map(),
    anonymousSpawns: [],
    malformedLines: false
  };

  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim();
    if (line) applyTranscriptLine(state, line);
  }

  const spawn = summarizeSpawns(state);
  const telemetryGaps: OrchestrationTelemetryGap[] = [];
  if (state.malformedLines) telemetryGaps.push("malformed_transcript_lines");
  if (spawn.unresolved > 0) telemetryGaps.push("unresolved_spawn_output");
  if (hasMissingTurnIdentity) telemetryGaps.push("missing_turn_identity");
  const telemetryStatus: OrchestrationTelemetryStatus =
    telemetryGaps.length === 0 ? "complete" : "incomplete";

  return {
    classification: state.classification,
    classificationSource: state.classificationSource,
    spawn,
    telemetryStatus,
    telemetryGaps,
    status: evaluateOrchestrationComplianceStatus(
      state.classification,
      spawn,
      telemetryStatus
    )
  };
}

/**
 * Observe orchestration compliance from a hook input payload and its transcript
 * file without blocking or throwing.
 */
export function observeOrchestrationCompliance(
  input: HookInput
): OrchestrationComplianceObservation {
  const hasMissingTurnIdentity =
    !trimmedStringOrNull(input.session_id) ||
    !trimmedStringOrNull(input.turn_id);
  const transcriptPath = input.transcript_path;
  const emptySpawn: ObservedSpawnSummary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    unresolved: 0
  };
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath)) {
    const telemetryGaps: OrchestrationTelemetryGap[] = [
      "missing_transcript_path",
      ...(hasMissingTurnIdentity ? (["missing_turn_identity"] as const) : [])
    ];
    return {
      classification: "unknown",
      classificationSource: "none",
      spawn: emptySpawn,
      telemetryStatus: "incomplete",
      telemetryGaps,
      status: "incomplete_telemetry"
    };
  }
  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, "utf8");
  } catch {
    const telemetryGaps: OrchestrationTelemetryGap[] = [
      "unreadable_transcript",
      ...(hasMissingTurnIdentity ? (["missing_turn_identity"] as const) : [])
    ];
    return {
      classification: "unknown",
      classificationSource: "none",
      spawn: emptySpawn,
      telemetryStatus: "incomplete",
      telemetryGaps,
      status: "incomplete_telemetry"
    };
  }
  return observeTranscriptCompliance(transcript, hasMissingTurnIdentity);
}

/**
 * The bootstrap stays in model context until the host (Codex or Claude Code)
 * compacts the history, which drops hook-injected context. Re-injecting it on every user prompt
 * re-sends ~2k tokens per prompt for the rest of the session, so inject only
 * when the current context window does not already carry it. Fails open: an
 * unreadable or missing transcript injects.
 */
export function parseInput(raw: string): HookInput {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object"
      ? (value as HookInput)
      : {};
  } catch {
    return {};
  }
}

function logInput(input: HookInput): void {
  appendHookLogRecord({
    event: input.hook_event_name,
    model: input.model,
    session: input.session_id,
    turn: input.turn_id ?? null
  });
}

export function runRootDelegation(raw = readFileSync(0, "utf8")): number {
  const input = parseInput(raw);
  logInput(input);
  const model = typeof input.model === "string" ? input.model : "";
  // Codex always reports the turn's model. Claude Code (CLI and desktop app)
  // never does, and the delegation policy is a Codex root-orchestrator
  // contract that does not apply to it, so a payload without a model is not a
  // root turn.
  if (!model) return 0;
  if (!isRootOrchestratorModel(model)) return 0;

  const compliance = observeOrchestrationCompliance(input);
  logOrchestrationCompliance({
    hook: "root-delegation",
    decision: "observe",
    model,
    session: trimmedStringOrNull(input.session_id),
    turn: trimmedStringOrNull(input.turn_id),
    ...compliance
  });

  return 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = runRootDelegation();
}
