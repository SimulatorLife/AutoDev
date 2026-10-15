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
    readonly version?: string;
  } = {}
): PlaytestPolicy {
  const id = options.id ?? "random";
  const cohort = options.cohort ?? "exploratory";
  const version = options.version ?? "hmac-sha256-v1";
  if (!id.trim() || !cohort.trim() || !version.trim()) {
    throw new TypeError(
      "Random policy id, cohort, and version must be non-empty."
    );
  }
  return {
    id,
    version,
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

/**
 * Deterministic lowest-action-id baseline.
 *
 * Independent of the random policy in the way that matters for a comparison arm:
 * it consults no seed and no RNG state, so its decisions cannot move when the
 * seed, the worker count or the scheduling order changes. It always takes the
 * lexicographically first legal action, which makes it the reference for
 * whether an arm's improvement came from the heuristic rather than from luck.
 *
 * It is a policy in its own right rather than a scored wrapper, so it needs no
 * game code and is therefore available to every onboarded game.
 */
export function createFirstLegalPlaytestPolicy(
  options: {
    readonly id?: string;
    readonly cohort?: string;
    readonly version?: string;
  } = {}
): PlaytestPolicy {
  const id = options.id ?? "first-legal";
  const cohort = options.cohort ?? "deterministic";
  const version = options.version ?? "lowest-action-id-v1";
  if (!id.trim() || !cohort.trim() || !version.trim()) {
    throw new TypeError(
      "First-legal policy id, cohort, and version must be non-empty."
    );
  }
  return {
    id,
    version,
    cohort,
    strategy: "lexicographically-first-legal-action",
    modelId: null,
    modelRevision: null,
    chooseAction(context) {
      const actions = context.legalActionIds;
      if (
        actions.length === 0 ||
        actions.some((actionId) => !actionId.trim()) ||
        new Set(actions).size !== actions.length
      ) {
        throw new TypeError(
          "First-legal policy requires unique, non-empty legal actions."
        );
      }
      return {
        actionId: [...actions].sort()[0]!,
        prediction: null
      };
    }
  };
}

/**
 * The policies AutoDev can actually run, in one place.
 *
 * A game config may name any policy string, so this registry is what the
 * onboarding check validates against. Without it, a game could declare a policy
 * no code path constructs and meet the refusal as a mid-run failure.
 */
export const PLAYTESTS_BUILTIN_POLICY_IDS: ReadonlySet<string> = new Set([
  "random",
  "first-legal"
]);

/** Construct a built-in policy by id, or null when the id is not one. */
export function createBuiltinPlaytestPolicy(
  policyId: string,
  options: { readonly version?: string } = {}
): PlaytestPolicy | null {
  if (policyId === "random")
    return createSeededRandomPlaytestPolicy({ id: policyId, ...options });
  if (policyId === "first-legal") {
    return createFirstLegalPlaytestPolicy({ id: policyId, ...options });
  }
  return null;
}
