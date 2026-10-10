/**
 * Typed failure modes for the Playtesting ClickHouse repository.
 *
 * ClickHouse being unreachable, returning malformed JSON, or returning a
 * count that cannot be parsed are not "zero episodes" or "no findings" --
 * they are the source failing to answer. Every read in this module throws
 * one of these instead of synthesizing an empty page, per
 * docs/playtesting-target-state.md Section 9 ("no invalid 0 for missing
 * data") and Section 3 of the measurement contract (missing data is a typed
 * absence, never a count).
 */

/** The ClickHouse-backed Playtesting store could not answer a request. */
export class PlaytestSourceUnavailableError extends Error {
  constructor(reason: string, cause?: unknown) {
    super(`Playtesting ClickHouse source is unavailable: ${reason}`);
    this.name = "PlaytestSourceUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** A caller supplied a keyset cursor this repository did not issue. */
export class PlaytestInvalidCursorError extends Error {
  constructor() {
    super(
      "Playtesting pagination cursor is malformed or was not issued by this repository."
    );
    this.name = "PlaytestInvalidCursorError";
  }
}
