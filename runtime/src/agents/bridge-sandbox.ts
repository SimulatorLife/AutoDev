/**
 * Bridge-side sandbox and skill-context parsing for router-authenticated turns.
 * Header names are owned by the Runtime package contract and resolved through
 * the installer's CODEX_HOME/node_modules link.
 */

import {
  CODEX_SESSION_HEADER,
  SANDBOX_MODE_HEADER,
  SKILL_CONTEXT_HEADER
} from "@simulatorlife/autodev-runtime/shared/agent-context-headers";

export type BridgeSandboxMode = "read-only" | "workspace-write" | null;

function pickHeader(
  headers: Record<string, unknown> | null | undefined,
  name: string,
  lowercase: boolean
): string | null {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name
  );
  if (key === undefined) return null;
  const value = headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  if (typeof single !== "string" || !single.trim()) return null;
  return lowercase ? single.trim().toLowerCase() : single.trim();
}

/** Read the bridge sandbox mode from a request's headers. */
export function bridgeSandboxMode(
  headers: Record<string, unknown> | null | undefined
): BridgeSandboxMode {
  const raw = pickHeader(headers, SANDBOX_MODE_HEADER, true);
  if (raw === "read-only" || raw === "workspace-write") return raw;
  return null;
}

/** Read the orchestrator-propagated selected-skill context. */
export function bridgeSkillContext(
  headers: Record<string, unknown> | null | undefined
): string | null {
  return pickHeader(headers, SKILL_CONTEXT_HEADER, false);
}

/**
 * Build the read-only enforcement block to inject into a bridge's system
 * prompt. Bridges without a CLI sandbox flag (Claude) use this to instruct
 * the model to refuse mutating operations; bridges that do (Antigravity,
 * Copilot) may use it as belt-and-braces alongside the CLI flag.
 *
 * Returns the empty string when the request is not read-only, so callers can
 * always concatenate without branching.
 */
export function readOnlySystemPromptInjection(
  headers: Record<string, unknown> | null | undefined
): string {
  if (bridgeSandboxMode(headers) !== "read-only") return "";
  return [
    "\n\n## Sandbox policy: READ-ONLY",
    "",
    "This turn was classified as read-only by the role contract.",
    "You MUST NOT edit, create, delete, stage, commit, push, install, or",
    "kill processes. If a delegated task appears to require mutation,",
    "report the constraint instead of attempting the mutation. Failure",
    "to honour this restriction is a contract violation, not a soft",
    "preference."
  ].join("\n");
}

/** Optional Codex session id header used as fallback correlation by /v1/agent-events. */
export function codexSessionIdHeader(
  headers: Record<string, unknown> | null | undefined
): string | null {
  return pickHeader(headers, CODEX_SESSION_HEADER, false);
}
