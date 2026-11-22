import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlaytestHighlightClips,
  PLAYTEST_HIGHLIGHT_MAX_CLIPS_PER_EPISODE,
  PLAYTEST_HIGHLIGHT_MEDIA_TYPE,
  type PlaytestHighlightClip
} from "../src/index.ts";

function sampleClip(overrides: Partial<PlaytestHighlightClip> = {}): PlaytestHighlightClip {
  return {
    id: "highlight-1",
    mediaType: PLAYTEST_HIGHLIGHT_MEDIA_TYPE,
    sha256: "a".repeat(64),
    bytes: 1024,
    title: "Stopped: no progress detected (steps 2-4)",
    reason: "anomaly-or-termination",
    startStep: 2,
    endStep: 4,
    frameCount: 3,
    durationMs: 1800,
    frameIds: ["frame-2", "frame-3", "frame-4"],
    ...overrides
  };
}

test("assertPlaytestHighlightClips accepts valid bounded highlight clips", () => {
  const clips = [
    sampleClip(),
    sampleClip({
      id: "highlight-2",
      reason: "session-summary",
      title: "Session highlight reel (steps 0-4)",
      startStep: 0,
      endStep: 4,
      frameCount: 2,
      frameIds: ["frame-0", "frame-4"]
    })
  ];
  assertPlaytestHighlightClips(clips);
});

test("assertPlaytestHighlightClips rejects malformed, duplicate, or unbounded clips", () => {
  assert.throws(() => assertPlaytestHighlightClips("nope"), TypeError);
  assert.throws(
    () => assertPlaytestHighlightClips([sampleClip({ mediaType: "image/png" as "image/gif" })]),
    TypeError
  );
  assert.throws(
    () => assertPlaytestHighlightClips([sampleClip({ sha256: "short" })]),
    TypeError
  );
  assert.throws(
    () => assertPlaytestHighlightClips([sampleClip({ startStep: 5, endStep: 3 })]),
    TypeError
  );
  assert.throws(
    () => assertPlaytestHighlightClips([sampleClip({ frameCount: 2, frameIds: ["frame-1"] })]),
    TypeError
  );
  assert.throws(
    () => assertPlaytestHighlightClips([sampleClip({ id: "dup" }), sampleClip({ id: "dup" })]),
    TypeError
  );
  const tooMany = Array.from({ length: PLAYTEST_HIGHLIGHT_MAX_CLIPS_PER_EPISODE + 1 }, (_, i) =>
    sampleClip({ id: "clip-" + String(i) })
  );
  assert.throws(() => assertPlaytestHighlightClips(tooMany), TypeError);
});
