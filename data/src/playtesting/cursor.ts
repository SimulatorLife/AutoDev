/**
 * Stable keyset pagination cursors for Playtesting list queries.
 *
 * Every list view in docs/playtesting-target-state.md Section 9 is
 * "server-filtered/cursor-paginated"; offset pagination over a ClickHouse
 * table that keeps growing would skip or repeat rows as new episodes land
 * between pages. The cursor instead names the last row's sort key
 * (`orderedAt`, the column each query orders by) and its tiebreaker id, so
 * the next page's WHERE clause can resume exactly where the last one ended
 * regardless of concurrent inserts.
 */

import { PlaytestInvalidCursorError } from "./errors.ts";

export interface PlaytestKeysetCursor {
  /** The ISO-8601 value of the row's primary ORDER BY column. */
  readonly orderedAt: string;
  /** The row's unique id column, used to break ties within one timestamp. */
  readonly tiebreakId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Encode a cursor as an opaque, URL-safe token. */
export function encodePlaytestCursor(cursor: PlaytestKeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Decode a cursor token; `undefined`/empty input means "first page". */
export function decodePlaytestCursor(
  token: string | undefined
): PlaytestKeysetCursor | null {
  if (token === undefined || token.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new PlaytestInvalidCursorError();
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.orderedAt !== "string" ||
    parsed.orderedAt.length === 0 ||
    typeof parsed.tiebreakId !== "string" ||
    parsed.tiebreakId.length === 0
  ) {
    throw new PlaytestInvalidCursorError();
  }
  return { orderedAt: parsed.orderedAt, tiebreakId: parsed.tiebreakId };
}
