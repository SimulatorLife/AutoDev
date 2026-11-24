import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER } from "./compaction.ts";
import { installedSkillDirectory } from "./installed-skills.ts";

export interface RootOrchestratorBootstrap {
  marker: string;
  content: string;
}

/**
 * The orchestrator prompt and its bootstrap marker (the prompt's first line,
 * or the canonical marker for an empty prompt), or null when the prompt file is
 * missing. The hook's transcript check and the injected block both read the
 * marker here, so they can never disagree about it.
 */
function readOrchestratorPrompt(
  repoRoot: string
): { prompt: string; marker: string } | null {
  const promptFile = path.join(
    repoRoot,
    "agents",
    "prompts",
    "orchestrator.md"
  );
  if (!existsSync(promptFile)) return null;
  const prompt = readFileSync(promptFile, "utf8").trim();
  const firstLineEnd = prompt.indexOf("\n");
  const firstLine =
    firstLineEnd === -1 ? prompt : prompt.slice(0, firstLineEnd);
  return { prompt, marker: firstLine || ROOT_ORCHESTRATOR_BOOTSTRAP_MARKER };
}

/** Keep this exceptional-path reminder compact; the orchestration skill owns the full procedure. */
function buildRecoveryContext(parentId: string | null): string {
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
  return readOrchestratorPrompt(repoRoot)?.marker ?? null;
}

function buildPostCompactionContent({
  marker,
  skillFile,
  skillDirectory,
  parentId
}: {
  marker: string;
  skillFile: string;
  skillDirectory: string;
  parentId: string | null;
}): string {
  const skillFallback = existsSync(skillFile)
    ? `Only read ${skillFile} (or \`references/\` under ${skillDirectory}) if an actual delegation or recovery error requires it.`
    : `If a delegation error occurs and ${skillFile} is missing, report that capability failure instead of guessing.`;
  const body =
    `${marker} (post-compaction continuation)\n\n` +
    "This session already compacted. Do NOT re-read `orchestration/SKILL.md`, its `references/*.md`, or re-probe `ALL_TOOLS` unless an actual delegation/recovery error occurs. " +
    `${skillFallback}\n\n` +
    "Trust verified facts, measurements, modified files, and active/parked child agent IDs from the compaction summary instead of re-reading files or re-viewing screenshots.\n\n" +
    '- Delegate substantive discovery, implementation, and validation via `tools.multi_agent_v1__spawn_agent`/`wait_agent` inside `exec` (or the bridge tool if declared under "Delegation on this provider"); keep iterative code edits and temporary probe tests in a bounded `worker` (scratch probes in gitignored `tmp/`, never left in `tests/`).\n' +
    "- Close unneeded parked children with `close_agent` before spawning a new wave at the concurrency cap, and avoid spawning fresh waves right before compaction unless required.\n" +
    "- `mcp__filesystem` is confined to the active workspace (plus read-only skill roots); instruct children inspecting `/tmp/*` or external snapshots to use `exec_command` instead of `mcp__filesystem`.\n" +
    "- Root must not read git history (`git log`, `git show`, `git blame`, `git reflog` — `PreToolUse` blocks the whole command even when chained); use `git rev-parse --short HEAD` / `git status --short` instead, or delegate scoped history to a child.\n" +
    '- Batch independent calls with `Promise.all` inside one `exec` script, bound outputs (`max_output_tokens <= 2000`), and wait with `// @exec: {"yield_time_ms": 330000}`.';
  return body + buildRecoveryContext(parentId);
}

/**
 * Build the canonical AutoDev root-orchestrator bootstrap block shared between
 * the `UserPromptSubmit` hook and router post-compaction recovery.
 */
export function buildRootOrchestratorBootstrap({
  repoRoot,
  skillsHome,
  parentSessionId = null,
  postCompaction = false
}: {
  repoRoot: string;
  skillsHome?: string;
  parentSessionId?: string | null;
  postCompaction?: boolean;
}): RootOrchestratorBootstrap | null {
  const orchestratorPrompt = readOrchestratorPrompt(repoRoot);
  if (!orchestratorPrompt) return null;
  const { prompt, marker } = orchestratorPrompt;

  const skillDirectory = installedSkillDirectory("orchestration", skillsHome);
  const skillFile = path.join(skillDirectory, "SKILL.md");
  const normalizedParent = parentSessionId?.trim() || null;

  if (postCompaction) {
    return {
      marker,
      content: buildPostCompactionContent({
        marker,
        skillFile,
        skillDirectory,
        parentId: normalizedParent
      })
    };
  }

  const codeSearchFile = path.join(
    repoRoot,
    "agents",
    "prompts",
    "code-search.md"
  );

  const skill = existsSync(skillFile)
    ? `\n\n## Canonical orchestration skill\n\nRead the installed \`orchestration\` skill before your first spawn, and only the references it names for your situation. Source: ${skillFile}; resolve its relative \`references/\` paths against ${skillDirectory}.`
    : `\n\nCanonical orchestration skill is unavailable at ${skillFile}; report that capability failure instead of silently substituting a workflow.`;
  const codeSearch = existsSync(codeSearchFile)
    ? `\n\n${readFileSync(codeSearchFile, "utf8").trim()}`
    : "\n\nShared codebase navigation prompt is unavailable; report that capability failure instead of silently substituting a workflow.";
  const recoveryContext = buildRecoveryContext(normalizedParent);

  return {
    marker,
    content: prompt + skill + codeSearch + recoveryContext
  };
}
