/**
 * The content a Codex request carries, and the images among it.
 *
 * Codex sends an image the user attached as a message part: an `input_image`
 * part holding a data URL. A bridge that can hand that image to its model
 * needs the bytes; a bridge that cannot has to name the limit rather than
 * answer a question the model was never asked. The routers read the same
 * content here, so every bridge and the router agree on what "this request
 * carries an image" means.
 */

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/su;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An image the request carries. */
export type RequestImage =
  /** The request carries the image's bytes, inline. */
  | {
      readonly kind: "bytes";
      readonly mediaType: string;
      readonly data: string;
    }
  /**
   * The request named the image and carries none of its bytes. A bridge cannot
   * hand this to its model: it has nothing to hand over.
   */
  | { readonly kind: "reference"; readonly url: string };

/** One part of a message's content, in the order the request carried it. */
export type RequestContentPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly image: RequestImage };

/** The image a content part carries, or null when the part carries no image. */
function imageOf(part: Record<string, unknown>): RequestImage | null {
  const typed = part.type === "input_image" || part.type === "image";
  const named = part.image_url !== undefined && part.image_url !== null;
  if (!typed && !named) return null;
  const url = typeof part.image_url === "string" ? part.image_url : null;
  if (url) {
    const match = DATA_URL_PATTERN.exec(url);
    const mediaType = match?.[1];
    const data = match?.[2];
    if (mediaType !== undefined && data !== undefined)
      return { kind: "bytes", mediaType, data };
    return { kind: "reference", url };
  }
  // An Anthropic-shaped part carries its bytes under `source` instead.
  const source = isRecord(part.source) ? part.source : null;
  if (source && source.type === "base64" && typeof source.data === "string") {
    return {
      kind: "bytes",
      mediaType:
        typeof source.media_type === "string" ? source.media_type : "image/png",
      data: source.data
    };
  }
  return { kind: "reference", url: "" };
}

/**
 * One message's content, as the parts the request carried.
 *
 * Only message content is inspected. A tool *output* that carries an image
 * travels the bridges' image-aware tool path, and must not make the turn that
 * carries it unservable.
 */
export function requestContentParts(content: unknown): RequestContentPart[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const parts: RequestContentPart[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ kind: "text", text: part });
      continue;
    }
    if (!isRecord(part)) continue;
    const image = imageOf(part);
    if (image) {
      parts.push({ kind: "image", image });
      continue;
    }
    if (typeof part.text === "string")
      parts.push({ kind: "text", text: part.text });
  }
  return parts;
}

/**
 * Every image the request's messages carried, in the order they appeared.
 *
 * Only message content is inspected. A tool *output* that carries an image
 * travels the bridges' image-aware tool path, and must not make the turn that
 * carries it unservable.
 */
export function requestImages(input: unknown): RequestImage[] {
  if (!Array.isArray(input)) return [];
  const images: RequestImage[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (!Array.isArray(item.content)) continue;
    for (const part of requestContentParts(item.content)) {
      if (part.kind === "image") images.push(part.image);
    }
  }
  return images;
}

/**
 * Whether the request's conversation carries an image.
 *
 * Only message content is inspected. A tool *output* that carries an image
 * travels the bridges' image-aware tool path, and must not refuse the turn
 * that carries it.
 */
export function requestCarriesImageContent(input: unknown): boolean {
  return requestImages(input).length > 0;
}
