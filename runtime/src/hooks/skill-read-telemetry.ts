#!/usr/bin/env node
// Observe SKILL.md read requests from native PreToolUse hooks and report
// them to the Runtime with the session's own attribution. A request is not
// proof that the file read completed.

import { createHash } from "node:crypto";
import process from "node:process";

import { isEntryPoint } from "../shared/entry-point.ts";
import {
  observedLabel,
  observedWorkspace
} from "../shared/native-session-observation.ts";
import {
  SKILL_READ_EVENTS_PATH,
  skillReadObservationSchema
} from "../shared/skill-read-observation.ts";
import {
  extractSkillReadPath,
  matchSkillReadTarget,
  normaliseSkillReadPath
} from "../shared/skill-reads.ts";
import {
  extractHookContext,
  extractHookToolCall,
  parseHookPayload,
  pickHookString
} from "./hook-payload.ts";
import { postRuntimeObservation } from "./runtime-observation.ts";

/**
Stable event identity, bounded independently of host-supplied identifiers.
A turn identifies repeated reads of one skill; without a turn, use an
observed call ID. Do not collapse a long-lived session into a synthetic
"no-turn" bucket or invent a unique ID for every hook retry.
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

export async function reportSkillRead(
  raw: string,
  environment: NodeJS.ProcessEnv = process.env,
  arguments_: readonly string[] = process.argv.slice(2)
): Promise<void> {
  const payload = parseHookPayload(raw);
  if (!payload) return;
  const tool = extractHookToolCall(payload);
  if (!tool) return;
  const context = extractHookContext(payload, environment, arguments_);
  // An unrelated native chat that only shares the projected hooks is not an
  // AutoDev session, so its reads are not AutoDev's evidence.
  if (!context.sessionId || context.origin === "unmanaged") return;
  const match = matchSkillReadTarget(
    normaliseSkillReadPath(
      extractSkillReadPath(tool.toolName, tool.toolInput),
      context.cwd
    )
  );
  if (!match) return;
  const callId = pickHookString(payload, [
    "tool_use_id",
    "toolUseId",
    "call_id",
    "callId"
  ]);
  const eventId = skillReadEventId(
    context.sessionId,
    context.turnId,
    callId,
    match.skill,
    match.root
  );
  if (!eventId) return;
  const observation = skillReadObservationSchema.safeParse({
    sessionId: context.sessionId,
    eventId,
    skill: match.skill,
    role: observedLabel(context.role),
    provider: observedLabel(context.provider),
    model: observedLabel(context.model),
    workspace: observedWorkspace(context.cwd)
  });
  // Repeated requests carry the same event ID, so the Runtime counts a
  // read once however often the host retries the hook.
  if (observation.success)
    await postRuntimeObservation(
      SKILL_READ_EVENTS_PATH,
      observation.data,
      environment
    );
}

if (isEntryPoint(import.meta.url)) {
  try {
    const chunks: Buffer[] = await Array.fromAsync(process.stdin);
    await reportSkillRead(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Observability must not prevent the host from executing a turn.
  } finally {
    process.exit(0);
  }
}
