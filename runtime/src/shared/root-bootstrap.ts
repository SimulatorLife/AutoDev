import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER } from "./compaction.ts";
import { installedSkillDirectory } from "./installed-skills.ts";

export { ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER } from "./compaction.ts";

export interface RootOrchestratorBootstrap {
  marker: string;
  content: string;
}

/** Keep this exceptional-path reminder compact; the orchestration skill owns the full procedure. */
export function buildRecoveryContext(parentId: string | null): string {
  if (!parentId) return "";
  return (
    "\n\n## Current-parent recovery preflight\n" +
    `Current parent session: ${parentId}. Only after a capacity/admission failure, ` +
    "follow the canonical orchestration recovery procedure against this parent's " +
    "own spawn history. Preserve running children and useful partial results; " +
    "close dead terminal handles or evict the oldest parked handles only when " +
    "capacity requires it. Never inspect or clean up foreign sessions.\n"
  );
}

/** Read only the bootstrap marker line from `agents/prompts/orchestrator.md`, or null if missing. */
export function readRootBootstrapMarker(repoRoot: string): string | null {
  const promptFile = path.join(
    repoRoot,
    "agents",
    "prompts",
    "orchestrator.md"
  );
  if (!existsSync(promptFile)) return null;
  const prompt = readFileSync(promptFile, "utf8").trim();
  const firstLineEnd = prompt.indexOf("\n");
  const marker = firstLineEnd === -1 ? prompt : prompt.slice(0, firstLineEnd);
  return marker || ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER;
}

/**
 * Build the canonical AutoDev root-orchestrator bootstrap block shared between
 * the `UserPromptSubmit` hook and router post-compaction recovery.
 */
export function buildRootOrchestratorBootstrap({
  repoRoot,
  skillsHome,
  parentSessionId = null
}: {
  repoRoot: string;
  skillsHome?: string;
  parentSessionId?: string | null;
}): RootOrchestratorBootstrap | null {
  const promptFile = path.join(
    repoRoot,
    "agents",
    "prompts",
    "orchestrator.md"
  );
  if (!existsSync(promptFile)) return null;

  const skillDirectory = installedSkillDirectory("orchestration", skillsHome);
  const skillFile = path.join(skillDirectory, "SKILL.md");
  const codeSearchFile = path.join(
    repoRoot,
    "agents",
    "prompts",
    "code-search.md"
  );

  const prompt = readFileSync(promptFile, "utf8").trim();
  const firstLineEnd = prompt.indexOf("\n");
  const marker =
    (firstLineEnd === -1 ? prompt : prompt.slice(0, firstLineEnd)) ||
    ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER;

  const skill = existsSync(skillFile)
    ? `\n\n## Canonical orchestration skill\n\nRead the installed \`orchestration\` skill before your first spawn, and only the references it names for your situation. Source: ${skillFile}; resolve its relative \`references/\` paths against ${skillDirectory}.`
    : `\n\nCanonical orchestration skill is unavailable at ${skillFile}; report that capability failure instead of silently substituting a workflow.`;
  const codeSearch = existsSync(codeSearchFile)
    ? `\n\n${readFileSync(codeSearchFile, "utf8").trim()}`
    : "\n\nShared codebase navigation prompt is unavailable; report that capability failure instead of silently substituting a workflow.";
  const normalizedParent = parentSessionId?.trim() || null;
  const recoveryContext = buildRecoveryContext(normalizedParent);

  return {
    marker,
    content: prompt + skill + codeSearch + recoveryContext
  };
}
