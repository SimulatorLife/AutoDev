import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  AGENT_ROLE_HEADER,
  SANDBOX_MODE_HEADER,
  SKILL_CONTEXT_HEADER
} from "@simulatorlife/autodev-runtime/shared/agent-context-headers";
import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";
import {
  MCP_SERVER_COCOINDEX,
  MCP_SERVER_CODEGRAPHCONTEXT,
  MCP_SERVER_LSP
} from "@simulatorlife/autodev-runtime/shared/tool-names";

// Router-generated request header naming the agent role a provider bridge is
// serving. The router builds its outbound header set from scratch, so this can
// never be spoofed by an inbound client: a bridge that sees the orchestrator
// value knows the local router classified the request as the root turn.
export const ORCHESTRATOR_AGENT_ROLE = "orchestrator";

const REPO_ROOT = resolveRuntimeSourceRoot(
  import.meta.dirname,
  process.env.AUTODEV_REPO_ROOT
);
const promptRoot = path.join(REPO_ROOT, "agents", "prompts");
const PROMPTS = Object.freeze({
  base: path.join(promptRoot, "base.md"),
  leaf: path.join(promptRoot, "leaf.md"),
  codeSearch: path.join(promptRoot, "code-search.md"),
  orchestrator: path.join(promptRoot, "orchestrator.md"),
  roleDirectory: path.join(promptRoot, "roles")
});
const ORCHESTRATION_SKILL_CANDIDATES = [
  path.join(REPO_ROOT, ".rulesync", "skills", "orchestration", "SKILL.md"),
  path.join(REPO_ROOT, ".agents", "skills", "orchestration", "SKILL.md")
];
const ORCHESTRATION_SKILL =
  ORCHESTRATION_SKILL_CANDIDATES.find((filePath) => existsSync(filePath)) ??
  ORCHESTRATION_SKILL_CANDIDATES[0]!;
const ROLE_PROMPT_NAMES = new Set([
  "browser-tester",
  "default",
  "docs-researcher",
  "explorer",
  "orchestrator",
  "smart",
  "validator",
  "worker"
]);
// Bounded: the role reaches this module from a request header, so the key
// domain is caller-controlled and unbounded, and every entry holds a fully
// composed prompt. That makes an unbounded map into steady heap growth driven
// by request data -- and the growth is nearly all duplication, because
// `roleContract` collapses every unrecognised role onto the same default
// contract and `rolePromptName` folds unknown roles onto the same prompt file,
// so two different unknown roles cache byte-identical strings under different
// keys. Map iterates in insertion order, so the oldest entry is the one that
// goes. Eviction costs a re-read at most: the prompt is a deterministic
// function of the role, so a re-read returns the same string.
const ROLE_PROMPT_CACHE_LIMIT = 64;
const cache = new Map<string, string>();
const BASE_PROMPT = readFileSync(PROMPTS.base, "utf8").trim();
const CODE_SEARCH_PROMPT = readFileSync(PROMPTS.codeSearch, "utf8").trim();

function headerValue(
  headers: Record<string, unknown> | null | undefined,
  name: string
): string | null {
  if (!headers || typeof headers !== "object") return null;
  // Node lowercases inbound header names, but LiteLLM and other intermediaries
  // can preserve the case the router sent, so match without regard to it.
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name
  );
  const value = key === undefined ? undefined : headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim()
    ? single.trim().toLowerCase()
    : null;
}

/** The sandbox mode the router assigned to this request, or null when it sent none. */
export function resolveSandboxModeFromHeaders(
  headers: Record<string, unknown> | null | undefined
): "read-only" | "workspace-write" | null {
  const raw = headerValue(headers, SANDBOX_MODE_HEADER);
  if (raw === "read-only" || raw === "workspace-write") return raw;
  return null;
}

/** Optional selected-skill context the router forwarded for child turns. */
export function resolveSkillContextFromHeaders(
  headers: Record<string, unknown> | null | undefined
): string | null {
  if (!headers || typeof headers !== "object") return null;
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === SKILL_CONTEXT_HEADER
  );
  if (key === undefined) return null;
  const value = headers[key];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" && single.trim() ? single : null;
}

/** The agent role the router assigned to this request, or null when it sent none. */
export function resolveAgentRole(
  headers: Record<string, unknown> | null | undefined
): string | null {
  return headerValue(headers, AGENT_ROLE_HEADER);
}

export function isOrchestratorRole(role: string | null | undefined): boolean {
  return role === ORCHESTRATOR_AGENT_ROLE;
}

/** The role prompt file (without extension) for `role`, falling back to "default" for unknown roles. */
function rolePromptName(role: string | null | undefined): string {
  let requested = "default";
  if (isOrchestratorRole(role)) requested = "orchestrator";
  else if (typeof role === "string" && role.trim())
    requested = role.trim().toLowerCase();
  return ROLE_PROMPT_NAMES.has(requested) ? requested : "default";
}

/**
 * The role-specific section of a provider prompt.
 *
 * This deliberately excludes the shared base and workspace sections. Keeping
 * that composition explicit prevents Claude's replacement system prompt from
 * accidentally receiving the base twice while the other bridges omit it.
 */
export function roleInstructions(role: string | null | undefined): string {
  const key = isOrchestratorRole(role) ? "orchestrator" : "leaf";
  const contractKey = isOrchestratorRole(role) ? "orchestrator" : role;
  const contract = roleContract(contractKey);
  const cacheKey = `${key}:${contractKey ?? "default"}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const bootstrap = readFileSync(PROMPTS[key], "utf8").trim();
  const canonical =
    key === "orchestrator"
      ? `\n\n## Canonical orchestration skill\n\n${readFileSync(ORCHESTRATION_SKILL, "utf8").trim()}`
      : "";
  const codeSearch =
    contract.mcp.includes(MCP_SERVER_CODEGRAPHCONTEXT) &&
    contract.mcp.includes(MCP_SERVER_LSP) &&
    contract.mcp.includes(MCP_SERVER_COCOINDEX)
      ? `\n\n${CODE_SEARCH_PROMPT}`
      : "";
  const rolePrompt = readFileSync(
    path.join(PROMPTS.roleDirectory, `${rolePromptName(role)}.md`),
    "utf8"
  ).trim();
  const tools =
    contract.mcp.length > 0 ? contract.mcp.join(", ") : "none declared";
  const webResearch =
    contract.webResearch?.search && contract.webResearch?.fetch
      ? " Website research is available through the provider's native search/fetch tools; use those for public documentation and URLs, never Playwright."
      : "";
  const prompt = `${bootstrap}${canonical}${codeSearch}\n\n## Effective role contract\n\n${rolePrompt}\n\nExpected MCP/tool capabilities: ${tools}.${webResearch} If a required capability is unavailable, report that fact instead of silently substituting a different workflow.`;
  cache.set(cacheKey, prompt);
  if (cache.size > ROLE_PROMPT_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  return prompt;
}

/**
 * Compose the complete prompt sent to a bridge-owned CLI.
 *
 * Every bridge gets the same shared base, workspace context, and role section;
 * only the downstream CLI invocation differs. Native Codex role configs use
 * render-agent-configs.py to materialize this same base+leaf+role-fragment composition.
 */
export function composeProviderPrompt(
  role: string | null | undefined,
  cwd: string | null = null
): string {
  const workspace =
    typeof cwd === "string" && cwd.trim()
      ? `\n\n## Workspace\n\nWorking directory: ${cwd}\nPlatform: ${process.platform}`
      : "";
  return `${BASE_PROMPT}${workspace}\n\n${roleInstructions(role)}`;
}
