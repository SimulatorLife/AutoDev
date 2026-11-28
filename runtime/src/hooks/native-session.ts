/**
Observe enrolled native host sessions without granting execution authority.
*/
import { readFileSync } from "node:fs";

import { isEntryPoint } from "../shared/entry-point.ts";
import {
  NATIVE_SESSION_EVENTS_PATH,
  type NativeSessionObservation,
  nativeSessionObservationSchema,
  observedLabel,
  observedWorkspace
} from "../shared/native-session-observation.ts";
import { extractHookContext, parseHookPayload } from "./hook-payload.ts";
import { postRuntimeObservation } from "./runtime-observation.ts";

/**
MiniMax's installed projection supplies a fixed host marker; Claude Code
supplies its own launch environment. Never infer a client from a model.
*/
export function nativeHookObservation(
  input: string,
  event: NativeSessionObservation["event"],
  environment: NodeJS.ProcessEnv = process.env,
  arguments_: readonly string[] = process.argv.slice(2)
): NativeSessionObservation | null {
  const payload = parseHookPayload(input);
  if (!payload) return null;
  const context = extractHookContext(payload, environment);
  if (
    context.origin !== "unmanaged" ||
    environment.AUTODEV_SESSION_ID?.trim() ||
    environment.AUTODEV_AGENT_ROLE?.trim() ||
    !context.sessionId
  ) {
    return null;
  }
  const client = arguments_.includes("--client=mcode")
    ? "minimax_code"
    : environment.CLAUDECODE === "1" || environment.CLAUDE_CODE_ENTRYPOINT
      ? "claude_code"
      : null;
  if (!client) return null;
  const parsed = nativeSessionObservationSchema.safeParse({
    client,
    sessionId: context.sessionId,
    event,
    model: observedLabel(context.model),
    workspace: observedWorkspace(context.cwd)
  });
  return parsed.success ? parsed.data : null;
}

export async function reportNativeSession(
  input: string,
  event: NativeSessionObservation["event"]
): Promise<void> {
  try {
    const observation = nativeHookObservation(input, event);
    if (observation)
      await postRuntimeObservation(NATIVE_SESSION_EVENTS_PATH, observation);
  } catch {
    // Observation is best effort and must not block native host work.
  }
}

if (isEntryPoint(import.meta.url)) {
  const event = process.argv[2];
  if (event === "prompt" || event === "stop" || event === "end") {
    await reportNativeSession(readFileSync(0, "utf8"), event);
  }
}
