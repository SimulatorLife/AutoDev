/**
Compare immutable game-build references across JSON/string boundaries.
*/

import type { PlaytestVersionedRef as PlaytestVersionedReference } from "./types.ts";

export function samePlaytestBuild(
  left: PlaytestVersionedReference | null | undefined,
  right: PlaytestVersionedReference | null | undefined
): boolean {
  if (!left || !right) return false;
  return (
    left.id === right.id &&
    String(left.version) === String(right.version) &&
    (left.contentHash ?? null) === (right.contentHash ?? null)
  );
}
