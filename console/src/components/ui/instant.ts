/**
The formatting owner for an instant.

Every timestamp the Console shows renders through `InstantDisplay`, the
Inline Display Toggle for a moment: relative time ("3 hours ago") and the
full date and time in the operator's local zone ("Nov 19, 2026, 10:30 AM").
This module is what it reads, and nothing else may format a moment: the
Console once answered "when did this happen" in seven spellings, including
`toLocaleString()` in the *server's* zone, because every view had its own.

Three readings live here:

- `relativeInstantText` and `localInstantText`, the two representations the
  operator toggles between, both computed in the browser, where the
  operator's clock and zone are;
- `instantLabel`, the storage form (`2026-02-11 03:00:12 UTC`), which is
  what the server renders before hydration because it knows neither. UTC
  is named in words, and a source's own numeric offset is kept, since
  relabelling `+02:00` would be a claim about the data.

A value that is not an ISO instant is shown whole: a value that cannot be
cut into parts is not cut into parts.
*/

/**
`YYYY-MM-DD`.
*/
const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/u;
/**
`HH:MM:SS`.
*/
const UTC_CLOCK = /^\d{2}:\d{2}:\d{2}$/u;
/**
`Z`, or a signed offset.
*/
const UTC_OFFSET = /^(?:Z|[+-]\d{2}:\d{2})$/u;
/**
The digits of a fractional second, which the clock reading does not include.
*/
const FRACTION = /^\d+/u;

/**
One instant, split into the parts a cell renders: a date, and where the
source wrote them, a clock and an offset.

Fixed-width checks in sequence rather than one pattern, for two reasons. The
shape here *is* fixed-width, so each piece is a trivial test. And a single
nested-quantifier regex for it trips `detect-unsafe-regex`, which is a report
worth answering rather than suppressing -- so this is the answer.

Anything that is not an ISO instant comes back whole, which is the property
that matters: a value that cannot be cut into parts is not cut into parts.
*/
interface InstantParts {
  /**
  The calendar date, `YYYY-MM-DD`, or the whole value when it is not one.
  */
  readonly date: string;
  /**
  The clock reading, `HH:MM:SS`, when the value carries one.
  */
  readonly clock?: string | undefined;
  /**
  The zone the source stated, `Z` or a signed offset.
  */
  readonly offset?: string | undefined;
}

function splitInstant(value: string | undefined | null): InstantParts {
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
Whether a machine can read this value back as an instant.

`splitInstant` answers whether the value can be *cut into parts*, which is a
narrower question: `2026-10-05 09:47:58` cannot be cut, and is still a date.
The two have to stay separate, because `time[datetime]` is the page's claim
that its content is a time, and that claim needs the second question.

The evaluator accepts any string here -- it checks that the field is one and
nothing more -- so a value whose writer failed reaches the view intact, and
stamping it into `datetime` asserted that the token was a date. Rendered as
the text it is, it claims nothing and still shows the operator what the store
holds. `Date.parse` is the test because it is the question being asked: can
this be read back as the moment it names?
*/
export function isReadableInstant(value: string | undefined | null): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
The zone, named the way the Console names it everywhere else.

`Z` is Zulu, which is UTC; the storage form says "UTC" because the
Console's date-range fields say "UTC", and a reader should not have to know
a symbol to read a moment. A numeric offset is left as the source stated it.
*/
function instantZone(offset: string | undefined): string {
  if (offset === undefined || offset === "") return "";
  return offset === "Z" ? "UTC" : offset;
}

/**
The storage form of an instant: its date, its clock and its zone -- what the
server renders before the browser can say "3 hours ago".

A value that names no clock is its date alone, and a value that is not an
instant at all is shown whole.
*/
export function instantLabel(value: string | undefined | null): string {
  const { date, clock, offset } = splitInstant(value);
  if (clock === undefined) return date;
  const zone = instantZone(offset);
  return zone === "" ? `${date} ${clock}` : `${date} ${clock} ${zone}`;
}

/**
The relative-time steps, largest first: a moment is read in the largest unit it spans.
*/
const RELATIVE_STEPS: readonly (readonly [
  Intl.RelativeTimeFormatUnit,
  number
])[] = [
  ["year", 365 * 24 * 60 * 60 * 1000],
  ["month", 30 * 24 * 60 * 60 * 1000],
  ["week", 7 * 24 * 60 * 60 * 1000],
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
  ["second", 1000]
];

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("en-US", {
  numeric: "always"
});

/**
How far an instant is from now, in the operator's words: "3 hours ago" for a
moment that has passed, "in 20 minutes" for one that has not (a quota reset,
a cooldown's end). The magnitude is truncated, never rounded up: a moment
fifty-nine minutes ago has not yet been an hour ago. Under a second reads as
"0 seconds ago". A value that is not a readable instant comes back whole.
*/
export function relativeInstantText(value: string, nowMs: number): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  const delta = at - nowMs;
  const magnitude = Math.abs(delta);
  for (const [unit, size] of RELATIVE_STEPS) {
    if (magnitude >= size || unit === "second") {
      const count = Math.trunc(magnitude / size);
      // `-0` reads "0 seconds ago": the moment that is now has just passed.
      return RELATIVE_FORMATTER.format(delta <= 0 ? -count : count, unit);
    }
  }
  return value;
}

/**
The full date and time of an instant in a zone, "Nov 19, 2026, 10:30 AM".

The zone defaults to the zone of the runtime the call runs in, which is the
operator's own only in the browser: on the server it is whichever machine
answered the request. So only the client calls this without a zone -- the
Console's timestamps are rendered by `InstantDisplay`, which reads it after
hydration -- and a test names the zone it means. A value that is not a
readable instant comes back whole.
*/
export function localInstantText(value: string, timeZone?: string): string {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  return localFormatter(timeZone).format(at);
}

/**
One formatter per zone. Building an `Intl.DateTimeFormat` loads locale and
zone data, and a page renders every timestamp through this call, so the
formatter is built once per zone rather than once per timestamp.
*/
const LOCAL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function localFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? "";
  let formatter = LOCAL_FORMATTERS.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone !== undefined && { timeZone })
    });
    LOCAL_FORMATTERS.set(key, formatter);
  }
  return formatter;
}
