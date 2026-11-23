/**
 * Bridge-side sandbox and skill-context parsing for router-authenticated turns.
 * Header names are owned by the Runtime package contract and resolved through
 * the installer's CODEX_HOME/node_modules link.
 */

import {
  CODEX_SESSION_HEADER,
  contextHeaderValue,
  READ_ONLY_HEADER,
  SKILL_CONTEXT_HEADER
} from "@simulatorlife/autodev-runtime/shared/agent-context-headers";
import { isReadOnlyRole } from "@simulatorlife/autodev-runtime/shared/execution-contract";

/** Read whether the router flagged this turn read-only (`1`/`true` or `0`/`false`). */
export function bridgeReadOnly(
  headers: Record<string, unknown> | null | undefined
): boolean | null {
  const raw = contextHeaderValue(headers, READ_ONLY_HEADER, {
    lowercase: true
  });
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

/**
 * Whether a bridged turn runs read-only.
 *
 * The header the router forwards is the authoritative wire signal: it says
 * whether the turn was routed read-only. The role contract is the fallback
 * for a request that carries none.
 */
export function turnIsReadOnly(
  readOnlyHeader: boolean | null,
  agentRole: string | null
): boolean {
  if (readOnlyHeader !== null) return readOnlyHeader;
  return isReadOnlyRole(agentRole);
}

/** Read the orchestrator-propagated selected-skill context. */
export function bridgeSkillContext(
  headers: Record<string, unknown> | null | undefined
): string | null {
  return contextHeaderValue(headers, SKILL_CONTEXT_HEADER);
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
  if (bridgeReadOnly(headers) !== true) return "";
  return [
    "\n\n## Sandbox policy: READ-ONLY",
    "",
    "This turn was classified as read-only by the role contract.",
    "You MUST NOT edit, create, delete, stage, commit, push, install, or",
    "kill processes. If a delegated task appears to require mutation,",
    "report the constraint instead of attempting the mutation. Failure",
    "to honour this restriction is a contract violation, not a soft",
    "preference. Use read-only shell commands (`rg`, `find`, `cat`, `nl`, `sed -n`, `wc`, `jq`, `git`) and iterate/parse in JavaScript rather than invoking `python3`, `node`, `awk`, `for` loops, `export`, command substitution, heredocs, or `>` redirections."
  ].join("\n");
}

/** Optional Codex session id header used as fallback correlation by /v1/agent-events. */
export function codexSessionIdHeader(
  headers: Record<string, unknown> | null | undefined
): string | null {
  return contextHeaderValue(headers, CODEX_SESSION_HEADER);
}
