/** Bounded LF framer for one UTF-8 JSON-RPC message per line. */
export class JsonLineFrameError extends Error {
  readonly maximumBytes: number;

  constructor(maximumBytes: number) {
    super(
      "JSON-RPC line exceeded its byte limit of " + String(maximumBytes) + "."
    );
    this.name = "JsonLineFrameError";
    this.maximumBytes = maximumBytes;
  }
}

/**
 * Accumulates partial chunks in a geometrically-grown buffer. This avoids
 * copying the full partial line on every small transport chunk, while
 * retaining a strict byte ceiling before JSON parsing.
 */
export class JsonLineFramer {
  readonly maximumBytes: number;
  private buffer: Buffer;
  private length = 0;

  constructor(maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new TypeError(
        "JSON-RPC line byte limit must be a positive integer."
      );
    }
    this.maximumBytes = maximumBytes;
    this.buffer = Buffer.allocUnsafe(Math.min(maximumBytes, 4096));
  }

  get pendingBytes(): number {
    return this.length;
  }

  /** Returns a copy of the unterminated bytes so the caller can preserve them. */
  pendingLine(): Buffer {
    return Buffer.from(this.buffer.subarray(0, this.length));
  }

  clear(): void {
    this.length = 0;
  }

  push(chunk: Buffer): readonly Buffer[] {
    const lines: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      this.append(chunk.subarray(offset, end));
      if (newline === -1) break;
      lines.push(Buffer.from(this.buffer.subarray(0, this.length)));
      this.length = 0;
      offset = newline + 1;
    }
    return lines;
  }

  private append(segment: Buffer): void {
    const nextLength = this.length + segment.length;
    if (nextLength > this.maximumBytes) {
      throw new JsonLineFrameError(this.maximumBytes);
    }
    if (nextLength > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < nextLength) {
        capacity = Math.min(this.maximumBytes, capacity * 2);
      }
      const expanded = Buffer.allocUnsafe(capacity);
      this.buffer.copy(expanded, 0, 0, this.length);
      this.buffer = expanded;
    }
    segment.copy(this.buffer, this.length);
    this.length = nextLength;
  }
}
