import { ConfigError } from "@simulatorlife/autodev-runtime/config";

/**
 * How every command family states which values it accepts.
 *
 * Each family used to spell its accepted values twice: once as a TypeScript
 * union, and again as a chain of `!==` comparisons in the dispatcher. That
 * second copy is why the errors were unhelpful. A dispatcher could only name
 * the value the caller got wrong, never the values it would have accepted, so
 * `autodev router bogus` answered "unsupported router command: bogus" and left
 * a contributor with no way to learn that `run`, `ensure`, and `status` were
 * the whole vocabulary. Learning it meant reading the source.
 *
 * Worse, a command invoked with no subcommand at all fell past every family and
 * reached the top level, where the catch-all reported it as "not implemented in
 * this migration slice; ... complete the owning subsystem migration". That was
 * false for every command it named -- `render` is implemented, and `--help`
 * lists it -- and the advice to finish a subsystem migration is not something a
 * caller can act on.
 *
 * The accepted values now live in one exported list per family, the union type
 * is derived from that list, and the rejection is built from the same list, so
 * a message cannot drift from what the command actually accepts.
 */

/** Joins accepted values the way a sentence reads: "a, b, or c". */
export function formatChoices(choices: readonly string[]): string {
  if (choices.length < 2) return choices.at(0) ?? "";
  return `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1) ?? ""}`;
}

/**
 * Builds the rejection a command family raises for an unusable argument.
 *
 * An empty `given` is reported as a missing argument rather than an empty one:
 * "unsupported provider: (missing)" described the implementation instead of the
 * mistake, and the placeholder was the only part of the line that told the
 * caller anything at all.
 *
 * `label` reads as the thing being chosen ("provider", "router command"), so
 * the two forms come out as
 * `provider requires one of: claude, minimax, copilot, or antigravity` and
 * `unsupported provider: bogus (expected one of: ...)`.
 */
export function unsupportedChoice(
  label: string,
  given: string,
  choices: readonly string[]
): ConfigError {
  const accepted = formatChoices(choices);
  return new ConfigError(
    given === ""
      ? `${label} requires one of: ${accepted}`
      : `unsupported ${label}: ${given} (expected one of: ${accepted})`
  );
}

/**
 * Narrows `value` against the single list its family owns.
 *
 * The cast is the boundary: `includes` cannot narrow a `readonly T[]` for a
 * plain `string`, and duplicating the literals in a comparison is exactly the
 * second source of truth this module exists to remove.
 */
export function isChoice<const T extends readonly string[]>(
  value: string,
  choices: T
): value is T[number] {
  return (choices as readonly string[]).includes(value);
}
