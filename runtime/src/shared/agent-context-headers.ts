/** Authenticated router-to-agent bridge context header names. */
export const AGENT_ROLE_HEADER = "x-autodev-agent-role";
export const SANDBOX_MODE_HEADER = "x-autodev-sandbox-mode";

/**
 * Optional router-to-bridge context carrying the selected skill body for
 * child threads; it is sent only on role-routed requests.
 */
export const SKILL_CONTEXT_HEADER = "x-autodev-skill-context";
export const CODEX_SESSION_HEADER = "x-autodev-codex-session";
