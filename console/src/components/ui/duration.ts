/**
 * One owner for a duration.
 *
 * The Console renders durations in five places: the Usage p95 latency card,
 * the Usage p95 tool-call card, the Usage recent-attempt table, the Usage
 * trace span table and the Evaluations trace panel. The last three all read
 * the same source value -- a span's `durationNs` -- and two of them used to
 * have a formatter of their own. The two did not agree with each other: one
 * rendered a span of a third of a microsecond as "0 µs", which claims the
 * span took no time at all, and the two spelled every larger magnitude
 * differently ("940 ms" against "940.0 ms", "2 min" against "2m 0s"), so the
 * same duration read one way on one page and another way on the next.
 *
 * A duration is one quantity, so it has one rendering. Which page a reader is
 * on is not a reason for the number to change. This one keeps both properties
 * the two owners had between them: the minutes are split from the seconds, so
 * a duration that rounds into its next minute says so ("1m 59s" beside
 * "2m 0s") instead of two spans a second apart reading the same, and a
 * duration of hours reads in hours instead of in minutes.
 */

/** The number of nanoseconds in a millisecond. */
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_HOUR = 3_600_000;

/**
 * The digits a duration carries.
 *
 * One decimal is enough to say what a duration was without the column growing
 * to fit the digits a reader has to convert.
 */
const DURATION_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1
});

/**
 * A duration, at a unit an operator can read at a glance.
 *
 * The unit steps so the value stays small at every magnitude, and two of the
 * steps are deliberate.
 *
 * The microsecond band is floored at one, because a span that took some time
 * is never rendered as having taken no time. That is the one thing a duration
 * must not claim, and it is the one case where rounding to the display
 * resolution and rounding to zero are not the same operation.
 *
 * The minutes are split from the seconds, and the seconds are rounded once
 * before the split, because rounding each half separately is how a minute ends
 * up holding sixty: 119.9s split first and rounded afterwards read as "1m 59s"
 * with a rounded leftover, which became "1m 60s" -- a duration that does not
 * exist, and one no reader can reconcile with the span beside it.
 */
export function formatDurationMs(milliseconds: number): string {
  if (milliseconds > 0 && milliseconds < 1) {
    return `${Math.max(1, Math.round(milliseconds * 1000))} µs`;
  }
  if (milliseconds >= MILLISECONDS_PER_HOUR) {
    return `${DURATION_FORMATTER.format(milliseconds / MILLISECONDS_PER_HOUR)} h`;
  }
  if (milliseconds >= MILLISECONDS_PER_MINUTE) {
    const totalSeconds = Math.round(milliseconds / MILLISECONDS_PER_SECOND);
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  }
  if (milliseconds >= MILLISECONDS_PER_SECOND) {
    return `${DURATION_FORMATTER.format(
      milliseconds / MILLISECONDS_PER_SECOND
    )} s`;
  }
  return `${DURATION_FORMATTER.format(milliseconds)} ms`;
}

/**
 * A span's duration, which the source measures in nanoseconds.
 *
 * The unit conversion lives here rather than at each call site so that a
 * caller cannot round the value into the wrong band on its way to the
 * formatter.
 */
export function formatSpanDuration(durationNs: number): string {
  return formatDurationMs(durationNs / NANOSECONDS_PER_MILLISECOND);
}
