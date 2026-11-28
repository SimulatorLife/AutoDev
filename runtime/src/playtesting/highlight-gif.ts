/**
Deterministic Playtesting highlight GIF recorder.

Selects up to `PLAYTEST_HIGHLIGHT_MAX_CLIPS_PER_EPISODE` bounded highlight
sequences from captured episode PNG frames, encodes them as animated GIF89a
clips using pure TypeScript and Node's built-in `zlib`, and stores them in the
workspace's content-addressed `PlaytestArtifactStore`.
*/

import { inflateSync } from "node:zlib";

import {
  assertPlaytestHighlightClips,
  PLAYTEST_HIGHLIGHT_MAX_BYTES,
  PLAYTEST_HIGHLIGHT_MAX_CLIPS_PER_EPISODE,
  PLAYTEST_HIGHLIGHT_MAX_FRAMES_PER_CLIP,
  PLAYTEST_HIGHLIGHT_MEDIA_TYPE,
  type PlaytestEvidenceLocator,
  type PlaytestHighlightClip,
  type PlaytestHighlightReason
} from "@simulatorlife/autodev-core";

import type { PlaytestArtifactStore } from "./artifact-store.ts";

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
const MAX_GIF_WIDTH = 480;
const MAX_GIF_HEIGHT = 360;
const DEFAULT_FRAME_DELAY_MS = 650;
const MIN_FRAMES_PER_CLIP = 2;

export interface DecodedRgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface HighlightStepSignal {
  readonly step: number;
  readonly isAnomaly?: boolean;
  readonly isEventTransition?: boolean;
  readonly isProgressMilestone?: boolean;
  readonly label?: string | null;
}

export interface HighlightClipWindow {
  readonly reason: PlaytestHighlightReason;
  readonly title: string;
  readonly startStep: number;
  readonly endStep: number;
  readonly frameIds: readonly string[];
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

/**
Decode an 8-bit non-interlaced PNG buffer (grayscale, RGB, palette, grayscale+alpha, or RGBA)
into RGBA pixel bytes. Returns `null` if the PNG is unsupported or malformed.
*/
export function decodePngRgba(bytes: Uint8Array): DecodedRgbaImage | null {
  if (bytes.length < 33) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filterMethod = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) return null;

    if (type === "IHDR") {
      if (length < 13) return null;
      width = readUint32BE(bytes, dataStart);
      height = readUint32BE(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      compression = bytes[dataStart + 10]!;
      filterMethod = bytes[dataStart + 11]!;
      interlace = bytes[dataStart + 12]!;
    } else if (type === "PLTE") {
      palette = bytes.subarray(dataStart, dataEnd);
    } else if (type === "IDAT") {
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    bitDepth !== 8 ||
    compression !== 0 ||
    filterMethod !== 0 ||
    interlace !== 0 ||
    idatChunks.length === 0
  ) {
    return null;
  }

  const bytesPerPixel =
    colorType === 0
      ? 1
      : colorType === 2
        ? 3
        : colorType === 3
          ? 1
          : colorType === 4
            ? 2
            : colorType === 6
              ? 4
              : 0;
  if (bytesPerPixel === 0) return null;
  if (colorType === 3 && (!palette || palette.length < 3)) return null;

  const totalIdat = idatChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(totalIdat);
  let writeOffset = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }

  let raw: Uint8Array;
  try {
    raw = inflateSync(compressed);
  } catch {
    return null;
  }

  const stride = width * bytesPerPixel;
  if (raw.length < height * (stride + 1)) return null;

  const reconstructed = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)]!;
    const srcRow = y * (stride + 1) + 1;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[srcRow + x]!;
      const left = x >= bytesPerPixel ? reconstructed[dstRow + x - bytesPerPixel]! : 0;
      const up = y > 0 ? reconstructed[prevRow + x]! : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel
          ? reconstructed[prevRow + x - bytesPerPixel]!
          : 0;
      let out = value;
      if (filterType === 1) out = (value + left) & 0xff;
      else if (filterType === 2) out = (value + up) & 0xff;
      else if (filterType === 3) out = (value + ((left + up) >> 1)) & 0xff;
      else if (filterType === 4) out = (value + paethPredictor(left, up, upLeft)) & 0xff;
      else if (filterType !== 0) return null;
      reconstructed[dstRow + x] = out;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const dst = i * 4;
    if (colorType === 6) {
      const src = i * 4;
      rgba[dst] = reconstructed[src]!;
      rgba[dst + 1] = reconstructed[src + 1]!;
      rgba[dst + 2] = reconstructed[src + 2]!;
      rgba[dst + 3] = reconstructed[src + 3]!;
    } else if (colorType === 2) {
      const src = i * 3;
      rgba[dst] = reconstructed[src]!;
      rgba[dst + 1] = reconstructed[src + 1]!;
      rgba[dst + 2] = reconstructed[src + 2]!;
      rgba[dst + 3] = 255;
    } else if (colorType === 0) {
      const g = reconstructed[i]!;
      rgba[dst] = g;
      rgba[dst + 1] = g;
      rgba[dst + 2] = g;
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      const src = i * 2;
      const g = reconstructed[src]!;
      rgba[dst] = g;
      rgba[dst + 1] = g;
      rgba[dst + 2] = g;
      rgba[dst + 3] = reconstructed[src + 1]!;
    } else if (colorType === 3 && palette) {
      const idx = reconstructed[i]! * 3;
      rgba[dst] = palette[idx] ?? 0;
      rgba[dst + 1] = palette[idx + 1] ?? 0;
      rgba[dst + 2] = palette[idx + 2] ?? 0;
      rgba[dst + 3] = 255;
    }
  }

  return { width, height, rgba };
}

function resizeRgbaNearest(
  image: DecodedRgbaImage,
  targetWidth: number,
  targetHeight: number
): DecodedRgbaImage {
  if (image.width === targetWidth && image.height === targetHeight) {
    return image;
  }
  const rgba = new Uint8Array(targetWidth * targetHeight * 4);
  for (let y = 0; y < targetHeight; y += 1) {
    const srcY = Math.min(
      image.height - 1,
      Math.floor((y * image.height) / targetHeight)
    );
    for (let x = 0; x < targetWidth; x += 1) {
      const srcX = Math.min(
        image.width - 1,
        Math.floor((x * image.width) / targetWidth)
      );
      const src = (srcY * image.width + srcX) * 4;
      const dst = (y * targetWidth + x) * 4;
      rgba[dst] = image.rgba[src]!;
      rgba[dst + 1] = image.rgba[src + 1]!;
      rgba[dst + 2] = image.rgba[src + 2]!;
      rgba[dst + 3] = image.rgba[src + 3]!;
    }
  }
  return { width: targetWidth, height: targetHeight, rgba };
}

/**
256-entry global palette: 6x6x6 uniform RGB cube (0..215) + 40 neutral grayscale steps (216..255).
*/
function buildGlobalPalette(): Uint8Array {
  const palette = new Uint8Array(256 * 3);
  let index = 0;
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        palette[index * 3] = Math.round((r * 255) / 5);
        palette[index * 3 + 1] = Math.round((g * 255) / 5);
        palette[index * 3 + 2] = Math.round((b * 255) / 5);
        index += 1;
      }
    }
  }
  for (let i = 0; i < 40; i += 1) {
    const v = Math.round((i * 255) / 39);
    palette[(216 + i) * 3] = v;
    palette[(216 + i) * 3 + 1] = v;
    palette[(216 + i) * 3 + 2] = v;
  }
  return palette;
}

function quantizeToPalette(rgba: Uint8Array, pixelCount: number): Uint8Array {
  const indices = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const ri = Math.round((r * 5) / 255);
    const gi = Math.round((g * 5) / 255);
    const bi = Math.round((b * 5) / 255);
    indices[i] = ri * 36 + gi * 6 + bi;
  }
  return indices;
}

function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;

  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  let table = new Map<number, number>();
  emit(clearCode);

  if (indices.length > 0) {
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i += 1) {
      const k = indices[i]!;
      const key = (prefix << 8) | k;
      const found = table.get(key);
      if (found !== undefined) {
        prefix = found;
      } else {
        emit(prefix);
        if (nextCode < 4096) {
          table.set(key, nextCode);
          nextCode += 1;
          if (nextCode > 1 << codeSize && codeSize < 12) {
            codeSize += 1;
          }
        } else {
          emit(clearCode);
          table = new Map<number, number>();
          codeSize = minCodeSize + 1;
          nextCode = eoiCode + 1;
        }
        prefix = k;
      }
    }
    emit(prefix);
  }

  emit(eoiCode);
  if (bitCount > 0) {
    out.push(bitBuffer & 0xff);
  }
  return Uint8Array.from(out);
}

/**
Encode an ordered list of RGBA frames into a valid looping animated GIF89a buffer.
*/
export function encodeAnimatedGif(
  frames: readonly DecodedRgbaImage[],
  frameDelayMs: number = DEFAULT_FRAME_DELAY_MS
): Uint8Array {
  if (frames.length === 0) {
    throw new RangeError("encodeAnimatedGif requires at least one frame.");
  }
  const first = frames[0]!;
  const scale = Math.min(
    1,
    MAX_GIF_WIDTH / first.width,
    MAX_GIF_HEIGHT / first.height
  );
  const width = Math.max(1, Math.round(first.width * scale));
  const height = Math.max(1, Math.round(first.height * scale));
  const delayCentiseconds = Math.max(
    2,
    Math.min(65_535, Math.round(frameDelayMs / 10))
  );
  const palette = buildGlobalPalette();
  const chunks: Uint8Array[] = [];

  // Header: GIF89a
  chunks.push(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));

  // Logical Screen Descriptor (Global Color Table flag = 1, 256 colors => 0xF7)
  chunks.push(
    Uint8Array.from([
      width & 0xff,
      (width >> 8) & 0xff,
      height & 0xff,
      (height >> 8) & 0xff,
      0xf7,
      0x00,
      0x00
    ])
  );

  // Global Color Table (768 bytes)
  chunks.push(palette);

  // Netscape 2.0 Application Extension (infinite loop)
  chunks.push(
    Uint8Array.from([
      0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32,
      0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00
    ])
  );

  const minCodeSize = 8;
  for (const frame of frames) {
    const fitted = resizeRgbaNearest(frame, width, height);
    const indexed = quantizeToPalette(fitted.rgba, width * height);
    const lzw = lzwEncode(indexed, minCodeSize);

    // Graphic Control Extension
    chunks.push(
      Uint8Array.from([
        0x21,
        0xf9,
        0x04,
        0x00,
        delayCentiseconds & 0xff,
        (delayCentiseconds >> 8) & 0xff,
        0x00,
        0x00
      ])
    );

    // Image Descriptor
    chunks.push(
      Uint8Array.from([
        0x2c,
        0x00,
        0x00,
        0x00,
        0x00,
        width & 0xff,
        (width >> 8) & 0xff,
        height & 0xff,
        (height >> 8) & 0xff,
        0x00
      ])
    );

    // LZW Minimum Code Size + Sub-blocks
    chunks.push(Uint8Array.from([minCodeSize]));
    for (let pos = 0; pos < lzw.length; pos += 255) {
      const slice = lzw.subarray(pos, Math.min(pos + 255, lzw.length));
      chunks.push(Uint8Array.from([slice.length]), slice);
    }
    chunks.push(Uint8Array.from([0x00]));
  }

  // Trailer
  chunks.push(Uint8Array.from([0x3b]));

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let cursor = 0;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.length;
  }
  return result;
}

interface OrderedFrame {
  readonly id: string;
  readonly step: number;
}

function orderedFramesFromLocators(
  frames: readonly Extract<PlaytestEvidenceLocator, { kind: "frame" }>[]
): OrderedFrame[] {
  return frames
    .map((frame, index) => ({
      id: frame.id,
      step: frame.step ?? frame.frameIndex ?? index
    }))
    .sort((a, b) => a.step - b.step);
}

function sampleWindow(
  frames: readonly OrderedFrame[],
  maxFrames: number
): OrderedFrame[] {
  if (frames.length <= maxFrames) return [...frames];
  const sampled: OrderedFrame[] = [];
  for (let i = 0; i < maxFrames; i += 1) {
    const idx = Math.round((i * (frames.length - 1)) / (maxFrames - 1));
    sampled.push(frames[idx]!);
  }
  return sampled;
}

function windowAroundStep(
  frames: readonly OrderedFrame[],
  targetStep: number,
  maxFrames: number
): OrderedFrame[] {
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < frames.length; i += 1) {
    const distance = Math.abs(frames[i]!.step - targetStep);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = i;
    }
  }
  const halfBefore = Math.floor((maxFrames - 1) / 2);
  const start = Math.max(
    0,
    Math.min(frames.length - maxFrames, nearestIndex - halfBefore)
  );
  const end = Math.min(frames.length, start + maxFrames);
  return frames.slice(start, end);
}

/**
Deterministically select up to `PLAYTEST_HIGHLIGHT_MAX_CLIPS_PER_EPISODE`
highlight windows from captured episode frames and step signals.
*/
export function selectHighlightClipWindows(
  frameLocators: readonly Extract<PlaytestEvidenceLocator, { kind: "frame" }>[],
  signals: readonly HighlightStepSignal[] = []
): readonly HighlightClipWindow[] {
  const ordered = orderedFramesFromLocators(frameLocators);
  if (ordered.length < MIN_FRAMES_PER_CLIP) return [];

  const maxFrames = Math.min(PLAYTEST_HIGHLIGHT_MAX_FRAMES_PER_CLIP, ordered.length);
  const windows: HighlightClipWindow[] = [];
  const seenSignatures = new Set<string>();

  const tryAdd = (
    reason: PlaytestHighlightReason,
    title: string,
    slice: readonly OrderedFrame[]
  ): void => {
    if (
      windows.length >= PLAYTEST_HIGHLIGHT_MAX_CLIPS_PER_EPISODE ||
      slice.length < MIN_FRAMES_PER_CLIP
    ) {
      return;
    }
    const frameIds = slice.map((frame) => frame.id);
    const signature = frameIds.join(",");
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);
    windows.push({
      reason,
      title,
      startStep: slice[0]!.step,
      endStep: slice.at(-1)!.step,
      frameIds
    });
  };

  const anomaly = signals.find((s) => s.isAnomaly === true);
  if (anomaly) {
    const slice = windowAroundStep(ordered, anomaly.step, Math.min(6, maxFrames));
    tryAdd(
      "anomaly-or-termination",
      anomaly.label?.trim() || `Anomaly / termination around step ${anomaly.step}`,
      slice
    );
  }

  const transition = signals.find((s) => s.isEventTransition === true);
  if (transition) {
    const slice = windowAroundStep(
      ordered,
      transition.step,
      Math.min(6, maxFrames)
    );
    tryAdd(
      "event-sequence",
      transition.label?.trim() || `Key event sequence around step ${transition.step}`,
      slice
    );
  }

  const milestone = signals.find((s) => s.isProgressMilestone === true);
  if (milestone) {
    const slice = windowAroundStep(
      ordered,
      milestone.step,
      Math.min(6, maxFrames)
    );
    tryAdd(
      "progress-milestone",
      milestone.label?.trim() || `Progress milestone around step ${milestone.step}`,
      slice
    );
  }

  // Always offer a session summary highlight clip when >= 2 frames exist and
  // the sampled sequence isn't already identical to a selected clip.
  const summarySlice = sampleWindow(ordered, Math.min(8, maxFrames));
  tryAdd(
    "session-summary",
    `Session summary (steps ${summarySlice[0]!.step}–${summarySlice.at(-1)!.step})`,
    summarySlice
  );

  return windows;
}

/**
Build and persist animated GIF89a highlight clips for an episode's captured PNG frames.
Fails gracefully if frames cannot be decoded as PNG, returning only valid persisted clips.
*/
export function buildEpisodeHighlightClips(options: {
  readonly artifacts: PlaytestArtifactStore;
  readonly frames: readonly Extract<PlaytestEvidenceLocator, { kind: "frame" }>[];
  readonly signals?: readonly HighlightStepSignal[];
  readonly frameDelayMs?: number;
}): readonly PlaytestHighlightClip[] {
  const windows = selectHighlightClipWindows(
    options.frames,
    options.signals ?? []
  );
  if (windows.length === 0) return [];

  const frameDelayMs = options.frameDelayMs ?? DEFAULT_FRAME_DELAY_MS;
  const decodedCache = new Map<string, DecodedRgbaImage | null>();
  const decodeFrame = (frameId: string): DecodedRgbaImage | null => {
    if (decodedCache.has(frameId)) return decodedCache.get(frameId) ?? null;
    try {
      const reference = options.artifacts.referenceForId(frameId);
      if (reference === null || reference.mediaType !== "image/png") {
        decodedCache.set(frameId, null);
        return null;
      }
      const artifact = options.artifacts.readArtifact(reference);
      const decoded = decodePngRgba(artifact.bytes);
      decodedCache.set(frameId, decoded);
      return decoded;
    } catch {
      decodedCache.set(frameId, null);
      return null;
    }
  };

  const clips: PlaytestHighlightClip[] = [];
  for (const window of windows) {
    const decodedFrames: DecodedRgbaImage[] = [];
    const includedIds: string[] = [];
    for (const frameId of window.frameIds) {
      const decoded = decodeFrame(frameId);
      if (decoded !== null) {
        decodedFrames.push(decoded);
        includedIds.push(frameId);
      }
    }
    if (decodedFrames.length < MIN_FRAMES_PER_CLIP) continue;
    try {
      const gifBytes = encodeAnimatedGif(decodedFrames, frameDelayMs);
      if (
        gifBytes.byteLength < 6 ||
        gifBytes.byteLength > PLAYTEST_HIGHLIGHT_MAX_BYTES
      ) {
        continue;
      }
      const stored = options.artifacts.writeArtifact({
        mediaType: PLAYTEST_HIGHLIGHT_MEDIA_TYPE,
        bytes: gifBytes
      });
      clips.push({
        id: stored.reference.artifactId,
        mediaType: PLAYTEST_HIGHLIGHT_MEDIA_TYPE,
        sha256: stored.reference.sha256,
        bytes: stored.reference.bytes,
        title: window.title,
        reason: window.reason,
        startStep: window.startStep,
        endStep: window.endStep,
        frameCount: decodedFrames.length,
        durationMs: decodedFrames.length * frameDelayMs,
        frameIds: includedIds
      });
    } catch {
      // Skip any clip that cannot be encoded or persisted without failing the episode.
    }
  }

  if (clips.length === 0) return [];
  assertPlaytestHighlightClips(clips);
  return clips;
}
