/** Small code-owned gameplay policy interfaces and safe deterministic baselines. */
import { createHmac } from "node:crypto";

import type { PlaytestJsonValue } from "@simulatorlife/autodev-core";

export interface PlaytestPolicyContext {
  readonly seed: string;
  readonly episodeId: string;
  readonly step: number;
  /** Filtered game-authored player-visible state only. */
  readonly observation: PlaytestJsonValue;
  readonly legalActionIds: readonly string[];
}

export interface PlaytestPolicyDecision {
  readonly actionId: string;
  /** Frozen before action execution; null means no expectation was collected. */
  readonly prediction: PlaytestJsonValue | null;
}

export interface PlaytestPolicy {
  readonly id: string;
  readonly version: string;
  readonly cohort: string;
  readonly strategy: string;
  readonly modelId: string | null;
  readonly modelRevision: string | null;
  chooseAction(
    context: PlaytestPolicyContext
  ): Promise<PlaytestPolicyDecision> | PlaytestPolicyDecision;
}

/**
 * Deterministic pseudorandom legal-action baseline. Uses HMAC-SHA-256 with a
 * domain-separated episode/step input, so retries and worker scheduling cannot
 * change a decision and no ambient `Math.random()` state is consulted.
 */
export function createSeededRandomPlaytestPolicy(
  options: {
    readonly id?: string;
    readonly cohort?: string;
  } = {}
): PlaytestPolicy {
  const id = options.id ?? "random";
  const cohort = options.cohort ?? "exploratory";
  if (!id.trim() || !cohort.trim()) {
    throw new TypeError("Random policy id and cohort must be non-empty.");
  }
  return {
    id,
    version: "hmac-sha256-v1",
    cohort,
    strategy: "uniform-legal-action",
    modelId: null,
    modelRevision: null,
    chooseAction(context) {
      if (
        !context.seed ||
        !context.episodeId ||
        !Number.isSafeInteger(context.step) ||
        context.step < 0
      ) {
        throw new TypeError(
          "Random policy requires a seed, episode id, and non-negative step."
        );
      }
      const actions = context.legalActionIds;
      if (
        actions.length === 0 ||
        actions.some((actionId) => !actionId.trim()) ||
        new Set(actions).size !== actions.length
      ) {
        throw new TypeError(
          "Random policy requires unique, non-empty legal actions."
        );
      }
      const range = 1n << 64n;
      const count = BigInt(actions.length);
      const acceptanceCeiling = range - (range % count);
      for (let counter = 0; counter < 32; counter += 1) {
        const digest = createHmac("sha256", context.seed)
          .update("autodev-playtest-random-v1\0", "utf8")
          .update(context.episodeId, "utf8")
          .update("\0" + String(context.step) + "\0" + String(counter), "utf8")
          .digest();
        const value = digest.readBigUInt64BE(0);
        if (value < acceptanceCeiling) {
          const offset = Number(value % count);
          return { actionId: actions[offset]!, prediction: null };
        }
      }
      throw new Error("Random policy rejection sampling exceeded its bound.");
    }
  };
}

/**
 * Wrap a target-owned deterministic heuristic without importing game rules
 * into AutoDev. The scorer sees only the policy context and returns a finite
 * score for legal action IDs; ties resolve by stable action-id ordering.
 */
export function createScoredPlaytestPolicy(options: {
  readonly id: string;
  readonly version: string;
  readonly cohort: string;
  readonly strategy: string;
  readonly modelId?: string | null;
  readonly modelRevision?: string | null;
  readonly score: (context: PlaytestPolicyContext, actionId: string) => number;
}): PlaytestPolicy {
  if (
    !options.id.trim() ||
    !options.version.trim() ||
    !options.cohort.trim() ||
    !options.strategy.trim()
  ) {
    throw new TypeError("Scored policy identity fields must be non-empty.");
  }
  return {
    id: options.id,
    version: options.version,
    cohort: options.cohort,
    strategy: options.strategy,
    modelId: options.modelId ?? null,
    modelRevision: options.modelRevision ?? null,
    chooseAction(context) {
      const actions = context.legalActionIds;
      if (
        actions.length === 0 ||
        actions.some((actionId) => !actionId.trim()) ||
        new Set(actions).size !== actions.length
      ) {
        throw new TypeError(
          "Scored policy requires unique, non-empty legal actions."
        );
      }
      let selected = actions[0]!;
      let selectedScore = options.score(context, selected);
      if (!Number.isFinite(selectedScore)) {
        throw new TypeError("Scored policy must return finite scores.");
      }
      for (const actionId of actions.slice(1)) {
        const score = options.score(context, actionId);
        if (!Number.isFinite(score)) {
          throw new TypeError("Scored policy must return finite scores.");
        }
        if (
          score > selectedScore ||
          (score === selectedScore && actionId < selected)
        ) {
          selected = actionId;
          selectedScore = score;
        }
      }
      return { actionId: selected, prediction: null };
    }
  };
}
