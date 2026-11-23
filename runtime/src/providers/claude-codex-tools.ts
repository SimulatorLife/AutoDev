/**
 * Claude CLI-specific message and image block adapters over the shared Codex
 * transcript and tool-surface helpers (`runtime/src/shared/codex-transcript.ts`).
 */

import {
  type CodexTranscriptOptions,
  renderCodexTranscript
} from "@simulatorlife/autodev-runtime/shared/codex-transcript";
import {
  type RequestImage,
  requestImages
} from "@simulatorlife/autodev-runtime/shared/request-content";

type JsonRecord = Record<string, unknown>;

/**
 * One block of the Claude CLI's user message.
 */
export type ClaudeContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: string;
        readonly data: string;
      };
    };

/** The image block for an image the request carries, or null when it has no bytes. */
function claudeImageBlock(image: RequestImage): ClaudeContentBlock | null {
  if (image.kind !== "bytes") return null;
  return {
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data }
  };
}

/**
 * The Codex conversation as the Claude CLI's user message.
 */
export function renderCodexContentBlocks(
  input: unknown,
  options: CodexTranscriptOptions = {}
): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = [
    { type: "text", text: renderCodexTranscript(input, options) }
  ];
  for (const image of requestImages(input)) {
    const block = claudeImageBlock(image);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * The one user message the CLI's print mode runs a turn from.
 */
export function claudeUserMessage(blocks: ClaudeContentBlock[]): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: blocks }
  })}\n`;
}

/**
 * The image an MCP tool result carries, in the shape the CLI renders.
 */
export function claudeMcpImageContent(image: RequestImage): JsonRecord | null {
  if (image.kind !== "bytes") return null;
  return { type: "image", mimeType: image.mediaType, data: image.data };
}
