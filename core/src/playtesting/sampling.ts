/**
 * Seeded surveillance sampling without replacement, with minimum-stratum
 * allocation plus proportional largest-remainder apportionment, and a
 * separate seeded discovery-sample selector.
 *
 * The sampler is a pure function of (population, strata, budget, seed): the
 * same inputs always produce the same selection, which is required for a
 * frozen review batch to be reproducible across runs. An over-budget design
 * (more nonempty strata than the budget can cover with at least one unit
 * each) is a hard, explicit error rather than a silently coarsened sample.
 */

import {
  type PlaytestDiscoverySample,
  PLAYTESTS_SAMPLING_SCHEMA,
  type PlaytestSamplingPlan,
  type PlaytestStratumAllocation,
  type PlaytestSurveillanceSample
} from "./types.ts";

/** One population unit (an episode id) assigned to exactly one stratum. */
export interface PlaytestStratumMember {
  readonly id: string;
  readonly stratumKey: string;
}

/**
 * Deterministic 32-bit string hash (FNV-1a). Used only to derive a stable,
 * reproducible pseudo-random ordering from a seed; it is not a cryptographic
 * hash and must never be used for identity or security purposes.
 */
function compareStableText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function fnv1a(input: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return hash >>> 0;
}

/** Deterministic [0,1) pseudo-random value derived from seed + salt. */
function seededUnitInterval(seed: string, salt: string): number {
  return fnv1a(`${seed}:${salt}`) / 0xff_ff_ff_ff;
}

/** Stable sort by a deterministic seeded random key, tie-broken by id. */
function seededShuffle<T extends { readonly id: string }>(
  items: readonly T[],
  seed: string
): readonly T[] {
  return Array.from(items, (item) => ({
    item,
    key: seededUnitInterval(seed, item.id)
  }))
    .sort((a, b) =>
      a.key === b.key ? compareStableText(a.item.id, b.item.id) : a.key - b.key
    )
    .map((entry) => entry.item);
}

interface StratumGroup {
  readonly stratumKey: string;
  readonly members: readonly PlaytestStratumMember[];
}

function groupByStratum(
  members: readonly PlaytestStratumMember[]
): readonly StratumGroup[] {
  const order: string[] = [];
  const groups = new Map<string, PlaytestStratumMember[]>();
  for (const member of members) {
    const existing = groups.get(member.stratumKey);
    if (existing) {
      existing.push(member);
    } else {
      groups.set(member.stratumKey, [member]);
      order.push(member.stratumKey);
    }
  }
  return order.map((stratumKey) => ({
    stratumKey,
    members: groups.get(stratumKey) ?? []
  }));
}

/**
 * Allocate at least one unit per nonempty stratum, then distribute the
 * remaining budget proportionally to stratum population using the largest
 * remainder method. Throws when there are more nonempty strata than the
 * budget can cover (one unit each).
 */
export function allocatePlaytestSurveillanceStrata(
  groups: readonly StratumGroup[],
  budget: number
): readonly PlaytestStratumAllocation[] {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new TypeError("Surveillance budget must be a non-negative integer.");
  }
  const seenStrata = new Set<string>();
  const seenEpisodeIds = new Set<string>();
  for (const group of groups) {
    if (!group.stratumKey.trim() || seenStrata.has(group.stratumKey)) {
      throw new TypeError(
        "Surveillance strata must have unique non-empty keys."
      );
    }
    seenStrata.add(group.stratumKey);
    for (const member of group.members) {
      if (
        !member.id.trim() ||
        member.stratumKey !== group.stratumKey ||
        seenEpisodeIds.has(member.id)
      ) {
        throw new TypeError(
          "Surveillance strata must contain each identified episode exactly once under its declared key."
        );
      }
      seenEpisodeIds.add(member.id);
    }
  }
  const nonEmpty = groups.filter((group) => group.members.length > 0);
  if (nonEmpty.length === 0) {
    return [];
  }
  if (nonEmpty.length > budget) {
    throw new RangeError(
      `Surveillance budget ${String(budget)} cannot cover ${String(nonEmpty.length)} nonempty strata with a minimum of one unit each; predeclare coarser strata or a larger budget.`
    );
  }
  const totalPopulation = nonEmpty.reduce(
    (sum, group) => sum + group.members.length,
    0
  );
  const minimumAllocation = 1;
  const actualBudget = Math.min(budget, totalPopulation);
  const remainingBudget = actualBudget - nonEmpty.length * minimumAllocation;

  const shares = nonEmpty.map((group) => {
    const exactShare =
      (group.members.length / totalPopulation) * remainingBudget;
    const flooredShare = Math.floor(exactShare);
    return {
      stratumKey: group.stratumKey,
      population: group.members.length,
      flooredShare,
      remainder: exactShare - flooredShare
    };
  });

  const flooredTotal = shares.reduce(
    (sum, share) => sum + share.flooredShare,
    0
  );
  let remainderToDistribute = remainingBudget - flooredTotal;

  const byRemainderDesc = Array.from(shares, (share, index) => ({
    ...share,
    index
  })).sort((a, b) =>
    b.remainder === a.remainder
      ? compareStableText(a.stratumKey, b.stratumKey)
      : b.remainder - a.remainder
  );

  const extraAllocation = new Map<string, number>();
  for (const share of byRemainderDesc) {
    if (remainderToDistribute <= 0) break;
    extraAllocation.set(share.stratumKey, 1);
    remainderToDistribute -= 1;
  }

  return shares.map((share) => {
    const allocated =
      minimumAllocation +
      share.flooredShare +
      (extraAllocation.get(share.stratumKey) ?? 0);
    return {
      stratumKey: share.stratumKey,
      population: share.population,
      allocated,
      inclusionProbability: allocated / share.population
    };
  });
}

/**
 * Build a seeded surveillance sample without replacement, allocating at
 * least one unit per nonempty stratum, then proportionally by population
 * using largest-remainder apportionment.
 */
export function samplePlaytestSurveillance(
  members: readonly PlaytestStratumMember[],
  budget: number,
  seed: string
): PlaytestSurveillanceSample {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new TypeError("Surveillance budget must be a non-negative integer.");
  }
  if (!seed.trim()) throw new TypeError("Surveillance seed must be non-empty.");
  const seenIds = new Set<string>();
  for (const member of members) {
    if (!member.id.trim() || !member.stratumKey.trim()) {
      throw new TypeError(
        "Surveillance episodes and strata require non-empty identifiers."
      );
    }
    if (seenIds.has(member.id)) {
      throw new TypeError(`Duplicate surveillance episode id: ${member.id}.`);
    }
    seenIds.add(member.id);
  }
  const groups = groupByStratum(members);
  const allocations = allocatePlaytestSurveillanceStrata(groups, budget);
  const selected: string[] = [];
  for (const group of groups) {
    const allocation = allocations.find(
      (entry) => entry.stratumKey === group.stratumKey
    );
    if (!allocation) continue;
    const shuffled = seededShuffle(
      group.members,
      `${seed}:${group.stratumKey}`
    );
    for (const member of shuffled.slice(0, allocation.allocated)) {
      selected.push(member.id);
    }
  }
  const totalAllocated = allocations.reduce(
    (sum, allocation) => sum + allocation.allocated,
    0
  );
  return {
    budget,
    seed,
    selected,
    allocations,
    minimumStratumAllocation: 1,
    totalAllocated
  };
}

/** One candidate episode for discovery ranking by a versioned anomaly signal. */
export interface PlaytestDiscoveryCandidate {
  readonly id: string;
  readonly anomalyScore: number;
}

/**
 * Rank remaining episodes by a versioned anomaly/novelty signal and select
 * the top `budget` with seeded tie-breaks. Deduplication of similar
 * discovery traces is the caller's responsibility (it requires domain-
 * specific similarity, which Core does not define).
 */
export function samplePlaytestDiscovery(
  candidates: readonly PlaytestDiscoveryCandidate[],
  budget: number,
  seed: string,
  rankedBy: string
): PlaytestDiscoverySample {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new TypeError("Discovery budget must be a non-negative integer.");
  }
  if (!seed.trim() || !rankedBy.trim()) {
    throw new TypeError(
      "Discovery selection requires a seed and ranking version."
    );
  }
  const seenIds = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.id.trim() || !Number.isFinite(candidate.anomalyScore)) {
      throw new TypeError(
        "Discovery candidates require an id and finite anomaly score."
      );
    }
    if (seenIds.has(candidate.id)) {
      throw new TypeError(`Duplicate discovery episode id: ${candidate.id}.`);
    }
    seenIds.add(candidate.id);
  }
  const ranked = [...candidates].sort((a, b) => {
    if (b.anomalyScore !== a.anomalyScore) {
      return b.anomalyScore - a.anomalyScore;
    }
    const tieKeyA = seededUnitInterval(seed, a.id);
    const tieKeyB = seededUnitInterval(seed, b.id);
    return tieKeyA === tieKeyB
      ? compareStableText(a.id, b.id)
      : tieKeyA - tieKeyB;
  });
  return {
    budget,
    seed,
    selected: ranked.slice(0, budget).map((candidate) => candidate.id),
    rankedBy,
    tieBreakerSeed: seed
  };
}

/** Combine a surveillance and discovery sample into one plan envelope. */
export function buildPlaytestSamplingPlan(
  surveillance: PlaytestSurveillanceSample,
  discovery: PlaytestDiscoverySample
): PlaytestSamplingPlan {
  return { surveillance, discovery, schema: PLAYTESTS_SAMPLING_SCHEMA };
}

export { groupByStratum };
export type { StratumGroup };
