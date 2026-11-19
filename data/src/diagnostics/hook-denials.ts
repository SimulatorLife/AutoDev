/**
 * The hook-denial reader.
 *
 * The hooks runtime records every `PreToolUse` decision in
 * `$CODEX_HOME/hooks/hooks.log` as one structured line. This module
 * aggregates those denials over a bounded window, so "which policy blocked
 * what, and how often" is one read rather than a grep.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type HookDenialSummary,
  SESSION_HOOK_DENIALS_SCHEMA,
  type SessionHookDenialsResponse
} from "@simulatorlife/autodev-core";

const MS_PER_DAY = 86_400_000;
const UNKNOWN_LABEL = "unknown";
const REASON_LIMIT = 15;
const COMMAND_LIMIT = 15;

interface HookDenialAccumulator {
  totalLines: number;
  userPromptSubmits: number;
  preToolUseDenials: number;
  byPolicy: Record<string, number>;
  byRole: Record<string, number>;
  reasonCounts: Map<string, number>;
  commandCounts: Map<
    string,
    { commandHead: string; policy: string; count: number }
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordHookLogLine(
  line: string,
  cutoff: string,
  acc: HookDenialAccumulator
): void {
  if (!line) return;
  acc.totalLines += 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(parsed) || typeof parsed.time !== "string") return;
  if (parsed.time < cutoff) return;
  if (parsed.event === "UserPromptSubmit") {
    acc.userPromptSubmits += 1;
    return;
  }
  if (parsed.event !== "PreToolUse" || parsed.decision !== "deny") return;
  acc.preToolUseDenials += 1;
  const policy =
    typeof parsed.policy === "string" ? parsed.policy : UNKNOWN_LABEL;
  const role = typeof parsed.role === "string" ? parsed.role : UNKNOWN_LABEL;
  const reason =
    typeof parsed.reason === "string" ? parsed.reason : UNKNOWN_LABEL;
  acc.byPolicy[policy] = (acc.byPolicy[policy] ?? 0) + 1;
  acc.byRole[role] = (acc.byRole[role] ?? 0) + 1;
  acc.reasonCounts.set(reason, (acc.reasonCounts.get(reason) ?? 0) + 1);
  if (typeof parsed.commandHead !== "string" || !parsed.commandHead) return;
  const key = `${policy}\0${parsed.commandHead}`;
  const previous = acc.commandCounts.get(key);
  if (previous) previous.count += 1;
  else {
    acc.commandCounts.set(key, {
      commandHead: parsed.commandHead,
      policy,
      count: 1
    });
  }
}

/** Aggregate the structured `PreToolUse` denial entries in the hook log. */
export function summarizeHookDenials(
  codexHome: string,
  sinceDays = 7,
  nowMs = Date.now()
): HookDenialSummary {
  const logFile = path.join(codexHome, "hooks", "hooks.log");
  const cutoff = new Date(nowMs - sinceDays * MS_PER_DAY).toISOString();
  const acc: HookDenialAccumulator = {
    totalLines: 0,
    userPromptSubmits: 0,
    preToolUseDenials: 0,
    byPolicy: {},
    byRole: {},
    reasonCounts: new Map(),
    commandCounts: new Map()
  };

  if (existsSync(logFile)) {
    for (const line of readFileSync(logFile, "utf8").split("\n")) {
      recordHookLogLine(line, cutoff, acc);
    }
  }

  return {
    logFile,
    sinceDays,
    cutoff,
    totalLines: acc.totalLines,
    userPromptSubmits: acc.userPromptSubmits,
    preToolUseDenials: acc.preToolUseDenials,
    byPolicy: acc.byPolicy,
    byRole: acc.byRole,
    byReason: [...acc.reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, REASON_LIMIT)
      .map(([reason, count]) => ({ reason, count })),
    topCommands: [...acc.commandCounts.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, COMMAND_LIMIT)
  };
}

/** The hook-denial summary, in the shape the Control API publishes. */
export function hookDenialsResponse(
  codexHome: string,
  sinceDays = 7,
  nowMs = Date.now()
): SessionHookDenialsResponse {
  return {
    schema: SESSION_HOOK_DENIALS_SCHEMA,
    summary: summarizeHookDenials(codexHome, sinceDays, nowMs)
  };
}
