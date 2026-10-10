/** AutoDev adapter for Jev Playtest Lab's pinned generic loop primitives. */
import type { PlaytestJsonValue } from "@simulatorlife/autodev-core";

import {
  LoopGuard,
  observationHash
} from "../../vendor/jev-playtest-lab/src/core.js";

export interface PlaytestLoopObservation {
  /** The game-owned objective exposed to this policy. */
  readonly goal: string;
  /** Already-filtered, player-visible observation; never engine/debug state. */
  readonly visibleState: PlaytestJsonValue;
  readonly legalActionIds: readonly string[];
}

export interface PlaytestLoopGuardOptions {
  readonly window?: number;
  readonly maxRepeats?: number;
}

export interface PlaytestLoopInspection {
  readonly loop: boolean;
  /** Upstream Jev Playtest Lab observation hash (16 lowercase hex chars). */
  readonly observationHash: string;
  readonly signature: string;
}

function canonicalJsonValue(value: PlaytestJsonValue): PlaytestJsonValue {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as { readonly [key: string]: PlaytestJsonValue })
        .sort()
        .map((key) => [
          key,
          canonicalJsonValue(
            (value as { readonly [key: string]: PlaytestJsonValue })[key]!
          )
        ])
    );
  }
  return value;
}

/**
 * Bounded loop detection using the vendored upstream `LoopGuard` and
 * `observationHash` implementation without its Jev-specific 255-choice,
 * `noul`, or model-decision restrictions. Instantiate once per episode.
 */
export class PlaytestLoopGuard {
  private readonly guard: InstanceType<typeof LoopGuard>;
  private readonly goal: string;

  constructor(goal: string, options: PlaytestLoopGuardOptions = {}) {
    if (!goal.trim()) throw new TypeError("Loop-guard goal is required.");
    const window = options.window ?? 6;
    const maxRepeats = options.maxRepeats ?? 3;
    if (!Number.isSafeInteger(window) || window < 1 || window > 1024) {
      throw new RangeError(
        "Loop-guard window must be an integer from 1 to 1024."
      );
    }
    if (
      !Number.isSafeInteger(maxRepeats) ||
      maxRepeats < 2 ||
      maxRepeats > window
    ) {
      throw new RangeError(
        "Loop-guard maxRepeats must be between 2 and its window size."
      );
    }
    this.goal = goal;
    this.guard = new LoopGuard({ window, maxRepeats });
  }

  inspect(
    observation: PlaytestLoopObservation,
    actionId: string
  ): PlaytestLoopInspection {
    if (observation.goal !== this.goal) {
      throw new TypeError(
        "Loop-guard observation goal changed within an episode."
      );
    }
    if (
      !Array.isArray(observation.legalActionIds) ||
      observation.legalActionIds.length === 0 ||
      observation.legalActionIds.some(
        (id) => typeof id !== "string" || id.trim().length === 0
      ) ||
      new Set(observation.legalActionIds).size !==
        observation.legalActionIds.length
    ) {
      throw new TypeError(
        "Loop-guard legal action ids must be unique and non-empty."
      );
    }
    if (!observation.legalActionIds.includes(actionId)) {
      throw new TypeError("Loop-guard action must be currently legal.");
    }

    // Preserve the upstream observation shape exactly, while canonicalizing
    // nested JSON keys so equivalent states hash identically across adapters.
    const upstreamObservation = {
      goal: this.goal,
      state: canonicalJsonValue(observation.visibleState),
      legalActions: observation.legalActionIds.map((id) => ({ id, label: id }))
    };
    const observationHashValue = observationHash(upstreamObservation);
    const inspection = this.guard.inspect(upstreamObservation, actionId);
    return {
      ...inspection,
      observationHash: observationHashValue
    };
  }
}
