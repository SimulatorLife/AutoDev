import { z } from "zod";

import { safeAutoDevSessionId as validateSessionId } from "../usage/session-id.ts";

export const ACP_PIN_LEDGER_SCHEMA = "autodev-acp-pins-v1" as const;
export const MAX_ACP_PIN_LEDGER_ENTRIES = 500;

/**
One pinned runtime/ACP/OpenCLI session published to `$CODEX_HOME/run/acp-pins.json`.
*/
export const acpPinRecordSchema = z.object({
  sessionId: z.string().min(1).max(256),
  parentSessionId: z.string().min(1).max(256).nullable(),
  acpSessionId: z.string().min(1).max(256).nullable(),
  role: z.string().min(1).max(128),
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  reasoningEffort: z.string().min(1).max(64).nullable(),
  transport: z.enum(["acp", "opencli"]),
  cwd: z.string().min(1).max(1024),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  closedAt: z.string().min(1).nullable()
});

export type AcpPinRecord = z.infer<typeof acpPinRecordSchema>;

export const acpPinLedgerSchema = z.object({
  schema: z.literal(ACP_PIN_LEDGER_SCHEMA),
  pid: z.number().int().positive(),
  updatedAt: z.string().min(1),
  pins: z.array(acpPinRecordSchema).max(MAX_ACP_PIN_LEDGER_ENTRIES)
});

export type AcpPinLedger = z.infer<typeof acpPinLedgerSchema>;

export function parseAcpPinLedger(value: unknown): AcpPinLedger | null {
  const parsed = acpPinLedgerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
Extract a source-confirmed thread or session identity from a coordinator pin.

Local gateway coordinator handles use `local:<role>:<workspace>:<session>`,
where `<session>` is checked with `validateSessionId` rather than inferred from
role or workspace names; other handles must pass `validateSessionId` directly.
*/
export function extractCoordinatorThreadId(
  parentSessionId: string | null | undefined
): string | null {
  if (!parentSessionId) return null;
  if (parentSessionId.startsWith("local:")) {
    const firstColon = parentSessionId.indexOf(":");
    const secondColon = parentSessionId.indexOf(":", firstColon + 1);
    const lastColon = parentSessionId.lastIndexOf(":");
    if (
      secondColon <= firstColon + 1 ||
      lastColon <= secondColon + 1 ||
      lastColon >= parentSessionId.length - 1
    ) {
      return null;
    }
    const candidate = parentSessionId.slice(lastColon + 1);
    return candidate === "catalogue" ? null : validateSessionId(candidate);
  }
  return validateSessionId(parentSessionId);
}
