import { readFileSync } from "node:fs";
import { roleContract } from "./execution-contract.mjs";

// Router-generated request header naming the agent role a provider bridge is
// serving. The router builds its outbound header set from scratch, so this can
// never be spoofed by an inbound client: a bridge that sees the orchestrator
// value knows the local router classified the request as the root turn.
export const AGENT_ROLE_HEADER = "x-autodev-agent-role";
export const ORCHESTRATOR_AGENT_ROLE = "orchestrator";

const PROMPTS = Object.freeze({
  base: new URL("../prompts/base.md", import.meta.url),
  leaf: new URL("../prompts/leaf.md", import.meta.url),
  codeSearch: new URL("../prompts/code-search.md", import.meta.url),
  orchestrator: new URL("../prompts/orchestrator.md", import.meta.url),
  roleDirectory: new URL("../prompts/roles/", import.meta.url),
});
const ORCHESTRATION_SKILL = new URL("../skills/orchestration/SKILL.md", import.meta.url);
const ROLE_PROMPT_NAMES = new Set(["browser-tester", "default", "docs-researcher", "explorer", "orchestrator", "smart", "validator", "worker"]);
const cache = new Map();
const BASE_PROMPT = readFileSync(PROMPTS.base, "utf8").trim();
const CODE_SEARCH_PROMPT = readFileSync(PROMPTS.codeSearch, "utf8").trim();

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
 * The role-specific section of a provider prompt.
 *
 * This deliberately excludes the shared base and workspace sections. Keeping
 * that composition explicit prevents Claude's replacement system prompt from
 * accidentally receiving the base twice while the other bridges omit it.
 */
export function roleInstructions(role) {
  const key = isOrchestratorRole(role) ? "orchestrator" : "leaf";
  const contractKey = isOrchestratorRole(role) ? "orchestrator" : role;
  const contract = roleContract(contractKey);
  const cacheKey = `${key}:${contractKey ?? "default"}`;
  if (!cache.has(cacheKey)) {
    const bootstrap = readFileSync(PROMPTS[key], "utf8").trim();
    const canonical = key === "orchestrator"
      ? `\n\n## Canonical orchestration skill\n\n${readFileSync(ORCHESTRATION_SKILL, "utf8").trim()}`
      : "";
    const codeSearch = contract.mcp.includes("lsp") && contract.mcp.includes("cocoindex-code")
      ? `\n\n${CODE_SEARCH_PROMPT}`
      : "";
    const requestedRolePrompt = isOrchestratorRole(role) ? "orchestrator" : (typeof role === "string" && role.trim() ? role.trim().toLowerCase() : "default");
    const rolePromptKey = ROLE_PROMPT_NAMES.has(requestedRolePrompt) ? requestedRolePrompt : "default";
    const rolePrompt = readFileSync(new URL(`${rolePromptKey}.md`, PROMPTS.roleDirectory), "utf8").trim();
    const tools = contract.mcp.length > 0 ? contract.mcp.join(", ") : "none declared";
    cache.set(cacheKey, `${bootstrap}${canonical}${codeSearch}\n\n## Effective role contract\n\n${rolePrompt}\n\nExpected MCP/tool capabilities: ${tools}. If a required capability is unavailable, report that fact instead of silently substituting a different workflow.`);
  }
  return cache.get(cacheKey);
}

/**
 * Compose the complete prompt sent to a bridge-owned CLI.
 *
 * Every bridge gets the same shared base, workspace context, and role section;
 * only the downstream CLI invocation differs. Native Codex role configs use
 * render-agent-configs.py to materialize this same base+leaf+role-fragment composition.
 */
export function composeProviderPrompt(role, cwd = null) {
  const workspace = typeof cwd === "string" && cwd.trim()
    ? `\n\n## Workspace\n\nWorking directory: ${cwd}\nPlatform: ${process.platform}`
    : "";
  return `${BASE_PROMPT}${workspace}\n\n${roleInstructions(role)}`;
}
