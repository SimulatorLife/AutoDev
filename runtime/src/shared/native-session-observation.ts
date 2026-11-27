/**
 * Content-free native host lifecycle observations. This contract does not
 * authorize a model request, tool, workspace or role.
 */
import { safeAutoDevSessionId } from "@simulatorlife/autodev-core";
import { z } from "zod";

export const NATIVE_SESSION_EVENTS_PATH = "/v1/agent-events/native-session";
export const NATIVE_SESSION_EVENT_LIMIT = 4096;
export const NATIVE_SESSION_CLIENTS = ["claude_code", "minimax_code"] as const;

export const nativeSessionObservationSchema = z.object({
  client: z.enum(NATIVE_SESSION_CLIENTS),
  sessionId: z.string().refine((id) => safeAutoDevSessionId(id) === id),
  event: z.enum(["start", "prompt", "stop", "end"]),
  model: z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/u).nullable(),
  workspace: z.string().regex(/^[A-Za-z0-9_. -]{1,128}$/u).nullable()
}).strict().refine((event) => nativeSessionIdentity(event) !== null);

export type NativeSessionObservation = z.infer<typeof nativeSessionObservationSchema>;

/** Distinguish independent host-native identities from Runtime session IDs. */
export function nativeSessionIdentity(event: {
  readonly client: string;
  readonly sessionId: string;
}): string | null {
  return safeAutoDevSessionId(`native:${event.client}:${event.sessionId}`);
}
