import type { WorkspacePlaytestLimits } from "@simulatorlife/autodev-core";

/**
 * The nine resource-limit fields Workspaces owns on an exact playtesting
 * approval, in the one order the approve form and its parsing route both
 * read them in.
 *
 * Core's `assertWorkspacePlaytestApproval` is the authoritative bound on each
 * field; this table only has to agree with Core on *which* fields exist and
 * whether a field is a float (`cpuCores`) or an integer. Restating the exact
 * numeric bounds here would drift the day Core's changed and still pass,
 * because the Runtime -- not the Console -- is what actually enforces them.
 */
export interface WorkspacePlaytestLimitField {
  readonly name: keyof WorkspacePlaytestLimits;
  readonly label: string;
  readonly isFloat: boolean;
}

export const WORKSPACE_PLAYTEST_LIMIT_FIELDS: readonly WorkspacePlaytestLimitField[] =
  [
    { name: "cpuCores", label: "CPU cores", isFloat: true },
    { name: "memoryBytes", label: "Memory (bytes)", isFloat: false },
    { name: "processCount", label: "Process count", isFloat: false },
    { name: "wallTimeMs", label: "Wall time (ms)", isFloat: false },
    { name: "artifactBytes", label: "Artifact bytes", isFloat: false },
    { name: "workerCount", label: "Worker count", isFloat: false },
    { name: "episodeCount", label: "Episode count", isFloat: false },
    {
      name: "maxStepsPerEpisode",
      label: "Max steps / episode",
      isFloat: false
    },
    { name: "critiqueCount", label: "Critique count", isFloat: false }
  ];

/** Parse one submitted limit field. `null` means the field was malformed. */
export function parseWorkspacePlaytestLimitValue(
  field: WorkspacePlaytestLimitField,
  raw: string | null
): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (!field.isFloat && !Number.isSafeInteger(value)) return null;
  return value;
}
