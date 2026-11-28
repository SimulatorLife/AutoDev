import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  PLAYTEST_HIGHLIGHT_MEDIA_TYPE,
  type PlaytestEvidenceLocator
} from "@simulatorlife/autodev-core";

import { PlaytestArtifactStore } from "../src/playtesting/artifact-store.ts";
import {
  buildEpisodeHighlightClips,
  decodePngRgba,
  encodeAnimatedGif,
  selectHighlightClipWindows
} from "../src/playtesting/highlight-gif.ts";

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xed_b8_83_20 : 0);
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)), false);
  return out;
}

function makeSolidPng(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number
): Uint8Array {
  const signature = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // None filter
    for (let x = 0; x < width; x += 1) {
      const px = row + 1 + x * 4;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
      raw[px + 3] = 255;
    }
  }
  const idat = deflateSync(raw);
  const parts = [
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0))
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

test("decodePngRgba and encodeAnimatedGif produce a valid looping GIF89a", () => {
  const red = decodePngRgba(makeSolidPng(16, 12, 220, 40, 40));
  const blue = decodePngRgba(makeSolidPng(16, 12, 40, 80, 220));
  assert.ok(red && blue);
  assert.equal(red.width, 16);
  assert.equal(red.height, 12);
  assert.equal(red.rgba[0], 220);
  assert.equal(blue.rgba[2], 220);

  const gif = encodeAnimatedGif([red, blue], 500);
  assert.equal(Buffer.from(gif.subarray(0, 6)).toString("ascii"), "GIF89a");
  assert.equal(gif.at(-1), 0x3b);
  assert.ok(gif.byteLength > 800);
});

test("selectHighlightClipWindows prioritizes anomalies, events, milestones, and summary", () => {
  const locators: Extract<PlaytestEvidenceLocator, { kind: "frame" }>[] =
    Array.from({ length: 10 }, (_, step) => ({
      kind: "frame",
      id: `frame-${step}`,
      step,
      frameIndex: step
    }));
  const windows = selectHighlightClipWindows(locators, [
    { step: 8, isAnomaly: true, label: "Stuck loop at step 8" },
    { step: 3, isEventTransition: true, label: "Phase transition at step 3" }
  ]);
  assert.ok(windows.length >= 2);
  assert.equal(windows[0]!.reason, "anomaly-or-termination");
  assert.equal(windows[0]!.title, "Stuck loop at step 8");
  assert.ok(windows.some((w) => w.reason === "event-sequence"));
  assert.ok(windows.some((w) => w.reason === "session-summary"));
});

test("buildEpisodeHighlightClips persists verified GIF89a artifacts in PlaytestArtifactStore", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autodev-gif-store-"));
  try {
    const store = new PlaytestArtifactStore({
      rootDirectory: root,
      workspaceId: "SimulatorLife/RacingGame"
    });
    const frame1 = store.writeArtifact({
      mediaType: "image/png",
      bytes: makeSolidPng(24, 18, 20, 180, 90)
    });
    const frame2 = store.writeArtifact({
      mediaType: "image/png",
      bytes: makeSolidPng(24, 18, 220, 160, 20)
    });
    const frame3 = store.writeArtifact({
      mediaType: "image/png",
      bytes: makeSolidPng(24, 18, 40, 120, 240)
    });
    const locators: Extract<PlaytestEvidenceLocator, { kind: "frame" }>[] = [
      { kind: "frame", id: frame1.reference.artifactId, step: 0, frameIndex: 0 },
      { kind: "frame", id: frame2.reference.artifactId, step: 1, frameIndex: 1 },
      { kind: "frame", id: frame3.reference.artifactId, step: 2, frameIndex: 2 }
    ];

    const clips = buildEpisodeHighlightClips({
      artifacts: store,
      frames: locators,
      signals: [{ step: 2, isAnomaly: true, label: "Collision at step 2" }]
    });
    assert.equal(clips.length, 1);
    const clip = clips[0]!;
    assert.equal(clip.mediaType, PLAYTEST_HIGHLIGHT_MEDIA_TYPE);
    assert.equal(clip.frameCount, 3);
    assert.equal(clip.startStep, 0);
    assert.equal(clip.endStep, 2);
    assert.equal(clip.reason, "anomaly-or-termination");

    const ref = store.referenceForId(clip.id);
    assert.ok(ref);
    assert.equal(ref.mediaType, "image/gif");
    const persisted = store.readArtifact(ref);
    assert.equal(
      Buffer.from(persisted.bytes.subarray(0, 6)).toString("ascii"),
      "GIF89a"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
