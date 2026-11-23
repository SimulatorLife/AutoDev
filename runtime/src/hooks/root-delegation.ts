#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@simulatorlife/autodev-core";
import { atomicWriteSync } from "@simulatorlife/autodev-data/files";
import { isRootOrchestratorModel } from "@simulatorlife/autodev-runtime/agents/orchestrator-policy";
import { isEntryPoint } from "@simulatorlife/autodev-runtime/shared/entry-point";
import { writeErrorLine } from "@simulatorlife/autodev-runtime/shared/output";
import {
  buildRootOrchestratorBootstrap,
  readRootBootstrapMarker
} from "@simulatorlife/autodev-runtime/shared/root-bootstrap";

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
import { codexHome, repositoryRoot } from "./hook-roots.ts";

type HookInput = {
  model?: unknown;
  session_id?: unknown;
  hook_event_name?: unknown;
  turn_id?: unknown;
  transcript_path?: unknown;
};
/**
 * Transcript records that replace history with a summary: Codex rollouts write
 * a `compacted` record, Claude Code writes a `compact_boundary` system record.
 */
const COMPACTION_RECORDS = [
  '"type":"compacted"',
  '"subtype":"compact_boundary"'
];
/**
 * Transcript records that carry hook-injected context: Codex records it as a
 * developer message, Claude Code as a `hook_additional_context` attachment.
 * Tool output that merely quotes the bootstrap (a `cat` of the prompt file) is
 * not an injection and must not suppress one.
 */
const INJECTION_RECORDS = [
  '"role":"developer"',
  '"type":"hook_additional_context"'
];
const DEDUP_TTL_MS = 15 * 60 * 1000;
const DEDUP_MAX_ENTRIES = 1024;
const LOCK_STALE_MS = 30 * 1000;
const DIRECT_SPAWN_TOOLS = new Set([
  "multi_agent_v1__spawn_agent",
  "spawn_agent",
  "invoke_subagent",
  "agent"
]);
const EXEC_SPAWN_CALL_PATTERN =
  /\b(?:tools\.)?multi_agent_v1__spawn_agent\s*\(/u;
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
export function bootstrapInCurrentWindow(
  transcriptPath: unknown,
  marker: string
): boolean {
  if (typeof transcriptPath !== "string" || !path.isAbsolute(transcriptPath))
    return false;
  let transcript: string;
  try {
    transcript = readFileSync(transcriptPath, "utf8");
  } catch {
    return false;
  }
  const encodedMarker = JSON.stringify(marker).slice(1, -1);
  let injected = false;
  for (const record of transcript.split("\n")) {
    const carriesBootstrap =
      record.includes(encodedMarker) &&
      INJECTION_RECORDS.some((kind) => record.includes(kind));
    // A compaction record starts a new window; it keeps the bootstrap only
    // when its replacement history retained the injected message.
    if (COMPACTION_RECORDS.some((boundary) => record.includes(boundary)))
      injected = carriesBootstrap;
    else if (carriesBootstrap) injected = true;
  }
  return injected;
}

function shouldInjectOnce(input: HookInput, model: string): boolean {
  const sessionId =
    typeof input.session_id === "string" ? input.session_id.trim() : "";
  const turnId = typeof input.turn_id === "string" ? input.turn_id.trim() : "";
  if (!sessionId || !turnId || !model) return true;

  const key = createHash("sha256")
    .update(JSON.stringify([sessionId, turnId, model]))
    .digest("hex");
  const hooksDir = path.join(codexHome(), "hooks");
  const stateFile = path.join(hooksDir, "root-delegation-state.json");
  const lockDir = path.join(hooksDir, "root-delegation-state.lock");
  try {
    mkdirSync(hooksDir, { recursive: true });
  } catch {
    return true;
  }

  if (!acquireStateLock(lockDir)) return true;
  try {
    const now = Date.now();
    const entries = readDedupEntries(stateFile, now);
    const duplicate = Object.hasOwn(entries, key);
    if (!duplicate) entries[key] = now;
    return writeDedupEntries(stateFile, entries) ? !duplicate : true;
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // A stale lock expires; never let state cleanup suppress root policy.
    }
  }
}

/** Sleep up to 10ms, but never past the deadline. Returns false once it has passed. */
function waitForLock(waitArray: Int32Array, deadline: number): boolean {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return false;
  Atomics.wait(waitArray, 0, 0, Math.min(10, remaining));
  return true;
}

/** Whether a lock directory is old enough that its holder must have died. */
function lockIsStale(lockDir: string): boolean | null {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS;
  } catch {
    return null;
  }
}

/**
 * mkdir is the cross-process atomic claim. State holds only hashed turn keys
 * and timestamps; no prompt content, model input, or credentials are stored.
 * Returns false when the lock could not be taken, and the caller fails open.
 */
function acquireStateLock(lockDir: string): boolean {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    }
    const stale = lockIsStale(lockDir);
    if (stale === true) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      } catch {
        // Fall through and wait before retrying.
      }
    }
    if (!waitForLock(waitArray, deadline)) return false;
  }
  return false;
}

function readDedupEntries(
  stateFile: string,
  now: number
): Record<string, number> {
  try {
    const stored: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    if (
      stored === null ||
      typeof stored !== "object" ||
      Array.isArray(stored)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" &&
          Number.isFinite(entry[1]) &&
          now - entry[1] < DEDUP_TTL_MS
      )
    );
  } catch {
    // Missing or corrupt state starts a fresh bounded window.
    return {};
  }
}

/** Persist the newest entries; false when the state could not be written. */
function writeDedupEntries(
  stateFile: string,
  entries: Record<string, number>
): boolean {
  const boundedEntries = Object.fromEntries(
    Object.entries(entries)
      .sort((a, b) => b[1] - a[1])
      .slice(0, DEDUP_MAX_ENTRIES)
  );
  try {
    atomicWriteSync(stateFile, JSON.stringify(boundedEntries), { mode: 0o600 });
    return true;
  } catch {
    // Always fail open and emit root policy.
    return false;
  }
}

function parseInput(raw: string): HookInput {
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

  const root = repositoryRoot();
  const marker = readRootBootstrapMarker(root);
  if (!marker) {
    writeErrorLine(
      `root-delegation: orchestrator prompt not found at ${path.join(root, "agents", "prompts", "orchestrator.md")}`
    );
    return 0;
  }

  if (bootstrapInCurrentWindow(input.transcript_path, marker)) return 0;
  if (!shouldInjectOnce(input, model)) return 0;

  const parentSessionId =
    typeof input.session_id === "string" && input.session_id.trim()
      ? input.session_id.trim()
      : null;
  const bootstrap = buildRootOrchestratorBootstrap({
    repoRoot: root,
    parentSessionId
  });
  if (!bootstrap) return 0;
  process.stdout.write(
    JSON.stringify({
      systemMessage:
        "UserPromptSubmit hook fired: injecting root delegation policy",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: bootstrap.content
      }
    })
  );
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = runRootDelegation();
}
