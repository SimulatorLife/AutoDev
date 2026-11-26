#!/usr/bin/env node
// Observe SKILL.md read requests from native PreToolUse hooks. A request
// is not proof that the file read completed; bridge outcome reporting owns
// confirmed success/failure where available. The router resolves session
// context and owns the bounded observation dedupe window.

import { createHash } from "node:crypto";
import process from "node:process";

import { isEntryPoint } from "../shared/entry-point.ts";
import {
  extractSkillReadPath,
  matchSkillReadTarget,
  normaliseSkillReadPath
} from "../shared/skill-reads.ts";
import {
  AGENT_EVENTS_URL_HEADER,
  resolveSkillReadReporter,
  SESSION_ID_HEADER,
  SKILL_READ_SOURCE
} from "../telemetry/agent-events.ts";
import {
  extractHookContext,
  extractHookToolCall,
  parseHookPayload,
  pickHookString
} from "./hook-payload.ts";

const DEFAULT_EVENTS_URL = "http://127.0.0.1:4100/v1/agent-events";

/**
 * Stable event identity, bounded independently of host-supplied identifiers.
 * A turn identifies repeated reads of one skill; without a turn, use an
 * observed call ID. Do not collapse a long-lived session into a synthetic
 * "no-turn" bucket or invent a unique ID for every hook retry.
 */
export function skillReadEventId(
  sessionId: string,
  turnId: string | null,
  callId: string | null,
  skill: string,
  root: string
): string | null {
  if (!turnId && !callId) return null;
  const identity = JSON.stringify([
    sessionId,
    turnId ? "turn" : "call",
    turnId ?? callId,
    skill,
    root
  ]);
  return "read:" + createHash("sha256").update(identity).digest("hex");
}

export async function reportSkillRead(raw: string): Promise<void> {
  const payload = parseHookPayload(raw);
  if (!payload) return;
  const tool = extractHookToolCall(payload);
  if (!tool) return;
  const context = extractHookContext(payload);
  if (!context.sessionId) return;
  const match = matchSkillReadTarget(
    normaliseSkillReadPath(
      extractSkillReadPath(tool.toolName, tool.toolInput),
      context.cwd
    )
  );
  if (!match) return;
  const callId = pickHookString(payload, [
    "tool_use_id", "toolUseId", "call_id", "callId"
  ]);
  const eventId = skillReadEventId(
    context.sessionId,
    context.turnId,
    callId,
    match.skill,
    match.root
  );
  if (!eventId) return;
  const reporter = resolveSkillReadReporter({
    [AGENT_EVENTS_URL_HEADER]:
      process.env.AUTODEV_AGENT_EVENTS_URL?.trim() || DEFAULT_EVENTS_URL,
    [SESSION_ID_HEADER]: context.sessionId
  });
  // Repeated requests have the same event ID. Only the router can decide
  // whether an observation was accepted for an attributed session.
  await reporter?.reportSkillUsed({
    skill: match.skill,
    source: SKILL_READ_SOURCE,
    eventId
  });
}

if (isEntryPoint(import.meta.url)) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    await reportSkillRead(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Observability must not prevent the host from executing a turn.
  } finally {
    process.exit(0);
  }
}
