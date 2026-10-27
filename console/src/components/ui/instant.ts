/**
 * One owner for an instant.
 *
 * The Console answers "when did this happen" in seven spellings, and the
 * spellings disagree with each other about the same fact. The memory records
 * table read a record's update as `2/11/2026` -- a date whose order is
 * ambiguous to anyone outside the United States, with no time in it at all.
 * The memory detail lines beside it read `2/11/2026, 3:00:12 AM`, which is
 * worse: `toLocaleString()` renders in the *server's* zone, so the time is
 * the time of whichever machine answered the request, not of the operator
 * reading it. The GitHub page rendered the raw wire value,
 * `2026-02-11T03:00:12.000Z`, milliseconds and all. The evaluations table
 * split an ISO instant into a date and a clock and spoke the zone as `Z`. The
 * Usage trace table spoke the same zone as `UTC`. The playtesting review line
 * printed the raw ISO again.
 *
 * An instant is one quantity, so it has one rendering, the way a duration has
 * one (`components/ui/duration.ts`). Which page a reader is on is not a reason
 * for the moment to change its shape.
 *
 * Two shapes are enough for every surface the Console has:
 *
 * - the date alone, `2026-02-11`, for a column whose budget holds a date and
 *   whose full value belongs on the hover title;
 * - the date, the clock and the zone, `2026-02-11 03:00:12 UTC`, for
 *   everything else.
 *
 * The zone is named in words. The Console already says "Time (UTC)" in a
 * column header and "From (UTC):" beside a date field, so `UTC` is the
 * Console's own spelling of the zone, and a reader does not have to know that
 * `Z` means Zulu to read a moment. A source that stated a numeric offset keeps
 * it: `+02:00` is the source's own spelling of a zone that is not UTC, and
 * relabelling it would be a claim about the data rather than about its
 * formatting.
 *
 * A value that is not an ISO instant is shown whole. A value that cannot be
 * cut into parts is not cut into parts.
 */

/** `YYYY-MM-DD`. */
const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/** `HH:MM:SS`. */
const UTC_CLOCK = /^\d{2}:\d{2}:\d{2}$/u;
/** `Z`, or a signed offset. */
const UTC_OFFSET = /^(?:Z|[+-]\d{2}:\d{2})$/u;
/** The digits of a fractional second, which the clock reading does not include. */
const FRACTION = /^\d+/u;

/**
 * One instant, split into the parts a cell renders: a date, and where the
 * source wrote them, a clock and an offset.
 *
 * Fixed-width checks in sequence rather than one pattern, for two reasons. The
 * shape here *is* fixed-width, so each piece is a trivial test. And a single
 * nested-quantifier regex for it trips `detect-unsafe-regex`, which is a report
 * worth answering rather than suppressing -- so this is the answer.
 *
 * Anything that is not an ISO instant comes back whole, which is the property
 * that matters: a value that cannot be cut into parts is not cut into parts.
 */
export interface InstantParts {
  /** The calendar date, `YYYY-MM-DD`, or the whole value when it is not one. */
  readonly date: string;
  /** The clock reading, `HH:MM:SS`, when the value carries one. */
  readonly clock?: string | undefined;
  /** The zone the source stated, `Z` or a signed offset. */
  readonly offset?: string | undefined;
}

export function splitInstant(value: string | undefined | null): InstantParts {
  if (typeof value !== "string") return { date: "" };
  const date = value.slice(0, 10);
  if (!UTC_DATE.test(date) || value.length === 10) return { date: value };
  if (value[10] !== "T") return { date: value };
  const clock = value.slice(11, 19);
  if (!UTC_CLOCK.test(clock)) return { date: value };

  let offset = value.slice(19);
  // A fractional second belongs to the instant, not to the clock reading, so it
  // is skipped rather than rendered as a third number.
  if (offset.startsWith(".")) {
    const digits = offset.slice(1).match(FRACTION);
    if (digits === null) return { date: value };
    offset = offset.slice(1 + digits[0].length);
  }
  return offset === "" || UTC_OFFSET.test(offset)
    ? { date, clock, offset }
    : { date: value };
}

/**
 * Whether a machine can read this value back as an instant.
 *
 * `splitInstant` answers whether the value can be *cut into parts*, which is a
 * narrower question: `2026-10-05 09:47:58` cannot be cut, and is still a date.
 * The two have to stay separate, because `time[datetime]` is the page's claim
 * that its content is a time, and that claim needs the second question.
 *
 * The evaluator accepts any string here -- it checks that the field is one and
 * nothing more -- so a value whose writer failed reaches the view intact, and
 * stamping it into `datetime` asserted that the token was a date. Rendered as
 * the text it is, it claims nothing and still shows the operator what the store
 * holds. `Date.parse` is the test because it is the question being asked: can
 * this be read back as the moment it names?
 */
export function isReadableInstant(value: string | undefined | null): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * The zone, named the way the Console names it everywhere else.
 *
 * `Z` is Zulu, which is UTC; the Console says "UTC" because its own column
 * headers and date fields say "UTC", and a reader should not have to know a
 * symbol to read a moment. A numeric offset is left as the source stated it.
 */
export function instantZone(offset: string | undefined): string {
  if (offset === undefined || offset === "") return "";
  return offset === "Z" ? "UTC" : offset;
}

/**
 * The date an instant names, or the whole value when it names no date.
 */
export function instantDate(value: string | undefined | null): string {
  return splitInstant(value).date;
}

/**
 * The clock an instant names, with its zone, or nothing when it names no
 * clock.
 *
 * This is the second half of the split rendering: a cell that shows the date
 * and the clock as two items can fold between them, and the whole value stays
 * on the title.
 */
export function instantClock(value: string | undefined | null): string {
  const { clock, offset } = splitInstant(value);
  if (clock === undefined) return "";
  return `${clock} ${instantZone(offset)}`.trim();
}

/**
 * The whole of an instant: its date, its clock and its zone.
 *
 * A value that names no clock is its date alone, and a value that is not an
 * instant at all is shown whole.
 */
export function instantLabel(value: string | undefined | null): string {
  const { date, clock, offset } = splitInstant(value);
  if (clock === undefined) return date;
  const zone = instantZone(offset);
  return zone === "" ? `${date} ${clock}` : `${date} ${clock} ${zone}`;
}
