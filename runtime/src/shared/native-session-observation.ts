/**
Content-free native host lifecycle observations. This contract does not
authorize a model request, tool, workspace or role.
*/
import path from "node:path";

import {
  NATIVE_SESSION_CLIENTS,
  NATIVE_SESSION_EVENTS,
  safeAutoDevSessionId
} from "@simulatorlife/autodev-core";
import { z } from "zod";

export const NATIVE_SESSION_EVENTS_PATH = "/v1/agent-events/native-session";
export const NATIVE_SESSION_EVENT_LIMIT = 4096;

/**
A bounded label a hook may report: a model, role or provider name.
*/
export const OBSERVED_LABEL = /^[A-Za-z0-9_.:/-]{1,128}$/u;

/**
A bounded workspace key a hook may report: its directory's name.
*/
export const OBSERVED_WORKSPACE = /^[A-Za-z0-9_. -]{1,128}$/u;

/**
A label the hook observed, or null when it is absent or not a bounded label.
*/
export function observedLabel(value: string | null): string | null {
  return value !== null && OBSERVED_LABEL.test(value) ? value : null;
}

/**
The workspace key of an absolute working directory, or null when there is
none or its name is not a bounded key.
*/
export function observedWorkspace(cwd: string | null): string | null {
  if (cwd === null || !path.isAbsolute(cwd)) return null;
  const name = path.basename(cwd);
  return OBSERVED_WORKSPACE.test(name) ? name : null;
}

export const nativeSessionObservationSchema = z
  .object({
    client: z.enum(NATIVE_SESSION_CLIENTS),
    sessionId: z.string().refine((id) => safeAutoDevSessionId(id) === id),
    event: z.enum(NATIVE_SESSION_EVENTS),
    model: z.string().regex(OBSERVED_LABEL).nullable(),
    workspace: z.string().regex(OBSERVED_WORKSPACE).nullable()
  })
  .strict()
  .refine((event) => nativeSessionIdentity(event) !== null);

export type NativeSessionObservation = z.infer<
  typeof nativeSessionObservationSchema
>;

/**
Distinguish independent host-native identities from Runtime session IDs.
*/
export function nativeSessionIdentity(event: {
  readonly client: string;
  readonly sessionId: string;
}): string | null {
  return safeAutoDevSessionId(`native:${event.client}:${event.sessionId}`);
}
