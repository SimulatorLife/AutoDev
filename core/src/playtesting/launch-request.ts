import type { WorkspaceVisualPlaytestLimits } from "../workspaces/visual-playtesting.ts";

/** Versioned, game-neutral request accepted by the single Runtime launch owner. */
export const PLAYTEST_LAUNCH_REQUEST_SCHEMA =
  "autodev-playtest-launch-v1" as const;

export const PLAYTEST_EXECUTION_MODES = [
  "autonomous-visual",
  "adapter-accelerated",
  "scripted-regression"
] as const;

export type PlaytestExecutionMode = (typeof PLAYTEST_EXECUTION_MODES)[number];

/** One game-neutral assignment in an adapter-accelerated batch. */
export interface PlaytestLaunchAssignment {
  readonly scenario: string;
  readonly policy: string;
  readonly seed: string;
  readonly goal?: string | undefined;
  readonly maxSteps?: number | undefined;
}

export interface PlaytestAdapterBatchOperation {
  readonly kind: "batch";
  readonly assignments: readonly PlaytestLaunchAssignment[];
}

export interface PlaytestAdapterBranchOperation {
  readonly kind: "branch";
  readonly parentEpisodeId: string;
  readonly branchStep: number;
  readonly alternativeActionId: string;
  readonly policy?: string | undefined;
  /** Replay-prefix steps count against this continuation budget. */
  readonly maxSteps?: number | undefined;
}

export type PlaytestAdapterLaunchOperation =
  PlaytestAdapterBatchOperation | PlaytestAdapterBranchOperation;

/**
 * A launch has exactly one execution mode. Visual budgets may only reduce the
 * operator-approved target limits; Runtime remains authoritative at launch.
 */
export type PlaytestLaunchRequest =
  | {
      readonly schema: typeof PLAYTEST_LAUNCH_REQUEST_SCHEMA;
      readonly mode: "adapter-accelerated";
      readonly workspaceId: string;
      /** Client-generated key, stable across uncertain acceptance retries. */
      readonly requestId: string;
      /** SHA-256 revision returned by the same server-authoritative preflight. */
      readonly capabilityRevision: string;
      readonly operation: PlaytestAdapterLaunchOperation;
    }
  | {
      readonly schema: typeof PLAYTEST_LAUNCH_REQUEST_SCHEMA;
      readonly mode: "autonomous-visual";
      readonly workspaceId: string;
      readonly requestId: string;
      readonly capabilityRevision: string;
      readonly targetId: string;
      readonly policyId: "smart-direct";
      readonly areasOfFocus: string | null;
      readonly limits: WorkspaceVisualPlaytestLimits;
    }
  | {
      readonly schema: typeof PLAYTEST_LAUNCH_REQUEST_SCHEMA;
      readonly mode: "scripted-regression";
      readonly workspaceId: string;
      readonly requestId: string;
      readonly capabilityRevision: string;
      readonly recipeId: string;
      readonly maxSteps: number;
      readonly wallTimeMs: number;
    };
