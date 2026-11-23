import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@simulatorlife/autodev-core";

import { codexHome } from "./hook-roots.ts";

export const MAX_HOOK_REASON_LENGTH = 200;
export const MAX_COMMAND_HEAD_LENGTH = 120;

export type HookDenialPolicy =
  "read-only" | "orchestrator-git-history" | "block-ccc-cli" | "file-surface";

export type OrchestrationClassification =
  "trivial" | "standard" | "high-risk" | "unknown";

export type OrchestrationClassificationSource =
  "assistant_message" | "structured_event" | "none";

export type OrchestrationTelemetryStatus = "complete" | "incomplete";

export type OrchestrationTelemetryGap =
  | "missing_transcript_path"
  | "unreadable_transcript"
  | "malformed_transcript_lines"
  | "unresolved_spawn_output"
  | "missing_turn_identity";

export type OrchestrationComplianceStatus =
  | "compliant"
  | "classification_unknown"
  | "no_delegation_observed"
  | "delegation_failed"
  | "incomplete_telemetry";

export interface ObservedSpawnSummary {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly unresolved: number;
}

export interface OrchestrationComplianceObservation {
  readonly classification: OrchestrationClassification;
  readonly classificationSource: OrchestrationClassificationSource;
  readonly spawn: ObservedSpawnSummary;
  readonly telemetryStatus: OrchestrationTelemetryStatus;
  readonly telemetryGaps: readonly OrchestrationTelemetryGap[];
  readonly status: OrchestrationComplianceStatus;
}

export interface OrchestrationComplianceLogEntry extends OrchestrationComplianceObservation {
  readonly hook: "root-delegation";
  readonly decision: "observe";
  readonly model: string | null;
  readonly session: string | null;
  readonly turn: string | null;
}

export interface PreToolUseDenialLogEntry {
  readonly hook: "role-sandbox" | "block-ccc-cli" | "file-surface";
  readonly policy: HookDenialPolicy;
  readonly role: string | null;
  readonly model: string | null;
  readonly session: string | null;
  readonly turn: string | null;
  readonly tool: string | null;
  readonly reason: string;
  readonly toolInput?: unknown;
}

const SHELL_COMMAND_TOOLS = new Set([
  "exec_command",
  "execcommand",
  "execute_command",
  "bash",
  "terminal",
  "run_command"
]);

const COMMAND_KEYS = ["cmd", "command", "exec", "input"] as const;

const REDACT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]"],
  [
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/gu,
    "[REDACTED]"
  ],
  [
    /\b([A-Za-z_]\w*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTH|CREDENTIAL)\w*)=("[^"]*"|'[^']*'|\S+)/giu,
    "$1=[REDACTED]"
  ],
  [
    /(--(?:token|api-key|apikey|secret|password|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/giu,
    "$1[REDACTED]"
  ]
];

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function normalizeReason(reason: string): string {
  const firstLine =
    reason
      .split("\n")
      .map((line) => line.replaceAll(/\s+/gu, " ").trim())
      .find((line) => line.length > 0) ?? "";
  return truncateText(firstLine, MAX_HOOK_REASON_LENGTH);
}

/**
 * Append a best-effort JSONL event record to `$CODEX_HOME/hooks/hooks.log`.
 * Never throws so logging issues cannot alter hook policy enforcement.
 */
export function appendHookLogRecord(
  record: Record<string, unknown>,
  logFilePath = path.join(codexHome(), "hooks", "hooks.log")
): void {
  try {
    mkdirSync(path.dirname(logFilePath), { recursive: true });
    appendFileSync(
      logFilePath,
      `${JSON.stringify({
        time: new Date().toISOString(),
        ...record
      })}\n`
    );
  } catch {
    // Hook logging is best effort; policy enforcement remains authoritative.
  }
}

/**
 * Normalize whitespace, redact common credential patterns, and truncate a shell
 * command string before writing it to `hooks.log`.
 */
export function sanitizeCommandHead(command: string): string {
  let cleaned = command.replaceAll(/\s+/gu, " ").trim();
  for (const [pattern, replacement] of REDACT_RULES) {
    cleaned = cleaned.replaceAll(pattern, replacement);
  }
  return truncateText(cleaned, MAX_COMMAND_HEAD_LENGTH);
}

/**
 * Extract and sanitize the command head for shell-execution tools only. Returns
 * `null` for non-shell tools such as `apply_patch` or `read_file` so patch and
 * file bodies are never written to `hooks.log`.
 */
export function extractShellCommandHead(
  toolName: string | null,
  toolInput: unknown
): string | null {
  if (!toolName) return null;
  const normalizedTool = toolName.toLowerCase().replaceAll(/[\s-]+/gu, "_");
  if (!SHELL_COMMAND_TOOLS.has(normalizedTool)) return null;

  let raw = "";
  if (typeof toolInput === "string") {
    raw = toolInput;
  } else if (isRecord(toolInput)) {
    for (const key of COMMAND_KEYS) {
      const value = toolInput[key];
      if (typeof value === "string") {
        raw = value;
        break;
      }
      if (isRecord(value)) {
        const nested = value.cmd ?? value.command;
        if (typeof nested === "string") {
          raw = nested;
          break;
        }
      }
    }
  }
  if (!raw.trim()) return null;
  const sanitized = sanitizeCommandHead(raw);
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * Record a structured `PreToolUse` policy denial event to `hooks.log`.
 */
export function logPreToolUseDenial(
  entry: PreToolUseDenialLogEntry,
  logFilePath?: string
): void {
  const commandHead = extractShellCommandHead(entry.tool, entry.toolInput);
  appendHookLogRecord(
    {
      event: "PreToolUse",
      hook: entry.hook,
      decision: "deny",
      policy: entry.policy,
      role: entry.role,
      model: entry.model,
      session: entry.session,
      turn: entry.turn,
      tool: entry.tool,
      reason: normalizeReason(entry.reason),
      ...(commandHead ? { commandHead } : {})
    },
    logFilePath
  );
}

/**
 * Record a structured, non-blocking `OrchestrationCompliance` observation to
 * `hooks.log`. Uses its own event name so `PreToolUse` denial and
 * `UserPromptSubmit` counters remain unaffected.
 */
export function logOrchestrationCompliance(
  entry: OrchestrationComplianceLogEntry,
  logFilePath?: string
): void {
  appendHookLogRecord(
    {
      event: "OrchestrationCompliance",
      hook: entry.hook,
      decision: entry.decision,
      model: entry.model,
      session: entry.session,
      turn: entry.turn,
      classification: entry.classification,
      classificationSource: entry.classificationSource,
      status: entry.status,
      telemetryStatus: entry.telemetryStatus,
      telemetryGaps: [...entry.telemetryGaps],
      spawn: { ...entry.spawn }
    },
    logFilePath
  );
}
