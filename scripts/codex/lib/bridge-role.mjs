import { readFileSync } from "node:fs";

// Router-generated request header naming the agent role a provider bridge is
// serving. The router builds its outbound header set from scratch, so this can
// never be spoofed by an inbound client: a bridge that sees the orchestrator
// value knows the local router classified the request as the root turn.
export const AGENT_ROLE_HEADER = "x-autodev-agent-role";
export const ORCHESTRATOR_AGENT_ROLE = "orchestrator";

const PROMPTS = Object.freeze({
  leaf: new URL("../prompts/leaf.md", import.meta.url),
  orchestrator: new URL("../prompts/orchestrator.md", import.meta.url),
});
const cache = new Map();

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  // Node lowercases inbound header names, but LiteLLM and other intermediaries
  // can preserve the case the router sent, so match without regard to it.
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim() ? single.trim().toLowerCase() : null;
}

/** The agent role the router assigned to this request, or null when it sent none. */
export function resolveAgentRole(headers) {
  return headerValue(headers, AGENT_ROLE_HEADER);
}

export function isOrchestratorRole(role) {
  return role === ORCHESTRATOR_AGENT_ROLE;
}

/**
 * Bridge instructions for the resolved role. The root orchestrator must never
 * receive the leaf policy: telling the parent it is a bounded leaf that cannot
 * spawn child agents suppresses the delegation the root turn exists to do.
 * Anything that is not explicitly the orchestrator is treated as a leaf.
 */
export function bridgeInstructions(role) {
  const key = isOrchestratorRole(role) ? "orchestrator" : "leaf";
  if (!cache.has(key)) cache.set(key, readFileSync(PROMPTS[key], "utf8").trim());
  return cache.get(key);
}
