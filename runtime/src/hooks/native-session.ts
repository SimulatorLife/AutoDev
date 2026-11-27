/**
Observe enrolled native host sessions without granting execution authority.
*/
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { readLocalAdmission } from "../mcp/gateway-admission.ts";
import { isEntryPoint } from "../shared/entry-point.ts";
import {
  NATIVE_SESSION_EVENTS_PATH,
  type NativeSessionObservation,
  nativeSessionObservationSchema} from "../shared/native-session-observation.ts";
import { extractHookContext, parseHookPayload } from "./hook-payload.ts";

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
  const workspace =
    context.cwd && path.isAbsolute(context.cwd)
      ? path.basename(context.cwd)
      : null;
  const parsed = nativeSessionObservationSchema.safeParse({
    client,
    sessionId: context.sessionId,
    event,
    model:
      context.model && /^[A-Za-z0-9_.:/-]{1,128}$/u.test(context.model)
        ? context.model
        : null,
    workspace:
      workspace && /^[A-Za-z0-9_. -]{1,128}$/u.test(workspace)
        ? workspace
        : null
  });
  return parsed.success ? parsed.data : null;
}

export async function reportNativeSession(
  input: string,
  event: NativeSessionObservation["event"]
): Promise<void> {
  try {
    const observation = nativeHookObservation(input, event);
    if (!observation) return;
    const home = process.env.HOME?.trim() || homedir();
    const codexHome =
      process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
    const admission = readLocalAdmission(codexHome);
    if (!admission) return;
    const port = Number(process.env.CODEX_MODEL_ROUTER_PORT ?? "4100");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return;
    const response = await fetch(
      `http://127.0.0.1:${port}${NATIVE_SESSION_EVENTS_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${admission.key}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(observation),
        redirect: "error",
        signal: AbortSignal.timeout(1000)
      }
    );
    await response.body?.cancel();
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
