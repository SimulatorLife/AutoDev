/** Compare immutable game-build references across JSON/string boundaries. */

import type { PlaytestVersionedRef } from "./types.ts";

export function samePlaytestBuild(
  left: PlaytestVersionedRef | null | undefined,
  right: PlaytestVersionedRef | null | undefined
): boolean {
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    String(left.version) === String(right.version) &&
    (left.contentHash ?? null) === (right.contentHash ?? null)
  );
}
