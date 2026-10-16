/** Seed selection for the Playtesting run form, owned by the Runtime's admissible-seed contract. */
import type { ControlApiPlaytestingCapabilitiesResponse } from "@simulatorlife/autodev-core";

export type PlaytestingAdmissibleSeeds =
  ControlApiPlaytestingCapabilitiesResponse["admissibleSeeds"];

export interface PlaytestingSeededAssignment {
  readonly scenarioId: string;
  readonly policyId: string;
  readonly seed: string;
}

/** The seed the first assignment starts with. */
export function initialPlaytestingSeed(
  admissibleSeeds: PlaytestingAdmissibleSeeds
): string {
  return admissibleSeeds?.[0]?.seed ?? "seed-1";
}

/** Whether the Runtime would admit this seed for the latest build. */
export function isAdmissiblePlaytestingSeed(
  admissibleSeeds: PlaytestingAdmissibleSeeds,
  seed: string
): boolean {
  const trimmed = seed.trim();
  return (
    trimmed.length > 0 &&
    (admissibleSeeds === null ||
      admissibleSeeds.some((entry) => entry.seed === trimmed))
  );
}

/**
 * The seed a new assignment starts with. A build that freezes a benchmark
 * admits only its inventory, so the first inventory seed unused in that
 * scenario/policy cell is offered (null once exhausted); otherwise the next
 * numbered seed unused in the batch.
 */
export function nextPlaytestingSeed(
  admissibleSeeds: PlaytestingAdmissibleSeeds,
  assignments: readonly PlaytestingSeededAssignment[],
  scenarioId: string,
  policyId: string
): string | null {
  if (admissibleSeeds !== null) {
    const used = new Set(
      assignments
        .filter(
          (assignment) =>
            assignment.scenarioId === scenarioId &&
            assignment.policyId === policyId
        )
        .map((assignment) => assignment.seed.trim())
    );
    return admissibleSeeds.find((entry) => !used.has(entry.seed))?.seed ?? null;
  }
  const seeds = new Set(assignments.map((assignment) => assignment.seed));
  let seedNumber = assignments.length + 1;
  while (seeds.has("seed-" + String(seedNumber))) seedNumber += 1;
  return "seed-" + String(seedNumber);
}
