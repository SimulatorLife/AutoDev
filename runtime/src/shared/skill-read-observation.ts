/**
A content-free observation that a session asked to read a skill's `SKILL.md`.

The hook that observes the read knows the session it runs in -- its id,
role, provider, model and workspace -- so it carries that attribution
itself. The post is authorized by the Runtime's local enrollment credential,
the same one native session observations use; like them, it authorizes no
request, tool, workspace or role.
*/
import { safeAutoDevSessionId } from "@simulatorlife/autodev-core";
import { z } from "zod";

import {
  OBSERVED_LABEL,
  OBSERVED_WORKSPACE
} from "./native-session-observation.ts";

export const SKILL_READ_EVENTS_PATH = "/v1/agent-events/skill-read";

/**
The source the Runtime records a hook-observed read under, distinct from a
skill a role contract declares (`role_contract`).
*/
export const SKILL_READ_SOURCE = "skill_read";
export const SKILL_READ_EVENT_LIMIT = 4096;

export const skillReadObservationSchema = z
  .object({
    sessionId: z.string().refine((id) => safeAutoDevSessionId(id) === id),
    /**
    Stable per turn (or per call) and skill, so a hook retry is one read.
    */
    eventId: z.string().regex(/^read:[0-9a-f]{64}$/u),
    skill: z.string().regex(OBSERVED_LABEL),
    role: z.string().regex(OBSERVED_LABEL).nullable(),
    provider: z.string().regex(OBSERVED_LABEL).nullable(),
    model: z.string().regex(OBSERVED_LABEL).nullable(),
    workspace: z.string().regex(OBSERVED_WORKSPACE).nullable()
  })
  .strict();

export type SkillReadObservation = z.infer<typeof skillReadObservationSchema>;
