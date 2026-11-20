import { NOT_OBSERVED_LABEL } from "../status/StatusBadge.ts";
import type { InlineRepresentation } from "./InlineDisplayToggle.ts";

/**
 * One unit a measured size of some content can be read in.
 *
 * `value` is null when the source has not measured the content in that unit.
 * An unmeasured unit is still offered -- it reads "Not observed" in that unit's
 * name -- so the operator can see which measurements the source does not
 * supply, instead of the toggle silently skipping a unit or showing a value
 * converted from another unit. Every value must be a measurement of the same
 * content; a count derived from another unit (bytes / 4 as "tokens") is not one.
 */
export interface MeasureUnit {
  readonly id: MeasureUnitId;
  readonly value: number | null;
}

export type MeasureUnitId = "bytes" | "characters" | "tokens";

const UNIT_NOUNS: Readonly<
  Record<MeasureUnitId, { readonly singular: string; readonly plural: string }>
> = {
  bytes: { singular: "byte", plural: "bytes" },
  characters: { singular: "character", plural: "characters" },
  tokens: { singular: "token", plural: "tokens" }
};

const COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});

/** The text one measurement displays, e.g. "1,200 bytes" or "Not observed (tokens)". */
export function measureText(unit: MeasureUnit): string {
  const nouns = UNIT_NOUNS[unit.id];
  if (unit.value === null) return `${NOT_OBSERVED_LABEL} (${nouns.plural})`;
  return `${COUNT_FORMATTER.format(unit.value)} ${unit.value === 1 ? nouns.singular : nouns.plural}`;
}

/** The measurements of one piece of content, as inline-toggle representations. */
export function measureRepresentations(
  units: readonly MeasureUnit[]
): readonly InlineRepresentation[] {
  return units.map((unit) => ({
    id: unit.id,
    text: measureText(unit),
    name: UNIT_NOUNS[unit.id].plural
  }));
}
