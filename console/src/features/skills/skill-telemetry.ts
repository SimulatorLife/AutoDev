import type { ControlApiSkillsResponse } from "@simulatorlife/autodev-core";

/**
 * What the Runtime observed about one skill.
 *
 * `null` is "nothing has been observed for this skill" and `0` is "observed,
 * and it never happened". The two are different facts, so they stay apart: a
 * page that turns "no evidence" into "zero" claims to know something it does
 * not.
 */
export type SkillObservation = Pick<
  ControlApiSkillsResponse["skills"][number],
  "observedExposure" | "observedUse"
>;

/**
 * The Runtime's skill telemetry.
 *
 * The collection-level fact is here as well as the per-skill one, because
 * "the Runtime has observed no skill telemetry at all" and "this skill has
 * never been seen" are different questions with different answers.
 */
export interface SkillTelemetry {
  /** Whether the Runtime has observed any skill telemetry at all. */
  readonly observed: boolean;
  /** What was observed for each skill, by name. */
  readonly bySkill: ReadonlyMap<string, SkillObservation>;
}
