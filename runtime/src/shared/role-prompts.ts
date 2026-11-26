/**
 * Single authoritative owner for AutoDev role prompt composition from
 * `agents/prompts/` (`base.md`, `leaf.md`, `code-search.md`, `roles/<role>.md`).
 *
 * Used identically by both static role projection (`render-agent-configs.ts`)
 * and live ACP/XACPX session dispatch (`xacpx/manager.ts`).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { roleContract } from "@simulatorlife/autodev-runtime/shared/execution-contract";
import { resolveRuntimeSourceRoot } from "@simulatorlife/autodev-runtime/shared/runtime-source-root";

export interface RolePromptParts {
  readonly base: string;
  readonly leaf: string;
  readonly codeSearch: string;
}

export function readPromptFileText(
  filePath: string,
  options: { readonly required?: boolean } = {}
): string {
  try {
    return readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if (options.required) throw error;
    return "";
  }
}

export function loadSharedRolePromptParts(
  promptDir: string,
  options: { readonly required?: boolean } = {}
): RolePromptParts {
  return {
    base: readPromptFileText(path.join(promptDir, "base.md"), options),
    leaf: readPromptFileText(path.join(promptDir, "leaf.md"), options),
    codeSearch: readPromptFileText(
      path.join(promptDir, "code-search.md"),
      options
    )
  };
}

/**
 * Compose the canonical system prompt for a declared AutoDev role from
 * `agents/prompts/`, matching every provider's projected prompt surface.
 */
export function composeRoleSystemPrompt(
  role: string,
  repositoryRoot: string = resolveRuntimeSourceRoot(
    import.meta.dirname,
    process.env.AUTODEV_REPO_ROOT
  )
): string {
  const normalized = role.trim().toLowerCase();
  const contract = roleContract(normalized);
  const promptDir = path.join(repositoryRoot, "agents", "prompts");
  const shared = loadSharedRolePromptParts(promptDir, { required: false });
  const parts: string[] = [];
  if (shared.base) parts.push(shared.base);
  if (contract.kind !== "orchestrator" && shared.leaf) {
    parts.push(shared.leaf);
  }
  if (
    shared.codeSearch &&
    (contract.mcp.includes("lsp") ||
      contract.mcp.includes("cocoindex-code") ||
      contract.mcp.includes("codegraphcontext"))
  ) {
    parts.push(shared.codeSearch);
  }
  const rolePrompt = readPromptFileText(
    path.join(promptDir, "roles", `${normalized}.md`),
    { required: false }
  );
  if (rolePrompt) parts.push(rolePrompt);
  return parts.join("\n\n");
}
